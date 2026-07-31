"use client";

import { useEffect, useMemo, useState } from "react";
import {
  db, fetchMetrics, fetchRecurring, fetchPlansForProjection, fetchMonthlyBreakdown,
  fetchCashflowBudgets, upsertCashflowBudget, deleteCashflowBudget, fetchInflationData,
  updateRecurringAmount, fetchStatements, fetchStatementConsumos,
  fetchCashflowPlans, insertCashflowPlan, deleteCashflowPlan,
  type Metrics, type RecurringView, type PlanProj, type MonthAgg, type StatementRow, type CashflowPlan,
} from "@/lib/db";
import { aggArs, arsDe } from "@/lib/fx";
import { readCache, writeCache } from "@/lib/cache";
import { compact } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import { Chart, ArrowUpRight, ArrowDownRight, Pencil } from "../icons";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const pad = (n: number) => String(n).padStart(2, "0");
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); return monthKey(new Date(y, m - 1 + n, 1)); };
const monthsBetween = (a: string, b: string) => { const [ay, am] = a.split("-").map(Number); const [by, bm] = b.split("-").map(Number); return (by - ay) * 12 + (bm - am); };
const monthName = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MESES[m - 1]} '${String(y).slice(2)}`; };
const median = (arr: number[]) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const NOFLOW = (c: string) => c !== "Cambio Divisas" && c !== "Préstamos";

const HORIZON = 6;
const CUR = monthKey(new Date());

type Row = { label: string; emoji: string; values: number[] };

