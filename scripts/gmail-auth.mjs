// Autorización de una sola vez para obtener el GOOGLE_REFRESH_TOKEN de Gmail.
// Uso: node scripts/gmail-auth.mjs  (desde la carpeta finanzas-app)
// Abre una URL de consentimiento, autorizás en el navegador, y guarda el
// refresh token en .env.local. Scope: solo lectura de Gmail.
import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";

const envText = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);

const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
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

console.log("\n=== Autorización de Gmail ===");
console.log("\nAbrí esta URL en tu navegador y autorizá:\n");
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
    await appendFile(new URL("../.env.local", import.meta.url), `GOOGLE_REFRESH_TOKEN=${data.refresh_token}\n`);
    res.end("✅ Listo. Refresh token guardado en .env.local. Podés cerrar esta pestaña.");
    console.log("\n✅ Refresh token guardado en .env.local\n");
  } else {
    res.end("Error al obtener token: " + JSON.stringify(data));
    console.log("\n❌ Error:", JSON.stringify(data), "\n");
  }
  setTimeout(() => { server.close(); process.exit(0); }, 800);
});

server.listen(PORT, () => console.log(`Esperando la autorización en ${REDIRECT} ...\n`));
