// Estado de Plata para Coucou, la isla de escritorio (ver integraciones/coucou/).
//
// ⚠️ NO se deploya con el repo: se sube con el MCP de Supabase (deploy_edge_function,
// verify_jwt=false). Esta copia existe para versionar el código; si la editás, redeployala.
//
// Auth: igual que el email-poller, un secreto compartido. Exige el header
// `x-coucou-secret` igual a app_secrets.COUCOU_SECRET. Sin eso devuelve 401.
// Es solo lectura: no escribe nada ni devuelve saldos, solo salud + último consumo.
//
// Lo pesado lo resuelve la RPC `coucou_health()` (supabase/sql/coucou_health.sql).
// Acá se suma lo único que la base no sabe: si el refresh token de Gmail sigue vivo.
// Es EL problema recurrente (caduca cada 7 días con la app de Google en "Testing") y
// el cron no lo ve: pg_net corta a los 5 s y el fallo del poller nunca queda registrado.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MIN = 60_000;

async function gmailToken(S: Record<string, string>): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: S.GOOGLE_CLIENT_ID,
        client_secret: S.GOOGLE_CLIENT_SECRET,
        refresh_token: S.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    const tok = await res.json();
    if (tok.access_token) return { ok: true, error: null };
    return { ok: false, error: String(tok.error ?? `HTTP ${res.status}`) };
  } catch (e) {
    // Google caído no es "token vencido": no alarmar por eso.
    return { ok: true, error: `sin respuesta de Google: ${(e as Error).message}` };
  }
}

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: secrets } = await sb.from("app_secrets").select("key,value");
  const S: Record<string, string> = Object.fromEntries((secrets ?? []).map((s: any) => [s.key, s.value]));
  if ((req.headers.get("x-coucou-secret") ?? "") !== (S.COUCOU_SECRET ?? "__no_secret__")) {
    return json({ error: "unauthorized" }, 401);
  }

  const [gmail, rpc] = await Promise.all([gmailToken(S), sb.rpc("coucou_health")]);
  if (rpc.error) return json({ error: rpc.error.message }, 500);
  const h = rpc.data as {
    jobs: { name: string; status: string | null; at: string | null }[];
    importer: { lastProcessedAt: string | null; errors24h: number; lastError: string | null };
    lastTx: { id: number; description: string; amount: number; currency: string; at: string } | null;
    fx: { day: string | null; blue: number | null; cripto: number | null; updatedAt: string | null };
  };

  const now = Date.now();
  const job = (prefix: string) => h.jobs.find((j) => j.name.startsWith(prefix));
  const problems: string[] = [];

  if (!gmail.ok) {
    problems.push(
      gmail.error === "invalid_grant"
        ? "Token de Gmail vencido: correr scripts/gmail-auth.mjs"
        : `Gmail rechaza el token (${gmail.error})`,
    );
  }
  const poller = job("email-poller");
  if (!poller?.at || now - Date.parse(poller.at) > 40 * MIN) {
    problems.push("El cron del importador no corre hace más de 40 min");
  } else if (poller.status === "failed") {
    problems.push("Falló el último cron del importador");
  }
  const fxJob = job("fx-sync");
  if (fxJob?.status === "failed") problems.push("Falló el último fx-sync");
  // fx_rates solo trae días hábiles: 4 días cubre un fin de semana largo.
  if (!h.fx.day || now - Date.parse(`${h.fx.day}T12:00:00-03:00`) > 4 * 24 * 60 * MIN) {
    problems.push(`Cotizaciones sin actualizar desde ${h.fx.day ?? "nunca"}`);
  }
  if (h.importer.errors24h > 0) {
    problems.push(`${h.importer.errors24h} error(es) del importador en 24 h: ${h.importer.lastError ?? "?"}`);
  }

  return json({
    ok: problems.length === 0,
    problems,
    checkedAt: new Date(now).toISOString(),
    gmail,
    importer: { ...h.importer, lastRunAt: poller?.at ?? null, lastRunStatus: poller?.status ?? null },
    lastTx: h.lastTx,
    fx: h.fx,
  });
});
