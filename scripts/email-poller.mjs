// Poller de "Alerta de Compras Visa": lee, parsea, mapea tarjeta y categoriza.
// Modo dry-run: imprime lo detectado (no escribe en la base todavía).
// Uso: node scripts/email-poller.mjs [newer_than]   ej: node scripts/email-poller.mjs 5d
import { readFile } from "node:fs/promises";

const envText = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);
const tok = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
}).then((r) => r.json());
const auth = { Authorization: `Bearer ${tok.access_token}` };

const dec = (d) => Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const body = (p) => p.mimeType === "text/plain" && p.body?.data ? dec(p.body.data)
  : p.parts ? p.parts.map(body).find(Boolean)
  : p.mimeType === "text/html" && p.body?.data ? dec(p.body.data).replace(/<[^>]+>/g, " ") : null;

function parse(text) {
  const g = (re) => (text.match(re)?.[1] || "").trim();
  return {
    comercio: g(/Comercio:\s*(.+?)\s+(?:Pa[ií]s|Ciudad|Tarjeta):/i),
    tarjeta: g(/Tarjeta:\s*(\d{3,4})/i),
    moneda: g(/Moneda:\s*([A-Z]{3})/i),
    monto: Number(g(/Monto:\s*([\d.]+)/i)) || 0,
  };
}

// last4 -> tarjeta de la app
const CARD = { "2811": { id: 1, name: "Platinum Gal", method: "Tarjeta de Crédito" }, "6374": { id: 3, name: "Débito Galicia", method: "Tarjeta de Débito" } };

const CAT = [
  [/rappi|pedidosya/i, "Delivery"],
  [/burger|lechuzita|mariposa|havanna|caf[eé]|coffee|starbucks|mcdonald|restaur|parrilla|pizz|cremolatti|just/i, "Comida"],
  [/hoyts|cine|spotify|netflix|hbo|disney|paramount|cinemark|multicharts/i, "Ocio"],
  [/claude|openai|chatgpt|railway|google|apple|tactiq|tradingview|linkedin|github|vercel|perplexity|clideo|suscrip/i, "Servicios"],
  [/express varela|carrefour|coto|d[ií]a|jumbo|superm|farmacity|farmacia|almac[eé]n|kiosco|neastore|dxelectr/i, "Compras"],
  [/ausa|autopista|peaje|sube|uber|cabify|ypf|shell|axion|nafta|estaci[oó]n/i, "Transporte"],
];
const categorize = (m) => CAT.find(([re]) => re.test(m))?.[1] ?? "Otros";

const q = `subject:"Alerta de Compras Visa" newer_than:${process.argv[2] || "5d"}`;
const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=80&q=${encodeURIComponent(q)}`, { headers: auth }).then((r) => r.json());

const rows = [];
for (const { id } of list.messages ?? []) {
  const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth }).then((r) => r.json());
  const p = parse(body(m.payload) || "");
  if (!p.monto) continue;
  const card = CARD[p.tarjeta];
  rows.push({
    gmailId: id,
    fecha: new Date(Number(m.internalDate)).toISOString(),
    cardId: card?.id ?? null,
    cardName: card?.name ?? `(desconocida ${p.tarjeta})`,
    method: card?.method ?? null,
    category: categorize(p.comercio),
    amount: p.monto,
    currency: p.moneda,
    merchant: p.comercio,
  });
}

console.log(`\nConsumos detectados (${q}): ${rows.length}\n`);
for (const r of rows) {
  console.log(`${r.fecha.slice(0, 16)} | ${r.cardName.padEnd(16)} | ${r.category.padEnd(11)} | ${r.currency} ${String(r.amount).padStart(10)} | ${r.merchant}`);
}
console.log("\n--- JSON ---");
console.log(JSON.stringify(rows));
