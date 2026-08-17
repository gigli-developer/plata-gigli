// Autorización de Spotify para el agente (una sola vez).
// Uso: node scripts/spotify-auth.mjs   (desde la carpeta finanzas-app)
//
// Para qué: buscar alcanza con las credenciales de la app, pero REPRODUCIR una
// playlist o un disco necesita tu usuario. Abrir la URI en el escritorio solo
// navega hasta ella; los temas sueltos arrancan, los contextos no.
//
// Requiere Premium (la API de reproducción de Spotify es solo para Premium).
//
// En developer.spotify.com, en la app, tiene que estar este Redirect URI:
//   http://127.0.0.1:53682
// (Spotify ya no acepta la palabra "localhost", solo la IP.)
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
const REDIRECT = `http://127.0.0.1:${PORT}`;

// Lo mínimo para poner música y saber qué suena. Sin acceso a datos personales
// más allá de la biblioteca guardada.
const SCOPE = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
  "playlist-read-private",
].join(" ");

if (!SB_URL || !SB_SERVICE) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local");
  process.exit(1);
}

async function leerSecreto(key) {
  const r = await fetch(`${SB_URL}/rest/v1/app_secrets?key=eq.${key}&select=value`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  return (await r.json())?.[0]?.value;
}

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

const CLIENT_ID = await leerSecreto("SPOTIFY_CLIENT_ID");
const CLIENT_SECRET = await leerSecreto("SPOTIFY_CLIENT_SECRET");
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Faltan SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET en app_secrets.");
  process.exit(1);
}

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT,
    scope: SCOPE,
  });

console.log("\n=== Autorización de Spotify ===");
console.log(`\nSi da INVALID_CLIENT, falta agregar ${REDIRECT}`);
console.log("en developer.spotify.com → tu app → Settings → Redirect URIs.\n");
console.log("Abrí esta URL y autorizá:\n");
console.log(authUrl + "\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) { res.end("Error: " + err); return; }
  if (!code) { res.statusCode = 404; res.end("no code"); return; }

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }),
  });
  const data = await tokenRes.json();

  if (data.refresh_token) {
    const ok = await guardarSecreto("SPOTIFY_REFRESH_TOKEN", data.refresh_token);
    const msg = ok
      ? "✅ Listo. Ya puede reproducir playlists y discos, no solo temas sueltos."
      : "❌ Conseguí el token pero no pude guardarlo. Avisale a Claude.";
    res.end(msg + " Podés cerrar esta pestaña.");
    console.log("\n" + msg + "\n");
  } else {
    res.end("Error: " + JSON.stringify(data));
    console.log("\n❌", JSON.stringify(data), "\n");
  }
  setTimeout(() => { server.close(); process.exit(0); }, 800);
});

server.listen(PORT, "127.0.0.1", () => console.log(`Esperando la autorización en ${REDIRECT} ...\n`));