export default function CashflowPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [recurring, setRecurring] = useState<RecurringView[]>([]);
  const [plans, setPlans] = useState<PlanProj[]>([]);
  const [breakdown, setBreakdown] = useState<MonthAgg[]>([]);
  const [budgets, setBudgets] = useState<Record<string, number>>({});
  const [infl, setInfl] = useState({ projected: 0, latest: null as string | null });
  const [inflation, setInflation] = useState(0); // % mensual usado (default = oficial proyectada)
  const [loading, setLoading] = useState(true);
  const [usdRate, setUsdRate] = useState(0);
  const [usdtRate, setUsdtRate] = useState(0);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [mode, setMode] = useState<"proyeccion" | "historico">("proyeccion");
  const [histStart, setHistStart] = useState(addMonths(CUR, -HORIZON));
  // por categoría de ingreso: ¿se ajusta por inflación en la proyección? (preferencia local). Default: solo "Sueldo".
  const [inflIncome, setInflIncome] = useState<Record<string, boolean>>({});
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [stmtConsumos, setStmtConsumos] = useState<Record<number, { ars: number; usd: number }>>({});
  const [manualPlans, setManualPlans] = useState<CashflowPlan[]>([]);
  const [pf, setPf] = useState({ type: "egreso" as "egreso" | "ingreso", concept: "", amount: "", start: CUR, months: "1" });
  const [pfErr, setPfErr] = useState<string | null>(null);
  // base contable: "caja" (cuándo se mueve la plata) vs "devengado" (cuándo se consume).
  const [basis, setBasis] = useState<"caja" | "devengado">("caja");

  useEffect(() => {
    // Pintar al instante el último snapshot; lo fresco llega por atrás.
    type Snap = { m: Metrics; r: RecurringView[]; p: PlanProj[]; b: MonthAgg[]; bg: Record<string, number>; inf: { projected: number; latest: string | null }; st: StatementRow[]; co: Record<number, { ars: number; usd: number }>; mp: CashflowPlan[] };
    const s = readCache<Snap>("cashflow");
    if (s) {
      setMetrics(s.m); setRecurring(s.r); setPlans(s.p); setBreakdown(s.b); setBudgets(s.bg); setInfl(s.inf); setInflation(Number(s.inf.projected.toFixed(2)));
      setUsdRate(s.m.usd_ars); setUsdtRate(s.m.usdt_ars); setStatements(s.st); setStmtConsumos(s.co); setManualPlans(s.mp); setLoading(false);
    }
    const sb = db();
    Promise.all([fetchMetrics(sb), fetchRecurring(sb), fetchPlansForProjection(sb), fetchMonthlyBreakdown(sb, 14), fetchCashflowBudgets(sb), fetchInflationData(sb), fetchStatements(sb), fetchStatementConsumos(sb), fetchCashflowPlans(sb)])
      .then(([m, r, p, b, bg, inf, st, co, mp]) => { setMetrics(m); setRecurring(r); setPlans(p); setBreakdown(b); setBudgets(bg); setInfl({ projected: inf.projected, latest: inf.latest }); setInflation(Number(inf.projected.toFixed(2))); setUsdRate(m.usd_ars); setUsdtRate(m.usdt_ars); setStatements(st); setStmtConsumos(co); setManualPlans(mp); writeCache("cashflow", { m, r, p, b, bg, inf: { projected: inf.projected, latest: inf.latest }, st, co, mp } satisfies Snap); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    try { const s = localStorage.getItem("plata.inflIncome"); if (s) setInflIncome(JSON.parse(s)); } catch {}
  }, []);

  const proj = useMemo(() => {
    if (!metrics) return null;
    // Movimientos ya ocurridos: se valúan con la cotización congelada de su día, para que
    // los meses cerrados no se muevan al cambiar el dólar. La cotización editable de arriba
    // sigue mandando en los saldos, las proyecciones y los resúmenes de tarjeta sin pagar.
    const valuar = (b: MonthAgg) => aggArs(b, { usd: usdRate, usdt: usdtRate, day: null });
    const months = Array.from({ length: HORIZON }, (_, i) => addMonths(mode === "proyeccion" ? CUR : histStart, i));

    // --- presupuestos: separo el gasto con tarjeta de crédito del resto (efectivo/débito) ---
    const completed = [...new Set(breakdown.map((b) => b.month).filter((m) => m < CUR))].sort().slice(-3);
    const egrMonths = new Set(breakdown.filter((b) => b.type === "egreso" && completed.includes(b.month)).map((b) => b.month));
    const nEgr = Math.max(egrMonths.size, 1);
    const isCredito = (method: string) => (method || "").toLowerCase().includes("crédito") || (method || "").toLowerCase().includes("credito");
    const seed = new Map<string, { v: number; emoji: string }>();      // todo el gasto (devengado)
    const seedCash = new Map<string, { v: number; emoji: string }>();  // solo no-crédito (caja)
    let creditSeed = 0;                                                 // consumos con crédito (para estimar resúmenes futuros)
    for (const b of breakdown) {
      if (b.type !== "egreso" || !completed.includes(b.month) || !NOFLOW(b.category)) continue;
      const ars = valuar(b);
      const e = seed.get(b.category) ?? { v: 0, emoji: b.emoji }; e.v += ars; seed.set(b.category, e);
      if (isCredito(b.method)) creditSeed += ars;
      else { const c = seedCash.get(b.category) ?? { v: 0, emoji: b.emoji }; c.v += ars; seedCash.set(b.category, c); }
    }
    const budgetByCat = new Map<string, number>();
    for (const [cat, e] of seed) budgetByCat.set(cat, e.v / nEgr);
    for (const [cat, v] of Object.entries(budgets)) budgetByCat.set(cat, v);
    const budgetCash = new Map<string, number>();
    for (const [cat, e] of seedCash) budgetCash.set(cat, e.v / nEgr);
    // Si el usuario pisó una categoría, su número manda también en base caja
    // (se asume gasto de bolsillo/débito; lo de tarjeta lo estima "Pago de tarjeta" aparte).
    for (const [cat, v] of Object.entries(budgets)) budgetCash.set(cat, v);
    const creditBudget = creditSeed / nEgr; // consumos mensuales típicos con crédito (sin cuotas)

    // emoji por categoría
    const emojiOf = new Map<string, string>();
    emojiOf.set("Pago de tarjeta", "💳");
    for (const b of breakdown) if (!emojiOf.has(b.category)) emojiOf.set(b.category, b.emoji);
    for (const p of plans) if (!emojiOf.has(p.category)) emojiOf.set(p.category, p.emoji);
    for (const r of recurring) if (!emojiOf.has(r.category)) emojiOf.set(r.category, r.emoji);
    for (const pl of manualPlans) if (!emojiOf.has(pl.concept)) emojiOf.set(pl.concept, "📌");

    const monthlyCuotas = (ym: string) => plans.reduce((s, p) => { const k = monthsBetween(p.firstMonth, ym); return (k >= 0 && k < p.total) ? s + p.monthly : s; }, 0);
    const stmtCuotas = (cardId: number, period: string) => plans.reduce((s, p) => { if (p.cardId !== cardId) return s; const k = monthsBetween(p.firstMonth, period); return (k >= 0 && k < p.total) ? s + p.monthly : s; }, 0);
    // total de un resumen: si está pagado, el reconciliado (guardado); si no, en vivo (consumos linkeados + cuotas).
    const stmtTotal = (st: StatementRow) => {
      // Pagado: los USD se saldaron al dólar de ESE día (fxRate), no al de hoy.
      if (st.paid) return st.totalArs + arsDe(st.totalUsd, "USD", st.fxRate, { usd: usdRate, usdt: usdtRate, day: null });
      const c = stmtConsumos[st.id] ?? { ars: 0, usd: 0 };
      return c.ars + c.usd * usdRate + stmtCuotas(st.cardId, st.period);
    };
    // base caja: pago del resumen que VENCE en el mes mm (real si el resumen existe, estimado si no)
    const cardPayment = (mm: string) => {
      const reales = statements.filter((s) => s.dueRaw && String(s.dueRaw).slice(0, 7) === mm);
      if (reales.length) return reales.reduce((s, st) => s + stmtTotal(st), 0);
      const prev = addMonths(mm, -1); // el resumen que cierra el mes anterior se paga en mm
      const fPrev = Math.pow(1 + inflation / 100, Math.max(monthsBetween(CUR, prev), 0));
      return creditBudget * fPrev + monthlyCuotas(prev);
    };

    // --- ingresos/egresos por categoría para cada mes (real si pasado/actual, proyectado si futuro) ---
    const incPer: Map<string, number>[] = [];
    const egrPer: Map<string, number>[] = [];
    months.forEach((mm) => {
      const future = mm > CUR;
      const f = Math.pow(1 + inflation / 100, Math.max(monthsBetween(CUR, mm), 0));
      const inc = new Map<string, number>();
      const egr = new Map<string, number>();

      // INGRESOS — la plata entra cuando entra (igual en ambas bases)
      if (future) {
        for (const r of recurring.filter((x) => x.type === "ingreso")) {
          const conInfl = inflIncome[r.category] ?? (r.category === "Sueldo");
          inc.set(r.category, (inc.get(r.category) ?? 0) + (conInfl ? r.baseAmount * f : r.baseAmount));
        }
      } else {
        for (const b of breakdown) {
          if (b.month !== mm || b.type !== "ingreso" || !NOFLOW(b.category)) continue;
          inc.set(b.category, (inc.get(b.category) ?? 0) + valuar(b));
        }
      }

      // EGRESOS
      if (basis === "devengado") {
        // consumo del mes (tarjeta por fecha de compra) + cuotas
        if (future) {
          for (const p of plans) { const k = monthsBetween(p.firstMonth, mm); if (k >= 0 && k < p.total) egr.set(p.category, (egr.get(p.category) ?? 0) + p.monthly); }
          for (const [cat, v] of budgetByCat) egr.set(cat, (egr.get(cat) ?? 0) + v * f);
        } else {
          for (const b of breakdown) {
            if (b.month !== mm || b.type !== "egreso" || !NOFLOW(b.category)) continue;
            egr.set(b.category, (egr.get(b.category) ?? 0) + valuar(b));
          }
          for (const p of plans) { const k = monthsBetween(p.firstMonth, mm); if (k >= 0 && k < p.total) egr.set(p.category, (egr.get(p.category) ?? 0) + p.monthly); }
        }
      } else {
        // CAJA: gasto no-crédito (efectivo/débito) por fecha/presupuesto + pago del resumen del mes
        if (future) {
          for (const [cat, v] of budgetCash) egr.set(cat, (egr.get(cat) ?? 0) + v * f);
        } else {
          for (const b of breakdown) {
            if (b.month !== mm || b.type !== "egreso" || !NOFLOW(b.category) || isCredito(b.method)) continue;
            egr.set(b.category, (egr.get(b.category) ?? 0) + valuar(b));
          }
        }
        const pago = cardPayment(mm);
        if (pago > 0) egr.set("Pago de tarjeta", (egr.get("Pago de tarjeta") ?? 0) + pago);
      }

      // Planificación manual (puntual o en cuotas) — se aplica en los meses que cubre
      for (const pl of manualPlans) {
        const k = monthsBetween(pl.startMonth, mm);
        if (k < 0 || k >= pl.monthsCount) continue;
        if (pl.type === "ingreso") inc.set(pl.concept, (inc.get(pl.concept) ?? 0) + pl.amount);
        else egr.set(pl.concept, (egr.get(pl.concept) ?? 0) + pl.amount);
      }
      incPer.push(inc); egrPer.push(egr);
    });

    const buildRows = (per: Map<string, number>[]): Row[] => {
      const cats = [...new Set(per.flatMap((m) => [...m.keys()]))];
      return cats.map((cat) => ({ label: cat, emoji: emojiOf.get(cat) ?? "•", values: months.map((_, i) => per[i].get(cat) ?? 0) }))
        .filter((r) => r.values.some((v) => v > 0))
        .sort((a, b) => b.values.reduce((s, x) => s + x, 0) - a.values.reduce((s, x) => s + x, 0));
    };
    const incomeRows = buildRows(incPer);
    const egresoRows = buildRows(egrPer);
    const totalInc = months.map((_, i) => incomeRows.reduce((s, r) => s + r.values[i], 0));
    const totalEgr = months.map((_, i) => egresoRows.reduce((s, r) => s + r.values[i], 0));
    const neto = months.map((_, i) => totalInc[i] - totalEgr[i]);
    const startBalance = mode === "proyeccion" ? metrics.ars_liquido + metrics.usd_liquido * usdRate + metrics.usdt_liquido * usdtRate : 0;
    let acc = startBalance;
    // En proyección, el mes en curso ya está reflejado en el saldo de hoy → no se vuelve a sumar.
    const acum = neto.map((n, i) => { if (mode === "proyeccion" && i === 0) return startBalance; acc += n; return acc; });
    const isFuture = months.map((mm) => mm > CUR);

    // --- Saldo en PESOS líquidos: igual lógica pero solo flujos en ARS (las cuotas son ARS) ---
    const seedArs = new Map<string, number>(), seedCashArs = new Map<string, number>();
    let creditSeedArs = 0;
    for (const b of breakdown) {
      if (b.type !== "egreso" || !completed.includes(b.month) || !NOFLOW(b.category) || b.currency !== "ARS") continue;
      seedArs.set(b.category, (seedArs.get(b.category) ?? 0) + b.total);
      if (isCredito(b.method)) creditSeedArs += b.total;
      else seedCashArs.set(b.category, (seedCashArs.get(b.category) ?? 0) + b.total);
    }
    // Promedio por categoría con los overrides del usuario aplicados (igual que la tabla principal).
    const totalConOverrides = (seedMap: Map<string, number>) => {
      const avg = new Map<string, number>();
      for (const [cat, v] of seedMap) avg.set(cat, v / nEgr);
      for (const [cat, v] of Object.entries(budgets)) avg.set(cat, v);
      return [...avg.values()].reduce((s, v) => s + v, 0);
    };
    const budgetArsTot = totalConOverrides(seedArs);
    const budgetCashArsTot = totalConOverrides(seedCashArs);
    const creditBudgetArs = creditSeedArs / nEgr;
    const stmtTotalArs = (st: StatementRow) => st.paid ? st.totalArs : (stmtConsumos[st.id]?.ars ?? 0) + stmtCuotas(st.cardId, st.period);
    const cardPaymentArs = (mm: string) => {
      const reales = statements.filter((s) => s.dueRaw && String(s.dueRaw).slice(0, 7) === mm);
      if (reales.length) return reales.reduce((s, st) => s + stmtTotalArs(st), 0);
      const prev = addMonths(mm, -1);
      const fPrev = Math.pow(1 + inflation / 100, Math.max(monthsBetween(CUR, prev), 0));
      return creditBudgetArs * fPrev + monthlyCuotas(prev);
    };
    const netoArs = months.map((mm) => {
      const future = mm > CUR;
      const f = Math.pow(1 + inflation / 100, Math.max(monthsBetween(CUR, mm), 0));
      let inc = 0, egr = 0;
      if (future) { for (const r of recurring.filter((x) => x.type === "ingreso")) { const ci = inflIncome[r.category] ?? (r.category === "Sueldo"); inc += ci ? r.baseAmount * f : r.baseAmount; } }
      else { for (const b of breakdown) { if (b.month === mm && b.type === "ingreso" && NOFLOW(b.category) && b.currency === "ARS") inc += b.total; } }
      if (basis === "devengado") {
        if (future) egr += monthlyCuotas(mm) + budgetArsTot * f;
        else { for (const b of breakdown) { if (b.month === mm && b.type === "egreso" && NOFLOW(b.category) && b.currency === "ARS") egr += b.total; } egr += monthlyCuotas(mm); }
      } else {
        if (future) egr += budgetCashArsTot * f;
        else { for (const b of breakdown) { if (b.month === mm && b.type === "egreso" && NOFLOW(b.category) && !isCredito(b.method) && b.currency === "ARS") egr += b.total; } }
        egr += cardPaymentArs(mm);
      }
      for (const pl of manualPlans) { const k = monthsBetween(pl.startMonth, mm); if (k >= 0 && k < pl.monthsCount) { if (pl.type === "ingreso") inc += pl.amount; else egr += pl.amount; } }
      return inc - egr;
    });
    let accArs = metrics.ars_liquido;
    const pesosAcum = netoArs.map((n, i) => { if (mode === "proyeccion" && i === 0) return metrics.ars_liquido; accArs += n; return accArs; });

    return { months, incomeRows, egresoRows, totalInc, totalEgr, neto, acum, pesosAcum, startBalance, isFuture, budgetByCat, seed, completedCount: completed.length };
  }, [metrics, recurring, plans, breakdown, budgets, inflation, mode, histStart, usdRate, usdtRate, inflIncome, statements, stmtConsumos, basis, manualPlans]);

  const sb = db();
  const onBudget = (cat: string, val: number) => setBudgets((p) => ({ ...p, [cat]: val }));
  const saveBudget = (cat: string, val: number) => { upsertCashflowBudget(sb, cat, val).catch(console.error); };
  const resetBudget = (cat: string) => { setBudgets((p) => { const n = { ...p }; delete n[cat]; return n; }); deleteCashflowBudget(sb, cat).catch(console.error); };
  // ingresos recurrentes: editar monto (persiste en recurring_templates) + togglear inflación (preferencia local)
  const onIncomeAmount = (id: number, val: number) => setRecurring((p) => p.map((r) => (r.id === id ? { ...r, baseAmount: val } : r)));
  const saveIncomeAmount = (id: number, val: number) => { updateRecurringAmount(sb, id, val).catch(console.error); };
  const toggleInfl = (cat: string, base: boolean) => setInflIncome((p) => { const next = { ...p, [cat]: !(p[cat] ?? base) }; try { localStorage.setItem("plata.inflIncome", JSON.stringify(next)); } catch {} return next; });
  // planificación manual de la proyección
  const reloadPlans = async () => setManualPlans(await fetchCashflowPlans(db()));
  const addPlan = async () => {
    setPfErr(null);
    // Formato argentino: punto = miles, coma = decimales ("1.200.000" → 1200000).
    const amount = Number(pf.amount.trim().replace(/\./g, "").replace(",", "."));
    const months = Math.max(1, Math.floor(Number(pf.months)) || 1);
    if (!pf.concept.trim()) { setPfErr("Poné un concepto (ej: Cuota moto)."); return; }
    if (!amount || Number.isNaN(amount) || amount <= 0) { setPfErr("Monto inválido. Es el monto POR MES (punto = miles, ej: 100.000)."); return; }
    await insertCashflowPlan(db(), { type: pf.type, concept: pf.concept.trim(), amount, startMonth: pf.start, monthsCount: months });
    setPf((p) => ({ ...p, concept: "", amount: "", months: "1" }));
    await reloadPlans();
  };
  const removePlan = async (id: number) => { await deleteCashflowPlan(db(), id); await reloadPlans(); };

  if (loading || !proj || !metrics) return (<><PageHeader title="Cash Flow" subtitle="Cargando…" /><div className="panel mt-6 p-10 text-center text-sm text-muted">Calculando…</div></>);

  const endBalance = proj.acum[proj.acum.length - 1];
  const avgNeto = proj.neto.reduce((s, n) => s + n, 0) / proj.neto.length;
  const totIng = proj.totalInc.reduce((s, n) => s + n, 0);
  const totEgr = proj.totalEgr.reduce((s, n) => s + n, 0);

  return (
    <>
      <PageHeader title="Cash Flow" subtitle={mode === "proyeccion" ? `Mes actual real + proyección · ${monthName(proj.months[0])} → ${monthName(proj.months[5])}` : `Histórico real · ${monthName(proj.months[0])} → ${monthName(proj.months[5])}`}>
        <div className="flex items-center gap-2 rounded-full border border-line bg-white/[0.06] px-3 py-1.5 text-xs">
          <span className="text-faint">Cotización</span>
          <span className="text-muted">USD</span>
          <input value={usdRate} onChange={(e) => setUsdRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
          <span className="text-muted">USDT</span>
          <input value={usdtRate} onChange={(e) => setUsdtRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
        </div>
      </PageHeader>

      {/* Toggle modo + navegación histórico */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-line bg-white/[0.06] p-0.5 text-sm">
            <button onClick={() => setMode("proyeccion")} className={`rounded-full px-4 py-1.5 transition-colors ${mode === "proyeccion" ? "bg-accent/15 text-accent" : "text-muted hover:text-fg"}`}>Proyección</button>
            <button onClick={() => setMode("historico")} className={`rounded-full px-4 py-1.5 transition-colors ${mode === "historico" ? "bg-accent/15 text-accent" : "text-muted hover:text-fg"}`}>Histórico</button>
          </div>
          <div className="flex rounded-full border border-line bg-white/[0.06] p-0.5 text-sm">
            <button onClick={() => setBasis("caja")} title="Cuándo se mueve la plata (la tarjeta cuenta el mes que pagás el resumen)" className={`rounded-full px-4 py-1.5 transition-colors ${basis === "caja" ? "bg-white/[0.09] text-fg" : "text-muted hover:text-fg"}`}>Caja</button>
            <button onClick={() => setBasis("devengado")} title="Cuánto consumiste (la tarjeta cuenta por fecha de compra)" className={`rounded-full px-4 py-1.5 transition-colors ${basis === "devengado" ? "bg-white/[0.09] text-fg" : "text-muted hover:text-fg"}`}>Devengado</button>
          </div>
        </div>
        {mode === "historico" && (
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => setHistStart(addMonths(histStart, -1))} className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white/[0.06] text-muted hover:text-fg">◀</button>
            <span className="tnum text-muted">{monthName(proj.months[0])} – {monthName(proj.months[5])}</span>
            <button onClick={() => setHistStart((s) => (monthsBetween(s, CUR) > HORIZON - 1 ? addMonths(s, 1) : s))} className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-white/[0.06] text-muted hover:text-fg">▶</button>
          </div>
        )}
      </div>

      {/* KPIs */}
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {mode === "proyeccion" ? (
          <>
            <KpiBox label="Saldo hoy" value={compact(proj.startBalance)} hint="líquido en ARS" icon={<Chart className="h-4 w-4 text-sky" />} />
            <KpiBox label={`Saldo en ${HORIZON}m`} value={compact(endBalance)} hint={`${endBalance - proj.startBalance >= 0 ? "+" : ""}${compact(endBalance - proj.startBalance)} proyectado`} tone={endBalance >= proj.startBalance ? "emerald" : "coral"} icon={endBalance - proj.startBalance >= 0 ? <ArrowUpRight className="h-4 w-4 text-emerald" /> : <ArrowDownRight className="h-4 w-4 text-coral" />} />
            <KpiBox label="Ahorro mensual prom." value={compact(avgNeto)} hint="ingresos − egresos" tone={avgNeto >= 0 ? "emerald" : "coral"} />
            <KpiBox label="Inflación proyectada" value={`${inflation.toFixed(1)}%`} hint={`oficial · prom. 6m (${infl.latest ? monthName(infl.latest) : "—"})`} tone="amber" />
          </>
        ) : (
          <>
            <KpiBox label="Ingresos (rango)" value={compact(totIng)} tone="emerald" />
            <KpiBox label="Egresos (rango)" value={compact(totEgr)} tone="coral" />
            <KpiBox label="Ahorro (rango)" value={compact(totIng - totEgr)} hint="ingresos − egresos" tone={totIng - totEgr >= 0 ? "emerald" : "coral"} />
            <KpiBox label="Ahorro mensual prom." value={compact(avgNeto)} tone={avgNeto >= 0 ? "emerald" : "coral"} />
          </>
        )}
      </div>

      {/* Supuestos (solo en proyección) */}
      {mode === "proyeccion" && (
        <section className="panel mt-5 overflow-hidden">
          <button onClick={() => setShowAssumptions((s) => !s)} className="flex w-full items-center justify-between px-5 py-3.5 text-left">
            <span className="flex items-center gap-2 font-display text-base text-fg"><Pencil className="h-4 w-4 text-accent" /> Supuestos de la proyección</span>
            <span className="text-xs text-faint">{showAssumptions ? "ocultar ▲" : "editar ▼"}</span>
          </button>
          {showAssumptions && (
            <div className="border-t border-line p-5">
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <label className="text-sm text-muted">Inflación mensual proyectada</label>
                <div className="flex items-center gap-1 rounded-lg border border-line bg-white/[0.06] px-3 py-1.5">
                  <input type="number" value={inflation} onChange={(e) => setInflation(Number(e.target.value) || 0)} className="tnum w-14 bg-transparent text-right text-fg outline-none" step="0.1" />
                  <span className="text-muted">%</span>
                </div>
                <button onClick={() => setInflation(Number(infl.projected.toFixed(2)))} className="rounded-full border border-line bg-white/[0.06] px-2.5 py-1 text-[0.7rem] text-muted hover:text-fg">↺ oficial ({infl.projected.toFixed(1)}%)</button>
                <span className="text-xs text-faint">se aplica a los gastos variables y a los ingresos marcados con 📈 (las cuotas nunca)</span>
              </div>

              <p className="mb-2 text-[0.7rem] uppercase tracking-wider text-faint">Ingresos recurrentes proyectados</p>
              {recurring.filter((r) => r.type === "ingreso").length === 0 ? (
                <p className="mb-5 text-xs text-faint">No hay ingresos recurrentes cargados todavía.</p>
              ) : (
                <div className="mb-5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {recurring.filter((r) => r.type === "ingreso").map((r) => {
                    const conInfl = inflIncome[r.category] ?? (r.category === "Sueldo");
                    return (
                      <div key={r.id} className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-3 py-2">
                        <span className="truncate text-sm text-muted">{r.emoji} {r.name}</span>
                        <NumInput value={Math.round(r.baseAmount)} onChange={(v) => onIncomeAmount(r.id, v)} onCommit={(v) => saveIncomeAmount(r.id, v)} className="ml-auto text-fg" />
                        <button onClick={() => toggleInfl(r.category, r.category === "Sueldo")} title={conInfl ? "Se ajusta por inflación · tocá para dejarlo fijo" : "Monto fijo · tocá para ajustarlo por inflación"} className={`shrink-0 rounded-full border px-2 py-1 text-[0.65rem] transition-colors ${conInfl ? "border-amber/40 bg-amber/10 text-amber" : "border-line bg-white/[0.06] text-faint hover:text-fg"}`}>
                          {conInfl ? "📈 infl" : "fijo"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="mb-2 text-[0.7rem] uppercase tracking-wider text-faint">Presupuesto mensual por categoría (gasto variable)</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {[...proj.budgetByCat.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([cat, v]) => {
                  const overridden = budgets[cat] != null;
                  return (
                    <div key={cat} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${overridden ? "border-accent/30 bg-accent/5" : "border-line bg-white/[0.04]"}`}>
                      <span className="truncate text-sm text-muted">{proj.seed.get(cat)?.emoji ?? "💸"} {cat}</span>
                      <NumInput value={Math.round(v)} onChange={(val) => onBudget(cat, val)} onCommit={(val) => saveBudget(cat, val)} className="ml-auto text-fg" />
                      {overridden && <button onClick={() => resetBudget(cat)} title="Volver al promedio" className="text-faint hover:text-coral">↺</button>}
                    </div>
                  );
                })}
              </div>

              <p className="mb-2 mt-5 text-[0.7rem] uppercase tracking-wider text-faint">Planificar (movimientos futuros · puntuales o en cuotas)</p>
              {manualPlans.length > 0 && (
                <div className="mb-3 flex flex-col gap-1.5">
                  {manualPlans.map((pl) => (
                    <div key={pl.id} className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-3 py-1.5 text-sm">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] ${pl.type === "ingreso" ? "bg-emerald/10 text-emerald" : "bg-coral/10 text-coral"}`}>{pl.type}</span>
                      <span className="truncate text-muted">📌 {pl.concept}</span>
                      <span className="tnum ml-auto text-fg">{compact(pl.amount)}</span>
                      <span className="shrink-0 text-xs text-faint">{monthName(pl.startMonth)}{pl.monthsCount > 1 ? ` · ${pl.monthsCount}x` : ""}</span>
                      <button onClick={() => removePlan(pl.id)} title="Borrar" className="shrink-0 text-faint hover:text-coral">✕</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex rounded-lg border border-line bg-white/[0.06] p-0.5 text-xs">
                  <button onClick={() => setPf((p) => ({ ...p, type: "egreso" }))} className={`rounded px-2.5 py-1 ${pf.type === "egreso" ? "bg-coral/15 text-coral" : "text-muted"}`}>Egreso</button>
                  <button onClick={() => setPf((p) => ({ ...p, type: "ingreso" }))} className={`rounded px-2.5 py-1 ${pf.type === "ingreso" ? "bg-emerald/15 text-emerald" : "text-muted"}`}>Ingreso</button>
                </div>
                <input value={pf.concept} onChange={(e) => setPf((p) => ({ ...p, concept: e.target.value }))} placeholder="Concepto (ej. Cuota moto)" className="min-w-[8rem] flex-1 rounded-lg border border-line bg-white/[0.06] px-3 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40" />
                <input value={pf.amount} onChange={(e) => setPf((p) => ({ ...p, amount: e.target.value }))} inputMode="numeric" placeholder="$ por mes" title="Monto de cada mes (si son cuotas, el valor de la cuota)" className="tnum w-24 rounded-lg border border-line bg-white/[0.06] px-3 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40" />
                <select value={pf.start} onChange={(e) => setPf((p) => ({ ...p, start: e.target.value }))} className="rounded-lg border border-line bg-white/[0.06] px-2 py-1.5 text-sm text-fg outline-none">
                  {proj.months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
                </select>
                <div className="flex items-center gap-1">
                  <input value={pf.months} onChange={(e) => setPf((p) => ({ ...p, months: e.target.value }))} inputMode="numeric" title="1 = puntual · N = cuotas" className="tnum w-12 rounded-lg border border-line bg-white/[0.06] px-2 py-1.5 text-center text-sm text-fg outline-none" />
                  <span className="text-xs text-faint">meses</span>
                </div>
                <button onClick={addPlan} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-transform hover:scale-[1.03]">Agregar</button>
              </div>
              {pfErr && <p className="mt-2 rounded-lg border border-coral/30 bg-coral/10 px-3 py-1.5 text-xs text-coral">{pfErr}</p>}
            </div>
          )}
        </section>
      )}

      {/* Tabla */}
      <section className="panel mt-5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="cf-sticky px-4 py-3 text-left font-medium text-muted">Flujo de Caja</th>
                {proj.months.map((m, i) => (
                  <th key={m} className={`px-3 py-3 text-right font-medium ${proj.isFuture[i] ? "text-muted" : "text-fg"}`}>
                    {monthName(m)}<span className="block text-[0.6rem] font-normal text-faint">{proj.isFuture[i] ? "proyectado" : m === CUR ? "en curso" : "real"}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SectionRow label="Ingresos" />
              {proj.incomeRows.map((r) => <DataRow key={r.label} row={r} />)}
              <TotalRow label="Total Ingresos" values={proj.totalInc} tone="inc" />

              <SectionRow label="Egresos" />
              {proj.egresoRows.map((r) => <DataRow key={r.label} row={r} />)}
              <TotalRow label="Total Egresos" values={proj.totalEgr} tone="exp" />

              <tr className="border-t-2 border-line">
                <td className="cf-sticky px-4 py-3 font-display text-fg">Neto del mes</td>
                {proj.neto.map((n, i) => <td key={i} className={`tnum px-3 py-3 text-right font-medium ${n >= 0 ? "text-emerald" : "text-coral"}`}>{compact(n)}</td>)}
              </tr>
              {mode === "proyeccion" && (
                <tr className="border-t border-line">
                  <td className="cf-sticky px-4 py-3 font-display text-sky">Pesos líquidos</td>
                  {proj.pesosAcum.map((n, i) => <td key={i} className={`tnum px-3 py-3 text-right font-semibold ${n >= 0 ? "text-sky" : "text-coral"}`}>{compact(n)}</td>)}
                </tr>
              )}
              <tr className="border-t border-line">
                <td className="cf-sticky px-4 py-3 font-display text-accent">{mode === "proyeccion" ? "Patrimonio neto acumulado" : "Neto Acumulado"}</td>
                {proj.acum.map((n, i) => <td key={i} className={`tnum px-3 py-3 text-right font-semibold ${n >= 0 ? "text-accent" : "text-coral"}`}>{compact(n)}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-4 text-xs text-faint">
        <span className="mr-1 rounded bg-white/[0.09] px-1.5 py-0.5 text-fg">{basis === "caja" ? "Base caja" : "Base devengado"}</span>
        {basis === "caja"
          ? "muestra cuándo se mueve la plata: efectivo/débito por fecha, y la tarjeta como el pago del resumen el mes que vence (los consumos de junio impactan en julio). 'Pesos líquidos' = tu saldo en $ al cierre de cada mes. "
          : "muestra cuánto consumiste cada mes: la tarjeta cuenta por fecha de compra (los consumos de junio impactan en junio). Útil para ver comportamiento de gasto. "}
        {mode === "proyeccion" ? (
          <>Los meses futuros son <b>proyección</b> (recurrentes con inflación {inflation.toFixed(1)}% en los marcados 📈; presupuesto mediana de {proj.completedCount} meses; los resúmenes futuros en base caja se estiman con el consumo del mes anterior + cuotas).</>
        ) : (
          <><b className="text-muted">Histórico real:</b> ingresos y egresos efectivos de cada mes por categoría (consumos + cuotas). Usá ◀ ▶ para mover el rango. El "Neto Acumulado" suma el neto del rango.</>
        )}
      </p>
    </>
  );
}

function NumInput({ value, onChange, onCommit, className = "" }: { value: number; onChange: (v: number) => void; onCommit: (v: number) => void; className?: string }) {
  return (
    <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} onBlur={(e) => onCommit(Number(e.target.value) || 0)} className={`tnum w-24 rounded-md border border-line bg-white/[0.05] px-2 py-1 text-right text-sm outline-none focus:border-accent/50 ${className}`} inputMode="decimal" />
  );
}

function KpiBox({ label, value, hint, tone, icon }: { label: string; value: string; hint?: string; tone?: "emerald" | "coral" | "amber"; icon?: React.ReactNode }) {
  const c = tone === "emerald" ? "text-emerald" : tone === "coral" ? "text-coral" : tone === "amber" ? "text-amber" : "text-fg";
  return (
    <div className="panel p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted">{icon}{label}</p>
      <p className={`tnum mt-1 text-[21px] font-semibold ${c}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-[0.7rem] text-faint">{hint}</p>}
    </div>
  );
}

function SectionRow({ label }: { label: string }) {
  return (<tr className="border-t border-line"><td colSpan={HORIZON + 1} className="cf-sticky px-4 pb-1 pt-3 text-[0.7rem] uppercase tracking-wider text-faint">{label}</td></tr>);
}
function DataRow({ row }: { row: Row }) {
  return (
    <tr className="border-b border-line/40">
      <td className="cf-sticky px-4 py-2 text-muted">{row.emoji} {row.label}</td>
      {row.values.map((v, i) => (<td key={i} className="tnum px-3 py-2 text-right text-fg/90">{v > 0 ? compact(v) : "—"}</td>))}
    </tr>
  );
}
function TotalRow({ label, values, tone }: { label: string; values: number[]; tone: "inc" | "exp" }) {
  const c = tone === "inc" ? "text-emerald" : "text-coral";
  return (
    <tr className="border-b border-line">
      <td className="cf-sticky px-4 py-2.5 font-medium text-fg">{label}</td>
      {values.map((v, i) => <td key={i} className={`tnum px-3 py-2.5 text-right font-medium ${c}`}>{compact(v)}</td>)}
    </tr>
  );
}
