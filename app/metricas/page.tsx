"use client";

import { useEffect, useMemo, useState } from "react";
import { db, fetchMetrics, fetchMonthlyBreakdown, fetchPlansForProjection, fetchNetWorthSeries, fetchInflationData, type Metrics, type MonthAgg, type PlanProj, type NetWorthPoint } from "@/lib/db";
import { aggArs, cuotaArs } from "@/lib/fx";
import { readCache, writeCache } from "@/lib/cache";
import { ars, compact, compactUsd } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import CountUp from "../components/CountUp";
import { Coins } from "../icons";
import { Donut, BarList, GroupedColumns, VariationTable, NetWorthChart, NetWorthTable, type Slice, type MonthCol, type VarRow, type NetWorthCol, type NetWorthRow } from "../components/charts";

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
  // Vara con la que se mide el patrimonio:
  //   ars  → pesos nominales (parte de la suba es devaluación)
  //   usd  → dólares, cada mes al blue de SU corte (crecimiento real vs la moneda de ahorro)
  //   real → pesos de HOY, deflactando por IPC (poder adquisitivo: ¿comprás más que antes?)
  const [nwCur, setNwCur] = useState<"ars" | "usd" | "real">("ars");
  const [nwView, setNwView] = useState<"grafico" | "tabla">("grafico");
  // Serie histórica de IPC (mes → % mensual). Alcanza para deflactar toda la serie.
  const [ipc, setIpc] = useState<Record<string, number>>({});
  const [monthFilter, setMonthFilter] = useState<string>(NOW_MONTH);
  const [cmpA, setCmpA] = useState<string>(addMonthYM(NOW_MONTH, -1));
  const [cmpB, setCmpB] = useState<string>(NOW_MONTH);
  const cmpOptions = useMemo(() => Array.from({ length: 8 }, (_, i) => addMonthYM(NOW_MONTH, -i)), []);

  useEffect(() => {
    // Pintar al instante el último snapshot; lo fresco llega por atrás.
    const s = readCache<{ m: Metrics; b: MonthAgg[]; p: PlanProj[]; nw?: NetWorthPoint[]; ipc?: Record<string, number> }>("metricas");
    if (s) { setM(s.m); setBreakdown(s.b); setPlans(s.p); setNetWorth(s.nw ?? []); setIpc(s.ipc ?? {}); setUsdRate(s.m.usd_ars); setUsdtRate(s.m.usdt_ars); setLoading(false); if (s.nw?.length) setNwLoading(false); }
    const sb = db();
    Promise.all([fetchMetrics(sb), fetchMonthlyBreakdown(sb, 6), fetchPlansForProjection(sb), fetchNetWorthSeries(sb, 12), fetchInflationData(sb)])
      .then(([d, b, p, nwSerie, inf]) => { setM(d); setBreakdown(b); setPlans(p); setNetWorth(nwSerie); setIpc(inf.byMonth); setUsdRate(d.usd_ars); setUsdtRate(d.usdt_ars); writeCache("metricas", { m: d, b, p, nw: nwSerie, ipc: inf.byMonth }); })
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
    // Las cuotas vienen en la moneda de su plan: una de US$ 100 no son $100.
    const fxm = { usd: usdRate, usdt: usdtRate, day: null };
    const valuar = (b: MonthAgg) => aggArs(b, fxm);
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
      if (k >= 0 && k < p.total) cuotas += cuotaArs(p, fxm);
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

  // Deflactor: cuánto hay que multiplicar un peso de `mes` para expresarlo en pesos
  // de HOY. Es el acumulado de IPC de todos los meses POSTERIORES al del corte.
  // El INDEC publica con rezago, así que "hoy" es en realidad el último mes con dato.
  const defl = useMemo(() => {
    const meses = Object.keys(ipc).sort();
    const ultimo = meses[meses.length - 1] ?? null;
    const factor = (desde: string) => {
      let f = 1;
      for (const mm of meses) if (mm > desde) f *= 1 + ipc[mm] / 100;
      return f;
    };
    return { factor, ultimo, hayDatos: meses.length > 0 };
  }, [ipc]);

  // Serie de patrimonio + descomposición mes a mes: cuánto subió por lo tuyo y
  // cuánto por algo externo (el dólar, o la inflación según la vara elegida).
  // El efecto externo siempre se mide sobre el stock con el que arrancó el mes
  // (convención estándar) y el resto queda como flujo real.
  const nw = useMemo(() => {
    const enUsd = nwCur === "usd";
    const enReal = nwCur === "real";
    // usd  → se divide por el dólar DE CADA CORTE: cada mes medido con la vara de su momento.
    // real → se multiplica por el IPC acumulado hasta hoy: todo en pesos de HOY.
    const v = (monto: number, p: NetWorthPoint) =>
      enUsd ? (p.usdArs ? monto / p.usdArs : 0)
      : enReal ? monto * defl.factor(p.month)
      : monto;
    const cols: NetWorthCol[] = netWorth.map((p) => ({
      label: monthLabel(p.month).slice(0, 3) + " " + p.month.slice(2, 4),
      ars: Math.max(v(p.ars, p), 0),
      usdArs: Math.max(v(p.usd * p.usdArs, p), 0),
      usdtArs: Math.max(v(p.usdt * p.usdtArs, p), 0),
      teDeben: v(p.teDeben, p),
      pasivos: v(p.pasivos, p),
      patrimonio: v(p.patrimonio, p),
    }));

    // Efecto "externo" de un mes contra el anterior: la parte de la variación que NO
    // pusiste vos. Siempre se mide sobre el stock con el que arrancaste el mes.
    const externoDe = (cur: NetWorthPoint, pre: NetWorthPoint) =>
      enUsd
        // lo que costó tener PESOS: los pesos de arranque valen menos dólares
        ? (cur.usdArs && pre.usdArs ? pre.ars * (1 / cur.usdArs - 1 / pre.usdArs) : 0)
        : enReal
        // lo que se comió la INFLACIÓN del stock inicial. Sale de la identidad
        // P₁·D₁ − P₀·D₀ = (P₁−P₀)·D₁ + P₀·(D₁−D₀); el segundo término es el efecto.
        ? pre.patrimonio * (defl.factor(cur.month) - defl.factor(pre.month))
        // en pesos nominales: la revaluación de las tenencias en moneda dura
        : pre.usd * (cur.usdArs - pre.usdArs) + pre.usdt * (cur.usdtArs - pre.usdtArs);

    let delta: { label: string; total: number; fx: number; ahorro: number } | null = null;
    if (netWorth.length >= 2) {
      const cur = netWorth[netWorth.length - 1], pre = netWorth[netWorth.length - 2];
      const total = v(cur.patrimonio, cur) - v(pre.patrimonio, pre);
      const fx = externoDe(cur, pre);
      delta = { label: monthLabel(cur.month), total, fx, ahorro: total - fx };
    }

    // El INDEC publica con rezago: para los meses posteriores al último IPC el
    // deflactor es 1 y el efecto daría 0, que se lee como "no hubo inflación".
    // No es cero, es desconocido — y así hay que mostrarlo.
    const sinIpc = (mes: string) => enReal && defl.ultimo !== null && mes > defl.ultimo;

    const rows: NetWorthRow[] = netWorth.map((p, i) => {
      const pre = i > 0 ? netWorth[i - 1] : null;
      const val = v(p.patrimonio, p);
      const valPre = pre ? v(pre.patrimonio, pre) : null;
      const varAbs = valPre === null ? null : val - valPre;
      const externo = pre ? externoDe(p, pre) : 0;
      return {
        month: p.month,
        label: monthLabel(p.month).slice(0, 3) + " " + p.month.slice(2, 4),
        ars: p.ars, usd: p.usd, usdt: p.usdt,
        patrimonio: val,
        varAbs,
        varPct: valPre ? (val - valPre) / Math.abs(valPre) : null,
        propio: varAbs === null ? 0 : varAbs - externo,
        externo: varAbs === null ? 0 : externo,
        sinDato: sinIpc(p.month),
      };
    });

    return { cols, delta, rows, deltaSinDato: netWorth.length >= 2 && sinIpc(netWorth[netWorth.length - 1].month) };
  }, [netWorth, nwCur, defl]);

  const charts = useMemo(() => {
    // Las cuotas vienen en la moneda de su plan: una de US$ 100 no son $100.
    const fxm = { usd: usdRate, usdt: usdtRate, day: null };
    const valuar = (b: MonthAgg) => aggArs(b, fxm);
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
    for (const p of plans) for (const mm of scopeMonths) { const k = monthsBetweenYM(p.firstMonth, mm); if (k >= 0 && k < p.total) { const e = catMap.get(p.category) ?? { v: 0, emoji: p.emoji }; const v = cuotaArs(p, fxm); e.v += v; catMap.set(p.category, e); cuotasTotal += v; } }
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
      for (const p of plans) { const k = monthsBetweenYM(p.firstMonth, mm); if (k >= 0 && k < p.total) { const e = map.get(p.category) ?? { v: 0, emoji: p.emoji }; e.v += cuotaArs(p, fxm); map.set(p.category, e); } }
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
    for (const p of plans) { const k = monthsBetweenYM(p.firstMonth, cmpB); if (k >= 0 && k < p.total) cuoB.set(p.category, (cuoB.get(p.category) ?? 0) + cuotaArs(p, fxm)); }

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
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs">
          <span className="label-micro">Cotización</span>
          <span className="text-subtle">USD</span>
          <input value={usdRate} onChange={(e) => setUsdRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
          <span className="text-subtle">USDT</span>
          <input value={usdtRate} onChange={(e) => setUsdtRate(Number(e.target.value) || 0)} className="tnum w-16 bg-transparent text-fg outline-none" inputMode="decimal" />
        </div>
      </PageHeader>

      {/* Patrimonio + saldos + ratios: cards sueltas dentro de un panel, como el
          diseño. Cada ratio lleva su semáforo como barra vertical a la izquierda. */}
      <section className="rise panel relative mt-5 overflow-hidden p-5">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/15 blur-3xl" />

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="label-micro">Patrimonio neto</p>
            <CountUp value={calc.patrimonio} format={ars} className={`tnum mt-1 block text-[38px] font-extrabold leading-none lg:text-[44px] ${calc.patrimonio >= 0 ? "text-fg" : "text-coral"}`} />
            <p className="tnum mt-1.5 text-xs text-faint">≈ US$ {calc.patrimonioUsd.toLocaleString("es-AR", { maximumFractionDigits: 0 })}</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="tnum rounded-lg border border-emerald/25 bg-emerald/10 px-3 py-1.5 font-bold text-emerald">Activos {ars(calc.activos)}</span>
            <span className="tnum rounded-lg border border-coral/25 bg-coral/10 px-3 py-1.5 font-bold text-coral">Pasivos {ars(calc.pasivos)}</span>
          </div>
        </div>

        <div className="relative mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-3">
          <Mini label="Pesos" num={m.ars_liquido} format={ars} tone="text-fg" />
          <Mini label="Dólares" num={m.usd_liquido} format={(n) => `US$ ${n.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`} sub={ars(calc.usdArs)} tone="text-gold" />
          <Mini label="Cripto" num={m.usdt_liquido} format={(n) => `USDT ${n.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`} sub={ars(calc.usdtArs)} tone="text-sky" />
        </div>

        <div className="relative mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <RatioMini title="Deuda / Ingresos" value={pct(flows.dti)} hint="Ideal < 36%" tone={flows.dti < 0.36 ? "emerald" : flows.dti < 0.43 ? "amber" : "coral"} />
          <RatioMini title="Tasa de ahorro" value={pct(flows.tasaAhorro)} hint="Ideal > 20%" tone={flows.tasaAhorro > 0.2 ? "emerald" : flows.tasaAhorro > 0.1 ? "amber" : "coral"} />
          <RatioMini title="Flujo de caja" value={`${flows.flujo.toFixed(2).replace(".", ",")}×`} hint="Ideal > 1" tone={flows.flujo > 1.2 ? "emerald" : flows.flujo >= 1 ? "amber" : "coral"} />
          <RatioMini title="Ahorro mensual" value={ars(flows.ahorroMostrar)} hint={monthFilter === "all" ? "Promedio mensual" : monthLabel(monthFilter)} tone={flows.ahorroMostrar > 0 ? "amber" : "coral"} />
        </div>
        <p className="relative mt-3 text-[0.7rem] text-faint">
          Ratios de <span className="text-subtle">{monthFilter === "all" ? "todos los meses" : monthLabel(monthFilter)}</span> · elegí el mes en Análisis ↓
        </p>
      </section>

      {/* Patrimonio neto en el tiempo */}
      <section className="rise panel mt-5 p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="font-display text-[17px] font-semibold text-fg">Patrimonio neto en el tiempo</h3>
            <p className="text-xs text-faint">
              Cierre de cada mes · {nwCur === "ars" ? "tenencias valuadas al dólar de esa fecha"
                : nwCur === "usd" ? "todo medido al dólar de cada mes"
                : `en pesos de hoy, deflactado por IPC${defl.ultimo ? ` (último dato ${monthLabel(defl.ultimo)})` : ""}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {nw.delta && (
              <div className="text-right text-xs">
                <p className={`tnum text-sm ${nw.delta.total >= 0 ? "text-emerald" : "text-coral"}`}>
                  {nw.delta.total >= 0 ? "+" : "−"}{nwFmt(Math.abs(nw.delta.total))} en {nw.delta.label}
                </p>
                <p className="text-faint">
                  {nw.deltaSinDato ? (
                    <span title="Todavía no se publicó el IPC de este mes">sin IPC del mes todavía</span>
                  ) : (
                    <>
                      <span className={nw.delta.ahorro >= 0 ? "text-emerald/80" : "text-coral/80"}>{nw.delta.ahorro >= 0 ? "+" : "−"}{nwFmt(Math.abs(nw.delta.ahorro))} tuyo</span>
                      {" · "}
                      <span className={nw.delta.fx >= 0 ? "text-amber/80" : "text-coral/80"}>{nw.delta.fx >= 0 ? "+" : "−"}{nwFmt(Math.abs(nw.delta.fx))} {nwCur === "ars" ? "por el dólar" : nwCur === "usd" ? "por estar en pesos" : "por la inflación"}</span>
                    </>
                  )}
                </p>
              </div>
            )}
            {/* Dos controles: con qué vara medís, y cómo lo mirás. */}
            <div className="flex items-center gap-2">
              <div className="seg text-xs">
                <button onClick={() => setNwCur("ars")} aria-selected={nwCur === "ars"} className="seg-item">$</button>
                <button onClick={() => setNwCur("usd")} aria-selected={nwCur === "usd"} className="seg-item">US$</button>
                <button onClick={() => setNwCur("real")} aria-selected={nwCur === "real"} disabled={!defl.hayDatos} title={defl.hayDatos ? "Pesos de hoy (ajustado por inflación)" : "Sin datos de inflación"} className="seg-item disabled:opacity-40">$ hoy</button>
              </div>
              <div className="seg text-xs">
                <button onClick={() => setNwView("grafico")} aria-selected={nwView === "grafico"} className="seg-item">Gráfico</button>
                <button onClick={() => setNwView("tabla")} aria-selected={nwView === "tabla"} className="seg-item">Tabla</button>
              </div>
            </div>
          </div>
        </div>
        {nwLoading && !nw.cols.length ? (
          <div className="grid h-48 place-items-center text-sm text-muted">Reconstruyendo la serie…</div>
        ) : nwView === "grafico" ? (
          <NetWorthChart data={nw.cols} fmt={nwFmt} />
        ) : (
          <NetWorthTable rows={nw.rows} fmt={nwFmt} externoLabel={nwCur === "real" ? "Inflación" : "Dólar"} />
        )}
        <p className="mt-3 text-[0.7rem] text-faint">
          {nwCur === "ars"
            ? "En pesos, parte de la suba es devaluación: el efecto cambiario se calcula sobre las tenencias con las que arrancaste el mes y lo demás es flujo real (lo que ganaste, gastaste o pagaste de deuda). Pasá a US$ para ver cuánto creciste de verdad."
            : nwCur === "usd"
            ? "Medido en dólares el crecimiento es real, sin el ruido de la devaluación. Acá el efecto cambiario es el espejo: lo que te costó (o te dio) tener pesos mientras el dólar se movía."
            : "En pesos de hoy: cada mes ajustado por la inflación acumulada desde entonces. Si la columna sube, tu patrimonio compra MÁS cosas que antes — es la vara que importa si tus gastos son en pesos. La columna «Inflación» es lo que te comió el aumento de precios sobre el patrimonio con el que arrancaste cada mes."}
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

function Mini({ label, num, format, sub, tone }: { label: string; num: number; format: (n: number) => string; sub?: string; tone: string }) {
  return (
    <div className="panel-inner p-4">
      <p className="label-micro">{label}</p>
      <CountUp value={num} format={format} className={`tnum mt-2 block text-[21px] font-semibold ${tone}`} />
      {sub && <p className="tnum mt-0.5 text-[0.7rem] text-faint">≈ {sub}</p>}
    </div>
  );
}

/** Ratio con el semáforo como barra vertical a la izquierda (verde/ámbar/coral). */
function RatioMini({ title, value, hint, tone }: { title: string; value: string; hint: string; tone: "emerald" | "amber" | "coral" }) {
  const txt = tone === "emerald" ? "text-emerald" : tone === "amber" ? "text-amber" : "text-coral";
  const bar = tone === "emerald" ? "bg-emerald" : tone === "amber" ? "bg-amber" : "bg-coral";
  return (
    <div className="panel-inner relative overflow-hidden py-3.5 pl-4 pr-4">
      <span className={`absolute inset-y-2 left-0 w-[3px] rounded-full ${bar}`} />
      <p className="text-xs text-subtle">{title}</p>
      <p className={`tnum mt-1 text-[24px] font-bold leading-none ${txt}`}>{value}</p>
      <p className="mt-1.5 text-[0.65rem] text-faint">{hint}</p>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-accent/50 bg-accent/15 text-accent" : "border-white/10 bg-white/[0.06] text-subtle hover:text-fg"}`}>{children}</button>
  );
}

function CmpSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="appearance-none rounded-[11px] border border-white/10 bg-white/[0.06] py-1.5 pl-3 pr-7 text-xs text-fg outline-none focus:border-accent/50">
        {options.map((o) => <option key={o} value={o}>{monthLabel(o)}</option>)}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint">▾</span>
    </div>
  );
}

function ChartCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="panel p-[22px_24px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[17px] font-semibold text-fg">{title}</h3>
        {sub && <span className="text-xs text-faint">{sub}</span>}
      </div>
      {children}
    </div>
  );
}
