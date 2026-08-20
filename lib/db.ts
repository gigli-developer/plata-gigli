import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "./supabase/client";
// Fechas: siempre desde acá. Ver el encabezado de `lib/fechas.ts` — la lógica de
// fechas desperdigada por archivo produjo siete bugs del mismo tipo.
import { mes as mesDe, mesActual, sumarMeses, desdeElDia, hastaElDia } from "./fechas";

export type Category = { id: number; name: string; emoji: string | null; kind: string };
export type PaymentMethod = { id: number; name: string };
export type CardRow = { id: number; name: string; last4: string | null };

// Vista de transacción para la UI (misma forma que el mock).
export type TxView = {
  id: number;
  desc: string;
  category: string;
  categoryId: number | null;
  emoji: string;
  method: string;
  paymentMethodId: number | null;
  amount: number;
  currency: "ARS" | "USD" | "USDT";
  /** Cotización congelada del día del movimiento (null en ARS). Valuar con `arsDe()`, no con la de hoy. */
  fxRate: number | null;
  type: "ingreso" | "egreso";
  date: string; // "día · hora"
  occurredAt: string;
  card?: string;
  source: "manual" | "ocr" | "email" | "chat";
};

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  let day: string;
  if (sameDay(d, now)) day = "Hoy";
  else if (sameDay(d, yest)) day = "Ayer";
  else day = `${String(d.getDate()).padStart(2, "0")} ${MESES[d.getMonth()]}`;
  return `${day} · ${hh}:${mm}`;
}

export const db = () => createClient();

export async function fetchCategories(sb: SupabaseClient): Promise<Category[]> {
  const { data, error } = await sb.from("categories").select("id,name,emoji,kind").eq("is_archived", false).order("name");
  if (error) throw error;
  return data ?? [];
}

export async function fetchPaymentMethods(sb: SupabaseClient): Promise<PaymentMethod[]> {
  const { data, error } = await sb.from("payment_methods").select("id,name").order("id");
  if (error) throw error;
  return data ?? [];
}

// ---- Reglas de consumos (condiciones → acciones) ----
// Condiciones: texto (contiene/empieza/igual), horario, días, rango de monto.
// Acciones: recategorizar, renombrar la descripción y/o forzar la moneda (p.ej. Spotify llega como ARS pero es USD).
export type Rule = { id: number; textOp: string | null; textValue: string | null; hourFrom: number | null; hourTo: number | null; days: number[] | null; amountMin: number | null; amountMax: number | null; categoryId: number | null; category: string | null; emoji: string | null; renameTo: string | null; setCurrency: string | null; priority: number; isActive: boolean };
export type NewRule = { textOp: string | null; textValue: string | null; hourFrom: number | null; hourTo: number | null; days: number[] | null; amountMin: number | null; amountMax: number | null; categoryId: number | null; renameTo: string | null; setCurrency: string | null };
export async function fetchRules(sb: SupabaseClient): Promise<Rule[]> {
  const { data, error } = await sb.from("rules").select("id,text_op,text_value,hour_from,hour_to,days,amount_min,amount_max,category_id,rename_to,set_currency,priority,is_active,categories(name,emoji)").order("priority", { ascending: false }).order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.id, textOp: r.text_op, textValue: r.text_value, hourFrom: r.hour_from, hourTo: r.hour_to, days: r.days, amountMin: r.amount_min != null ? Number(r.amount_min) : null, amountMax: r.amount_max != null ? Number(r.amount_max) : null, categoryId: r.category_id, category: r.categories?.name ?? null, emoji: r.categories?.emoji ?? null, renameTo: r.rename_to, setCurrency: r.set_currency, priority: r.priority, isActive: r.is_active }));
}
export async function insertRule(sb: SupabaseClient, r: NewRule) {
  const { error } = await sb.from("rules").insert({ text_op: r.textOp, text_value: r.textValue, hour_from: r.hourFrom, hour_to: r.hourTo, days: r.days, amount_min: r.amountMin, amount_max: r.amountMax, category_id: r.categoryId, rename_to: r.renameTo, set_currency: r.setCurrency });
  if (error) throw error;
}
export async function deleteRule(sb: SupabaseClient, id: number) {
  const { error } = await sb.from("rules").delete().eq("id", id);
  if (error) throw error;
}
export async function toggleRule(sb: SupabaseClient, id: number, active: boolean) {
  const { error } = await sb.from("rules").update({ is_active: active }).eq("id", id);
  if (error) throw error;
}

export async function fetchCards(sb: SupabaseClient): Promise<CardRow[]> {
  const { data, error } = await sb.from("cards").select("id,name,last4").eq("is_archived", false).order("id");
  if (error) throw error;
  return data ?? [];
}

export async function fetchTransactions(sb: SupabaseClient, limit = 500): Promise<TxView[]> {
  const { data, error } = await sb
    .from("transactions")
    .select("id,type,amount,currency,fx_rate_ars,description,occurred_at,source,category_id,payment_method_id,categories(name,emoji),payment_methods(name),cards(name)")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r: any): TxView => ({
    id: r.id,
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
    fxRate: r.fx_rate_ars != null ? Number(r.fx_rate_ars) : null,
    desc: r.description || r.categories?.name || "Movimiento",
    category: r.categories?.name ?? "Otros",
    categoryId: r.category_id,
    emoji: r.categories?.emoji ?? "✨",
    method: r.payment_methods?.name ?? "—",
    paymentMethodId: r.payment_method_id,
    card: r.cards?.name ?? undefined,
    source: r.source,
    occurredAt: r.occurred_at,
    date: formatDate(r.occurred_at),
  }));
}

/**
 * Transacciones de un rango de fechas, con filtro opcional por texto.
 *
 * `fetchTransactions` trae las últimas 500 sin filtrar, que sirve para la pantalla
 * pero no para "qué gasté el martes": traer 500 filas para descartar 490 es caro
 * y, si el rango es viejo, ni siquiera están. Acá el filtro va en la consulta.
 *
 * `desde`/`hasta` son YYYY-MM-DD **en hora de Argentina**, ambos inclusive.
 */
export async function fetchTransactionsRange(
  sb: SupabaseClient,
  desde: string,
  hasta: string,
  busqueda?: string,
  limit = 300,
): Promise<TxView[]> {
  let q = sb
    .from("transactions")
    .select("id,type,amount,currency,fx_rate_ars,description,occurred_at,source,category_id,payment_method_id,categories(name,emoji),payment_methods(name),cards(name)")
    .gte("occurred_at", desdeElDia(desde))
    .lte("occurred_at", hastaElDia(hasta))
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (busqueda) {
    // Escapar los comodines. `*` va incluido: PostgREST lo traduce a `%`, así que
    // una búsqueda de "*" devolvía TODA la base — el peor caso de tokens con un
    // solo carácter — y "MERP*AUSA" matcheaba como comodín sin que nadie lo pidiera.
    const t = busqueda.replace(/[\\%_*]/g, (c) => `\\${c}`);
    q = q.ilike("description", `%${t}%`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r: any): TxView => ({
    id: r.id,
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
    fxRate: r.fx_rate_ars != null ? Number(r.fx_rate_ars) : null,
    desc: r.description || r.categories?.name || "Movimiento",
    category: r.categories?.name ?? "Otros",
    categoryId: r.category_id,
    emoji: r.categories?.emoji ?? "✨",
    method: r.payment_methods?.name ?? "—",
    paymentMethodId: r.payment_method_id,
    card: r.cards?.name ?? undefined,
    source: r.source,
    occurredAt: r.occurred_at,
    date: formatDate(r.occurred_at),
  }));
}

/**
 * Movimientos dados de ALTA después de un instante (`created_at`, no `occurred_at`).
 *
 * Los dos campos se separan justo en el caso que importa: el importador de mails
 * corre cada 15 minutos, así que un consumo del viernes a la noche puede aparecer
 * en la base recién el sábado. Para "¿hay algo nuevo?" lo que vale es cuándo lo
 * VISTE, no cuándo pasó — si no, un consumo viejo recién importado no figuraría
 * nunca como novedad.
 */
