import type { SupabaseClient } from "@supabase/supabase-js";
import { guardar, descartar } from "./propuestas";
import type { Tool } from "./tools";
import { dia as diaAr, diaCorto } from "../fechas";

/**
 * Fase 6 — Puente con Claude Code. **Mitad servidor.**
 *
 * Lucas dicta una consigna de código por voz, el modelo la expande a un prompt
 * bien formado, el servidor la guarda como TAREA en `tareas_codigo` y devuelve
 * una previsualización. Recién cuando él confirma, `tarea_codigo_lanzar` marca
 * la tarea como `lista` y devuelve una acción para que el agente local corra
 * `claude -p` en la carpeta del repo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ LA CONFIRMACIÓN ES ESTRUCTURAL Y NO UNA SUGERENCIA DEL PROMPT
 *
 * Dictar código por voz sale mal: el STT destroza nombres de archivos y de
 * variables ("codigo.ts" sale "código punto teese"). El único momento en que eso
 * se atrapa es cuando se le lee de vuelta lo que se entendió. Si esa lectura
 * dependiera de que el modelo se acuerde de pedirla, no existiría: un prompt es
 * una sugerencia.
 *
 * Por eso se copia el cerrojo de `propuestas.ts`: **una tarea NO se puede lanzar
 * en la misma request en la que se dictó.** El modelo puede encadenar
 * `tarea_codigo_dictar` → `tarea_codigo_lanzar` en el mismo turno leyendo el id
 * de su propio resultado; con el cerrojo, esa segunda llamada devuelve
 * `ok: false` y le dice que pregunte. El usuario tiene que haber hablado en el
 * medio, sí o sí.
 *
 * Lo que se lee en voz alta (`para_decir`) es exactamente lo que puede haber
 * salido mal transcripto: el repo, los archivos y la consigna. Las reglas fijas
 * que el servidor le agrega al prompt NO se leen — son constantes y escucharlas
 * en cada dictado haría que Lucas deje de prestar atención justo a la parte que
 * importa.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SEGURIDAD — el reparto de responsabilidades
 *
 * El servicio de Next está expuesto a internet; el ejecutor corre en la máquina
 * personal de Lucas. Entonces:
 *
 *  · El servidor **nunca arma un comando de shell**. Manda `{tipo, valor}` con
 *    `tipo` de un enum cerrado (acá, `"codigo"`), y `valor` es un JSON de datos:
 *    repo, prompt, archivos, lista de herramientas. Ni un flag, ni una ruta
 *    absoluta, ni un pedazo de línea de comandos.
 *  · El servidor **sanea la entrada**: el repo es un NOMBRE (sin barras, sin
 *    letra de unidad, sin `..`) y los archivos son rutas relativas sin `..`. Un
 *    dictado no puede salirse de la carpeta.
 *  · El **cliente local es la autoridad final**: él resuelve el nombre del repo
 *    contra su propio mapa, verifica que el árbol esté limpio, que la rama no
 *    sea main, arma el argv con `shell=False` y aplica su propio
 *    `--allowedTools`. El servidor no le puede mandar nada que viole eso porque
 *    no le manda flags.
 *  · `--dangerously-skip-permissions` no aparece en este archivo ni puede
 *    aparecer: no hay ningún camino por el que el servidor mande flags.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTEGRACIÓN — este archivo no toca nada de lo que ya existe.
 * `TOOLS_CODIGO` se agrega al array `TOOLS` de `tools.ts`. Ver el informe.
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 *  borrador   dictada, esperando que Lucas confirme
 *  lista      confirmada y mandada al cliente local
 *  ejecutando el cliente arrancó `claude -p`
 *  hecha      terminó
 */
export type EstadoTarea = "borrador" | "lista" | "ejecutando" | "hecha";

export const ESTADOS: EstadoTarea[] = ["borrador", "lista", "ejecutando", "hecha"];

export type TareaCodigo = {
  id: string;
  repo: string;
  archivos: string[];
  prompt: string;
  estado: EstadoTarea;
  session_id: string | null;
  creado_en: string;
  /** La PC lo refresca cada ~2 min mientras ejecuta. Viejo = zombi. */
  ultimo_latido: string | null;
  /** Cómo terminó. NULL mientras no terminó; el estado `hecha` es para los dos. */
  exito: boolean | null;
  resumen: string | null;
  costo_usd: number | null;
};

/**
 * Un `ejecutando` sin latido hace 10 minutos es un zombi: la PC late cada ~2,
 * así que 10 son cinco latidos seguidos perdidos — eso no es red lenta, es una
 * máquina apagada o un Jarvis muerto. El zombi se puede relanzar.
 */
export const LATIDO_VENCIDO_MS = 10 * 60 * 1000;

