"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { db, fetchDebts, fetchPersons, insertDebt, insertPerson, settleDebt, payDebt, deleteDebtPayment, type DebtView, type DebtPayment } from "@/lib/db";
import { readCache, writeCache } from "@/lib/cache";
import { fxSync, loadFx, toArs } from "@/lib/fx";
import { ars } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import Modal from "../components/Modal";
import CountUp from "../components/CountUp";
import { ArrowUpRight, ArrowDownRight, Swap, Chevron, Plus } from "../icons";

type DebtKind = "cash" | "in_kind" | "split";
const kindMeta: Record<DebtKind, { label: string; emoji: string; cls: string; bg: string; hint: string }> = {
  cash: { label: "Dinero", emoji: "💸", cls: "text-emerald", bg: "bg-emerald/10 border-emerald/30", hint: "Movimiento real de plata · no es gasto" },
  in_kind: { label: "En especie", emoji: "📦", cls: "text-amber", bg: "bg-amber/10 border-amber/30", hint: "Diste/recibiste una cosa (no plata). No mueve tu saldo al crearla; si te pagan en plata, impacta al saldar." },
  split: { label: "Compartido", emoji: "🧾", cls: "text-sky", bg: "bg-sky/10 border-sky/30", hint: "Gasto dividido · solo tu parte es gasto" },
};

type DirFilter = "todas" | "to_collect" | "to_pay";
const money = (n: number, cur: string) => (cur === "USD" ? `US$ ${n.toLocaleString("es-AR")}` : cur === "USDT" ? `${n.toLocaleString("es-AR")} USDT` : ars(n));
// para sumar deudas de distintas monedas, valuamos en ARS con la cotización vigente
const inArs = (n: number, cur: string) => toArs(n, cur, fxSync());

