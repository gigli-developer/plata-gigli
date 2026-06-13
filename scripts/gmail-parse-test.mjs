// Prueba el parser regex sobre los últimos N "Alerta de Compras Visa".
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
function body(part) {
  if (part.mimeType === "text/plain" && part.body?.data) return dec(part.body.data);
  if (part.parts) for (const p of part.parts) { const r = body(p); if (r) return r; }
  if (part.mimeType === "text/html" && part.body?.data) return dec(part.body.data).replace(/<[^>]+>/g, " ");
  return null;
}
function parse(text) {
  const g = (re) => (text.match(re)?.[1] || "").trim();
  return {
    comercio: g(/Comercio:\s*(.+?)\s+(?:Pa[ií]s|Ciudad|Tarjeta):/i),
    tarjeta: g(/Tarjeta:\s*(\d{3,4})/i),
    tipo: g(/Tipo de transacci[oó]n:\s*([^\n]+?)\s+Moneda:/i),
    moneda: g(/Moneda:\s*([A-Z]{3})/i),
    monto: g(/Monto:\s*([\d.,]+)/i),
  };
}

const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=12&q=${encodeURIComponent('subject:"Alerta de Compras Visa"')}`, { headers: auth }).then((r) => r.json());
for (const { id } of list.messages ?? []) {
  const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth }).then((r) => r.json());
  const dh = Object.fromEntries((m.payload?.headers ?? []).map((x) => [x.name, x.value]));
  const p = parse(body(m.payload) || "");
  console.log(`${(dh.Date||"").slice(0,17).padEnd(18)} | tarj ${p.tarjeta} | ${p.moneda} ${p.monto.padStart(11)} | ${p.tipo.padEnd(8)} | ${p.comercio}`);
}
