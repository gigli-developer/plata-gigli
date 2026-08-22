import type { SupabaseClient } from "@supabase/supabase-js";
import type { Tool } from "./tools";
import { guardar } from "./propuestas";
import { hoy as hoyAr, sumarDias, esFecha } from "../fechas";

/**
 * Cliente de Google Tasks para el agente + las dos herramientas de tareas.
 *
 * Mismo molde que `google.ts` (Calendar): las credenciales `GCAL_CLIENT_ID` /
 * `GCAL_CLIENT_SECRET` / `GCAL_REFRESH_TOKEN` viven en `app_secrets` y el access
 * token se cachea en memoria del proceso. Es EL MISMO refresh token que el de la
 * agenda — un solo OAuth con los dos scopes —, pero el flujo está duplicado acá
 * a propósito: `google.ts` no lo exporta, y este archivo necesita traducir el
 * 403 a "falta el scope de Tasks" sin meterle casos ajenos al de la agenda.
 *
 * ⚠️ Mientras el refresh token vigente tenga solo `calendar.events`, TODO lo de
 * acá devuelve 403 (insufficientPermissions). No es un bug de este código: hay
 * que re-autorizar con `node scripts/tasks-auth.mjs`, que pide los dos scopes
 * juntos (si se pide solo Tasks, el token nuevo pierde Calendar).
 *
 * Las tareas se LEEN de todas las listas (Lucas tiene cinco: Emprendimiento,
 * Trabajo, Desarrollo Personal, Generales, Estudios — verificado el 21/08 con
 * datos vivos; leer solo `@default` escondia la mayoria). Las nuevas van a la
 * lista por defecto: decidir lista por voz es mas friccion que moverla despues.
 * El
 * scope de Tasks tampoco da para mucho más protagonismo por voz.
 */

const API = "https://tasks.googleapis.com/tasks/v1";

/** Falta autorizar (no hay token, o el que hay no tiene el scope de Tasks). */
export class SinTasks extends Error {
  constructor() {
    super(
      "Falta autorizar Google Tasks: corré `node scripts/tasks-auth.mjs` y pegá el " +
        "refresh token nuevo en app_secrets (GCAL_REFRESH_TOKEN).",
    );
  }
}

// El access token dura una hora. Caché propio, separado del de Calendar: los dos
// salen del mismo refresh token, pero compartirlo acoplaría los archivos.
let cache: { token: string; vence: number } | null = null;

async function tokenDeAcceso(sb: SupabaseClient): Promise<string> {
  if (cache && Date.now() < cache.vence) return cache.token;

  const { data, error } = await sb
    .from("app_secrets")
    .select("key,value")
    .in("key", ["GCAL_CLIENT_ID", "GCAL_CLIENT_SECRET", "GCAL_REFRESH_TOKEN"]);
  if (error) throw new Error(`No pude leer los secrets de Google: ${error.message}`);

  const s = Object.fromEntries((data ?? []).map((f) => [f.key, f.value])) as Record<string, string>;
  if (!s.GCAL_REFRESH_TOKEN) throw new SinTasks();

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.GCAL_CLIENT_ID,
      client_secret: s.GCAL_CLIENT_SECRET,
      refresh_token: s.GCAL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) {
    // `invalid_grant` acá significa que el refresh token se revocó o caducó.
    throw new Error(`Google rechazó el refresh token: ${JSON.stringify(t).slice(0, 200)}`);
  }

  // 60s de colchón para no usar un token que vence a mitad de la request.
  cache = { token: t.access_token, vence: Date.now() + (t.expires_in - 60) * 1000 };
  return cache.token;
}

