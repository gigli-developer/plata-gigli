// Reautorización de Gmail (una sola vez, ahora que la app está en Producción).
// Uso: node scripts/gmail-auth.mjs   (desde la carpeta finanzas-app)
// Abre una URL de consentimiento, autorizás en el navegador, y:
//   1) guarda/REEMPLAZA el refresh token en .env.local (sin duplicar)
//   2) lo escribe directo en app_secrets de Supabase (si está la service role key)
// Scope: solo lectura de Gmail.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";

const envUrl = new URL("../.env.local", import.meta.url);
const envText = await readFile(envUrl, "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);

const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_SERVICE = env.SUPABASE_SERVICE_ROLE_KEY; // opcional: si está, actualiza app_secrets solo
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en .env.local");
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
    prompt: "consent",
  });

await writeFile(new URL("./_authurl.txt", import.meta.url), authUrl, "utf8");
console.log("\n=== Reautorización de Gmail ===");
console.log("\nAbrí esta URL en tu navegador y autorizá (si sale 'Google no verificó esta app' → Configuración avanzada → Ir a la app):\n");
console.log(authUrl + "\n");

// Reemplaza (o agrega) GOOGLE_REFRESH_TOKEN en .env.local, sin duplicar.
async function saveEnv(token) {
  const lines = envText.split("\n").filter((l) => !l.trim().startsWith("GOOGLE_REFRESH_TOKEN="));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(`GOOGLE_REFRESH_TOKEN=${token}`, "");
  await writeFile(envUrl, lines.join("\n"), "utf8");
}

// Escribe el token directo en app_secrets (necesita la service role key).
async function saveSecret(token) {
  if (!SB_URL || !SB_SERVICE) return false;
  const res = await fetch(`${SB_URL}/rest/v1/app_secrets?key=eq.GOOGLE_REFRESH_TOKEN`, {
    method: "PATCH",
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ value: token }),
  });
  return res.ok;
}

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
    await saveEnv(data.refresh_token);
    const secretOk = await saveSecret(data.refresh_token);
    const msg = secretOk
      ? "✅ Listo. Token guardado en .env.local y en app_secrets. El poller ya puede andar."
      : "✅ Token guardado en .env.local. (No actualicé app_secrets: falta SUPABASE_SERVICE_ROLE_KEY en .env.local — avisale a Claude.)";
    res.end(msg + " Podés cerrar esta pestaña.");
    console.log("\n" + msg + "\n");
  } else {
    res.end("Error al obtener token: " + JSON.stringify(data));
    console.log("\n❌ Error:", JSON.stringify(data), "\n");
  }
  setTimeout(() => { server.close(); process.exit(0); }, 800);
});

server.listen(PORT, () => console.log(`Esperando la autorización en ${REDIRECT} ...\n`));
