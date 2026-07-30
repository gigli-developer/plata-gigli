"use client";

import { useEffect, useMemo, useState } from "react";
import {
  db, fetchExchanges, insertExchange, fetchFxBoard, fetchMetrics,
  type ExchangeView, type FxBoard, type FxQuote, type Metrics,
} from "@/lib/db";
import { readCache, writeCache } from "@/lib/cache";
import { ars, compact } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import { Swap, ArrowUpRight, ArrowDownRight, Coins } from "../icons";

const MONEDAS = ["ARS", "USD", "USDT"] as const;
type Moneda = (typeof MONEDAS)[number];
/** Qué casa de cambio corresponde a cada moneda (la misma que usa el resto de la app). */
const CASA_DE: Record<string, string> = { USD: "blue", USDT: "cripto" };
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const diaCorto = (iso: string) => { const [, m, d] = iso.slice(0, 10).split("-"); return `${Number(d)} ${MESES[Number(m) - 1]}`; };

export default function DivisasPage() {
  const [history, setHistory] = useState<ExchangeView[]>([]);
  const [board, setBoard] = useState<FxBoard | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  // Tras registrar un cambio hay que refrescar también las tenencias: la
  // operación ahora genera las dos transacciones y mueve los saldos.
  const reload = async () => {
    const sb = db();
    const [h, m] = await Promise.all([fetchExchanges(sb), fetchMetrics(sb)]);
    setHistory(h);
    setMetrics(m);
  };

  useEffect(() => {
    type Snap = { b: FxBoard; m: Metrics };
    const s = readCache<Snap>("divisas");
    if (s) { setBoard(s.b); setMetrics(s.m); setLoading(false); }
    const sb = db();
    reload();
    Promise.all([fetchFxBoard(sb, 90), fetchMetrics(sb)])
      .then(([b, m]) => { setBoard(b); setMetrics(m); writeCache("divisas", { b, m } satisfies Snap); })
      .finally(() => setLoading(false));
  }, []);

  const quotes = board?.quotes ?? [];
  const actualizado = quotes[0]?.day;

  return (
    <>
      <PageHeader title="Divisas" subtitle="Cotizaciones, conversor y tenencias">
        <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-subtle">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald pulse-dot" />
          {actualizado ? `Al ${diaCorto(actualizado)}` : "Cargando…"}
        </span>
      </PageHeader>

      {/* Cotizaciones reales (tabla fx_rates, la sincroniza fx-sync cada hora) */}
      <div className="mt-5 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {loading && !quotes.length
          ? [0, 1, 2, 3].map((i) => <div key={i} className="panel h-[116px] animate-pulse p-4" />)
          : quotes.map((q, i) => <QuoteCard key={q.casa} q={q} delay={i * 60} />)}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Converter quotes={quotes} onRegister={reload} />
        <Volatilidad board={board} />
      </div>

      <div className="mt-5">
        <Holdings metrics={metrics} quotes={quotes} />
      </div>

      {/* Historial de punta a punta, en grilla */}
      <section className="rise panel mt-5 p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-display text-[17px] font-semibold text-fg">Historial de cambios</h2>
            <p className="text-xs text-faint">{history.length} {history.length === 1 ? "operación" : "operaciones"} registradas</p>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="mt-4 text-sm text-muted">Todavía no registraste ningún cambio.</p>
        ) : (
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {history.map((h) => (
              <li key={h.id} className="panel-inner flex items-center gap-3 p-3.5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.06]"><Swap className="h-5 w-5 text-accent" /></span>
                <div className="min-w-0">
                  <p className="truncate text-[0.95rem] text-fg">{h.from} → {h.to}</p>
                  <p className="tnum truncate text-xs text-faint">{h.date} · TC ${h.rate.toLocaleString("es-AR")}</p>
                </div>
                <div className="ml-auto shrink-0 text-right">
                  <p className="tnum text-[0.95rem] font-semibold text-fg">{h.to === "ARS" ? ars(h.toAmount) : `${h.toAmount.toLocaleString("es-AR")} ${h.to}`}</p>
                  <p className="tnum text-xs text-faint">−{h.fromAmount.toLocaleString("es-AR")} {h.from}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function QuoteCard({ q, delay }: { q: FxQuote; delay: number }) {
  const up = (q.changePct ?? 0) >= 0;
  const spread = q.compra > 0 ? ((q.venta - q.compra) / q.compra) * 100 : 0;
  return (
    <div className="rise panel panel-hover p-4" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-fg">{q.label}</span>
        {q.changePct != null && (
          <span className={`tnum flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.7rem] font-bold ${up ? "bg-emerald/12 text-emerald" : "bg-coral/12 text-coral"}`}>
            {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {Math.abs(q.changePct).toFixed(1)}%
          </span>
        )}
      </div>
      <p className="tnum mt-2 text-[21px] font-semibold text-fg">${q.venta.toLocaleString("es-AR")}</p>
      <p className="tnum mt-0.5 text-xs text-faint">compra ${q.compra.toLocaleString("es-AR")}</p>
      {/* El ancho de la barra es el spread compra/venta, no un dato inventado.
          Escala ×20: los spreads reales van de 0,2% (cripto) a 3,4% (oficial). */}
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.08]" title={`Spread compra/venta ${spread.toFixed(2)}%`}>
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-gold" style={{ width: `${Math.min(spread * 20, 100)}%` }} />
      </div>
    </div>
  );
}

/**
 * Conversor. La cotización correcta depende de la dirección: si entregás dólares
 * te los COMPRAN (rate compra), si los recibís te los VENDEN (rate venta). Un solo
 * número para las dos direcciones haría que ida y vuelta cierre perfecto, cuando en
 * la vida real perdés el spread.
 */
function Converter({ quotes, onRegister }: { quotes: FxQuote[]; onRegister: () => Promise<void> }) {
  const [amount, setAmount] = useState("100");
  const [from, setFrom] = useState<Moneda>("USDT");
  const [to, setTo] = useState<Moneda>("ARS");
  const [manual, setManual] = useState(false);
  const [manualRate, setManualRate] = useState("");
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);

  const q = (casa: string) => quotes.find((x) => x.casa === casa);
  // valor en ARS de 1 unidad, según si la estás entregando (compra) o recibiendo (venta)
  const alVender = (m: Moneda) => (m === "ARS" ? 1 : q(CASA_DE[m])?.compra ?? 0);
  const alComprar = (m: Moneda) => (m === "ARS" ? 1 : q(CASA_DE[m])?.venta ?? 0);

  const value = Number(amount.replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
  const autoRate = from === to ? 1 : (alComprar(to) ? alVender(from) / alComprar(to) : 0);
  const rate = manual ? Number(manualRate.replace(/[^\d.,]/g, "").replace(",", ".")) || 0 : autoRate;
  const result = value * rate;

  const swap = () => { setFrom(to); setTo(from); };

  const register = async () => {
    if (!value || !rate) return;
    setSaving(true);
    try {
      await insertExchange(db(), { from, to, fromAmount: value, toAmount: Math.round(result * 100) / 100, rate: Number(rate.toFixed(4)), rateSource: manual ? "manual" : "auto" });
      await onRegister();
      setOk(true);
      setTimeout(() => setOk(false), 2200);
    } finally { setSaving(false); }
  };

  return (
    <section className="rise panel p-6" style={{ animationDelay: "80ms" }}>
      <h2 className="font-display text-[17px] font-semibold text-fg">Conversor</h2>
      <p className="text-xs text-faint">Con la cotización de hoy, o poné la tuya</p>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <MoneyField label="Entregás" amount={amount} onAmount={setAmount} currency={from} onCurrency={(v) => setFrom(v as Moneda)} editable />
        <button
          onClick={swap}
          className="mx-auto grid h-11 w-11 shrink-0 place-items-center self-center rounded-full border border-white/10 bg-white/[0.06] text-accent transition-transform hover:rotate-180 hover:text-fg"
          title="Invertir"
        >
          <Swap className="h-5 w-5" />
        </button>
        <MoneyField label="Recibís" amount={result.toLocaleString("es-AR", { maximumFractionDigits: 2 })} currency={to} onCurrency={(v) => setTo(v as Moneda)} />
      </div>

      <div className="panel-inner mt-4 px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-subtle">Tipo de cambio</span>
          <div className="flex rounded-full border border-white/10 bg-white/[0.06] p-0.5 text-xs">
            <button onClick={() => setManual(false)} className={`rounded-full px-2.5 py-1 transition-colors ${!manual ? "bg-accent text-bg" : "text-subtle hover:text-fg"}`}>Auto</button>
            <button onClick={() => { setManual(true); if (!manualRate) setManualRate(autoRate.toFixed(2)); }} className={`rounded-full px-2.5 py-1 transition-colors ${manual ? "bg-accent text-bg" : "text-subtle hover:text-fg"}`}>Manual</button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-sm">
          <span className="tnum text-faint">1 {from} =</span>
          {manual ? (
            <input
              value={manualRate}
              onChange={(e) => setManualRate(e.target.value)}
              inputMode="decimal"
              placeholder="cotización…"
              autoFocus
              className="tnum w-32 rounded-lg border border-accent/40 bg-white/[0.09] px-2 py-1 text-fg outline-none"
            />
          ) : (
            <span className="tnum text-fg">{autoRate.toLocaleString("es-AR", { maximumFractionDigits: 4 })}</span>
          )}
          <span className="tnum text-faint">{to}</span>
          {!manual && from !== to && (
            <span className="ml-auto text-[0.7rem] text-faint">
              {from !== "ARS" ? `${CASA_DE[from]} compra` : `${CASA_DE[to]} venta`}
            </span>
          )}
        </div>
      </div>

      <button onClick={register} disabled={saving || !value || !rate} className="mt-4 w-full rounded-[13px] bg-accent py-3 text-sm font-semibold text-bg transition-transform hover:scale-[1.02] disabled:opacity-50">
        {saving ? "Guardando…" : ok ? "Registrado ✓" : "Registrar cambio"}
      </button>
      <p className="mt-2 text-center text-[0.7rem] text-faint">
        Se registra acá y <b className="text-subtle">mueve los saldos</b>: genera el egreso y el ingreso en Transacciones, categoría «Cambio Divisas» (no cuenta como gasto del mes).
      </p>
    </section>
  );
}

function MoneyField({ label, amount, onAmount, currency, onCurrency, editable }: {
  label: string; amount: string; onAmount?: (v: string) => void; currency: string; onCurrency: (v: string) => void; editable?: boolean;
}) {
  return (
    <div className="panel-inner flex-1 p-4">
      <p className="label-micro">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={amount}
          onChange={(e) => onAmount?.(e.target.value)}
          readOnly={!editable}
          inputMode="decimal"
          className={`tnum w-full bg-transparent text-[26px] font-semibold outline-none sm:text-[30px] ${editable ? "text-fg" : "text-fg/80"}`}
        />
        <div className="relative shrink-0">
          <select
            value={currency}
            onChange={(e) => onCurrency(e.target.value)}
            className="appearance-none rounded-lg border border-white/10 bg-white/[0.09] py-1.5 pl-3 pr-7 text-sm text-fg outline-none"
          >
            {MONEDAS.map((c) => <option key={c}>{c}</option>)}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-faint">▾</span>
        </div>
      </div>
    </div>
  );
}

/** Tenencias reales: los saldos que ya calcula get_metrics, valuados a la cotización de hoy. */
function Holdings({ metrics, quotes }: { metrics: Metrics | null; quotes: FxQuote[] }) {
  if (!metrics) return <section className="panel p-6"><p className="text-sm text-muted">Cargando tenencias…</p></section>;
  const usdArs = metrics.usd_liquido * metrics.usd_ars;
  const usdtArs = metrics.usdt_liquido * metrics.usdt_ars;
  const total = metrics.ars_liquido + usdArs + usdtArs;
  const items = [
    { moneda: "ARS", emoji: "💵", cant: metrics.ars_liquido, enArs: metrics.ars_liquido, rate: 1, color: "text-accent" },
    { moneda: "USD", emoji: "💸", cant: metrics.usd_liquido, enArs: usdArs, rate: metrics.usd_ars, color: "text-gold" },
    { moneda: "USDT", emoji: "🪙", cant: metrics.usdt_liquido, enArs: usdtArs, rate: metrics.usdt_ars, color: "text-sky" },
  ];
  return (
    <section className="rise panel p-6" style={{ animationDelay: "100ms" }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold text-fg">Tenencias</h2>
          <p className="text-xs text-faint">Tus saldos líquidos, valuados a la cotización de hoy</p>
        </div>
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-accent"><Coins className="h-5 w-5" /></span>
      </div>
      <p className="tnum mt-3 text-[30px] font-extrabold leading-none text-fg">{ars(total)}</p>
      <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {items.map((h) => (
          <li key={h.moneda} className="panel-inner p-3.5">
            <div className="flex items-center gap-2">
              <span className="text-base">{h.emoji}</span>
              <span className="label-micro">{h.moneda}</span>
              <span className="tnum ml-auto text-[0.7rem] text-faint">{h.rate === 1 ? "—" : `$${h.rate.toLocaleString("es-AR")}`}</span>
            </div>
            <p className={`tnum mt-1.5 text-[17px] font-semibold ${h.color}`}>
              {h.moneda === "ARS" ? ars(h.cant) : `${h.cant.toLocaleString("es-AR", { maximumFractionDigits: 2 })} ${h.moneda}`}
            </p>
            {h.moneda !== "ARS" && <p className="tnum text-[0.7rem] text-faint">≈ {compact(h.enArs)}</p>}
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
              <div className="h-full rounded-full bg-current opacity-70" style={{ width: `${total ? (h.enArs / total) * 100 : 0}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PERIODOS = [
  { dias: 7, label: "7d" },
  { dias: 30, label: "30d" },
  { dias: 90, label: "90d" },
] as const;

/** Volatilidad del tipo de cambio: sparkline + mínimo/promedio/máximo del período. */
function Volatilidad({ board }: { board: FxBoard | null }) {
  const [casa, setCasa] = useState("blue");
  const [dias, setDias] = useState<number>(30);

  const serie = useMemo(() => {
    const s = board?.series[casa] ?? [];
    return s.slice(-dias);
  }, [board, casa, dias]);

  const stats = useMemo(() => {
    if (serie.length < 2) return null;
    const vs = serie.map((p) => p.venta);
    const min = Math.min(...vs), max = Math.max(...vs);
    const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
    const first = vs[0], last = vs[vs.length - 1];
    const w = 100, h = 34;
    const pts = vs.map((v, i) => [(i / (vs.length - 1)) * w, h - ((v - min) / (max - min || 1)) * h] as const);
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
    return {
      min, max, avg, last,
      changePct: first ? ((last - first) / first) * 100 : 0,
      // amplitud: qué tanto se movió en el período respecto al promedio
      amplitud: avg ? ((max - min) / avg) * 100 : 0,
      path, area: `${path} L${w},${h} L0,${h} Z`,
      up: last >= first,
    };
  }, [serie]);

  const opciones = board?.quotes ?? [];
  const color = stats?.up ? "#35e08a" : "#ff433d";

  return (
    <section className="rise panel p-6" style={{ animationDelay: "120ms" }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold text-fg">Volatilidad</h2>
          <p className="text-xs text-faint">Cuánto se movió en el período</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select value={casa} onChange={(e) => setCasa(e.target.value)} className="appearance-none rounded-full border border-white/10 bg-white/[0.06] py-1 pl-3 pr-7 text-xs text-fg outline-none">
              {opciones.map((o) => <option key={o.casa} value={o.casa}>{o.label}</option>)}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[0.6rem] text-faint">▾</span>
          </div>
          <div className="flex rounded-full border border-white/10 bg-white/[0.06] p-0.5 text-xs">
            {PERIODOS.map((p) => (
              <button key={p.dias} onClick={() => setDias(p.dias)} className={`rounded-full px-2.5 py-1 transition-colors ${dias === p.dias ? "bg-accent text-bg" : "text-subtle hover:text-fg"}`}>{p.label}</button>
            ))}
          </div>
        </div>
      </div>

      {!stats ? (
        <p className="mt-6 text-sm text-muted">Sin suficientes datos para ese período.</p>
      ) : (
        <>
          <div className="mt-4 flex items-baseline gap-2">
            <p className="tnum text-[26px] font-bold text-fg">${stats.last.toLocaleString("es-AR")}</p>
            <span className={`tnum text-sm font-bold ${stats.up ? "text-emerald" : "text-coral"}`}>
              {stats.up ? "▲" : "▼"} {Math.abs(stats.changePct).toFixed(1)}%
            </span>
            <span className="ml-auto tnum text-[0.7rem] text-faint">amplitud {stats.amplitud.toFixed(1)}%</span>
          </div>
          <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="mt-3 h-24 w-full overflow-visible">
            <defs>
              <linearGradient id={`fxg-${casa}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.35" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={stats.area} fill={`url(#fxg-${casa})`} />
            <path className="draw-line" pathLength={1} d={stats.path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="mt-3 grid grid-cols-3 divide-x divide-white/10 border-t border-white/10 pt-3 text-center">
            <div><p className="label-micro">mínimo</p><p className="tnum mt-0.5 text-sm text-fg">${Math.round(stats.min).toLocaleString("es-AR")}</p></div>
            <div><p className="label-micro">promedio</p><p className="tnum mt-0.5 text-sm text-fg">${Math.round(stats.avg).toLocaleString("es-AR")}</p></div>
            <div><p className="label-micro">máximo</p><p className="tnum mt-0.5 text-sm text-fg">${Math.round(stats.max).toLocaleString("es-AR")}</p></div>
          </div>
        </>
      )}
    </section>
  );
}
