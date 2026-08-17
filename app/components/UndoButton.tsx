"use client";

import { useEffect, useState } from "react";
import { db, ultimaOperacion, deshacerOperacion, type Activity } from "@/lib/db";
import Modal from "./Modal";
import { Swap } from "../icons";

/**
 * Deshacer la última operación en cascada (dividir un gasto, registrar un cambio,
 * pagar una deuda).
 *
 * NUNCA actúa a ciegas: primero muestra QUÉ va a deshacer y qué se borra. El motivo
 * es concreto — el email-poller importa consumos cada 15 min, así que "lo último que
 * pasó" no es "lo último que hiciste vos". Por eso el botón lee un registro de
 * operaciones propias (`activity_log`) y no simplemente el último movimiento.
 *
 * Si no hay nada que deshacer, el botón no se renderiza: no ocupa lugar al pedo.
 */
export default function UndoButton({ onDone }: { onDone: () => Promise<void> }) {
  const [op, setOp] = useState<Activity | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refrescar = () => { ultimaOperacion(db()).then(setOp).catch(() => setOp(null)); };
  useEffect(() => { refrescar(); }, []);

  if (!op) return null;

  const QUE_BORRA: Record<string, string> = {
    split: "Vuelve a juntar el gasto en un solo movimiento y borra las deudas que había creado.",
    exchange: "Borra el cambio y los dos movimientos que generó en Transacciones. Los saldos vuelven atrás.",
    debt_payment: "Borra el pago y su movimiento de plata. Si la deuda había quedado saldada, vuelve a estar pendiente.",
  };

  const deshacer = async () => {
    setBusy(true); setErr(null);
    try {
      await deshacerOperacion(db(), op);
      await onDone();
      setAbierto(false);
      refrescar();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button
        onClick={() => { setErr(null); setAbierto(true); }}
        title={op.label}
        className="flex items-center gap-2 rounded-full border border-line bg-white/[0.06] px-3.5 py-2 text-sm text-muted transition-colors hover:text-fg"
      >
        <Swap className="h-4 w-4" /> Deshacer
      </button>

      {abierto && (
        <Modal title="Deshacer última operación" onClose={() => setAbierto(false)} maxWidth="max-w-sm">
          <>
            <div className="panel-inner p-4">
              <p className="text-sm text-fg">{op.label}</p>
              <p className="mt-1 text-[0.68rem] text-faint">
                {new Date(op.createdAt).toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
            <p className="mt-3 text-xs text-muted">{QUE_BORRA[op.kind] ?? "Revierte la operación."}</p>

            {err && <p className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">{err}</p>}

            <div className="mt-5 flex gap-2">
              <button onClick={() => setAbierto(false)} disabled={busy} className="flex-1 rounded-xl border border-line bg-white/[0.06] py-3 text-sm text-muted transition-colors hover:text-fg disabled:opacity-60">
                Cancelar
              </button>
              <button onClick={deshacer} disabled={busy} className="flex-1 rounded-xl bg-coral py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">
                {busy ? "Deshaciendo…" : "Sí, deshacer"}
              </button>
            </div>
          </>
        </Modal>
      )}
    </>
  );
}
