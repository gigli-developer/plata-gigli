"use client";

import { useState } from "react";
import { db, insertCard, updateCard, archiveCard, last4EnUso, type CardFull } from "@/lib/db";
import { X, Trash, Card as CardIcon } from "../icons";

const REDES = ["VISA", "Mastercard", "AMEX"];

// Alta y edición de tarjetas de crédito. card === null → alta.
// Solo crédito: /tarjetas oculta las de débito (esCredito), así que crear una
// desde acá la haría desaparecer al guardar.
export default function CardModal({ card, onClose, onSaved }: {
  card: CardFull | null; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(card?.name ?? "");
  const [bank, setBank] = useState(card?.bank ?? "");
  const [network, setNetwork] = useState(card?.network ?? "VISA");
  const [last4, setLast4] = useState(card?.last4 ?? "");
  const [limit, setLimit] = useState(card?.limitArs != null ? String(card.limitArs) : "");
  const [closeDay, setCloseDay] = useState(card?.closeDay != null ? String(card.closeDay) : "");
  const [dueDay, setDueDay] = useState(card?.dueDay != null ? String(card.dueDay) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Formato argentino: punto = miles, coma = decimales.
  const parseMonto = (s: string) => Number(s.trim().replace(/\./g, "").replace(",", "."));

  const save = async () => {
    setErr(null);
    const cd = Number(closeDay), dd = Number(dueDay);
    const lim = limit.trim() ? parseMonto(limit) : null;
    if (!name.trim()) return setErr("Poné un nombre para la tarjeta.");
    if (!Number.isInteger(cd) || cd < 1 || cd > 31) return setErr("El día de cierre tiene que ser un número del 1 al 31.");
    if (!Number.isInteger(dd) || dd < 1 || dd > 31) return setErr("El día de vencimiento tiene que ser un número del 1 al 31.");
    if (last4.trim() && !/^\d{4}$/.test(last4.trim())) return setErr("Los últimos 4 dígitos tienen que ser exactamente 4 números.");
    if (lim != null && (Number.isNaN(lim) || lim < 0)) return setErr("El límite no es un número válido.");
    setBusy(true);
    try {
      // last4 duplicado = el importador de mails imputa los consumos a la tarjeta equivocada.
      if (last4.trim()) {
        const enUso = await last4EnUso(db(), last4.trim(), card?.id);
        if (enUso) { setErr(`Los dígitos ${last4.trim()} ya los usa "${enUso}". Si se repiten, los consumos que llegan por mail se cargan en la tarjeta equivocada.`); return; }
      }
      const payload = {
        name: name.trim(), bank: bank.trim() || null, network: network || null,
        last4: last4.trim() || null, limitArs: lim, closeDay: cd, dueDay: dd,
      };
      if (card) await updateCard(db(), card.id, payload);
      else await insertCard(db(), payload);
      await onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const archive = async () => {
    if (!card) return;
    if (!confirm(`¿Archivar "${card.name}"?\n\nDeja de aparecer en la app, pero se conservan sus resúmenes, consumos y cuotas.`)) return;
    setBusy(true);
    try { await archiveCard(db(), card.id); await onSaved(); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-fg">{card ? "Editar tarjeta" : "Nueva tarjeta"}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg"><X className="h-4 w-4" /></button>
        </div>

        {!card && (
          <p className="mt-3 flex items-center gap-2 rounded-xl border border-sky/25 bg-sky/8 px-3 py-2 text-xs text-sky">
            <CardIcon className="h-4 w-4 shrink-0" /> Solo tarjetas de <b>crédito</b>. Al guardarla se genera automáticamente su primer resumen.
          </p>
        )}

        <Field label="Nombre">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Platinum Gal" className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-lime/40" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Banco">
            <input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="Galicia" className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-lime/40" />
          </Field>
          <Field label="Red">
            <div className="relative">
              <select value={network} onChange={(e) => setNetwork(e.target.value)} className="w-full appearance-none rounded-xl border border-line bg-surface-2 py-2.5 pl-3 pr-9 text-sm text-fg outline-none focus:border-lime/40">
                {REDES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint">▾</span>
            </div>
          </Field>
        </div>

        <Field label="Últimos 4 dígitos">
          <input value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="2811" className="tnum w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-lime/40" />
          <p className="mt-1 text-[0.68rem] text-faint">Con esto el importador reconoce de qué tarjeta es cada consumo que llega por mail.</p>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Día de cierre">
            <input value={closeDay} onChange={(e) => setCloseDay(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="25" className="tnum w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-center text-fg outline-none placeholder:text-faint focus:border-lime/40" />
          </Field>
          <Field label="Día de vencimiento">
            <input value={dueDay} onChange={(e) => setDueDay(e.target.value.replace(/\D/g, "").slice(0, 2))} inputMode="numeric" placeholder="6" className="tnum w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-center text-fg outline-none placeholder:text-faint focus:border-lime/40" />
          </Field>
        </div>

        <Field label="Límite de compra">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
            <span className="text-lg text-faint">$</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" placeholder="opcional" className="tnum w-full bg-transparent text-lg text-fg outline-none placeholder:text-base placeholder:text-faint" />
          </div>
          <p className="mt-1 text-[0.68rem] text-faint">Se usa para la barra de “uso del límite”. Punto = miles (ej: 5.000.000).</p>
        </Field>

        {err && <p className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">{err}</p>}

        <div className="mt-5 flex gap-2">
          {card && (
            <button onClick={archive} disabled={busy} title="Archivar tarjeta" className="flex items-center gap-1.5 rounded-xl border border-coral/30 bg-coral/10 px-3 py-3 text-sm text-coral transition-colors hover:bg-coral/20 disabled:opacity-60">
              <Trash className="h-4 w-4" /> Archivar
            </button>
          )}
          <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-lime py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">
            {busy ? "Guardando…" : card ? "Guardar cambios" : "Crear tarjeta"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="mt-4"><label className="text-xs text-muted">{label}</label><div className="mt-1">{children}</div></div>;
}
