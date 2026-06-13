"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sparkle, Send, X, Mic } from "../icons";
import { useAssistantChat, MessageList } from "./assistantChat";
import { useDictation } from "./useDictation";

// Asistente flotante (modal) para las pantallas que no son el Resumen.
export default function Assistant() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const chat = useAssistantChat();
  const dictation = useDictation(chat.setInput, { silenceMs: 3000, onSilence: (t) => chat.send(t) });

  if (pathname === "/") return null; // en Resumen el chat vive dentro de la barra

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} className="ai-glow fixed! bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full text-violet shadow-lg transition-transform hover:scale-105 lg:bottom-6 lg:right-6" title="Asistente IA">
          <Sparkle className="h-6 w-6" />
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-end sm:justify-end sm:p-6">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="ai-glow relative flex h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-surface sm:h-[600px] sm:rounded-3xl">
            <header className="flex items-center gap-2 border-b border-line/60 px-4 py-3">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-violet/15 text-violet"><Sparkle className="h-4 w-4" /></span>
              <div className="leading-tight">
                <p className="font-display text-fg">Asistente</p>
                <p className="text-[0.65rem] text-faint">Contame y registro por vos</p>
              </div>
              <button onClick={() => setOpen(false)} className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg"><X className="h-4 w-4" /></button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <MessageList chat={chat} onConfirm={(i, p) => chat.confirm(i, p)} />
            </div>

            <div className="border-t border-line/60 p-3">
              <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface-2 px-3 py-2">
                <textarea
                  value={chat.input} onChange={(e) => chat.setInput(e.target.value)} rows={1}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chat.send(); } }}
                  placeholder={dictation.listening ? "Escuchando… (corta a los 3s de silencio)" : "Contame tu gasto…"} className="max-h-24 flex-1 resize-none bg-transparent text-sm text-fg outline-none placeholder:text-faint"
                />
                {dictation.supported && (
                  <button onClick={dictation.toggle} title={dictation.listening ? "Detener" : "Dictar por voz"} className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors ${dictation.listening ? "bg-coral/20 text-coral" : "text-faint hover:text-violet"}`}><Mic className={`h-4 w-4 ${dictation.listening ? "pulse-dot" : ""}`} /></button>
                )}
                <button onClick={() => chat.send()} disabled={chat.loading || !chat.input.trim()} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet/90 text-bg transition-opacity disabled:opacity-40"><Send className="h-4 w-4" /></button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
