import { timingSafeEqual } from "node:crypto";

/**
 * Autenticación del canal PC, compartida por `/api/pc` y `/api/tool`.
 *
 * El orden importa: primero se compara contra `PC_CHANNEL_SECRET` de las variables
 * de entorno y **recién si eso pasa** se toca la base.
 *
 * Antes se leía `app_secrets` ANTES de validar, así que cualquiera sin el secreto
 * podía forzar una consulta a Supabase por request — una superficie de gasto que
 * no hacía falta tener abierta. La env var es la misma cadena; `app_secrets` sigue
 * siendo la fuente de verdad para todo lo demás y como respaldo si la env falta.
 */

export function secretoOk(recibido: string | null, esperado: string): boolean {
  if (!recibido || !esperado) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  // Distinto largo se rechaza sin comparar: `timingSafeEqual` exige buffers iguales.
  // Filtra el largo en teoría, pero el ruido de red lo tapa por varios órdenes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Rechazo temprano y barato. `true` = seguro que NO está autorizado, cortar ya.
 * `false` = puede estar bien (o no hay env var configurada): seguir con la
 * validación contra `app_secrets`.
 */
export function rechazoTemprano(request: Request): boolean {
  const esperado = process.env.PC_CHANNEL_SECRET;
  if (!esperado) return false; // sin env var no se puede decidir acá
  return !secretoOk(request.headers.get("x-pc-secret"), esperado);
}

/** Lo que se le contesta a quien no tiene el secreto. Sin detalles, a propósito. */
export const NO_AUTORIZADO = Response.json({ error: "no" }, { status: 401 });
