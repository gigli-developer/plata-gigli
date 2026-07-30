"use client";

import { useEffect, useMemo, useState } from "react";
import {
  db, fetchTransactions, fetchCategories, fetchPaymentMethods, insertTransaction,
  type TxView, type Category, type PaymentMethod,
} from "@/lib/db";
import { readCache, writeCache } from "@/lib/cache";
import { ars, compact } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import Modal from "../components/Modal";
import EditTxModal from "../components/EditTxModal";
import { Search, Plus, Camera, Mail, Sparkle, ArrowUpRight, ArrowDownRight, Pencil } from "../icons";

type TypeFilter = "todos" | "ingreso" | "egreso";
const CURRENCIES = ["ARS", "USD", "USDT"];

export default function TransaccionesPage() {
  const [items, setItems] = useState<TxView[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TxView | null>(null);
  const [nuevoOpen, setNuevoOpen] = useState(false);

  const [q, setQ] = useState("");
  const [type, setType] = useState<TypeFilter>("todos");
  const [cat, setCat] = useState("todas");
  const [method, setMethod] = useState("todos");

  const reload = async () => {
    const sb = db();
    const [tx, c, m] = await Promise.all([fetchTransactions(sb), fetchCategories(sb), fetchPaymentMethods(sb)]);
    setItems(tx); setCats(c); setMethods(m);
    writeCache("transacciones", { tx, c, m });
  };

  useEffect(() => {
    // Pintar al instante el último snapshot; lo fresco llega por atrás.
    const s = readCache<{ tx: TxView[]; c: Category[]; m: PaymentMethod[] }>("transacciones");
    if (s) { setItems(s.tx); setCats(s.c); setMethods(s.m); setLoading(false); }
    reload().catch((e) => setErr(e.message)).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => items.filter((t) => {
    if (type !== "todos" && t.type !== type) return false;
    if (cat !== "todas" && t.category !== cat) return false;
    if (method !== "todos" && t.method !== method) return false;
    if (q && !t.desc.toLowerCase().includes(q.toLowerCase()) && !t.category.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [items, type, cat, method, q]);

  const totals = useMemo(() => {
    let ingresos = 0, egresos = 0;
    for (const t of filtered) (t.type === "ingreso" ? (ingresos += t.amount) : (egresos += t.amount));
    return { ingresos, egresos, balance: ingresos - egresos, count: filtered.length };
  }, [filtered]);

  const groups = useMemo(() => {
    const map = new Map<string, TxView[]>();
    for (const t of filtered) {
      const day = t.date.split(" · ")[0];
      if (!map.has(day)) map.set(day, []);
      map.get(day)!.push(t);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <>
      <PageHeader title="Transacciones" subtitle={loading ? "Cargando…" : `${items.length} movimientos`}>
        <button onClick={() => setNuevoOpen(true)} className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-bg transition-transform hover:scale-[1.03]">
          <Plus className="h-4 w-4" /> Nuevo movimiento
        </button>
      </PageHeader>

      {err && <p className="mt-4 rounded-xl border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">Error: {err}</p>}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Ingresos" value={totals.ingresos} tone="emerald" up />
        <Stat label="Egresos" value={totals.egresos} tone="coral" />
        <Stat label="Balance" value={totals.balance} tone="accent" up={totals.balance >= 0} />
        <div className="rounded-2xl border border-line bg-white/[0.05] p-4">
          <p className="text-xs text-muted">Movimientos</p>
          <p className="tnum mt-2 text-lg text-fg">{totals.count}</p>
        </div>
      </div>

      <div className="mt-6">
        <div>
          <div className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <label className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-white/[0.06] px-3 py-2">
              <Search className="h-4 w-4 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre o categoría…" className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint" />
            </label>
            <Segmented value={type} onChange={setType} />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Select value={cat} onChange={setCat}>
              <option value="todas">Todas las categorías</option>
              {cats.map((c) => <option key={c.id} value={c.name}>{c.emoji} {c.name}</option>)}
            </Select>
            <Select value={method} onChange={setMethod}>
              <option value="todos">Todos los métodos</option>
              {methods.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
            </Select>
            {(cat !== "todas" || method !== "todos" || type !== "todos" || q) && (
              <button onClick={() => { setCat("todas"); setMethod("todos"); setType("todos"); setQ(""); }} className="rounded-xl border border-line bg-white/[0.06] px-3 py-2 text-xs text-muted hover:text-fg">Limpiar filtros</button>
            )}
          </div>

          <section className="panel mt-3 p-2 sm:p-4">
            {loading ? (
              <p className="px-2 py-10 text-center text-sm text-muted">Cargando movimientos…</p>
            ) : groups.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-muted">No hay movimientos con esos filtros.</p>
            ) : (
              groups.map(([day, rows]) => {
                const dayTotal = rows.reduce((a, t) => a + (t.type === "ingreso" ? t.amount : -t.amount), 0);
                return (
                  <div key={day} className="px-2">
                    <div className="flex items-center justify-between border-b border-line py-2">
                      <span className="text-xs uppercase tracking-wider text-faint">{day}</span>
                      <span className={`tnum text-xs ${dayTotal >= 0 ? "text-emerald" : "text-faint"}`}>{dayTotal >= 0 ? "+" : "−"}{compact(Math.abs(dayTotal))}</span>
                    </div>
                    <ul className="divide-y divide-line">{rows.map((t) => <Row key={t.id} t={t} onEdit={() => setEditing(t)} />)}</ul>
                  </div>
                );
              })
            )}
          </section>
        </div>

      </div>

      {nuevoOpen && <NewMovementForm cats={cats} methods={methods} onSaved={reload} onClose={() => setNuevoOpen(false)} />}
      {editing && <EditTxModal tx={editing} cats={cats} methods={methods} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

function Stat({ label, value, tone, up }: { label: string; value: number; tone: "emerald" | "coral" | "accent"; up?: boolean }) {
  const color = tone === "emerald" ? "text-emerald" : tone === "coral" ? "text-coral" : "text-accent";
  return (
    <div className="rounded-2xl border border-line bg-white/[0.05] p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <span className={`grid h-5 w-5 place-items-center rounded-md bg-white/5 ${color}`}>{up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}</span>
        {label}
      </div>
      <p className="tnum mt-2 text-lg text-fg">{ars(value)}</p>
    </div>
  );
}

function Segmented({ value, onChange }: { value: TypeFilter; onChange: (v: TypeFilter) => void }) {
  const opts: { v: TypeFilter; label: string }[] = [
    { v: "todos", label: "Todos" }, { v: "ingreso", label: "Ingresos" }, { v: "egreso", label: "Egresos" },
  ];
  return (
    <div className="flex rounded-xl border border-line bg-white/[0.06] p-1 text-sm">
      {opts.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} className={`rounded-lg px-3 py-1.5 transition-colors ${value === o.v ? "bg-white/[0.09] text-fg" : "text-muted hover:text-fg"}`}>{o.label}</button>
      ))}
    </div>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="appearance-none rounded-xl border border-line bg-white/[0.06] py-2 pl-3 pr-9 text-sm text-fg outline-none focus:border-accent/40">{children}</select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint">▾</span>
    </div>
  );
}

function Row({ t, onEdit }: { t: TxView; onEdit: () => void }) {
  const sources: Record<string, { label: string; Icon: typeof Camera; cls: string }> = {
    ocr: { label: "OCR", Icon: Camera, cls: "text-sky" },
    email: { label: "Email", Icon: Mail, cls: "text-amber" },
    chat: { label: "Chat", Icon: Sparkle, cls: "text-accent" },
    manual: { label: "Manual", Icon: Plus, cls: "text-faint" },
  };
  const s = sources[t.source] ?? sources.manual;
  const time = t.date.split(" · ")[1] ?? "";
  return (
    <li onClick={onEdit} className="group flex cursor-pointer items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-white/[0.05]">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.06] text-lg">{t.emoji}</span>
      <div className="min-w-0">
        <p className="truncate text-[0.95rem] text-fg">{t.desc}</p>
        <p className="truncate text-xs text-faint">{t.category} · {t.method}{t.card ? ` · ${t.card}` : ""}{time ? ` · ${time}` : ""}</p>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className={`hidden items-center gap-1 rounded-full border border-line bg-white/[0.06] px-2 py-0.5 text-[0.65rem] sm:flex ${s.cls}`}>
          <s.Icon className="h-3 w-3" /> {s.label}
        </span>
        <span className={`tnum text-[0.95rem] ${t.type === "ingreso" ? "text-emerald" : "text-fg"}`}>
          {t.type === "ingreso" ? "+" : "−"}{ars(t.amount).replace("$", "$ ")}
          {t.currency !== "ARS" ? <span className="ml-1 text-[0.65rem] text-faint">{t.currency}</span> : null}
        </span>
        <Pencil className="h-4 w-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </li>
  );
}

function NewMovementForm({ cats, methods, onSaved, onClose }: { cats: Category[]; methods: PaymentMethod[]; onSaved: () => Promise<void>; onClose: () => void }) {
  const [type, setType] = useState<"ingreso" | "egreso">("egreso");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [methodId, setMethodId] = useState<string>("");
  const [currency, setCurrency] = useState("ARS");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);

  // "Cambio Divisas" y "Préstamos" quedan fuera del alta manual: las generan
  // solas /divisas y /deudas (con su contrasiento), y además están excluidas de
  // las métricas de gasto. Cargar una a mano acá desbalancea la contabilidad —
  // y encima "Cambio Divisas" venía preseleccionada por ser la primera de la
  // lista, así que un movimiento guardado sin tocar el select no contaba.
  const catsManuales = useMemo(() => cats.filter((c) => c.name !== "Cambio Divisas" && c.name !== "Préstamos"), [cats]);

  useEffect(() => {
    if (catsManuales.length && !categoryId) {
      const otros = catsManuales.find((c) => c.name === "Otros");
      setCategoryId(String((otros ?? catsManuales[0]).id));
    }
    if (methods.length && !methodId) setMethodId(String(methods[0].id));
  }, [catsManuales, methods]);

  const save = async () => {
    const value = Number(amount.replace(/[^\d]/g, ""));
    if (!value) return;
    setSaving(true); setOk(false);
    try {
      await insertTransaction(db(), {
        type, amount: value, currency,
        categoryId: categoryId ? Number(categoryId) : null,
        paymentMethodId: methodId ? Number(methodId) : null,
        description: desc || null,
      });
      await onSaved();
      setAmount(""); setDesc(""); setOk(true);
      // Se cierra solo: el movimiento nuevo ya quedó arriba de la lista.
      setTimeout(() => { setOk(false); onClose(); }, 1200);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Nuevo movimiento" onClose={onClose}>
      <div>
        <p className="-mt-2 mb-4 text-xs text-faint">Carga manual · también podés usar el asistente 🤖</p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => setType("egreso")} className={`rounded-xl border py-2.5 text-sm transition-colors ${type === "egreso" ? "border-coral/40 bg-coral/10 text-coral" : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>Egreso</button>
          <button onClick={() => setType("ingreso")} className={`rounded-xl border py-2.5 text-sm transition-colors ${type === "ingreso" ? "border-emerald/40 bg-emerald/10 text-emerald" : "border-line bg-white/[0.06] text-muted hover:text-fg"}`}>Ingreso</button>
        </div>

        <div className="mt-4">
          <label className="text-xs text-muted">Monto</label>
          <div className="mt-1 flex items-center gap-2 rounded-xl border border-line bg-white/[0.06] px-3 py-2.5">
            <span className="text-lg text-faint">$</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="0" className="tnum w-full bg-transparent text-xl text-fg outline-none placeholder:text-faint" />
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="appearance-none rounded-lg border border-line bg-white/[0.09] px-2 py-1 text-xs text-muted outline-none">
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <Field label="Categoría">
          <FullSelect value={categoryId} onChange={setCategoryId}>
            {catsManuales.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
          </FullSelect>
        </Field>
        <Field label="Método de pago">
          <FullSelect value={methodId} onChange={setMethodId}>
            {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </FullSelect>
        </Field>
        <Field label="Descripción">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ej: Cena con amigos" className="w-full rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40" />
        </Field>

        <button onClick={save} disabled={saving} className="mt-5 w-full rounded-[13px] bg-accent py-3 text-sm font-semibold text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">
          {saving ? "Guardando…" : "Guardar movimiento"}
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