export function latidoVencido(t: Pick<TareaCodigo, "ultimo_latido">): boolean {
  // Sin latido no hubo reclamo sano (el reclamo lo setea siempre): también zombi.
  if (!t.ultimo_latido) return true;
  const ts = Date.parse(t.ultimo_latido);
  return !Number.isFinite(ts) || Date.now() - ts > LATIDO_VENCIDO_MS;
}

/**
 * Lo que viaja adentro de `valor`, serializado como JSON.
 *
 * Es **datos, no un comando**. El cliente lo parsea, lo valida contra su propia
 * configuración y arma el argv él. `esquema` está para poder cambiar la forma
 * más adelante sin romper un cliente viejo: si no lo reconoce, que no ejecute.
 */
export type CargaCodigo = {
  esquema: 1;
  tarea_id: string;
  repo: string;
  prompt: string;
  archivos: string[];
  allowed_tools: string[];
  /** Para `claude --resume`. Hoy siempre null: lo llena el cliente al terminar. */
  resume_session_id: string | null;
};

/**
 * La acción que se le manda al cliente local. Mismo contrato que las de
 * `tools.ts` (`{tipo, valor}` con tipo de un enum cerrado); el tipo `"codigo"`
 * es nuevo y hay que sumarlo al union `Accion` de `tools.ts` — ver el informe.
 */
export type AccionCodigo = {
  tipo: "codigo";
  valor: string;
};

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MAX_ARCHIVOS = 20;
const MAX_LARGO_RUTA = 200;
const MAX_LARGO_CONSIGNA = 4000;
const MIN_LARGO_CONSIGNA = 12;
const MAX_PENDIENTES_A_MOSTRAR = 10;

/**
 * Con qué herramientas arranca Claude Code. **Bash queda afuera a propósito.**
 *
 * Sin Bash no puede correr tests ni el build, que es una limitación real; pero
 * mandar una spec de Bash desde el servidor sería el servidor decidiendo qué
 * comando se corre en la máquina de Lucas, que es justo lo que este diseño
 * evita. Si hace falta, se habilita **del lado del cliente**, que es la
 * autoridad y sabe en qué repo está parado.
 */
const HERRAMIENTAS_BASE = ["Read", "Grep", "Glob", "Edit", "Write"];

/** Nombre de herramienta pelado: sin paréntesis, sin espacios, sin specs. */
const NOMBRE_HERRAMIENTA = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/**
 * Se puede sobrescribir por env, pero solo con nombres pelados y nunca `Bash`:
 * un `CODIGO_ALLOWED_TOOLS` mal escrito no debería poder abrir la puerta que el
 * diseño cierra. Un valor inválido se descarta en silencio y quedan las base.
 */
function herramientasPermitidas(): string[] {
  const crudo = process.env.CODIGO_ALLOWED_TOOLS;
  if (!crudo) return HERRAMIENTAS_BASE;
  const limpias = crudo
    .split(",")
    .map((s) => s.trim())
    .filter((s) => NOMBRE_HERRAMIENTA.test(s) && s !== "Bash");
  return limpias.length ? limpias : HERRAMIENTAS_BASE;
}

/**
 * Repos aceptados, si están declarados. Es defensa en profundidad: el cliente
 * igual resuelve el nombre contra su propio mapa y rechaza lo que no conoce,
 * pero declararlos acá permite avisar en el momento del dictado —cuando Lucas
 * todavía está escuchando— en vez de que la tarea falle recién al lanzarse.
 */
