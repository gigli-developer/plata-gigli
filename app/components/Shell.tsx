"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Grid, Swap, Card as CardIcon, Handshake, Repeat, Coins, Gear, Bell, Chart, Flow, Tag, Dots, Bug } from "../icons";
import MoreSheet from "./MoreSheet";
import { createClient } from "@/lib/supabase/client";
import PrivacyToggle, { usePrivacy } from "./PrivacyToggle";

export const nav = [
  { label: "Resumen", Icon: Grid, href: "/" },
  { label: "Métricas", Icon: Chart, href: "/metricas" },
  { label: "Gastos hormiga", Icon: Bug, href: "/hormiga" },
  { label: "Cash Flow", Icon: Flow, href: "/cashflow" },
  { label: "Transacciones", Icon: Swap, href: "/transacciones" },
  { label: "Tarjetas", Icon: CardIcon, href: "/tarjetas" },
  { label: "Deudas", Icon: Handshake, href: "/deudas" },
  { label: "Recurrentes", Icon: Repeat, href: "/recurrentes" },
  { label: "Divisas", Icon: Coins, href: "/divisas" },
  { label: "Reglas", Icon: Tag, href: "/reglas" },
];

// Los 5 que quedan fijos en el bottom nav de mobile; el resto va al botón "Más".
// Para cambiarlos, editá esta lista (tienen que existir en `nav`).
const MOBILE_FIJOS = ["/", "/metricas", "/hormiga", "/transacciones", "/tarjetas"];
// Etiqueta corta para que entren 6 slots en pantallas de 360px.
const SHORT: Record<string, string> = { "/": "Resumen", "/metricas": "Métricas", "/hormiga": "Hormiga", "/transacciones": "Movs", "/tarjetas": "Tarjetas", "/cashflow": "Flujo" };

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/** Logo: tile naranja con la "P", como en el rediseño. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <div className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent font-display text-[17px] font-extrabold text-bg">P</div>
      {!compact ? (
        <div className="leading-none">
          <p className="font-display text-lg text-fg">Plata</p>
          <p className="label-micro">finanzas</p>
        </div>
      ) : (
        <p className="font-display text-[19px] font-bold text-fg">Plata</p>
      )}
    </Link>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const privacy = usePrivacy();
  const [moreOpen, setMoreOpen] = useState(false);
  const navFijos = MOBILE_FIJOS.map((h) => nav.find((n) => n.href === h)).filter((n) => !!n);
  const navResto = nav.filter((n) => !MOBILE_FIJOS.includes(n.href));

  const logout = async () => {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  };

  // El login y rutas de auth no llevan el chrome (sidebar / nav).
  if (pathname === "/login" || pathname.startsWith("/auth")) {
    return <>{children}</>;
  }

  return (
    <div className={`flex min-h-screen ${privacy ? "privacy" : ""}`}>
      {/* ── Rail desktop ──────────────────────────────────────────────
          Píldora de vidrio flotante, centrada verticalmente. El <aside>
          reserva el ancho (el rail va fixed, si no el contenido se le mete
          debajo) y queda alineado al borde del contenido de 1480px. */}
      <aside className="hidden w-[92px] shrink-0 lg:block">
        <nav
          aria-label="Secciones"
          className="fixed top-1/2 z-40 flex w-[76px] -translate-y-1/2 flex-col items-center rounded-[40px] border border-white/30 bg-white/[0.06] shadow-[0_24px_60px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.16)] backdrop-blur-[28px] backdrop-saturate-150"
          style={{ left: "max(20px, calc((100vw - 1580px) / 2))" }}
        >
          <div className="flex w-full flex-col items-center gap-2 px-0 pb-1.5 pt-4">
            {nav.map(({ label, Icon, href }) => {
              const a = isActive(pathname, href);
              return (
                <Link
                  key={href}
                  href={href}
                  title={label}
                  aria-label={label}
                  aria-current={a ? "page" : undefined}
                  className={`grid h-[46px] w-[46px] place-items-center rounded-[15px] transition-transform duration-150 ease-[cubic-bezier(.22,.61,.36,1)] hover:scale-[1.16] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    a
                      ? "bg-accent text-bg shadow-[0_6px_18px_rgba(255,158,27,0.45)]"
                      : "text-subtle hover:bg-white/[0.07] hover:text-fg"
                  }`}
                >
                  <Icon className="h-[22px] w-[22px]" />
                </Link>
              );
            })}
          </div>
          <div className="flex flex-col items-center gap-2.5 px-0 pb-[18px] pt-2">
            <div className="mb-1 h-px w-[38px] bg-white/10" />
            <button title="Configuración" aria-label="Configuración" className="grid h-[46px] w-[46px] place-items-center rounded-[15px] text-subtle transition-colors hover:bg-white/[0.07] hover:text-fg">
              <Gear className="h-5 w-5" />
            </button>
            <button onClick={logout} title="Salir" aria-label="Cerrar sesión" className="grid h-[46px] w-[46px] place-items-center rounded-[15px] text-subtle transition-colors hover:bg-coral/[0.12] hover:text-coral">
              <Swap className="h-5 w-5 rotate-90" />
            </button>
          </div>
        </nav>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header mobile: sticky, de vidrio */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/[0.07] bg-white/[0.06] px-[18px] py-3.5 backdrop-blur-[22px] backdrop-saturate-150 lg:hidden">
          <Brand compact />
          <div className="ml-auto flex items-center gap-2">
            <PrivacyToggle />
            <button aria-label="Notificaciones" className="relative grid h-9 w-9 place-items-center rounded-[10px] border border-white/[0.06] bg-white/[0.06] text-subtle">
              <Bell className="h-[18px] w-[18px]" />
              <span className="absolute right-2 top-2 h-[7px] w-[7px] rounded-full bg-coral pulse-dot" />
            </button>
            <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-gradient-to-br from-accent to-sky text-sm font-bold text-bg">G</span>
          </div>
        </header>

        <main className="pb-nav mx-auto w-full max-w-[1480px] px-4 pt-5 lg:px-16 lg:pb-14 lg:pt-8">
          <div key={pathname} className="page-enter">{children}</div>
        </main>
      </div>

      {/* ── Bottom nav mobile: píldora flotante ──────────────────────
          El dock magnify del prototipo se omitió a propósito: es hover-only
          y en una pantalla táctil no hace nada. */}
      <nav aria-label="Secciones" className="fixed inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
        <div className="flex items-stretch gap-0.5 rounded-[26px] border border-white/[0.18] bg-white/[0.08] px-1.5 py-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.28)] backdrop-blur-[24px] backdrop-saturate-150">
          {navFijos.map(({ label, Icon, href }) => {
            const a = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={a ? "page" : undefined}
                className={`flex w-[58px] flex-col items-center gap-1 rounded-[16px] px-1 py-1.5 text-[0.6rem] transition-colors ${
                  a ? "bg-accent text-bg" : "text-subtle"
                }`}
              >
                <Icon className="h-[21px] w-[21px]" />
                {SHORT[href] ?? label}
              </Link>
            );
          })}
          <button
            onClick={() => setMoreOpen(true)}
            aria-label="Más secciones"
            className={`flex w-[58px] flex-col items-center gap-1 rounded-[16px] px-1 py-1.5 text-[0.6rem] transition-colors ${
              navResto.some((n) => isActive(pathname, n.href)) ? "bg-accent text-bg" : "text-subtle"
            }`}
          >
            <Dots className="h-[21px] w-[21px]" />
            Más
          </button>
        </div>
      </nav>

      {moreOpen && <MoreSheet items={navResto} pathname={pathname} onClose={() => setMoreOpen(false)} />}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        {subtitle && <p className="text-[0.95rem] text-subtle">{subtitle}</p>}
        <h1 className="mt-0.5 font-display text-[25px] font-bold tracking-[-0.03em] text-fg lg:text-[32px]">{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="panel max-w-sm p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.06] text-2xl">
          <Repeat className="h-7 w-7 text-accent" />
        </div>
        <h2 className="mt-4 font-display text-xl text-fg">{title}</h2>
        <p className="mx-auto mt-2 inline-block rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-[0.7rem] text-accent">Próximamente</p>
        <p className="mt-3 text-sm text-muted">Acá vas a poder ver y pausar tus suscripciones y débitos automáticos en un solo lugar.</p>
      </div>
    </div>
  );
}
