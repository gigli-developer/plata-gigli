"use client";

import { useState } from "react";
import { db, updateTransaction, deleteTransaction, type TxView, type Category, type PaymentMethod } from "@/lib/db";
import { X, Trash } from "../icons";

const CURRENCIES = ["ARS", "USD", "USDT"];

function toDateInput(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function EditTxModal({ tx, cats, methods, onClose, onSaved }: {
  tx: TxView; cats: Category[]; methods: PaymentMethod[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [type, setType] = useState<"ingreso" | "egreso">(tx.type);
  const [amount, setAmount] = useState(String(tx.amount));
  const [currency, setCurrency] = useState(tx.currency);
  const [categoryId, setCategoryId] = useState(tx.categoryId ? String(tx.categoryId) : "");
  const [methodId, setMethodId] = useState(tx.paymentMethodId ? String(tx.paymentMethodId) : "");
  const [desc, setDesc] = useState(tx.desc);
  const [date, setDate] = useState(toDateInput(tx.occurredAt));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const value = Number(amount.replace(/[^\d.]/g, ""));
    if (!value) return;
    setBusy(true);
    try {
      await updateTransaction(db(), tx.id, {
        type, amount: value, currency,
        categoryId: categoryId ? Number(categoryId) : null,
        paymentMethodId: methodId ? Number(methodId) : null,
        description: desc || null,
        occurredAt: new Date(`${date}T12:00:00`).toISOString(),
      });
      await onSaved(); onClose();
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm("¿Borrar este movimiento? No se puede deshacer.")) return;
    setBusy(true);
    try { await deleteTransaction(db(), tx.id); await onSaved(); onClose(); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-fg">Editar movimiento</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => setType("egreso")} className={`rounded-xl border py-2.5 text-sm transition-colors ${type === "egreso" ? "border-coral/40 bg-coral/10 text-coral" : "border-line bg-surface-2 text-muted hover:text-fg"}`}>Egreso</button>
          <button onClick={() => setType("ingreso")} className={`rounded-xl border py-2.5 text-sm transition-colors ${type === "ingreso" ? "border-emerald/40 bg-emerald/10 text-emerald" : "border-line bg-surface-2 text-muted hover:text-fg"}`}>Ingreso</button>
        </div>

        <label className="mt-4 block text-xs text-muted">Monto</label>
        <div className="mt-1 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
          <span className="text-lg text-faint">$</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="tnum w-full bg-transparent text-xl text-fg outline-none" />
          <select value={currency} onChange={(e) => setCurrency(e.target.value as TxView["currency"])} className="appearance-none rounded-lg border border-line bg-surface-3 px-2 py-1 text-xs text-muted outline-none">
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>

        <Field label="Categoría">
          <Sel value={categoryId} onChange={setCategoryId}><option value="">— sin categoría —</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}</Sel>
        </Field>
        <Field label="Método de pago">
          <Sel value={methodId} onChange={setMethodId}><option value="">—</option>{methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Sel>
        </Field>
        <Field label="Descripción">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-lime/40" />
        </Field>
        <Field label="Fecha">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none [color-scheme:dark] focus:border-lime/40" />
        </Field>

        <div className="mt-5 flex gap-2">
          <button onClick={remove} disabled={busy} className="flex items-center gap-1.5 rounded-xl border border-coral/30 bg-coral/10 px-3 py-3 text-sm text-coral transition-colors hover:bg-coral/20 disabled:opacity-60"><Trash className="h-4 w-4" /> Borrar</button>
          <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-lime py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">{busy ? "Guardando…" : "Guardar cambios"}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="mt-4"><label className="text-xs text-muted">{label}</label><div className="mt-1">{children}</div></div>;
}
function Sel({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full appearance-none rounded-xl border border-line bg-surface-2 py-2.5 pl-3 pr-9 text-sm text-fg outline-none focus:border-lime/40">{children}</select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint">▾</span>
    </div>
  );
}