async function api(sb: SupabaseClient, ruta: string, init: RequestInit = {}) {
  const token = await tokenDeAcceso(sb);
  const r = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (r.status === 204) return null;
  // Con un solo usuario, un 403 acá quiere decir UNA cosa: el refresh token no
  // tiene el scope de Tasks (insufficientPermissions / PERMISSION_DENIED). En
  // teoría también podría ser cuota, pero a este volumen esa lectura sería paranoia.
  if (r.status === 403) throw new SinTasks();
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message ?? JSON.stringify(data).slice(0, 200);
    throw new Error(`Google Tasks (${r.status}): ${msg}`);
  }
  return data;
}

/** Traduce los errores a algo que el modelo pueda decir sin inventar. */
function errorTasks(e: unknown) {
  if (e instanceof SinTasks) return { ok: false, motivo: e.message };
  return { ok: false, motivo: e instanceof Error ? e.message : "Error desconocido" };
}

// ---------------------------------------------------------------------------
// El cliente: lo que usa `confirmar` en tools.ts y las herramientas de acá
// ---------------------------------------------------------------------------

export type Tarea = {
  id: string;
  /** En que lista vive: sin esto, editarla o borrarla apuntaria a `@default` y fallaria. */
  listaId: string;
  lista: string;
  titulo: string;
  nota?: string;
  /** YYYY-MM-DD, sin hora: es lo único que Google Tasks guarda. */
  vence?: string;
};

/** La parte de la respuesta de Google que nos interesa. */
type TareaGoogle = { id?: string; title?: string; notes?: string; due?: string };

function aTarea(t: TareaGoogle, listaId: string, lista: string): Tarea {
  return {
    id: String(t.id),
    listaId,
    lista,
    titulo: String(t.title ?? "(sin título)"),
    nota: t.notes ? String(t.notes).slice(0, 300) : undefined,
    // ⚠️ `due` llega como medianoche UTC ("...T00:00:00.000Z") pero es una FECHA
    // disfrazada: la API descarta la hora. Va `slice` y NO `dia()` de fechas.ts,
    // porque convertirla a día argentino la correría al día ANTERIOR (UTC-3).
    // Es la excepción documentada a la regla de "todo por fechas.ts".
    vence: t.due ? String(t.due).slice(0, 10) : undefined,
  };
}

// Las listas se cachean para siempre en memoria del proceso: crear una lista
// nueva es un evento raro, y el cache muere solo en cada deploy.
let cacheListas: { id: string; titulo: string }[] | null = null;
async function listas(sb: SupabaseClient): Promise<{ id: string; titulo: string }[]> {
  if (cacheListas) return cacheListas;
  const d = await api(sb, "/users/@me/lists");
  const filas = ((d?.items ?? []) as { id?: string; title?: string }[])
    .map((l) => ({ id: String(l.id), titulo: String(l.title ?? "Tareas") }));
  if (filas.length) cacheListas = filas;
  return filas.length ? filas : [{ id: "@default", titulo: "Tareas" }];
}

export async function listarTareas(sb: SupabaseClient): Promise<Tarea[]> {
  const q = new URLSearchParams({ showCompleted: "false", maxResults: "100" });
  const ls = await listas(sb);
  // A la par: son pocas listas y la latencia total es la de la mas lenta.
  const porLista = await Promise.all(
    ls.map(async (l) => {
      const d = await api(sb, `/lists/${encodeURIComponent(l.id)}/tasks?${q}`);
      return ((d?.items ?? []) as TareaGoogle[]).map((x) => aTarea(x, l.id, l.titulo));
    }),
  );
  return porLista.flat();
}

export type CamposTarea = { titulo?: string; notas?: string; vence?: string };

/** Arma el body de Google a partir de nuestros campos. */
function aBody(c: CamposTarea): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (c.titulo !== undefined) body.title = c.titulo;
  if (c.notas !== undefined) body.notes = c.notas;
  // El RFC3339 completo es obligatorio aunque la hora se tire a la basura.
  if (c.vence !== undefined) body.due = `${c.vence}T00:00:00.000Z`;
  return body;
}

