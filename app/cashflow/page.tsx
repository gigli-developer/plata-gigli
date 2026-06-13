"use client";

import { useEffect, useMemo, useState } from "react";
import {
  db, fetchMetrics, fetchRecurring, fetchPlansForProjection, fetchMonthlyBreakdown,
  fetchCashflowBudgets, upsertCashflowBudget, deleteCashflowBudget, fetchInflationData,
  type Metrics, type RecurringView, type PlanProj, type MonthAgg,
} from "@/lib/db";
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

  useEffect(() => {
    const sb = db();
    Promise.all([fetchMetrics(sb), fetchRecurring(sb), fetchPlansForProjection(sb), fetchMonthlyBreakdown(sb, 14), fetchCashflowBudgets(sb), fetchInflationData(sb)])
      .then(([m, r, p, b, bg, inf]) => { setMetrics(m); setRecurring(r); setPlans(p); setBreakdown(b); setBudgets(bg); setInfl({ projected: inf.projected, latest: inf.latest }); setInflation(Number(inf.projected.toFixed(2))); setUsdRate(m.usd_ars); setUsdtRate(m.usdt_ars); })
      .finally(() => setLoading(false));
  }, []);

  const proj = useMemo(() => {
    if (!metrics) return null;
    const toArs = (v: number, cur: string) => (cur === "USD" ? v * usdRate : cur === "USDT" ? v * usdtRate : v);
    const months = Array.from({ length: HORIZON }, (_, i) => addMonths(mode === "proyeccion" ? CUR : histStart, i));

    // --- presupuesto variable por categoría (mediana de meses completados + override) ---
    const completed = [...new Set(breakdown.map((b) => b.month).filter((m) => m < CUR))].sort().slice(-3);
    const egrMonths = new Set(breakdown.filter((b) => b.type === "egreso" && completed.includes(b.month)).map((b) => b.month));
    const nEgr = Math.max(egrMonths.size, 1);
    const seed = new Map<string, { v: number; emoji: string }>();
    for (const b of breakdown) { if (b.type !== "egreso" || !completed.includes(b.month) || !NOFLOW(b.category)) continue; const e = seed.get(b.category) ?? { v: 0, emoji: b.emoji }; e.v += toArs(b.total, b.currency); seed.set(b.category, e); }
    const budgetByCat = new Map<string, number>();
    for (const [cat, e] of seed) budgetByCat.set(cat, e.v / nEgr);
    for (const [cat, v] of Object.entries(budgets)) budgetByCat.set(cat, v);

    // emoji por categoría
    const emojiOf = new Map<string, string>();
    for (const b of breakdown) if (!emojiOf.has(b.category)) emojiOf.set(b.category, b.emoji);
    for (const p of plans) if (!emojiOf.has(p.category)) emojiOf.set(p.category, p.emoji);
    for (const r of recurring) if (!emojiOf.has(r.category)) emojiOf.set(r.category, r.emoji);

    // --- ingresos/egresos por categoría para cada mes (real si pasado/actual, proyectado si futuro) ---
    const incPer: Map<string, number>[] = [];
    const egrPer: Map<string, number>[] = [];
    months.forEach((mm) => {
      const future = mm > CUR;
      const f = Math.pow(1 + inflation / 100, Math.max(monthsBetween(CUR, mm), 0));
      const inc = new Map<string, number>();
      const egr = new Map<string, number>();
      if (future) {
        // ingresos: recurrentes (inflación SOLO al sueldo)
        for (const r of recurring.filter((x) => x.type === "ingreso")) inc.set(r.category, (inc.get(r.category) ?? 0) + (r.category === "Sueldo" ? r.baseAmount * f : r.baseAmount));
        // egresos: cuotas (sin inflación) + presupuesto variable (con inflación)
        for (const p of plans) { const k = monthsBetween(p.firstMonth, mm); if (k >= 0 && k < p.total) egr.set(p.category, (egr.get(p.category) ?? 0) + p.monthly); }
        for (const [cat, v] of budgetByCat) egr.set(cat, (egr.get(cat) ?? 0) + v * f);
      } else {
        // REAL: del breakdown (transacciones) + cuotas que cayeron ese mes
        for (const b of breakdown) {
          if (b.month !== mm || !NOFLOW(b.category)) continue;
          if (b.type === "ingreso") inc.set(b.category, (inc.get(b.category) ?? 0) + toArs(b.total, b.currency));
          else egr.set(b.category, (egr.get(b.category) ?? 0) + toArs(b.total, b.currency));
        }
        for (const p of plans) { const k = monthsBetween(p.firstMonth, mm); if (k >= 0 && k < p.total) egr.set(p.category, (egr.get(p.category) ?? 0) + p.monthly); }
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
    const acum = neto.map((n) => (acc += n));
    const isFuture = months.map((mm) => mm > CUR);

    return { months, incomeRows, egresoRows, totalInc, totalEgr, neto, acum, startBalance, isFuture, budgetByCat, seed, completedCount: completed.length };
  }, [metrics, recurring, plans, breakdown, budgets, inflation, mode, histStart, usdRate, usdtRate]);

  const sb = db();
  const onBudget = (cat: string, val: number) => setBudgets((p) => ({ ...p, [cat]: val }));
  const saveBudget = (cat: string, val: number) => { upsertCashflowBudget(sb, cat, val).catch(console.error); };
  const resetBudget = (cat: string) => { setBudgets((p) => { const n = { ...p }; delete n[cat]; return n; }); deleteCashflowBudget(sb, cat).catch(console.error); };

  if (loading || !proj || !metrics) return (<><PageHeader title="Cash Flow" subtitle="Cargando…" /><div className="panel mt-6 p-10 text-center text-sm text-muted">Calculando…</div></>);

  const endBalance = proj.acum[proj.acum.length - 1];
  const avgNeto = proj.neto.reduce((s, n) => s + n, 0) / proj.neto.length;
  const totIng = proj.totalInc.reduce((s, n) => s + n, 0);
  const totEgr = proj.totalEgr.reduce((s, n) => s + n, 0);

  return (
    <>
      <PageHeader title="Cash Flow" subtitle={mode === "proyeccion" ? `Mes actual real + proyección · ${monthName(proj.months[0])} → ${monthName(proj.months[5])}` : `Histórico real · ${monthName(proj.months[0])} → ${monthName(proj.months[5])}`}>
        <div className="flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs">
          <span className="text-faint">Cotización</span>
          <span className="text-muted">USD</span>
          <input value={usdRate} onChange={(e) => setUsdRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
          <span className="text-muted">USDT</span>
          <input value={usdtRate} onChange={(e) => setUsdtRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
        </div>
      </PageHeader>

      {/* Toggle modo + navegación histórico */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-full border border-line bg-surface-2 p-0.5 text-sm">
          <button onClick={() => setMode("proyeccion")} className={`rounded-full px-4 py-1.5 transition-colors ${mode === "proyeccion" ? "bg-lime/15 text-lime" : "text-muted hover:text-fg"}`}>Proyección</button>
          <button onClick={() => setMode("historico")} className={`rounded-full px-4 py-1.5 transition-colors ${mode === "historico" ? "bg-lime/15 text-lime" : "text-muted hover:text-fg"}`}>Histórico</button>
        </div>
        {mode === "historico" && (
          <div className="flex items-center gap-2 text-sm">
            <button onClick={() => setHistStart(addMonths(histStart, -1))} className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface-2 text-muted hover:text-fg">◀</button>
            <span className="tnum text-muted">{monthName(proj.months[0])} – {monthName(proj.months[5])}</span>
            <button onClick={() => setHistStart((s) => (monthsBetween(s, CUR) > HORIZON - 1 ? addMonths(s, 1) : s))} className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface-2 text-muted hover:text-fg">▶</button>
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
            <span className="flex items-center gap-2 font-display text-base text-fg"><Pencil className="h-4 w-4 text-lime" /> Supuestos de la proyección</span>
            <span className="text-xs text-faint">{showAssumptions ? "ocultar ▲" : "editar ▼"}</span>
          </button>
          {showAssumptions && (
            <div className="border-t border-line p-5">
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <label className="text-sm text-muted">Inflación mensual proyectada</label>
                <div className="flex items-center gap-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5">
                  <input type="number" value={inflation} onChange={(e) => setInflation(Number(e.target.value) || 0)} className="tnum w-14 bg-transparent text-right text-fg outline-none" step="0.1" />
                  <span className="text-muted">%</span>
                </div>
                <button onClick={() => setInflation(Number(infl.projected.toFixed(2)))} className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[0.7rem] text-muted hover:text-fg">↺ oficial ({infl.projected.toFixed(1)}%)</button>
                <span className="text-xs text-faint">se aplica al sueldo y a los gastos variables (no a las cuotas ni al alquiler)</span>
              </div>
              <p className="mb-2 text-[0.7rem] uppercase tracking-wider text-faint">Presupuesto mensual por categoría (gasto variable)</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {[...proj.budgetByCat.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([cat, v]) => {
                  const overridden = budgets[cat] != null;
                  return (
                    <div key={cat} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${overridden ? "border-lime/30 bg-lime/5" : "border-line bg-surface-2/40"}`}>
                      <span className="truncate text-sm text-muted">{proj.seed.get(cat)?.emoji ?? "💸"} {cat}</span>
                      <NumInput value={Math.round(v)} onChange={(val) => onBudget(cat, val)} onCommit={(val) => saveBudget(cat, val)} className="ml-auto text-fg" />
                      {overridden && <button onClick={() => resetBudget(cat)} title="Volver al promedio" className="text-faint hover:text-coral">↺</button>}
                    </div>
                  );
                })}
              </div>
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
                <th className="sticky left-0 z-10 bg-surface px-4 py-3 text-left font-medium text-muted">Flujo de Caja</th>
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

              <tr className="border-t-2 border-line bg-surface-2/40">
                <td className="sticky left-0 z-10 bg-surface-2/40 px-4 py-3 font-display text-fg">Saldo Neto</td>
                {proj.neto.map((n, i) => <td key={i} className={`tnum px-3 py-3 text-right font-medium ${n >= 0 ? "text-emerald" : "text-coral"}`}>{compact(n)}</td>)}
              </tr>
              <tr className="bg-lime/5">
                <td className="sticky left-0 z-10 bg-[#0d1410] px-4 py-3 font-display text-lime">{mode === "proyeccion" ? "Saldo Acumulado" : "Neto Acumulado"}</td>
                {proj.acum.map((n, i) => <td key={i} className={`tnum px-3 py-3 text-right font-semibold ${n >= 0 ? "text-lime" : "text-coral"}`}>{compact(n)}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-4 text-xs text-faint">
        {mode === "proyeccion" ? (
          <><b className="text-muted">Cómo se calcula:</b> el mes <b>en curso</b> muestra lo <b>real</b> que pasó (consumos + cuotas del mes). Los meses futuros son <b>proyección</b>: ingresos recurrentes (la inflación {inflation.toFixed(1)}% afecta solo al sueldo), cuotas reales (bajan al terminar) y presupuesto variable por categoría (mediana de {proj.completedCount} meses, ajustable, con inflación). Todo por categoría.</>
        ) : (
          <><b className="text-muted">Histórico real:</b> ingresos y egresos efectivos de cada mes por categoría (consumos + cuotas). Usá ◀ ▶ para mover el rango. El "Neto Acumulado" suma el neto del rango.</>
        )}
      </p>
    </>
  );
}

function NumInput({ value, onChange, onCommit, className = "" }: { value: number; onChange: (v: number) => void; onCommit: (v: number) => void; className?: string }) {
  return (
    <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} onBlur={(e) => onCommit(Number(e.target.value) || 0)} className={`tnum w-24 rounded-md border border-line bg-surface px-2 py-1 text-right text-sm outline-none focus:border-lime/50 ${className}`} inputMode="decimal" />
  );
}

function KpiBox({ label, value, hint, tone, icon }: { label: string; value: string; hint?: string; tone?: "emerald" | "coral" | "amber"; icon?: React.ReactNode }) {
  const c = tone === "emerald" ? "text-emerald" : tone === "coral" ? "text-coral" : tone === "amber" ? "text-amber" : "text-fg";
  return (
    <div className="panel p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted">{icon}{label}</p>
      <p className={`tnum mt-1 font-display text-2xl ${c}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-[0.7rem] text-faint">{hint}</p>}
    </div>
  );
}

function SectionRow({ label }: { label: string }) {
  return (<tr className="border-t border-line"><td colSpan={HORIZON + 1} className="sticky left-0 bg-surface px-4 pb-1 pt-3 text-[0.7rem] uppercase tracking-wider text-faint">{label}</td></tr>);
}
function DataRow({ row }: { row: Row }) {
  return (
    <tr className="border-b border-line/40 hover:bg-surface-2/30">
      <td className="sticky left-0 z-10 bg-surface px-4 py-2 text-muted">{row.emoji} {row.label}</td>
      {row.values.map((v, i) => (<td key={i} className="tnum px-3 py-2 text-right text-fg/90">{v > 0 ? compact(v) : "—"}</td>))}
    </tr>
  );
}
function TotalRow({ label, values, tone }: { label: string; values: number[]; tone: "inc" | "exp" }) {
  const c = tone === "inc" ? "text-emerald" : "text-coral";
  return (
    <tr className="border-b border-line bg-surface-2/30">
      <td className="sticky left-0 z-10 bg-[#13161d] px-4 py-2.5 font-medium text-fg">{label}</td>
      {values.map((v, i) => <td key={i} className={`tnum px-3 py-2.5 text-right font-medium ${c}`}>{compact(v)}</td>)}
    </tr>
  );
}
