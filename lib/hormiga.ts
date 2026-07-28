// Lógica pura de "Gastos hormiga". Sin JSX ni fetches: recibe los egresos ya
// traídos y devuelve todo lo que la pantalla necesita.
//
// Definición: el eje es lo EVITABLE, no lo chico. Entra todo el gasto
// prescindible (delivery, salidas, ocio) sin importar el ticket: una cena de
// $30.000 es MÁS recortable que un café de $4.000, no menos.
// El umbral no excluye nada — solo parte el total en dos para leerlo mejor:
//   · goteo   → tickets chicos y repetidos (el hormiga clásico)
//   · grandes → los pocos consumos gordos que mueven la aguja
// Sí quedan afuera las cuotas de tarjeta (no son decisión del mes) y las
// suscripciones (se analizan aparte, no son impulso).
import type { ExpenseRow } from "./db";
import type { FxRates } from "./db";
import { toArs, arsDe } from "./fx";

export const CATEGORIAS_HORMIGA = ["Delivery", "Comida", "Ocio", "Transporte", "Compras"];

// Prefijos de pasarelas de pago que ensucian el nombre del comercio.
const PREFIJOS = /^(MERPAGO\*|MERPAGO\s|MP\*|DLO\*|PEDIDOSYA\*|PVS\*|CP\*|HPS\*|EBANX\*|RAPIPAGO\s)/i;
// Palabras que delatan una suscripción aunque solo tengamos 2 meses de historia.
export const PISTA_SUSCRIPCION = /(spotify|netflix|hbo|max|disney|paramount|apple|claude|anthropic|openai|chatgpt|prime|youtube|plus\b|pro\b|suscrip|abono|membres)/i;

/** Normaliza el nombre del comercio para poder agrupar: saca pasarela, sucursal y ruido. */
export function normalizarComercio(desc: string): string {
  return (desc || "")
    .replace(PREFIJOS, "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s*\d{2,}\s*$/, "")   // número de sucursal al final
    .replace(/\s*X{3,}\s*$/i, "")   // enmascarados tipo "XXXX"
    .replace(/[^A-Z0-9\s.&*\/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "SIN NOMBRE";
}

export type Suscripcion = { comercio: string; monto: number; currency: string; meses: string[]; ids: number[]; yaFija: boolean; anual: number };
export type Comercio = { comercio: string; veces: number; totalArs: number; emoji: string; categoria: string };
export type HormigaResult = {
  umbral: number;
  hormiga: ExpenseRow[];        // TODO el gasto evitable del período
  goteo: ExpenseRow[];          // los de ticket chico (<= umbral)
  grandes: ExpenseRow[];        // los pocos gordos (> umbral)
  suscripciones: Suscripcion[];
  totalPorMes: Record<string, number>;
  porCategoriaMes: Record<string, Record<string, number>>;
  comercios: Comercio[];
};

/**
 * Umbral auto-calibrado (percentil 70 del ticket). NO excluye: solo separa el
 * "goteo" chico de los consumos gordos. Se recalcula solo con la inflación.
 */
export function calcularUmbral(rows: ExpenseRow[], fx: FxRates): number {
  const montos = rows
    .filter((r) => !r.esCuota && CATEGORIAS_HORMIGA.includes(r.category))
    .map((r) => arsDe(r.amount, r.currency, r.fxRate, fx))
    .sort((a, b) => a - b);
  if (montos.length < 10) return 15000; // muestra chica: valor razonable por defecto
  const p70 = montos[Math.floor(montos.length * 0.7)];
  return Math.max(2000, Math.round(p70 / 500) * 500); // redondeo a $500
}

export function analizarHormiga(rows: ExpenseRow[], fx: FxRates, umbralManual?: number): HormigaResult {
  const umbral = umbralManual ?? calcularUmbral(rows, fx);
  // Gasto ya ocurrido → cotización congelada de su día.
  const ars = (r: ExpenseRow) => arsDe(r.amount, r.currency, r.fxRate, fx);

  // --- Suscripciones: mismo comercio + mismo monto en varios meses ---
  // Se piden 3 meses distintos, salvo que el nombre delate una suscripción (ahí
  // alcanzan 2). Sin esto, dos almuerzos de $9.000 en meses seguidos darían falso positivo.
  const clave = new Map<string, { comercio: string; monto: number; currency: string; meses: Set<string>; ids: number[] }>();
  for (const r of rows) {
    if (r.esCuota) continue;
    const c = normalizarComercio(r.desc);
    const k = `${c}|${r.amount}|${r.currency}`;
    const e = clave.get(k) ?? { comercio: c, monto: r.amount, currency: r.currency, meses: new Set<string>(), ids: [] };
    e.meses.add(r.month); e.ids.push(r.id);
    clave.set(k, e);
  }
  const suscripciones: Suscripcion[] = [...clave.values()]
    .filter((e) => e.meses.size >= (PISTA_SUSCRIPCION.test(e.comercio) ? 2 : 3))
    .map((e) => ({
      comercio: e.comercio, monto: e.monto, currency: e.currency,
      meses: [...e.meses].sort(), ids: e.ids,
      yaFija: rows.filter((r) => e.ids.includes(r.id)).every((r) => r.nature === "fijo"),
      // Costo anual = lo que va a salir de acá en adelante → cotización de HOY, no la congelada.
      anual: toArs(e.monto, e.currency, fx) * 12,
    }))
    .sort((a, b) => b.anual - a.anual);

  const idsSuscripcion = new Set(suscripciones.flatMap((s) => s.ids));

  // --- Gasto evitable: categoría prescindible, sin cuotas ni suscripciones ---
  // El monto NO filtra: un delivery de $18.000 es tan evitable como uno de $8.000.
  const hormiga = rows.filter((r) => !r.esCuota && CATEGORIAS_HORMIGA.includes(r.category) && !idsSuscripcion.has(r.id));
  const goteo = hormiga.filter((r) => ars(r) <= umbral);
  const grandes = hormiga.filter((r) => ars(r) > umbral).sort((a, b) => ars(b) - ars(a));

  const totalPorMes: Record<string, number> = {};
  const porCategoriaMes: Record<string, Record<string, number>> = {};
  for (const r of hormiga) {
    totalPorMes[r.month] = (totalPorMes[r.month] ?? 0) + ars(r);
    (porCategoriaMes[r.category] ??= {});
    porCategoriaMes[r.category][r.month] = (porCategoriaMes[r.category][r.month] ?? 0) + ars(r);
  }

  const cm = new Map<string, Comercio>();
  for (const r of hormiga) {
    const c = normalizarComercio(r.desc);
    const e = cm.get(c) ?? { comercio: c, veces: 0, totalArs: 0, emoji: r.emoji, categoria: r.category };
    e.veces += 1; e.totalArs += ars(r);
    cm.set(c, e);
  }
  const comercios = [...cm.values()].sort((a, b) => b.totalArs - a.totalArs);

  return { umbral, hormiga, goteo, grandes, suscripciones, totalPorMes, porCategoriaMes, comercios };
}
