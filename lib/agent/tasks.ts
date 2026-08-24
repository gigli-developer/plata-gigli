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
 * El scope de Tasks tampoco da para mucho más protagonismo por voz.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ EL TECHO: UNA TAREA NO TIENE HORA Y NO AVISA NADA
 * ---------------------------------------------------------------------------
 *
 * Lo que Google Tasks SÍ guarda — y es TODO lo que guarda:
 *   · `title`   el título.
 *   · `notes`   una nota libre (acá se corta a 300 al leer).
 *   · `due`     el día de vencimiento… y nada más que el DÍA.
 *   · `status`  pendiente / completada (con su timestamp, que lo pone Google).
 *   · la lista donde vive (las cinco de arriba).
 *
 * Lo que NO existe, y no se arregla agregando un campo:
 *   · hora del día,
 *   · recordatorios,
 *   · alertas o notificaciones al celular.
 *
 * El POR QUÉ es la API, no este código. El único campo de tiempo del recurso
 * `Task` es `due`, y la doc de Google es explícita: la porción de HORA se
 * DESCARTA al escribir y no se puede ni leer ni escribir por la API. Los avisos
 * que uno ve en el teléfono son una función de las apps de Google (Tasks de
 * Android, Calendar, Assistant): viven del lado del cliente y la API pública no
 * los expone. Por eso una tarea creada desde acá NUNCA va a sonar, aunque la
 * misma tarea creada a mano en el celular sí suene. No hay flag, scope ni
 * endpoint que lo destrabe: pedir otro scope solo cambia el 403, no el techo.
 *
 * La consecuencia práctica —que es la que gobierna el ruteo del modelo—: todo lo
 * que lleve HORA o pida que le AVISEN no es una tarea, es un EVENTO de Calendar
 * (`agenda_cambiar`, en `google.ts`), que sí tiene recordatorio y sí notifica.
 * "comprar pan" es tarea; "llamarlo a las 3" es evento. Eso está dicho tres
 * veces a propósito, porque una sola no alcanza: en la `description` de
 * `tareas_cambiar` con ejemplos de frases (es lo ÚNICO que el modelo lee para
 * decidir), en el campo `vence` del schema, y en `desvioAAgenda()`, que rebota
 * lo que igual cae acá en vez de anotar una tarea a medias y decir "listo".
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

/**
 * Lo que se COMPLETO hoy (dia argentino), para el repaso de la noche. Google
 * guarda `completed` en UTC; el corte va con el offset -03:00 explicito para
 * que el «hoy» sea el de aca y no el de Greenwich.
 */