export default function DeudasPage() {
  const [items, setItems] = useState<DebtView[]>([]);
  const [persons, setPersons] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [dir, setDir] = useState<DirFilter>("todas");
  const [kind, setKind] = useState<"todos" | DebtKind>("todos");
  const [nuevaOpen, setNuevaOpen] = useState(false);
  const [view, setView] = useState<"personas" | "historial">("personas");
  const [selected, setSelected] = useState<string | null>(null);

  const reload = async () => {
    const sb = db();
    const [d, p] = await Promise.all([fetchDebts(sb), fetchPersons(sb)]);
    setItems(d); setPersons(p);
    writeCache("deudas", { d, p });
  };
  useEffect(() => {
    // Pintar al instante el último snapshot; lo fresco llega por atrás.
    const s = readCache<{ d: DebtView[]; p: { id: number; name: string }[] }>("deudas");
    if (s) { setItems(s.d); setPersons(s.p); setLoading(false); }
    loadFx().then(() => setItems((p) => [...p])); // refresca la valuación cuando llega la cotización
    reload().finally(() => setLoading(false));
  }, []);

  const pending = items.filter((d) => d.status === "pending");
  const toCollect = pending.filter((d) => d.direction === "to_collect").reduce((a, d) => a + inArs(d.outstanding, d.currency), 0);
  const toPay = pending.filter((d) => d.direction === "to_pay").reduce((a, d) => a + inArs(d.outstanding, d.currency), 0);

  const filtered = useMemo(
    () => items.filter((d) => (dir === "todas" || d.direction === dir) && (kind === "todos" || d.kind === kind)),
    [items, dir, kind]
  );

  // Guardia anti doble-click: una sola operación de pago/saldado/borrado en vuelo a la vez.
  const busyRef = useRef(false);
  const guarded = async (fn: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; try { await fn(); } finally { busyRef.current = false; } };

  const settle = (id: number) => guarded(async () => {
    setItems((p) => p.map((d) => (d.id === id ? { ...d, status: "settled" } : d)));
    await settleDebt(db(), id);
    await reload();
  });
  const pay = (id: number, amount: number) => guarded(async () => { await payDebt(db(), id, amount); await reload(); });
  // Borrar un pago mal cargado (ej: click duplicado): elimina el pago y su movimiento en Transacciones.
  const removePayment = (d: DebtView, p: DebtPayment) => guarded(async () => {
    if (!window.confirm(`¿Borrar el pago de ${money(p.amount, d.currency)} del ${p.date}?\n\nTambién se borra su movimiento en Transacciones y el saldo pendiente vuelve a subir.`)) return;
    await deleteDebtPayment(db(), d.id, p);
    await reload();
  });

  return (
    <>
      <PageHeader title="Deudas" subtitle={loading ? "Cargando…" : "A cobrar y a pagar"}>
        <button onClick={() => setNuevaOpen(true)} className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-bg transition-transform hover:scale-[1.03]">
          <Plus className="h-4 w-4" /> Nueva deuda
        </button>
      </PageHeader>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Te deben" value={toCollect} tone="emerald" up />
        <SummaryCard label="Debés" value={toPay} tone="coral" />
        <SummaryCard label="Balance neto" value={toCollect - toPay} tone={toCollect - toPay >= 0 ? "emerald" : "coral"} up={toCollect - toPay >= 0} />
      </div>
      <p className="mt-3 flex items-center gap-2 text-xs text-faint">
        <span className="grid h-4 w-4 place-items-center rounded-full bg-white/[0.09] text-[0.6rem]">i</span>
        Los préstamos (💸 Dinero) no se cuentan como gasto. En los compartidos (🧾) solo tu parte es gasto tuyo.
      </p>

      <div className="mt-6">
        <div>
          <div className="flex rounded-xl border border-line bg-white/[0.06] p-1 text-sm">
            {(["personas", "historial"] as const).map((v) => (
              <button key={v} onClick={() => { setView(v); setSelected(null); }} className={`rounded-lg px-3 py-1.5 transition-colors ${view === v ? "bg-white/[0.09] text-fg" : "text-muted hover:text-fg"}`}>
                {v === "personas" ? "Por persona" : "Historial"}
              </button>
            ))}
          </div>

          {view === "personas" ? (
            selected ? (
              <PersonDetail person={selected} items={items.filter((d) => d.person === selected)} onBack={() => setSelected(null)} onSettle={settle} onPay={pay} onDeletePayment={removePayment} />
            ) : (
              <PeopleSummary items={items} loading={loading} onOpen={setSelected} />
            )
          ) : (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Segmented value={dir} onChange={setDir} />
                <div className="flex flex-wrap gap-1.5">
                  <KindChip active={kind === "todos"} onClick={() => setKind("todos")}>Todos</KindChip>
                  {(Object.keys(kindMeta) as DebtKind[]).map((k) => (
                    <KindChip key={k} active={kind === k} onClick={() => setKind(k)}>{kindMeta[k].emoji} {kindMeta[k].label}</KindChip>
                  ))}
                </div>
              </div>
              <section className="panel mt-3 divide-y divide-line p-2 sm:p-4">
                {loading ? (
                  <p className="px-2 py-10 text-center text-sm text-muted">Cargando deudas…</p>
                ) : filtered.length === 0 ? (
                  <p className="px-2 py-10 text-center text-sm text-muted">No hay deudas con esos filtros.</p>
                ) : (
                  <DebtHistory items={filtered} />
                )}
              </section>
            </>
          )}
        </div>

      </div>

      {nuevaOpen && <NewDebtForm persons={persons} onSaved={reload} onClose={() => setNuevaOpen(false)} />}
    </>
  );
}

/**
 * El color va en el NÚMERO, no en un cuadradito suelto: antes el monto siempre
 * salía blanco y el único color estaba en el ícono, así que un balance negativo
 * no se leía como negativo.
 */
function SummaryCard({ label, value, tone, up }: { label: string; value: number; tone: "emerald" | "coral"; up?: boolean }) {
  const color = tone === "emerald" ? "text-emerald" : "text-coral";
  const chip = tone === "emerald" ? "bg-emerald/12 text-emerald" : "bg-coral/12 text-coral";
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 text-xs text-subtle">
        <span className={`grid h-5 w-5 place-items-center rounded-md ${chip}`}>{up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}</span>
        {label}
      </div>
      <CountUp value={value} format={ars} className={`tnum mt-2 block text-[24px] font-bold ${color}`} />
    </div>
  );
}

function Segmented({ value, onChange }: { value: DirFilter; onChange: (v: DirFilter) => void }) {
  const opts: { v: DirFilter; label: string }[] = [
    { v: "todas", label: "Todas" }, { v: "to_collect", label: "Te deben" }, { v: "to_pay", label: "Debés" },
  ];
  return (
    <div className="flex rounded-xl border border-line bg-white/[0.06] p-1 text-sm">
      {opts.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} className={`rounded-lg px-3 py-1.5 transition-colors ${value === o.v ? "bg-white/[0.09] text-fg" : "text-muted hover:text-fg"}`}>{o.label}</button>
      ))}
    </div>
  );
}

function KindChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${active ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>{children}</button>;
}

type Ev = { key: string; at: string; dateLabel: string; person: string; kind: DebtKind; amount: number; currency: string; verb: string; desc: string; incoming: boolean; isPay: boolean };
function DebtHistory({ items }: { items: DebtView[] }) {
  const events = useMemo(() => {
    const evs: Ev[] = [];
    for (const d of items) {
      const collect = d.direction === "to_collect";
      evs.push({
        key: `c${d.id}`, at: d.occurredAt, dateLabel: d.date, person: d.person, kind: d.kind, amount: d.amount, currency: d.currency, isPay: false,
        verb: collect ? `Prestaste a ${d.person}` : `${d.person} te prestó`,
        desc: d.description || kindMeta[d.kind].label, incoming: !collect,
      });
      d.payments.forEach((p, i) => evs.push({
        key: `p${d.id}-${i}`, at: p.at, dateLabel: p.date, person: d.person, kind: d.kind, amount: p.amount, currency: d.currency, isPay: true,
        verb: collect ? `${d.person} te pagó` : `Le pagaste a ${d.person}`,
        desc: d.description || kindMeta[d.kind].label, incoming: collect,
      }));
    }
    return evs.sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [items]);

  return (
    <>
      {events.map((e) => (
        <div key={e.key} className="flex items-center gap-3 px-2 py-3">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border text-base ${e.isPay ? "border-emerald/25 bg-emerald/8" : `${kindMeta[e.kind].bg}`}`}>
            {e.isPay ? "↩" : kindMeta[e.kind].emoji}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.95rem] text-fg">{e.verb}</p>
            <p className="truncate text-xs text-faint">{e.isPay ? "Pago" : kindMeta[e.kind].label} · {e.desc} · {e.dateLabel}</p>
          </div>
          <div className="ml-auto text-right">
            <p className={`tnum text-[0.95rem] ${e.incoming ? "text-emerald" : "text-coral"}`}>{e.incoming ? "+" : "−"}{money(e.amount, e.currency)}</p>
            <p className="text-[0.6rem] text-faint">{e.isPay ? "pago" : "deuda"}</p>
          </div>
        </div>
      ))}
    </>
  );
}

function PeopleSummary({ items, loading, onOpen }: { items: DebtView[]; loading: boolean; onOpen: (p: string) => void }) {
  const people = useMemo(() => {
    const map = new Map<string, { name: string; collect: number; pay: number; pending: number; total: number }>();
    for (const d of items) {
      const e = map.get(d.person) ?? { name: d.person, collect: 0, pay: 0, pending: 0, total: 0 };
      if (d.status === "pending") { if (d.direction === "to_collect") e.collect += inArs(d.outstanding, d.currency); else e.pay += inArs(d.outstanding, d.currency); e.pending += 1; }
      e.total += 1;
      map.set(d.person, e);
    }
    return [...map.values()].sort((a, b) => (b.pending - a.pending) || (Math.abs(b.collect - b.pay) - Math.abs(a.collect - a.pay)));
  }, [items]);

  if (loading) return <section className="panel mt-3 p-10 text-center text-sm text-muted">Cargando…</section>;
  if (!people.length) return <section className="panel mt-3 p-10 text-center text-sm text-muted">Todavía no hay deudas registradas.</section>;

  return (
    <section className="panel mt-3 divide-y divide-line p-2 sm:p-3">
      {people.map((p) => {
        const net = p.collect - p.pay;
        return (
          <button key={p.name} onClick={() => onOpen(p.name)} className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/[0.05]">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent/30 to-sky/20 font-display text-fg">{p.name.slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0">
              <p className="truncate text-[0.95rem] text-fg">{p.name}</p>
              <p className="text-xs text-faint">{p.pending > 0 ? `${p.pending} pendiente${p.pending > 1 ? "s" : ""}` : "al día ✅"} · {p.total} en total</p>
            </div>
            <div className="ml-auto text-right">
              <p className={`tnum text-[0.95rem] ${net > 0 ? "text-emerald" : net < 0 ? "text-coral" : "text-faint"}`}>{net === 0 ? "saldado" : `${net > 0 ? "+" : "−"}${ars(Math.abs(net))}`}</p>
              <p className="text-[0.65rem] text-faint">{net > 0 ? "te debe" : net < 0 ? "le debés" : ""}</p>
            </div>
            <Chevron className="h-4 w-4 shrink-0 -rotate-90 text-faint" />
          </button>
        );
      })}
    </section>
  );
}

function PersonDetail({ person, items, onBack, onSettle, onPay, onDeletePayment }: { person: string; items: DebtView[]; onBack: () => void; onSettle: (id: number) => void; onPay: (id: number, amount: number) => void; onDeletePayment: (d: DebtView, p: DebtPayment) => void }) {
  const sorted = [...items].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const collect = items.filter((d) => d.status === "pending" && d.direction === "to_collect").reduce((a, d) => a + inArs(d.outstanding, d.currency), 0);
  const pay = items.filter((d) => d.status === "pending" && d.direction === "to_pay").reduce((a, d) => a + inArs(d.outstanding, d.currency), 0);
  const net = collect - pay;
  return (
    <section className="panel mt-3 p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.06] text-muted hover:text-fg"><Chevron className="h-4 w-4 rotate-90" /></button>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent/30 to-sky/20 font-display text-fg">{person.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <p className="font-display text-lg text-fg">{person}</p>
          <p className="text-xs text-faint">{items.length} movimiento{items.length > 1 ? "s" : ""}</p>
        </div>
        <div className="ml-auto text-right">
          <p className={`tnum font-display text-xl ${net > 0 ? "text-emerald" : net < 0 ? "text-coral" : "text-faint"}`}>{net === 0 ? "saldado" : `${net > 0 ? "+" : "−"}${ars(Math.abs(net))}`}</p>
          <p className="text-[0.65rem] text-faint">{net > 0 ? "te debe" : net < 0 ? "le debés" : "sin pendientes"}</p>
        </div>
      </div>

      {(collect > 0 || pay > 0) && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
          <div className="rounded-xl border border-emerald/20 bg-emerald/8 px-3 py-2"><p className="text-muted">Te debe</p><p className="tnum text-emerald">{ars(collect)}</p></div>
          <div className="rounded-xl border border-coral/20 bg-coral/8 px-3 py-2"><p className="text-muted">Le debés</p><p className="tnum text-coral">{ars(pay)}</p></div>
        </div>
      )}

      <p className="mt-4 mb-1 text-[0.7rem] uppercase tracking-wider text-faint">Historial</p>
      <ul className="space-y-2">
        {sorted.map((d) => {
          const m = kindMeta[d.kind]; const collectDir = d.direction === "to_collect";
          return (
            <li key={d.id} className="rounded-xl border border-line bg-white/[0.03] px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.05] text-base">{m.emoji}</span>
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">{d.description || m.label}</p>
                  <p className="text-[0.7rem] text-faint">
                    {collectDir ? "te debe" : "le debés"} · {d.date}
                    {d.status === "settled" && d.settledAt ? ` · ${collectDir ? "te pagó" : "le pagaste"} el ${d.settledAt}` : ""}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <div className="text-right">
                    {d.status === "pending" && d.paid > 0 ? (
                      <>
                        <p className={`tnum text-sm ${collectDir ? "text-emerald" : "text-coral"}`}>{collectDir ? "+" : "−"}{money(d.outstanding, d.currency)}</p>
                        <p className="text-[0.6rem] text-faint">de {money(d.amount, d.currency)}</p>
                      </>
                    ) : (
                      <>
                        <p className={`tnum text-sm ${d.status === "settled" ? "text-faint line-through" : collectDir ? "text-emerald" : "text-coral"}`}>{collectDir ? "+" : "−"}{money(d.amount, d.currency)}</p>
                        {d.status === "settled" && <p className="text-[0.6rem] text-emerald">saldada</p>}
                      </>
                    )}
                  </div>
                  {d.status === "pending" && <DebtActions onSettle={() => onSettle(d.id)} onPay={(amt) => onPay(d.id, amt)} />}
                </div>
              </div>
              {d.payments.length > 0 && (
                <ul className="ml-12 mt-2 space-y-0.5 border-l border-line pl-3 text-[0.7rem] text-faint">
                  {d.payments.map((p) => (
                    <li key={p.id} className="flex items-center gap-1.5">
                      <span className="text-emerald">↩</span> {collectDir ? "pagó" : "pagaste"} {money(p.amount, d.currency)} · {p.date}
                      <button onClick={() => onDeletePayment(d, p)} title="Borrar este pago" className="grid h-4 w-4 place-items-center rounded text-[0.7rem] leading-none text-faint transition-colors hover:bg-coral/15 hover:text-coral">✕</button>
                    </li>
                  ))}
                  {d.status === "pending" && <li className="text-muted">quedan {money(d.outstanding, d.currency)}</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DebtActions({ onSettle, onPay }: { onSettle: () => void; onPay: (amount: number) => void }) {
  const [paying, setPaying] = useState(false);
  const [val, setVal] = useState("");
  if (!paying) {
    return (
      <div className="flex items-center gap-1.5">
        <button onClick={() => setPaying(true)} className="rounded-lg border border-line bg-white/[0.05] px-2.5 py-1 text-xs text-muted transition-colors hover:border-sky/40 hover:text-sky">Pago</button>
        <button onClick={onSettle} className="rounded-lg border border-line bg-white/[0.05] px-2.5 py-1 text-xs text-muted transition-colors hover:border-emerald/40 hover:text-emerald">Saldar</button>
      </div>
    );
  }
  const amount = Number(val.replace(/[^\d]/g, "")) || 0;
  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center rounded-lg border border-line bg-white/[0.05] px-2 py-1">
        <span className="text-xs text-faint">$</span>
        <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && amount > 0) onPay(amount); }} inputMode="numeric" placeholder="monto" className="tnum w-20 bg-transparent text-xs text-fg outline-none placeholder:text-faint" />
      </div>
      <button onClick={() => { if (amount > 0) onPay(amount); }} className="rounded-lg bg-emerald/90 px-2 py-1 text-xs font-medium text-bg">OK</button>
      <button onClick={() => { setPaying(false); setVal(""); }} className="grid h-6 w-6 place-items-center rounded-lg border border-line text-xs text-muted">✕</button>
    </div>
  );
}

function NewDebtForm({ persons, onSaved, onClose }: { persons: { id: number; name: string }[]; onSaved: () => Promise<void>; onClose: () => void }) {
  const [kind, setKind] = useState<DebtKind>("cash");
  const [direction, setDirection] = useState<"to_collect" | "to_pay">("to_collect");
  const [personId, setPersonId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"ARS" | "USD" | "USDT">("ARS");
  const [participants, setParticipants] = useState("2");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  const [newPerson, setNewPerson] = useState("");

  useEffect(() => { if (persons.length && !personId) setPersonId(String(persons[0].id)); }, [persons]);

  const savePerson = async () => {
    const name = newPerson.trim();
    if (!name) return;
    const id = await insertPerson(db(), name);
    await onSaved(); // recarga la lista de personas
    setPersonId(String(id));
    setNewPerson("");
    setAddingPerson(false);
  };

  const m = kindMeta[kind];
  const total = Number(amount.replace(/[^\d]/g, "")) || 0;
  const parts = Math.max(1, Number(participants) || 1);
  const yourShare = kind === "split" ? Math.round(total / parts) : 0;
  const owed = kind === "split" ? total - yourShare : total;

  const save = async () => {
    if (!total) return;
    setSaving(true); setOk(false);
    try {
      await insertDebt(db(), {
        personId: personId ? Number(personId) : null,
        kind, direction, amount: owed, currency,
        description: desc || (kind === "split" ? "Gasto compartido" : kind === "in_kind" ? "En especie" : "Préstamo"),
        ...(kind === "split" ? { splitTotal: total, yourShare, participants: parts } : {}),
      });
      await onSaved();
      setAmount(""); setDesc(""); setOk(true);
      // Se cierra solo: la deuda ya aparece en la lista de la izquierda.
      setTimeout(() => { setOk(false); onClose(); }, 1200);
    } finally { setSaving(false); }
  };

  return (
    <Modal title="Nueva deuda" onClose={onClose}>
      <div>
        <p className="-mt-2 mb-4 text-xs text-faint">{m.hint}</p>

        <div className="mt-4 grid grid-cols-3 gap-2">
          {(Object.keys(kindMeta) as DebtKind[]).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`rounded-xl border px-2 py-2.5 text-center text-xs transition-colors ${kind === k ? `${kindMeta[k].bg} ${kindMeta[k].cls}` : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>
              <span className="block text-base">{kindMeta[k].emoji}</span>
              {kindMeta[k].label}
            </button>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => setDirection("to_collect")} className={`rounded-xl border py-2.5 text-sm transition-colors ${direction === "to_collect" ? "border-emerald/40 bg-emerald/10 text-emerald" : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>Me deben</button>
          <button onClick={() => setDirection("to_pay")} className={`rounded-xl border py-2.5 text-sm transition-colors ${direction === "to_pay" ? "border-coral/40 bg-coral/10 text-coral" : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>Yo debo</button>
        </div>

        <Field label="Persona">
          {addingPerson ? (
            <div className="flex items-center gap-2">
              <input autoFocus value={newPerson} onChange={(e) => setNewPerson(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") savePerson(); }} placeholder="Nombre…" className="w-full rounded-xl border border-accent/40 bg-white/[0.06] px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint" />
              <button onClick={savePerson} className="shrink-0 rounded-xl bg-accent px-3 py-2.5 text-sm font-medium text-bg">OK</button>
              <button onClick={() => { setAddingPerson(false); setNewPerson(""); }} className="shrink-0 rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-muted">✕</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <FullSelect value={personId} onChange={setPersonId}>
                  {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </FullSelect>
              </div>
              <button onClick={() => setAddingPerson(true)} title="Agregar persona" className="shrink-0 rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-muted transition-colors hover:border-accent/40 hover:text-accent">＋ Nueva</button>
            </div>
          )}
        </Field>

        <Field label={kind === "split" ? "Monto total del gasto" : kind === "in_kind" ? "Valor estimado" : "Monto"}>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.06] px-3 py-2.5">
            <span className="text-lg text-faint">{currency === "ARS" ? "$" : currency === "USD" ? "US$" : "₮"}</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="0" className="tnum w-full bg-transparent text-xl text-fg outline-none placeholder:text-faint" />
          </div>
          <div className="mt-2 flex gap-1.5">
            {(["ARS", "USD", "USDT"] as const).map((c) => (
              <button key={c} onClick={() => setCurrency(c)} className={`rounded-full border px-3 py-1 text-xs transition-colors ${currency === c ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>{c}</button>
            ))}
          </div>
        </Field>

        {kind === "split" && (
          <>
            <Field label="¿Entre cuántos se divide?">
              <div className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.06] px-3 py-2.5">
                <input value={participants} onChange={(e) => setParticipants(e.target.value)} inputMode="numeric" className="tnum w-16 bg-transparent text-lg text-fg outline-none" />
                <span className="text-sm text-faint">personas (vos incluido)</span>
              </div>
            </Field>
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-sky/25 bg-sky/8 p-3 text-center">
              <div><p className="text-[0.65rem] text-muted">Tu parte (gasto)</p><p className="tnum mt-0.5 text-sm text-fg">{ars(yourShare)}</p></div>
              <div><p className="text-[0.65rem] text-muted">Te deben</p><p className="tnum mt-0.5 text-sm text-sky">{ars(owed)}</p></div>
            </div>
          </>
        )}

        {kind === "cash" && (
          <p className="mt-3 flex items-center gap-2 rounded-xl border border-emerald/20 bg-emerald/8 px-3 py-2 text-xs text-emerald">
            <Swap className="h-4 w-4" /> Se registra como movimiento real (no suma a tus gastos).
          </p>
        )}

        <Field label="Descripción">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ej: Cena, préstamo, objeto…" className="w-full rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40" />
        </Field>

        <button onClick={save} disabled={saving} className="mt-5 w-full rounded-[13px] bg-accent py-3 text-sm font-semibold text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">
          {saving ? "Guardando…" : "Registrar deuda"}
        </button>
        {ok && <p className="mt-3 rounded-lg border border-emerald/30 bg-emerald/10 px-3 py-2 text-center text-xs text-emerald">✓ Guardado</p>}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <label className="text-xs text-muted">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function FullSelect({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full appearance-none rounded-xl border border-line bg-white/[0.06] py-2.5 pl-3 pr-9 text-sm text-fg outline-none focus:border-accent/40">{children}</select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint">▾</span>
    </div>
  );
}
