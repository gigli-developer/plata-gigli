// Autorización de Google Calendar + Tasks para el agente (una sola vez).
// Uso: node scripts/google-agenda-auth.mjs   (desde la carpeta finanzas-app)
//
// ⚠️ Esto NO toca el token de Gmail. Son dos OAuth distintos, de dos proyectos de
// Google Cloud distintos, y a propósito:
//
//   · Gmail    → proyecto 905035919284, secrets GOOGLE_*.       Scope: gmail.readonly
//   · Agenda   → proyecto 838299317197, secrets GCAL_*.         Scopes: calendar.events + tasks
//
// El de la agenda usa el proyecto que ya estaba PUBLICADO (el que se creó para
// Momentum), así que su refresh token no caduca a los 7 días. Si algún día unificás
// los dos, verificá primero que el 905035919284 esté en Producción — si no, al
// agregarle scopes al token de Gmail se te cae el importador de mails cada semana.
//
// Requisito en la consola de Google Cloud (proyecto 838299317197):
//   Credenciales → el cliente OAuth → URIs de redireccionamiento autorizados
//   → agregar  http://localhost:53682
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const envUrl = new URL("../.env.local", import.meta.url);
const envText = await readFile(envUrl, "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);

const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;

// Exactamente los dos scopes que ya están declarados en la pantalla de consentimiento
// de ese proyecto. Pedir uno de más obliga a reconfigurarla en la consola.
const SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
].join(" ");

if (!SB_URL || !SB_SERVICE) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(1);
}

/** Lee un secreto de app_secrets con la service role (saltea RLS). */
async function leerSecreto(key) {
  const r = await fetch(`${SB_URL}/rest/v1/app_secrets?key=eq.${key}&select=value`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  const filas = await r.json();
  return filas?.[0]?.value;
}

/** Inserta o actualiza un secreto. */
async function guardarSecreto(key, value) {
  const existe = await leerSecreto(key);
  const url = existe
    ? `${SB_URL}/rest/v1/app_secrets?key=eq.${key}`
    : `${SB_URL}/rest/v1/app_secrets`;
  const r = await fetch(url, {
    method: existe ? "PATCH" : "POST",
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(existe ? { value } : { key, value }),
  });
  return r.ok;
}

const CLIENT_ID = await leerSecreto("GCAL_CLIENT_ID");
const CLIENT_SECRET = await leerSecreto("GCAL_CLIENT_SECRET");
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Faltan GCAL_CLIENT_ID / GCAL_CLIENT_SECRET en app_secrets.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // fuerza que devuelva refresh_token aunque ya hayas autorizado antes
  });

console.log("\n=== Autorización de Google Calendar + Tasks ===");
console.log("\nSi da 'redirect_uri_mismatch', falta agregar " + REDIRECT);
console.log("en la consola de Google Cloud (proyecto 838299317197 → Credenciales → cliente OAuth).\n");
console.log("Abrí esta URL y autorizá:\n");
console.log(authUrl + "\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) { res.end("Error: " + err); return; }
  if (!code) { res.statusCode = 404; res.end("no code"); return; }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const data = await tokenRes.json();

  if (data.refresh_token) {
    const ok = await guardarSecreto("GCAL_REFRESH_TOKEN", data.refresh_token);
    const msg = ok
      ? "✅ Listo. GCAL_REFRESH_TOKEN guardado en app_secrets. El agente ya puede ver tu agenda."
      : "❌ Conseguí el token pero no pude escribirlo en app_secrets. Avisale a Claude.";
    res.end(msg + " Podés cerrar esta pestaña.");
    console.log("\n" + msg);
    console.log("   scopes otorgados: " + (data.scope ?? "(no informados)") + "\n");
  } else {
    res.end("Error al obtener token: " + JSON.stringify(data));
    console.log("\n❌ Error:", JSON.stringify(data), "\n");
  }
  setTimeout(() => { server.close(); process.exit(0); }, 800);
});

server.listen(PORT, () => console.log(`Esperando la autorización en ${REDIRECT} ...\n`));