export async function crearTarea(sb: SupabaseClient, c: CamposTarea): Promise<{ titulo: string }> {
  const d = await api(sb, "/lists/@default/tasks", { method: "POST", body: JSON.stringify(aBody(c)) });
  return { titulo: String(d?.title ?? c.titulo ?? "(sin titulo)") };
}

export async function editarTarea(
  sb: SupabaseClient, listaId: string, id: string, c: CamposTarea,
): Promise<void> {
  // PATCH y no update completo: solo se pisa lo que se tocó, igual que la agenda.
  await api(sb, `/lists/${encodeURIComponent(listaId)}/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(aBody(c)),
  });
}

export async function completarTarea(sb: SupabaseClient, listaId: string, id: string): Promise<void> {
  // Completar es un PATCH de estado; Google le pone el timestamp solo.
  await api(sb, `/lists/${encodeURIComponent(listaId)}/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed" }),
  });
}

export async function borrarTarea(sb: SupabaseClient, listaId: string, id: string): Promise<void> {
  await api(sb, `/lists/${encodeURIComponent(listaId)}/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// Humanizar
// ---------------------------------------------------------------------------

/** "hoy", "mañana", "vencida hace 3 días", "22 ago". Null si no tiene fecha. */
function humanizarVence(vence?: string): string | null {
  if (!vence) return null;
  const h = hoyAr();
  if (vence === h) return "hoy";
  if (vence === sumarDias(h, 1)) return "mañana";
  // La cuenta de días va en milisegundos al mediodía de cada punta, la misma
  // jugada anti-off-by-one que los feriados de mundo.ts.
  const dif = Math.round((Date.parse(`${h}T12:00:00Z`) - Date.parse(`${vence}T12:00:00Z`)) / 864e5);
  if (dif > 0) return `vencida hace ${dif} día${dif === 1 ? "" : "s"}`;
  return new Date(`${vence}T12:00:00Z`)
    .toLocaleDateString("es-AR", { day: "numeric", month: "short", timeZone: "UTC" })
    .replace(/\./g, "");
}

/** El `cuando` de la tarjeta de previsualización: "vence mañana", "vencida hace 3 días". */
function cuandoTarjeta(vence?: string): string | undefined {
  const h = humanizarVence(vence);
  if (!h) return undefined;
  return h.startsWith("vencida") ? h : `vence ${h}`;
}

/** `"A, B y C"`: una lista corta como se lee en voz alta. La usa también el lote de plata. */
export const enumerar = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`;

/**
 * Vencidas primero (la más vieja arriba), después por fecha, y las sin fecha al
 * final en su orden original — que es el orden manual de la lista, y el sort de
 * JS es estable, así que se conserva solo. Las fechas se comparan como texto:
 * YYYY-MM-DD ordena igual alfabética que cronológicamente.
 */
function ordenar(tareas: Tarea[]): Tarea[] {
  const h = hoyAr();
  const peso = (t: Tarea) => (!t.vence ? 2 : t.vence < h ? 0 : 1);
  return [...tareas].sort(
    (a, b) => peso(a) - peso(b) || (a.vence ?? "").localeCompare(b.vence ?? ""),
  );
}

// ---------------------------------------------------------------------------
// Las herramientas
// ---------------------------------------------------------------------------

const tareasVer: Tool = {
  name: "tareas_ver",
  description:
    "Las tareas pendientes de su lista de Google Tasks. Usar para '¿qué tengo " +
    "pendiente?', '¿qué me falta hacer?', '¿tengo algo para hoy?', 'leeme la lista'. " +
    "Devuelve las vencidas primero. ⚠️ Las tareas de CÓDIGO (tocar un repo, lanzar " +
    "un agente) van por `tarea_codigo_dictar` y `tareas_codigo_ver`, no por acá.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient) {
    try {
      const tareas = ordenar(await listarTareas(sb));
      const filas = tareas.map((t) => ({
        lista: t.lista,
        titulo: t.titulo,
        vence: humanizarVence(t.vence),
        nota: t.nota ?? null,
      }));
      const vencidas = filas.filter((f) => f.vence?.startsWith("vencida")).length;

      // Agrupadas por su lista real (Trabajo, Estudios...), en el orden en que
      // aparecieron. El nombre de la lista va UNA vez, en el grupo, no por fila.
      const grupos: { nombre: string; tareas: { titulo: string; vence: string | null; nota: string | null }[] }[] = [];
      for (const f of filas) {
        let g = grupos.find((x) => x.nombre === f.lista);
        if (!g) { g = { nombre: f.lista, tareas: [] }; grupos.push(g); }
        g.tareas.push({ titulo: f.titulo, vence: f.vence, nota: f.nota });
      }

      const nombres = tareas.slice(0, 3).map((t) => `"${t.titulo}"`).join(", ");
      const deVencidas = vencidas ? ` (${vencidas} vencida${vencidas === 1 ? "" : "s"})` : "";
      return {
        ok: true,
        cuantas: tareas.length,
        tareas: filas,
        para_decir: tareas.length
          ? `Tenés ${tareas.length} tarea${tareas.length === 1 ? "" : "s"} pendiente` +
            `${tareas.length === 1 ? "" : "s"}${deVencidas}: ${nombres}` +
            `${tareas.length > 3 ? " y más" : ""}.`
          : "No tenés ninguna tarea pendiente.",
        // El contrato con la cara WPF; run.ts lo saca antes de que cueste tokens.
        panel: { tipo: "tareas", listas: grupos },
      };
    } catch (e) {
      return errorTasks(e);
    }
  },
};

const tareasCambiar: Tool = {
  name: "tareas_cambiar",
  description:
    "PROPONE crear, completar, editar o borrar una tarea de Google Tasks. NO ejecuta " +
    "nada: devuelve una previsualización y hay que confirmarla con `confirmar`. Usar " +
    "para 'anotá que tengo que comprar pilas', 'acordame de llamar al contador el " +
    "viernes', 'listo lo de la farmacia' (→ completar), 'sacá lo del service' (→ " +
    "borrar). Para completar, editar o borrar pasá el título TAL COMO lo dijo, aunque " +
    "sea aproximado: la herramienta la busca sola. Si dicta VARIAS tareas de una, van " +
    "todas juntas en `varias`: una sola propuesta y una sola confirmación. ⚠️ Las " +
    "tareas de CÓDIGO van por `tarea_codigo_dictar`, no por acá.",
  input_schema: {
    type: "object",
    properties: {
      accion: {
        type: "string",
        enum: ["crear", "completar", "editar", "borrar"],
        description: "Qué se quiere hacer.",
      },
      titulo: {
        type: "string",
        description:
          "Para crear: el título de la tarea nueva. Para el resto: el título tal como " +
          "lo dijo — se busca por coincidencia, no hace falta que sea exacto.",
      },
      varias: {
        type: "array",
        items: {
          type: "object",
          properties: {
            titulo: { type: "string" },
            nota: { type: "string" },
            vence: { type: "string" },
          },
          required: ["titulo"],
        },
        description:
          "Para CREAR varias tareas de una: va la lista completa acá y UNA sola " +
          "propuesta. Si el usuario dicta más de una tarea, usá esto y NO llames " +
          "varias veces.",
      },
      titulo_nuevo: { type: "string", description: "Solo para editar: el título nuevo, si cambia." },
      nota: { type: "string", description: "Detalle o aclaración de la tarea." },
      vence: {
        type: "string",
        description:
          "Fecha límite YYYY-MM-DD, solo si dijo una ('para el viernes'). " +
          "Google Tasks guarda el día pelado, sin hora.",
      },
    },
    required: ["accion", "titulo"],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    try {
      const accion = String(input?.accion ?? "");
      if (!["crear", "completar", "editar", "borrar"].includes(accion)) {
        return { ok: false, motivo: `Acción desconocida: ${accion}` };
      }

      // --- alta en LOTE: "anotá A, B y C" → UNA tarjeta y UN solo sí ---------
      // Antes salía cuadrito por cuadrito, una confirmación por tarea. Se valida
      // TODO antes de proponer: una fecha rota en la tarea 3 no puede dejar dos
      // cargadas y una en el aire.
      const varias = accion === "crear" && Array.isArray(input?.varias)
        ? (input.varias as Record<string, unknown>[])
        : [];
      if (varias.length >= 1) {
        const lote: { titulo: string; notas?: string; vence?: string }[] = [];
        for (let i = 0; i < varias.length; i++) {
          const t = varias[i] ?? {};
          const tit = String(t?.titulo ?? "").trim();
          if (!tit) return { ok: false, motivo: `La tarea ${i + 1} de la lista viene sin título.` };
          const v = t?.vence !== undefined ? String(t.vence).trim() : undefined;
          if (v && !esFecha(v)) {
            return {
              ok: false,
              motivo: `El vencimiento de "${tit}" no es una fecha válida: "${v}" (va YYYY-MM-DD).`,
            };
          }
          const n = t?.nota !== undefined ? String(t.nota).trim() : undefined;
          lote.push({ titulo: tit, notas: n || undefined, vence: v || undefined });
        }

        const p = guardar({ dominio: "tarea", tipo: "crear", tareasNuevas: lote });
        return {
          ok: true,
          propuesta: {
            id: p.id, dominio: "tarea", tipo: "crear", antes: null, despues: null,
            // El contrato del lote con la cara: un renglón por tarea, con su
            // vence ya humanizado. Sin tachar — esto es un alta, no un borrado.
            lista_rica: lote.map((t) => {
              const cu = cuandoTarjeta(t.vence);
              return { titulo: t.titulo, ...(cu ? { detalle: cu } : {}) };
            }),
          },
          para_decir:
            `Anotar ${lote.length} tarea${lote.length === 1 ? "" : "s"}: ` +
            `${enumerar(lote.map((t) => t.titulo))}.`,
          que_hacer: `Leéselas y preguntale UNA sola vez. Si confirma, llamá confirmar con id "${p.id}".`,
        };
      }

      const titulo = String(input?.titulo ?? "").trim();
      if (!titulo) return { ok: false, motivo: "Falta el título de la tarea." };
      const nota = input?.nota !== undefined ? String(input.nota).trim() : undefined;
      const vence = input?.vence !== undefined ? String(input.vence).trim() : undefined;
      const tituloNuevo =
        input?.titulo_nuevo !== undefined ? String(input.titulo_nuevo).trim() : undefined;
      if (vence && !esFecha(vence)) {
        return { ok: false, motivo: `"${vence}" no es una fecha válida (va YYYY-MM-DD).` };
      }

      if (accion === "crear") {
        const p = guardar({
          dominio: "tarea", tipo: "crear",
          tarea: { accion: "crear", titulo, notas: nota, vence },
        });
        return {
          ok: true,
          propuesta: {
            id: p.id, dominio: "tarea", tipo: "crear", antes: null,
            despues: { titulo, cuando: cuandoTarjeta(vence), nota },
          },
          para_decir: `Anotar "${titulo}"${vence ? `, vence ${humanizarVence(vence)}` : ""}.`,
          que_hacer: `Mostrale esto y preguntale si confirma. Si dice que sí, llamá confirmar con id "${p.id}".`,
        };
      }

      // Para tocar una existente primero hay que saber CUÁL. Se resuelve ACÁ, al
      // proponer, y no al confirmar: lo que se muestra en la tarjeta tiene que ser
      // exactamente lo que después se ejecuta. Búsqueda por subcadena sin tildes,
      // que es lo que uno espera al nombrarla en voz alta.
      const tareas = await listarTareas(sb);
      const plano = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      const aguja = plano(titulo);
      const candidatas = tareas.filter((t) => plano(t.titulo).includes(aguja));

      if (!candidatas.length) {
        return {
          ok: false,
          motivo: `No encontré ninguna tarea pendiente que diga "${titulo}".`,
          opciones: tareas.map((t) => t.titulo),
          que_hacer:
            "Leele las que tiene y preguntale a cuál se refería. NO propongas nada " +
            "todavía: puede estar anotada con otras palabras.",
        };
      }
      if (candidatas.length > 1) {
        return {
          ok: false,
          motivo: `Hay ${candidatas.length} tareas que coinciden con "${titulo}".`,
          opciones: candidatas.map((t) => `${t.titulo} (${t.lista})`),
          que_hacer: "Preguntale cuál es y volvé a llamar con un título menos ambiguo.",
          // La pantalla ofrece las candidatas para tocar; run.ts lo saca antes de
          // que le cueste tokens al modelo. El `tag` es la lista donde vive.
          panel: {
            tipo: "eleccion",
            titulo,
            pregunta: "¿Cuál de estas es?",
            opciones: candidatas.map((t) => ({ v: t.titulo, tag: t.lista })),
          },
        };
      }

      const t = candidatas[0];
      const antes = { titulo: t.titulo, cuando: cuandoTarjeta(t.vence), nota: t.nota };

      if (accion === "completar") {
        const p = guardar({
          dominio: "tarea", tipo: "editar",
          tarea: { accion: "completar", taskId: t.id, listaId: t.listaId, titulo: t.titulo },
        });
        return {
          ok: true,
          // Completar se dibuja como una edición: el mismo título con el tilde adelante.
          propuesta: {
            id: p.id, dominio: "tarea", tipo: "editar", antes,
            despues: { titulo: `✓ ${t.titulo}` },
          },
          para_decir: `Marcar "${t.titulo}" como hecha.`,
          que_hacer: `Mostrale y preguntale. Si confirma, llamá confirmar con id "${p.id}".`,
        };
      }

      if (accion === "borrar") {
        const p = guardar({
          dominio: "tarea", tipo: "borrar",
          tarea: { accion: "borrar", taskId: t.id, listaId: t.listaId, titulo: t.titulo },
        });
        return {
          ok: true,
          propuesta: { id: p.id, dominio: "tarea", tipo: "borrar", antes, despues: null },
          para_decir: `Borrar la tarea "${t.titulo}".`,
          que_hacer:
            `Es destructivo: confirmá con el usuario ANTES de llamar confirmar con id "${p.id}". ` +
            "Si en realidad la HIZO, lo que va es completar, no borrar.",
        };
      }

      // Editar.
      if (tituloNuevo === undefined && nota === undefined && vence === undefined) {
        return { ok: false, motivo: "No me dijiste qué cambiarle a la tarea." };
      }
      const p = guardar({
        dominio: "tarea", tipo: "editar",
        tarea: { accion: "editar", taskId: t.id, listaId: t.listaId, titulo: t.titulo, tituloNuevo, notas: nota, vence },
      });
      return {
        ok: true,
        propuesta: {
          id: p.id, dominio: "tarea", tipo: "editar", antes,
          despues: {
            titulo: tituloNuevo ?? t.titulo,
            cuando: cuandoTarjeta(vence ?? t.vence),
            nota: nota ?? t.nota,
          },
        },
        para_decir:
          `Cambiar "${t.titulo}": queda "${tituloNuevo ?? t.titulo}"` +
          `${vence ? `, vence ${humanizarVence(vence)}` : ""}.`,
        que_hacer: `Mostrale el antes y el después y preguntale. Si confirma, llamá confirmar con id "${p.id}".`,
      };
    } catch (e) {
      return errorTasks(e);
    }
  },
};

export const TOOLS_TAREAS: Tool[] = [tareasVer, tareasCambiar];
