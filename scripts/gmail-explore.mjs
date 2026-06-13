// Explora la casilla para identificar los emails del banco.
// Uso: node scripts/gmail-explore.mjs "query de gmail"
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
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
}).then((r) => r.json());

if (!tok.access_token) { console.error("No se pudo obtener access token:", tok); process.exit(1); }
const auth = { Authorization: `Bearer ${tok.access_token}` };

const q = process.argv[2] || "newer_than:60d (consumo OR compra OR Galicia OR tarjeta)";
const list = await fetch(
  `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${encodeURIComponent(q)}`,
  { headers: auth }
).then((r) => r.json());

console.log(`\nQuery: ${q}\nMensajes: ${list.resultSizeEstimate ?? 0}\n`);
for (const { id } of list.messages ?? []) {
  const m = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    { headers: auth }
  ).then((r) => r.json());
  const h = Object.fromEntries((m.payload?.headers ?? []).map((x) => [x.name, x.value]));
  console.log(`${(h.Date || "").slice(0, 25).padEnd(26)} | ${(h.From || "").slice(0, 38).padEnd(39)} | ${h.Subject || ""}`);
}
