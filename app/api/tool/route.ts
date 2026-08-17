import { createServiceClient, loadSecrets } from "@/lib/supabase/service";
import { secretoOk, rechazoTemprano } from "@/lib/agent/canal";
import { ejecutarTool, schemasPara } from "@/lib/agent/tools";
import { nuevoTurno } from "@/lib/agent/propuestas";

/**
 * Ejecuta UNA herramienta, sin modelo de por medio.
 *
 * Para qué: cuando el modelo vive fuera de acá (una API de voz a voz corriendo en
 * la máquina del usuario), es el cliente quien recibe el pedido de herramienta.
 * Este endpoint le deja resolverlo sin reescribir en Python la lógica que ya
 * existe en TypeScript, y sin sacar las credenciales de Supabase y Google del
 * servidor.
 *
 * GET  → los esquemas de las 9 herramientas, para declarárselas al modelo.
 * POST → { nombre, input } y devuelve el resultado tal cual, con `panel` incluido
 *        (el cliente decide qué dibuja y qué le devuelve al modelo).
 *
 * Mismo cerrojo que /api/pc: header `x-pc-secret` comparado en tiempo constante.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function autorizar(request: Request) {
  // Rechazo antes de tocar la base: sin esto, una request sin secreto igual
  // disparaba un SELECT a app_secrets.
  if (rechazoTemprano(request)) return { error: "no", status: 401 as const };

  const sb = createServiceClient();
  const secrets = await loadSecrets(sb);
  if (!secrets.PC_CHANNEL_SECRET) return { error: "no configurado", status: 500 as const };
  if (!secretoOk(request.headers.get("x-pc-secret"), secrets.PC_CHANNEL_SECRET)) {
    return { error: "no", status: 401 as const };
  }
  return { sb };
}

export async function GET(request: Request) {
  const a = await autorizar(request);
  if ("error" in a) return Response.json({ error: a.error }, { status: a.status });
  return Response.json({ herramientas: schemasPara("pc") });
}

export async function POST(request: Request) {
  const a = await autorizar(request);
  if ("error" in a) return Response.json({ error: a.error }, { status: a.status });

  const body = await request.json().catch(() => null);
  const nombre = String(body?.nombre ?? "").trim();
  if (!nombre) return Response.json({ error: "falta nombre" }, { status: 400 });

  // Cada llamada es una request distinta, así que avanza el turno. Sin esto el
  // contador quedaba clavado y `agenda_confirmar` SIEMPRE se rechazaba con
  // "mismo_turno": el cerrojo terminaba bloqueando el uso legítimo.
  //
  // Ojo: acá el sello ya no garantiza que el usuario haya hablado en el medio
  // (dos tool calls seguidas son dos requests). Esa garantía la pone el cliente,
  // que exige un turno de voz entre proponer y confirmar.
  nuevoTurno();

  // Techo al tamaño de la entrada: los strings viajan a PostgREST y a APIs de
  // terceros, y no había ningún límite (el de /api/pc recorta a 2000).
  const input = recortar((body?.input ?? {}) as Record<string, unknown>);

  try {
    const salida = await ejecutarTool(a.sb, nombre, input, "pc");
    // El `ok` del sobre refleja lo que pasó de verdad: antes venía siempre en
    // `true` con el fallo escondido adentro de `resultado`, así que un cliente
    // que mirara el nivel de arriba concluía que había salido todo bien.
    const r = salida as { ok?: boolean; error?: unknown } | null;
    const salioBien = !(r && typeof r === "object" && (r.ok === false || r.error !== undefined));
    return Response.json({ ok: salioBien, resultado: salida });
  } catch (e) {
    // El detalle va al log, no al cliente: los errores de Supabase y Anthropic
    // cuentan de más sobre la infraestructura.
    console.error("api/tool", nombre, e);
    return Response.json({ ok: false, error: "no se pudo ejecutar" }, { status: 500 });
  }
}

const MAX_TEXTO = 2000;
const MAX_LISTA = 50;

/** Recorta strings largos y listas enormes, sin cambiar la forma del objeto. */
function recortar(input: Record<string, unknown>): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") salida[k] = v.slice(0, MAX_TEXTO);
    else if (Array.isArray(v)) {
      salida[k] = v.slice(0, MAX_LISTA).map((x) =>
        typeof x === "string" ? x.slice(0, MAX_TEXTO) : x);
    } else salida[k] = v;
  }
  return salida;
}
