"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Coins, Sparkle } from "../icons";

// App mono-usuario: no hay registro (la base además lo bloquea con un trigger).
// La recuperación de contraseña manda el mail SIEMPRE a esta casilla — sin campo
// de destino, así nadie puede usar el botón para mandar mails a otro lado.
const OWNER_EMAIL = "giglilangonelucas@gmail.com";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return setError(error.message);
    router.push("/");
    router.refresh();
  };

  const forgot = async () => {
    setError(null);
    setInfo(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(OWNER_EMAIL, {
      redirectTo: `${window.location.origin}/auth/reset`,
    });
    setLoading(false);
    if (error) return setError(error.message);
    setInfo("Mail de recuperación enviado a tu casilla. Abrí el link del correo para elegir una contraseña nueva.");
  };

  return (
    <div className="grid min-h-screen place-items-center px-5">
      <div className="w-full max-w-sm">
        {/* brand */}
        <div className="flex flex-col items-center text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-accent via-emerald to-sky text-bg shadow-[0_12px_40px_-12px_rgba(200,255,77,0.6)]">
            <Coins className="h-7 w-7" />
          </div>
          <h1 className="mt-4 font-display text-3xl text-fg">Plata</h1>
          <p className="text-sm text-muted">Tus finanzas, claras y al día.</p>
        </div>

        <form onSubmit={submit} className="ai-glow mt-8 rounded-2xl p-6">
          <div className="mb-4 flex items-center gap-2 text-accent">
            <Sparkle className="h-[18px] w-[18px]" />
            <span className="text-xs font-medium uppercase tracking-[0.18em]">Iniciar sesión</span>
          </div>

          <label className="block text-xs text-muted">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vos@email.com"
            className="mt-1 w-full rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/50"
          />

          <label className="mt-4 block text-xs text-muted">Contraseña</label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="mt-1 w-full rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/50"
          />

          {error && <p className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">{error}</p>}
          {info && <p className="mt-3 rounded-lg border border-emerald/30 bg-emerald/10 px-3 py-2 text-xs text-emerald">{info}</p>}

          <button
            type="submit"
            disabled={loading}
            className="mt-5 w-full rounded-xl bg-accent py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60"
          >
            {loading ? "Procesando…" : "Entrar"}
          </button>

          <p className="mt-4 text-center text-xs text-muted">
            <button type="button" onClick={forgot} disabled={loading} className="text-accent hover:underline disabled:opacity-60">
              ¿Olvidaste tu contraseña?
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
