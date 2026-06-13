"use client";

import { useEffect, useState } from "react";
import { db, fetchCardsFull, fetchStatements, fetchInstallments, fetchStatementConsumos, fetchStatementMovements, fetchPlansForProjection, type CardFull, type StatementRow, type InstallmentRow, type StatementMovement, type PlanProj } from "@/lib/db";
import { ars, usd, compact } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import { Donut, type Slice } from "../components/charts";
import EditPlanModal from "../components/EditPlanModal";
import EditDatesModal from "../components/EditDatesModal";
import { Plus, Card as CardIcon, ArrowUpRight, Pencil, Chevron } from "../icons";

const USD_ARS = 1455; // cotización para valuar consumos en USD dentro del desglose
const monthsBetweenYM = (a: string, b: string) => { const [ay, am] = a.slice(0, 7).split("-").map(Number); const [by, bm] = b.slice(0, 7).split("-").map(Number); return (by - ay) * 12 + (bm - am); };
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingPlan, setEditingPlan] = useState<InstallmentRow | null>(null);
  const [editingDates, setEditingDates] = useState<StatementRow | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [movements, setMovements] = useState<Record<number, StatementMovement[]>>({});
  const [loadingMov, setLoadingMov] = useState<number | null>(null);

  const reloadCuotas = async () => setInstallments(await fetchInstallments(db()));
  const reloadStatements = async () => { const sb = db(); setStatements(await fetchStatements(sb)); setCards((await fetchCardsFull(sb)).filter(esCredito).map((card, idx) => ({ ...card, ...palette[idx % palette.length] }))); };

  const toggleMovements = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
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
    (async () => {
      const sb = db();
      const [c, s, i, co, pl] = await Promise.all([fetchCardsFull(sb), fetchStatements(sb), fetchInstallments(sb), fetchStatementConsumos(sb), fetchPlansForProjection(sb)]);
      const vis = c.filter(esCredito).map((card, idx) => ({ ...card, ...palette[idx % palette.length] }));
      setCards(vis); setStatements(s); setInstallments(i); setConsumos(co); setPlans(pl);
      setSelectedId(vis[0]?.id ?? null);
    })().finally(() => setLoading(false));
  }, []);

  if (loading) return (<><PageHeader title="Tarjetas" subtitle="Cargando…" /><div className="panel mt-6 p-10 text-center text-sm text-muted">Cargando tarjetas…</div></>);
  if (!cards.length) return (<><PageHeader title="Tarjetas" subtitle="Sin tarjetas" /><div className="panel mt-6 p-10 text-center text-sm text-muted">Todavía no tenés tarjetas cargadas.</div></>);

  const card = cards.find((c) => c.id === selectedId) ?? cards[0];
  const history = statements.filter((s) => s.cardId === card.id);
  // Resumen a pagar = el último cerrado que NO esté pagado. Si están todos pagos, mostramos el próximo (en curso).
  const today = new Date();
  const toPay = history.find((s) => s.closingRaw && new Date(s.closingRaw) <= today && !s.paid);
  const current = toPay ?? history.find((s) => s.closingRaw && new Date(s.closingRaw) > today) ?? history[0];
  const alDia = !toPay;
  const cuotas = installments.filter((i) => i.cardId === card.id);
  // Resúmenes abiertos (cierre a futuro, ej. junio) se estiman con las cuotas pendientes.
  const cuotasSum = cuotas.reduce((a, q) => a + q.monthly, 0);
  const isOpen = (s: StatementRow) => !!s.closingRaw && new Date(s.closingRaw) > today;
  const stTotal = (s: StatementRow) => (isOpen(s) ? cuotasSum + (consumos[s.id]?.ars ?? 0) : s.totalArs);
  const stUsd = (s: StatementRow) => (isOpen(s) ? (consumos[s.id]?.usd ?? 0) : s.totalUsd);
  const spent = current ? stTotal(current) : 0;
  const spentUsd = current ? stUsd(current) : 0;
  const usage = card.limitArs ? Math.min(100, Math.round((spent / card.limitArs) * 100)) : 0;

  return (
    <>
      <PageHeader title="Tarjetas" subtitle="Resúmenes y consumos">
        <button className="flex items-center gap-2 rounded-full bg-lime px-4 py-2 text-sm font-medium text-bg transition-transform hover:scale-[1.03]">
          <Plus className="h-4 w-4" /> Agregar tarjeta
        </button>
      </PageHeader>

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
                <p className="mt-1 font-display text-4xl text-fg"><span className="tnum">{ars(spent)}</span></p>
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
              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full transition-all" style={{ width: `${usage}%`, background: `linear-gradient(90deg, ${card.accent}, #c8ff4d)` }} />
              </div>
              <p className="mt-2 text-xs text-faint">{card.limitArs ? `${usage}% del límite · disponible ${ars(card.limitArs - spent)}` : "Definí un límite para ver el uso disponible"}</p>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {alDia ? (
                <span className="rounded-xl border border-emerald/30 bg-emerald/10 px-4 py-2 text-sm text-emerald">Estás al día · nada que pagar 🎉</span>
              ) : (
                <button className="rounded-xl bg-violet/90 px-4 py-2 text-sm font-medium text-bg transition-transform hover:scale-[1.03]">Pagar resumen</button>
              )}
              {current && (
                <button onClick={() => toggleMovements(current.id)} className={`rounded-xl border px-4 py-2 text-sm transition-colors ${expandedId === current.id ? "border-lime/40 bg-lime/10 text-lime" : "border-line bg-surface-2 text-muted hover:text-fg"}`}>
                  {expandedId === current.id ? "Ocultar movimientos" : "Ver movimientos"}
                </button>
              )}
            </div>
            {current && expandedId === current.id && (
              <MovementsPanel statement={current} consumos={movements[current.id]} cuotas={cuotasForPeriod(current.period, current.cardId)} loading={loadingMov === current.id} open={isOpen(current)} />
            )}
          </section>

          <section className="panel p-6">
            <h2 className="font-display text-lg text-fg">Resúmenes anteriores</h2>
            <p className="text-xs text-faint">{card.name} · {history.length} resúmenes</p>
            <ul className="mt-4">
              {history.map((s) => {
                const open = isOpen(s);
                const exp = expandedId === s.id;
                return (
                  <li key={s.id} className="border-b border-line last:border-0">
                    <div onClick={() => toggleMovements(s.id)} className={`flex cursor-pointer items-center gap-3 rounded-xl px-1.5 py-3 transition-colors hover:bg-surface-2/40 ${exp ? "bg-surface-2/30" : ""}`}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2"><CardIcon className="h-5 w-5 text-muted" /></span>
                      <div>
                        <p className="flex items-center gap-2 text-[0.95rem] text-fg">
                          {s.period}
                          {open && <span className="rounded-full border border-sky/30 bg-sky/10 px-1.5 py-0.5 text-[0.6rem] text-sky">en curso</span>}
                        </p>
                        <p className="text-xs text-faint">Cierre {s.closing} · Vence {s.due}</p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="tnum text-[0.95rem] text-fg">{ars(stTotal(s))}</p>
                        <p className="text-xs text-faint">+ {usd(stUsd(s))}{open ? " · estimado" : ""}</p>
                      </div>
                      {open ? <span className="ml-2 hidden rounded-full border border-sky/30 bg-sky/10 px-2.5 py-1 text-[0.65rem] text-sky sm:inline">Estimado</span> : <StatusBadge paid={s.paid} />}
                      <Chevron className={`h-4 w-4 shrink-0 text-faint transition-transform ${exp ? "rotate-180 text-lime" : ""}`} />
                    </div>
                    {exp && <MovementsPanel statement={s} consumos={movements[s.id]} cuotas={cuotasForPeriod(s.period, s.cardId)} loading={loadingMov === s.id} open={open} />}
                  </li>
                );
              })}
              {history.length === 0 && <li className="py-6 text-center text-sm text-muted">Sin resúmenes para esta tarjeta.</li>}
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
                          <button key={c.id} onClick={() => setSelectedId(c.id)} className="flex w-full items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-fg transition-colors hover:border-lime/40">
                            <CardIcon className="h-4 w-4 text-muted" /> {c.name}
                            <span className="ml-auto rounded-full bg-lime/15 px-2 py-0.5 text-[0.65rem] text-lime">{n} {n === 1 ? "plan" : "planes"}</span>
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
                    <li key={q.id} onClick={() => setEditingPlan(q)} className="group cursor-pointer rounded-xl p-1 transition-colors hover:bg-surface-2/50">
                      <div className="flex items-center gap-3">
                        <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-surface-2 text-lg">{q.emoji}</span>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-fg">{q.desc}</p>
                          <p className="text-xs text-faint">Cuota {q.current} de {q.total}</p>
                        </div>
                        <Pencil className="h-4 w-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                        <span className="tnum text-sm text-fg">{ars(q.monthly)}</span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                        <div className="h-full rounded-full bg-gradient-to-r from-violet to-sky" style={{ width: `${pct}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="panel p-6">
            <h2 className="font-display text-lg text-fg">Totales por mes</h2>
            <p className="text-xs text-faint">{card.name}</p>
            {history.length ? <MiniBars data={history.map((s) => ({ ...s, totalArs: stTotal(s) }))} accent={card.accent} /> : <p className="mt-4 text-sm text-muted">Sin datos.</p>}
          </section>

          <section className="panel relative overflow-hidden p-6">
            <div className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-violet/10 blur-3xl" />
            <div className="relative flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-violet/15 text-violet"><ArrowUpRight className="h-5 w-5" /></span>
              <div>
                <p className="text-sm text-fg">Tip de cierre</p>
                <p className="mt-1 text-xs text-muted">Comprás después del día de cierre y la compra cae en el próximo resumen — más días para pagar sin interés.</p>
              </div>
            </div>
          </section>
        </div>
      </div>

      {editingPlan && <EditPlanModal plan={editingPlan} onClose={() => setEditingPlan(null)} onSaved={reloadCuotas} />}
      {editingDates && <EditDatesModal statement={editingDates} onClose={() => setEditingDates(null)} onSaved={reloadStatements} />}
    </>
  );
}

