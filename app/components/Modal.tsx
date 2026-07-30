"use client";

import { useEffect } from "react";
import { X } from "../icons";

/**
 * Modal centrado, la forma estándar de las altas (movimiento, deuda, regla).
 *
 * Detalles que importan y ya nos mordieron antes:
 * - `flex + overflow-y-auto` en vez de `grid place-items-center`: con el teclado
 *   abierto en mobile el contenido tiene que poder scrollear.
 * - El overlay cierra al click, pero la card frena la propagación.
 * - Escape también cierra, y mientras está abierto se bloquea el scroll del body.
 */
export default function Modal({
  title,
  onClose,
  children,
  maxWidth = "max-w-md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(3,4,4,0.6)] p-4 backdrop-blur-[6px] sm:items-center"
      style={{ animation: "pageEnter .2s ease both" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`rise panel my-auto w-full ${maxWidth} p-6`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-display text-[18px] font-semibold text-fg">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-white/[0.06] text-subtle transition-colors hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
