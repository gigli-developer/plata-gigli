// Caché local stale-while-revalidate para las páginas: al montar se pinta
// el último snapshot conocido (instantáneo) y en paralelo se trae lo fresco
// de Supabase, que actualiza la UI y el snapshot. App mono-usuario: la
// staleness de unos segundos es aceptable; los datos viven solo en este navegador.
const PREFIX = "plata:v1:";

export function readCache<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
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
