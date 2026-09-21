"use client";

import { useState } from "react";
import { db, updateStatementDates, reassignStatementConsumos, type StatementRow } from "@/lib/db";
import { X } from "../icons";

export default function EditDatesModal({ statement, onClose, onSaved }: {
  statement: StatementRow; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [closing, setClosing] = useState(statement.closingRaw?.slice(0, 10) ?? "");
  const [due, setDue] = useState(statement.dueRaw?.slice(0, 10) ?? "");
  const [reacomodar, setReacomodar] = useState(true);
  const [busy, setBusy] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  const save = async () => {
    if (!closing || !due) return;
    setBusy(true);
    try {
      // updateCardDefault=true: las futuras heredan estas fechas. Las viejas no se tocan.
      await updateStatementDates(db(), statement.id, closing, due, statement.cardId, true);
      // El statement_id vive en cada transacción: sin esto, mover el cierre no mueve los
      // consumos y el resumen sigue mostrando los que ya cayeron del otro lado del corte.
      if (reacomodar) {
        const r = await reassignStatementConsumos(db(), statement.cardId);
        await onSaved();
        if (r.movidos) {
          setResultado(`${r.movidos} consumo${r.movidos === 1 ? "" : "s"} reubicado${r.movidos === 1 ? "" : "s"}: ${r.detalle.map((d) => `${d.desc} (${d.de} → ${d.a})`).join(", ")}`);
          setBusy(false);
          return; // el detalle queda a la vista; el usuario cierra cuando lo leyó
        }
      } else {
        await onSaved();
      }
      onClose();
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

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5">
          <input type="checkbox" checked={reacomodar} onChange={(e) => setReacomodar(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-accent" />
          <span className="text-xs text-muted">
            <b className="text-fg">Reacomodar los consumos</b> según el nuevo cierre. El banco corta unos días antes del día nominal, así que los consumos de esa ventana van al resumen siguiente. Los resúmenes <b>ya pagados no se tocan</b>.
          </span>
        </label>

        {resultado && <p className="mt-3 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent">{resultado}</p>}

        <button onClick={resultado ? onClose : save} disabled={busy} className="mt-5 w-full rounded-xl bg-accent py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">{busy ? "Guardando…" : resultado ? "Listo" : "Guardar fechas"}</button>
      </div>
    </div>
  );
}