export async function fetchTransactionsNuevas(
  sb: SupabaseClient,
  desdeIso: string,
  limit = 60,
): Promise<(TxView & { createdAt: string })[]> {
  const { data, error } = await sb
    .from("transactions")
    .select("id,type,amount,currency,fx_rate_ars,description,occurred_at,created_at,source,category_id,payment_method_id,categories(name,emoji),payment_methods(name),cards(name)")
    .gte("created_at", desdeIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    id: r.id,
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
    fxRate: r.fx_rate_ars != null ? Number(r.fx_rate_ars) : null,
    desc: r.description || r.categories?.name || "Movimiento",
    category: r.categories?.name ?? "Otros",
    categoryId: r.category_id,
    emoji: r.categories?.emoji ?? "✨",
    method: r.payment_methods?.name ?? "—",
    paymentMethodId: r.payment_method_id,
    card: r.cards?.name ?? undefined,
    source: r.source,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
    date: formatDate(r.occurred_at),
  }));
}

export type NewTx = {
  type: "ingreso" | "egreso";
  amount: number;
  currency: string;
  categoryId: number | null;
  paymentMethodId: number | null;
  description: string | null;
  /** ISO. Si no viene, la base pone now(). Sirve para cargar un gasto de ayer. */
  occurredAt?: string;
};

export function formatShort(iso: string | null): string {
  if (!iso) return "—";
  // Parsear 'YYYY-MM-DD' en local para evitar el corrimiento por UTC.
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return `${String(dt.getDate()).padStart(2, "0")} ${MESES[dt.getMonth()]}`;
}

// ---- Tarjetas ----
export type CardFull = { id: number; name: string; bank: string | null; network: string | null; last4: string | null; limitArs: number | null; closeDay: number | null; dueDay: number | null };
export async function fetchCardsFull(sb: SupabaseClient): Promise<CardFull[]> {
  const { data, error } = await sb.from("cards").select("id,name,bank,network,last4,limit_ars,closing_day,due_day").eq("is_archived", false).order("id");
  if (error) throw error;
  return (data ?? []).map((c: any) => ({ id: c.id, name: c.name, bank: c.bank, network: c.network, last4: c.last4, limitArs: c.limit_ars != null ? Number(c.limit_ars) : null, closeDay: c.closing_day, dueDay: c.due_day }));
}

// ---- Detalle de egresos (para Gastos hormiga) ----
// A diferencia de fetchMonthlyBreakdown (que agrega y pierde la descripción), acá
// hace falta el movimiento individual: sin descripción no se puede detectar ni el
// comercio repetido ni la suscripción, que son el corazón de esa pantalla.
export type ExpenseRow = {
  id: number; amount: number; currency: "ARS" | "USD" | "USDT"; desc: string;
  /** Cotización congelada del día del gasto (null en ARS). Valuar con `arsDe()`. */
  fxRate: number | null;
  occurredAt: string; month: string; category: string; emoji: string;
  method: string; nature: "fijo" | "variable"; esCuota: boolean;
};
export async function fetchExpenseDetail(sb: SupabaseClient, monthsBack = 12): Promise<ExpenseRow[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);
  since.setDate(1);
  const { data, error } = await sb.from("transactions")
    .select("id,amount,currency,fx_rate_ars,description,occurred_at,installment_total,nature,categories(name,emoji),payment_methods(name)")
    .eq("type", "egreso")
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r: any): ExpenseRow => ({
    id: r.id,
    amount: Number(r.amount),
    currency: r.currency,
    fxRate: r.fx_rate_ars != null ? Number(r.fx_rate_ars) : null,
    desc: r.description || r.categories?.name || "Movimiento",
    occurredAt: r.occurred_at,
    month: String(r.occurred_at).slice(0, 7),
    category: r.categories?.name ?? "Otros",
    emoji: r.categories?.emoji ?? "✨",
    method: r.payment_methods?.name ?? "—",
    nature: r.nature === "fijo" ? "fijo" : "variable",
    esCuota: !!r.installment_total && r.installment_total > 1,
  }));
}

// Marcar un gasto como fijo (suscripción, abono) o variable. El enum tx_nature ya
// existe en la base con esos dos valores; el Cash Flow lo usa para NO promediar
// ni inflar los gastos fijos en la proyección.
export async function setTxNature(sb: SupabaseClient, ids: number[], nature: "fijo" | "variable") {
  if (!ids.length) return;
  const { error } = await sb.from("transactions").update({ nature }).in("id", ids);
  if (error) throw error;
}

// ---- Cotizaciones (tabla fx_rates, sincronizada por la Edge Function fx-sync) ----
// USD se valúa a blue COMPRA (el precio al que realmente convertís billetes a pesos)
// y USDT a cripto COMPRA, que tiene su propio spread (~4% sobre el blue).
export type FxRates = { usd: number; usdt: number; day: string | null };
export const FX_FALLBACK: FxRates = { usd: 1525, usdt: 1593, day: null };

export async function fetchFxRates(sb: SupabaseClient): Promise<FxRates> {
  const { data, error } = await sb.from("fx_rates").select("casa,compra,day")
    .in("casa", ["blue", "cripto"]).order("day", { ascending: false }).limit(20);
  if (error) throw error;
  const ultima = (casa: string) => (data ?? []).find((r: any) => r.casa === casa);
  const b = ultima("blue"), c = ultima("cripto");
  return {
    usd: Number(b?.compra) || FX_FALLBACK.usd,
    usdt: Number(c?.compra) || FX_FALLBACK.usdt,
    day: (b?.day as string) ?? null,
  };
}

// ---- Alta / edición de tarjetas ----
// No se expone borrar: card_statements.card_id es ON DELETE CASCADE, así que un
// delete se llevaría puesto todo el historial de resúmenes. Se archiva (is_archived).
export type NewCard = { name: string; bank: string | null; network: string | null; last4: string | null; limitArs: number | null; closeDay: number | null; dueDay: number | null };

const cardPayload = (c: NewCard) => ({
  name: c.name, bank: c.bank, network: c.network, last4: c.last4,
  limit_ars: c.limitArs, closing_day: c.closeDay, due_day: c.dueDay,
});

export async function insertCard(sb: SupabaseClient, c: NewCard): Promise<number> {
  // id es GENERATED ALWAYS y user_id tiene default auth.uid(): no se mandan.
  const { data, error } = await sb.from("cards").insert(cardPayload(c)).select("id").single();
  if (error) throw error;
  return data.id as number;
}
export async function updateCard(sb: SupabaseClient, id: number, c: NewCard) {
  const { error } = await sb.from("cards").update(cardPayload(c)).eq("id", id);
  if (error) throw error;
}
export async function archiveCard(sb: SupabaseClient, id: number) {
  const { error } = await sb.from("cards").update({ is_archived: true }).eq("id", id);
  if (error) throw error;
}
// Los últimos 4 dígitos identifican la tarjeta en el importador de mails
// (cardByLast4): si se repiten, los consumos se imputan a la tarjeta equivocada.
export async function last4EnUso(sb: SupabaseClient, last4: string, exceptId?: number): Promise<string | null> {
  let q = sb.from("cards").select("id,name").eq("last4", last4).eq("is_archived", false);
  if (exceptId) q = q.neq("id", exceptId);
  const { data } = await q.limit(1);
  return data?.[0]?.name ?? null;
}

