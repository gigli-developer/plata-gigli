// El día del Centro de Control para Coucou, la isla de escritorio (ver ../README.md).
// Proyecto Supabase: cqnlceqghqqrlacbjhzj (Centro de Control, NO Plata).
//
// ⚠️ NO se deploya con ningún repo: se sube con el MCP de Supabase
// (deploy_edge_function, name "coucou-foco", verify_jwt=false). Esta copia existe
// para versionar el código; si la editás, redeployala.
//
// Auth: secreto compartido. Exige el header `x-coucou-secret` igual al secreto de
// Vault `cdc_coucou_secret`. La comparación la hace la base (public.coucou_foco):
// el secreto nunca sale de Vault. Sin header o con uno distinto → 401.
// Es SOLO LECTURA: todo lo arma cdc.coucou_foco() (coucou_foco.sql).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// giglilangonelucas@gmail.com: la isla es de Lucas y de nadie más.
const USUARIO = "772701e0-5ad4-4a01-94ae-20b6760b099c";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secreto = req.headers.get("x-coucou-secret") ?? "";
  if (!secreto) return json({ error: "unauthorized" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.rpc("coucou_foco", { p_secreto: secreto, p_usuario: USUARIO });
  if (error) return json({ error: error.message }, 500);
  // null = el secreto no coincide (o no existe en Vault).
  if (data == null) return json({ error: "unauthorized" }, 401);
  return json(data);
});
