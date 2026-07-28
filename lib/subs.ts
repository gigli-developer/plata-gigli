// Suscripciones y abonos que se cobran con tarjeta de crédito.
//
// Para qué: los resúmenes FUTUROS solo sabían de cuotas, así que un mes que viene
// mostraba $0 aunque todos los meses te caen Spotify, Apple, Google One y compañía.
// Acá se detectan esos cargos recurrentes para poder proyectarlos.
//
// Regla de oro: esto SOLO alimenta períodos que todavía no existen como resumen.
// En un resumen real (en curso o cerrado) los consumos entran por el importador de
// mails; sumarle una proyección encima contaría dos veces la misma suscripción.
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizarComercio, PISTA_SUSCRIPCION } from "./hormiga";

export type CardCharge = {
  id: number; cardId: number; amount: number; currency: "ARS" | "USD" | "USDT";
  desc: string; month: string; esCuota: boolean; fija: boolean;
  category: string; emoji: string;
};

export type CardSub = {
  cardId: number; comercio: string; amount: number; currency: "ARS" | "USD" | "USDT";
  meses: string[]; lastMonth: string; emoji: string; category: string;
  /** Por qué se la considera recurrente: la marcaste fija o se repite sola. */
  motivo: "marcada" | "repetida";
};

const addYM = (ym: string, k: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Consumos con tarjeta (sin cuotas) de los últimos meses, para detectar lo recurrente. */
export async function fetchCardCharges(sb: SupabaseClient, monthsBack = 8): Promise<CardCharge[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);
  since.setDate(1);
  const { data, error } = await sb.from("transactions")
    .select("id,card_id,amount,currency,description,occurred_at,installment_total,nature,categories(name,emoji)")
    .eq("type", "egreso")
    .not("card_id", "is", null)
    .gte("occurred_at", since.toISOString());
  if (error) throw error;
  return (data ?? []).map((r: any): CardCharge => ({
    id: r.id,
    cardId: r.card_id,
    amount: Number(r.amount),
    currency: r.currency,
    desc: r.description || r.categories?.name || "Movimiento",
    month: String(r.occurred_at).slice(0, 7),
    esCuota: !!r.installment_total && r.installment_total > 1,
    fija: r.nature === "fijo",
    category: r.categories?.name ?? "Otros",
    emoji: r.categories?.emoji ?? "🔁",
  }));
}

const mediana = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Tolerancia del monto: una suscripción en USD varía un poco mes a mes (Spotify 2,27 → 2,42). */
const TOLERANCIA = 0.25;
/** Una suscripción se cobra UNA vez por mes. AUSA (peajes) aparece 11 veces; Rappi, 9. */
const MAX_COBROS_MES = 1.5;

/**
 * Detecta los cargos que se van a repetir el mes que viene.
 *
 * Un comercio entra si lo marcaste `fijo` en Gastos hormiga, o si cumple las tres
 * condiciones juntas:
 *   1. aparece en 3 meses distintos con un monto parecido (±25% de la mediana) — 2
 *      meses alcanzan si el nombre delata suscripción (Spotify, Apple, Claude…);
 *   2. se cobra a lo sumo ~1 vez por mes;
 *   3. el último cobro es de los últimos 2 meses (si no, se asume dada de baja).
 *
 * Sin (1) dos almuerzos en el mismo lugar pasarían por abono; sin (2) entrarían los
 * peajes y el delivery, que son los comercios más repetidos de todos.
 *
 * El monto proyectado es la MEDIANA de los meses que caen dentro de la tolerancia:
 * así una compra suelta en Apple (US$ 0,39) no arrastra la proyección de su abono.
 */
export function detectarSubs(charges: CardCharge[], hoyYM: string): CardSub[] {
  type G = {
    cardId: number; comercio: string; currency: CardCharge["currency"];
    porMes: Map<string, { monto: number; cobros: number }>;
    fija: boolean; emoji: string; category: string;
  };
  const grupos = new Map<string, G>();

  for (const c of charges) {
    if (c.esCuota) continue; // las cuotas ya las proyecta el plan de cuotas
    const comercio = normalizarComercio(c.desc);
    const k = `${c.cardId}|${comercio}|${c.currency}`;
    const g = grupos.get(k) ?? { cardId: c.cardId, comercio, currency: c.currency, porMes: new Map(), fija: false, emoji: c.emoji, category: c.category };
    const m = g.porMes.get(c.month) ?? { monto: 0, cobros: 0 };
    m.monto += c.amount; m.cobros += 1;
    g.porMes.set(c.month, m);
    g.fija = g.fija || c.fija;
    grupos.set(k, g);
  }

  const minMes = addYM(hoyYM, -2); // último cobro más viejo que esto = dada de baja
  const subs: CardSub[] = [];

  for (const g of grupos.values()) {
    const meses = [...g.porMes.keys()].sort();
    const lastMonth = meses[meses.length - 1];
    if (lastMonth < minMes) continue;

    const montos = meses.map((m) => g.porMes.get(m)!.monto);
    const med = mediana(montos);
    if (med <= 0) continue;
    // Meses cuyo monto se parece a la mediana: son los que sostienen la suscripción.
    const cerca = meses.filter((m) => Math.abs(g.porMes.get(m)!.monto - med) <= med * TOLERANCIA);
    const cobrosPorMes = meses.reduce((s, m) => s + g.porMes.get(m)!.cobros, 0) / meses.length;
    const minMeses = PISTA_SUSCRIPCION.test(g.comercio) ? 2 : 3;
    const repetida = cerca.length >= minMeses && cobrosPorMes <= MAX_COBROS_MES;
    if (!g.fija && !repetida) continue;

    const montosCerca = cerca.map((m) => g.porMes.get(m)!.monto);
    subs.push({
      cardId: g.cardId, comercio: g.comercio,
      amount: montosCerca.length ? mediana(montosCerca) : med,
      currency: g.currency,
      meses: cerca.length ? cerca : meses,
      lastMonth, emoji: g.emoji, category: g.category,
      motivo: g.fija && !repetida ? "marcada" : "repetida",
    });
  }

  return subs.sort((a, b) => b.amount - a.amount);
}

/** Total mensual proyectado de suscripciones de una tarjeta, separado por moneda. */
export function subsTotals(subs: CardSub[], cardId: number, usdRate: number) {
  let ars = 0, usd = 0;
  for (const s of subs) {
    if (s.cardId !== cardId) continue;
    if (s.currency === "ARS") ars += s.amount;
    else if (s.currency === "USD") usd += s.amount;
    else ars += s.amount * usdRate; // USDT con tarjeta es raro; se valúa y va a pesos
  }
  return { ars, usd };
}
