import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente de Google Calendar para el agente.
 *
 * Credenciales: `GCAL_CLIENT_ID` / `GCAL_CLIENT_SECRET` / `GCAL_REFRESH_TOKEN` en
 * `app_secrets`. Son de un proyecto de Google Cloud DISTINTO al de Gmail, a
 * propósito: el de la agenda (838299317197) está publicado y su refresh token no
 * caduca; el de Gmail (905035919284) está en Testing y muere cada 7 días. No
 * unificarlos sin verificar antes el estado del segundo — ver `CREDENCIALES.md`.
 *
 * Scope disponible: `calendar.events`. Alcanza para leer, crear, editar y borrar
 * eventos, pero NO para listar los calendarios de la cuenta: todo va contra `primary`.
 */

const ZONA = "America/Argentina/Buenos_Aires";
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export class SinAutorizar extends Error {
  constructor() {
    super("Todavía no autorizaste el acceso a Google Calendar.");
  }
}

// El access token dura una hora. Se cachea en memoria del proceso para no pedir
// uno nuevo en cada herramienta; se pierde en cada deploy, que es lo esperado.
let cache: { token: string; vence: number } | null = null;

async function tokenDeAcceso(sb: SupabaseClient): Promise<string> {
  if (cache && Date.now() < cache.vence) return cache.token;

  const { data, error } = await sb
    .from("app_secrets")
    .select("key,value")
    .in("key", ["GCAL_CLIENT_ID", "GCAL_CLIENT_SECRET", "GCAL_REFRESH_TOKEN"]);
  if (error) throw new Error(`No pude leer los secrets de Google: ${error.message}`);

  const s = Object.fromEntries((data ?? []).map((f) => [f.key, f.value])) as Record<string, string>;
  if (!s.GCAL_REFRESH_TOKEN) throw new SinAutorizar();

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.GCAL_CLIENT_ID,
      client_secret: s.GCAL_CLIENT_SECRET,
      refresh_token: s.GCAL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) {
    // `invalid_grant` acá significa que el refresh token se revocó o caducó.
    throw new Error(`Google rechazó el refresh token: ${JSON.stringify(t).slice(0, 200)}`);
  }

  // 60s de colchón para no usar un token que vence a mitad de la request.
  cache = { token: t.access_token, vence: Date.now() + (t.expires_in - 60) * 1000 };
  return cache.token;
}

async function api(sb: SupabaseClient, ruta: string, init: RequestInit = {}) {
  const token = await tokenDeAcceso(sb);
  const r = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (r.status === 204) return null;
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message ?? JSON.stringify(data).slice(0, 200);
    throw new Error(`Google Calendar (${r.status}): ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------------------

export type Evento = {
  id: string;
  titulo: string;
  inicio: string;      // ISO con offset, o YYYY-MM-DD si es de día completo
  fin: string;
  todo_el_dia: boolean;
  lugar?: string;
  nota?: string;
};

/** La parte de la respuesta de Google que nos interesa. Trae bastante más. */
type EventoGoogle = {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

/** Normaliza la respuesta de Google a algo chico y estable. */
function aEvento(e: EventoGoogle): Evento {
  const todoElDia = Boolean(e.start?.date);
  return {
    id: String(e.id),
    titulo: String(e.summary ?? "(sin título)"),
    inicio: String(e.start?.dateTime ?? e.start?.date ?? ""),
    fin: String(e.end?.dateTime ?? e.end?.date ?? ""),
    todo_el_dia: todoElDia,
    lugar: e.location ? String(e.location) : undefined,
    nota: e.description ? String(e.description).slice(0, 300) : undefined,
  };
}

export async function listarEventos(
  sb: SupabaseClient,
  desdeIso: string,
  hastaIso: string,
  busqueda?: string,
): Promise<Evento[]> {
  const q = new URLSearchParams({
    timeMin: desdeIso,
    timeMax: hastaIso,
    singleEvents: "true",     // expande las repeticiones en instancias concretas
    orderBy: "startTime",
    maxResults: "100",
    timeZone: ZONA,
  });
  // ⚠️ El filtro NO se delega a Google.
  //
  // El parámetro `q` de la API busca por PALABRAS COMPLETAS y con su propia idea
  // de relevancia: buscar "entrega" encontraba "Entrega actividades M1", pero
  // "actividad" o "la entrega del 25" no encontraban nada, y el asistente
  // contestaba que no existía un evento que estaba ahí. Como el rango ya está
  // acotado —nunca más de unas decenas de eventos— se traen todos y se filtra acá,
  // por subcadena y sin tildes, que es lo que uno espera al decirlo en voz alta.
  const data = await api(sb, `?${q}`);
  const eventos: Evento[] = (data?.items ?? []).map(aEvento);
  if (!busqueda) return eventos;

  const plano = (s: string) =>
    (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const agujas = plano(busqueda).split(/\s+/).filter((p) => p.length > 2);
  if (!agujas.length) return eventos;

  return eventos.filter((e) => {
    const pajar = plano(`${e.titulo} ${e.lugar ?? ""} ${e.nota ?? ""}`);
    // Alcanza con que aparezca UNA de las palabras: al dictar se agregan artículos
    // y palabras de más ("la entrega de actividades"), y exigirlas todas no
    // encuentra nada.
    return agujas.some((a) => pajar.includes(a));
  });
}

export async function obtenerEvento(sb: SupabaseClient, id: string): Promise<Evento> {
  return aEvento(await api(sb, `/${encodeURIComponent(id)}`));
}

export type CamposEvento = {
  titulo?: string;
  inicio?: string;
  fin?: string;
  todo_el_dia?: boolean;
  lugar?: string;
  nota?: string;
};

/** Arma el body de Google a partir de nuestros campos. */
function aBody(c: CamposEvento, base?: Evento): Record<string, unknown> {
  const todoElDia = c.todo_el_dia ?? base?.todo_el_dia ?? false;
  const body: Record<string, unknown> = {};

  if (c.titulo !== undefined) body.summary = c.titulo;
  if (c.lugar !== undefined) body.location = c.lugar;
  if (c.nota !== undefined) body.description = c.nota;

  const inicio = c.inicio ?? base?.inicio;
  const fin = c.fin ?? base?.fin;
  if (inicio) {
    body.start = todoElDia
      ? { date: inicio.slice(0, 10) }
      : { dateTime: inicio, timeZone: ZONA };
  }
  if (fin) {
    body.end = todoElDia ? { date: fin.slice(0, 10) } : { dateTime: fin, timeZone: ZONA };
  }
  return body;
}

export async function crearEvento(sb: SupabaseClient, c: CamposEvento): Promise<Evento> {
  return aEvento(await api(sb, "", { method: "POST", body: JSON.stringify(aBody(c)) }));
}

export async function editarEvento(
  sb: SupabaseClient,
  id: string,
  c: CamposEvento,
  base: Evento,
): Promise<Evento> {
  // PATCH y no PUT: así no se pisan los campos que el agente no tocó
  // (invitados, recordatorios, recurrencia…).
  return aEvento(
    await api(sb, `/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(aBody(c, base)),
    }),
  );
}

export async function borrarEvento(sb: SupabaseClient, id: string): Promise<void> {
  await api(sb, `/${encodeURIComponent(id)}`, { method: "DELETE" });
}
