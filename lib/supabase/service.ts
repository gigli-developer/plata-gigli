import { createClient as createSbClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente con SERVICE ROLE: saltea RLS y no usa cookies de sesión.
 *
 * Solo para rutas de servidor que YA validaron quién llama (el webhook de Telegram
 * chequea el secreto del header + el chat_id antes de tocar esto). Nunca importar
 * desde un Client Component ni exponerlo en una ruta sin autenticar: con esta key
 * cualquiera lee toda la base.
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  return createSbClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Secrets desde la tabla `app_secrets` (mismo patrón que las Edge Functions).
 * Se mantienen ahí y no en variables de Railway para tener una sola fuente de verdad:
 * la única env var que hace falta es la SERVICE_ROLE_KEY que abre esta puerta.
 */
export async function loadSecrets(sb: SupabaseClient): Promise<Record<string, string>> {
  const { data, error } = await sb.from("app_secrets").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((s: { key: string; value: string }) => [s.key, s.value]));
}
