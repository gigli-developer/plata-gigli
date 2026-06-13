"use client";

import { useEffect, useRef, useState } from "react";

type Opts = { silenceMs?: number; onSilence?: (text: string) => void };

// Dictado por voz (Web Speech API, es-AR). Modo continuo (no corta en pausas cortas)
// y, si se pasa silenceMs, se detiene y dispara onSilence tras ese tiempo de silencio.
export function useDictation(onText: (t: string) => void, opts?: Opts) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recRef = useRef<any>(null);
  const intentRef = useRef(false);
  const baseRef = useRef("");
  const finalRef = useRef("");
  const timerRef = useRef<any>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const SR = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
    setSupported(!!SR);
  }, []);

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  const armSilence = () => {
    const ms = optsRef.current?.silenceMs ?? 0;
    if (!ms) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      intentRef.current = false;
      setListening(false);
      clearTimer();
      try { recRef.current?.stop(); } catch { /* noop */ }
      const text = finalRef.current.trim();
      if (text) optsRef.current?.onSilence?.(text);
    }, ms);
  };

  const start = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "es-AR";
    rec.interimResults = true;
    rec.continuous = true;
    baseRef.current = finalRef.current;
    rec.onresult = (e: any) => {
      let interim = "", sessionFinal = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) sessionFinal += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      finalRef.current = baseRef.current + sessionFinal;
      onText((finalRef.current + interim).trim());
      armSilence(); // reiniciar el contador de silencio en cada palabra
    };
    rec.onerror = (ev: any) => {
      if (ev?.error === "not-allowed" || ev?.error === "service-not-allowed") { intentRef.current = false; clearTimer(); setListening(false); }
    };
    rec.onend = () => {
      if (intentRef.current) { try { start(); } catch { setListening(false); } }
      else { clearTimer(); setListening(false); }
    };
    recRef.current = rec;
    try { rec.start(); } catch { /* ya iniciado */ }
    armSilence();
  };

  const toggle = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (intentRef.current) {
      intentRef.current = false;
      clearTimer();
      setListening(false);
      try { recRef.current?.stop(); } catch { /* noop */ }
      return;
    }
    intentRef.current = true;
    baseRef.current = "";
    finalRef.current = "";
    setListening(true);
    start();
  };

  return { listening, supported, toggle };
}
