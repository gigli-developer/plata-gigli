"use client";

import { useEffect, useMemo, useState } from "react";
import { db, fetchMetrics, fetchMonthlyBreakdown, fetchPlansForProjection, fetchNetWorthSeries, type Metrics, type MonthAgg, type PlanProj, type NetWorthPoint } from "@/lib/db";
import { aggArs } from "@/lib/fx";
import { readCache, writeCache } from "@/lib/cache";
import { ars, compact, compactUsd } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import { Coins } from "../icons";
import { Donut, BarList, GroupedColumns, VariationTable, NetWorthChart, type Slice, type MonthCol, type VarRow, type NetWorthCol } from "../components/charts";

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const monthLabel = (ym: string) => { const [y, m] = (ym || "").split("-").map(Number); return m ? `${MESES[m - 1]} ${y}` : ym; };
const monthsBetweenYM = (a: string, b: string) => { const [ay, am] = a.slice(0, 7).split("-").map(Number); const [by, bm] = b.slice(0, 7).split("-").map(Number); return (by - ay) * 12 + (bm - am); };
const addMonthYM = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const NOW_MONTH = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();

export default function MetricasPage() {
  const [m, setM] = useState<Metrics | null>(null);
  const [breakdown, setBreakdown] = useState<MonthAgg[]>([]);
  const [loading, setLoading] = useState(true);
  const [usdRate, setUsdRate] = useState(0);
  const [usdtRate, setUsdtRate] = useState(0);
  const [plans, setPlans] = useState<PlanProj[]>([]);
  const [netWorth, setNetWorth] = useState<NetWorthPoint[]>([]);
  const [nwLoading, setNwLoading] = useState(true);
  // Unidad del gráfico de patrimonio. En pesos la serie exagera el crecimiento
  // (parte es devaluación); en dólares se ve cuánto creciste de verdad.
  const [nwCur, setNwCur] = useState<"ars" | "usd">("ars");
  const [monthFilter, setMonthFilter] = useState<string>(NOW_MONTH);
  const [cmpA, setCmpA] = useState<string>(addMonthYM(NOW_MONTH, -1));
  const [cmpB, setCmpB] = useState<string>(NOW_MONTH);
  const cmpOptions = useMemo(() => Array.from({ length: 8 }, (_, i) => addMonthYM(NOW_MONTH, -i)), []);

  useEffect(() => {
    // Pintar al instante el último snapshot; lo fresco llega por atrás.
    const s = readCache<{ m: Metrics; b: MonthAgg[]; p: PlanProj[]; nw?: NetWorthPoint[] }>("metricas");
    if (s) { setM(s.m); setBreakdown(s.b); setPlans(s.p); setNetWorth(s.nw ?? []); setUsdRate(s.m.usd_ars); setUsdtRate(s.m.usdt_ars); setLoading(false); if (s.nw?.length) setNwLoading(false); }
    const sb = db();
    Promise.all([fetchMetrics(sb), fetchMonthlyBreakdown(sb, 6), fetchPlansForProjection(sb), fetchNetWorthSeries(sb, 12)])
      .then(([d, b, p, nwSerie]) => { setM(d); setBreakdown(b); setPlans(p); setNetWorth(nwSerie); setUsdRate(d.usd_ars); setUsdtRate(d.usdt_ars); writeCache("metricas", { m: d, b, p, nw: nwSerie }); })
      .finally(() => { setLoading(false); setNwLoading(false); });
  }, []);

  const calc = useMemo(() => {
    if (!m) return null;
    const usdArs = m.usd_liquido * usdRate;
    const usdtArs = m.usdt_liquido * usdtRate;
    const activos = m.ars_liquido + usdArs + usdtArs + m.te_deben;
    const pasivos = m.deuda_cuotas_ars + m.deuda_vencida_ars + m.debes;
    const patrimonio = activos - pasivos;
    return {
      usdArs, usdtArs, activos, pasivos, patrimonio,
      patrimonioUsd: usdRate ? patrimonio / usdRate : 0,
    };
  }, [m, usdRate, usdtRate]);

  // Ratios del mes elegido en Análisis (o "todos"): mismo criterio que los gráficos (transacciones + cuotas).
  const flows = useMemo(() => {
    // Los movimientos en USD/USDT se valúan con la cotización CONGELADA de su día
    // (viene ya sumada en el agregado); la cotización editable de arriba solo entra
    // si alguna fila no tuviera rate congelado.
    const valuar = (b: MonthAgg) => aggArs(b, { usd: usdRate, usdt: usdtRate, day: null });
    const scopeMonths = monthFilter === "all" ? [...new Set(breakdown.map((b) => b.month))] : [monthFilter];
    const scope = new Set(scopeMonths);
    let ing = 0, egr = 0;
    for (const b of breakdown) {
      if (!scope.has(b.month)) continue;
      const v = valuar(b);
      if (b.type === "ingreso") ing += v; else egr += v;
    }
    let cuotas = 0;
    for (const p of plans) for (const mm of scopeMonths) {
      const k = monthsBetweenYM(p.firstMonth, mm);
      if (k >= 0 && k < p.total) cuotas += p.monthly;
    }
    egr += cuotas;
    const ahorro = ing - egr;
    const nMonths = Math.max(scopeMonths.length, 1);
    return {
      dti: ing ? cuotas / ing : 0,
      tasaAhorro: ing ? ahorro / ing : 0,
      flujo: egr ? ing / egr : 0,
      ahorroMostrar: monthFilter === "all" ? ahorro / nMonths : ahorro,
    };
  }, [breakdown, plans, monthFilter, usdRate, usdtRate]);

  const months = useMemo(() => [...new Set(breakdown.map((b) => b.month))].sort().reverse(), [breakdown]);

  // Serie de patrimonio + descomposición del último mes: cuánto subió por ahorro y
  // cuánto solo porque se movió el tipo de cambio.
  //
  // En PESOS el efecto cambiario es la revaluación de las tenencias en moneda dura.
  // En DÓLARES es el espejo: lo que perdés (o ganás) por tener PESOS mientras el
  // dólar se mueve. En ambos casos se mide sobre el stock con el que arrancó el mes
  // (convención estándar) y el resto queda como flujo real.
  const nw = useMemo(() => {
    const enUsd = nwCur === "usd";
    // Todo se divide por el dólar DE CADA CORTE: así cada mes queda medido con la
    // vara de su momento, que es el sentido de mirar la serie en dólares.
    const v = (monto: number, p: NetWorthPoint) => (enUsd ? (p.usdArs ? monto / p.usdArs : 0) : monto);
    const cols: NetWorthCol[] = netWorth.map((p) => ({
      label: monthLabel(p.month).slice(0, 3) + " " + p.month.slice(2, 4),
      ars: Math.max(v(p.ars, p), 0),
      usdArs: Math.max(v(p.usd * p.usdArs, p), 0),
      usdtArs: Math.max(v(p.usdt * p.usdtArs, p), 0),
      teDeben: v(p.teDeben, p),
      pasivos: v(p.pasivos, p),
      patrimonio: v(p.patrimonio, p),
    }));
    let delta: { label: string; total: number; fx: number; ahorro: number } | null = null;
    if (netWorth.length >= 2) {
      const cur = netWorth[netWorth.length - 1], pre = netWorth[netWorth.length - 2];
      const total = v(cur.patrimonio, cur) - v(pre.patrimonio, pre);
      const fx = enUsd
        // efecto de haber estado en pesos: los pesos del mes anterior valen menos dólares
        ? (cur.usdArs && pre.usdArs ? pre.ars * (1 / cur.usdArs - 1 / pre.usdArs) : 0)
        : pre.usd * (cur.usdArs - pre.usdArs) + pre.usdt * (cur.usdtArs - pre.usdtArs);
      delta = { label: monthLabel(cur.month), total, fx, ahorro: total - fx };
    }
    return { cols, delta };
  }, [netWorth, nwCur]);

  const charts = useMemo(() => {
    const valuar = (b: MonthAgg) => aggArs(b, { usd: usdRate, usdt: usdtRate, day: null });
    const filtered = monthFilter === "all" ? breakdown : breakdown.filter((b) => b.month === monthFilter);

    const cap8 = (arr: Slice[]): Slice[] => { if (arr.length <= 8) return arr; const top = arr.slice(0, 7); const rest = arr.slice(7).reduce((s, x) => s + x.value, 0); top.push({ label: "Resto", value: rest, emoji: undefined }); return top; };

    // serie temporal (siempre todos los meses)
    const tmap = new Map<string, MonthCol>();
    for (const b of breakdown) {
      const c = tmap.get(b.month) ?? { label: monthLabel(b.month).slice(0, 3) + " " + b.month.slice(2, 4), ingreso: 0, egreso: 0 };
      if (b.type === "ingreso") c.ingreso += valuar(b); else c.egreso += valuar(b);
      tmap.set(b.month, c);
    }
    const series = [...tmap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);

    // gastos por categoría = consumos (transacciones) + CUOTAS del/los mes(es) en alcance
    const scopeMonths = monthFilter === "all" ? [...new Set(breakdown.map((b) => b.month))] : [monthFilter];
    const catMap = new Map<string, { v: number; emoji?: string }>();
    for (const b of filtered) { if (b.type !== "egreso") continue; const e = catMap.get(b.category) ?? { v: 0, emoji: b.emoji }; e.v += valuar(b); catMap.set(b.category, e); }
    let cuotasTotal = 0;
    for (const p of plans) for (const mm of scopeMonths) { const k = monthsBetweenYM(p.firstMonth, mm); if (k >= 0 && k < p.total) { const e = catMap.get(p.category) ?? { v: 0, emoji: p.emoji }; e.v += p.monthly; catMap.set(p.category, e); cuotasTotal += p.monthly; } }
    const gastosCat = cap8([...catMap.entries()].map(([label, e]) => ({ label, value: e.v, emoji: e.emoji })).sort((a, b) => b.value - a.value));

    // gastos por método = consumos + cuotas (las cuotas se pagan con Tarjeta de Crédito)
    const methMap = new Map<string, number>();
    for (const b of filtered) { if (b.type !== "egreso") continue; methMap.set(b.method, (methMap.get(b.method) ?? 0) + valuar(b)); }
    if (cuotasTotal > 0) methMap.set("Tarjeta de Crédito", (methMap.get("Tarjeta de Crédito") ?? 0) + cuotasTotal);
    const gastosMetodo = cap8([...methMap.entries()].map(([label, value]) => ({ label, value, emoji: undefined })).sort((a, b) => b.value - a.value));

    // variación por categoría: mes seleccionado vs mes anterior (consumos + cuotas)
    const catTotals = (mm: string) => {
      const map = new Map<string, { v: number; emoji?: string }>();
      for (const b of breakdown) { if (b.type !== "egreso" || b.month !== mm) continue; const e = map.get(b.category) ?? { v: 0, emoji: b.emoji }; e.v += valuar(b); map.set(b.category, e); }
      for (const p of plans) { const k = monthsBetweenYM(p.firstMonth, mm); if (k >= 0 && k < p.total) { const e = map.get(p.category) ?? { v: 0, emoji: p.emoji }; e.v += p.monthly; map.set(p.category, e); } }
      return map;
    };
    const curTot = catTotals(cmpB), prevTot = catTotals(cmpA);
    // Estimado fin de mes para cmpB: proyecta los CONSUMOS por el ritmo del mes; las CUOTAS van enteras.
    const [by, bm] = cmpB.split("-").map(Number);
    const daysInMonth = new Date(by, bm, 0).getDate();
    const todayD = new Date();
    const isCurrentB = cmpB === NOW_MONTH;
    const elapsed = isCurrentB ? Math.max(todayD.getDate(), 1) : daysInMonth;
    const factor = daysInMonth / elapsed;
    const consB = new Map<string, number>();
    for (const b of breakdown) { if (b.type !== "egreso" || b.month !== cmpB) continue; consB.set(b.category, (consB.get(b.category) ?? 0) + valuar(b)); }
    const cuoB = new Map<string, number>();
    for (const p of plans) { const k = monthsBetweenYM(p.firstMonth, cmpB); if (k >= 0 && k < p.total) cuoB.set(p.category, (cuoB.get(p.category) ?? 0) + p.monthly); }

    const variacion: VarRow[] = [...new Set([...curTot.keys(), ...prevTot.keys()])].map((cat) => {
      const cur = curTot.get(cat)?.v ?? 0, prev = prevTot.get(cat)?.v ?? 0;
      const est = (consB.get(cat) ?? 0) * factor + (cuoB.get(cat) ?? 0);
      return { label: cat, emoji: curTot.get(cat)?.emoji ?? prevTot.get(cat)?.emoji, cur, prev, est, pct: prev > 0 ? (cur - prev) / prev : null };
    }).filter((v) => v.cur > 0 || v.prev > 0).sort((a, b) => Math.abs(b.cur - b.prev) - Math.abs(a.cur - a.prev));

    return { gastosCat, gastosMetodo, series, variacion, showEst: isCurrentB };
  }, [breakdown, monthFilter, plans, cmpA, cmpB, usdRate, usdtRate]);

  const nwFmt = nwCur === "usd" ? compactUsd : compact;

  if (loading || !m || !calc) return (<><PageHeader title="Métricas" subtitle="Cargando…" /><div className="panel mt-6 p-10 text-center text-sm text-muted">Calculando…</div></>);

  return (
    <>
      <PageHeader title="Métricas" subtitle={`Patrimonio, ratios y análisis · ref: ${monthLabel(m.ref_month)}`}>
        <div className="flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs">
          <span className="text-faint">Cotización</span>
          <span className="text-muted">USD</span>
          <input value={usdRate} onChange={(e) => setUsdRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
          <span className="text-muted">USDT</span>
          <input value={usdtRate} onChange={(e) => setUsdtRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
        </div>
      </PageHeader>

      {/* Banda compacta: patrimonio + saldos + ratios todo junto */}
      <section className="rise panel relative mt-6 overflow-hidden">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-lime/10 blur-3xl" />
        <div className="relative grid gap-px bg-line/60 lg:grid-cols-[1.4fr_2fr]">
          {/* Patrimonio */}
          <div className="bg-surface p-5">
            <p className="flex items-center gap-2 text-sm text-muted"><Coins className="h-4 w-4 text-lime" /> Patrimonio neto <span className="text-faint">· hoy</span></p>
            <p className={`mt-1 font-display text-3xl sm:text-4xl ${calc.patrimonio >= 0 ? "text-fg" : "text-coral"}`}><span className="tnum">{ars(calc.patrimonio)}</span></p>
            <p className="mt-1 text-xs text-faint">≈ US$ {calc.patrimonioUsd.toLocaleString("es-AR", { maximumFractionDigits: 0 })}</p>
            <div className="mt-3 flex gap-2 text-xs">
              <span className="rounded-lg border border-emerald/20 bg-emerald/8 px-2 py-1 text-emerald">Activos {compact(calc.activos)}</span>
              <span className="rounded-lg border border-coral/20 bg-coral/8 px-2 py-1 text-coral">Pasivos {compact(calc.pasivos)}</span>
            </div>
          </div>
          {/* Saldos por moneda */}
          <div className="grid grid-cols-3 gap-px bg-line/60">
            <Mini label="Pesos" tag="ARS" value={compact(m.ars_liquido)} />
            <Mini label="Dólares" tag="USD" value={`US$ ${m.usd_liquido.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`} sub={compact(calc.usdArs)} />
            <Mini label="Cripto" tag="USDT" value={`${m.usdt_liquido.toLocaleString("es-AR")}`} sub={compact(calc.usdtArs)} />
          </div>
        </div>
        {/* Ratios en línea — del mes elegido en Análisis (o todos) */}
        <div className="flex flex-wrap items-center gap-x-2 border-t border-line bg-surface/40 px-4 py-1.5 text-[0.7rem] text-faint">
          <span>Ratios de <span className="text-muted">{monthFilter === "all" ? "todos los meses" : monthLabel(monthFilter)}</span></span>
          <span className="ml-auto opacity-80">elegí el mes en Análisis ↓</span>
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-line bg-line/60 sm:grid-cols-4">
          <RatioMini title="Deuda / Ingresos" value={pct(flows.dti)} hint="< 36%" tone={flows.dti < 0.36 ? "emerald" : flows.dti < 0.43 ? "amber" : "coral"} />
          <RatioMini title="Tasa de ahorro" value={pct(flows.tasaAhorro)} hint="> 20%" tone={flows.tasaAhorro > 0.2 ? "emerald" : flows.tasaAhorro > 0.1 ? "amber" : "coral"} />
          <RatioMini title="Flujo de caja" value={`${flows.flujo.toFixed(2)}×`} hint="> 1" tone={flows.flujo > 1.2 ? "emerald" : flows.flujo >= 1 ? "amber" : "coral"} />
          <RatioMini title="Ahorro mensual" value={compact(flows.ahorroMostrar)} hint={monthFilter === "all" ? "prom. mensual" : monthLabel(monthFilter)} tone={flows.ahorroMostrar > 0 ? "emerald" : "coral"} />
        </div>
      </section>

      {/* Patrimonio neto en el tiempo */}
      <section className="rise panel mt-5 p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="font-display text-base text-fg">Patrimonio neto en el tiempo</h3>
            <p className="text-xs text-faint">
              Cierre de cada mes · {nwCur === "ars" ? "tenencias valuadas al dólar de esa fecha" : "todo medido al dólar de cada mes"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {nw.delta && (
              <div className="text-right text-xs">
                <p className={`tnum text-sm ${nw.delta.total >= 0 ? "text-emerald" : "text-coral"}`}>
                  {nw.delta.total >= 0 ? "+" : "−"}{nwFmt(Math.abs(nw.delta.total))} en {nw.delta.label}
                </p>
                <p className="text-faint">
                  <span className={nw.delta.ahorro >= 0 ? "text-emerald/80" : "text-coral/80"}>{nw.delta.ahorro >= 0 ? "+" : "−"}{nwFmt(Math.abs(nw.delta.ahorro))} tuyo</span>
                  {" · "}
                  <span className={nw.delta.fx >= 0 ? "text-amber/80" : "text-coral/80"}>{nw.delta.fx >= 0 ? "+" : "−"}{nwFmt(Math.abs(nw.delta.fx))} {nwCur === "ars" ? "por el dólar" : "por estar en pesos"}</span>
                </p>
              </div>
            )}
            <div className="flex rounded-full border border-line bg-surface-2 p-0.5 text-xs">
              <button onClick={() => setNwCur("ars")} className={`rounded-full px-2.5 py-1 transition-colors ${nwCur === "ars" ? "bg-lime/15 text-lime" : "text-muted hover:text-fg"}`}>$</button>
              <button onClick={() => setNwCur("usd")} className={`rounded-full px-2.5 py-1 transition-colors ${nwCur === "usd" ? "bg-lime/15 text-lime" : "text-muted hover:text-fg"}`}>US$</button>
            </div>
          </div>
        </div>
        {nwLoading && !nw.cols.length ? (
          <div className="grid h-48 place-items-center text-sm text-muted">Reconstruyendo la serie…</div>
        ) : (
          <NetWorthChart data={nw.cols} fmt={nwFmt} />
        )}
        <p className="mt-3 text-[0.7rem] text-faint">
          {nwCur === "ars"
            ? "En pesos, parte de la suba es devaluación: el efecto cambiario se calcula sobre las tenencias con las que arrancaste el mes y lo demás es flujo real (lo que ganaste, gastaste o pagaste de deuda). Pasá a US$ para ver cuánto creciste de verdad."
            : "Medido en dólares el crecimiento es real, sin el ruido de la devaluación. Acá el efecto cambiario es el espejo: lo que te costó (o te dio) tener pesos mientras el dólar se movía."}
        </p>
      </section>

      {/* Análisis con gráficos */}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg text-fg">Análisis</h2>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={monthFilter === "all"} onClick={() => setMonthFilter("all")}>Todos</FilterChip>
          {months.map((mo) => <FilterChip key={mo} active={monthFilter === mo} onClick={() => setMonthFilter(mo)}>{monthLabel(mo)}</FilterChip>)}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Gastos por categoría" sub={`${monthFilter === "all" ? "todos los meses" : monthLabel(monthFilter)} · incluye cuotas`}>
          <Donut data={charts.gastosCat} fmt={compact} />
        </ChartCard>
        <ChartCard title="Gastos por método de pago" sub={`${monthFilter === "all" ? "todos los meses" : monthLabel(monthFilter)} · incluye cuotas`}>
          <BarList data={charts.gastosMetodo} fmt={compact} />
        </ChartCard>
        <div className="panel p-5 lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-base text-fg">Variación por categoría</h3>
            <div className="flex items-center gap-2 text-xs">
              <CmpSelect value={cmpA} onChange={setCmpA} options={cmpOptions} />
              <span className="text-faint">vs</span>
              <CmpSelect value={cmpB} onChange={setCmpB} options={cmpOptions} />
            </div>
          </div>
          <VariationTable data={charts.variacion} fmt={compact} labelA={monthLabel(cmpA)} labelB={monthLabel(cmpB)} showEst={charts.showEst} />
        </div>
        <div className="lg:col-span-2">
          <ChartCard title="Ingresos vs Egresos" sub="mes a mes (ARS)">
            <GroupedColumns data={charts.series} fmt={compact} />
          </ChartCard>
        </div>
      </div>

      <p className="mt-6 text-xs text-faint">
        Los gráficos valúan USD/USDT en ARS con la cotización de arriba y excluyen los cambios de divisa. Las métricas mensuales usan <b>{monthLabel(m.ref_month)}</b> (último mes con ingresos).
      </p>
    </>
  );
}

function Mini({ label, tag, value, sub }: { label: string; tag: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface p-4">
      <div className="flex items-center justify-between"><p className="text-xs text-muted">{label}</p><span className="rounded-full border border-line bg-surface-2 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wider text-faint">{tag}</span></div>
      <p className="tnum mt-1.5 font-display text-lg text-fg">{value}</p>
      {sub && <p className="text-[0.7rem] text-faint">≈ {sub}</p>}
    </div>
  );
}

function RatioMini({ title, value, hint, tone }: { title: string; value: string; hint: string; tone: "emerald" | "amber" | "coral" }) {
  const txt = tone === "emerald" ? "text-emerald" : tone === "amber" ? "text-amber" : "text-coral";
  const dot = tone === "emerald" ? "bg-emerald" : tone === "amber" ? "bg-amber" : "bg-coral";
  return (
    <div className="bg-surface p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted"><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{title}</p>
      <p className={`tnum mt-1 font-display text-xl ${txt}`}>{value}</p>
      <p className="text-[0.65rem] text-faint">ideal {hint}</p>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-lime/40 bg-lime/10 text-lime" : "border-line bg-surface-2 text-muted hover:text-fg"}`}>{children}</button>
  );
}

function CmpSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="appearance-none rounded-lg border border-line bg-surface-2 py-1.5 pl-3 pr-7 text-xs text-fg outline-none focus:border-lime/40">
        {options.map((o) => <option key={o} value={o}>{monthLabel(o)}</option>)}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint">▾</span>
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-base text-fg">{title}</h3>
        {sub && <span className="text-xs text-faint">{sub}</span>}
      </div>
      {children}
    </div>
  );
}
