import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient, loadSecrets } from "@/lib/supabase/service";
import { secretoOk, rechazoTemprano } from "@/lib/agent/canal";
import {
  transicionarTarea,
  leerTarea,
  type EstadoTarea,
  type TareaCodigo,
} from "@/lib/agent/codigo";

/**
 * El ciclo de estados de `tareas_codigo`, del lado que le toca a la PC.
 *
 * `tarea_codigo_lanzar` deja la tarea en `lista` y le manda la carga al agente
 * local; desde ahí el dueño de la verdad es la PC — es la única que sabe si
 * Claude Code arrancó, si sigue vivo y cómo terminó. Este endpoint es el
 * canal por el que lo cuenta:
 *
 *   reclamar  lista → ejecutando   ANTES del Popen. Es un UPDATE condicionado
 *                                  por estado: si la tarea ya no está en
 *                                  `lista`, la PC NO lanza. Ese único WHERE es
 *                                  toda la deduplicación del "mandala de nuevo".
 *   latido    refresca `ultimo_latido` mientras corre (cada ~2 min). Un
 *             `ejecutando` sin latido hace 10 min es un zombi y el lanzador lo
 *             deja relanzar.
 *   soltar    ejecutando → lista   "reclamé pero no llegué a arrancar" (falló
 *                                  la copia de archivos, el Popen, etc.). Deja
 *                                  la tarea relanzable sin esperar el vencimiento.
 *   terminar  ejecutando → hecha   con `exito`, `resumen`, `costo_usd` y el
 *                                  `session_id` para `claude --resume`.
 *
 * ⚠️ Esto NO es una herramienta del modelo, a propósito, por dos razones:
 *   · La lista de herramientas es prefijo del caché de prompt (regla 7 del
 *     contrato del cerebro): agregar una la rompe. Un endpoint aparte no toca
 *     nada de eso.
 *   · El estado lo reporta código, no un modelo: acá no hay nadie que pueda
 *     "redondear" la verdad. Un modelo con una herramienta `marcar_hecha`
 *     tarde o temprano la llama para cerrar una conversación.
 *
 * Por lo mismo, acá NO se llama `nuevoTurno()`: el contador de turnos es el
 * cerrojo conversacional de proponer→confirmar, y un latido que cayera en el
 * medio de una conversación lo avanzaría — el "tiene que hablar el usuario en
 * el medio" pasaría a ser "o que la PC lata", que es exactamente lo que el
 * cerrojo existe para impedir.
 *
 * Mismo cerrojo de acceso que /api/pc y /api/tool: header `x-pc-secret`
 * comparado en tiempo constante.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ORDENES = new Set(["reclamar", "latido", "soltar", "terminar"]);

const MAX_RESUMEN = 2000; // el check de la columna; acá se recorta, no se rebota
const MAX_SESSION_ID = 64;

async function autorizar(request: Request) {
  if (rechazoTemprano(request)) return { error: "no", status: 401 as const };
  const sb = createServiceClient();
  const secrets = await loadSecrets(sb);
  if (!secrets.PC_CHANNEL_SECRET) return { error: "no configurado", status: 500 as const };
  if (!secretoOk(request.headers.get("x-pc-secret"), secrets.PC_CHANNEL_SECRET)) {
    return { error: "no", status: 401 as const };
  }
  return { sb };
}

/** Lo que se le devuelve a la PC: el estado y poco más. El prompt no hace falta. */
function resumir(t: TareaCodigo) {
  return { id: t.id, repo: t.repo, estado: t.estado, exito: t.exito };
}

/**
 * El motivo cuando una transición encontró el WHERE vacío. Se relee la fila
 * para contestar la verdad ("ya está hecha") y no un genérico; si además no
 * existe, eso también se dice.
 */
async function motivoDelRechazo(
  sb: SupabaseClient,
  id: string,
  esperaba: EstadoTarea,
): Promise<{ motivo: string; tarea?: ReturnType<typeof resumir> }> {
  const tarea = await leerTarea(sb, id).catch(() => null);
  if (!tarea) return { motivo: `no existe ninguna tarea "${id}"` };
  return {
    motivo: `la tarea está en "${tarea.estado}" y esta orden esperaba "${esperaba}"`,
    tarea: resumir(tarea),
  };
}

export async function POST(request: Request) {
  const a = await autorizar(request);
  if ("error" in a) return Response.json({ error: a.error }, { status: a.status });

  const body = await request.json().catch(() => null);
  const orden = String(body?.orden ?? "").trim();
  const id = String(body?.tarea_id ?? "").trim().toLowerCase();
  if (!ORDENES.has(orden)) return Response.json({ ok: false, motivo: "orden desconocida" }, { status: 400 });
  if (!id || id.length > 16) return Response.json({ ok: false, motivo: "falta tarea_id" }, { status: 400 });

  const ahora = new Date().toISOString();

  try {
    if (orden === "reclamar") {
      const t = await transicionarTarea(a.sb, id, ["lista"], "ejecutando", { ultimo_latido: ahora });
      if (t) return Response.json({ ok: true, tarea: resumir(t) });
      return Response.json({ ok: false, ...(await motivoDelRechazo(a.sb, id, "lista")) });
    }

    if (orden === "latido") {
      // De ejecutando a ejecutando: solo refresca el reloj. Si la tarea ya no
      // está `ejecutando` (la terminó, o un relanzamiento se la llevó), el ok
      // en false le dice a la PC que deje de latir por esta tarea.
      const t = await transicionarTarea(a.sb, id, ["ejecutando"], "ejecutando", { ultimo_latido: ahora });
      if (t) return Response.json({ ok: true });
      return Response.json({ ok: false, ...(await motivoDelRechazo(a.sb, id, "ejecutando")) });
    }

    if (orden === "soltar") {
      const t = await transicionarTarea(a.sb, id, ["ejecutando"], "lista", { ultimo_latido: null });
      if (t) return Response.json({ ok: true, tarea: resumir(t) });
      return Response.json({ ok: false, ...(await motivoDelRechazo(a.sb, id, "ejecutando")) });
    }

    // terminar
    const exito = body?.exito === true;
    const resumen = typeof body?.resumen === "string" && body.resumen.trim()
      ? body.resumen.trim().slice(0, MAX_RESUMEN)
      : null;
    const costo = Number(body?.costo_usd);
    const sesion = typeof body?.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim().slice(0, MAX_SESSION_ID)
      : undefined; // undefined = no pisar el que hubiera
    const t = await transicionarTarea(a.sb, id, ["ejecutando"], "hecha", {
      exito,
      resumen,
      costo_usd: Number.isFinite(costo) && costo >= 0 ? costo : null,
      ultimo_latido: ahora,
      ...(sesion !== undefined ? { session_id: sesion } : {}),
    });
    if (t) return Response.json({ ok: true, tarea: resumir(t) });
    return Response.json({ ok: false, ...(await motivoDelRechazo(a.sb, id, "ejecutando")) });
  } catch (e) {
    // El detalle va al log del server; a la red sale lo mínimo, como en /api/tool.
    console.error("api/codigo", orden, id, e);
    return Response.json({ ok: false, motivo: "no se pudo" }, { status: 500 });
  }
}
