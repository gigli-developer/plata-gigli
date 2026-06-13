// Trae el cuerpo del email más reciente que matchee la query.
// Uso: node scripts/gmail-body.mjs 'subject:"Alerta de Compras Visa"'
import { readFile } from "node:fs/promises";

const envText = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);

const tok = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token",
  }),
}).then((r) => r.json());
const auth = { Authorization: `Bearer ${tok.access_token}` };

const q = process.argv[2] || 'subject:"Alerta de Compras Visa"';
const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(q)}`, { headers: auth }).then((r) => r.json());
const id = list.messages?.[0]?.id;
if (!id) { console.log("Sin resultados para:", q); process.exit(0); }

const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth }).then((r) => r.json());

const dec = (d) => Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
function findBody(part) {
  if (part.mimeType === "text/plain" && part.body?.data) return dec(part.body.data);
  if (part.parts) {
    for (const p of part.parts) { const r = findBody(p); if (r) return r; }
  }
  if (part.mimeType === "text/html" && part.body?.data) return dec(part.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return null;
}
const headers = Object.fromEntries((msg.payload?.headers ?? []).map((x) => [x.name, x.value]));
console.log("FROM:", headers.From);
console.log("SUBJECT:", headers.Subject);
console.log("DATE:", headers.Date);
console.log("\n----- BODY -----\n");
console.log((findBody(msg.payload) || "(no body)").trim().slice(0, 2500));
