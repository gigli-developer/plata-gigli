import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async () => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: secrets } = await sb.from("app_secrets").select("key,value");
  const S: Record<string, string> = Object.fromEntries((secrets ?? []).map((s: any) => [s.key, s.value]));
  const { data: prof } = await sb.from("profiles").select("id").limit(1).single();
  const userId = prof?.id;
  const { data: cards } = await sb.from("cards").select("id,last4,network");
  const { data: pms } = await sb.from("payment_methods").select("id,name");
  const { data: cats } = await sb.from("categories").select("id,name");
  const cardByLast4: Record<string, any> = Object.fromEntries((cards ?? []).map((c: any) => [c.last4, c]));
  const pmId = (n: string) => (pms ?? []).find((p: any) => p.name === n)?.id ?? null;
  const catId = (n: string) => (cats ?? []).find((c: any) => c.name === n)?.id ?? null;

  // Reglas de auto-categorización (gana la de mayor prioridad que matchee).
  const { data: rules } = await sb.from("rules").select("text_op,text_value,hour_from,hour_to,days,category_id").eq("is_active", true).order("priority", { ascending: false });
  const ruleCatId = (desc: string, occMs: number): number | null => {
    if (!rules || !rules.length) return null;
    let hour = -1, wd = -1;
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date(occMs));
      hour = Number(parts.find((p: any) => p.type === "hour")?.value);
      const wm: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
      wd = wm[parts.find((p: any) => p.type === "weekday")?.value ?? ""] ?? -1;
    } catch (_e) { /* noop */ }
    const d = (desc || "").toLowerCase();
    for (const r of rules as any[]) {
      if (r.text_value) {
        const v = String(r.text_value).toLowerCase();
        const okText = r.text_op === "starts" ? d.startsWith(v) : r.text_op === "equals" ? d === v : d.includes(v);
        if (!okText) continue;
      }
      if (r.hour_from != null && hour < r.hour_from) continue;
      if (r.hour_to != null && hour > r.hour_to) continue;
      if (r.days && r.days.length && !r.days.includes(wd)) continue;
      return r.category_id;
    }
    return null;
  };

  const tok = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: S.GOOGLE_CLIENT_ID, client_secret: S.GOOGLE_CLIENT_SECRET, refresh_token: S.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
  })).json();
  if (!tok.access_token) return new Response(JSON.stringify({ error: "token", detail: tok }), { status: 500 });
  const auth = { Authorization: `Bearer ${tok.access_token}` };

  const q = 'subject:"Alerta de Compras Visa" newer_than:2d';
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`, { headers: auth })).json();
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const { data: done } = await sb.from("email_process_logs").select("email_id").in("email_id", ids.length ? ids : ["_"]);
  const seen = new Set((done ?? []).map((d: any) => d.email_id));

  let inserted = 0, skipped = 0, nocard = 0, dupes = 0;
  const today = new Date().toISOString().slice(0, 10);

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
    const lo = new Date(occMs - 120000).toISOString();
    const hi = new Date(occMs + 120000).toISOString();
    const { data: dup } = await sb.from("transactions").select("id").eq("card_id", card.id).eq("amount", p.monto).eq("currency", p.moneda).gte("occurred_at", lo).lte("occurred_at", hi).limit(1);
    if (dup && dup.length) {
      await sb.from("email_process_logs").insert({ user_id: userId, email_id: id, merchant: p.comercio, amount: p.monto, currency: p.moneda, card_last4: p.tarjeta, status: "skip_duplicate" });
      dupes++; continue;
    }
    const isDebit = (card.network || "").toLowerCase().includes("déb") || (card.network || "").toLowerCase().includes("deb");
    const method = isDebit ? "Tarjeta de Débito" : "Tarjeta de Crédito";
    let statementId: number | null = null;
    if (!isDebit) {
      const { data: st } = await sb.from("card_statements").select("id").eq("card_id", card.id).gte("closing_date", today).order("closing_date", { ascending: true }).limit(1);
      statementId = st?.[0]?.id ?? null;
    }
    const occurred = new Date(occMs).toISOString();
    const { data: tx, error: txErr } = await sb.from("transactions").insert({
      user_id: userId, type: "egreso", nature: "variable", category_id: ruleCatId(p.comercio, occMs) ?? catId(categorize(p.comercio)), payment_method_id: pmId(method),
      amount: p.monto, currency: p.moneda, description: p.comercio, is_paid: isDebit, card_id: card.id, statement_id: statementId, occurred_at: occurred, source: "email",
    }).select("id").single();
    if (txErr) { await sb.from("email_process_logs").insert({ user_id: userId, email_id: id, merchant: p.comercio, amount: p.monto, currency: p.moneda, card_last4: p.tarjeta, status: "error", error_message: txErr.message }); continue; }
    await sb.from("email_process_logs").insert({ user_id: userId, email_id: id, merchant: p.comercio, amount: p.monto, currency: p.moneda, card_last4: p.tarjeta, transaction_id: tx.id, status: "ok" });
    inserted++;
  }
  return new Response(JSON.stringify({ found: ids.length, inserted, skipped, dupes, nocard }), { headers: { "Content-Type": "application/json" } });
});
