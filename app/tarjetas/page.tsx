"use client";

import { useEffect, useState } from "react";
import { db, fetchCardsFull, fetchStatements, fetchInstallments, fetchStatementConsumos, fetchStatementMovements, fetchPlansForProjection, payStatement, ensureNextStatements, formatShort, type CardFull, type StatementRow, type InstallmentRow, type StatementMovement, type PlanProj } from "@/lib/db";
import { fetchCardCharges, detectarSubs, subsTotals, type CardSub } from "@/lib/subs";
import { readCache, writeCache } from "@/lib/cache";
import CardModal from "../components/CardModal";
import { fxSync, loadFx } from "@/lib/fx";
import { ars, usd, compact } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import CountUp from "../components/CountUp";
import { Donut, type Slice } from "../components/charts";
import EditPlanModal from "../components/EditPlanModal";
import EditDatesModal from "../components/EditDatesModal";
import { Plus, Card as CardIcon, ArrowUpRight, Pencil, Chevron } from "../icons";

// Cotización para valuar consumos en USD dentro del desglose (fuente: fx_rates).
const monthsBetweenYM = (a: string, b: string) => { const [ay, am] = a.slice(0, 7).split("-").map(Number); const [by, bm] = b.slice(0, 7).split("-").map(Number); return (by - ay) * 12 + (bm - am); };
// Suma k meses a un período "YYYY-MM" y devuelve "YYYY-MM".
const addMonthsYM = (ym: string, k: number) => { const [y, m] = ym.slice(0, 7).split("-").map(Number); const d = new Date(y, (m - 1) + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
// Parsear 'YYYY-MM-DD' en LOCAL (new Date(iso) parsea UTC y corre el día en ART).
const parseYMD = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const daysInYM = (ym: string) => { const [y, m] = ym.slice(0, 7).split("-").map(Number); return new Date(y, m, 0).getDate(); };
// Esta pantalla es de tarjetas de crédito (resúmenes). Ocultamos la débito (solo visual; no se borra nada).
const esCredito = (c: { network?: string | null; name?: string | null }) =>
  !((c.network ?? "").toLowerCase().includes("déb") || (c.network ?? "").toLowerCase().includes("deb") || (c.name ?? "").toLowerCase().includes("débito") || (c.name ?? "").toLowerCase().includes("debito"));

const palette = [
  { hue: "from-[#10231c] via-[#0f2a20] to-[#0a1612]", accent: "#34e1a0" },
  { hue: "from-[#221c3a] via-[#1c1830] to-[#120f1f]", accent: "#a78bfa" },
  { hue: "from-[#0e2230] via-[#0c1b27] to-[#0a141c]", accent: "#5ec8ff" },
  { hue: "from-[#2a2218] via-[#211a12] to-[#15110b]", accent: "#ff9f5e" },
];
type CardVis = CardFull & { hue: string; accent: string };

export default function TarjetasPage() {
  const [cards, setCards] = useState<CardVis[]>([]);
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [installments, setInstallments] = useState<InstallmentRow[]>([]);
  const [consumos, setConsumos] = useState<Record<number, { ars: number; usd: number }>>({});
  const [plans, setPlans] = useState<PlanProj[]>([]);
  // Suscripciones/abonos detectados: los resúmenes que todavía no existen se
  // proyectan con cuotas + esto (si no, un mes futuro mostraría solo las cuotas).
  const [subs, setSubs] = useState<CardSub[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingPlan, setEditingPlan] = useState<InstallmentRow | null>(null);
  const [editingDates, setEditingDates] = useState<StatementRow | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [movements, setMovements] = useState<Record<number, StatementMovement[]>>({});
  const [loadingMov, setLoadingMov] = useState<number | null>(null);
  const [payingId, setPayingId] = useState<number | null>(null);
  // { open, card }: card null = alta, card = edición.
  const [cardModal, setCardModal] = useState<{ open: boolean; card: CardFull | null }>({ open: false, card: null });

  const reloadCuotas = async () => setInstallments(await fetchInstallments(db()));
  const reloadStatements = async () => {
    const sb = db();
    await ensureNextStatements(sb).catch(() => {}); // una tarjeta nueva estrena su primer resumen acá
    const [s, c] = await Promise.all([fetchStatements(sb), fetchCardsFull(sb)]);
    const vis = c.filter(esCredito).map((card, idx) => ({ ...card, ...palette[idx % palette.length] }));
    setStatements(s); setCards(vis);
    setSelectedId((prev) => (prev && vis.some((v) => v.id === prev) ? prev : vis[0]?.id ?? null));
    // Sin esto el snapshot queda viejo y al volver a entrar la tarjeta nueva no está.
    writeCache("tarjetas", { cards: vis, statements: s, installments, consumos, plans, subs });
  };

  const toggleMovements = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (id < 0) { setMovements((prev) => (prev[id] ? prev : { ...prev, [id]: [] })); return; } // proyectado: solo cuotas, sin consumos
    if (!movements[id]) {
      setLoadingMov(id);
      try { const m = await fetchStatementMovements(db(), id); setMovements((prev) => ({ ...prev, [id]: m })); }
      finally { setLoadingMov(null); }
    }
  };
  // Cuotas que caen en un resumen de determinado período (YYYY-MM) de ESA tarjeta.
  const cuotasForPeriod = (period: string, cardId: number) => plans
    .filter((p) => p.cardId === cardId)
    .map((p) => ({ ...p, n: monthsBetweenYM(p.firstMonth, period) + 1 }))
    .filter((p) => p.n >= 1 && p.n <= p.total);

  useEffect(() => {
    type Snap = { cards: CardVis[]; statements: StatementRow[]; installments: InstallmentRow[]; consumos: Record<number, { ars: number; usd: number }>; plans: PlanProj[]; subs: CardSub[] };
    // Pintar al instante el último snapshot conocido; lo fresco llega por atrás.
    const cached = readCache<Snap>("tarjetas");
    if (cached) {
      setCards(cached.cards); setStatements(cached.statements); setInstallments(cached.installments); setConsumos(cached.consumos); setPlans(cached.plans); setSubs(cached.subs ?? []);
      setSelectedId((prev) => prev ?? cached.cards[0]?.id ?? null);
      setLoading(false);
    }
    loadFx();
    (async () => {
      const sb = db();
      const load = async () => {
        const [c, s, i, co, pl, ch] = await Promise.all([fetchCardsFull(sb), fetchStatements(sb), fetchInstallments(sb), fetchStatementConsumos(sb), fetchPlansForProjection(sb), fetchCardCharges(sb)]);
        const vis = c.filter(esCredito).map((card, idx) => ({ ...card, ...palette[idx % palette.length] }));
        const now = new Date();
        const su = detectarSubs(ch, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
        setCards(vis); setStatements(s); setInstallments(i); setConsumos(co); setPlans(pl); setSubs(su);
        setSelectedId((prev) => prev ?? vis[0]?.id ?? null);
        writeCache("tarjetas", { cards: vis, statements: s, installments: i, consumos: co, plans: pl, subs: su } satisfies Snap);
      };
      await load();
      // Fuera del camino crítico: asegurar el próximo resumen; si creó uno, refrescar.
      const created = await ensureNextStatements(sb).catch(() => false);
      if (created) await load();
    })().finally(() => setLoading(false));
  }, []);

  const nuevaTarjetaBtn = (
    <button onClick={() => setCardModal({ open: true, card: null })} className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-bg transition-transform hover:scale-[1.03]">
      <Plus className="h-4 w-4" /> Agregar tarjeta
    </button>
  );

  if (loading) return (<><PageHeader title="Tarjetas" subtitle="Cargando…" /><div className="panel mt-6 p-10 text-center text-sm text-muted">Cargando tarjetas…</div></>);
  // Sin tarjetas también hay que poder crear una (si no, la pantalla queda sin salida).
  if (!cards.length) return (
    <>
      <PageHeader title="Tarjetas" subtitle="Sin tarjetas">{nuevaTarjetaBtn}</PageHeader>
      <div className="panel mt-6 p-10 text-center">
        <p className="text-sm text-muted">Todavía no tenés tarjetas cargadas.</p>
        <button onClick={() => setCardModal({ open: true, card: null })} className="mt-4 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-bg transition-transform hover:scale-[1.03]">Agregar la primera</button>
      </div>
      {cardModal.open && <CardModal card={cardModal.card} onClose={() => setCardModal({ open: false, card: null })} onSaved={reloadStatements} />}
    </>
  );

  const card = cards.find((c) => c.id === selectedId) ?? cards[0];
  const history = statements.filter((s) => s.cardId === card.id);
  // Resumen a pagar = el último cerrado que NO esté pagado. Si están todos pagos, mostramos el próximo (en curso).
  const today = new Date();
  const toPay = history.find((s) => s.closingRaw && parseYMD(s.closingRaw) <= today && !s.paid);
  const current = toPay ?? history.find((s) => s.closingRaw && parseYMD(s.closingRaw) > today) ?? history[0];
  const alDia = !toPay;
  const cuotas = installments.filter((i) => i.cardId === card.id);
  const isOpen = (s: StatementRow) => !!s.closingRaw && parseYMD(s.closingRaw) > today;
  // Cuotas que caen en el período de ese resumen.
  const cuotasForStmt = (s: StatementRow) => cuotasForPeriod(s.period, s.cardId).reduce((a, p) => a + p.monthly, 0);
  // Suscripciones y abonos que se van a repetir. SOLO se suman a los resúmenes
  // PROYECTADOS (id < 0): en uno real, esos consumos entran por el importador de
  // mails, y sumarles la proyección encima los contaría dos veces.
  const subsForCard = (cardId: number) => subsTotals(subs, cardId, fxSync().usd);
  const subsDeStmt = (s: StatementRow) => (s.id < 0 ? subsForCard(s.cardId) : { ars: 0, usd: 0 });
  // Total del resumen: si está PAGADO → el reconciliado (guardado). Si NO (abierto o cerrado sin pagar) → en vivo (consumos + cuotas).
  const stTotal = (s: StatementRow) => (s.paid ? s.totalArs : cuotasForStmt(s) + (consumos[s.id]?.ars ?? 0) + subsDeStmt(s).ars);
  const stUsd = (s: StatementRow) => (s.paid ? s.totalUsd : (consumos[s.id]?.usd ?? 0) + subsDeStmt(s).usd);
  // Pagar: fija el total que se ve en pantalla como reconciliado y marca is_paid (baja del saldo líquido).
  const handlePay = async (s: StatementRow) => {
    if (s.id < 0 || s.paid || payingId != null) return; // proyectados no se pagan
    const total = stTotal(s);
    const totalUsd = stUsd(s);
    const detalle = `${ars(total)}${totalUsd > 0 ? ` + ${usd(totalUsd)}` : ""}`;
    if (!window.confirm(`¿Marcar como pagado el resumen ${s.period} por ${detalle}?\n\nEl total queda fijo y el pago se descuenta del saldo líquido.`)) return;
    setPayingId(s.id);
    try { await payStatement(db(), s.id, total, totalUsd); await reloadStatements(); }
    catch (e) { alert(`No se pudo pagar el resumen: ${e instanceof Error ? e.message : e}`); }
    finally { setPayingId(null); }
  };
  const spent = current ? stTotal(current) : 0;
  const spentUsd = current ? stUsd(current) : 0;
  const usage = card.limitArs ? Math.min(100, Math.round((spent / card.limitArs) * 100)) : 0;

  // ── Resúmenes futuros ──────────────────────────────────────────────
  // Filas reales aún por cerrar (closing > hoy) + proyección de los próximos
  // períodos a partir de las cuotas activas (todavía no existen como resumen).
  const realFuture = history.filter((s) => isOpen(s));
  const anteriores = history.filter((s) => !isOpen(s));
  const lastPeriod = history[0]?.period ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const cardPlans = plans.filter((p) => p.cardId === card.id);
  // Hasta dónde llegan las cuotas activas (mes del último vencimiento, relativo al último resumen).
  const horizon = cardPlans.reduce((mx, p) => Math.max(mx, monthsBetweenYM(lastPeriod, addMonthsYM(p.firstMonth, p.total - 1))), 0);
  const cardSubs = subs.filter((s) => s.cardId === card.id);
  // Con suscripciones detectadas hay algo que proyectar aunque no queden cuotas:
  // mostramos 3 meses en vez de 1 para que se vea el patrón mensual.
  const futureCount = Math.min(6, Math.max(cardSubs.length ? 3 : 1, horizon));
  const closeDay = card.closeDay ?? (Number((current?.closingRaw ?? "").slice(8, 10)) || 25);
  const dueDay = card.dueDay ?? (Number((current?.dueRaw ?? "").slice(8, 10)) || 6);
  const existingPeriods = new Set(history.map((h) => h.period));
  const projected: StatementRow[] = Array.from({ length: futureCount }, (_, idx) => {
    const period = addMonthsYM(lastPeriod, idx + 1);
    const closingRaw = `${period}-${String(Math.min(closeDay, daysInYM(period))).padStart(2, "0")}`;
    const dueMonth = dueDay < closeDay ? addMonthsYM(period, 1) : period;
    const dueRaw = `${dueMonth}-${String(Math.min(dueDay, daysInYM(dueMonth))).padStart(2, "0")}`;
    return { id: -(card.id * 100 + idx + 1), cardId: card.id, period, closing: formatShort(closingRaw), due: formatShort(dueRaw), closingRaw, dueRaw, paid: false, totalArs: 0, totalUsd: 0, fxRate: null };
  }).filter((p) => !existingPeriods.has(p.period)); // no duplicar períodos que ya existen como fila real
  const futuros = [...realFuture, ...projected].sort((a, b) => a.period.localeCompare(b.period));

  // Render de una fila de resumen (compartido entre futuros y anteriores).
  const renderStmt = (s: StatementRow) => {
    const projectedRow = s.id < 0;
    const open = projectedRow || isOpen(s);
    const exp = expandedId === s.id;
    return (
      <li key={s.id} className="border-b border-line last:border-0">
        <div onClick={() => toggleMovements(s.id)} className={`flex cursor-pointer items-center gap-3 rounded-xl px-1.5 py-3 transition-colors hover:bg-white/[0.04] ${exp ? "bg-white/[0.03]" : ""}`}>
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.06]"><CardIcon className="h-5 w-5 text-muted" /></span>
          <div>
            <p className="flex items-center gap-2 text-[0.95rem] text-fg">
              {s.period}
              {projectedRow ? <span className="rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[0.6rem] text-accent">próximo</span>
                : open && <span className="rounded-full border border-sky/30 bg-sky/10 px-1.5 py-0.5 text-[0.6rem] text-sky">en curso</span>}
            </p>
            <p className="text-xs text-faint">Cierre {s.closing} · Vence {s.due}</p>
          </div>
          <div className="ml-auto text-right">
            <p className="tnum text-[0.95rem] text-fg">{ars(stTotal(s))}</p>
            <p className="text-xs text-faint">+ {usd(stUsd(s))}{projectedRow ? " · proyectado" : open ? " · estimado" : ""}</p>
          </div>
          {projectedRow ? <span className="ml-2 hidden rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[0.65rem] text-accent sm:inline">Proyectado</span>
            : open ? <span className="ml-2 hidden rounded-full border border-sky/30 bg-sky/10 px-2.5 py-1 text-[0.65rem] text-sky sm:inline">Estimado</span>
            : <StatusBadge paid={s.paid} paying={payingId === s.id} onPay={() => handlePay(s)} />}
          <Chevron className={`h-4 w-4 shrink-0 text-faint transition-transform ${exp ? "rotate-180 text-accent" : ""}`} />
        </div>
        {exp && <MovementsPanel statement={s} consumos={movements[s.id]} cuotas={cuotasForPeriod(s.period, s.cardId)} subs={s.id < 0 ? subs.filter((x) => x.cardId === s.cardId) : []} loading={loadingMov === s.id} open={open} />}
      </li>
    );
  };

  // Datos del gráfico "Totales por mes": TODAS las tarjetas, ARS y USD por período,
  // + proyección futura (cuotas ya confirmadas) hasta donde llegan los planes (máx. 6 meses).
  const chartMonths = [...new Set(statements.map((s) => s.period))].sort();
  const lastRealPeriod = chartMonths[chartMonths.length - 1];
  const lastOfCard = (cid: number) => statements.filter((s) => s.cardId === cid).map((s) => s.period).sort().pop() ?? null;
  // Un período proyectado = cuotas del período + suscripciones mensuales de esa tarjeta.
  const projValue = (period: string, cid: number) => {
    const cuotasArs = cuotasForPeriod(period, cid).reduce((a, p) => a + p.monthly, 0);
    const s = subsForCard(cid);
    return { ars: cuotasArs + s.ars, usd: s.usd };
  };
  const chartHorizon = lastRealPeriod
    ? Math.min(6, Math.max(subs.length ? 3 : 1, plans.reduce((mx, p) => Math.max(mx, monthsBetweenYM(lastRealPeriod, addMonthsYM(p.firstMonth, p.total - 1))), 0)))
    : 0;
  const chartData: CardBarsRow[] = [
    ...chartMonths.map((period) => ({
      period, future: false,
      values: cards.map((c) => {
        const st = statements.find((s) => s.cardId === c.id && s.period === period);
        if (st) return { name: c.name, accent: c.accent, ars: stTotal(st), usd: stUsd(st), open: isOpen(st), proj: false };
        const lp = lastOfCard(c.id);
        if (lp && period > lp) { const p = projValue(period, c.id); return { name: c.name, accent: c.accent, ars: p.ars, usd: p.usd, open: false, proj: true }; }
        return { name: c.name, accent: c.accent, ars: null, usd: null, open: false, proj: false };
      }),
    })),
    ...Array.from({ length: chartHorizon }, (_, i) => addMonthsYM(lastRealPeriod, i + 1)).map((period) => ({
      period, future: true,
      values: cards.map((c) => { const p = projValue(period, c.id); return { name: c.name, accent: c.accent, ars: p.ars, usd: p.usd, open: false, proj: true }; }),
    })),
  ];

  return (
    <>
      <PageHeader title="Tarjetas" subtitle="Resúmenes y consumos">{nuevaTarjetaBtn}</PageHeader>

      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="flex flex-col gap-5 xl:col-span-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {cards.map((c) => (
              <CreditCardVisual key={c.id} card={c} active={c.id === card.id} onClick={() => setSelectedId(c.id)} />
            ))}
          </div>

          <section className="panel p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  {alDia ? "Próximo resumen · en curso" : "Resumen a pagar"} · {current?.period ?? "—"}
                  {alDia && <span className="rounded-full border border-emerald/30 bg-emerald/10 px-2 py-0.5 text-[0.6rem] text-emerald">Al día ✅</span>}
                </p>
                <CountUp value={spent} format={ars} className="tnum mt-1.5 block text-[38px] font-extrabold leading-none text-fg lg:text-[42px]" />
                <p className="mt-1 text-sm text-faint">+ {usd(spentUsd)} en dólares</p>
              </div>
              <button onClick={() => current && setEditingDates(current)} title="Editar fechas" className="group relative flex gap-3 rounded-2xl transition-opacity hover:opacity-90">
                <Pencil className="absolute -top-1 right-0 h-3.5 w-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                <DateBox label="Cierre" value={current?.closing ?? "—"} />
                <DateBox label="Vencimiento" value={current?.due ?? "—"} accent />
              </button>
            </div>

            <div className="mt-6">
              <div className="flex items-center justify-between text-xs text-muted">
                <span>Uso del límite</span>
                <span className="tnum">{ars(spent)} / {card.limitArs ? ars(card.limitArs) : "sin límite"}</span>
              </div>
              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-white/[0.09]">
                <div className="h-full rounded-full transition-all" style={{ width: `${usage}%`, background: `linear-gradient(90deg, ${card.accent}, #ffbf47)` }} />
              </div>
              <p className="mt-2 text-xs text-faint">
                {card.limitArs ? `${usage}% del límite · disponible ${ars(card.limitArs - spent)}` : (
                  <>Sin límite definido. <button onClick={() => setCardModal({ open: true, card })} className="text-accent hover:underline">Definilo acá</button> para ver cuánto te queda.</>
                )}
              </p>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {alDia ? (
                <span className="rounded-xl border border-emerald/30 bg-emerald/10 px-4 py-2 text-sm text-emerald">Estás al día · nada que pagar 🎉</span>
              ) : (
                <button onClick={() => current && handlePay(current)} disabled={payingId != null} className="rounded-xl bg-accent/90 px-4 py-2 text-sm font-medium text-bg transition-transform hover:scale-[1.03] disabled:opacity-60">
                  {payingId != null ? "Pagando…" : "Pagar resumen"}
                </button>
              )}
              {current && (
                <button onClick={() => toggleMovements(current.id)} className={`rounded-xl border px-4 py-2 text-sm transition-colors ${expandedId === current.id ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>
                  {expandedId === current.id ? "Ocultar movimientos" : "Ver movimientos"}
                </button>
              )}
              <button onClick={() => setCardModal({ open: true, card })} title="Editar tarjeta" className="flex items-center gap-1.5 rounded-xl border border-line bg-white/[0.06] px-4 py-2 text-sm text-muted transition-colors hover:text-fg">
                <Pencil className="h-4 w-4" /> Editar tarjeta
              </button>
            </div>
            {current && expandedId === current.id && (
              <MovementsPanel statement={current} consumos={movements[current.id]} cuotas={cuotasForPeriod(current.period, current.cardId)} subs={[]} loading={loadingMov === current.id} open={isOpen(current)} />
            )}
          </section>

          <section className="panel p-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg text-fg">Resúmenes futuros</h2>
              <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[0.65rem] text-accent">Proyección</span>
            </div>
            <p className="text-xs text-faint">
              {card.name} · próximos {futuros.length} · cuotas{cardSubs.length > 0 ? ` y ${cardSubs.length} suscripcion${cardSubs.length === 1 ? "" : "es"}` : ""} por venir
            </p>
            <ul className="mt-4">
              {futuros.map(renderStmt)}
              {futuros.length === 0 && <li className="py-6 text-center text-sm text-muted">Sin resúmenes próximos proyectados.</li>}
            </ul>
            <p className="mt-2 text-[0.7rem] text-faint">
              Los meses marcados <span className="text-accent">próximo</span> estiman cuotas + suscripciones que se repiten todos los meses. El resumen <span className="text-sky">en curso</span> no las incluye: ahí los consumos entran solos cuando se importan del mail.
            </p>
          </section>

          <section className="panel p-6">
            <h2 className="font-display text-lg text-fg">Resúmenes anteriores</h2>
            <p className="text-xs text-faint">{card.name} · {anteriores.length} resúmenes</p>
            <ul className="mt-4">
              {anteriores.map(renderStmt)}
              {anteriores.length === 0 && <li className="py-6 text-center text-sm text-muted">Sin resúmenes para esta tarjeta.</li>}
            </ul>
          </section>
        </div>

        <div className="flex flex-col gap-5">
          <section className="panel p-6">
            <h2 className="font-display text-lg text-fg">Cuotas activas</h2>
            <p className="text-xs text-faint">{card.name}</p>
            {cuotas.length === 0 ? (
              <div className="mt-4">
                <p className="text-sm text-muted">Sin cuotas activas en esta tarjeta. 🎉</p>
                {(() => {
                  const others = cards.filter((c) => c.id !== card.id && installments.some((i) => i.cardId === c.id));
                  if (!others.length) return null;
                  return (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-faint">Hay cuotas activas en:</p>
                      {others.map((c) => {
                        const n = installments.filter((i) => i.cardId === c.id).length;
                        return (
                          <button key={c.id} onClick={() => setSelectedId(c.id)} className="flex w-full items-center gap-2 rounded-xl border border-line bg-white/[0.06] px-3 py-2 text-sm text-fg transition-colors hover:border-accent/40">
                            <CardIcon className="h-4 w-4 text-muted" /> {c.name}
                            <span className="ml-auto rounded-full bg-accent/15 px-2 py-0.5 text-[0.65rem] text-accent">{n} {n === 1 ? "plan" : "planes"}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            ) : (
              <ul className="mt-4 space-y-4">
                {cuotas.map((q) => {
                  const pct = Math.round((q.current / q.total) * 100);
                  return (
                    <li key={q.id} onClick={() => setEditingPlan(q)} className="group cursor-pointer rounded-xl p-1 transition-colors hover:bg-white/[0.05]">
                      <div className="flex items-center gap-3">
                        <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-white/[0.06] text-lg">{q.emoji}</span>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-fg">{q.desc}</p>
                          <p className="text-xs text-faint">Cuota {q.current} de {q.total}</p>
                        </div>
                        <Pencil className="h-4 w-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                        <span className="tnum text-sm text-fg">{ars(q.monthly)}</span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.09]">
                        <div className="h-full rounded-full bg-gradient-to-r from-accent to-sky" style={{ width: `${pct}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel p-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg text-fg">Suscripciones</h2>
              <span className="rounded-full border border-sky/30 bg-sky/10 px-2.5 py-0.5 text-[0.65rem] text-sky">🔁 mensual</span>
            </div>
            <p className="text-xs text-faint">{card.name} · se suman a cada resumen proyectado</p>
            {cardSubs.length === 0 ? (
              <p className="mt-4 text-sm text-muted">
                No detecté abonos recurrentes en esta tarjeta. Se detectan solos con 3 meses de historia (2 si el nombre lo delata), o marcando el gasto como fijo en <a href="/hormiga" className="text-accent hover:underline">Gastos hormiga</a>.
              </p>
            ) : (
              <>
                <ul className="mt-4 space-y-2">
                  {cardSubs.map((s) => (
                    <li key={`${s.comercio}-${s.currency}`} className="flex items-center gap-3 rounded-xl px-1 py-1.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.06] text-base">{s.emoji}</span>
                      <div className="min-w-0">
                        <p className="truncate text-sm text-fg">{s.comercio}</p>
                        <p className="text-[0.7rem] text-faint">
                          {s.motivo === "marcada" ? "marcada como fija" : `${s.meses.length} meses seguidos`}
                          {s.lastMonth ? ` · última ${mesLabel(s.lastMonth)}` : ""}
                        </p>
                      </div>
                      <span className="tnum ml-auto shrink-0 text-sm text-fg">{s.currency === "ARS" ? ars(s.amount) : usd(s.amount)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-sm">
                  <span className="text-muted">Por mes</span>
                  <span className="tnum text-fg">
                    {ars(subsForCard(card.id).ars)}{subsForCard(card.id).usd > 0 ? ` + ${usd(subsForCard(card.id).usd)}` : ""}
                  </span>
                </div>
              </>
            )}
          </section>

          <section className="panel relative overflow-hidden p-6">
            <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
            <div className="relative flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"><ArrowUpRight className="h-5 w-5" /></span>
              <div>
                <p className="text-sm text-fg">Tip de cierre</p>
                <p className="mt-1 text-xs text-muted">Comprás después del día de cierre y la compra cae en el próximo resumen — más días para pagar sin interés.</p>
              </div>
            </div>
          </section>
        </div>
      </div>

      <section className="panel mt-5 p-6">
        <div className="mb-1">
          <h2 className="font-display text-lg text-fg">Totales por mes</h2>
          <p className="text-xs text-faint">Resúmenes de todas las tarjetas · elegí rango y moneda</p>
        </div>
        <CardBars data={chartData} />
      </section>

      {editingPlan && <EditPlanModal plan={editingPlan} onClose={() => setEditingPlan(null)} onSaved={reloadCuotas} />}
      {editingDates && <EditDatesModal statement={editingDates} onClose={() => setEditingDates(null)} onSaved={reloadStatements} />}
      {cardModal.open && <CardModal card={cardModal.card} onClose={() => setCardModal({ open: false, card: null })} onSaved={reloadStatements} />}
    </>
  );
}

function CreditCardVisual({ card, active, onClick }: { card: CardVis; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`group relative aspect-[1.6/1] w-full overflow-hidden rounded-2xl border bg-gradient-to-br ${card.hue} p-5 text-left transition-all ${active ? "border-transparent ring-2 ring-accent" : "border-line hover:-translate-y-0.5"}`}>
      <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full opacity-30 blur-2xl" style={{ background: card.accent }} />
      <div className="relative flex h-full flex-col justify-between">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-fg/90">{card.name}</p>
            <p className="text-[0.7rem] uppercase tracking-widest text-fg/40">{card.bank}</p>
          </div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-fg/40" strokeWidth="1.6" strokeLinecap="round">
            <path d="M8 8a6 6 0 0 1 0 8M11.5 6a9 9 0 0 1 0 12M15 4.5a12 12 0 0 1 0 15" />
          </svg>
        </div>
        <div className="h-7 w-10 rounded-md bg-gradient-to-br from-amber/80 to-amber/30 ring-1 ring-black/20" />
        <div className="flex items-end justify-between">
          <p className="tnum text-fg/85">•••• {card.last4 ?? "----"}</p>
          <span className="font-display text-lg italic text-fg/80">{card.network}</span>
        </div>
      </div>
    </button>
  );
}

function DateBox({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 text-center ${accent ? "border-coral/30 bg-coral/8" : "border-line bg-white/[0.06]"}`}>
      <p className="text-[0.65rem] uppercase tracking-widest text-faint">{label}</p>
      <p className={`tnum mt-0.5 text-base ${accent ? "text-coral" : "text-fg"}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ paid, paying, onPay }: { paid: boolean; paying?: boolean; onPay?: () => void }) {
  return paid ? (
    <span className="ml-2 hidden rounded-full border border-emerald/30 bg-emerald/10 px-2.5 py-1 text-[0.65rem] text-emerald sm:inline">Pagado</span>
  ) : (
    <button onClick={(e) => { e.stopPropagation(); onPay?.(); }} disabled={paying} className="ml-2 rounded-full bg-coral/90 px-3 py-1 text-[0.65rem] font-medium text-bg disabled:opacity-60">{paying ? "…" : "Pagar"}</button>
  );
}

// Desplegable de movimientos del resumen, con dos páginas: lista y desglose por categoría.
function MovementsPanel({ statement, consumos, cuotas, subs, loading, open }: { statement: StatementRow; consumos: StatementMovement[] | undefined; cuotas: (PlanProj & { n: number })[]; subs: CardSub[]; loading: boolean; open: boolean }) {
  const [page, setPage] = useState<"list" | "cat">("list");
  const toArs = (amount: number, currency: string) => (currency === "ARS" ? amount : amount * fxSync().usd);

  type Item = { key: string; emoji: string; desc: string; sub: string; category: string; amount: number; currency: string; isCuota: boolean; isSub?: boolean };
  const base: Item[] = [
    ...cuotas.map((c) => ({ key: `q${c.id}`, emoji: c.emoji, desc: c.desc, sub: `Cuota ${c.n}/${c.total}`, category: c.category, amount: c.monthly, currency: "ARS", isCuota: true })),
    // Suscripciones proyectadas (solo en resúmenes que todavía no existen).
    ...subs.map((s) => ({ key: `s${s.cardId}-${s.comercio}-${s.currency}`, emoji: s.emoji, desc: s.comercio, sub: s.motivo === "marcada" ? "abono fijo" : `se repite hace ${s.meses.length} meses`, category: s.category, amount: s.amount, currency: s.currency, isCuota: false, isSub: true })),
    ...(consumos ?? []).map((c) => ({ key: `t${c.id}`, emoji: c.emoji, desc: c.desc, sub: c.date, category: c.category, amount: c.amount, currency: c.currency, isCuota: false })),
  ];

  // En resúmenes CERRADOS, el total real (reconciliado) suele ser mayor a lo registrado
  // (consumos viejos que nunca se importaron). Agregamos una fila con esa diferencia para que cuadre.
  const regArs = base.filter((i) => i.currency === "ARS").reduce((s, i) => s + i.amount, 0);
  const regUsd = base.filter((i) => i.currency === "USD").reduce((s, i) => s + i.amount, 0);
  const arsGap = open ? 0 : Math.max(0, statement.totalArs - regArs);
  const usdGap = open ? 0 : Math.max(0, statement.totalUsd - regUsd);
  const items: Item[] = [...base];
  if (arsGap > 1) items.push({ key: "gap-ars", emoji: "🧾", desc: "Consumos no detallados", sub: "no importados", category: "Sin detalle", amount: arsGap, currency: "ARS", isCuota: false });
  if (usdGap > 0.5) items.push({ key: "gap-usd", emoji: "🧾", desc: "Consumos no detallados (USD)", sub: "no importados", category: "Sin detalle", amount: usdGap, currency: "USD", isCuota: false });
  items.sort((a, b) => toArs(b.amount, b.currency) - toArs(a.amount, a.currency));

  const totalArs = items.filter((i) => i.currency === "ARS").reduce((s, i) => s + i.amount, 0);
  const totalUsd = items.filter((i) => i.currency === "USD").reduce((s, i) => s + i.amount, 0);

  // desglose por categoría (solo pesos; los dólares van aparte, igual que en el resumen)
  const catMap = new Map<string, { v: number; emoji: string }>();
  for (const i of items) {
    if (i.currency !== "ARS") continue;
    const e = catMap.get(i.category) ?? { v: 0, emoji: i.emoji };
    e.v += i.amount;
    catMap.set(i.category, e);
  }
  const slices: Slice[] = [...catMap.entries()].map(([label, e]) => ({ label, value: e.v, emoji: e.emoji })).sort((a, b) => b.value - a.value);

  return (
    <div className="mt-4 rounded-2xl border border-line bg-white/[0.03] p-4">
      {/* pager */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex rounded-full border border-line bg-white/[0.05] p-0.5 text-xs">
          <button onClick={() => setPage("list")} className={`rounded-full px-3 py-1 transition-colors ${page === "list" ? "bg-accent/15 text-accent" : "text-muted hover:text-fg"}`}>Gastos</button>
          <button onClick={() => setPage("cat")} className={`rounded-full px-3 py-1 transition-colors ${page === "cat" ? "bg-accent/15 text-accent" : "text-muted hover:text-fg"}`}>Por categoría</button>
        </div>
        <span className="tnum text-xs text-faint">{items.length} mov · {compact(totalArs)}{totalUsd > 0 ? ` · +${usd(totalUsd)}` : ""}</span>
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-muted">Cargando movimientos…</p>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Sin movimientos registrados en este resumen.</p>
      ) : page === "list" ? (
        <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.05] text-base">{i.emoji}</span>
              <div className="min-w-0">
                <p className="truncate text-sm text-fg">{i.desc}</p>
                <p className="flex items-center gap-1.5 text-[0.7rem] text-faint">
                  {i.category}
                  {i.isCuota && <span className="rounded-full border border-accent/30 bg-accent/10 px-1.5 text-[0.6rem] text-accent">{i.sub}</span>}
                  {i.isSub && <span className="rounded-full border border-sky/30 bg-sky/10 px-1.5 text-[0.6rem] text-sky">🔁 {i.sub}</span>}
                  {!i.isCuota && !i.isSub && <span>· {i.sub}</span>}
                </p>
              </div>
              <span className="tnum ml-auto shrink-0 text-sm text-fg">{i.currency === "ARS" ? ars(i.amount) : usd(i.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="py-2">
          <Donut data={slices} fmt={compact} size={170} thickness={24} />
          {totalUsd > 0 && <p className="mt-2 text-center text-[0.7rem] text-faint">+ {usd(totalUsd)} en dólares (resumen aparte, no incluido en el desglose en pesos)</p>}
        </div>
      )}
    </div>
  );
}

const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const mesLabel = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MESES_CORTOS[(m || 1) - 1]} '${String(y).slice(2)}`; };

// Totales por mes: barras agrupadas por tarjeta, con rango de meses y moneda elegibles.
// Los meses futuros (proyección con cuotas confirmadas) se muestran siempre, punteados.
type CardBarsRow = { period: string; future: boolean; values: { name: string; accent: string; ars: number | null; usd: number | null; open: boolean; proj: boolean }[] };
function CardBars({ data }: { data: CardBarsRow[] }) {
  const [range, setRange] = useState(6);
  const [cur, setCur] = useState<"ARS" | "USD">("ARS");
  // El rango recorta los meses reales; la proyección va siempre al final.
  const visible = range > 0 ? [...data.filter((r) => !r.future).slice(-range), ...data.filter((r) => r.future)] : data;
  const val = (v: CardBarsRow["values"][number]) => (cur === "ARS" ? v.ars ?? 0 : v.usd ?? 0);
  const max = Math.max(...visible.flatMap((m) => m.values.map(val)), cur === "ARS" ? 1 : 0.01);
  const fmt = (n: number) => (cur === "ARS" ? compact(n) : usd(n));
  const legend = data[data.length - 1]?.values ?? [];
  const hayEnCurso = visible.some((m) => m.values.some((v) => v.open));
  const hayProyeccion = visible.some((m) => m.values.some((v) => v.proj));
  return (
    <div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
          {legend.map((c) => (
            <span key={c.name} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c.accent }} /> {c.name}</span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-full border border-line bg-white/[0.06] p-0.5 text-xs">
            {[3, 6, 0].map((n) => (
              <button key={n} onClick={() => setRange(n)} className={`rounded-full px-3 py-1 transition-colors ${range === n ? "bg-accent/15 text-accent" : "text-muted hover:text-fg"}`}>{n === 0 ? "Todos" : `${n}M`}</button>
            ))}
          </div>
          <div className="flex rounded-full border border-line bg-white/[0.06] p-0.5 text-xs">
            {(["ARS", "USD"] as const).map((c) => (
              <button key={c} onClick={() => setCur(c)} className={`rounded-full px-3 py-1 transition-colors ${cur === c ? "bg-accent/15 text-accent" : "text-muted hover:text-fg"}`}>{c === "ARS" ? "$ Pesos" : "US$ Dólares"}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto pb-1">
        <div className="flex min-w-[420px] items-end gap-3">
          {visible.map((m) => (
            <div key={m.period} className="flex flex-1 flex-col items-center gap-2">
              <div className="flex h-44 w-full items-end justify-center gap-1.5">
                {m.values.map((v) => {
                  const value = val(v);
                  return (
                    <div key={v.name} className="flex w-full max-w-12 flex-col items-center justify-end gap-1 self-stretch">
                      <span className="tnum text-[0.62rem] text-faint">{value > 0 ? fmt(value) : ""}</span>
                      <span
                        className="grow-bar w-full rounded-t-md"
                        style={v.proj
                          ? { height: `${Math.max((value / max) * 100, value > 0 ? 2 : 0)}%`, background: `linear-gradient(to top, ${v.accent}18, ${v.accent}55)`, border: `1px dashed ${v.accent}88`, borderBottom: "none" }
                          : { height: `${Math.max((value / max) * 100, value > 0 ? 2 : 0)}%`, background: `linear-gradient(to top, ${v.accent}44, ${v.accent})` }}
                      />
                    </div>
                  );
                })}
              </div>
              <span className={`text-[0.68rem] ${m.future ? "text-accent/80" : "text-faint"}`}>{mesLabel(m.period)}{m.values.some((v) => v.open) ? " *" : ""}</span>
            </div>
          ))}
          {visible.length === 0 && <p className="w-full py-8 text-center text-sm text-muted">Sin resúmenes.</p>}
        </div>
      </div>
      {(hayEnCurso || hayProyeccion) && (
        <p className="mt-2 text-[0.68rem] text-faint">
          {hayEnCurso && "* mes en curso: total estimado hasta hoy."}
          {hayEnCurso && hayProyeccion && " · "}
          {hayProyeccion && "Barras punteadas: proyección con las cuotas ya confirmadas (los consumos nuevos se suman cuando ocurran; en dólares no hay proyección)."}
        </p>
      )}
    </div>
  );
}
