"use client";

import { useEffect, useMemo, useState } from "react";
import { liveQuotes, fxRatesToArs, fxHoldings, fxTrend, currencies } from "@/lib/mock";
import { db, fetchExchanges, insertExchange, type ExchangeView } from "@/lib/db";
import { ars, compact } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import { Swap, ArrowUpRight, ArrowDownRight, Coins } from "../icons";

export default function DivisasPage() {
  const [history, setHistory] = useState<ExchangeView[]>([]);
  const reload = async () => setHistory(await fetchExchanges(db()));
  useEffect(() => { reload(); }, []);

  return (
    <>
      <PageHeader title="Divisas" subtitle="Cotización en vivo">
        <span className="flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald pulse-dot" /> Actualizado recién
        </span>
      </PageHeader>

      {/* live quotes */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {liveQuotes.map((q, i) => (
          <div key={q.name} className="rise panel panel-hover p-4" style={{ animationDelay: `${i * 60}ms` }}>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">{q.name}</span>
              <span className={`tnum flex items-center gap-0.5 text-[0.7rem] ${q.changePct >= 0 ? "text-emerald" : "text-coral"}`}>
                {q.changePct >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {Math.abs(q.changePct)}%
              </span>
            </div>
            <p className="tnum mt-2 text-2xl text-fg">${q.sell.toLocaleString("es-AR")}</p>
            <p className="mt-1 text-xs text-faint">compra ${q.buy.toLocaleString("es-AR")}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="flex flex-col gap-5 xl:col-span-2">
          <Converter onRegister={reload} />

          {/* history */}
          <section className="rise panel p-6" style={{ animationDelay: "160ms" }}>
            <h2 className="font-display text-lg text-fg">Historial de cambios</h2>
            <p className="text-xs text-faint">{history.length} operaciones</p>
            <ul className="mt-4 divide-y divide-line">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-3 py-3.5">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2"><Swap className="h-5 w-5 text-violet" /></span>
                  <div>
                    <p className="text-[0.95rem] text-fg">{h.from} → {h.to}</p>
                    <p className="text-xs text-faint">{h.date} · TC ${h.rate.toLocaleString("es-AR")}</p>
                  </div>
                  <div className="ml-auto text-right">
                    <p className="tnum text-[0.95rem] text-fg">{ars(h.toAmount)}</p>
                    <p className="tnum text-xs text-faint">−{h.fromAmount.toLocaleString("es-AR")} {h.from}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* right: holdings + trend */}
        <div className="flex flex-col gap-5">
          <Holdings />
          <TrendCard />
        </div>
      </div>
    </>
  );
}

function Converter({ onRegister }: { onRegister: () => Promise<void> }) {
  const [amount, setAmount] = useState("100");
  const [from, setFrom] = useState("USDT");
  const [to, setTo] = useState("ARS");
  const [manual, setManual] = useState(false);
  const [manualRate, setManualRate] = useState("");
  const [saving, setSaving] = useState(false);

  const value = Number(amount.replace(/[^\d.]/g, "")) || 0;
  const autoRate = fxRatesToArs[from] / fxRatesToArs[to];
  const rate = manual ? Number(manualRate.replace(/[^\d.]/g, "")) || 0 : autoRate;
  const result = value * rate;

  const swap = () => { setFrom(to); setTo(from); };

  const register = async () => {
    if (!value || !rate) return;
    setSaving(true);
    try {
      await insertExchange(db(), { from, to, fromAmount: value, toAmount: Math.round(result), rate: Number(rate.toFixed(2)), rateSource: manual ? "manual" : "auto" });
      await onRegister();
    } finally { setSaving(false); }
  };

  return (
    <section className="rise panel p-6" style={{ animationDelay: "80ms" }}>
      <h2 className="font-display text-lg text-fg">Conversor y registro</h2>
      <p className="text-xs text-faint">Convertí al instante o registrá un cambio real</p>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <MoneyField label="Entregás" amount={amount} onAmount={setAmount} currency={from} onCurrency={setFrom} editable />
        <button
          onClick={swap}
          className="mx-auto grid h-11 w-11 shrink-0 place-items-center self-center rounded-xl border border-line bg-surface-2 text-violet transition-transform hover:rotate-180 hover:text-fg"
          title="Invertir"
        >
          <Swap className="h-5 w-5" />
        </button>
        <MoneyField label="Recibís" amount={result.toLocaleString("es-AR", { maximumFractionDigits: 2 })} currency={to} onCurrency={setTo} />
      </div>

      <div className="mt-4 rounded-xl border border-line bg-surface-2/60 px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-muted">Tipo de cambio</span>
          <div className="flex rounded-lg border border-line bg-surface-3 p-0.5 text-xs">
            <button onClick={() => setManual(false)} className={`rounded-md px-2.5 py-1 transition-colors ${!manual ? "bg-surface-2 text-lime" : "text-muted hover:text-fg"}`}>Auto</button>
            <button onClick={() => { setManual(true); if (!manualRate) setManualRate(autoRate.toFixed(2)); }} className={`rounded-md px-2.5 py-1 transition-colors ${manual ? "bg-surface-2 text-violet" : "text-muted hover:text-fg"}`}>Manual</button>
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
              className="tnum w-32 rounded-lg border border-violet/40 bg-surface-3 px-2 py-1 text-fg outline-none"
            />
          ) : (
            <span className="tnum text-fg">{autoRate.toLocaleString("es-AR", { maximumFractionDigits: 4 })}</span>
          )}
          <span className="tnum text-faint">{to}</span>
          {manual && <span className="ml-auto text-[0.7rem] text-violet">cotización propia</span>}
        </div>
      </div>

      <button onClick={register} disabled={saving} className="mt-4 w-full rounded-xl bg-lime py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">
        {saving ? "Guardando…" : "Registrar cambio"}
      </button>
    </section>
  );
}

function MoneyField({ label, amount, onAmount, currency, onCurrency, editable }: {
  label: string; amount: string; onAmount?: (v: string) => void; currency: string; onCurrency: (v: string) => void; editable?: boolean;
}) {
  return (
    <div className="flex-1 rounded-2xl border border-line bg-surface-2 p-4">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={amount}
          onChange={(e) => onAmount?.(e.target.value)}
          readOnly={!editable}
          inputMode="decimal"
          className={`tnum w-full bg-transparent text-2xl outline-none ${editable ? "text-fg" : "text-fg/80"}`}
        />
        <div className="relative shrink-0">
          <select
            value={currency}
            onChange={(e) => onCurrency(e.target.value)}
            className="appearance-none rounded-lg border border-line bg-surface-3 py-1.5 pl-3 pr-7 text-sm text-fg outline-none"
          >
            {currencies.map((c) => <option key={c}>{c}</option>)}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-faint">▾</span>
        </div>
      </div>
    </div>
  );
}

function Holdings() {
  const total = fxHoldings.reduce((a, h) => a + h.amount * fxRatesToArs[h.currency], 0);
  return (
    <section className="rise panel p-6" style={{ animationDelay: "100ms" }}>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg text-fg">Tenencias</h2>
          <p className="text-xs text-faint">Valuadas en pesos</p>
        </div>
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-lime/12 text-lime"><Coins className="h-5 w-5" /></span>
      </div>
      <p className="tnum mt-4 font-display text-3xl text-fg">{ars(total)}</p>
      <ul className="mt-4 space-y-3">
        {fxHoldings.map((h) => (
          <li key={h.currency} className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-line bg-surface-2 text-base">{h.emoji}</span>
            <div>
              <p className="text-sm text-fg">{h.amount.toLocaleString("es-AR")} {h.currency}</p>
              <p className="text-xs text-faint">≈ {ars(h.amount * fxRatesToArs[h.currency])}</p>
            </div>
            <span className="tnum ml-auto text-sm text-muted">${fxRatesToArs[h.currency].toLocaleString("es-AR")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TrendCard() {
  const { path, area, up } = useMemo(() => {
    const w = 100, h = 32;
    const min = Math.min(...fxTrend), max = Math.max(...fxTrend);
    const pts = fxTrend.map((v, i) => {
      const x = (i / (fxTrend.length - 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * h;
      return [x, y];
    });
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = `${path} L${w},${h} L0,${h} Z`;
    return { path, area, up: fxTrend[fxTrend.length - 1] >= fxTrend[0] };
  }, []);
  const color = up ? "#34e1a0" : "#ff6b6b";

  return (
    <section className="rise panel p-6" style={{ animationDelay: "160ms" }}>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg text-fg">USDT / ARS</h2>
          <p className="text-xs text-faint">Últimas 12 jornadas</p>
        </div>
        <span className={`tnum text-sm ${up ? "text-emerald" : "text-coral"}`}>${fxTrend[fxTrend.length - 1].toLocaleString("es-AR")}</span>
      </div>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mt-4 h-24 w-full overflow-visible">
        <defs>
          <linearGradient id="fxg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#fxg)" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </section>
  );
}
