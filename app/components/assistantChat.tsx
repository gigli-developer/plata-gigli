"use client";

import { useEffect, useRef, useState } from "react";
import {
  db, askAssistant, fetchCategories, fetchPaymentMethods, fetchPersons, insertPerson, insertTransaction, insertDebt,
  type AssistantProposal, type Category, type PaymentMethod,
} from "@/lib/db";
import { ars, usd } from "@/lib/format";

export type Msg = { role: "user" | "assistant"; content: string; proposal?: AssistantProposal | null; options?: string[] | null; cost?: number; tokens?: number; done?: boolean };
const money = (n: number, c: string) => (c === "ARS" ? ars(n) : c === "USD" ? usd(n) : `${n} ${c}`);
const GREETING: Msg = { role: "assistant", content: "¡Hola! Contame tu día y registro los movimientos. Ej: «Pagué $12.000 de delivery con débito» o «Comí con los chicos $30.000 con la tarjeta, Thiago y Toto me deben»." };

// Toda la lógica del asistente, reutilizable por la barra inline y por el modal.
export function useAssistantChat() {
  const [msgs, setMsgs] = useState<Msg[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cats, setCats] = useState<Category[]>([]);
  const [pms, setPms] = useState<PaymentMethod[]>([]);
  const [persons, setPersons] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    const sb = db();
    Promise.all([fetchCategories(sb), fetchPaymentMethods(sb), fetchPersons(sb)]).then(([c, p, pe]) => { setCats(c); setPms(p); setPersons(pe); });
  }, []);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || loading) return;
    if (!override) setInput("");
    const history = [...msgs.filter((m) => !m.done), { role: "user" as const, content: text }];
    setMsgs((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    try {
      const payload = history.map((m) => ({ role: m.role, content: m.content }));
      while (payload.length && payload[0].role !== "user") payload.shift();
      const { reply, proposal, options, costUsd, tokens } = await askAssistant(db(), payload) as any;
      setMsgs((prev) => [...prev, { role: "assistant", content: reply || "Listo.", proposal, options, cost: costUsd ?? undefined, tokens: tokens ?? undefined }]);
    } catch (e: any) {
      setMsgs((prev) => [...prev, { role: "assistant", content: "Uy, hubo un error consultando al asistente. " + (e?.message ?? "") }]);
    } finally {
      setLoading(false);
    }
  };

  const catId = (name: string) => cats.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? cats.find((c) => c.name === "Otros")?.id ?? null;
  const pmId = (name: string) => pms.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  const personId = async (sb: any, name: string) => {
    const found = persons.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const id = await insertPerson(sb, name);
    setPersons((prev) => [...prev, { id, name }]);
    return id;
  };

  const confirm = async (idx: number, p: AssistantProposal, onDone?: () => void) => {
    setBusy(true);
    const sb = db();
    try {
      for (const t of p.transacciones ?? []) {
        await insertTransaction(sb, { type: t.tipo, amount: t.monto, currency: t.moneda, categoryId: catId(t.categoria), paymentMethodId: pmId(t.metodo_pago), description: t.descripcion });
      }
      for (const d of p.deudas ?? []) {
        const pid = await personId(sb, d.persona);
        await insertDebt(sb, { personId: pid, kind: d.tipo, direction: d.direccion === "me_deben" ? "to_collect" : "to_pay", amount: d.monto, currency: d.moneda, description: d.descripcion, splitTotal: d.total_dividido, yourShare: d.tu_parte, participants: d.participantes });
      }
      setMsgs((prev) => prev.map((m, i) => (i === idx ? { ...m, proposal: null } : m)).concat([{ role: "assistant", content: "✅ ¡Registrado!", done: true }]));
      onDone?.();
    } catch (e: any) {
      setMsgs((prev) => [...prev, { role: "assistant", content: "No pude guardar: " + (e?.message ?? "") }]);
    } finally {
      setBusy(false);
    }
  };

  const discard = (idx: number) => setMsgs((prev) => prev.map((m, i) => (i === idx ? { ...m, proposal: null } : m)).concat([{ role: "assistant", content: "Listo, lo descarté.", done: true }]));
  const reset = () => { setMsgs([GREETING]); setInput(""); };
  const hasConversation = msgs.some((m) => m.role === "user") || loading;

  return { msgs, input, setInput, loading, busy, send, confirm, discard, reset, hasConversation };
}

