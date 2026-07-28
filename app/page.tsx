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

const chips = [
  "Gasté 18.500 en delivery con la Galicia",
  "¿Cuánto gasté en Compras este mes?",
  "Cobré el alquiler de Chañar II",
];
const SHORT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const CAT_COLORS = ["#c8ff4d", "#34e1a0", "#5ec8ff", "#a78bfa", "#ff9f5e", "#6b7080"];

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
      <header className="hidden items-center justify-between gap-4 lg:flex">
        <div>
          <p className="text-sm text-muted">Buenas 👋</p>
          <h1 className="font-display text-2xl text-fg">Tu resumen</h1>
        </div>
        <div className="flex items-center gap-2">
          <PrivacyToggle />
          <button className="flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3.5 py-2 text-sm text-muted transition-colors hover:text-fg"><Search className="h-4 w-4" /> Buscar</button>
          <button className="relative grid h-10 w-10 place-items-center rounded-full border border-line bg-surface/70 text-muted transition-colors hover:text-fg">
            <Bell className="h-[18px] w-[18px]" />
            <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-coral pulse-dot" />
          </button>
        </div>
      </header>

      {/* AI command bar — el chat se despliega DENTRO de la misma barra */}
      <section className="rise mt-0 lg:mt-6">
        <div className={`ai-glow rounded-2xl p-4 transition-all duration-500 sm:p-5 ${chatActive ? "ring-1 ring-violet/25" : ""}`}>
          <div className="flex items-center gap-2 text-violet">
            <Sparkle className="h-[18px] w-[18px]" />
            <span className="text-xs font-medium uppercase tracking-[0.18em]">Asistente</span>
            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-violet pulse-dot" />
            {chatActive && <button onClick={closeChat} className="ml-auto flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[0.7rem] text-muted transition-colors hover:text-fg"><X className="h-3.5 w-3.5" /> Cerrar</button>}
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
              <button onClick={dictation.toggle} title={dictation.supported ? (dictation.listening ? "Detener" : "Dictar por voz") : "Tu navegador no soporta dictado"} className={`grid h-10 w-10 place-items-center rounded-xl transition-colors ${dictation.listening ? "bg-coral/20 text-coral" : "text-faint hover:bg-surface-2 hover:text-violet"} ${dictation.supported ? "" : "opacity-40"}`}>
                <Mic className={`h-[18px] w-[18px] ${dictation.listening ? "pulse-dot" : ""}`} />
              </button>
              <button onClick={() => submitChat()} disabled={chat.loading || !chat.input.trim()} title="Enviar al asistente" className="grid h-10 w-10 place-items-center rounded-xl bg-violet text-bg transition-transform hover:scale-105 disabled:opacity-40"><Send className="h-[18px] w-[18px]" /></button>
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
  return <button title={title} className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-surface-2 text-muted transition-colors hover:text-fg">{children}</button>;
}

function SaldosHero({ metrics, loading }: { metrics: Metrics | null; loading: boolean }) {
  if (loading || !metrics) return <section className="panel p-6"><p className="text-sm text-muted">Cargando saldos…</p></section>;
  const usdArs = metrics.usd_liquido * metrics.usd_ars;
  const usdtArs = metrics.usdt_liquido * metrics.usdt_ars;
  const patrimonio = metrics.ars_liquido + usdArs + usdtArs + metrics.te_deben - metrics.deuda_cuotas_ars - metrics.deuda_vencida_ars - metrics.debes;
  return (
    <section className="rise panel relative overflow-hidden p-6">
      <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-lime/10 blur-3xl" />
      <div className="relative flex items-center gap-2 text-sm text-muted"><Coins className="h-4 w-4 text-lime" /> Saldos actuales</div>
      <p className="relative mt-1 font-display text-4xl text-fg sm:text-5xl"><span className="tnum">{ars(metrics.ars_liquido)}</span> <span className="text-base text-faint">en pesos</span></p>
      <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SaldoStat label="Dólares" main={`US$ ${metrics.usd_liquido.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`} sub={`≈ ${compact(usdArs)}`} accent="text-emerald" />
        <SaldoStat label="USDT" main={`${metrics.usdt_liquido.toLocaleString("es-AR")} USDT`} sub={`≈ ${compact(usdtArs)}`} accent="text-sky" />
        <SaldoStat label="Patrimonio neto" main={compact(patrimonio)} sub="todo valuado en ARS" accent="text-lime" />
      </div>
    </section>
  );
}
function SaldoStat({ label, main, sub, accent }: { label: string; main: string; sub: string; accent: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface-2/50 p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`tnum mt-1 text-lg ${accent}`}>{main}</p>
      <p className="mt-0.5 text-[0.7rem] text-faint">{sub}</p>
    </div>
  );
}

