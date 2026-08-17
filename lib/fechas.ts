/**
 * Fechas en horario argentino. **Fuente única.**
 *
 * Por qué existe este archivo: en producción el servidor corre en UTC y el usuario
 * vive en UTC-3. Cada vez que un pedazo de código resolvió fechas por su cuenta,
 * apareció el mismo bug. Van siete:
 *
 *   1. El panel de agenda mostraba los horarios corridos 3 horas (cena 21:30 → 00:30).
 *   2. Los movimientos del 12 a la noche figuraban como del 13.
 *   3. "¿Llego a fin de mes?" el día 31 a las 21:30 proyectaba 29 días de gasto
 *      inexistentes, porque el servidor ya estaba en el mes siguiente.
 *   4. `compromisos_futuros` devolvía TODOS los meses corridos uno para atrás: el
 *      1 de agosto a las 00:00 UTC se imprimía como 31 de julio.
 *   5. Los gastos del último día del mes a la noche se agrupaban en el mes siguiente
 *      ($67.250 de mayo contados en junio).
 *   6. El mes más viejo de un rango salía truncado según la hora en que preguntaras.
 *   7. El "Hoy / Ayer" que se le muestra al modelo salía del reloj del proceso.
 *
 * REGLA: ningún archivo debe volver a hacer `new Date().getMonth()`,
 * `iso.slice(0,7)` ni `toISOString()` para trabajar con fechas del usuario.
 * Todo pasa por acá.
 *
 * Argentina no tiene horario de verano desde 2009, así que el offset fijo -03:00
 * es correcto y estable. Si algún día vuelve, este es el único archivo a tocar.
 */

export const ZONA = "America/Argentina/Buenos_Aires";
export const OFFSET = "-03:00";

// ---------------------------------------------------------------------------
// Días
// ---------------------------------------------------------------------------

/** Hoy, YYYY-MM-DD. */
export const hoy = (): string =>
  new Date().toLocaleDateString("en-CA", { timeZone: ZONA });

/** El día calendario de un instante, YYYY-MM-DD. NUNCA usar `iso.slice(0,10)`. */
export const dia = (iso: string | Date): string =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: ZONA });

/** Ayer, YYYY-MM-DD. */
export const ayer = (): string =>
  new Date(Date.now() - 864e5).toLocaleDateString("en-CA", { timeZone: ZONA });

/** Suma (o resta) días a un YYYY-MM-DD. Sin corrimientos: aritmética sobre mediodía. */
export function sumarDias(fecha: string, k: number): string {
  const t = new Date(`${fecha}T12:00:00${OFFSET}`).getTime() + k * 864e5;
  return dia(new Date(t));
}

// ---------------------------------------------------------------------------
// Meses
// ---------------------------------------------------------------------------

/** El mes de un instante, YYYY-MM. NUNCA usar `iso.slice(0,7)`. */
export const mes = (iso: string | Date): string => dia(iso).slice(0, 7);

/** El mes en curso, YYYY-MM. */
export const mesActual = (): string => hoy().slice(0, 7);

/**
 * Suma meses a un YYYY-MM con aritmética pura, sin pasar por `Date`.
 * Construir un `Date` para esto es justo lo que corría los meses uno para atrás.
 */
