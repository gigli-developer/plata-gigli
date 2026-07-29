"use client";

import { useState } from "react";
import { db, updateStatementDates, type StatementRow } from "@/lib/db";
import { X } from "../icons";

export default function EditDatesModal({ statement, onClose, onSaved }: {
  statement: StatementRow; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [closing, setClosing] = useState(statement.closingRaw?.slice(0, 10) ?? "");
  const [due, setDue] = useState(statement.dueRaw?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!closing || !due) return;
    setBusy(true);
    try {
      // updateCardDefault=true: las futuras heredan estas fechas. Las viejas no se tocan.
      await updateStatementDates(db(), statement.id, closing, due, statement.cardId, true);
      await onSaved(); onClose();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-fg">Fechas del resumen {statement.period}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg"><X className="h-4 w-4" /></button>
        </div>

        <p className="mt-3 rounded-xl border border-line bg-white/[0.06] px-3 py-2 text-xs text-muted">
          Editás solo este resumen. Los <b>anteriores no se modifican</b> y los <b>próximos heredan</b> estas fechas.
        </p>

        <div className="mt-4">
          <label className="text-xs text-muted">Cierre</label>
          <input type="date" value={closing} onChange={(e) => setClosing(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-fg outline-none [color-scheme:dark] focus:border-accent/40" />
        </div>
        <div className="mt-4">
          <label className="text-xs text-muted">Vencimiento</label>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-fg outline-none [color-scheme:dark] focus:border-coral/40" />
        </div>

        <button onClick={save} disabled={busy} className="mt-5 w-full rounded-xl bg-accent py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">{busy ? "Guardando…" : "Guardar fechas"}</button>
      </div>
    </div>
  );
}