function CashflowCard({ cashflow }: { cashflow: Computed["cashflow"] }) {
  const max = Math.max(...cashflow.flatMap((c) => [c.in, c.out]), 1);
  return (
    <section className="rise panel p-6">
      <CardHeader title="Flujo de caja" subtitle="Últimos 6 meses"><Legend /></CardHeader>
      <div className="mt-6 flex items-end justify-between gap-3 sm:gap-5">
        {cashflow.map((c, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-2">
            <div className="flex h-44 w-full items-end justify-center gap-1.5">
              <span className="grow-bar w-1/2 max-w-5 rounded-t-md bg-gradient-to-t from-emerald/40 to-emerald" style={{ height: `${(c.in / max) * 100}%`, animationDelay: `${i * 80}ms` }} />
              <span className="grow-bar w-1/2 max-w-5 rounded-t-md bg-gradient-to-t from-coral/30 to-coral/80" style={{ height: `${(c.out / max) * 100}%`, animationDelay: `${i * 80 + 40}ms` }} />
            </div>
            <span className="text-xs text-faint">{c.m}</span>
          </div>
        ))}
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
          <div className="absolute inset-[14px] grid place-items-center rounded-full bg-bg text-center"><div><p className="text-[0.6rem] uppercase tracking-widest text-faint">Total</p><p className="tnum text-sm text-fg">{compact(total)}</p></div></div>
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
        <a href="/transacciones" className="flex items-center gap-1 text-sm text-lime hover:underline">Ver todo</a>
      </CardHeader>
      <ul className="mt-4 divide-y divide-line">
        {txs.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-lg">{t.emoji}</span>
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
    chat: { label: "Chat", Icon: Sparkle, cls: "text-violet" }, manual: { label: "Manual", Icon: Plus, cls: "text-faint" },
  };
  const it = map[source] ?? map.manual;
  return <span className={`hidden items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[0.65rem] sm:flex ${it.cls}`}><it.Icon className="h-3 w-3" /> {it.label}</span>;
}

function CardsStrip({ cards }: { cards: Computed["cardSummaries"] }) {
  return (
    <section className="rise panel p-6">
      <CardHeader title="Tarjetas" subtitle={`${cards.length} activas`}>
        <a href="/tarjetas" className="grid h-7 w-7 place-items-center rounded-lg border border-line text-muted hover:text-fg"><Plus className="h-4 w-4" /></a>
      </CardHeader>
      <div className="mt-4 space-y-3">
        {cards.map((c) => {
          const pct = c.limitArs ? Math.min(100, Math.round((c.spentArs / c.limitArs) * 100)) : 0;
          return (
            <div key={c.last4} className="rounded-2xl border border-line bg-gradient-to-br from-[#161922] to-[#0e1016] p-4">
              <div className="flex items-start justify-between">
                <div><p className="text-sm text-fg">{c.name}</p><p className="text-xs text-faint">{c.bank} · {c.network} ···· {c.last4}</p></div>
                <CardIcon className="h-5 w-5 text-muted" />
              </div>
              <div className="mt-4 flex items-end justify-between">
                <div><p className="text-[0.65rem] uppercase tracking-widest text-faint">{c.label}</p><p className="tnum text-fg">{ars(c.spentArs)}</p></div>
                <p className="text-xs text-faint">{c.closeDay ? `Cierra ${c.closeDay}` : ""}{c.dueDay ? ` · Vence ${c.dueDay}` : ""}</p>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/40"><div className="h-full rounded-full bg-gradient-to-r from-lime to-emerald" style={{ width: `${pct}%` }} /></div>
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
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-base">{t.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg">{t.desc}</p>
                  <p className="text-xs text-faint">{t.date.split(" · ")[0]} · {ars(t.amount)}</p>
                </div>
                <div className="relative shrink-0">
                  <select defaultValue="" onChange={(e) => e.target.value && onCategorize(t.id, Number(e.target.value))} className="appearance-none rounded-lg border border-line bg-surface-2 py-1.5 pl-2.5 pr-7 text-xs text-fg outline-none focus:border-lime/40">
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
        <div className="rounded-2xl border border-line bg-emerald/8 p-3"><p className="text-xs text-muted">Te deben</p><p className="tnum mt-1 text-emerald">{ars(toCollect)}</p></div>
        <div className="rounded-2xl border border-line bg-coral/8 p-3"><p className="text-xs text-muted">Debés</p><p className="tnum mt-1 text-coral">{ars(toPay)}</p></div>
      </div>
      <ul className="mt-4 space-y-2.5">
        {people.map((p, i) => (
          <li key={i} className="flex items-center gap-2.5 text-sm">
            <span className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface-2">{p.emoji}</span>
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
