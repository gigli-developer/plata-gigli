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
 *
 * Un evento sirve para AVISAR, no solo para figurar: por eso acá viven también
 * los recordatorios y la repetición. Google los expone en dos campos
 * independientes del evento:
 *
 *   "reminders":  { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 15 }] }
 *   "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=TU"]
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

/**
 * Minúsculas y sin tildes. Al dictar nadie acentúa: "miércoles" y "miercoles"
 * tienen que ser la misma palabra, tanto para buscar un evento como para
 * entender "todos los miércoles".
 */
function plano(s: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Recordatorios
// ---------------------------------------------------------------------------

export type MetodoAviso = "popup" | "email";

/** Un aviso ya normalizado: minutos ANTES del inicio. */
export type Recordatorio = { minutos: number; metodo: MetodoAviso };

/**
 * Lo que se acepta al pedir un aviso: el número pelado alcanza (`15` = 15
 * minutos antes, por pantalla) y la forma larga existe solo para pedir mail.
 */
export type PedidoRecordatorio = number | { minutos: number; metodo?: MetodoAviso };

/** Tope de Google: 5 `overrides` por evento. El sexto hace fallar la request entera. */
const MAX_AVISOS = 5;
/** Tope de Google: 4 semanas antes. Más que eso lo rechaza con un 400 en inglés. */
const MAX_MINUTOS = 40320;

/**
 * Convierte lo que pidió el modelo en los `overrides` que quiere Google, y
 * revienta con un motivo DECIBLE si algo no cierra.
 *
 * Está exportada a propósito: conviene llamarla al armar la propuesta (antes de
 * que el usuario confirme) y no recién al escribir en Google, así el "no puedo"
 * llega en la misma frase en la que pidió el aviso y no después del "dale".
 *
 * ⚠️ Los repetidos se sacan ANTES de contar contra el tope de 5: "avisame 15
 * minutos antes... y 15 minutos antes" no tiene por qué gastar dos lugares.
 */
export function normalizarRecordatorios(
  pedidos: PedidoRecordatorio[],
  metodoPorDefecto: MetodoAviso = "popup",
): Recordatorio[] {
  if (!Array.isArray(pedidos)) {
    throw new Error("Los recordatorios tienen que venir como una lista de minutos.");
  }

  const salida: Recordatorio[] = [];
  const vistos = new Set<string>();

  for (const p of pedidos) {
    // El modelo a veces manda `{minutes, method}` en inglés (copia la doc de
    // Google) o los minutos como texto. Se aceptan las dos formas: rebotar por
    // eso sería pedantería, no una validación.
    const crudo = typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
    const bruto = crudo ? crudo.minutos ?? crudo.minutes : p;
    const minutos = typeof bruto === "string" ? Number(bruto.trim()) : bruto;

    if (typeof minutos !== "number" || !Number.isFinite(minutos)) {
      throw new Error(`No entendí de cuántos minutos antes es el aviso: "${String(bruto)}".`);
    }
    if (!Number.isInteger(minutos)) {
      throw new Error(`El aviso tiene que ser un número entero de minutos: ${minutos} no sirve.`);
    }
    if (minutos < 0) {
      throw new Error("Un aviso no puede ser después del evento: los minutos van de 0 en adelante.");
    }
    if (minutos > MAX_MINUTOS) {
      throw new Error(
        `Google no avisa con más de 4 semanas (${MAX_MINUTOS} minutos) de anticipación, y me pediste ${minutos}.`,
      );
    }

    const m = crudo ? crudo.metodo ?? crudo.method : undefined;
    const metodo = m === undefined || m === null ? metodoPorDefecto : plano(String(m));
    if (metodo !== "popup" && metodo !== "email") {
      throw new Error(
        `El aviso solo puede ser por pantalla ("popup") o por mail ("email"), no "${String(m)}".`,
      );
    }

    const clave = `${metodo}:${minutos}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ minutos, metodo });
  }

  if (salida.length > MAX_AVISOS) {
    throw new Error(
      `Google acepta hasta ${MAX_AVISOS} avisos por evento y me pediste ${salida.length}. Decime cuáles dejo.`,
    );
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Repetición (RRULE, RFC 5545)
// ---------------------------------------------------------------------------

/** Los días de la semana EN ORDEN, que es lo que hace falta para expandir un rango. */
const DIAS: { re: RegExp; cod: string }[] = [
  { re: /\blunes\b/, cod: "MO" },
  { re: /\bmartes\b/, cod: "TU" },
  { re: /\bmiercoles\b/, cod: "WE" },
  { re: /\bjueves\b/, cod: "TH" },
  { re: /\bviernes\b/, cod: "FR" },
  { re: /\bsabados?\b/, cod: "SA" },
  { re: /\bdomingos?\b/, cod: "SU" },
];
const HABILES = ["MO", "TU", "WE", "TH", "FR"];

/** "dos" → 2. Al dictar, los números salen en letras tanto como en dígitos. */
const NUMEROS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15,
  veinte: 20, treinta: 30,
};

function numeroDe(txt: string): number | null {
  if (/^\d+$/.test(txt)) return Number(txt);
  return NUMEROS[txt] ?? null;
}

function codigoDeDia(palabra: string): string | null {
  return DIAS.find((d) => d.re.test(palabra))?.cod ?? null;
}

/** Qué días concretos nombró, ya en orden de semana. Vacío = no nombró ninguno. */
function diasDe(t: string): string[] {
  // Los atajos van PRIMERO: "de lunes a viernes" nombra dos días pero significa
  // cinco, y "entre semana" no nombra ninguno.
  if (/\b(habiles|laborables)\b/.test(t) || /\bentre semana\b/.test(t) || /\bdias de semana\b/.test(t)) {
    return [...HABILES];
  }
  if (/\bfin(es)? de semana\b/.test(t) || /\bfindes?\b/.test(t)) return ["SA", "SU"];

  const nombres = DIAS.map((d) => d.re.source.replace(/\\b/g, "")).join("|");
  const rango = new RegExp(`\\b(${nombres})\\s+a\\s+(${nombres})\\b`).exec(t);
  if (rango) {
    const desde = DIAS.findIndex((d) => d.cod === codigoDeDia(rango[1]));
    const hasta = DIAS.findIndex((d) => d.cod === codigoDeDia(rango[2]));
    if (desde >= 0 && hasta >= 0) {
      // Se recorre en círculo: "de viernes a lunes" es VI-SA-DO-LU, no vacío.
      const out: string[] = [];
      for (let i = desde; ; i = (i + 1) % DIAS.length) {
        out.push(DIAS[i].cod);
        if (i === hasta) break;
      }
      return out;
    }
  }

  return DIAS.filter((d) => d.re.test(t)).map((d) => d.cod);
}

/** "cada 2 semanas" → { cada: 2, freq: "WEEKLY" }. Null si no dijo un intervalo. */
function intervaloDe(t: string): { cada: number; freq: string } | null {
  const m = /\bcada\s+(\d{1,4}|[a-z]+)\s+(dias?|semanas?|mes(?:es)?|anos?)\b/.exec(t);
  if (!m) return null;
  const cada = numeroDe(m[1]);
  if (cada === null || cada < 1) return null;
  const u = m[2];
  const freq =
    u.startsWith("dia") ? "DAILY" :
    u.startsWith("semana") ? "WEEKLY" :
    u.startsWith("mes") ? "MONTHLY" :
    "YEARLY";
  return { cada, freq };
}

function armar(freq: string, cada = 1, dias: string[] = []): string {
  return `RRULE:FREQ=${freq}` +
    (cada > 1 ? `;INTERVAL=${cada}` : "") +
    (dias.length ? `;BYDAY=${dias.join(",")}` : "");
}

/**
 * Traduce lo que uno DICE a la regla que entiende Google.
 *
 * Devuelve la línea entera lista para meter en `recurrence` (con el prefijo
 * `RRULE:`), o **null si no lo entendió**. Null no es un detalle: el llamador
 * tiene que avisar "no te entendí cada cuánto" en vez de inventar una regla,
 * porque una repetición inventada ensucia el calendario para adelante y el
 * usuario se entera semanas después.
 *
 * Está exportada suelta para poder probarla sin tocar Google.
 *
 * ⚠️ No fija el día ni la hora: eso lo saca Google del `start` del evento.
 * "Todos los meses" repite el día del mes en que arranca — no hay que mandar
 * BYMONTHDAY, y mandarlo sería inventar un dato que el usuario no dio.
 */
export function aRRule(criollo: string): string | null {
  const t = plano(criollo).replace(/\s+/g, " ").trim();
  if (!t) return null;

  // Si ya viene una RRULE hecha, pasa derecho. El modelo a veces la escribe solo
  // (la vio mil veces en la doc de Google) y rebotarla sería absurdo.
  const crudo = criollo.trim().toUpperCase().replace(/^RRULE:/, "");
  if (/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)\b/.test(crudo)) return `RRULE:${crudo}`;

  const dias = diasDe(t);
  const intervalo = intervaloDe(t);

  // Los días concretos mandan sobre todo lo demás: "cada dos semanas los martes"
  // es WEEKLY;INTERVAL=2;BYDAY=TU. Un intervalo en otra unidad ("cada 2 meses los
  // martes") no se puede expresar así; antes que inventar se ignora el intervalo
  // y queda semanal, que es lo que dijo.
  if (dias.length) {
    const cada = intervalo?.freq === "WEEKLY" ? intervalo.cada : 1;
    return armar("WEEKLY", cada, dias);
  }
  if (intervalo) return armar(intervalo.freq, intervalo.cada);

  // Los "cada tanto" que tienen nombre propio.
  if (/\bquincenal(mente)?\b/.test(t)) return armar("WEEKLY", 2);
  if (/\bbimestral(mente)?\b/.test(t)) return armar("MONTHLY", 2);
  if (/\btrimestral(mente)?\b/.test(t)) return armar("MONTHLY", 3);
  if (/\bsemestral(mente)?\b/.test(t)) return armar("MONTHLY", 6);

  // Y las frecuencias peladas.
  // ⚠️ "año" queda como "ano" después de sacarle la tilde (la ñ se descompone en
  // n + tilde, y la tilde se va). Feo, pero es contra ESO que hay que matchear.
  if (/\b(diario|diariamente|dias?)\b/.test(t)) return armar("DAILY");
  if (/\b(semanal(mente)?|semanas?)\b/.test(t)) return armar("WEEKLY");
  if (/\b(mensual(mente)?|mes(es)?)\b/.test(t)) return armar("MONTHLY");
  if (/\b(anual(mente)?|anos?|anios?|aniversario)\b/.test(t)) return armar("YEARLY");

  return null;
}

/**
 * "no", "nunca", "una sola vez": pedidos de SACAR la repetición, no de ponerla.
 * Van por afuera de `aRRule` porque ahí null significa "no entendí", y confundir
 * "no entendí" con "sacásela" es justo lo que no queremos.
 */
export function pideNoRepetir(t: string): boolean {
  return /^(no|nunca|ninguna|ninguno|nada|una vez|una sola vez|solo una vez|sin repetir|sin repeticion|no repetir|no se repite)$/
    .test(plano(t).replace(/\s+/g, " ").trim());
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

  /**
   * Los avisos puestos a mano. `[]` significa "no tiene ninguno" (es un dato,
   * no la falta de un dato); `undefined` significa que no se sabe.
   */
  recordatorios?: Recordatorio[];
  /**
   * El evento usa los avisos por defecto del calendario. ⚠️ CUÁLES son no se
   * puede saber con el scope `calendar.events`: viven en la configuración del
   * calendario, no en el evento. Por eso en ese caso `recordatorios` viene
   * vacío a propósito — antes que inventar "15 minutos antes", que diga que
   * usa los de siempre.
   */
  usa_recordatorio_default?: boolean;
  /** Las RRULE tal cual las guarda Google, ej. `["RRULE:FREQ=WEEKLY;BYDAY=TU"]`. */
  repeticion?: string[];
  /**
   * Si este evento es UNA FECHA de una serie, el id del evento madre.
   * ⚠️ Editar por el id de la instancia cambia solo ese día; para tocar la serie
   * entera hay que ir contra este id.
   */
  serie_id?: string;
};

/** La parte de la respuesta de Google que nos interesa. Trae bastante más. */
type EventoGoogle = {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurrence?: string[];
  recurringEventId?: string;
  reminders?: { useDefault?: boolean; overrides?: { method?: string; minutes?: number }[] };
};

/** Normaliza la respuesta de Google a algo chico y estable. */
function aEvento(e: EventoGoogle): Evento {
  const todoElDia = Boolean(e.start?.date);
  const r = e.reminders;

  // Son TRES estados distintos y hay que poder decir los tres:
  //   sin `reminders`  → no sabemos nada (Google no lo mandó)
  //   useDefault:true  → usa los del calendario, que no podemos leer
  //   useDefault:false → la lista es la verdad, aunque esté vacía
  const usaDefault = r ? r.useDefault === true : undefined;
  const avisos = r && !usaDefault
    ? (r.overrides ?? [])
        // Sin `minutes` el aviso no dice nada; se descarta en vez de completarlo.
        .filter((o): o is { method?: string; minutes: number } => typeof o.minutes === "number")
        // Google dejó de mandar SMS en 2019: hoy solo devuelve popup o email.
        .map((o): Recordatorio => ({ minutos: o.minutes, metodo: o.method === "email" ? "email" : "popup" }))
    : undefined;

  return {
    id: String(e.id),
    titulo: String(e.summary ?? "(sin título)"),
    inicio: String(e.start?.dateTime ?? e.start?.date ?? ""),
    fin: String(e.end?.dateTime ?? e.end?.date ?? ""),
    todo_el_dia: todoElDia,
    lugar: e.location ? String(e.location) : undefined,
    nota: e.description ? String(e.description).slice(0, 300) : undefined,
    recordatorios: avisos,
    usa_recordatorio_default: usaDefault,
    repeticion: e.recurrence?.length ? e.recurrence.map(String) : undefined,
    serie_id: e.recurringEventId ? String(e.recurringEventId) : undefined,
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
  //
  // ⚠️ Lo que `singleEvents=true` le hace a lo nuevo: las instancias expandidas NO
  // traen `recurrence`, así que acá `repeticion` viene siempre vacío. Lo que sí
  // traen es `recurringEventId` → `serie_id`, que alcanza para saber que la cosa
  // se repite; la regla en sí se lee pidiendo ESE id con `obtenerEvento`.
  const data = await api(sb, `?${q}`);
  const eventos: Evento[] = (data?.items ?? []).map(aEvento);
  if (!busqueda) return eventos;

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

  /**
   * Minutos ANTES del inicio, uno por aviso: `[15, 1440]` es "un cartel 15
   * minutos antes y otro el día anterior".
   *
   * ⚠️ Los tres estados importan, sobre todo en el PATCH de edición:
   *   undefined → NO se tocan los avisos que ya tiene el evento.
   *   []        → se le sacan todos (ni los propios ni los del calendario).
   *   [n, ...]  → esos y solo esos.
   */
  recordatorios?: PedidoRecordatorio[];
  /** Por dónde avisa, para todos los de arriba que no lo aclaren. Default popup. */
  recordatorios_metodo?: MetodoAviso;

  /**
   * Cada cuánto se repite, EN CRIOLLO: "todos los martes", "dias habiles",
   * "cada 2 semanas", "mensual". Lo traduce `aRRule`; si no se entiende, la
   * operación falla con un motivo decible en vez de inventar una regla.
   *
   * ⚠️ Mismos tres estados que los avisos: undefined no toca nada, y
   * "no" / "una sola vez" / "" le saca la repetición que tuviera.
   */
  repetir?: string;
};

/** Empieza con fecha Y hora: `2026-08-14T15:00`. Sin esto Google rechaza el dateTime. */
const CON_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * El día siguiente a una fecha `YYYY-MM-DD`.
 *
 * ⚠️ Todo en UTC y a mano: `new Date("2026-08-14")` se parsea como UTC y al
 * leerlo en hora local argentina da el 13. El clásico off-by-one del proyecto.
 */
function diaSiguiente(fecha: string): string {
  const [y, m, d] = fecha.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Suma horas conservando el formato y el offset que vino.
 *
 * ⚠️ No se usa `new Date(iso).getTime() + 36e5` + `toISOString()` porque eso
 * devuelve siempre en Z: si el `inicio` venía SIN offset ("2026-08-14T15:00:00",
 * que Google interpreta con el `timeZone` que le mandamos), el fin salía en UTC y
 * el evento quedaba de cuatro horas. Acá se hace cuenta de reloj de pared sobre
 * los mismos componentes y se le vuelve a pegar el sufijo original. Vale porque
 * Argentina no cambia de horario desde 2009.
 */
function sumarHoras(iso: string, horas: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(.*)$/.exec(iso.trim());
  if (!m) throw new Error(`No entendí la fecha y hora "${iso}".`);
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + horas, +m[5], +(m[6] ?? 0)));
  const dd = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${dd(t.getUTCMonth() + 1)}-${dd(t.getUTCDate())}` +
    `T${dd(t.getUTCHours())}:${dd(t.getUTCMinutes())}:${dd(t.getUTCSeconds())}${m[7] ?? ""}`;
}

/** Arma el body de Google a partir de nuestros campos. */
function aBody(c: CamposEvento, base?: Evento): Record<string, unknown> {
  const todoElDia = c.todo_el_dia ?? base?.todo_el_dia ?? false;
  const body: Record<string, unknown> = {};

  if (c.titulo !== undefined) body.summary = c.titulo;
  if (c.lugar !== undefined) body.location = c.lugar;
  if (c.nota !== undefined) body.description = c.nota;

  const inicio = c.inicio ?? base?.inicio;
  let fin = c.fin ?? base?.fin;

  if (inicio && !todoElDia && !CON_HORA.test(inicio)) {
    // Google contesta "Invalid value for: dateTime" y el asistente terminaba
    // repitiendo eso en inglés. Es más útil devolver la pregunta que falta hacer.
    throw new Error(
      `El inicio "${inicio}" no tiene hora. Decime a qué hora es, o marcalo como de día completo.`,
    );
  }

  if (inicio) {
    // Duración por defecto: una hora.
    //
    // ⚠️ Google EXIGE `end` al crear — sin esto tiraba "Missing end time".
    // `agenda_cambiar` ya venía rellenando el fin antes de llamar acá, pero
    // cualquier otro llamador de `crearEvento` (una tarea, una prueba) se comía
    // la falla. Al editar no se dispara nunca: `base.fin` siempre viene de Google.
    if (!fin) fin = todoElDia ? diaSiguiente(inicio) : sumarHoras(inicio, 1);

    // ⚠️ Los dos casos de conversión, que antes le mandaban basura a Google:
    // pasar un evento de día completo a uno con hora dejaba un `fin` que era una
    // fecha suelta ("2026-08-15") metida como dateTime; y al revés, uno de 15 a
    // 16 convertido en día completo daba start.date == end.date, que Google
    // rechaza con "The specified time range is empty" (el fin es EXCLUSIVO).
    if (!todoElDia && !CON_HORA.test(fin)) fin = sumarHoras(inicio, 1);
    if (todoElDia && fin.slice(0, 10) <= inicio.slice(0, 10)) fin = diaSiguiente(inicio);

    body.start = todoElDia
      ? { date: inicio.slice(0, 10) }
      : { dateTime: inicio, timeZone: ZONA };
  }
  if (fin) {
    body.end = todoElDia ? { date: fin.slice(0, 10) } : { dateTime: fin, timeZone: ZONA };
  }

  // ⚠️ `reminders` se toca SOLO si el campo vino. Mandar `useDefault:false` con
  // overrides vacíos "por las dudas" le sacaría los avisos a un evento que el
  // usuario solo quiso renombrar — el PATCH existe justamente para eso.
  if (c.recordatorios !== undefined) {
    body.reminders = {
      useDefault: false,
      overrides: normalizarRecordatorios(c.recordatorios, c.recordatorios_metodo ?? "popup")
        .map((a) => ({ method: a.metodo, minutes: a.minutos })),
    };
  }

  // Ídem con la repetición: undefined no la toca, "no" la borra.
  if (c.repetir !== undefined) {
    if (!c.repetir.trim() || pideNoRepetir(c.repetir)) {
      body.recurrence = [];
    } else {
      const regla = aRRule(c.repetir);
      if (!regla) {
        throw new Error(
          `No entendí cada cuánto se repite: "${c.repetir}". Decímelo como "todos los martes", ` +
          `"cada dos semanas", "mensual" o "días hábiles".`,
        );
      }
      body.recurrence = [regla];
    }
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
  // ⚠️ Cambiarle la repetición a UNA fecha de una serie es imposible: Google
  // contesta "Cannot change the recurrence of an instance". Se corta antes y con
  // el id de la serie a mano, así el asistente puede ofrecer el cambio completo
  // en vez de leerle un error en inglés.
  if (c.repetir !== undefined && base.serie_id) {
    throw new Error(
      `"${base.titulo}" es una fecha de un evento que ya se repite; para cambiar cada cuánto es, ` +
      `hay que editar la serie entera (id ${base.serie_id}).`,
    );
  }

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