export async function listarCompletadasHoy(sb: SupabaseClient): Promise<{ titulo: string; lista: string }[]> {
  const q = new URLSearchParams({
    showCompleted: "true", showHidden: "true", maxResults: "100",
    completedMin: new Date(`${hoyAr()}T00:00:00-03:00`).toISOString(),
  });
  const ls = await listas(sb);
  const porLista = await Promise.all(
    ls.map(async (l) => {
      const d = await api(sb, `/lists/${encodeURIComponent(l.id)}/tasks?${q}`);
      return ((d?.items ?? []) as (TareaGoogle & { status?: string })[])
        .filter((x) => x.status === "completed")
        .map((x) => ({ titulo: String(x.title ?? "(sin titulo)"), lista: l.titulo }));
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
  //
  // ⚠️ La `Z` es a propósito y NO es el bug de UTC de siempre: acá NO se está
  // convirtiendo un instante, se está empaquetando una FECHA en el formato que
  // la API exige. Google se queda con la parte de fecha del timestamp, así que
  // mandando medianoche UTC el día que queda guardado es exactamente el
  // YYYY-MM-DD que dictó el usuario. Verificado de ida y vuelta:
  //   "2026-08-25" → due "2026-08-25T00:00:00.000Z" → Google devuelve ese mismo
  //   string → `aTarea` lo lee con slice(0,10) → "2026-08-25". Cierra.
  // Las dos maneras de romperlo, para que nadie las "arregle" de nuevo:
  //   · leer con `dia()` en vez de `slice` → medianoche UTC en ART es el día
  //     ANTERIOR a las 21:00, y toda tarea aparecería corrida un día atrás;
  //   · mandar el offset argentino (`T00:00:00-03:00`) → Google lo normaliza a
  //     las 03:00Z del MISMO día y hoy da bien, pero queda dependiendo de su
  //     normalización en vez de ser la fecha literal que mandamos.
  // La combinación actual (escribir con Z, leer con slice) es la única que no
  // depende de la hora del servidor ni de nada del otro lado.
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
// El techo: detectar lo que pide hora o aviso (ver la cabecera)
// ---------------------------------------------------------------------------

/*
 * La `description` le dice al modelo que lo que lleva hora va por `agenda_cambiar`,
 * pero una description es una sugerencia: igual va a caer acá "llamar al contador
 * a las 3". Estos patrones son la red, y son deliberadamente ESTRECHOS — un falso
 * positivo manda a la agenda algo que era una tarea legítima, que es peor que
 * dejarla pasar:
 *
 *   · el reloj va con dos puntos y nada más. Con punto ("3.45") pescaba precios
 *     y cantidades, que en un título de tarea son mucho más comunes que un horario.
 *   · "a las 3" solo cuenta si CIERRA la frase o si viene con su marca ("hs",
 *     "de la tarde", "y media"). Si no, "llamar a las 3 personas" terminaba en
 *     la agenda.
 *   · "acordame" / "recordame" / "avisame" a secas NO disparan: así se dicta una
 *     tarea normal en criollo ("acordame de llamar al plomero") y es exactamente
 *     el caso que Tasks resuelve bien. Lo que dispara es pedir el ARTEFACTO —
 *     una alarma, un recordatorio, una notificación — o un aviso relativo
 *     ("media hora antes"), que sin hora base no significa nada.
 */
const RELOJ = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/;
const A_LAS_CON_MARCA =
  /\ba\s+las?\s+(?:[01]?\d|2[0-3])\s*(?:y\s+(?:media|cuarto)|hs?\b|horas?\b|a\.?m\.?\b|p\.?m\.?\b|de\s+la\s+(?:ma(?:ñ|n)ana|tarde|noche)\b|del\s+mediod(?:í|i)a\b)/i;
const A_LAS_SOLA = /\ba\s+las?\s+(?:[01]?\d|2[0-3])\s*(?=$|[,;.])/i;
const AVISO_RELATIVO =
  /\b(?:\d+\s*(?:minutos?|min\b|horas?|hs?\b)|media\s+hora|un\s+rato)\s+antes\b/i;
const ARTEFACTO_DE_AVISO =
  /\b(?:alarma|recordatorio|notificaci(?:ó|o)n|notific(?:á|a)me|alert(?:á|a)me|despert(?:á|a)me)\b/i;

/** Qué señal encontró, en criollo y ya lista para meter en el `motivo`. Null si no hay ninguna. */
function senalDeHora(...textos: (string | undefined)[]): string | null {
  const t = textos.filter(Boolean).join(" · ");
  if (RELOJ.test(t) || A_LAS_CON_MARCA.test(t) || A_LAS_SOLA.test(t)) return "una hora";
  if (AVISO_RELATIVO.test(t)) return "un aviso con anticipación";
  if (ARTEFACTO_DE_AVISO.test(t)) return "un recordatorio";
  return null;
}

/** `2026-08-25T09:00` o `2026-08-25 09:00`: una fecha CON hora metida en `vence`. */
const FECHA_CON_HORA = /^\d{4}-\d{2}-\d{2}[T ]\s*\d{1,2}[:.]\d{2}/;

/**
 * La respuesta cuando lo dictado lleva hora o pide aviso.
 *
 * NO se propone nada a medias. La tarea se podría crear igual —Google la acepta
 * y tira la hora sola—, pero entonces el usuario escucha "listo, lo anoté" y se
 * entera de que nadie le avisó cuando ya pasó. Eso es peor que no hacer nada:
 * es fingir una capacidad que no existe. Se devuelve el techo en criollo, con el
 * desvío a la agenda, y que el modelo lo ofrezca.
 *
 * ⚠️ Si algún día el aviso deja de ser un evento de Calendar (otra herramienta,
 * otro nombre), este es el ÚNICO lugar del archivo que nombra `agenda_cambiar`
 * fuera de la `description`: se cambia acá y listo.
 */
function desvioAAgenda(que: string, senal: string) {
  return {
    ok: false,
    motivo:
      `"${que}" lleva ${senal}, y una tarea de Google Tasks no puede tener eso: guarda ` +
      "el DÍA de vencimiento y nada más. Sin hora, sin recordatorio y sin alerta — no " +
      "suena, no notifica, no aparece nada en el celular. Es la API de Google, no algo " +
      "que se pueda destrabar de este lado.",
    que_hacer:
      "Eso no es una tarea, es un EVENTO: proponelo con `agenda_cambiar` (accion " +
      '"crear", con la fecha y la hora que dijo), que sí lleva recordatorio y sí le ' +
      "suena el teléfono. Decíselo tal cual, sin vueltas: que como tarea no le iba a " +
      "avisar nadie, así que se lo agendás para esa hora. Si igual la quiere como tarea " +
      "suelta, sin aviso, volvé a llamarme con el título SIN la hora.",
  };
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
  input_schema: {
    type: "object",
    properties: {
      completadas: {
        type: "boolean",
        description:
          "true para ver las tareas que COMPLETO HOY (para el repaso del dia: " +
          "'que termine hoy?'). Sin esto, las pendientes de siempre.",
      },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    // El repaso de la noche pregunta al reves: no que falta, sino que se hizo.
    if (input?.completadas === true) {
      try {
        const hechas = await listarCompletadasHoy(sb);
        return {
          ok: true,
          cuantas: hechas.length,
          tareas: hechas.map((h) => ({ titulo: h.titulo, lista: h.lista })),
          para_decir: hechas.length
            ? `Hoy completaste ${hechas.length}: ${hechas.map((h) => `"${h.titulo}"`).join(", ")}.`
            : "Hoy no completaste ninguna tarea todavia.",
          panel: {
            tipo: "tareas",
            listas: [{
              nombre: "hechas hoy",
              tareas: hechas.map((h) => ({ titulo: `\u2713 ${h.titulo}`, vence: null, nota: h.lista })),
            }],
          },
        };
      } catch (e) {
        return errorTasks(e);
      }
    }
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
    "nada: devuelve una previsualización y hay que confirmarla con `confirmar`. " +
    "⚠️ UNA TAREA NO TIENE HORA Y NO AVISA NADA. Google Tasks solo guarda título, nota " +
    "y DÍA de vencimiento (sin hora), y no dispara ninguna alerta: no suena, no notifica, " +
    "no llega nada al celular. Es la API de Google, no una limitación que se pueda " +
    "destrabar. De ahí sale el criterio para elegir herramienta, y es el único que " +
    "importa: ¿la frase tiene HORA o pide que le AVISEN? " +
    "NO tiene hora → es una tarea y va ACÁ: 'anotá que tengo que comprar pilas', " +
    "'acordame de llamar al plomero', 'tengo que mandar la factura', 'pagar el seguro " +
    "antes del viernes', 'listo lo de la farmacia' (→ completar), 'sacá lo del service' " +
    "(→ borrar). " +
    "SÍ tiene hora o pide aviso → NO es una tarea, es un EVENTO, y va por " +
    "`agenda_cambiar`: 'llamar al contador a las 3', 'recordame mañana a las 9', " +
    "'avisame media hora antes de la reunión', 'ponéme una alarma para las 8', " +
    "'turno con el dentista el jueves 16:30'. Un evento de Calendar SÍ tiene " +
    "recordatorio y SÍ le suena el teléfono; una tarea con esa hora escrita en el " +
    "título se la come el silencio. Ante la duda, si en la frase hay un horario, es " +
    "agenda. Si igual mandás una hora acá, te la rebota. " +
    "Para completar, editar o borrar pasá el título TAL COMO lo dijo, aunque sea " +
    "aproximado: la herramienta la busca sola. Si dicta VARIAS tareas de una, van todas " +
    "juntas en `varias`: una sola propuesta y una sola confirmación. ⚠️ Las tareas de " +
    "CÓDIGO van por `tarea_codigo_dictar`, no por acá.",
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
            vence: { type: "string", description: "YYYY-MM-DD, el día pelado. Sin hora: no existe." },
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
          "Fecha límite YYYY-MM-DD, solo si dijo una ('para el viernes'). Calculala " +
          "contra el 'Hoy es…' del prompt, no de memoria. ⚠️ El día PELADO y nada más: " +
          "acá NO entra una hora ni un ISO con hora — Google Tasks la descarta y el " +
          "usuario se queda esperando un aviso que no existe. Si dijo una hora, la " +
          "herramienta correcta es `agenda_cambiar`.",
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
          // Una sola con hora tumba el lote entero, y está bien: si de tres cosas
          // dictadas una era "llamarlo a las 3", esa hay que agendarla, y anotar
          // las otras dos por separado sin decir nada de la tercera es la mentira
          // por omisión que este archivo trata de no cometer.
          const senalLote = senalDeHora(tit, String(t?.nota ?? "")) ??
            (v && FECHA_CON_HORA.test(v) ? "una hora" : null);
          if (senalLote) {
            const d = desvioAAgenda(tit, senalLote);
            if (varias.length === 1) return d;
            return {
              ...d,
              que_hacer:
                `${d.que_hacer} Ojo que venían ${varias.length} cosas dictadas y NO se ` +
                `anotó ninguna: agendá esa y volvé a mandarme las otras ${varias.length - 1} ` +
                "juntas en `varias`.",
            };
          }
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

      // El techo, antes que cualquier otra validación: si lo que pidió lleva hora
      // o aviso, el problema NO es el formato de la fecha, y decirle "va YYYY-MM-DD"
      // lo manda a reintentar tirando la hora en silencio — que es exactamente el
      // final que hay que evitar.
      //
      // Solo se mira lo que el usuario está ESCRIBIENDO: al crear, el título y la
      // nota; al editar, el título nuevo y la nota. En completar y borrar, `titulo`
      // es la aguja para buscar una tarea que ya existe, y esa bien puede llamarse
      // "llamar al contador a las 3" — rebotar ahí sería no dejarlo tacharla nunca.
      if (accion === "crear" || accion === "editar") {
        const escrito = accion === "crear" ? titulo : tituloNuevo;
        const senal = senalDeHora(escrito, nota) ??
          (vence && FECHA_CON_HORA.test(vence) ? "una hora" : null);
        if (senal) return desvioAAgenda(escrito || titulo, senal);
      }

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
