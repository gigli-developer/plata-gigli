"use client";

import { useEffect, useMemo, useState } from "react";
import {
  db, fetchTransactions, fetchCardsFull, fetchDebts, fetchCategories, fetchMetrics, updateTxCategory,
  fetchStatements, fetchInstallments, fetchStatementConsumos,
  FX_FALLBACK,
  type TxView, type CardFull, type DebtView, type Category, type Metrics, type StatementRow, type InstallmentRow,
} from "@/lib/db";
import { arsDe } from "@/lib/fx";
import { readCache, writeCache } from "@/lib/cache";
import { ars, compact } from "@/lib/format";
import { Card as CardIcon, Sparkle, Bell, Search, Plus, ArrowUpRight, ArrowDownRight, Camera, Mail, Mic, Send, Coins, X } from "./icons";
import { useAssistantChat, MessageList } from "./components/assistantChat";
import { useDictation } from "./components/useDictation";
import PrivacyToggle from "./components/PrivacyToggle";
import CountUp from "./components/CountUp";

// Formatters de moneda extranjera. Se acotan los decimales porque durante la
// animación el valor es fraccionario y "300,4567 USDT" queda sucio.
const fmtUsd = (n: number) => `US$ ${n.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
const fmtUsdt = (n: number) => `${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })} USDT`;

const chips = [
  "Gasté 18.500 en delivery con la Galicia",
  "¿Cuánto gasté en Compras este mes?",
  "Cobré el alquiler de Chañar II",
];
const SHORT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const CAT_COLORS = ["#ff9e1b", "#35e08a", "#5ec8ff", "#ffbf47", "#ff433d", "#a78bfa"];

export default function Dashboard() {
  const chat = useAssistantChat();
  const [chatActive, setChatActive] = useState(false);
  const [txs, setTxs] = useState<TxView[]>([]);
  const [cards, setCards] = useState<CardFull[]>([]);
  const [debts, setDebts] = useState<DebtView[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [installments, setInstallments] = useState<InstallmentRow[]>([]);
  const [consumos, setConsumos] = useState<Record<number, { ars: number; usd: number }>>({});
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    const sb = db();
    const [t, c, d, ca, mt, st, inst, co] = await Promise.all([
      fetchTransactions(sb), fetchCardsFull(sb), fetchDebts(sb), fetchCategories(sb), fetchMetrics(sb),
      fetchStatements(sb), fetchInstallments(sb), fetchStatementConsumos(sb),
    ]);
    setTxs(t); setCards(c); setDebts(d); setCats(ca); setMetrics(mt); setStatements(st); setInstallments(inst); setConsumos(co);
    writeCache("resumen", { t, c, d, ca, mt, st, inst, co });
  };
  useEffect(() => {
    // Pintar al instante el último snapshot; lo fresco llega por atrás.
    const s = readCache<{ t: TxView[]; c: CardFull[]; d: DebtView[]; ca: Category[]; mt: Metrics; st: StatementRow[]; inst: InstallmentRow[]; co: Record<number, { ars: number; usd: number }> }>("resumen");
    if (s) { setTxs(s.t); setCards(s.c); setDebts(s.d); setCats(s.ca); setMetrics(s.mt); setStatements(s.st); setInstallments(s.inst); setConsumos(s.co); setLoading(false); }
    reload().finally(() => setLoading(false));
  }, []);

  // Las cotizaciones salen de get_metrics (fuente única: tabla fx_rates).
  const fx = { usd: metrics?.usd_ars ?? FX_FALLBACK.usd, usdt: metrics?.usdt_ars ?? FX_FALLBACK.usdt };
  const data = useMemo(() => compute(txs, cards, debts, installments, statements, consumos, fx), [txs, cards, debts, installments, statements, consumos, fx.usd, fx.usdt]);
  const uncategorized = useMemo(() => txs.filter((t) => t.type === "egreso" && (t.category === "Otros" || !t.categoryId)).slice(0, 6), [txs]);

  const categorize = async (id: number, catId: number) => {
    await updateTxCategory(db(), id, catId);
    await reload();
  };

  // Abrir el chat inline dentro de la barra y enviar el mensaje.
  const submitChat = (text?: string) => {
    const t = (text ?? chat.input).trim();
    if (!t) return;
    setChatActive(true);
    chat.setInput("");
    chat.send(t);
  };
  const closeChat = () => { setChatActive(false); chat.reset(); };
  const onConfirm = (idx: number, p: Parameters<typeof chat.confirm>[1]) => chat.confirm(idx, p, () => { reload(); setTimeout(() => { setChatActive(false); chat.reset(); }, 1600); });
  const dictation = useDictation(chat.setInput, { silenceMs: 3000, onSilence: (t) => submitChat(t) });

  return (
    <>
      <header className="hidden items-end justify-between gap-4 lg:flex">
        <div>
          <p className="text-[0.95rem] text-subtle">Buenas 👋</p>
          <h1 className="mt-0.5 font-display text-[32px] font-bold tracking-[-0.03em] text-fg">Tu resumen</h1>
        </div>
        <div className="flex items-center gap-2.5">
          <PrivacyToggle />
          <button className="grid h-10 w-10 place-items-center rounded-[11px] border border-white/[0.06] bg-white/[0.06] text-subtle transition-colors hover:border-white/[0.14] hover:text-fg"><Search className="h-[18px] w-[18px]" /></button>
          <button className="relative grid h-10 w-10 place-items-center rounded-[11px] border border-white/[0.06] bg-white/[0.06] text-subtle transition-colors hover:border-white/[0.14] hover:text-fg">
            <Bell className="h-[18px] w-[18px]" />
            <span className="absolute right-[9px] top-[9px] h-[7px] w-[7px] rounded-full bg-coral pulse-dot" />
          </button>
        </div>
      </header>

      {/* AI command bar — el chat se despliega DENTRO de la misma barra */}
      <section className="rise mt-0 lg:mt-6">
        <div className={`ai-glow rounded-2xl p-4 transition-all duration-500 sm:p-5 ${chatActive ? "ring-1 ring-accent/25" : ""}`}>
          <div className="flex items-center gap-2 text-accent">
            <Sparkle className="h-[18px] w-[18px]" />
            <span className="text-xs font-medium uppercase tracking-[0.18em]">Asistente</span>
            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-accent pulse-dot" />
            {chatActive && <button onClick={closeChat} className="ml-auto flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[0.7rem] text-subtle transition-colors hover:text-fg"><X className="h-3.5 w-3.5" /> Cerrar</button>}
          </div>

          {chatActive && (
            <div className="mt-4 max-h-[52vh] overflow-y-auto pr-1">
              <MessageList chat={chat} onConfirm={onConfirm} />
            </div>
          )}

          <div className="mt-3 flex items-center gap-3">
            <input value={chat.input} onChange={(e) => chat.setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitChat(); } }} placeholder={dictation.listening ? "Escuchando… (envío a los 3s de silencio)" : chatActive ? "Seguí contándome…" : "Escribí o dictá un gasto… ej: «gasté 5.600 en café»"} className="w-full bg-transparent text-[1.05rem] text-fg outline-none placeholder:text-faint" />
            <div className="flex items-center gap-1.5">
              {!chatActive && <IconBtn title="Subir ticket (OCR)"><Camera className="h-[18px] w-[18px]" /></IconBtn>}
              <button onClick={dictation.toggle} title={dictation.supported ? (dictation.listening ? "Detener" : "Dictar por voz") : "Tu navegador no soporta dictado"} className={`grid h-10 w-10 place-items-center rounded-xl transition-colors ${dictation.listening ? "bg-coral/20 text-coral" : "text-faint hover:bg-white/[0.07] hover:text-accent"} ${dictation.supported ? "" : "opacity-40"}`}>
                <Mic className={`h-[18px] w-[18px] ${dictation.listening ? "pulse-dot" : ""}`} />
              </button>
              <button onClick={() => submitChat()} disabled={chat.loading || !chat.input.trim()} title="Enviar al asistente" className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent to-sky text-bg transition-transform hover:scale-105 disabled:opacity-40"><Send className="h-[18px] w-[18px]" /></button>
            </div>
          </div>

          {!chatActive && (
            <div className="mt-3 flex flex-wrap gap-2">
              {chips.map((c) => <button key={c} onClick={() => submitChat(c)} className="chip px-3 py-1.5 text-xs text-muted">{c}</button>)}
            </div>
          )}
        </div>
      </section>

      <div className={`transition-all duration-500 ease-out ${chatActive ? "pointer-events-none max-h-0 translate-y-10 overflow-hidden opacity-0" : "max-h-[6000px] translate-y-0 opacity-100"}`}>
      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="flex flex-col gap-5 xl:col-span-2">
          <SaldosHero metrics={metrics} loading={loading} />
          <CashflowCard cashflow={data.cashflow} />
          <RecentTransactions txs={data.recent} loading={loading} count={txs.length} />
        </div>
        <div className="flex flex-col gap-5">
          <CategoryCard cats={data.categories} />
          <CardsStrip cards={data.cardSummaries} />
          <UncategorizedCard items={uncategorized} cats={cats} onCategorize={categorize} />
          <DebtsCard toCollect={data.toCollect} toPay={data.toPay} people={data.people} />
        </div>
      </div>
      </div>
    </>
  );
}

type Computed = ReturnType<typeof compute>;
function compute(txs: TxView[], cards: CardFull[], debts: DebtView[], installments: InstallmentRow[], statements: StatementRow[], consumos: Record<number, { ars: number; usd: number }>, fx: { usd: number; usdt: number }) {
  const now = new Date();
  const inMonth = (iso: string, y: number, m: number) => { const d = new Date(iso); return d.getFullYear() === y && d.getMonth() === m; };
  const past = txs.filter((t) => new Date(t.occurredAt) <= now);
  const refDate = past.length ? new Date(Math.max(...past.map((t) => +new Date(t.occurredAt)))) : now;
  const refY = refDate.getFullYear(), refM = refDate.getMonth();
  const monthTxs = txs.filter((t) => inMonth(t.occurredAt, refY, refM));

  // Préstamos y cambios de divisa no son gasto/ingreso real → fuera de flujo y dona.
  const flujo = (t: TxView) => t.category !== "Préstamos" && t.category !== "Cambio Divisas";
  // Cada movimiento se valúa con la cotización congelada de su día (arsDe), no con la de
  // hoy: así los meses cerrados del gráfico dejan de moverse cuando cambia el dólar.
  const toArsTx = (t: TxView) => arsDe(t.amount, t.currency, t.fxRate, { usd: fx.usd, usdt: fx.usdt, day: null });
  const cashflow = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(refY, refM - i, 1);
    const mt = txs.filter((t) => inMonth(t.occurredAt, d.getFullYear(), d.getMonth()) && flujo(t));
    cashflow.push({ m: SHORT[d.getMonth()], in: mt.filter((t) => t.type === "ingreso").reduce((a, t) => a + toArsTx(t), 0), out: mt.filter((t) => t.type === "egreso").reduce((a, t) => a + toArsTx(t), 0) });
  }

  const catMap = new Map<string, { emoji: string; amount: number }>();
  for (const t of monthTxs.filter((t) => t.type === "egreso" && flujo(t))) {
    const e = catMap.get(t.category) ?? { emoji: t.emoji, amount: 0 };
    e.amount += toArsTx(t); catMap.set(t.category, e);
  }
  // Sumar las cuotas de tarjeta del mes a su categoría (Kennedy→Educación, etc.), si el mes de ref es el actual.
  const nowD = new Date();
  if (refY === nowD.getFullYear() && refM === nowD.getMonth()) {
    for (const q of installments) {
      const e = catMap.get(q.category) ?? { emoji: q.catEmoji, amount: 0 };
      e.amount += q.monthly; catMap.set(q.category, e);
    }
  }
  let catArr = [...catMap.entries()].map(([name, v]) => ({ name, emoji: v.emoji, amount: v.amount })).sort((a, b) => b.amount - a.amount);
  if (catArr.length > 7) { const top = catArr.slice(0, 6); const rest = catArr.slice(6).reduce((s, x) => s + x.amount, 0); top.push({ name: "Resto", emoji: "•", amount: rest }); catArr = top; }
  const categories = catArr.map((c, i) => ({ ...c, color: CAT_COLORS[i % CAT_COLORS.length] }));

  const today = new Date();
  const cardSummaries = cards.map((c) => {
    const isDebit = (c.network ?? "").toLowerCase().includes("déb") || (c.network ?? "").toLowerCase().includes("deb");
    let spent: number;
    let label: string;
    if (isDebit) {
      spent = monthTxs.filter((t) => t.type === "egreso" && t.card === c.name).reduce((a, t) => a + t.amount, 0);
      label = "Gasto del mes";
    } else {
      // crédito: estimado del resumen abierto = cuotas + consumos posteados
      const cuotasSum = installments.filter((i) => i.cardId === c.id).reduce((a, q) => a + q.monthly, 0);
      const open = statements.filter((s) => s.cardId === c.id).find((s) => s.closingRaw && new Date(s.closingRaw) > today);
      spent = cuotasSum + (open ? consumos[open.id]?.ars ?? 0 : 0);
      label = "Resumen en curso";
    }
    return { name: c.name, bank: c.bank ?? "", network: c.network ?? "", last4: c.last4 ?? "----", spentArs: spent, label, limitArs: c.limitArs, closeDay: c.closeDay, dueDay: c.dueDay };
  });

  const pending = debts.filter((d) => d.status === "pending");
  const debtArs = (d: DebtView) => (d.currency === "USD" ? d.outstanding * fx.usd : d.currency === "USDT" ? d.outstanding * fx.usdt : d.outstanding);
  const toCollect = pending.filter((d) => d.direction === "to_collect").reduce((a, d) => a + debtArs(d), 0);
  const toPay = pending.filter((d) => d.direction === "to_pay").reduce((a, d) => a + debtArs(d), 0);
  const people = pending.slice(0, 3).map((d) => ({ name: d.person, emoji: d.emoji, amount: debtArs(d), type: d.direction, note: d.description }));

  return { monthLabel: SHORT[refM], cashflow, categories, recent: txs.slice(0, 6), cardSummaries, toCollect, toPay, people };
}

function IconBtn({ children, title }: { children: React.ReactNode; title: string }) {
  return <button title={title} className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.06] text-subtle transition-colors hover:text-fg">{children}</button>;
}

const SALDO_TABS = [
  { key: "ars", label: "Pesos" },
  { key: "usd", label: "Dólares" },
  { key: "usdt", label: "USDT" },
] as const;

function SaldosHero({ metrics, loading }: { metrics: Metrics | null; loading: boolean }) {
  // Qué saldo se muestra en grande. Es solo una vista: los tres números salen
  // de get_metrics igual, no se recalcula nada al cambiar de pestaña.
  const [tab, setTab] = useState<"ars" | "usd" | "usdt">("ars");
  if (loading || !metrics) return <section className="panel p-6"><p className="text-sm text-muted">Cargando saldos…</p></section>;
  const usdArs = metrics.usd_liquido * metrics.usd_ars;
  const usdtArs = metrics.usdt_liquido * metrics.usdt_ars;
  const patrimonio = metrics.ars_liquido + usdArs + usdtArs + metrics.te_deben - metrics.deuda_cuotas_ars - metrics.deuda_vencida_ars - metrics.debes;

  const hero =
    tab === "ars" ? { value: metrics.ars_liquido, format: ars, sub: "en pesos, disponible hoy" }
    : tab === "usd" ? { value: metrics.usd_liquido, format: fmtUsd, sub: `≈ ${ars(usdArs)} al blue de hoy` }
    : { value: metrics.usdt_liquido, format: fmtUsdt, sub: `≈ ${ars(usdtArs)} al cripto de hoy` };

  return (
    <section className="rise panel relative overflow-hidden p-6">
      <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-accent/15 blur-3xl" />
      <div className="relative flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-accent" />
          <span className="label-micro">Saldo total</span>
        </div>
        <div className="flex rounded-full border border-white/10 bg-white/[0.06] p-0.5 text-xs">
          {SALDO_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3 py-1 transition-colors ${tab === t.key ? "bg-accent text-bg" : "text-subtle hover:text-fg"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <CountUp
        key={tab}
        value={hero.value}
        format={hero.format}
        className="tnum relative mt-2 block text-[36px] font-extrabold leading-none text-fg sm:text-[44px]"
      />
      <p className="relative mt-2 text-sm text-faint">{hero.sub}</p>
      <div className="relative mt-6 grid grid-cols-2 gap-3.5 sm:grid-cols-3">
        <SaldoStat label="Dólares" value={metrics.usd_liquido} format={fmtUsd} sub={`≈ ${compact(usdArs)}`} accent="text-gold" />
        <SaldoStat label="USDT" value={metrics.usdt_liquido} format={fmtUsdt} sub={`≈ ${compact(usdtArs)}`} accent="text-sky" />
        <SaldoStat label="Patrimonio neto" value={patrimonio} format={compact} sub="todo valuado en ARS" accent="text-fg" />
      </div>
    </section>
  );
}
function SaldoStat({ label, value, format, sub, accent }: { label: string; value: number; format: (n: number) => string; sub: string; accent: string }) {
  return (
    <div className="panel-inner p-4">
      <p className="label-micro">{label}</p>
      <CountUp value={value} format={format} className={`tnum mt-1.5 block text-[19px] font-semibold ${accent}`} />
      <p className="tnum mt-0.5 text-[0.7rem] text-faint">{sub}</p>
    </div>
  );
}

function CashflowCard({ cashflow }: { cashflow: Computed["cashflow"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...cashflow.flatMap((c) => [c.in, c.out]), 1);
  // 4 líneas de referencia: dan escala sin necesidad de un eje completo.
  const steps = [1, 0.75, 0.5, 0.25];
  const H = 176;
  const sel = hover != null ? cashflow[hover] : null;
  return (
    <section className="rise panel p-6">
      <CardHeader title="Flujo de caja" subtitle="Últimos 6 meses"><Legend /></CardHeader>
      <div className="relative mt-6 flex gap-3">
        {/* escala */}
        <div className="flex w-11 shrink-0 flex-col justify-between" style={{ height: H }}>
          {steps.map((s) => (
            <span key={s} className="tnum -mt-1.5 text-right text-[0.6rem] leading-none text-faint">{compact(max * s)}</span>
          ))}
        </div>
        <div className="relative flex-1">
          {/* gridlines */}
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: H }}>
            {steps.map((s) => (
              <div key={s} className="absolute inset-x-0 border-t border-white/[0.06]" style={{ top: `${(1 - s) * 100}%` }} />
            ))}
            <div className="absolute inset-x-0 bottom-0 border-t border-white/[0.10]" />
          </div>
          {sel && hover != null && (
            <div
              className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-[11px] border border-white/[0.18] bg-[#0d0e0e]/95 px-2.5 py-1.5 text-xs shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
              style={{ left: `${((hover + 0.5) / cashflow.length) * 100}%`, top: H - (Math.max(sel.in, sel.out) / max) * H - 8 }}
            >
              <p className="mb-0.5 text-subtle">{sel.m}</p>
              <p className="tnum text-emerald">+{compact(sel.in)}</p>
              <p className="tnum text-coral">−{compact(sel.out)}</p>
            </div>
          )}
          <div className="relative flex items-end" style={{ height: H }}>
            {cashflow.map((c, i) => (
              <div
                key={i}
                className="flex flex-1 flex-col items-center justify-end"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ height: H, opacity: hover == null || hover === i ? 1 : 0.45, transition: "opacity .15s ease" }}
              >
                <div className="flex w-full items-end justify-center gap-1.5" style={{ height: H }}>
                  <span className="grow-bar w-1/2 max-w-5 rounded-t-md bg-gradient-to-t from-emerald/40 to-emerald" style={{ height: `${(c.in / max) * 100}%`, animationDelay: `${i * 80}ms` }} />
                  <span className="grow-bar w-1/2 max-w-5 rounded-t-md bg-gradient-to-t from-coral/30 to-coral/80" style={{ height: `${(c.out / max) * 100}%`, animationDelay: `${i * 80 + 40}ms` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex">
            {cashflow.map((c, i) => (
              <span key={i} className="tnum flex-1 text-center text-[0.65rem] text-faint">{c.m}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted">
      <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-emerald" /> Ingresos</span>
      <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-coral/80" /> Egresos</span>
    </div>
  );
}

function CategoryCard({ cats }: { cats: Computed["categories"] }) {
  const total = cats.reduce((a, c) => a + c.amount, 0);
  const gradient = useMemo(() => {
    if (!total) return "conic-gradient(var(--color-surface-3) 0% 100%)";
    let acc = 0;
    const stops = cats.map((c) => { const s = (acc / total) * 100; acc += c.amount; return `${c.color} ${s}% ${(acc / total) * 100}%`; });
    return `conic-gradient(${stops.join(", ")})`;
  }, [cats, total]);
  return (
    <section className="rise panel p-6">
      <CardHeader title="Gastos por categoría" subtitle="del mes" />
      <div className="mt-5 flex items-center gap-6">
        <div className="relative h-32 w-32 shrink-0">
          <div className="h-full w-full rounded-full" style={{ background: gradient }} />
          {/* El centro va con el color del vidrio, no con bg-bg: un negro opaco
              acá se ve como un agujero dentro de la card translúcida. */}
          <div className="absolute inset-[14px] grid place-items-center rounded-full bg-[#131414]/85 text-center backdrop-blur-sm"><div><p className="label-micro">Total</p><p className="tnum text-sm font-semibold text-fg">{compact(total)}</p></div></div>
        </div>
        <ul className="flex-1 space-y-2">
          {cats.length === 0 && <li className="text-sm text-muted">Sin gastos este mes.</li>}
          {cats.slice(0, 5).map((c) => (
            <li key={c.name} className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
              <span className="text-muted">{c.emoji} {c.name}</span>
              <span className="tnum ml-auto text-fg">{compact(c.amount)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function RecentTransactions({ txs, loading, count }: { txs: TxView[]; loading: boolean; count: number }) {
  return (
    <section className="rise panel p-6">
      <CardHeader title="Movimientos recientes" subtitle={loading ? "Cargando…" : `${count} en total`}>
        <a href="/transacciones" className="flex items-center gap-1 text-sm text-accent hover:underline">Ver todo</a>
      </CardHeader>
      <ul className="mt-4 divide-y divide-line">
        {txs.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.06] text-lg">{t.emoji}</span>
            <div className="min-w-0"><p className="truncate text-[0.95rem] text-fg">{t.desc}</p><p className="truncate text-xs text-faint">{t.date} · {t.method}{t.card ? ` · ${t.card}` : ""}</p></div>
            <div className="ml-auto flex items-center gap-3">
              <SourceTag source={t.source} />
              <span className={`tnum text-[0.95rem] ${t.type === "ingreso" ? "text-emerald" : "text-fg"}`}>{t.type === "ingreso" ? "+" : "−"}{ars(t.amount).replace("$", "$ ")}</span>
            </div>
          </li>
        ))}
        {!loading && txs.length === 0 && <li className="py-6 text-center text-sm text-muted">Sin movimientos todavía.</li>}
      </ul>
    </section>
  );
}
function SourceTag({ source }: { source: string }) {
  const map: Record<string, { label: string; Icon: typeof Camera; cls: string }> = {
    ocr: { label: "OCR", Icon: Camera, cls: "text-sky" }, email: { label: "Email", Icon: Mail, cls: "text-amber" },
    chat: { label: "Chat", Icon: Sparkle, cls: "text-accent" }, manual: { label: "Manual", Icon: Plus, cls: "text-faint" },
  };
  const it = map[source] ?? map.manual;
  return <span className={`hidden items-center gap-1 rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[0.65rem] sm:flex ${it.cls}`}><it.Icon className="h-3 w-3" /> {it.label}</span>;
}

function CardsStrip({ cards }: { cards: Computed["cardSummaries"] }) {
  return (
    <section className="rise panel p-6">
      <CardHeader title="Tarjetas" subtitle={`${cards.length} activas`}>
        <a href="/tarjetas" className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-white/[0.06] text-subtle hover:text-fg"><Plus className="h-4 w-4" /></a>
      </CardHeader>
      <div className="mt-4 space-y-3">
        {cards.map((c) => {
          const pct = c.limitArs ? Math.min(100, Math.round((c.spentArs / c.limitArs) * 100)) : 0;
          return (
            <div key={c.last4} className="panel-inner p-4">
              <div className="flex items-start justify-between">
                <div><p className="text-sm text-fg">{c.name}</p><p className="text-xs text-faint">{c.bank} · {c.network} ···· {c.last4}</p></div>
                <CardIcon className="h-5 w-5 text-subtle" />
              </div>
              <div className="mt-4 flex items-end justify-between">
                <div><p className="label-micro">{c.label}</p><p className="tnum text-[17px] font-semibold text-fg">{ars(c.spentArs)}</p></div>
                <p className="tnum text-xs text-faint">{c.closeDay ? `Cierra ${c.closeDay}` : ""}{c.dueDay ? ` · Vence ${c.dueDay}` : ""}</p>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-gradient-to-r from-accent to-gold" style={{ width: `${pct}%` }} /></div>
            </div>
          );
        })}
        {cards.length === 0 && <p className="text-sm text-muted">Sin tarjetas.</p>}
      </div>
    </section>
  );
}

function UncategorizedCard({ items, cats, onCategorize }: { items: TxView[]; cats: Category[]; onCategorize: (id: number, catId: number) => Promise<void> }) {
  const options = cats.filter((c) => c.name !== "Otros");
  return (
    <section className="rise panel p-6">
      <CardHeader title="Sin categorizar" subtitle={items.length ? `${items.length} en "Otros"` : "todo clasificado"} />
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-muted">¡Todo categorizado! ✅</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-faint">Asignales una categoría para mejorar tus métricas 👇</p>
          <ul className="mt-3 space-y-3">
            {items.map((t) => (
              <li key={t.id} className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.06] text-base">{t.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{t.desc}</p>
                  <p className="tnum text-xs text-faint">{t.date.split(" · ")[0]} · {ars(t.amount)}</p>
                </div>
                <div className="relative shrink-0">
                  <select defaultValue="" onChange={(e) => e.target.value && onCategorize(t.id, Number(e.target.value))} className="appearance-none rounded-lg border border-white/10 bg-white/[0.06] py-1.5 pl-2.5 pr-7 text-xs text-fg outline-none focus:border-accent/40">
                    <option value="">Categoría…</option>
                    {options.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
                  </select>
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[0.6rem] text-faint">▾</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function DebtsCard({ toCollect, toPay, people }: { toCollect: number; toPay: number; people: Computed["people"] }) {
  return (
    <section className="rise panel p-6">
      <CardHeader title="Deudas" subtitle="A cobrar y a pagar" />
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="panel-inner border-emerald/25 bg-emerald/10 p-3"><p className="text-xs text-muted">Te deben</p><p className="tnum mt-1 text-emerald">{ars(toCollect)}</p></div>
        <div className="panel-inner border-coral/25 bg-coral/10 p-3"><p className="text-xs text-muted">Debés</p><p className="tnum mt-1 text-coral">{ars(toPay)}</p></div>
      </div>
      <ul className="mt-4 space-y-2.5">
        {people.map((p, i) => (
          <li key={i} className="flex items-center gap-2.5 text-sm">
            <span className="grid h-8 w-8 place-items-center rounded-full border border-white/10 bg-white/[0.06]">{p.emoji}</span>
            <div className="leading-tight"><p className="text-fg">{p.name}</p><p className="text-xs text-faint">{p.note}</p></div>
            <span className={`tnum ml-auto ${p.type === "to_collect" ? "text-emerald" : "text-coral"}`}>{p.type === "to_collect" ? "+" : "−"}{compact(p.amount)}</span>
          </li>
        ))}
        {people.length === 0 && <li className="text-sm text-muted">Sin deudas pendientes.</li>}
      </ul>
    </section>
  );
}

function CardHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="font-display text-lg text-fg">{title}</h2>{subtitle && <p className="text-xs text-faint">{subtitle}</p>}</div>
      {children}
    </div>
  );
}
