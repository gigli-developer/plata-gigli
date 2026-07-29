"use client";

import Link from "next/link";
import { X } from "../icons";

type Item = { label: string; Icon: (p: { className?: string }) => React.ReactElement; href: string };

// Hoja inferior con los módulos que no entran en el bottom nav.
// z-30: por debajo de los modales (z-50) y del FAB del asistente (z-40, que se
// esconde mientras esto está abierto).
export default function MoreSheet({ items, pathname, onClose }: {
  items: Item[]; pathname: string; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 lg:hidden" role="dialog" aria-modal="true" aria-label="Más secciones">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[70dvh] overflow-y-auto rounded-t-3xl border-t border-line bg-white/[0.05] pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <div className="mx-auto h-1 w-10 rounded-full bg-white/[0.09]" aria-hidden />
        </div>
        <div className="flex items-center justify-between px-5 pb-3 pt-2">
          <p className="font-display text-lg text-fg">Más secciones</p>
          <button onClick={onClose} aria-label="Cerrar" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="grid grid-cols-2 gap-2 px-4 pb-6">
          {items.map(({ label, Icon, href }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 text-sm transition-colors ${
                  active ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-white/[0.06] text-muted hover:text-fg"
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? "" : "opacity-80"}`} />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