// `fxRate`: cotización congelada del día en que se pagó el resumen (null si no está
// pagado). El total en USD de un resumen pagado se saldó a ESE dólar, no al de hoy.
export type StatementRow = { id: number; cardId: number; period: string; closing: string; due: string; closingRaw: string | null; dueRaw: string | null; paid: boolean; totalArs: number; totalUsd: number; fxRate: number | null };
export async function fetchStatements(sb: SupabaseClient): Promise<StatementRow[]> {
  const { data, error } = await sb.from("card_statements").select("id,card_id,period_label,closing_date,due_date,is_paid,total_ars,total_usd,fx_rate_ars").order("closing_date", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((s: any) => ({ id: s.id, cardId: s.card_id, period: s.period_label ?? "—", closing: formatShort(s.closing_date), due: formatShort(s.due_date), closingRaw: s.closing_date, dueRaw: s.due_date, paid: !!s.is_paid, totalArs: Number(s.total_ars), totalUsd: Number(s.total_usd), fxRate: s.fx_rate_ars != null ? Number(s.fx_rate_ars) : null }));
}
// Editar fechas de un resumen. Solo afecta ese resumen; opcionalmente actualiza el día
// por defecto de la tarjeta (para que los resúmenes futuros hereden esa fecha).
export async function updateStatementDates(sb: SupabaseClient, id: number, closingDate: string, dueDate: string, cardId?: number, updateCardDefault?: boolean) {
  const { error } = await sb.from("card_statements").update({ closing_date: closingDate, due_date: dueDate }).eq("id", id);
  if (error) throw error;
  if (updateCardDefault && cardId) {
    await sb.from("cards").update({ closing_day: Number(closingDate.slice(8, 10)), due_day: Number(dueDate.slice(8, 10)) }).eq("id", cardId);
  }
}

// Auto-generación del próximo resumen: si una tarjeta de crédito no tiene ningún resumen con
// cierre >= hoy, crea el del próximo período (cierre = closing_day de este mes o del siguiente;
// vence al mes siguiente si due_day < closing_day). El poller de Gmail hace lo mismo del lado
// del servidor; el índice único (card_id, period_label) evita duplicados. Devuelve true si creó.
export async function ensureNextStatements(sb: SupabaseClient): Promise<boolean> {
  const [{ data: cards }, { data: sts }] = await Promise.all([
    sb.from("cards").select("id,name,network,closing_day,due_day").eq("is_archived", false).not("closing_day", "is", null),
    sb.from("card_statements").select("card_id,closing_date,period_label"),
  ]);
  // Formatear en LOCAL (nunca toISOString: corre el día en ART).
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Día clampeado al largo del mes (cierre 31 en abril → 30, sin desbordar al mes siguiente).
  const mkDate = (y: number, m: number, day: number) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
  const esDebito = (c: any) => /d[eé]b/i.test(`${c.network ?? ""} ${c.name ?? ""}`);
  const now = new Date();
  const todayIso = fmt(now);
  let created = false;
  for (const c of (cards ?? []) as any[]) {
    if (esDebito(c)) continue; // débito no lleva resúmenes
    if ((sts ?? []).some((s: any) => s.card_id === c.id && s.closing_date && s.closing_date >= todayIso)) continue;
    const periods = new Set((sts ?? []).filter((s: any) => s.card_id === c.id).map((s: any) => s.period_label));
    const mOff = now.getDate() <= c.closing_day ? 0 : 1;
    // Primer período LIBRE: si el de este mes ya existe (cerrado antes de tiempo), pasar al siguiente.
    for (let k = 0; k < 3; k++) {
      const closing = mkDate(now.getFullYear(), now.getMonth() + mOff + k, c.closing_day);
      const period = fmt(closing).slice(0, 7);
      if (periods.has(period)) continue;
      const dueDay = c.due_day ?? c.closing_day;
      const due = mkDate(closing.getFullYear(), closing.getMonth() + (dueDay < c.closing_day ? 1 : 0), dueDay);
      const { data, error } = await sb.from("card_statements").upsert(
        { card_id: c.id, period_label: period, closing_date: fmt(closing), due_date: fmt(due) },
        { onConflict: "card_id,period_label", ignoreDuplicates: true },
      ).select("id");
      if (!error && (data?.length ?? 0) > 0) created = true;
      break;
    }
  }
  return created;
}

// Pagar un resumen: guarda el total reconciliado (lo que se ve en pantalla al momento de pagar)
// y lo marca pagado en ambas monedas. A partir de acá el total queda FIJO (no se recalcula).
export async function payStatement(sb: SupabaseClient, id: number, totalArs: number, totalUsd: number) {
  // .eq(is_paid,false): si otra pestaña/dispositivo ya lo pagó, no pisar el total congelado.
  const { error } = await sb.from("card_statements").update({ is_paid: true, paid_usd: true, total_ars: totalArs, total_usd: totalUsd }).eq("id", id).eq("is_paid", false);
  if (error) throw error;
}

// Cuotas activas: se leen de la tabla installment_plans (fuente limpia).
// La cuota actual se calcula según cuántos meses pasaron desde first_charge_date.
/**
 * ⚠️ `monthly` viene EN LA MONEDA DEL PLAN, no en pesos. Todo lo que lo sume o
 * lo muestre como ARS tiene que valuarlo antes con `currency`.
 *
 * No traer la moneda fue un agujero real: hasta el 19/08/2026 no había forma de
 * crear un plan que no fuera en pesos, así que nadie lo notó — y el día que la
 * herramienta de voz permitió convertir un consumo en dólares, una cuota de
 * US$ 100 empezó a mostrarse como $100 (son ~$154.000).
 */
export type InstallmentRow = { id: number; cardId: number | null; desc: string; emoji: string; monthly: number; currency: string; current: number; total: number; firstChargeDate: string; category: string; catEmoji: string };
export async function fetchInstallments(sb: SupabaseClient): Promise<InstallmentRow[]> {
  const { data, error } = await sb
    .from("installment_plans")
    .select("id,card_id,description,emoji,monthly_amount,currency,total_installments,first_charge_date,categories(name,emoji)");
  if (error) throw error;
  const now = new Date();
  const out: InstallmentRow[] = [];
  for (const p of data ?? []) {
    // Parsear first_charge_date en local (evita el corrimiento por UTC que daba cuotas de más).
    const [fy, fm] = String(p.first_charge_date).slice(0, 10).split("-").map(Number);
    const elapsed = (now.getFullYear() - fy) * 12 + (now.getMonth() - (fm - 1));
    const current = elapsed + 1;
    if (current > p.total_installments) continue; // plan terminado
    out.push({
      id: p.id,
      cardId: p.card_id,
      desc: p.description,
      emoji: p.emoji ?? "💳",
      monthly: Number(p.monthly_amount),
      currency: String((p as any).currency ?? "ARS"),
      current: Math.min(Math.max(current, 1), p.total_installments),
      total: p.total_installments,
      firstChargeDate: p.first_charge_date,
      category: (p as any).categories?.name ?? "Cuotas",
      catEmoji: (p as any).categories?.emoji ?? "💳",
    });
  }
  return out.sort((a, b) => (b.total - b.current) - (a.total - a.current));
}

// Consumos (no-cuota) por resumen. Para el total de resúmenes ABIERTOS:
// total = cuotas (de installment_plans) + estos consumos linkeados.
export async function fetchStatementConsumos(sb: SupabaseClient): Promise<Record<number, { ars: number; usd: number }>> {
  const { data, error } = await sb.from("transactions").select("statement_id,amount,currency,installment_total").not("statement_id", "is", null);
  if (error) throw error;
  const m: Record<number, { ars: number; usd: number }> = {};
  for (const t of (data ?? []) as any[]) {
    if (t.installment_total && t.installment_total > 1) continue; // las cuotas se cuentan aparte
    const id = t.statement_id as number;
    (m[id] ??= { ars: 0, usd: 0 });
    if (t.currency === "ARS") m[id].ars += Number(t.amount);
    else m[id].usd += Number(t.amount);
  }
  return m;
}

// Movimientos (consumos vinculados) de un resumen puntual, para el desplegable.
export type StatementMovement = { id: number; desc: string; category: string; emoji: string; amount: number; currency: "ARS" | "USD" | "USDT"; date: string };
export async function fetchStatementMovements(sb: SupabaseClient, statementId: number): Promise<StatementMovement[]> {
  const { data, error } = await sb
    .from("transactions")
    .select("id,description,amount,currency,occurred_at,installment_total,categories(name,emoji)")
    .eq("statement_id", statementId)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  return (data ?? [])
    .filter((t: any) => !(t.installment_total && t.installment_total > 1))
    .map((t: any) => ({
      id: t.id,
      desc: t.description || t.categories?.name || "Consumo",
      category: t.categories?.name ?? "Otros",
      emoji: t.categories?.emoji ?? "✨",
      amount: Number(t.amount),
      currency: t.currency,
      date: formatShort(t.occurred_at),
    }));
}

// ---- Deudas ----
export type DebtPayment = { id: number; amount: number; date: string; at: string; transactionId: number | null };
export type DebtView = { id: number; person: string; emoji: string; kind: "cash" | "in_kind" | "split"; direction: "to_collect" | "to_pay"; status: "pending" | "settled"; amount: number; paid: number; outstanding: number; payments: DebtPayment[]; currency: string; description: string; date: string; occurredAt: string; settledAt: string | null; splitTotal?: number; yourShare?: number; participants?: number };
export async function fetchDebts(sb: SupabaseClient): Promise<DebtView[]> {
  const [{ data, error }, { data: pays }] = await Promise.all([
    sb.from("debts").select("id,kind,direction,status,amount,currency,description,occurred_at,settled_at,split_total,your_share,participants,persons(name)").order("occurred_at", { ascending: false }),
    sb.from("debt_payments").select("id,debt_id,amount,occurred_at,transaction_id").order("occurred_at", { ascending: true }),
  ]);
  if (error) throw error;
  const payMap = new Map<number, DebtPayment[]>();
  for (const p of (pays ?? []) as any[]) { const arr = payMap.get(p.debt_id) ?? []; arr.push({ id: p.id, amount: Number(p.amount), date: formatShort(p.occurred_at), at: p.occurred_at, transactionId: p.transaction_id ?? null }); payMap.set(p.debt_id, arr); }
  return (data ?? []).map((d: any) => {
    const payments = payMap.get(d.id) ?? [];
    const paid = payments.reduce((a, p) => a + p.amount, 0);
    const amount = Number(d.amount);
    return {
      id: d.id, person: d.persons?.name ?? "—", emoji: "🧑", kind: d.kind, direction: d.direction, status: d.status,
      amount, paid, outstanding: Math.max(amount - paid, 0), payments,
      currency: d.currency, description: d.description ?? "", date: formatShort(d.occurred_at), occurredAt: d.occurred_at, settledAt: d.settled_at ? formatShort(d.settled_at) : null,
      splitTotal: d.split_total != null ? Number(d.split_total) : undefined, yourShare: d.your_share != null ? Number(d.your_share) : undefined, participants: d.participants ?? undefined,
    };
  });
}
export async function fetchPersons(sb: SupabaseClient): Promise<{ id: number; name: string }[]> {
  const { data, error } = await sb.from("persons").select("id,name").order("name");
  if (error) throw error;
  return data ?? [];
}

// ---- Divisas ----
export type ExchangeView = { id: number; from: string; to: string; fromAmount: number; toAmount: number; rate: number; rateSource: string; date: string };
export async function fetchExchanges(sb: SupabaseClient): Promise<ExchangeView[]> {
  const { data, error } = await sb.from("currency_exchanges").select("id,from_currency,to_currency,from_amount,to_amount,rate,rate_source,occurred_at").order("occurred_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((e: any) => ({ id: e.id, from: e.from_currency, to: e.to_currency, fromAmount: Number(e.from_amount), toAmount: Number(e.to_amount), rate: Number(e.rate), rateSource: e.rate_source, date: formatShort(e.occurred_at) }));
}

/**
 * `userId` solo hace falta del lado SERVIDOR. La columna `user_id` es NOT NULL con
 * default `auth.uid()`: desde el browser la pone la sesión sola, pero con el
 * service role no hay usuario autenticado, `auth.uid()` da NULL y el insert falla.
 */
export async function insertTransaction(sb: SupabaseClient, tx: NewTx, userId?: string) {
  const { data, error } = await sb
    .from("transactions")
    .insert({
      ...(userId ? { user_id: userId } : {}),
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      category_id: tx.categoryId,
      payment_method_id: tx.paymentMethodId,
      description: tx.description,
      source: "manual",
      // Solo se manda si el usuario eligió fecha; si no, la base pone now().
      // El trigger trg_tx_freeze_fx congela la cotización del día que quede acá,
      // así que un gasto de abril se valúa con el dólar de abril.
      ...(tx.occurredAt ? { occurred_at: tx.occurredAt } : {}),
    })
    .select("id")
    .single();
  if (error) throw error;
  return data;
}

export type EditTx = {
  type: "ingreso" | "egreso";
  amount: number;
  currency: string;
  categoryId: number | null;
  paymentMethodId: number | null;
  description: string | null;
  occurredAt: string; // ISO
};
export async function updateTransaction(sb: SupabaseClient, id: number, tx: EditTx) {
  const { error } = await sb.from("transactions").update({
    type: tx.type, amount: tx.amount, currency: tx.currency,
    category_id: tx.categoryId, payment_method_id: tx.paymentMethodId,
    description: tx.description, occurred_at: tx.occurredAt,
  }).eq("id", id);
  if (error) throw error;
}
export async function deleteTransaction(sb: SupabaseClient, id: number) {
  const { error } = await sb.from("transactions").delete().eq("id", id);
  if (error) throw error;
}
export async function updateTxCategory(sb: SupabaseClient, id: number, categoryId: number) {
  const { error } = await sb.from("transactions").update({ category_id: categoryId }).eq("id", id);
  if (error) throw error;
}

// ---- Planes de cuotas (editar el plan = afecta TODAS las cuotas) ----
export type EditPlan = { description: string; emoji: string; monthlyAmount: number; totalInstallments: number; firstChargeDate: string };
export async function updateInstallmentPlan(sb: SupabaseClient, id: number, p: EditPlan) {
  const { error } = await sb.from("installment_plans").update({
    description: p.description, emoji: p.emoji, monthly_amount: p.monthlyAmount,
    total_installments: p.totalInstallments, first_charge_date: p.firstChargeDate,
  }).eq("id", id);
  if (error) throw error;
}
export async function deleteInstallmentPlan(sb: SupabaseClient, id: number) {
  const { error } = await sb.from("installment_plans").delete().eq("id", id);
  if (error) throw error;
}

export type NewDebt = {
  personId: number | null;
  kind: "cash" | "in_kind" | "split";
  direction: "to_collect" | "to_pay";
  amount: number;
  currency: string;
  description: string | null;
  splitTotal?: number;
  yourShare?: number;
  participants?: number;
};
// Movimiento "Préstamo" en Transacciones (no cuenta como gasto/ingreso en métricas).
// Devuelve el id de la transacción creada (para vincularla al pago y poder borrarlos juntos).
// Antes esta función NO leía ningún `error`: si el insert fallaba (RLS, constraint,
// red) devolvía null y los tres llamadores lo trataban como éxito. Resultado: la
// deuda quedaba registrada pero el movimiento de plata no existía, en silencio.
async function loanTransaction(sb: SupabaseClient, type: "ingreso" | "egreso", amount: number, currency: string, desc: string): Promise<number> {
  const { data: cat, error: eCat } = await sb.from("categories").select("id").eq("name", "Préstamos").maybeSingle();
  if (eCat) throw eCat;
  // Sin la categoría "Préstamos" la transacción caería en "Otros" y SÍ contaría como
  // gasto en las métricas, rompiendo la decisión 3. Mejor fallar que falsear.
  if (!cat?.id) throw new Error('Falta la categoría "Préstamos". Creala antes de registrar movimientos de deuda.');
  const { data: pm } = await sb.from("payment_methods").select("id").ilike("name", "%efectivo%").limit(1).maybeSingle();
  const { data, error } = await sb.from("transactions").insert({
    type, amount, currency, category_id: cat.id, payment_method_id: pm?.id ?? null,
    description: desc, is_paid: true, source: "manual",
  }).select("id").maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error("No se pudo registrar el movimiento de plata de la deuda.");
  return data.id as number;
}

export async function insertDebt(sb: SupabaseClient, d: NewDebt) {
  const { error } = await sb.from("debts").insert({
    person_id: d.personId,
    kind: d.kind,
    direction: d.direction,
    amount: d.amount,
    currency: d.currency,
    description: d.description,
    split_total: d.splitTotal ?? null,
    your_share: d.yourShare ?? null,
    participants: d.participants ?? null,
  });
  if (error) throw error;
  // Si es efectivo (movimiento real de plata), reflejarlo en Transacciones.
  if (d.kind === "cash") {
    let pname = "alguien";
    if (d.personId) { const { data: p } = await sb.from("persons").select("name").eq("id", d.personId).maybeSingle(); pname = p?.name ?? pname; }
    if (d.direction === "to_collect") await loanTransaction(sb, "egreso", d.amount, d.currency, `Préstamo a ${pname}`);
    else await loanTransaction(sb, "ingreso", d.amount, d.currency, `Préstamo de ${pname}`);
  }
}
// ---- Registro de operaciones (botón "Deshacer") ----
// Solo se anotan las operaciones que crean VARIAS filas de una. NO se registra lo
// que hace el email-poller: "lo último que pasó" no es "lo último que hiciste vos".
export type ActivityKind = "split" | "exchange" | "debt_payment";
export type Activity = { id: number; kind: ActivityKind; label: string; detail: any; createdAt: string };

async function logActivity(sb: SupabaseClient, kind: ActivityKind, label: string, detail: any, userId?: string) {
  // Si falla, se pierde el deshacer pero NO la operación: nunca debe tirar el flujo.
  //
  // `userId` es para quien escribe SIN sesión (el agente, con service role): ahí
  // el default `auth.uid()` de la columna da NULL y el insert se caería en
  // silencio, dejando la operación fuera del Deshacer. Desde el browser no se
  // pasa y todo sigue igual que antes.
  try {
    await sb.from("activity_log").insert({ kind, label, detail, ...(userId ? { user_id: userId } : {}) });
  } catch { /* noop */ }
}

/** La última operación deshecha-ble, o null si no hay ninguna pendiente. */
export async function ultimaOperacion(sb: SupabaseClient): Promise<Activity | null> {
  const { data, error } = await sb.from("activity_log")
    .select("id,kind,label,detail,created_at")
    .is("undone_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return null;   // la tabla puede no existir todavía (migración sin correr)
  if (!data) return null;
  return { id: data.id, kind: data.kind, label: data.label, detail: data.detail, createdAt: data.created_at };
}

/**
 * Revierte una operación registrada. Cada tipo sabe deshacerse:
 *   split        → junta las dos transacciones en una y borra las deudas
 *   exchange     → borra el cambio (la FK en cascada se lleva su contrasiento)
 *   debt_payment → borra el pago, su movimiento de plata y reabre la deuda
 */
export async function deshacerOperacion(sb: SupabaseClient, op: Activity) {
  const d = op.detail ?? {};

  if (op.kind === "split") {
    // 1) la original vuelve a su monto y descripción de antes
    const { error: e1 } = await sb.from("transactions")
      .update({ amount: d.montoOriginal, description: d.descOriginal ?? null })
      .eq("id", d.originalTxId);
    if (e1) throw e1;
    // 2) se va la hermana de "Préstamos"
    if (d.hermanaTxId) {
      const { error } = await sb.from("transactions").delete().eq("id", d.hermanaTxId);
      if (error) throw error;
    }
    // 3) y las deudas que había generado
    if (d.debtIds?.length) {
      const { error } = await sb.from("debts").delete().in("id", d.debtIds);
      if (error) throw error;
    }
  } else if (op.kind === "exchange") {
    await deleteExchange(sb, d.exchangeId);
  } else if (op.kind === "debt_payment") {
    if (d.txId) await sb.from("transactions").delete().eq("id", d.txId);
    const { error } = await sb.from("debt_payments").delete().eq("id", d.paymentId);
    if (error) throw error;
    // si el pago había saldado la deuda, vuelve a quedar pendiente
    if (d.saldoLaDeuda) {
      await sb.from("debts").update({ status: "pending", settled_at: null }).eq("id", d.debtId);
    }
  } else {
    throw new Error(`No sé deshacer una operación de tipo "${op.kind}".`);
  }

  const { error } = await sb.from("activity_log").update({ undone_at: new Date().toISOString() }).eq("id", op.id);
  if (error) throw error;
}

// ---- Dividir un gasto entre varias personas ----
export type SplitParte = { personId: number; personName: string; amount: number };

/**
 * Convierte un gasto propio en un gasto compartido.
 *
 * El movimiento original se PARTE EN DOS, conservando fecha, tarjeta, resumen y
 * método de pago:
 *   · tu parte  → queda en la transacción original, con su categoría real
 *   · lo ajeno  → una transacción hermana en "Préstamos"
 * más una deuda `split` por persona.
 *
 * Por qué así:
 *   - "Préstamos" ya está EXCLUIDA de las métricas de gasto (decisión 3), así que
 *     "Gastos por categoría" pasa a mostrar solo lo tuyo sin tocar ningún cálculo.
 *   - Los dos movimientos suman el total original → el saldo no se descuadra.
 *   - Las dos conservan el `statement_id`, así que el resumen de la tarjeta sigue
 *     sumando lo mismo y sigue cerrando contra el PDF del banco. Por eso esto
 *     funciona igual con crédito, que era el caso "difícil".
 *   - El patrimonio no se mueve: cambiás plata por "te deben".
 *
 * No hay RPC, así que la atomicidad se cubre con compensación: si falla un paso,
 * se deshace lo ya creado.
 */
export async function splitTransaction(sb: SupabaseClient, txId: number, yourShare: number, partes: SplitParte[]) {
  if (!partes.length) throw new Error("Elegí al menos una persona con quien dividir.");

  const { data: tx, error: eTx } = await sb.from("transactions").select("*").eq("id", txId).maybeSingle();
  if (eTx) throw eTx;
  if (!tx) throw new Error("Ese movimiento ya no existe. Recargá la pantalla.");

  const total = Number(tx.amount);
  const ajeno = partes.reduce((a, p) => a + p.amount, 0);
  if (Math.abs(yourShare + ajeno - total) > 0.5) {
    throw new Error(`Las partes suman ${(yourShare + ajeno).toFixed(2)} y el gasto es ${total.toFixed(2)}.`);
  }
  if (yourShare < 0 || partes.some((p) => p.amount <= 0)) throw new Error("Cada parte tiene que ser mayor a cero.");

  const { data: cat } = await sb.from("categories").select("id").eq("name", "Préstamos").maybeSingle();
  if (!cat?.id) throw new Error('Falta la categoría "Préstamos", que es la que mantiene el gasto ajeno fuera de tus métricas.');

  const base = (tx.description ?? "Gasto compartido").replace(/^Parte de otros · /, "");

  // 1) la transacción hermana con la parte ajena
  const { data: hermana, error: eH } = await sb.from("transactions").insert({
    type: tx.type,
    amount: ajeno,
    currency: tx.currency,
    category_id: cat.id,
    payment_method_id: tx.payment_method_id,
    card_id: tx.card_id,
    statement_id: tx.statement_id,   // mismo resumen: el total de la tarjeta no cambia
    occurred_at: tx.occurred_at,
    description: `Parte de otros · ${base}`,
    is_paid: tx.is_paid,
    source: tx.source,
  }).select("id").single();
  if (eH) throw eH;

  const deudas: number[] = [];
  try {
    // 2) una deuda por persona
    for (const p of partes) {
      const { data, error } = await sb.from("debts").insert({
        person_id: p.personId,
        kind: "split",
        direction: "to_collect",
        amount: p.amount,
        currency: tx.currency,
        description: base,
        split_total: total,
        your_share: yourShare,
        participants: partes.length + 1,   // los otros + vos
      }).select("id").single();
      if (error) throw error;
      deudas.push(data.id as number);
    }

    // 3) recién ahora se reduce la original a tu parte
    const { error: eU } = await sb.from("transactions")
      .update({ amount: yourShare, description: base })
      .eq("id", txId);
    if (eU) throw eU;

    // 4) queda registrado para poder deshacerlo. Guarda el monto y la descripción
    //    PREVIOS, que son los que hay que restaurar.
    await logActivity(sb, "split", `División de «${base}» entre ${partes.length + 1}`, {
      originalTxId: txId,
      hermanaTxId: hermana.id,
      debtIds: deudas,
      montoOriginal: total,
      descOriginal: tx.description,
    });
  } catch (err) {
    // compensación: sin esto quedaría un egreso duplicado inflando el gasto
    if (deudas.length) await sb.from("debts").delete().in("id", deudas);
    await sb.from("transactions").delete().eq("id", hermana.id);
    throw err;
  }
}

export async function insertPerson(sb: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await sb.from("persons").insert({ name }).select("id").single();
  if (error) throw error;
  return data.id as number;
}

// ---- Asistente IA (chatbot con tool use vía Edge Function) ----
export type AssistantProposal = {
  resumen?: string;
  transacciones?: { tipo: "ingreso" | "egreso"; monto: number; moneda: string; categoria: string; metodo_pago: string; descripcion: string }[];
  deudas?: { persona: string; direccion: "me_deben" | "debo"; tipo: "cash" | "split" | "in_kind"; monto: number; moneda: string; descripcion: string; total_dividido?: number; tu_parte?: number; participantes?: number }[];
};
export type AssistantReply = { reply: string; proposal: AssistantProposal | null; options?: string[] | null; tokens?: number; costUsd?: number };
export async function askAssistant(sb: SupabaseClient, messages: { role: "user" | "assistant"; content: string }[]): Promise<AssistantReply> {
  const { data, error } = await sb.functions.invoke("assistant", { body: { messages } });
  if (error) throw error;
  if (data?.error) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail ?? data.error));
  return data;
}

async function debtPaidSoFar(sb: SupabaseClient, debtId: number): Promise<number> {
  const { data } = await sb.from("debt_payments").select("amount").eq("debt_id", debtId);
  return (data ?? []).reduce((a: number, p: any) => a + Number(p.amount), 0);
}
// Al PAGAR/SALDAR una deuda, la plata entra o sale (sea préstamo, gasto compartido o en especie pagado en plata).
// `nota` es opcional y se anexa a la descripción del movimiento: sin ella, en
// Transacciones solo se ve "Cobro a Branko" y no queda registro de por qué ni cómo.
async function debtCashMovement(sb: SupabaseClient, d: any, amount: number, nota?: string): Promise<number> {
  const pname = d.persons?.name ?? "alguien";
  const sufijo = nota?.trim() ? ` · ${nota.trim()}` : "";
  const base = d.direction === "to_collect" ? `Cobro a ${pname}` : `Pago a ${pname}`;
  const contexto = d.description ? ` (${d.description})` : "";
  return loanTransaction(sb, d.direction === "to_collect" ? "ingreso" : "egreso", amount, d.currency, `${base}${contexto}${sufijo}`);
}

/**
 * Registra un pago de deuda: mueve la plata y anota el pago.
 *
 * Son dos escrituras en tablas distintas y NO hay transacción (esto corre desde el
 * browser). Lo que sí hay es COMPENSACIÓN: si el insert del pago falla, se borra la
 * transacción recién creada. Sin eso quedaba un ingreso/egreso fantasma que había
 * movido el saldo sin ningún pago que lo justificara.
 *
 * Lo correcto de verdad sería una RPC, como se hizo con `register_exchange`.
 */
async function registrarPago(sb: SupabaseClient, d: any, debtId: number, amount: number, nota?: string): Promise<{ txId: number; paymentId: number }> {
  const txId = await debtCashMovement(sb, d, amount, nota);
  const { data, error } = await sb.from("debt_payments")
    .insert({ debt_id: debtId, amount, transaction_id: txId }).select("id").single();
  if (error) {
    await sb.from("transactions").delete().eq("id", txId); // compensación
    throw error;
  }
  return { txId, paymentId: data.id as number };
}

// Saldo pendiente real de una deuda, leído de la base (no del estado de la UI).
async function debtOutstanding(sb: SupabaseClient, debtId: number, amount: number): Promise<number> {
  const paid = await debtPaidSoFar(sb, debtId);
  return Math.max(Number(amount) - paid, 0);
}

async function marcarSaldada(sb: SupabaseClient, id: number) {
  const { error } = await sb.from("debts").update({ status: "settled", settled_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

// Saldar el total restante de una deuda (registra un pago por el saldo pendiente).
export async function settleDebt(sb: SupabaseClient, id: number) {
  const { data: debt, error } = await sb.from("debts").select("kind,direction,amount,currency,persons(name)").eq("id", id).maybeSingle();
  if (error) throw error;
  // Antes era `return` a secas: si la deuda ya no existía, el botón no hacía nada
  // y tampoco avisaba.
  if (!debt) throw new Error("Esa deuda ya no existe. Recargá la pantalla.");
  const d = debt as any;
  const outstanding = await debtOutstanding(sb, id, d.amount);
  if (outstanding > 0.5) await registrarPago(sb, d, id, outstanding);
  await marcarSaldada(sb, id);
}

// Pago parcial de una deuda: registra un pago (NO toca el monto original) y mueve la plata.
export async function payDebt(sb: SupabaseClient, debtId: number, amount: number, nota?: string) {
  const { data: debt, error } = await sb.from("debts").select("kind,direction,amount,currency,persons(name)").eq("id", debtId).maybeSingle();
  if (error) throw error;
  if (!debt) throw new Error("Esa deuda ya no existe. Recargá la pantalla.");
  const d = debt as any;

  // El saldo pendiente se relee de la base, no se confía en la UI: sin este tope se
  // podía pagar $50.000 de una deuda de $10.000. La deuda quedaba saldada (outstanding
  // hace Math.max(…, 0), así que el exceso no se veía) pero el movimiento de plata se
  // generaba por el monto completo y te descuadraba el saldo líquido.
  const outstanding = await debtOutstanding(sb, debtId, d.amount);
  if (amount > outstanding + 0.5) {
    throw new Error(`El pago (${amount.toLocaleString("es-AR")}) supera el saldo pendiente (${outstanding.toLocaleString("es-AR")}).`);
  }

  const { txId, paymentId } = await registrarPago(sb, d, debtId, amount, nota);
  const saldoLaDeuda = (await debtOutstanding(sb, debtId, d.amount)) <= 0.5;
  if (saldoLaDeuda) await marcarSaldada(sb, debtId);

  const quien = d.persons?.name ?? "alguien";
  await logActivity(sb, "debt_payment", `Pago de ${amount.toLocaleString("es-AR")} ${d.currency} de ${quien}`, {
    debtId, paymentId, txId, saldoLaDeuda,
  });
}

// Borrar un pago de deuda (ej: click duplicado): elimina también su movimiento de plata
// y, si la deuda estaba saldada, la reabre con el saldo pendiente que corresponda.
export async function deleteDebtPayment(sb: SupabaseClient, debtId: number, p: DebtPayment) {
  if (p.transactionId) {
    const { error } = await sb.from("transactions").delete().eq("id", p.transactionId);
    if (error) throw error;
  } else {
    // Pagos viejos sin vínculo: matchear el movimiento "Cobro a/Pago a" por monto y ±2 min.
    const t = new Date(p.at).getTime();
    const { data: cand } = await sb.from("transactions").select("id,description").eq("amount", p.amount)
      .gte("occurred_at", new Date(t - 120000).toISOString()).lte("occurred_at", new Date(t + 120000).toISOString());
    const hit = (cand ?? []).find((x: any) => /^(cobro a|pago a)/i.test(x.description ?? ""));
    if (hit) await sb.from("transactions").delete().eq("id", hit.id);
  }
  const { error: ePago } = await sb.from("debt_payments").delete().eq("id", p.id);
  if (ePago) throw ePago;
  const { data: d } = await sb.from("debts").select("amount,status").eq("id", debtId).maybeSingle();
  if (d && (d as any).status === "settled") {
    const paid = await debtPaidSoFar(sb, debtId);
    if (Number((d as any).amount) - paid > 0.5) {
      const { error } = await sb.from("debts").update({ status: "pending", settled_at: null }).eq("id", debtId);
      if (error) throw error;
    }
  }
}

export type Metrics = {
  ref_month: string;
  ars_liquido: number; usd_liquido: number; usdt_liquido: number;
  deuda_cuotas_ars: number; deuda_vencida_ars: number;
  te_deben: number; debes: number;
  ing_mes_ars: number; ing_mes_usd: number;
  egr_mes_ars: number; egr_mes_usd: number;
  usdt_ars: number; usd_ars: number;
};
export async function fetchMetrics(sb: SupabaseClient): Promise<Metrics> {
  const { data, error } = await sb.rpc("get_metrics");
  if (error) throw error;
  const d = data as any;
  const n = (v: any) => Number(v) || 0;
  return {
    ref_month: d.ref_month,
    ars_liquido: n(d.ars_liquido), usd_liquido: n(d.usd_liquido), usdt_liquido: n(d.usdt_liquido),
    deuda_cuotas_ars: n(d.deuda_cuotas_ars), deuda_vencida_ars: n(d.deuda_vencida_ars),
    te_deben: n(d.te_deben), debes: n(d.debes),
    ing_mes_ars: n(d.ing_mes_ars), ing_mes_usd: n(d.ing_mes_usd),
    egr_mes_ars: n(d.egr_mes_ars), egr_mes_usd: n(d.egr_mes_usd),
    usdt_ars: n(d.usdt_ars), usd_ars: n(d.usd_ars),
  };
}

export type RecurringView = { id: number; name: string; baseAmount: number; type: "ingreso" | "egreso"; emoji: string; category: string; preferredDay: number | null; cardId: number | null };
export async function fetchRecurring(sb: SupabaseClient): Promise<RecurringView[]> {
  const { data, error } = await sb.from("recurring_templates").select("id,name,base_amount,type,preferred_day,card_id,categories(name,emoji)").eq("is_active", true).order("preferred_day");
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, baseAmount: Number(r.base_amount ?? 0), type: r.type, emoji: r.categories?.emoji ?? "🔁", category: r.categories?.name ?? "Otros", preferredDay: r.preferred_day, cardId: r.card_id }));
}

// ---- Inflación oficial (tabla inflation_monthly, sincronizada por edge function) ----
export async function fetchInflationData(sb: SupabaseClient): Promise<{ byMonth: Record<string, number>; projected: number; latest: string | null }> {
  const { data, error } = await sb.from("inflation_monthly").select("month,rate").order("month", { ascending: false });
  if (error) throw error;
  const byMonth: Record<string, number> = {};
  for (const r of (data ?? []) as any[]) byMonth[r.month] = Number(r.rate);
  const recent = (data ?? []).slice(0, 6).map((r: any) => Number(r.rate));
  const projected = recent.length ? recent.reduce((a: number, b: number) => a + b, 0) / recent.length : 0;
  return { byMonth, projected, latest: (data ?? [])[0]?.month ?? null };
}

// ---- Tablero de cotizaciones (pantalla Divisas) ----
// Reemplaza los datos mock que vivían en lib/mock.ts (ya borrado: Divisas fue la
// última pantalla que los usaba). Sale todo de `fx_rates`, la misma tabla que
// alimenta las valuaciones del resto de la app y que sincroniza la Edge Function
// fx-sync cada hora. La tabla tiene política `read_all`: se puede leer desde el
// browser sin problema.
export const FX_CASAS = [
  { casa: "blue", label: "Blue", hint: "informal" },
  { casa: "bolsa", label: "MEP", hint: "bolsa" },
  { casa: "cripto", label: "Cripto", hint: "USDT" },
  { casa: "oficial", label: "Oficial", hint: "BNA" },
] as const;

export type FxQuote = {
  casa: string; label: string; hint: string;
  day: string; compra: number; venta: number;
  /** Variación % de la venta contra el día anterior con dato. */
  changePct: number | null;
};
export type FxPoint = { day: string; compra: number; venta: number };
export type FxBoard = { quotes: FxQuote[]; series: Record<string, FxPoint[]> };

export async function fetchFxBoard(sb: SupabaseClient, dias = 90): Promise<FxBoard> {
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const iso = desde.toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("fx_rates")
    .select("day,casa,compra,venta")
    .in("casa", FX_CASAS.map((c) => c.casa))
    .gte("day", iso)
    .order("day", { ascending: true });
  if (error) throw error;

  const series: Record<string, FxPoint[]> = {};
  for (const r of (data ?? []) as any[]) {
    (series[r.casa] ??= []).push({ day: r.day, compra: Number(r.compra), venta: Number(r.venta) });
  }
  const quotes: FxQuote[] = [];
  for (const c of FX_CASAS) {
    const s = series[c.casa];
    if (!s?.length) continue;
    const last = s[s.length - 1];
    const prev = s.length > 1 ? s[s.length - 2] : null;
    quotes.push({
      casa: c.casa, label: c.label, hint: c.hint,
      day: last.day, compra: last.compra, venta: last.venta,
      changePct: prev && prev.venta ? ((last.venta - prev.venta) / prev.venta) * 100 : null,
    });
  }
  return { quotes, series };
}

// ---- Patrimonio neto en el tiempo ----
// Serie reconstruida por la RPC `get_networth_series`: para el cierre de cada mes
// calcula los mismos componentes que get_metrics() devuelve para hoy. Las tenencias
// se valúan con la cotización VIGENTE A ESA FECHA (no la congelada del movimiento):
// son stocks, y lo que valían tus dólares el 30/04 es el blue del 30/04.
// El último punto de la serie coincide con el patrimonio que muestra /metricas.
export type NetWorthPoint = {
  month: string; cutoff: string;
  ars: number; usd: number; usdt: number; usdArs: number; usdtArs: number;
  teDeben: number; debes: number; deudaCuotas: number; deudaVencida: number;
  activos: number; pasivos: number; patrimonio: number;
};
export async function fetchNetWorthSeries(sb: SupabaseClient, months = 12): Promise<NetWorthPoint[]> {
  const { data, error } = await sb.rpc("get_networth_series", { p_months: months });
  if (error) throw error;
  const n = (v: any) => Number(v) || 0;
  return (data ?? []).map((r: any): NetWorthPoint => ({
    month: r.month, cutoff: r.cutoff,
    ars: n(r.ars), usd: n(r.usd), usdt: n(r.usdt),
    usdArs: n(r.usd_ars), usdtArs: n(r.usdt_ars),
    teDeben: n(r.te_deben), debes: n(r.debes),
    deudaCuotas: n(r.deuda_cuotas), deudaVencida: n(r.deuda_vencida),
    activos: n(r.activos), pasivos: n(r.pasivos), patrimonio: n(r.patrimonio),
  }));
}

// ---- Desglose mensual (para gráficos de Métricas) ----
// Una fila por (mes, tipo, categoría, método, moneda). Excluye "Cambio Divisas" (ruido de conversión).
// `total` es el monto en su moneda original. Para valuar en ARS NO hay que multiplicarlo
// por la cotización de hoy: cada fila trae su cotización congelada, así que el grupo ya
// viene sumado en `totalArs`. `totalPend` queda con lo que no tenía rate congelado (en su
// moneda), para que el llamador lo valúe con la cotización viva vía `aggArs()`.
export type MonthAgg = { month: string; type: "ingreso" | "egreso"; category: string; emoji: string; method: string; currency: "ARS" | "USD" | "USDT"; total: number; totalArs: number; totalPend: number; count: number };
export async function fetchMonthlyBreakdown(sb: SupabaseClient, monthsBack = 6): Promise<MonthAgg[]> {
  // Ventana de meses CALENDARIO completos, desde el día 1 a las 00:00 de Argentina.
  //
  // ⚠️ Antes era `setMonth(getMonth()-monthsBack); setDate(1)` sin poner la hora en
  // cero, así que `since` conservaba la hora actual y **el mes más viejo salía
  // truncado según la hora en que preguntaras**: a las 12:50 se perdía todo lo
  // anterior a las 12:50 del día 1. Medido: abril daba $474.764 con `meses:4` y
  // $1.013.974 con `meses:5` — el 53% del mes aparecía o desaparecía solo.
  // Además devolvía monthsBack+1 buckets en vez de monthsBack.
  const desde = desdeElDia(`${sumarMeses(mesActual(), -Math.max(monthsBack - 1, 0))}-01`);

  const { data, error } = await sb
    .from("transactions")
    .select("type,amount,currency,fx_rate_ars,occurred_at,categories(name,emoji),payment_methods(name)")
    .gte("occurred_at", desde)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  const map = new Map<string, MonthAgg>();
  for (const r of (data ?? []) as any[]) {
    const cat = r.categories?.name ?? "Otros";
    if (cat === "Cambio Divisas" || cat === "Préstamos") continue; // no son gasto/ingreso real
    // ⚠️ NO `slice(0,7)`: eso agrupa por mes UTC. Un gasto del 31 de mayo a las
    // 23:23 de Argentina se guarda como 1 de junio en UTC y caía en el mes
    // siguiente. Medido: $67.250 de mayo contados en junio.
    const month = mesDe(r.occurred_at);
    const method = r.payment_methods?.name ?? "—";
    const key = `${month}|${r.type}|${cat}|${method}|${r.currency}`;
    const cur = map.get(key) ?? { month, type: r.type, category: cat, emoji: r.categories?.emoji ?? "✨", method, currency: r.currency, total: 0, totalArs: 0, totalPend: 0, count: 0 };
    const amount = Number(r.amount);
    const rate = r.fx_rate_ars != null ? Number(r.fx_rate_ars) : r.currency === "ARS" ? 1 : null;
    cur.total += amount;
    if (rate != null) cur.totalArs += amount * rate;
    else cur.totalPend += amount;
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.values()];
}

// ---- Presupuestos editables del Cash Flow (override del promedio por categoría) ----
export async function fetchCashflowBudgets(sb: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await sb.from("cashflow_budgets").select("category,monthly_amount");
  if (error) throw error;
  const m: Record<string, number> = {};
  for (const b of (data ?? []) as any[]) m[b.category] = Number(b.monthly_amount);
  return m;
}
export async function upsertCashflowBudget(sb: SupabaseClient, category: string, monthly: number) {
  const { error } = await sb.from("cashflow_budgets").upsert({ category, monthly_amount: monthly, updated_at: new Date().toISOString() }, { onConflict: "user_id,category" });
  if (error) throw error;
}
export async function deleteCashflowBudget(sb: SupabaseClient, category: string) {
  const { error } = await sb.from("cashflow_budgets").delete().eq("category", category);
  if (error) throw error;
}

// ---- Planificación manual del Cash Flow (movimientos futuros a mano: puntuales o en cuotas) ----
export type CashflowPlan = { id: number; type: "ingreso" | "egreso"; concept: string; amount: number; startMonth: string; monthsCount: number };
export async function fetchCashflowPlans(sb: SupabaseClient): Promise<CashflowPlan[]> {
  const { data, error } = await sb.from("cashflow_plans").select("id,type,concept,amount,start_month,months_count").order("start_month");
  if (error) throw error;
  return (data ?? []).map((p: any) => ({ id: p.id, type: p.type, concept: p.concept, amount: Number(p.amount), startMonth: p.start_month, monthsCount: p.months_count }));
}
export async function insertCashflowPlan(sb: SupabaseClient, p: { type: "ingreso" | "egreso"; concept: string; amount: number; startMonth: string; monthsCount: number }) {
  const { error } = await sb.from("cashflow_plans").insert({ type: p.type, concept: p.concept, amount: p.amount, start_month: p.startMonth, months_count: p.monthsCount });
  if (error) throw error;
}
export async function deleteCashflowPlan(sb: SupabaseClient, id: number) {
  const { error } = await sb.from("cashflow_plans").delete().eq("id", id);
  if (error) throw error;
}

// ---- Config: inflación mensual (%) ----
export async function fetchInflation(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.from("cashflow_config").select("inflation_monthly").maybeSingle();
  if (error) throw error;
  return data ? Number((data as any).inflation_monthly) : 0;
}
export async function updateInflation(sb: SupabaseClient, pct: number) {
  const { error } = await sb.from("cashflow_config").upsert({ inflation_monthly: pct }, { onConflict: "user_id" });
  if (error) throw error;
}

// ---- Editar monto de un recurrente (para mantener ingresos reales) ----
export async function updateRecurringAmount(sb: SupabaseClient, id: number, amount: number) {
  const { error } = await sb.from("recurring_templates").update({ base_amount: amount }).eq("id", id);
  if (error) throw error;
}

// ---- Proyección: todos los planes de cuotas con su calendario completo ----
/** `monthly` va en la moneda del plan — ver el aviso en `InstallmentRow`. */
export type PlanProj = { id: number; desc: string; monthly: number; currency: string; total: number; firstMonth: string; category: string; emoji: string; cardId: number | null };
export async function fetchPlansForProjection(sb: SupabaseClient): Promise<PlanProj[]> {
  const { data, error } = await sb.from("installment_plans").select("id,description,monthly_amount,currency,total_installments,first_charge_date,card_id,categories(name,emoji)");
  if (error) throw error;
  return (data ?? []).map((p: any) => ({ id: p.id, desc: p.description, monthly: Number(p.monthly_amount), currency: String(p.currency ?? "ARS"), total: p.total_installments, firstMonth: String(p.first_charge_date).slice(0, 7), category: p.categories?.name ?? "Cuotas", emoji: p.categories?.emoji ?? "💳", cardId: p.card_id }));
}

export type NewExchange = { from: string; to: string; fromAmount: number; toAmount: number; rate: number; rateSource: "auto" | "manual" };
/**
 * Registra un cambio de divisas Y mueve los saldos.
 *
 * Va por la RPC `register_exchange` en vez de tres inserts desde acá porque tiene
 * que ser atómico: escribe la operación en `currency_exchanges` más las dos
 * transacciones del contrasiento (egreso de lo que entregaste, ingreso de lo que
 * recibiste), ambas en la categoría "Cambio Divisas" — que mueve el saldo pero
 * está excluida de las métricas de gasto/ingreso. Si se hiciera por partes y
 * fallara la segunda, quedaría un saldo mal sin su contrapartida.
 */
export async function insertExchange(sb: SupabaseClient, e: NewExchange, userId?: string) {
  const { data, error } = await sb.rpc("register_exchange", {
    p_from: e.from,
    p_to: e.to,
    p_from_amount: e.fromAmount,
    p_to_amount: e.toAmount,
    p_rate: e.rate,
    p_rate_source: e.rateSource,
    // Solo lo manda quien no tiene sesión (el agente). Desde el browser va
    // undefined y la RPC usa `auth.uid()`, como siempre.
    ...(userId ? { p_user_id: userId } : {}),
  });
  if (error) throw error;
  // La RPC devuelve el id del cambio; con eso el deshacer borra en cascada.
  if (data) await logActivity(sb, "exchange", `Cambio de ${e.fromAmount.toLocaleString("es-AR")} ${e.from} a ${e.toAmount.toLocaleString("es-AR")} ${e.to}`, { exchangeId: data }, userId);
}

/**
 * Edita un cambio ya registrado y su contrasiento.
 *
 * Va por RPC porque toca tres filas (la operación + las dos transacciones) y
 * tienen que moverse juntas: si se hiciera por partes y fallara la segunda, el
 * saldo quedaría inconsistente con el cambio.
 */
export async function updateExchange(sb: SupabaseClient, id: number, e: NewExchange) {
  // Si la migración no corrió, la RPC no existe y el error de PostgREST es críptico
  // ("Could not find the function..."). Mejor decir qué falta.
  const { error } = await sb.rpc("update_exchange", {
    p_id: id,
    p_from: e.from,
    p_to: e.to,
    p_from_amount: e.fromAmount,
    p_to_amount: e.toAmount,
    p_rate: e.rate,
    p_rate_source: e.rateSource,
  });
  if (error) {
    if (/find the function|does not exist|PGRST202/i.test(error.message ?? "")) {
      throw new Error("Falta correr la migración 2026-08-03 en Supabase para poder editar cambios. Por ahora podés borrarlo y cargarlo de nuevo.");
    }
    throw error;
  }
}

/**
 * Borra un cambio junto con las dos transacciones que generó.
 *
 * Con la migración `2026-08-03_exchange_link` aplicada alcanza con borrar el cambio:
 * la FK `transactions.exchange_id` es ON DELETE CASCADE. Pero si todavía NO se corrió,
 * ese borrado dejaría los dos movimientos huérfanos y el saldo descuadrado — por eso
 * acá se borran explícitamente ANTES, con el vínculo si existe y por coincidencia de
 * fecha y montos si no. Cuando la migración esté, la primera rama cubre todo y esta
 * salvaguarda queda inerte.
 */
export async function deleteExchange(sb: SupabaseClient, id: number) {
  const { data: ex } = await sb.from("currency_exchanges")
    .select("from_currency,to_currency,from_amount,to_amount,occurred_at").eq("id", id).maybeSingle();

  // 1) por el vínculo (post-migración)
  const { error: eLink } = await sb.from("transactions").delete().eq("exchange_id", id);

  // 2) sin la columna, PostgREST devuelve 42703: caer al matcheo por fecha + monto,
  //    el mismo criterio que usa el backfill de la migración.
  if (eLink && ex) {
    const t = new Date(ex.occurred_at as string).getTime();
    const desde = new Date(t - 2000).toISOString();
    const hasta = new Date(t + 2000).toISOString();
    const { data: cat } = await sb.from("categories").select("id").eq("name", "Cambio Divisas").maybeSingle();
    if (cat?.id) {
      const { data: cand } = await sb.from("transactions")
        .select("id,type,amount,currency")
        .eq("category_id", cat.id).gte("occurred_at", desde).lte("occurred_at", hasta);
      const hit = (cand ?? []).filter((t: any) =>
        (t.type === "egreso" && t.currency === ex.from_currency && Number(t.amount) === Number(ex.from_amount)) ||
        (t.type === "ingreso" && t.currency === ex.to_currency && Number(t.amount) === Number(ex.to_amount)));
      if (hit.length) await sb.from("transactions").delete().in("id", hit.map((h: any) => h.id));
    }
  }

  const { error } = await sb.from("currency_exchanges").delete().eq("id", id);
  if (error) throw error;
}
