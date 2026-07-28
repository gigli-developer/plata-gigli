// Cotizaciones compartidas: se cargan una vez y quedan disponibles de forma
// SÍNCRONA para cualquier componente (incluidos los que no hacen fetch, como el
// costo del asistente). Antes cada archivo hardcodeaba 1455/1462 por su cuenta.
import { db, fetchFxRates, FX_FALLBACK, type FxRates } from "./db";
import { readCache, writeCache } from "./cache";

let memoria: FxRates | null = null;
let enVuelo: Promise<FxRates> | null = null;

/** Última cotización conocida, sin esperar red. Cae al snapshot local y, si no hay, al fallback. */
export function fxSync(): FxRates {
  return memoria ?? readCache<FxRates>("fx") ?? FX_FALLBACK;
}

/** Trae las cotizaciones frescas (una sola request aunque la llamen varias páginas a la vez). */
export async function loadFx(): Promise<FxRates> {
  if (enVuelo) return enVuelo;
  enVuelo = fetchFxRates(db())
    .then((r) => { memoria = r; writeCache("fx", r); return r; })
    .catch(() => fxSync())
    .finally(() => { enVuelo = null; });
  return enVuelo;
}

/** Valúa un monto en ARS con las cotizaciones dadas (cotización VIVA, la de hoy). */
export const toArs = (amount: number, currency: string, fx: FxRates) =>
  currency === "USD" ? amount * fx.usd : currency === "USDT" ? amount * fx.usdt : amount;

/**
 * Valúa un movimiento en ARS usando la cotización CONGELADA del día en que ocurrió
 * (`transactions.fx_rate_ars`, que setea el trigger trg_tx_freeze_fx). Así un gasto
 * de abril vale lo que valió en abril y los meses cerrados dejan de moverse cada vez
 * que cambia el dólar. Solo cae a la cotización viva si la fila no tiene rate
 * congelado — en la práctica, únicamente si fx_rates no tenía ese día.
 *
 * Ojo: esto es para FLUJOS (gastos/ingresos ya ocurridos). Los SALDOS y el patrimonio
 * se siguen valuando a la cotización de hoy: tener USD 1.000 vale el dólar de hoy,
 * no el del día que entraron.
 */
export const arsDe = (amount: number, currency: string, fxRate: number | null, fx: FxRates) =>
  fxRate != null ? amount * fxRate : toArs(amount, currency, fx);

/**
 * Igual que `arsDe` pero para los agregados de `fetchMonthlyBreakdown`, donde cada
 * grupo ya trae sumada aparte la parte congelada (`totalArs`) y la que quedó sin
 * cotización (`totalPend`, en su moneda original).
 */
export const aggArs = (
  a: { currency: string; total?: number; totalArs?: number; totalPend?: number },
  fx: FxRates,
) =>
  // El `?? total` cubre un snapshot de caché con la forma vieja (sin los campos
  // nuevos): peor caso, valúa a cotización de hoy como antes, nunca NaN.
  a.totalArs != null || a.totalPend != null
    ? (a.totalArs ?? 0) + toArs(a.totalPend ?? 0, a.currency, fx)
    : toArs(a.total ?? 0, a.currency, fx);
