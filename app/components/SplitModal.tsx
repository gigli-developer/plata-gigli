"use client";

import { useEffect, useMemo, useState } from "react";
import { db, fetchPersons, insertPerson, splitTransaction, type TxView, type SplitParte } from "@/lib/db";
import { parseAmount } from "@/lib/format";
import Modal from "./Modal";
import { Plus, Swap } from "../icons";

/**
 * Dividir un gasto entre varias personas.
 *
 * El reparto arranca en partes IGUALES (el caso común) y cada parte se puede pisar
 * a mano. El resto va siempre a tu parte, así el total cierra por construcción y
 * nunca se puede guardar un reparto que no sume.
 */
export default function SplitModal({ tx, onClose, onSaved }: {
  tx: TxView; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [persons, setPersons] = useState<{ id: number; name: string }[]>([]);
  const [elegidas, setElegidas] = useState<number[]>([]);
  // Montos pisados a mano, por persona. Lo que no está acá se reparte parejo.
  const [manual, setManual] = useState<Record<number, string>>({});
  const [nuevo, setNuevo] = useState("");
  const [agregando, setAgregando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { fetchPersons(db()).then(setPersons).catch(() => {}); }, []);

  const total = tx.amount;
  const cur = tx.currency;

  // Reparto: los montos pisados mandan; el resto se divide en partes iguales
  // entre vos y los que no tienen monto propio.
  const reparto = useMemo(() => {
    const pisados = elegidas.filter((id) => manual[id] != null && manual[id] !== "");
    const sumaPisada = pisados.reduce((a, id) => a + parseAmount(manual[id]), 0);
    const libres = elegidas.filter((id) => !pisados.includes(id));
    const resto = total - sumaPisada;
    // +1 = vos, que siempre participás del reparto de lo que quedó libre
    const porCabeza = resto > 0 ? Math.round((resto / (libres.length + 1)) * 100) / 100 : 0;

    const partes: SplitParte[] = elegidas.map((id) => ({
      personId: id,
      personName: persons.find((p) => p.id === id)?.name ?? "?",
      amount: pisados.includes(id) ? parseAmount(manual[id]) : porCabeza,
    }));
    const ajeno = partes.reduce((a, p) => a + p.amount, 0);
    // Tu parte absorbe el redondeo para que la suma dé exacta.
    const tuya = Math.round((total - ajeno) * 100) / 100;
    return { partes, ajeno, tuya };
  }, [elegidas, manual, total, persons]);

  const fmt = (n: number) =>
    cur === "ARS" ? `$ ${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })}`
    : `${n.toLocaleString("es-AR", { maximumFractionDigits: 2 })} ${cur}`;

  const toggle = (id: number) => {
    setElegidas((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    setManual((m) => { const { [id]: _, ...resto } = m; return resto; });
  };

  const agregarPersona = async () => {
    const name = nuevo.trim();
    if (!name) return;
    setErr(null);
    try {
      const id = await insertPerson(db(), name);
      setPersons(await fetchPersons(db()));
      setElegidas((p) => [...p, id]);
      setNuevo(""); setAgregando(false);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const guardar = async () => {
    if (!elegidas.length) { setErr("Elegí con quién lo dividís."); return; }
    if (reparto.tuya < 0) { setErr("Las partes de los demás superan el total del gasto."); return; }
    setBusy(true); setErr(null);
    try {
      await splitTransaction(db(), tx.id, reparto.tuya, reparto.partes);
      await onSaved(); onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Dividir gasto" onClose={onClose}>
      <>
        <div className="panel-inner p-4">
          <p className="text-xs text-faint">{tx.desc}</p>
          <p className="tnum mt-1 text-[22px] font-semibold text-fg">{fmt(total)}</p>
          <p className="mt-1 text-[0.68rem] text-faint">{tx.date} · {tx.method}{tx.card ? ` · ${tx.card}` : ""}</p>
        </div>

        <p className="mt-4 text-xs text-muted">¿Con quién lo dividís?</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {persons.map((p) => (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                elegidas.includes(p.id) ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-white/[0.06] text-muted hover:text-fg"
              }`}
            >
              {p.name}
            </button>
          ))}
          <button onClick={() => setAgregando(true)} className="flex items-center gap-1 rounded-full border border-line bg-white/[0.06] px-3 py-1.5 text-xs text-subtle transition-colors hover:text-fg">
            <Plus className="h-3 w-3" /> Nueva
          </button>
        </div>

        {agregando && (
          <div className="mt-2 flex gap-2">
            <input value={nuevo} onChange={(e) => setNuevo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && agregarPersona()} autoFocus placeholder="Nombre" className="flex-1 rounded-lg border border-line bg-white/[0.06] px-3 py-1.5 text-sm text-fg outline-none focus:border-accent/40" />
            <button onClick={agregarPersona} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-bg">OK</button>
            <button onClick={() => { setAgregando(false); setNuevo(""); }} className="icon-btn h-8 w-8">✕</button>
          </div>
        )}

        {elegidas.length > 0 && (
          <>
            <div className="mt-4 space-y-1.5">
              {/* Vos primero: es la parte que queda como gasto tuyo */}
              <div className="flex items-center gap-3 rounded-xl border border-emerald/25 bg-emerald/8 px-3 py-2.5">
                <span className="flex-1 text-sm text-fg">Vos <span className="text-[0.68rem] text-faint">· queda como tu gasto</span></span>
                <span className="tnum text-sm font-semibold text-emerald">{fmt(reparto.tuya)}</span>
              </div>
              {reparto.partes.map((p) => (
                <div key={p.personId} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.04] px-3 py-2">
                  <span className="flex-1 truncate text-sm text-muted">{p.personName}</span>
                  <input
                    value={manual[p.personId] ?? p.amount.toLocaleString("es-AR", { maximumFractionDigits: 2 })}
                    onChange={(e) => setManual((m) => ({ ...m, [p.personId]: e.target.value }))}
                    inputMode="decimal"
                    className="tnum w-28 rounded-lg border border-line bg-white/[0.06] px-2 py-1 text-right text-sm text-fg outline-none focus:border-accent/40"
                  />
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-xs text-faint">
              Se parte en dos: <b className="text-muted">{fmt(reparto.tuya)}</b> queda en «{tx.category}» como gasto tuyo y{" "}
              <b className="text-muted">{fmt(reparto.ajeno)}</b> pasa a «Préstamos», que no cuenta como gasto.
              {tx.card ? " El resumen de la tarjeta no cambia." : ""}
              {" "}Se crean {reparto.partes.length} {reparto.partes.length === 1 ? "deuda" : "deudas"} a cobrar.
            </div>
          </>
        )}

        {err && <p className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">{err}</p>}

        <button onClick={guardar} disabled={busy || !elegidas.length} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-semibold text-bg transition-transform hover:scale-[1.02] disabled:opacity-50">
          <Swap className="h-4 w-4" /> {busy ? "Dividiendo…" : "Dividir gasto"}
        </button>
      </>
    </Modal>
  );
}