function CreditCardVisual({ card, active, onClick }: { card: CardVis; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`group relative aspect-[1.6/1] w-full overflow-hidden rounded-2xl border bg-gradient-to-br ${card.hue} p-5 text-left transition-all ${active ? "border-transparent ring-2 ring-lime" : "border-line hover:-translate-y-0.5"}`}>
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
    <div className={`rounded-2xl border px-4 py-3 text-center ${accent ? "border-coral/30 bg-coral/8" : "border-line bg-surface-2/60"}`}>
      <p className="text-[0.65rem] uppercase tracking-widest text-faint">{label}</p>
      <p className={`tnum mt-0.5 text-base ${accent ? "text-coral" : "text-fg"}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ paid }: { paid: boolean }) {
  return paid ? (
    <span className="ml-2 hidden rounded-full border border-emerald/30 bg-emerald/10 px-2.5 py-1 text-[0.65rem] text-emerald sm:inline">Pagado</span>
  ) : (
    <button onClick={(e) => e.stopPropagation()} className="ml-2 rounded-full bg-coral/90 px-3 py-1 text-[0.65rem] font-medium text-bg">Pagar</button>
  );
}

// Desplegable de movimientos del resumen, con dos páginas: lista y desglose por categoría.
function MovementsPanel({ statement, consumos, cuotas, loading, open }: { statement: StatementRow; consumos: StatementMovement[] | undefined; cuotas: (PlanProj & { n: number })[]; loading: boolean; open: boolean }) {
  const [page, setPage] = useState<"list" | "cat">("list");
  const toArs = (amount: number, currency: string) => (currency === "ARS" ? amount : amount * USD_ARS);

  type Item = { key: string; emoji: string; desc: string; sub: string; category: string; amount: number; currency: string; isCuota: boolean };
  const base: Item[] = [
    ...cuotas.map((c) => ({ key: `q${c.id}`, emoji: c.emoji, desc: c.desc, sub: `Cuota ${c.n}/${c.total}`, category: c.category, amount: c.monthly, currency: "ARS", isCuota: true })),
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
    <div className="mt-4 rounded-2xl border border-line bg-surface-2/30 p-4">
      {/* pager */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex rounded-full border border-line bg-surface p-0.5 text-xs">
          <button onClick={() => setPage("list")} className={`rounded-full px-3 py-1 transition-colors ${page === "list" ? "bg-lime/15 text-lime" : "text-muted hover:text-fg"}`}>Gastos</button>
          <button onClick={() => setPage("cat")} className={`rounded-full px-3 py-1 transition-colors ${page === "cat" ? "bg-lime/15 text-lime" : "text-muted hover:text-fg"}`}>Por categoría</button>
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
            <li key={i.key} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface/60">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-surface text-base">{i.emoji}</span>
              <div className="min-w-0">
                <p className="truncate text-sm text-fg">{i.desc}</p>
                <p className="flex items-center gap-1.5 text-[0.7rem] text-faint">
                  {i.category}
                  {i.isCuota && <span className="rounded-full border border-violet/30 bg-violet/10 px-1.5 text-[0.6rem] text-violet">{i.sub}</span>}
                  {!i.isCuota && <span>· {i.sub}</span>}
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

function MiniBars({ data, accent }: { data: StatementRow[]; accent: string }) {
  const ordered = [...data].reverse();
  const max = Math.max(...ordered.map((s) => s.totalArs), 1);
  return (
    <div className="mt-4 flex items-end justify-between gap-2">
      {ordered.map((s) => (
        <div key={s.id} className="flex flex-1 flex-col items-center gap-2">
          <div className="flex h-28 w-full items-end justify-center">
            <span className="grow-bar w-2/3 max-w-7 rounded-t-md" style={{ height: `${(s.totalArs / max) * 100}%`, background: `linear-gradient(to top, ${accent}55, ${accent})` }} />
          </div>
          <span className="tnum text-[0.6rem] text-faint">{compact(s.totalArs)}</span>
          <span className="text-[0.6rem] text-faint">{s.period.slice(0, 3)}</span>
        </div>
      ))}
    </div>
  );
}
