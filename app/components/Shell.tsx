"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Grid, Swap, Card as CardIcon, Handshake, Repeat, Coins, Gear, Bell, Chart, Flow, Tag, Dots, Bug } from "../icons";
import MoreSheet from "./MoreSheet";
import { createClient } from "@/lib/supabase/client";
import { user } from "@/lib/mock";
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

// Los 4 que quedan fijos en el bottom nav de mobile; el resto va al botón "Más".
// Para cambiarlos, editá esta lista (tienen que existir en `nav`).
const MOBILE_FIJOS = ["/", "/hormiga", "/transacciones", "/tarjetas"];
// Etiqueta corta para que entren 5 slots en pantallas de 360px.
const SHORT: Record<string, string> = { "/": "Resumen", "/metricas": "Métricas", "/hormiga": "Hormiga", "/transacciones": "Movs", "/tarjetas": "Tarjetas", "/cashflow": "Flujo" };

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-lime via-emerald to-sky text-bg shadow-[0_8px_24px_-8px_rgba(200,255,77,0.6)]">
        <Coins className="h-5 w-5" />
      </div>
      {!compact ? (
        <div className="leading-none">
          <p className="font-display text-lg text-fg">Plata</p>
          <p className="text-[0.65rem] uppercase tracking-[0.22em] text-faint">finanzas</p>
        </div>
      ) : (
        <p className="font-display text-lg text-fg">Plata</p>
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
    <div className={`min-h-screen flex ${privacy ? "privacy" : ""}`}>
      {/* Sidebar desktop */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col gap-1 border-r border-line px-4 py-6 sticky top-0 h-screen">
        <Brand />
        <nav className="mt-8 flex flex-col gap-1">
          {nav.map(({ label, Icon, href }) => {
            const a = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                className={`group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[0.95rem] transition-colors ${
                  a ? "bg-surface-2 text-fg border border-line" : "text-muted hover:text-fg hover:bg-surface/60 border border-transparent"
                }`}
              >
                <Icon className={a ? "text-lime" : "opacity-80"} />
                {label}
                {a && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-lime" />}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-1">
          <button className="flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[0.95rem] text-muted hover:text-fg transition-colors">
            <Gear /> Configuración
          </button>
          <div className="mt-3 flex items-center gap-3 rounded-2xl border border-line bg-surface/60 p-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-lime to-emerald text-bg font-display font-bold">N</div>
            <div className="leading-tight">
              <p className="text-sm text-fg">{user.name}</p>
              <p className="text-xs text-faint">@{user.username}</p>
            </div>
            <button onClick={logout} title="Cerrar sesión" className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-coral">
              <Swap className="h-4 w-4 rotate-90" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="pb-nav flex-1 min-w-0 overflow-x-clip px-5 pt-6 lg:px-9 lg:pb-12">
        {/* Mobile top bar */}
        <div className="mb-6 flex items-center justify-between lg:hidden">
          <Brand compact />
          <div className="flex items-center gap-2">
            <PrivacyToggle />
            <button className="relative grid h-10 w-10 place-items-center rounded-full border border-line bg-surface/70 text-muted">
              <Bell className="h-[18px] w-[18px]" />
              <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-coral pulse-dot" />
            </button>
            <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-lime to-emerald text-bg font-display font-bold">N</span>
          </div>
        </div>
        <div key={pathname} className="page-enter">{children}</div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="bottom-safe lg:hidden fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-md items-stretch justify-around px-1 py-2">
          {navFijos.map(({ label, Icon, href }) => {
            const a = isActive(pathname, href);
            return (
              <Link key={href} href={href} className={`flex flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[0.62rem] ${a ? "text-lime" : "text-faint"}`}>
                <Icon className="h-[22px] w-[22px]" />
                {SHORT[href] ?? label}
              </Link>
            );
          })}
          <button
            onClick={() => setMoreOpen(true)}
            aria-label="Más secciones"
            className={`flex flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[0.62rem] ${
              navResto.some((n) => isActive(pathname, n.href)) ? "text-lime" : "text-faint"
            }`}
          >
            <Dots className="h-[22px] w-[22px]" />
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
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        <h1 className="font-display text-2xl text-fg sm:text-3xl">{title}</h1>
      </div>
      {children}
    </header>
  );
}

export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="panel max-w-sm p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-lime/20 to-violet/20 text-2xl">🚧</div>
        <h2 className="mt-4 font-display text-xl text-fg">{title}</h2>
        <p className="mt-2 text-sm text-muted">Esta sección la maquetamos en el próximo paso. Por ahora seguí explorando el Resumen y las Tarjetas.</p>
      </div>
    </div>
  );
}
