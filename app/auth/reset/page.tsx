"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Coins, Sparkle } from "../../icons";

// Aterrizaje del link de recuperación de contraseña. El link del mail trae un
// código de un solo uso: lo canjeamos por sesión y dejamos elegir la clave nueva.
export default function ResetPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const params = new URLSearchParams(window.location.search);
      // 1) Flujo PKCE (?code=...): requiere el MISMO navegador que pidió el mail.
      const code = params.get("code");
      if (code) await supabase.auth.exchangeCodeForSession(code).catch(() => {});
      // 2) Flujo token_hash (?token_hash=...&type=recovery): funciona desde cualquier dispositivo.
      const tokenHash = params.get("token_hash");
      if (tokenHash) await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash }).catch(() => {});
      // 3) Tokens en el fragmento (#access_token=...): formato implícito viejo.
      const h = new URLSearchParams(window.location.hash.slice(1));
      const at = h.get("access_token"), rt = h.get("refresh_token");
      if (at && rt) await supabase.auth.setSession({ access_token: at, refresh_token: rt }).catch(() => {});
      // Con sesión (por el link o porque ya estabas logueado) → dejar elegir contraseña nueva.
      const { data: { session } } = await supabase.auth.getSession();
      setReady(!!session);
      setChecking(false);
    })();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (p1.length < 6) return setErr("La contraseña tiene que tener al menos 6 caracteres.");
    if (p1 !== p2) return setErr("Las contraseñas no coinciden.");
    setSaving(true);
    const { error } = await createClient().auth.updateUser({ password: p1 });
    setSaving(false);
    if (error) return setErr(error.message);
    setOk(true);
    setTimeout(() => { router.push("/"); router.refresh(); }, 1200);
  };

  return (
    <div className="grid min-h-screen place-items-center px-5">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-accent via-emerald to-sky text-bg shadow-[0_12px_40px_-12px_rgba(200,255,77,0.6)]">
            <Coins className="h-7 w-7" />
          </div>
          <h1 className="mt-4 font-display text-3xl text-fg">Plata</h1>
          <p className="text-sm text-muted">Elegí tu nueva contraseña.</p>
        </div>

        <div className="ai-glow mt-8 rounded-2xl p-6">
          <div className="mb-4 flex items-center gap-2 text-violet">
            <Sparkle className="h-[18px] w-[18px]" />
            <span className="text-xs font-medium uppercase tracking-[0.18em]">Nueva contraseña</span>
          </div>

          {checking ? (
            <p className="py-4 text-center text-sm text-muted">Verificando el link…</p>
          ) : !ready ? (
            <div className="text-sm text-muted">
              <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">
                El link no es válido o ya venció. Los links son de un solo uso y hay que abrirlos en el <b>mismo navegador</b> desde el que pediste el mail. Pedí uno nuevo desde el login — o, si ya tenés sesión abierta, entrá directo a esta página y elegí la contraseña.
              </p>
              <button onClick={() => router.push("/login")} className="mt-4 w-full rounded-xl border border-line bg-surface-2 py-2.5 text-sm text-fg transition-colors hover:border-accent/40">
                Volver al login
              </button>
            </div>
          ) : (
            <form onSubmit={save}>
              <label className="block text-xs text-muted">Contraseña nueva</label>
              <input
                type="password"
                required
                minLength={6}
                value={p1}
                onChange={(e) => setP1(e.target.value)}
                placeholder="••••••••"
                className="mt-1 w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-violet/50"
              />
              <label className="mt-4 block text-xs text-muted">Repetila</label>
              <input
                type="password"
                required
                minLength={6}
                value={p2}
                onChange={(e) => setP2(e.target.value)}
                placeholder="••••••••"
                className="mt-1 w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-violet/50"
              />

              {err && <p className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">{err}</p>}
              {ok && <p className="mt-3 rounded-lg border border-emerald/30 bg-emerald/10 px-3 py-2 text-xs text-emerald">✓ Contraseña actualizada. Entrando…</p>}

              <button
                type="submit"
                disabled={saving || ok}
                className="mt-5 w-full rounded-xl bg-accent py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60"
              >
                {saving ? "Guardando…" : "Guardar y entrar"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