function reposDeclarados(): string[] {
  return (process.env.CODIGO_REPOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copia local de la de `tools.ts` (que no está exportada, y no toco ese
 * archivo). Supabase no tira `Error` sino un objeto plano, y `String(e)` lo
 * dejaba en "[object Object]".
 */
function mensajeDeError(e: unknown): string {
  const cortar = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s);
  if (e instanceof Error) return cortar(e.message);
  if (e && typeof e === "object") {
    const o = e as { message?: string; details?: string; hint?: string; code?: string };
    const partes = [o.message, o.details, o.hint].filter(Boolean);
    if (partes.length) return cortar(partes.join(" · ") + (o.code ? ` [${o.code}]` : ""));
    return cortar(JSON.stringify(e));
  }
  return cortar(String(e));
}

/**
 * El id del único usuario de Plata: hace falta para escribir con el service
 * role, que no tiene sesión y por lo tanto `auth.uid()` es null. Mismo criterio
 * que `tools.ts`: se saca de una fila existente y se cachea.
 */
let cacheUsuario: string | null = null;
async function idDeUsuario(sb: SupabaseClient): Promise<string> {
  if (cacheUsuario) return cacheUsuario;
  const { data, error } = await sb.from("transactions").select("user_id").limit(1).single();
  if (error || !data?.user_id) {
    throw new Error(`No pude averiguar el user_id: ${mensajeDeError(error)}`);
  }
  cacheUsuario = String(data.user_id);
  return cacheUsuario;
}

/** Ids cortos y fáciles de decir en voz alta, igual que en `propuestas.ts`. */
function nuevoId(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789"; // sin i, l, o, 0, 1
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

/**
 * En qué request estamos.
 *
 * `propuestas.ts` lleva el contador (lo incrementa `nuevoTurno()` una vez por
 * request, desde `run.ts`) pero no lo exporta. En vez de duplicar un segundo
 * contador —que se desincronizaría del real y volvería el cerrojo decorativo—
 * se lee el que ya existe: se crea una propuesta sonda, se mira su `turno` y se
 * la borra en el acto. Nunca queda visible para nadie.
 *
 * (Si algún día `propuestas.ts` exporta el turno, esto son dos líneas menos.
 * El diff está en el informe.)
 */
function turnoDelRequest(): number {
  const sonda = guardar({ tipo: "crear" });
  descartar(sonda.id);
  return sonda.turno;
}

/**
 * En qué turno se dictó cada tarea. Solo sirve para el cerrojo del mismo turno.
 *
 * Si una tarea NO está acá es porque se dictó en otro proceso o antes de un
 * deploy — es decir, seguro en otra request— y entonces se puede lanzar. Eso es
 * lo que hace que las tareas diferidas ("mandá la que dejé ayer") sigan
 * funcionando: el cerrojo cubre el encadenado automático, no el paso del tiempo.
 */
const TURNO_DE = new Map<string, number>();
const MAX_TURNOS_RECORDADOS = 50;

function recordarTurno(id: string, turno: number) {
  while (TURNO_DE.size >= MAX_TURNOS_RECORDADOS) {
    const primera = TURNO_DE.keys().next();
    if (primera.done) break;
    TURNO_DE.delete(primera.value);
  }
  TURNO_DE.set(id, turno);
}

const normalizarId = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Saca caracteres de control: nunca son parte de nada dictado por voz. */
const sinControles = (s: string) =>
  Array.from(s)
    .map((c) => { const n = c.charCodeAt(0); return n < 32 || n === 127 ? " " : c; })
    .join("");

/**
 * El repo es un NOMBRE, no una ruta. Sin barras, sin `..`, sin `C:`.
 *
 * La ruta absoluta la resuelve el cliente contra su propio mapa. Que el nombre
 * no pueda contener separadores es lo que garantiza que un dictado no arme una
 * ruta: no hay nada que "escapar" porque la gramática no lo permite.
 */
const REPO_VALIDO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validarRepo(crudo: unknown): { repo: string } | { motivo: string } {
  const repo = sinControles(String(crudo ?? "")).trim();
  if (!repo) return { motivo: "Me falta el repo: decime en cuál laburamos." };
  if (!REPO_VALIDO.test(repo) || repo.includes("..")) {
    return {
      motivo:
        `"${repo}" no es un nombre de repo válido. Va el nombre de la carpeta a secas ` +
        `(letras, números, punto, guion), sin barras ni rutas.`,
    };
  }
  const declarados = reposDeclarados();
  if (declarados.length && !declarados.some((r) => r.toLowerCase() === repo.toLowerCase())) {
    return { motivo: `No conozco el repo "${repo}". Los que hay: ${declarados.join(", ")}.` };
  }
  return { repo };
}

/**
 * Los archivos son rutas RELATIVAS al repo. Se rechaza todo lo que pueda salir
 * de ahí: raíz, letra de unidad, UNC y cualquier segmento `..`.
 *
 * El cliente igual resuelve a absoluta y verifica que siga adentro de la
 * carpeta (es su trabajo y es el que sabe dónde está la carpeta). Esto es la
 * red de arriba: una ruta rara ni siquiera llega a guardarse.
 */
function validarArchivos(crudo: unknown): { archivos: string[] } | { motivo: string } {
  if (crudo === undefined || crudo === null) return { archivos: [] };
  if (!Array.isArray(crudo)) return { motivo: "`archivos` tiene que ser una lista de rutas." };
  if (crudo.length > MAX_ARCHIVOS) {
    return { motivo: `Son demasiados archivos (${crudo.length}). El tope es ${MAX_ARCHIVOS}.` };
  }

  const archivos: string[] = [];
  for (const item of crudo) {
    const bruto = sinControles(String(item ?? "")).trim().replace(/\\/g, "/");
    if (!bruto) continue;
    if (bruto.length > MAX_LARGO_RUTA) {
      return { motivo: `Esa ruta es demasiado larga: "${bruto.slice(0, 40)}…".` };
    }
    if (bruto.startsWith("/") || /^[A-Za-z]:/.test(bruto) || bruto.startsWith("//")) {
      return {
        motivo:
          `"${bruto}" es una ruta absoluta y no la acepto. Las rutas van relativas al repo ` +
          `(por ejemplo "lib/agent/codigo.ts").`,
      };
    }
    if (bruto.split("/").some((seg) => seg === "..")) {
      return { motivo: `"${bruto}" se sale del repo. No puede tener "..".` };
    }
    const limpio = bruto.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
    if (limpio && !archivos.includes(limpio)) archivos.push(limpio);
  }
  return { archivos };
}

/**
 * Las reglas del lanzador, dichas también DENTRO del prompt.
 *
 * No reemplazan a las que hace cumplir el cliente (rama, árbol limpio,
 * `--allowedTools`): esas son las que valen. Esto es para que el Claude Code
 * del otro lado sepa en qué marco está trabajando y no proponga deployar ni
 * aplicar una migración, que es lo que hace cuando nadie se lo aclara.
 */
const REGLAS_FIJAS = [
  "Trabajás sobre una rama, nunca sobre main.",
  "No deployes, no apliques migraciones y no corras nada destructivo.",
  "Si algo de la consigna quedó ambiguo, pará y preguntá en vez de adivinar: " +
    "esta consigna se dictó por voz y puede haber quedado mal transcripta.",
];

/** Arma el prompt final: contexto + consigna + reglas fijas. */
function armarPrompt(repo: string, consigna: string, archivos: string[]): string {
  const partes = [`Repo: ${repo}.`];
  if (archivos.length) {
    partes.push(
      `Archivos que menciona la consigna (rutas relativas al repo): ${archivos.join(", ")}.`,
    );
  }
  partes.push("", consigna, "", "Reglas de esta tarea:", ...REGLAS_FIJAS.map((r) => `- ${r}`));
  return partes.join("\n");
}

// ---------------------------------------------------------------------------
// Acceso a la tabla
// ---------------------------------------------------------------------------

const COLUMNAS =
  "id,repo,archivos,prompt,estado,session_id,creado_en,ultimo_latido,exito,resumen,costo_usd";

type Fila = {
  id: string;
  repo: string;
  archivos: string[] | null;
  prompt: string;
  estado: string;
  session_id: string | null;
  creado_en: string;
  ultimo_latido: string | null;
  exito: boolean | null;
  resumen: string | null;
  costo_usd: number | string | null;
};

const aTarea = (f: Fila): TareaCodigo => ({
  id: f.id,
  repo: f.repo,
  archivos: f.archivos ?? [],
  prompt: f.prompt,
  estado: (ESTADOS as string[]).includes(f.estado) ? (f.estado as EstadoTarea) : "borrador",
  session_id: f.session_id,
  creado_en: f.creado_en,
  ultimo_latido: f.ultimo_latido,
  exito: f.exito,
  resumen: f.resumen,
  // numeric de Postgres llega como string por PostgREST.
  costo_usd: f.costo_usd == null ? null : Number(f.costo_usd),
});

async function buscarTarea(sb: SupabaseClient, id: string): Promise<TareaCodigo | null> {
  const { data, error } = await sb
    .from("tareas_codigo")
    .select(COLUMNAS)
    .eq("id", id)
    .limit(1);
  if (error) throw error;
  const fila = (data as Fila[] | null)?.[0];
  return fila ? aTarea(fila) : null;
}

/**
 * Mueve una tarea de estado, PERO solo si está en uno de los estados `desde`.
 *
 * El condicionamiento no es prolijidad: es el reclamo atómico del ciclo. La PC
 * reclama con `lista → ejecutando`; si dos lanzamientos de la misma tarea llegan
 * casi juntos (el caso real: "no arrancó, mandala de nuevo" cuando SÍ había
 * arrancado), el primero se la lleva y el segundo encuentra el WHERE vacío y
 * devuelve null. Un UPDATE con WHERE es una sola sentencia: no hay ventana entre
 * leer el estado y escribirlo.
 *
 * La usa `/api/codigo` (reclamar / latido / soltar / terminar) y el propio
 * `tarea_codigo_lanzar` (confirmar y resucitar zombis).
 */
export async function transicionarTarea(
  sb: SupabaseClient,
  id: string,
  desde: EstadoTarea[],
  hacia: EstadoTarea,
  campos?: {
    session_id?: string | null;
    ultimo_latido?: string | null;
    exito?: boolean | null;
    resumen?: string | null;
    costo_usd?: number | null;
  },
): Promise<TareaCodigo | null> {
  const parche: Record<string, unknown> = { estado: hacia, ...(campos ?? {}) };
  const { data, error } = await sb
    .from("tareas_codigo")
    .update(parche)
    .eq("id", normalizarId(id))
    .in("estado", desde)
    .select(COLUMNAS);
  if (error) throw error;
  const fila = (data as Fila[] | null)?.[0];
  return fila ? aTarea(fila) : null;
}

/** Para que /api/codigo distinga "no estaba en ese estado" de "no existe". */
export async function leerTarea(sb: SupabaseClient, id: string): Promise<TareaCodigo | null> {
  return buscarTarea(sb, normalizarId(id));
}

/** Inserta reintentando si el id corto ya estaba tomado (colisión de PK). */
async function insertarTarea(
  sb: SupabaseClient,
  campos: { repo: string; archivos: string[]; prompt: string },
): Promise<TareaCodigo> {
  const userId = await idDeUsuario(sb);
  let ultimoError: unknown = null;
  for (let intento = 0; intento < 6; intento++) {
    const id = nuevoId();
    const { data, error } = await sb
      .from("tareas_codigo")
      .insert({ id, ...campos, estado: "borrador", user_id: userId })
      .select(COLUMNAS);
    if (!error) {
      const fila = (data as Fila[] | null)?.[0];
      if (fila) return aTarea(fila);
    }
    // 23505 = unique_violation. Cualquier otra cosa no se arregla reintentando.
    if (error && (error as { code?: string }).code !== "23505") throw error;
    ultimoError = error;
  }
  throw new Error(`No pude guardar la tarea: ${mensajeDeError(ultimoError)}`);
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

const tareaCodigoDictar: Tool = {
  name: "tarea_codigo_dictar",
  description:
    "PROPONE una tarea de código para que Claude Code la ejecute en un repo. NO lanza nada: " +
    "la guarda como borrador y devuelve la previsualización para leérsela. " +
    "En `intencion` va la consigna YA EXPANDIDA por vos: Lucas la dice en criollo y vos la " +
    "convertís en una consigna clara, autocontenida y en imperativo, como se la escribirías a " +
    "otro programador que no escuchó la conversación (qué hay que lograr, en qué archivos, y " +
    "qué NO tocar). No la resumas: lo que escribas es lo que se va a ejecutar. " +
    "`repo` es el NOMBRE de la carpeta, nunca una ruta. `archivos` son rutas relativas al repo. " +
    "⚠️ Después de llamarla, leéle la previsualización y ESPERÁ que confirme: esto se dictó por " +
    "voz y los nombres de archivo se transcriben mal. Recién ahí llamás `tarea_codigo_lanzar`.",
  input_schema: {
    type: "object",
    properties: {
      repo: {
        type: "string",
        description: "Nombre de la carpeta del repo. Ej: 'finanzas-app'. Sin barras ni rutas.",
      },
      intencion: {
        type: "string",
        description:
          "La consigna ya expandida, en imperativo y autocontenida. Es el texto que va a " +
          "recibir Claude Code.",
      },
      archivos: {
        type: "array",
        items: { type: "string" },
        description:
          "Rutas relativas al repo que la consigna menciona. Opcional. " +
          "Ej: ['lib/agent/codigo.ts'].",
      },
    },
    required: ["repo", "intencion"],
  },
  canales: ["pc"],
  async handler(sb, input) {
    const r = validarRepo(input?.repo);
    if ("motivo" in r) return { ok: false, motivo: r.motivo };

    const a = validarArchivos(input?.archivos);
    if ("motivo" in a) return { ok: false, motivo: a.motivo };

    const consigna = sinControles(String(input?.intencion ?? ""))
      .replace(/[ \t]+/g, " ")
      .trim();
    if (consigna.length < MIN_LARGO_CONSIGNA) {
      return {
        ok: false,
        motivo: "La consigna quedó demasiado corta como para ejecutarla.",
        que_hacer:
          "Expandila vos: qué hay que lograr, en qué archivos y qué no tocar. Si de verdad " +
          "no entendiste lo que te dijo, preguntale.",
      };
    }
    if (consigna.length > MAX_LARGO_CONSIGNA) {
      return { ok: false, motivo: `La consigna es demasiado larga (tope ${MAX_LARGO_CONSIGNA} caracteres).` };
    }

    let tarea: TareaCodigo;
    try {
      tarea = await insertarTarea(sb, {
        repo: r.repo,
        archivos: a.archivos,
        prompt: armarPrompt(r.repo, consigna, a.archivos),
      });
    } catch (e) {
      return { ok: false, motivo: `No pude guardar la tarea: ${mensajeDeError(e)}` };
    }

    // El cerrojo: queda anotado en qué request se dictó. `tarea_codigo_lanzar`
    // lo compara y se niega si es la misma.
    recordarTurno(tarea.id, turnoDelRequest());

    const listaArchivos = a.archivos.length ? a.archivos.join(", ") : null;

    return {
      ok: true,
      tarea_id: tarea.id,
      // Misma forma que las propuestas de agenda y plata, así la tarjeta de
      // previsualización del HUD la dibuja sin cambios.
      propuesta: {
        id: tarea.id,
        dominio: "codigo",
        tipo: "crear",
        antes: null,
        despues: {
          titulo: `Tarea de código en ${r.repo}`,
          cuando: listaArchivos ?? "sin archivos puntuales",
          nota: consigna,
        },
      },
      // Esto es LO QUE HAY QUE LEER: repo, archivos y consigna son exactamente
      // lo que el STT puede haber roto. Las reglas fijas del prompt no van acá
      // a propósito — son constantes y escucharlas cada vez hace que se deje de
      // prestar atención justo a la parte que cambia.
      revisar: { repo: r.repo, archivos: a.archivos, consigna },
      para_decir:
        `En ${r.repo}` +
        (listaArchivos ? `, tocando ${listaArchivos}` : "") +
        `: ${consigna}`,
      que_hacer:
        `Leéselo tal cual —el repo, los archivos y la consigna— y preguntale si la largo. ` +
        `NO la lances vos. Cuando te diga que sí, en su próximo mensaje, llamás ` +
        `\`tarea_codigo_lanzar\` con tarea_id "${tarea.id}".`,
    };
  },
};

const tareaCodigoLanzar: Tool = {
  name: "tarea_codigo_lanzar",
  description:
    "Lanza una tarea de código que YA se dictó y que Lucas ACEPTÓ: la marca como lista y se la " +
    "manda al agente local para que corra Claude Code. " +
    "Nunca la llames sin que haya dicho explícitamente que sí después de escuchar la " +
    "previsualización. Si dijo que no, usá cancelar=true.",
  input_schema: {
    type: "object",
    properties: {
      tarea_id: { type: "string", description: "El id que devolvió `tarea_codigo_dictar`." },
      cancelar: { type: "boolean", description: "true para descartar la tarea sin lanzarla." },
    },
    required: ["tarea_id"],
  },
  canales: ["pc"],
  esAccion: true,
  async handler(sb, input) {
    const id = normalizarId(input?.tarea_id);
    if (!id) return { ok: false, motivo: "Necesito el id de la tarea." };

    let tarea: TareaCodigo | null;
    try {
      tarea = await buscarTarea(sb, id);
    } catch (e) {
      return { ok: false, motivo: `No pude leer la tarea: ${mensajeDeError(e)}` };
    }
    if (!tarea) {
      return {
        ok: false,
        motivo: `No existe ninguna tarea con id "${id}".`,
        que_hacer: "Fijate con `tareas_codigo_ver` qué quedó pendiente. NO inventes que se lanzó.",
      };
    }

    if (input?.cancelar) {
      try {
        const { error } = await sb.from("tareas_codigo").delete().eq("id", id);
        if (error) throw error;
      } catch (e) {
        return { ok: false, motivo: `No pude descartarla: ${mensajeDeError(e)}` };
      }
      TURNO_DE.delete(id);
      // No lleva `accion`, así que el corte de la segunda vuelta de `run.ts` no
      // se dispara aunque la herramienta sea `esAccion`: el modelo redacta.
      return { ok: true, cancelada: true, para_decir: "Listo, la descarto." };
    }

    // ── El cerrojo ───────────────────────────────────────────────────────────
    // Dictar y lanzar no pueden ser la misma request. El modelo puede encadenar
    // las dos herramientas leyendo el id de su propio resultado; acá se corta.
    // El usuario tiene que haber hablado en el medio.
    const dictadaEn = TURNO_DE.get(id);
    if (dictadaEn !== undefined && dictadaEn === turnoDelRequest()) {
      return {
        ok: false,
        motivo: "Recién la dicté: Lucas todavía no escuchó la previsualización.",
        que_hacer:
          "Leéle el repo, los archivos y la consigna, y PREGUNTALE si la largo. No la lances " +
          "vos. Cuando te conteste que sí, en su próximo mensaje, ahí llamás " +
          "`tarea_codigo_lanzar`.",
      };
    }

    // Un `ejecutando` que late está corriendo de verdad; uno que dejó de latir
    // hace >10 min es un zombi (la PC se apagó a mitad de la tarea) y lo único
    // sensato es dejar relanzarlo — si no, queda clavado en "ya está corriendo"
    // para siempre.
    const zombi = tarea.estado === "ejecutando" && latidoVencido(tarea);
    if (tarea.estado === "ejecutando" && !zombi) {
      return {
        ok: false,
        motivo: `Esa tarea ya está corriendo en ${tarea.repo}.`,
        que_hacer: "Decíselo. NO la vuelvas a lanzar.",
      };
    }
    if (tarea.estado === "hecha") {
      if (tarea.exito === false) {
        return {
          ok: false,
          motivo:
            `Esa tarea ya se corrió en ${tarea.repo} y FALLÓ` +
            (tarea.resumen ? `: ${recortarParaVoz(tarea.resumen)}` : "."),
          que_hacer:
            "Decíselo, con el motivo. Para reintentar hay que dictarla de nuevo con " +
            "`tarea_codigo_dictar` (el repo puede haber quedado a medio tocar: avisale eso también).",
        };
      }
      return {
        ok: false,
        motivo: `Esa tarea ya se hizo (${tarea.repo}).`,
        que_hacer: "Decíselo. Si quiere algo más, hay que dictar una tarea nueva.",
      };
    }

    // `lista` y ya lanzada: se permite reenviar, porque el caso real es "no
    // arrancó, mandala de nuevo". La deduplicación no es una promesa del
    // cliente: es el reclamo atómico — si SÍ había arrancado, la tarea está
    // `ejecutando` y el reclamo del segundo envío encuentra el WHERE vacío.
    const reenvio = tarea.estado === "lista" || zombi;

    try {
      // La transición es condicionada también acá: si entre el SELECT de arriba
      // y este UPDATE la PC reclamó la tarea (o la terminó), el WHERE queda
      // vacío y NO se le pisa el estado.
      const actualizada = await transicionarTarea(
        sb, id,
        zombi ? ["ejecutando"] : ["borrador", "lista"],
        "lista",
        zombi ? { ultimo_latido: null } : undefined,
      );
      if (!actualizada) {
        return {
          ok: false,
          motivo: "La tarea cambió de estado justo mientras la lanzaba (la PC la agarró o la terminó).",
          que_hacer: "Fijate con `tareas_codigo_ver` cómo quedó antes de contestar.",
        };
      }
      tarea = actualizada;
    } catch (e) {
      return { ok: false, motivo: `No pude marcarla como lista: ${mensajeDeError(e)}` };
    }

    const carga: CargaCodigo = {
      esquema: 1,
      tarea_id: tarea.id,
      repo: tarea.repo,
      prompt: tarea.prompt,
      archivos: tarea.archivos,
      allowed_tools: herramientasPermitidas(),
      resume_session_id: tarea.session_id,
    };

    const accion: AccionCodigo = { tipo: "codigo", valor: JSON.stringify(carga) };

    return {
      ok: true,
      tarea_id: tarea.id,
      reenvio,
      abriendo: `la tarea en ${tarea.repo}`,
      frase: zombi
        ? `Esa tarea había quedado colgada (la PC dejó de reportar a mitad de camino). La relanzo en ${tarea.repo}.`
        : reenvio
          ? `Dale, la mando de nuevo a ${tarea.repo}.`
          : `Dale, la largo en ${tarea.repo}.`,
      accion,
    };
  },
};

const tareasCodigoVer: Tool = {
  name: "tareas_codigo_ver",
  description:
    "Qué tareas de código quedaron pendientes: las dictadas y sin confirmar (borrador), las " +
    "confirmadas (lista) y las que están corriendo. Usar para 'qué tareas dejé', " +
    "'mandá la tarea que dejé', 'quedó algo pendiente de código'.",
  input_schema: {
    type: "object",
    properties: {
      estado: {
        type: "string",
        enum: ESTADOS,
        description: "Filtra por estado. Sin esto trae todo lo que no está hecho.",
      },
      repo: { type: "string", description: "Filtra por repo. Opcional." },
    },
    required: [],
  },
  canales: ["pc"],
  async handler(sb, input) {
    const estado = String(input?.estado ?? "").trim();
    const repo = sinControles(String(input?.repo ?? "")).trim();

    let q = sb
      .from("tareas_codigo")
      .select(COLUMNAS)
      .order("creado_en", { ascending: false })
      .limit(MAX_PENDIENTES_A_MOSTRAR);

    if ((ESTADOS as string[]).includes(estado)) q = q.eq("estado", estado);
    else q = q.in("estado", ["borrador", "lista", "ejecutando"]);
    if (repo && REPO_VALIDO.test(repo)) q = q.eq("repo", repo);

    const { data, error } = await q;
    if (error) return { ok: false, motivo: `No pude leer las tareas: ${mensajeDeError(error)}` };

    const tareas = ((data as Fila[] | null) ?? []).map(aTarea);
    if (!tareas.length) {
      return { ok: true, cuantas: 0, tareas: [], para_decir: "No tenés ninguna tarea de código pendiente." };
    }

    // Conclusiones, no filas crudas (regla de oro del proyecto): el prompt
    // entero de cada tarea son ~300 tokens y no hace falta para decir qué hay
    // pendiente. Va la consigna recortada; el prompt completo se lee al lanzar.
    const lista = tareas.map((t) => ({
      id: t.id,
      repo: t.repo,
      estado: t.estado,
      cuando: diaCorto(diaAr(t.creado_en)),
      archivos: t.archivos.length,
      consigna: consignaCorta(t.prompt),
      // Una `ejecutando` que dejó de latir está colgada: la PC murió a mitad de
      // camino. Se dice tal cual — relanzarla es `tarea_codigo_lanzar`, que ya
      // sabe resucitar zombis.
      ...(t.estado === "ejecutando" && latidoVencido(t) ? { colgada: true } : {}),
      // Las terminadas cuentan cómo salieron (aparecen al filtrar estado=hecha).
      ...(t.estado === "hecha"
        ? { exito: t.exito, ...(t.resumen ? { resumen: recortarParaVoz(t.resumen) } : {}) }
        : {}),
    }));

    const porEstado = tareas.reduce<Record<string, number>>((acc, t) => {
      acc[t.estado] = (acc[t.estado] ?? 0) + 1;
      return acc;
    }, {});

    return {
      ok: true,
      cuantas: tareas.length,
      por_estado: porEstado,
      tareas: lista,
      para_decir:
        `${tareas.length} tarea${tareas.length === 1 ? "" : "s"} de código: ` +
        lista
          .map((t) => `${t.repo} (${"colgada" in t && t.colgada ? "colgada" : t.estado})`)
          .join(", ") + ".",
      que_hacer:
        "Si quiere lanzar una, usá `tarea_codigo_lanzar` con su id. Si quiere cambiarla, " +
        "hay que dictarla de nuevo con `tarea_codigo_dictar`.",
    };
  },
};

/**
 * El resumen final de una sesión de Claude Code puede tener 2000 caracteres;
 * para el canal de voz alcanzan las primeras frases.
 */
function recortarParaVoz(texto: string): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  return limpio.length > 220 ? limpio.slice(0, 220) + "…" : limpio;
}

/**
 * La consigna sin el contexto ni las reglas fijas que agrega `armarPrompt`.
 * Se recorta para que listar 10 tareas no cueste 3.000 tokens.
 */
function consignaCorta(prompt: string): string {
  const cuerpo = prompt.split("\nReglas de esta tarea:")[0];
  const lineas = cuerpo
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Repo:") && !l.startsWith("Archivos que menciona"));
  const texto = lineas.join(" ");
  return texto.length > 140 ? texto.slice(0, 140) + "…" : texto;
}

// ---------------------------------------------------------------------------

/** Para sumar al array `TOOLS` de `tools.ts`. Ver el informe. */
export const TOOLS_CODIGO: Tool[] = [tareaCodigoDictar, tareaCodigoLanzar, tareasCodigoVer];

export const NOMBRES_CODIGO = TOOLS_CODIGO.map((t) => t.name);

/**
 * ¿La consulta huele a tarea de código? **Escrito, pero NO recomendado. Leé por
 * qué antes de usarlo.**
 *
 * La idea era la obvia: los tres schemas de acá suman ~675 tokens contra los
 * ~3.570 que ya viajan en cada consulta del canal PC (+19%), y una consulta de
 * finanzas nunca los va a usar. Filtrarlos parece plata regalada.
 *
 * **Sale más caro filtrarlos que mandarlos.** Los `tools` son el primer bloque
 * del prefijo cacheado (tools → system → mensajes), y `run.ts` pone
 * `cache_control` sobre el system, así que hoy el prefijo entero —schemas
 * incluidos— se cachea. Con caché caliente, 675 tokens de más cuestan
 * **US$ 0,00007 por llamada** (lectura a US$ 0,10/M en Haiku): nada. Pero
 * cambiar la lista de herramientas entre una consulta y la siguiente **cambia el
 * prefijo y tira el caché**, y reescribirlo son ~5.600 tokens a US$ 1,25/M =
 * **US$ 0,007**, cien veces lo que se ahorraba. Es el mismo problema que el
 * CLAUDE.md ya anota para Hermes: cambiar de modelo a mitad de sesión resetea el
 * caché y el re-read a precio completo cuesta más que la diferencia.
 *
 * O sea: la lista de herramientas conviene **estable**. Queda esto acá por si
 * alguna vez se mide lo contrario (por ejemplo si el caché deja de pegar), no
 * para usarlo de entrada.
 */
const PIDE_CODIGO =
  /\b(c[oó]digo|claude code|repo|repositorio|refactor|refactoriz|programar|commit|branch|rama|pull request|bug|tareas?|tarea_codigo)\b/i;

export const pareceTareaDeCodigo = (texto: string): boolean => PIDE_CODIGO.test(texto);

/**
 * ¿La propuesta que está esperando respuesta es una tarea de código?
 *
 * Hace falta para el filtro de arriba y es el detalle que lo salva: en el turno
 * de la confirmación Lucas dice "sí, dale" —que no menciona ninguna palabra de
 * código— y sin esto `tarea_codigo_lanzar` no se declararía justo en el turno en
 * el que hay que llamarla. La tarea quedaría imposible de lanzar.
 *
 * Se responde con lo que ya está en memoria, sin tocar la base.
 */
export const esTareaDeCodigo = (id?: string | null): boolean =>
  !!id && TURNO_DE.has(normalizarId(id));
