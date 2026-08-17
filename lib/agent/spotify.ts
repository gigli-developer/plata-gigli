import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Búsqueda en Spotify para el agente.
 *
 * Usa **client credentials** (credenciales de la app, sin usuario): alcanza para
 * buscar temas, discos, artistas y playlists públicas, y no necesita que el
 * usuario autorice nada ni tener Premium.
 *
 * Lo que se hace con el resultado es abrir la URI `spotify:` en la app de
 * escritorio, que la reproduce sola. Es más simple y más robusto que la API de
 * reproducción, que exige Premium Y un "dispositivo activo" — y si Spotify está
 * cerrado, no hay dispositivo.
 *
 * Secrets: `SPOTIFY_CLIENT_ID` y `SPOTIFY_CLIENT_SECRET` en `app_secrets`.
 * Se sacan de developer.spotify.com → Create app.
 */

export class SinCredenciales extends Error {
  constructor() {
    super("Faltan las credenciales de Spotify.");
  }
}

// El token de client credentials dura una hora. Se cachea en memoria del proceso.
let cache: { token: string; vence: number } | null = null;

async function token(sb: SupabaseClient): Promise<string> {
  if (cache && Date.now() < cache.vence) return cache.token;

  const { data, error } = await sb
    .from("app_secrets")
    .select("key,value")
    .in("key", ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"]);
  if (error) throw new Error(`No pude leer los secrets de Spotify: ${error.message}`);

  const s = Object.fromEntries((data ?? []).map((f) => [f.key, f.value])) as Record<string, string>;
  if (!s.SPOTIFY_CLIENT_ID || !s.SPOTIFY_CLIENT_SECRET) throw new SinCredenciales();

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${s.SPOTIFY_CLIENT_ID}:${s.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) {
    throw new Error(`Spotify rechazó las credenciales: ${JSON.stringify(t).slice(0, 160)}`);
  }

  cache = { token: t.access_token, vence: Date.now() + (t.expires_in - 60) * 1000 };
  return cache.token;
}

export type Hallazgo = {
  uri: string;
  titulo: string;
  de: string;      // artista, o dueño de la playlist
  tipo: "track" | "album" | "artist" | "playlist";
};

/**
 * Busca y devuelve lo mejor que encontró, o null.
 *
 * `tipo` acota la búsqueda: "reproducí Bohemian Rhapsody" es un track, pero
 * "poné Pink Floyd" es un artista y "poné el disco Kind of Blue" es un álbum.
 */
export async function buscar(
  sb: SupabaseClient,
  consulta: string,
  tipo: Hallazgo["tipo"] = "track",
  mercado = "AR",
): Promise<Hallazgo | null> {
  const q = new URLSearchParams({ q: consulta, type: tipo, limit: "5", market: mercado });
  const r = await fetch(`https://api.spotify.com/v1/search?${q}`, {
    headers: { authorization: `Bearer ${await token(sb)}` },
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Spotify (${r.status}): ${data?.error?.message ?? "falló la búsqueda"}`);
  }

  const items = data?.[`${tipo}s`]?.items ?? [];
  // Las playlists a veces vienen con huecos (null) en los resultados.
  const item = items.find((x: unknown) => x && typeof x === "object");
  if (!item) return null;

  const de =
    tipo === "artist" ? "" :
    tipo === "playlist" ? String(item.owner?.display_name ?? "") :
    (item.artists ?? []).map((a: { name: string }) => a.name).join(", ");

  return { uri: String(item.uri), titulo: String(item.name), de, tipo };
}

// ---------------------------------------------------------------------------
// Reproducción con el usuario (necesita SPOTIFY_REFRESH_TOKEN y Premium)
// ---------------------------------------------------------------------------

let cacheUsuario: { token: string; vence: number } | null = null;

/** null si el usuario todavía no autorizó: quien llama decide el plan B. */
async function tokenUsuario(sb: SupabaseClient): Promise<string | null> {
  if (cacheUsuario && Date.now() < cacheUsuario.vence) return cacheUsuario.token;

  const { data } = await sb
    .from("app_secrets")
    .select("key,value")
    .in("key", ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN"]);
  const s = Object.fromEntries((data ?? []).map((f) => [f.key, f.value])) as Record<string, string>;
  if (!s.SPOTIFY_REFRESH_TOKEN) return null;

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${s.SPOTIFY_CLIENT_ID}:${s.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: s.SPOTIFY_REFRESH_TOKEN,
    }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) return null;

  cacheUsuario = { token: t.access_token, vence: Date.now() + (t.expires_in - 60) * 1000 };
  return cacheUsuario.token;
}

export type Reproduccion =
  | { estado: "sonando"; donde: string }
  | { estado: "sin_dispositivo" }
  | { estado: "sin_autorizar" }
  | { estado: "error"; motivo: string };

/**
 * Pone algo a sonar de verdad.
 *
 * Es lo que resuelve el problema de las playlists: abrir su URI en el escritorio
 * NAVEGA hasta ella pero no le da play. Solo los temas sueltos arrancan solos.
 * Para un contexto (playlist, disco, artista) hace falta esta llamada.
 *
 * Requiere un dispositivo activo. Si Spotify está cerrado no hay ninguno, así que
 * se avisa y quien llama abre la app primero.
 */
export async function reproducir(sb: SupabaseClient, uri: string): Promise<Reproduccion> {
  const token = await tokenUsuario(sb);
  if (!token) return { estado: "sin_autorizar" };

  const cabeceras = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // ¿Hay dónde reproducir? Si hay dispositivos pero ninguno activo, se usa el primero.
  const rd = await fetch("https://api.spotify.com/v1/me/player/devices", { headers: cabeceras });
  const devs = (await rd.json())?.devices ?? [];
  if (!devs.length) return { estado: "sin_dispositivo" };
  const dev = devs.find((d: { is_active: boolean }) => d.is_active) ?? devs[0];

  // Un track va en `uris`; playlist/disco/artista van como `context_uri`.
  const cuerpo = uri.startsWith("spotify:track:")
    ? { uris: [uri] }
    : { context_uri: uri };

  const r = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(dev.id)}`,
    { method: "PUT", headers: cabeceras, body: JSON.stringify(cuerpo) },
  );
  if (r.status === 204 || r.ok) return { estado: "sonando", donde: String(dev.name ?? "tu equipo") };

  const err = await r.json().catch(() => ({}));
  const msg = err?.error?.message ?? `HTTP ${r.status}`;
  // 403 acá casi siempre significa cuenta sin Premium.
  return { estado: "error", motivo: r.status === 403 ? `${msg} (¿la cuenta es Premium?)` : msg };
}

/** Qué está sonando ahora. null si no hay nada o falta autorización. */
export async function sonando(sb: SupabaseClient): Promise<string | null> {
  const token = await tokenUsuario(sb);
  if (!token) return null;
  const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 204 || !r.ok) return null;
  const d = await r.json();
  const t = d?.item;
  if (!t) return null;
  const artistas = (t.artists ?? []).map((a: { name: string }) => a.name).join(", ");
  return artistas ? `${t.name} de ${artistas}` : String(t.name);
}
