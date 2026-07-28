"use client";

import { useState } from "react";
import { db, updateInstallmentPlan, deleteInstallmentPlan, type InstallmentRow } from "@/lib/db";
import { X, Trash, Repeat } from "../icons";

export default function EditPlanModal({ plan, onClose, onSaved }: {
  plan: InstallmentRow; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [desc, setDesc] = useState(plan.desc);
  const [emoji, setEmoji] = useState(plan.emoji);
  const [monthly, setMonthly] = useState(String(plan.monthly));
  const [total, setTotal] = useState(String(plan.total));
  const [firstDate, setFirstDate] = useState(plan.firstChargeDate?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const m = Number(monthly.replace(/[^\d.]/g, ""));
    const t = Number(total) || plan.total;
    if (!m || !t) return;
    setBusy(true);
    try {
      await updateInstallmentPlan(db(), plan.id, { description: desc, emoji: emoji || "💳", monthlyAmount: m, totalInstallments: t, firstChargeDate: firstDate });
      await onSaved(); onClose();
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!confirm("¿Borrar este plan de cuotas completo?")) return;
    setBusy(true);
    try { await deleteInstallmentPlan(db(), plan.id); await onSaved(); onClose(); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-fg">Editar plan de cuotas</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg"><X className="h-4 w-4" /></button>
        </div>

        <p className="mt-3 flex items-center gap-2 rounded-xl border border-violet/25 bg-violet/8 px-3 py-2 text-xs text-violet">
          <Repeat className="h-4 w-4 shrink-0" /> Editar el monto o el total afecta <b>todas</b> las cuotas del plan (anteriores y posteriores).
        </p>

        <Field label="Descripción">
          <div className="flex gap-2">
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className="w-14 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-center text-lg outline-none" />
            <input value={desc} onChange={(e) => setDesc(e.target.value)} className="flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-lime/40" />
          </div>
        </Field>
        <Field label="Monto de la cuota (mensual)">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
            <span className="text-lg text-faint">$</span>
            <input value={monthly} onChange={(e) => setMonthly(e.target.value)} inputMode="decimal" className="tnum w-full bg-transparent text-xl text-fg outline-none" />
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Total de cuotas">
            <input value={total} onChange={(e) => setTotal(e.target.value)} inputMode="numeric" className="tnum w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-fg outline-none focus:border-lime/40" />
          </Field>
          <Field label="Fecha 1ª cuota">
            <input type="date" value={firstDate} onChange={(e) => setFirstDate(e.target.value)} className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none [color-scheme:dark] focus:border-lime/40" />
          </Field>
        </div>

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