// Lista de mensajes (burbujas) + tarjeta de propuesta.
export function MessageList({ chat, onConfirm }: { chat: ReturnType<typeof useAssistantChat>; onConfirm: (idx: number, p: AssistantProposal) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" }); }, [chat.msgs, chat.loading]);
  return (
    <div ref={ref} className="flex flex-col gap-3 overflow-y-auto">
      {chat.msgs.map((m, i) => (
        <div key={i}>
          <div className={`max-w-[88%] rounded-2xl px-3.5 py-2 text-sm ${m.role === "user" ? "ml-auto bg-violet/20 text-fg" : "bg-surface-2 text-fg/90"}`}>{m.content}</div>
          {m.options && m.options.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {m.options.map((o) => <button key={o} onClick={() => chat.send(o)} disabled={chat.loading} className="rounded-full border border-violet/30 bg-violet/10 px-3 py-1 text-xs text-violet transition-colors hover:bg-violet/20 disabled:opacity-50">{o}</button>)}
            </div>
          )}
          {m.proposal && (m.proposal.transacciones?.length || m.proposal.deudas?.length) && (
            <ProposalCard p={m.proposal} busy={chat.busy} onConfirm={() => onConfirm(i, m.proposal!)} onDiscard={() => chat.discard(i)} />
          )}
          {m.role === "assistant" && m.cost != null && <p className="mt-1 text-[0.6rem] text-faint" title={`US$ ${m.cost.toFixed(4)} · ${m.tokens} tokens`}>costo ≈ ${Math.max(1, Math.round(m.cost * 1455)).toLocaleString("es-AR")} pesos</p>}
        </div>
      ))}
      {chat.loading && <div className="max-w-[88%] rounded-2xl bg-surface-2 px-3.5 py-2 text-sm text-muted">Pensando…</div>}
    </div>
  );
}

export function ProposalCard({ p, busy, onConfirm, onDiscard }: { p: AssistantProposal; busy: boolean; onConfirm: () => void; onDiscard: () => void }) {
  return (
    <div className="mt-2 max-w-[92%] rounded-2xl border border-violet/30 bg-violet/5 p-3">
      <p className="mb-2 text-[0.7rem] uppercase tracking-wider text-violet">Voy a registrar</p>
      <ul className="space-y-1.5">
        {(p.transacciones ?? []).map((t, i) => (
          <li key={`t${i}`} className="flex items-center gap-2 text-sm">
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs ${t.tipo === "ingreso" ? "bg-emerald/15 text-emerald" : "bg-coral/15 text-coral"}`}>{t.tipo === "ingreso" ? "↑" : "↓"}</span>
            <span className="min-w-0 flex-1 truncate text-fg/90">{t.descripcion} <span className="text-faint">· {t.categoria} · {t.metodo_pago}</span></span>
            <span className="tnum shrink-0 text-fg">{money(t.monto, t.moneda)}</span>
          </li>
        ))}
        {(p.deudas ?? []).map((d, i) => (
          <li key={`d${i}`} className="flex items-center gap-2 text-sm">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-amber/15 text-xs text-amber">🤝</span>
            <span className="min-w-0 flex-1 truncate text-fg/90">{d.direccion === "me_deben" ? `${d.persona} te debe` : `Le debés a ${d.persona}`} <span className="text-faint">· {d.tipo}</span></span>
            <span className="tnum shrink-0 text-fg">{money(d.monto, d.moneda)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <button onClick={onConfirm} disabled={busy} className="flex-1 rounded-xl bg-lime px-3 py-1.5 text-sm font-medium text-bg transition-opacity disabled:opacity-50">{busy ? "Guardando…" : "Confirmar"}</button>
        <button onClick={onDiscard} disabled={busy} className="rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-sm text-muted hover:text-fg">Descartar</button>
      </div>
    </div>
  );
}
