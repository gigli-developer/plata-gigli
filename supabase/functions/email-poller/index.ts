// Importador de consumos de tarjeta desde las alertas de Gmail.
//
// ⚠️ NO se deploya con el repo: se sube con el MCP de Supabase (deploy_edge_function).
// Esta copia existe para versionar el código; si la editás, acordate de redeployarla.
//
// Auth: la dispara el cron (pg_cron, job 1) cada 15 min. Como verify_jwt=false, se
// protege con un secreto compartido: exige el header `x-poller-secret` igual a
// app_secrets.POLLER_SECRET. Sin ese header devuelve 401.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const USD_ARS = 1455; // misma cotización hardcodeada que usa la app para valuar

const dec = (d: string) => new TextDecoder().decode(Uint8Array.from(atob(d.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
function bodyText(part: any): string | null {
  if (part?.mimeType === "text/plain" && part.body?.data) return dec(part.body.data);
  if (part?.parts) { for (const p of part.parts) { const r = bodyText(p); if (r) return r; } }
  if (part?.mimeType === "text/html" && part.body?.data) return dec(part.body.data).replace(/<[^>]+>/g, " ");
  return null;
}
function parse(text: string) {
  const g = (re: RegExp) => (text.match(re)?.[1] || "").trim();
  return {
    comercio: g(/Comercio:\s*(.+?)\s+(?:Pa[ií]s|Ciudad|Tarjeta):/i),
    tarjeta: g(/Tarjeta:\s*(\d{3,4})/i),
    moneda: g(/Moneda:\s*([A-Z]{3})/i),
    monto: Number(g(/Monto:\s*([\d.]+)/i)) || 0,
  };
}
const CAT: [RegExp, string][] = [
  [/rappi|pedidosya/i, "Delivery"],
  [/burger|lechuzita|mariposa|havanna|caf[eé]|coffee|starbucks|mcdonald|restaur|parrilla|pizz|cremolatti|just/i, "Comida"],
  [/hoyts|cine|spotify|netflix|hbo|disney|paramount|cinemark|multicharts/i, "Ocio"],
  [/claude|openai|chatgpt|railway|google|apple|tactiq|tradingview|linkedin|github|vercel|perplexity|clideo|suscrip/i, "Servicios"],
  [/express varela|carrefour|coto|d[ií]a|jumbo|superm|farmacity|farmacia|almac[eé]n|kiosco|neastore|dxelectr/i, "Compras"],
  [/ausa|autopista|peaje|sube|uber|cabify|ypf|shell|axion|nafta|estaci[oó]n/i, "Transporte"],
];
const categorize = (m: string) => CAT.find(([re]) => re.test(m))?.[1] ?? "Otros";

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: secrets } = await sb.from("app_secrets").select("key,value");
  const S: Record<string, string> = Object.fromEntries((secrets ?? []).map((s: any) => [s.key, s.value]));
  // Auth: solo el cron (que manda el secreto compartido en el header) puede disparar el poller.
  if ((req.headers.get("x-poller-secret") ?? "") !== (S.POLLER_SECRET ?? "__no_secret__")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const { data: prof } = await sb.from("profiles").select("id").limit(1).single();
  const userId = prof?.id;
  const { data: cards } = await sb.from("cards").select("id,last4,network,closing_day,due_day");
  const { data: pms } = await sb.from("payment_methods").select("id,name");
  const { data: cats } = await sb.from("categories").select("id,name");
  const cardByLast4: Record<string, any> = Object.fromEntries((cards ?? []).map((c: any) => [c.last4, c]));
  const pmId = (n: string) => (pms ?? []).find((p: any) => p.name === n)?.id ?? null;
  const catId = (n: string) => (cats ?? []).find((c: any) => c.name === n)?.id ?? null;

  // Orden determinístico: prioridad desc y, a igual prioridad, la más vieja primero (igual que la UI).
  const { data: rules } = await sb.from("rules").select("text_op,text_value,hour_from,hour_to,days,amount_min,amount_max,category_id,rename_to,set_currency").eq("is_active", true).order("priority", { ascending: false }).order("id", { ascending: true });
  // Evalúa TODAS las reglas (en orden) contra la descripción ORIGINAL y junta acciones:
  // primera categoría, primer renombre y primera moneda que aparezcan (pueden venir de reglas distintas).
  const ruleActions = (desc: string, occMs: number, amount: number): { catId: number | null; rename: string | null; currency: string | null } => {
    const out = { catId: null as number | null, rename: null as string | null, currency: null as string | null };
    if (!rules || !rules.length) return out;
    let hour = -1, wd = -1;
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date(occMs));
      hour = Number(parts.find((p: any) => p.type === "hour")?.value);
      const wm: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
      wd = wm[parts.find((p: any) => p.type === "weekday")?.value ?? ""] ?? -1;
    } catch (_e) { /* noop */ }
    const d = (desc || "").toLowerCase();
    for (const r of rules as any[]) {
      if (out.catId != null && out.rename != null && out.currency != null) break;
      if (r.text_value) {
        const v = String(r.text_value).toLowerCase();
        const okText = r.text_op === "starts" ? d.startsWith(v) : r.text_op === "equals" ? d === v : d.includes(v);
        if (!okText) continue;
      }
      if (r.hour_from != null || r.hour_to != null) {
        if (hour < 0 || Number.isNaN(hour)) continue; // no se pudo calcular la hora: no matchear condiciones horarias
        const f = r.hour_from ?? 0, t = r.hour_to ?? 23;
        // Rango normal (11 a 15) o nocturno que cruza medianoche (22 a 2).
        const inRange = f <= t ? (hour >= f && hour <= t) : (hour >= f || hour <= t);
        if (!inRange) continue;
      }
      if (r.days && r.days.length && !r.days.includes(wd)) continue;
      if (r.amount_min != null && amount < Number(r.amount_min)) continue;
      if (r.amount_max != null && amount > Number(r.amount_max)) continue;
      if (out.catId == null && r.category_id != null) out.catId = r.category_id;
      if (out.rename == null && r.rename_to) out.rename = r.rename_to;
      if (out.currency == null && r.set_currency) out.currency = r.set_currency;
    }
    return out;
  };

  const tok = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: S.GOOGLE_CLIENT_ID, client_secret: S.GOOGLE_CLIENT_SECRET, refresh_token: S.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
  })).json();
  if (!tok.access_token) return new Response(JSON.stringify({ error: "token", detail: tok }), { status: 500 });
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const q = 'subject:"Alerta de Compras Visa" newer_than:4d';
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}`, { headers: auth })).json();
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const { data: done } = await sb.from("email_process_logs").select("email_id").in("email_id", ids.length ? ids : ["_"]);
  const seen = new Set((done ?? []).map((d: any) => d.email_id));

  let inserted = 0, skipped = 0, nocard = 0, dupes = 0;
  const today = new Date().toISOString().slice(0, 10);

  // Busca el resumen abierto de la tarjeta; si no existe, CREA el próximo
  // (cierre = closing_day del mes actual o siguiente, clampeado al largo del mes;
  //  vence al mes siguiente si due_day < closing_day).
  const openStatementId = async (card: any): Promise<number | null> => {
    const { data: st } = await sb.from("card_statements").select("id").eq("card_id", card.id).gte("closing_date", today).order("closing_date", { ascending: true }).limit(1);
    if (st?.[0]?.id) return st[0].id;
    if (!card.closing_day) return null;
    const now = new Date();
    const mkUTC = (y: number, m: number, day: number) => { const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(day, last))); };
    const mOff = now.getUTCDate() <= card.closing_day ? 0 : 1;
    const closing = mkUTC(now.getUTCFullYear(), now.getUTCMonth() + mOff, card.closing_day);
    const dueDay = card.due_day ?? card.closing_day;
    const due = mkUTC(closing.getUTCFullYear(), closing.getUTCMonth() + (dueDay < card.closing_day ? 1 : 0), dueDay);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const period = iso(closing).slice(0, 7);
    const { data: created } = await sb.from("card_statements")
      .upsert({ user_id: userId, card_id: card.id, period_label: period, closing_date: iso(closing), due_date: iso(due) }, { onConflict: "card_id,period_label", ignoreDuplicates: true })
      .select("id").maybeSingle();
    if (created?.id) return created.id;
    const { data: existing } = await sb.from("card_statements").select("id").eq("card_id", card.id).eq("period_label", period).maybeSingle();
    return existing?.id ?? null;
  };

  for (const id of ids) {
    if (seen.has(id)) { skipped++; continue; }
    const m = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth })).json();
    const p = parse(bodyText(m.payload) || "");
    if (!p.monto) { skipped++; continue; }
    const card = cardByLast4[p.tarjeta];
    if (!card) {
      await sb.from("email_process_logs").insert({ user_id: userId, email_id: id, merchant: p.comercio, amount: p.monto, currency: p.moneda, card_last4: p.tarjeta, status: "skip_no_card" });
      nocard++; continue;
    }
    const occMs = Number(m.internalDate);
    // Acciones de reglas ANTES del dup-check: si una regla convierte el monto/moneda,
    // el duplicado hay que buscarlo con el valor final (los dos mails convierten igual).
    const acts = ruleActions(p.comercio, occMs, p.monto);
    // "Forzar moneda" CONVIERTE el monto: la alerta del banco reporta el equivalente en pesos
    // (ej: TACTIQ $6.000 → USD 4,11 en el resumen), nunca el precio original en dólares.
    let monto = p.monto;
    let moneda = p.moneda;
    if (acts.currency && acts.currency !== p.moneda) {
      monto = acts.currency === "USD" ? Math.round((p.monto / USD_ARS) * 100) / 100 : Math.round(p.monto * USD_ARS * 100) / 100;
      moneda = acts.currency;
    }
    const descripcion = acts.rename ?? p.comercio;
    const lo = new Date(occMs - 120000).toISOString();
    const hi = new Date(occMs + 120000).toISOString();
    // Dup-check por tarjeta+monto final+ventana de ±2min, sin filtrar moneda.
    const { data: dup } = await sb.from("transactions").select("id").eq("card_id", card.id).eq("amount", monto).gte("occurred_at", lo).lte("occurred_at", hi).limit(1);
    if (dup && dup.length) {
      await sb.from("email_process_logs").insert({ user_id: userId, email_id: id, merchant: p.comercio, amount: p.monto, currency: p.moneda, card_last4: p.tarjeta, status: "skip_duplicate" });
      dupes++; continue;
    }
    const isDebit = (card.network || "").toLowerCase().includes("déb") || (card.network || "").toLowerCase().includes("deb");
    const method = isDebit ? "Tarjeta de Débito" : "Tarjeta de Crédito";
    const statementId: number | null = isDebit ? null : await openStatementId(card);
    const occurred = new Date(occMs).toISOString();
    const { data: tx, error: txErr } = await sb.from("transactions").insert({
      user_id: userId, type: "egreso", nature: "variable", category_id: acts.catId ?? catId(categorize(p.comercio)), payment_method_id: pmId(method),
      amount: monto, currency: moneda, description: descripcion, is_paid: isDebit, card_id: card.id, statement_id: statementId, occurred_at: occurred, source: "email",
    }).select("id").single();
    if (txErr) { await sb.from("email_process_logs").insert({ user_id: userId, email_id: id, merchant: p.comercio, amount: p.monto, currency: p.moneda, card_last4: p.tarjeta, status: "error", error_message: txErr.message }); continue; }
    await sb.from("email_process_logs").insert({ user_id: userId, email_id: id, merchant: p.comercio, amount: p.monto, currency: p.moneda, card_last4: p.tarjeta, transaction_id: tx.id, status: "ok" });
    inserted++;
  }
  return new Response(JSON.stringify({ found: ids.length, inserted, skipped, dupes, nocard }), { headers: { "Content-Type": "application/json" } });
});
