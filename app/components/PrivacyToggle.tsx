"use client";

// Modo privacidad: desenfoca todos los montos (.tnum) cuando está activo.
// El estado vive en un store mínimo (persistido en localStorage). La clase `privacy`
// se aplica en el div raíz del Shell vía useSyncExternalStore → sin mismatch de hidratación.
import { useSyncExternalStore } from "react";
import { Eye, EyeOff } from "../icons";

let on = false;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") on = localStorage.getItem("plata.privacy") === "1";

function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function getSnapshot() { return on; }

// useSyncExternalStore: en SSR e hidratación inicial devuelve `false` (matchea al server),
// y recién después de hidratar pasa al valor real de localStorage → no rompe la hidratación.
export function usePrivacy() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function togglePrivacy() {
  on = !on;
  try { localStorage.setItem("plata.privacy", on ? "1" : "0"); } catch { /* noop */ }
  listeners.forEach((l) => l());
}

export default function PrivacyToggle({ className = "" }: { className?: string }) {
  const active = usePrivacy();
  return (
    <button
      onClick={togglePrivacy}
      aria-pressed={active}
      title={active ? "Mostrar montos" : "Ocultar montos"}
      className={`relative grid h-10 w-10 place-items-center rounded-full border border-line bg-white/[0.05] transition-colors ${active ? "border-accent/40 text-accent" : "text-muted hover:text-fg"} ${className}`}
    >
      {active ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
    </button>
  );
}
