// Caché local stale-while-revalidate para las páginas: al montar se pinta
// el último snapshot conocido (instantáneo) y en paralelo se trae lo fresco
// de Supabase, que actualiza la UI y el snapshot. App mono-usuario: la
// staleness de unos segundos es aceptable; los datos viven solo en este navegador.
// La versión se bumpea cuando cambia la FORMA de algún snapshot: un caché viejo
// leído con el código nuevo daría campos undefined (y números NaN en pantalla)
// hasta que llegue el fetch fresco. v2: MonthAgg/TxView/ExpenseRow ganaron la
// cotización congelada (fx_rate_ars).
const PREFIX = "plata:v2:";

let limpiado = false;
/** Borra snapshots de versiones anteriores (una sola vez por sesión). */
function limpiarViejos() {
  if (limpiado) return;
  limpiado = true;
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("plata:") && !k.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* sin storage: nada que limpiar */ }
}

export function readCache<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  limpiarViejos();
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeCache(key: string, data: unknown) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    /* storage lleno o modo privado: seguimos sin caché */
  }
}
