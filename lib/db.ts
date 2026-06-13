import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "./supabase/client";

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

// ---- Reglas de auto-categorización ----
export type Rule = { id: number; textOp: string | null; textValue: string | null; hourFrom: number | null; hourTo: number | null; days: number[] | null; categoryId: number; category: string; emoji: string | null; priority: number; isActive: boolean };
export type NewRule = { textOp: string | null; textValue: string | null; hourFrom: number | null; hourTo: number | null; days: number[] | null; categoryId: number };
export async function fetchRules(sb: SupabaseClient): Promise<Rule[]> {
  const { data, error } = await sb.from("rules").select("id,text_op,text_value,hour_from,hour_to,days,category_id,priority,is_active,categories(name,emoji)").order("priority", { ascending: false }).order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ id: r.id, textOp: r.text_op, textValue: r.text_value, hourFrom: r.hour_from, hourTo: r.hour_to, days: r.days, categoryId: r.category_id, category: r.categories?.name ?? "—", emoji: r.categories?.emoji, priority: r.priority, isActive: r.is_active }));
}
export async function insertRule(sb: SupabaseClient, r: NewRule) {
  const { error } = await sb.from("rules").insert({ text_op: r.textOp, text_value: r.textValue, hour_from: r.hourFrom, hour_to: r.hourTo, days: r.days, category_id: r.categoryId });
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
    .select("id,type,amount,currency,description,occurred_at,source,category_id,payment_method_id,categories(name,emoji),payment_methods(name),cards(name)")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r: any): TxView => ({
    id: r.id,
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
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

export type NewTx = {
  type: "ingreso" | "egreso";
  amount: number;
  currency: string;
  categoryId: number | null;
  paymentMethodId: number | null;
  description: string | null;
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

export type StatementRow = { id: number; cardId: number; period: string; closing: string; due: string; closingRaw: string | null; dueRaw: string | null; paid: boolean; totalArs: number; totalUsd: number };
export async function fetchStatements(sb: SupabaseClient): Promise<StatementRow[]> {
  const { data, error } = await sb.from("card_statements").select("id,card_id,period_label,closing_date,due_date,is_paid,total_ars,total_usd").order("closing_date", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((s: any) => ({ id: s.id, cardId: s.card_id, period: s.period_label ?? "—", closing: formatShort(s.closing_date), due: formatShort(s.due_date), closingRaw: s.closing_date, dueRaw: s.due_date, paid: !!s.is_paid, totalArs: Number(s.total_ars), totalUsd: Number(s.total_usd) }));
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

// Cuotas activas: se leen de la tabla installment_plans (fuente limpia).
// La cuota actual se calcula según cuántos meses pasaron desde first_charge_date.
export type InstallmentRow = { id: number; cardId: number | null; desc: string; emoji: string; monthly: number; current: number; total: number; firstChargeDate: string; category: string; catEmoji: string };
export async function fetchInstallments(sb: SupabaseClient): Promise<InstallmentRow[]> {
  const { data, error } = await sb
    .from("installment_plans")
    .select("id,card_id,description,emoji,monthly_amount,total_installments,first_charge_date,categories(name,emoji)");
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
export type DebtPayment = { amount: number; date: string; at: string };
export type DebtView = { id: number; person: string; emoji: string; kind: "cash" | "in_kind" | "split"; direction: "to_collect" | "to_pay"; status: "pending" | "settled"; amount: number; paid: number; outstanding: number; payments: DebtPayment[]; currency: string; description: string; date: string; occurredAt: string; settledAt: string | null; splitTotal?: number; yourShare?: number; participants?: number };
export async function fetchDebts(sb: SupabaseClient): Promise<DebtView[]> {
  const [{ data, error }, { data: pays }] = await Promise.all([
    sb.from("debts").select("id,kind,direction,status,amount,currency,description,occurred_at,settled_at,split_total,your_share,participants,persons(name)").order("occurred_at", { ascending: false }),
    sb.from("debt_payments").select("debt_id,amount,occurred_at").order("occurred_at", { ascending: true }),
  ]);
  if (error) throw error;
  const payMap = new Map<number, DebtPayment[]>();
  for (const p of (pays ?? []) as any[]) { const arr = payMap.get(p.debt_id) ?? []; arr.push({ amount: Number(p.amount), date: formatShort(p.occurred_at), at: p.occurred_at }); payMap.set(p.debt_id, arr); }
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

export async function insertTransaction(sb: SupabaseClient, tx: NewTx) {
  const { data, error } = await sb
    .from("transactions")
    .insert({
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      category_id: tx.categoryId,
      payment_method_id: tx.paymentMethodId,
      description: tx.description,
      source: "manual",
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
async function loanTransaction(sb: SupabaseClient, type: "ingreso" | "egreso", amount: number, currency: string, desc: string) {
  const { data: cat } = await sb.from("categories").select("id").eq("name", "Préstamos").maybeSingle();
  const { data: pm } = await sb.from("payment_methods").select("id").ilike("name", "%efectivo%").limit(1).maybeSingle();
  await sb.from("transactions").insert({
    type, amount, currency, category_id: cat?.id ?? null, payment_method_id: pm?.id ?? null,
    description: desc, is_paid: true, source: "manual",
  });
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
async function debtCashMovement(sb: SupabaseClient, d: any, amount: number) {
  const pname = d.persons?.name ?? "alguien";
  if (d.direction === "to_collect") await loanTransaction(sb, "ingreso", amount, d.currency, `Cobro a ${pname}`);
  else await loanTransaction(sb, "egreso", amount, d.currency, `Pago a ${pname}`);
}

// Saldar el total restante de una deuda (registra un pago por el saldo pendiente).
export async function settleDebt(sb: SupabaseClient, id: number) {
  const { data: debt } = await sb.from("debts").select("kind,direction,amount,currency,persons(name)").eq("id", id).maybeSingle();
  if (!debt) return;
  const d = debt as any;
  const paid = await debtPaidSoFar(sb, id);
  const outstanding = Math.max(Number(d.amount) - paid, 0);
  if (outstanding > 0.5) {
    await sb.from("debt_payments").insert({ debt_id: id, amount: outstanding });
    await debtCashMovement(sb, d, outstanding);
  }
  await sb.from("debts").update({ status: "settled", settled_at: new Date().toISOString() }).eq("id", id);
}

// Pago parcial de una deuda: registra un pago (NO toca el monto original) y mueve la plata.
export async function payDebt(sb: SupabaseClient, debtId: number, amount: number) {
  const { data: debt } = await sb.from("debts").select("kind,direction,amount,currency,persons(name)").eq("id", debtId).maybeSingle();
  if (!debt) return;
  const d = debt as any;
  await sb.from("debt_payments").insert({ debt_id: debtId, amount });
  const paid = await debtPaidSoFar(sb, debtId);
  if (paid >= Number(d.amount) - 0.5) await sb.from("debts").update({ status: "settled", settled_at: new Date().toISOString() }).eq("id", debtId);
  await debtCashMovement(sb, d, amount);
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

// ---- Desglose mensual (para gráficos de Métricas) ----
// Una fila por (mes, tipo, categoría, método, moneda). Excluye "Cambio Divisas" (ruido de conversión).
export type MonthAgg = { month: string; type: "ingreso" | "egreso"; category: string; emoji: string; method: string; currency: "ARS" | "USD" | "USDT"; total: number; count: number };
export async function fetchMonthlyBreakdown(sb: SupabaseClient, monthsBack = 6): Promise<MonthAgg[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);
  since.setDate(1);
  const { data, error } = await sb
    .from("transactions")
    .select("type,amount,currency,occurred_at,categories(name,emoji),payment_methods(name)")
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  const map = new Map<string, MonthAgg>();
  for (const r of (data ?? []) as any[]) {
    const cat = r.categories?.name ?? "Otros";
    if (cat === "Cambio Divisas" || cat === "Préstamos") continue; // no son gasto/ingreso real
    const month = String(r.occurred_at).slice(0, 7); // YYYY-MM
    const method = r.payment_methods?.name ?? "—";
    const key = `${month}|${r.type}|${cat}|${method}|${r.currency}`;
    const cur = map.get(key) ?? { month, type: r.type, category: cat, emoji: r.categories?.emoji ?? "✨", method, currency: r.currency, total: 0, count: 0 };
    cur.total += Number(r.amount);
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
export type PlanProj = { id: number; desc: string; monthly: number; total: number; firstMonth: string; category: string; emoji: string; cardId: number | null };
export async function fetchPlansForProjection(sb: SupabaseClient): Promise<PlanProj[]> {
  const { data, error } = await sb.from("installment_plans").select("id,description,monthly_amount,total_installments,first_charge_date,card_id,categories(name,emoji)");
  if (error) throw error;
  return (data ?? []).map((p: any) => ({ id: p.id, desc: p.description, monthly: Number(p.monthly_amount), total: p.total_installments, firstMonth: String(p.first_charge_date).slice(0, 7), category: p.categories?.name ?? "Cuotas", emoji: p.categories?.emoji ?? "💳", cardId: p.card_id }));
}

export type NewExchange = { from: string; to: string; fromAmount: number; toAmount: number; rate: number; rateSource: "auto" | "manual" };
export async function insertExchange(sb: SupabaseClient, e: NewExchange) {
  const { error } = await sb.from("currency_exchanges").insert({
    from_currency: e.from,
    to_currency: e.to,
    from_amount: e.fromAmount,
    to_amount: e.toAmount,
    rate: e.rate,
    rate_source: e.rateSource,
  });
  if (error) throw error;
}