export function sumarMeses(ym: string, k: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + k;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Cuántos días tiene un YYYY-MM. */
export function diasDelMes(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Instantes: para consultar la base
// ---------------------------------------------------------------------------

/** `2026-08-13` → `2026-08-13T00:00:00-03:00`. Para el `gte` de un rango. */
export const desdeElDia = (fecha: string): string => `${fecha}T00:00:00${OFFSET}`;

/** `2026-08-13` → `2026-08-13T23:59:59-03:00`. Para el `lte` de un rango. */
export const hastaElDia = (fecha: string): string => `${fecha}T23:59:59${OFFSET}`;

/** Mediodía del día, que es el instante seguro para representar "esa fecha". */
export const mediodia = (fecha: string): string => `${fecha}T12:00:00${OFFSET}`;

// ---------------------------------------------------------------------------
// Horas
// ---------------------------------------------------------------------------

/** `HH:MM` en hora argentina. */
export const hora = (iso: string | Date): string =>
  new Date(iso).toLocaleTimeString("es-AR", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ZONA,
  });

/** Minutos desde la medianoche argentina. Para comparar horarios entre sí. */
export function minutosDelDia(iso: string | Date): number {
  const [h, m] = hora(iso).split(":").map(Number);
  return h * 60 + m;
}

/** `930` → `"15:30"`. */
export const deMinutos = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Para mostrar y para decir en voz
// ---------------------------------------------------------------------------

/**
 * `"Hoy · 21:49"`, `"Ayer · 09:15"`, `"lun 10 ago · 18:41"`.
 *
 * El día de la semana va incluido a propósito. Sin él, el modelo lo deducía solo
 * a partir del `YYYY-MM-DD` y se equivocaba: al gasto del **lunes** 10 de agosto
 * lo llamó "el viernes pasado". Es la misma clase de error que todo lo demás en
 * este archivo — calcular fechas a mano — así que la respuesta es la misma:
 * que venga resuelto y no haya nada que deducir.
 */
export function cuando(iso: string | Date): string {
  const d = dia(iso);
  if (d === hoy()) return `Hoy · ${hora(iso)}`;
  if (d === ayer()) return `Ayer · ${hora(iso)}`;
  const fecha = new Date(iso)
    .toLocaleDateString("es-AR", {
      weekday: "short", day: "2-digit", month: "short", timeZone: ZONA,
    })
    .replace(/\./g, "")
    .replace(",", "");
  return `${fecha} · ${hora(iso)}`;
}

/** `"miércoles 13 de agosto"`. */
export const diaLargo = (fecha: string): string =>
  new Date(mediodia(fecha)).toLocaleDateString("es-AR", {
    weekday: "long", day: "numeric", month: "long", timeZone: ZONA,
  });

/** `"13 de agosto"`. */
export const diaCorto = (fecha: string): string =>
  new Date(mediodia(fecha)).toLocaleDateString("es-AR", {
    day: "numeric", month: "long", timeZone: ZONA,
  });

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

/** ¿Es un YYYY-MM-DD que existe de verdad? Rechaza el 30 de febrero. */
export function esFecha(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const p = new Date(Date.UTC(y, m - 1, d));
  return p.getUTCFullYear() === y && p.getUTCMonth() === m - 1 && p.getUTCDate() === d;
}

/**
 * Normaliza un rango. Devuelve el motivo (string) si no sirve.
 * Un rango invertido se da vuelta en vez de devolver cero en silencio.
 */
export function rango(desde: string, hasta: string): { desde: string; hasta: string } | string {
  if (!esFecha(desde) || !esFecha(hasta)) return "Las fechas tienen que ser YYYY-MM-DD.";
  return desde <= hasta ? { desde, hasta } : { desde: hasta, hasta: desde };
}

// ---------------------------------------------------------------------------
// Períodos con nombre
// ---------------------------------------------------------------------------

/**
 * Traduce "esta semana", "el mes pasado", "los últimos 7 días" a un rango de fechas.
 *
 * Existe porque el modelo hacía esta cuenta solo y la erraba de maneras que no se
 * ven en la respuesta —el número queda perfectamente coherente, solo que del
 * período equivocado—. Medido el 13/08/2026:
 *
 *   · "los últimos siete días" → pidió del 06 al 13, que son OCHO días. Contestó
 *     $394.504 cuando la respuesta era $327.119.
 *   · "esta semana" → pidió los últimos 7 días en vez de desde el lunes: $327.119
 *     donde iban $76.642. Un 4x de error, dicho con total naturalidad.
 *
 * Ninguno de los dos es un error de razonamiento del modelo: es que la aritmética
 * de calendario no es su trabajo. Acá está resuelta una sola vez, con el mismo
 * criterio que el resto del archivo (día argentino, no UTC), y el modelo elige
 * un nombre de una lista.
 *
 * Criterios, para que no haya dudas después:
 *   · La semana arranca el LUNES (es lo que quiere decir "esta semana" en Argentina).
 *   · "últimos N días" INCLUYE hoy: últimos 7 = hoy y los 6 anteriores.
 *   · "este mes" / "este año" van hasta HOY, no hasta fin de mes: es lo que ya pasó.
 *   · "mes pasado" es el mes calendario completo anterior.
 */
export type Periodo =
  | "hoy" | "ayer" | "anteayer"
  | "esta_semana" | "semana_pasada"
  | "ultimos_7_dias" | "ultimos_15_dias" | "ultimos_30_dias"
  | "este_mes" | "mes_pasado" | "ultimos_3_meses" | "ultimos_6_meses"
  | "este_anio";

export const PERIODOS: Periodo[] = [
  "hoy", "ayer", "anteayer", "esta_semana", "semana_pasada",
  "ultimos_7_dias", "ultimos_15_dias", "ultimos_30_dias",
  "este_mes", "mes_pasado", "ultimos_3_meses", "ultimos_6_meses", "este_anio",
];

/** Día de la semana, 0 = lunes. */
function diaSemana(fecha: string): number {
  const d = new Date(mediodia(fecha)).toLocaleDateString("en-US", {
    weekday: "short", timeZone: ZONA,
  });
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(d);
}

/** Último día de un YYYY-MM. */
export const finDeMes = (ym: string): string => `${ym}-${String(diasDelMes(ym)).padStart(2, "0")}`;

export function periodo(
  nombre: string,
): { desde: string; hasta: string; etiqueta: string } | null {
  const h = hoy();
  const lunes = sumarDias(h, -diaSemana(h));

  switch (nombre) {
    case "hoy": return { desde: h, hasta: h, etiqueta: "hoy" };
    case "ayer": {
      const a = sumarDias(h, -1);
      return { desde: a, hasta: a, etiqueta: "ayer" };
    }
    case "anteayer": {
      const a = sumarDias(h, -2);
      return { desde: a, hasta: a, etiqueta: "anteayer" };
    }
    case "esta_semana":
      return { desde: lunes, hasta: h, etiqueta: "esta semana (desde el lunes)" };
    case "semana_pasada":
      return {
        desde: sumarDias(lunes, -7), hasta: sumarDias(lunes, -1),
        etiqueta: "la semana pasada (lunes a domingo)",
      };
    case "ultimos_7_dias":
      return { desde: sumarDias(h, -6), hasta: h, etiqueta: "los últimos 7 días" };
    case "ultimos_15_dias":
      return { desde: sumarDias(h, -14), hasta: h, etiqueta: "los últimos 15 días" };
    case "ultimos_30_dias":
      return { desde: sumarDias(h, -29), hasta: h, etiqueta: "los últimos 30 días" };
    case "este_mes":
      return { desde: `${mesActual()}-01`, hasta: h, etiqueta: "lo que va del mes" };
    case "mes_pasado": {
      const m = sumarMeses(mesActual(), -1);
      return { desde: `${m}-01`, hasta: finDeMes(m), etiqueta: `${m} completo` };
    }
    case "ultimos_3_meses":
      return { desde: `${sumarMeses(mesActual(), -2)}-01`, hasta: h, etiqueta: "los últimos 3 meses" };
    case "ultimos_6_meses":
      return { desde: `${sumarMeses(mesActual(), -5)}-01`, hasta: h, etiqueta: "los últimos 6 meses" };
    case "este_anio":
      return { desde: `${h.slice(0, 4)}-01-01`, hasta: h, etiqueta: `lo que va de ${h.slice(0, 4)}` };
    default:
      return null;
  }
}
