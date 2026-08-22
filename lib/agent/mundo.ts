import type { SupabaseClient } from "@supabase/supabase-js";
import type { Tool } from "./tools";
import { hoy as hoyAr, diaLargo, esFecha } from "../fechas";

/**
 * Herramientas del mundo de afuera: clima, feriados y rutas.
 *
 * Las tres son consultas a APIs públicas y **ninguna toca Supabase**. Viven acá
 * y no en `tools.ts` por eso mismo: aquel archivo es la capa de datos del
 * usuario, éste es el mundo. Ninguna guarda nada ni cuesta un centavo.
 *
 * ## Por qué estas tres y no una API paga
 *
 * - Clima: **Open-Meteo**, sin clave y sin registro. La alternativa de la lista
 *   pública (Weatherstack) pide clave para lo mismo.
 * - Feriados: **Nager.Date**, sin clave. Cubre AR y US, que es lo que se pidió.
 * - Rutas: **Nominatim** (dirección → coordenadas) + **OSRM** (ruta), las dos
 *   sin clave. Google Directions daría tiempos CON tránsito, pero exige una
 *   cuenta de facturación en Google Cloud. Ver la advertencia en `ruta`.
 *
 * ## La regla de oro, igual que en `tools.ts`
 *
 * Cada handler devuelve la CONCLUSIÓN redactada en `para_decir`, no el JSON
 * crudo de la API. El modelo repite; no interpreta códigos ni hace cuentas de
 * minutos. Un pronóstico de Open-Meteo son ~2.000 tokens de JSON; lo que sale
 * de acá son ~40.
 */

// Plazo corto a propósito: esto corre en medio de una conversación hablada. Más
// vale «no pude averiguarlo» en 8 segundos que un silencio de treinta.
const PLAZO = 8000;

// Nominatim EXIGE un User-Agent que identifique la aplicación; sin él responde
// 403. Es la condición de su uso gratuito, junto con no pasar de 1 consulta por
// segundo (acá se hace de a una, a mano, así que no hay riesgo).
const AGENTE = "plata-jarvis/1.0 (asistente personal)";

async function traer(url: string, cabeceras?: Record<string, string>) {
  const r = await fetch(url, {
    headers: { "User-Agent": AGENTE, ...cabeceras },
    signal: AbortSignal.timeout(PLAZO),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const motivoDe = (e: unknown) =>
  e instanceof Error && e.name === "TimeoutError"
    ? "El servicio tardó demasiado en contestar."
    : e instanceof Error
      ? e.message
      : "Error desconocido";

// ---------------------------------------------------------------------------
// Clima
// ---------------------------------------------------------------------------

/**
 * Los códigos WMO que devuelve Open-Meteo, en castellano hablado.
 *
 * Se traducen ACÁ y no en el modelo por la regla de oro: mandarle un `73` y
 * que adivine es pedirle que invente. Los que faltan caen en "sin datos", que
 * es honesto y no rompe nada.
 */
const CIELO: Record<number, string> = {
  0: "despejado", 1: "mayormente despejado", 2: "parcialmente nublado", 3: "nublado",
  45: "con niebla", 48: "con niebla y escarcha",
  51: "con llovizna leve", 53: "con llovizna", 55: "con llovizna fuerte",
  56: "con llovizna helada", 57: "con llovizna helada fuerte",
  61: "con lluvia leve", 63: "con lluvia", 65: "con lluvia fuerte",
  66: "con lluvia helada", 67: "con lluvia helada fuerte",
  71: "con nevada leve", 73: "nevando", 75: "con nevada fuerte", 77: "con aguanieve",
  80: "con chaparrones leves", 81: "con chaparrones", 82: "con chaparrones fuertes",
  85: "con chaparrones de nieve", 86: "con chaparrones de nieve fuertes",
  95: "con tormenta", 96: "con tormenta y granizo", 99: "con tormenta y granizo fuerte",
};

const ZONA_AR = "America/Argentina/Buenos_Aires";

/** Ciudad → coordenadas. Open-Meteo tiene su propio geocodificador, sin clave. */
async function ubicar(lugar: string) {
  const q = encodeURIComponent(lugar);
  const d = await traer(
    `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=es&format=json`,
  );
  const r = d?.results?.[0];
  if (!r) return null;
  const donde = [r.name, r.admin1, r.country].filter(Boolean);
  // Se saca el duplicado de "Buenos Aires, Buenos Aires": queda feo dicho en voz alta.
  const limpio = donde.filter((x: string, i: number) => donde.indexOf(x) === i);
  return {
    lat: r.latitude,
    lon: r.longitude,
    // Dos nombres a propósito: el corto es el que se DICE («Córdoba») y el largo
    // el que desambigua por escrito («Córdoba, Provincia de Córdoba, Argentina»).
    // Leer el largo en voz alta suena a GPS de 2005.
    nombre: String(r.name),
    nombre_largo: limpio.join(", "),
    tz: r.timezone,
  };
}

const redondo = (n: unknown) => Math.round(Number(n));

// El día corto para el panel ("jue"). Anclado al mediodía UTC a propósito: el día
// de la semana de un YYYY-MM-DD no depende de ninguna zona horaria si el parseo
// no puede correrlo de día — la misma jugada que hacen los feriados más abajo
// con sus milisegundos.
const diaChico = (f: string) =>
  new Date(`${f}T12:00:00Z`)
    .toLocaleDateString("es-AR", { weekday: "short", timeZone: "UTC" })
    .replace(/\./g, "");

const clima: Tool = {
  name: "clima",
  description:
    "El clima de ahora y el pronóstico de los próximos días. Usar para '¿cómo está " +
    "el clima?', '¿llueve hoy?', '¿hace frío?', '¿qué temperatura hay?', '¿cómo " +
    "viene el finde?', '¿me llevo campera?'. Si no dice de dónde, es Buenos Aires: " +
    "NO se lo preguntes.",
  input_schema: {
    type: "object",
    properties: {
      lugar: {
        type: "string",
        description:
          "Ciudad, solo si nombró una distinta a la suya ('Córdoba', 'Madrid'). " +
          "Si no dijo nada, omitilo.",
      },
      dias: {
        type: "number",
        description: "Cuántos días de pronóstico (1 a 7). Por defecto 3.",
      },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(_sb: SupabaseClient, input: Record<string, unknown>) {
    const pedido = String(input?.lugar ?? "").trim();
    const dias = Math.min(Math.max(Number(input?.dias) || 3, 1), 7);

    try {
      // Sin lugar se usa Buenos Aires con coordenadas fijas: es el 99% de los
      // casos y ahorra una llamada de red entera en el camino más frecuente.
      const donde = pedido
        ? await ubicar(pedido)
        : { lat: -34.6037, lon: -58.3816, nombre: "Buenos Aires", nombre_largo: "Buenos Aires", tz: ZONA_AR };
      if (!donde) {
        return {
          ok: false,
          motivo: `No encontré ningún lugar que se llame "${pedido}".`,
          que_hacer: "Preguntale a qué ciudad se refería. NO inventes el clima.",
        };
      }

      const d = await traer(
        `https://api.open-meteo.com/v1/forecast?latitude=${donde.lat}&longitude=${donde.lon}` +
          `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code` +
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
          // `forecast_hours` corta el hourly a partir de la HORA ACTUAL del lugar
          // (verificado en la doc de Open-Meteo), así que el [0] ya es esta hora.
          // Sin ese parámetro el array arranca a las 00:00 del día y habría que
          // indexar contra el timezone a mano — de ahí saldría el próximo bug UTC.
          `&hourly=temperature_2m,precipitation_probability&forecast_hours=12` +
          `&timezone=${encodeURIComponent(donde.tz || ZONA_AR)}&forecast_days=${dias}`,
      );

      const ahora = d.current;
      const temp = redondo(ahora.temperature_2m);
      const sens = redondo(ahora.apparent_temperature);
      const cielo = CIELO[Number(ahora.weather_code)] ?? "sin datos de cielo";

      const pronostico = (d.daily?.time ?? []).map((f: string, i: number) => ({
        fecha: f,
        cuando: i === 0 ? "hoy" : i === 1 ? "mañana" : diaLargo(f),
        min: redondo(d.daily.temperature_2m_min[i]),
        max: redondo(d.daily.temperature_2m_max[i]),
        prob_lluvia_pct: redondo(d.daily.precipitation_probability_max[i]),
        cielo: CIELO[Number(d.daily.weather_code[i])] ?? "sin datos",
      }));

      // La frase sale armada de acá. La sensación térmica solo se menciona si
      // se aparta de la real: decir "12 grados, sensación 12" es ruido.
      const hoyP = pronostico[0];
      const sensacion = Math.abs(sens - temp) >= 2 ? `, sensación ${sens}` : "";
      const lluvia = hoyP && hoyP.prob_lluvia_pct >= 30
        ? ` Hay ${hoyP.prob_lluvia_pct}% de probabilidad de lluvia.`
        : "";
      const maxmin = hoyP ? ` Hoy va de ${hoyP.min} a ${hoyP.max} grados.` : "";

      // Las próximas horas, hora a hora. Se piden 12 y el panel dibuja 8.
      const horas: { hora: string; temp: number; lluvia_pct: number }[] =
        (d.hourly?.time ?? []).map((t: string, i: number) => ({
          // "17", sin cero adelante ni minutos: es una columna del HUD, no un log.
          hora: String(Number(String(t).slice(11, 13))),
          temp: redondo(d.hourly.temperature_2m[i]),
          lluvia_pct: redondo(d.hourly.precipitation_probability[i]),
        }));

      // El aviso mira las 12 horas pedidas, no solo las 8 que se dibujan: una
      // tormenta a la hora 9 merece la advertencia aunque no tenga columna.
      const conLluvia = horas.filter((h) => h.lluvia_pct > 50);
      const avisoLluvia = conLluvia.length
        ? conLluvia.length === 1
          ? `llueve a las ${conLluvia[0].hora} · ${conLluvia[0].lluvia_pct}%`
          : `llueve de ${conLluvia[0].hora} a ${conLluvia[conLluvia.length - 1].hora} · ` +
            `${Math.max(...conLluvia.map((h) => h.lluvia_pct))}%`
        : null;

      return {
        ok: true,
        lugar: donde.nombre_largo,
        ahora: { temperatura: temp, sensacion: sens, humedad_pct: redondo(ahora.relative_humidity_2m), cielo },
        pronostico,
        para_decir:
          `En ${donde.nombre} hay ${temp} grados${sensacion}, ${cielo}.${maxmin}${lluvia}`,
        // El contrato con la cara WPF — no cambiarle la forma. Al modelo no le
        // llega: run.ts lo saca antes, igual que el panel de la agenda.
        panel: {
          tipo: "clima",
          lugar: donde.nombre,
          ahora: { temperatura: temp, sensacion: sens, humedad_pct: redondo(ahora.relative_humidity_2m), cielo },
          horas: horas.slice(0, 8),
          dias: pronostico.slice(0, 3).map((p: { fecha: string; min: number; max: number; prob_lluvia_pct: number; cielo: string }) => ({
            dia: diaChico(p.fecha), min: p.min, max: p.max, lluvia_pct: p.prob_lluvia_pct, cielo: p.cielo,
          })),
          aviso_lluvia: avisoLluvia,
        },
      };
    } catch (e) {
      return { ok: false, motivo: `No pude consultar el clima: ${motivoDe(e)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Feriados
// ---------------------------------------------------------------------------

const PAISES: Record<string, { codigo: string; como: string }> = {
  ar: { codigo: "AR", como: "Argentina" },
  us: { codigo: "US", como: "Estados Unidos" },
};

type Feriado = { date: string; localName: string; name: string };

/**
 * Los feriados de un país para este año y el que viene.
 *
 * Se piden los DOS años siempre, y no es exceso de celo: preguntar "cuál es el
 * próximo feriado" un 20 de diciembre con un solo año cargado devuelve "no hay
 * más", que es falso. Son dos consultas a una API que cachea agresivo.
 */
async function feriadosDe(codigo: string): Promise<Feriado[]> {
  const anio = Number(hoyAr().slice(0, 4));
  const tandas = await Promise.all(
    [anio, anio + 1].map((a) =>
      traer(`https://date.nager.at/api/v3/PublicHolidays/${a}/${codigo}`).catch(() => []),
    ),
  );
  return tandas.flat() as Feriado[];
}

const feriados: Tool = {
  name: "feriados",
  description:
    "Los feriados de Argentina y de Estados Unidos: cuál es el próximo, o si una " +
    "fecha puntual cae feriado. Usar para '¿cuándo es el próximo feriado?', '¿el " +
    "lunes es feriado?', '¿hay finde largo?', '¿el 4 de julio qué se festeja?'. Si " +
    "no aclara el país, es Argentina.",
  input_schema: {
    type: "object",
    properties: {
      pais: {
        type: "string",
        enum: ["ar", "us", "ambos"],
        description: "'ar' Argentina (por defecto), 'us' Estados Unidos, 'ambos' los dos.",
      },
      fecha: {
        type: "string",
        description:
          "Solo si preguntó por un día PUNTUAL, en formato YYYY-MM-DD. Si preguntó " +
          "'cuál es el próximo', omitila.",
      },
      cuantos: {
        type: "number",
        description: "Cuántos feriados próximos listar (1 a 10). Por defecto 3.",
      },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(_sb: SupabaseClient, input: Record<string, unknown>) {
    const cual = String(input?.pais ?? "ar").trim().toLowerCase();
    const fecha = String(input?.fecha ?? "").trim();
    const cuantos = Math.min(Math.max(Number(input?.cuantos) || 3, 1), 10);

    if (fecha && !esFecha(fecha)) {
      return { ok: false, motivo: `"${fecha}" no es una fecha válida (va YYYY-MM-DD).` };
    }
    const elegidos = cual === "ambos" ? ["ar", "us"] : [PAISES[cual] ? cual : "ar"];

    try {
      const listas = await Promise.all(
        elegidos.map(async (k) => ({
          pais: PAISES[k].como,
          dias: await feriadosDe(PAISES[k].codigo),
        })),
      );

      // Pregunta puntual: ¿ese día es feriado?
      if (fecha) {
        const cae = listas.flatMap((l) =>
          l.dias.filter((f) => f.date === fecha).map((f) => ({ pais: l.pais, como: f.localName })),
        );
        return {
          ok: true,
          fecha,
          es_feriado: cae.length > 0,
          detalle: cae,
          para_decir: cae.length
            ? `Sí, el ${diaLargo(fecha)} es feriado: ${cae
                .map((c) => `${c.como}${elegidos.length > 1 ? ` en ${c.pais}` : ""}`)
                .join(", ")}.`
            : `No, el ${diaLargo(fecha)} no es feriado en ${listas
                .map((l) => l.pais)
                .join(" ni en ")}.`,
        };
      }

      // Los próximos. Se compara como texto porque las dos puntas son YYYY-MM-DD,
      // que ordena igual alfabética que cronológicamente — y así no entra ni una
      // conversión a Date, que es de donde salen los off-by-one de zona horaria.
      const desde = hoyAr();
      const proximos = listas.flatMap((l) =>
        l.dias
          .filter((f) => f.date >= desde)
          .map((f) => ({ pais: l.pais, fecha: f.date, que_es: f.localName })),
      );
      proximos.sort((a, b) => a.fecha.localeCompare(b.fecha));
      const recorte = proximos.slice(0, cuantos);

      if (!recorte.length) {
        return { ok: true, proximos: [], para_decir: "No me quedan feriados cargados." };
      }
      const p = recorte[0];
      // Los días que faltan se cuentan en milisegundos al mediodía de cada punta:
      // al mediodía, el cambio de horario de verano no puede correr el día.
      const faltan = Math.round(
        (Date.parse(`${p.fecha}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 864e5,
      );
      const cuando = faltan === 0 ? "es hoy" : faltan === 1 ? "es mañana" : `faltan ${faltan} días`;

      return {
        ok: true,
        proximos: recorte,
        para_decir:
          `El próximo feriado ${elegidos.length > 1 ? `(${p.pais}) ` : ""}es el ` +
          `${diaLargo(p.fecha)}, ${p.que_es}: ${cuando}.`,
      };
    } catch (e) {
      return { ok: false, motivo: `No pude consultar los feriados: ${motivoDe(e)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

/**
 * Dirección → coordenadas, con Nominatim (OpenStreetMap).
 *
 * Se le agrega ", Argentina" cuando el texto no nombra un país conocido: sin
 * eso, "Corrientes 348" puede caer en cualquier lado del planeta, y el error es
 * silencioso — devuelve una ruta perfecta a la ciudad equivocada.
 */
async function geocodificar(texto: string) {
  const suena = /argentina|uruguay|chile|brasil|españa|estados unidos|usa|eeuu/i.test(texto);
  const q = encodeURIComponent(suena ? texto : `${texto}, Argentina`);
  const d = await traer(
    `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=0`,
  );
  const r = Array.isArray(d) ? d[0] : null;
  if (!r) return null;
  // El display_name de Nominatim es larguísimo (once campos hasta el código
  // postal). Para DECIRLO alcanza con el primero; el de tres partes queda en los
  // datos por si hay que desambiguar. Medido en la prueba: la versión larga daba
  // «a Aeropuerto Internacional Ministro Pistarini, Autopista Ezeiza - Cañuelas,
  // Aeropuerto Internacional Ezeiza», que nadie dice nunca.
  const partes = String(r.display_name).split(",").map((s) => s.trim());
  return {
    lat: Number(r.lat),
    lon: Number(r.lon),
    nombre: partes[0],
    nombre_largo: partes.slice(0, 3).join(", "),
  };
}

// Velocidades para estimar a pie y en bici. NO salen del ruteador: el servidor
// público de OSRM tiene cargado SOLO el mapa de autos, y si se le pide el perfil
// `walking` responde igual que para un auto (medido: 2,8 km en 5 minutos, que
// caminando son 35). Antes que repetir ese número, se estima con la distancia.
// Son estimaciones y se dicen como tales.
const VELOCIDAD: Record<string, { kmh: number; como: string }> = {
  caminando: { kmh: 4.8, como: "caminando" },
  bici: { kmh: 15, como: "en bici" },
};

const ruta: Tool = {
  name: "ruta",
  description:
    "Cuánto hay de un lugar a otro y cuánto se tarda, por calle. Usar para '¿cuánto " +
    "tardo de acá a X?', '¿qué tan lejos queda Y?', '¿cuánto hay hasta Z?'. Pasá las " +
    "direcciones TAL COMO las dijo, sin completarlas ni corregirlas.\n" +
    "⚠️ El tiempo NO tiene en cuenta el tránsito del momento: es el de calle libre. " +
    "Decilo cuando la respuesta sea un horario que le importe (si llega a algo).",
  input_schema: {
    type: "object",
    properties: {
      desde: {
        type: "string",
        description:
          "El origen, tal como lo dijo ('el obelisco', 'Corrientes 348'). Si dijo " +
          "'de acá' o no lo nombró, omitilo y sale desde su casa.",
      },
      hasta: { type: "string", description: "El destino, tal como lo dijo." },
      modo: {
        type: "string",
        enum: ["auto", "caminando", "bici"],
        description: "Por defecto 'auto'.",
      },
    },
    required: ["hasta"],
  },
  canales: ["telegram", "pc"],
  async handler(_sb: SupabaseClient, input: Record<string, unknown>) {
    const hasta = String(input?.hasta ?? "").trim();
    const modo = String(input?.modo ?? "auto").trim().toLowerCase();
    // Si no dice de dónde, sale del centro. Es un default honesto y mejorable:
    // el día que haya una dirección de casa cargada, va acá y nada más cambia.
    const desde = String(input?.desde ?? "").trim() || "Obelisco, Buenos Aires";
    if (!hasta) return { ok: false, motivo: "No me dijiste adónde." };

    try {
      // En serie y no en paralelo: Nominatim pide un máximo de una consulta por
      // segundo, y respetarlo es la condición de que siga siendo gratis.
      const a = await geocodificar(desde);
      if (!a) {
        return {
          ok: false,
          motivo: `No encontré dónde queda "${desde}".`,
          que_hacer: "Pedile la dirección con más detalle. NO inventes una ruta.",
        };
      }
      await new Promise((r) => setTimeout(r, 1100));
      const b = await geocodificar(hasta);
      if (!b) {
        return {
          ok: false,
          motivo: `No encontré dónde queda "${hasta}".`,
          que_hacer: "Pedile la dirección con más detalle. NO inventes una ruta.",
        };
      }

      const d = await traer(
        `https://router.project-osrm.org/route/v1/driving/` +
          `${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`,
      );
      const r0 = d?.routes?.[0];
      if (!r0) return { ok: false, motivo: "No hay ninguna ruta por calle entre esos dos puntos." };

      const km = r0.distance / 1000;
      const v = VELOCIDAD[modo];
      const minutos = v ? Math.round((km / v.kmh) * 60) : Math.round(r0.duration / 60);
      const comoSeVa = v ? v.como : "en auto";
      const tiempo = minutos >= 60
        ? `${Math.floor(minutos / 60)} h ${minutos % 60} min`
        : `${minutos} minutos`;

      return {
        ok: true,
        desde: a.nombre_largo,
        hasta: b.nombre_largo,
        km: Number(km.toFixed(1)),
        minutos,
        modo: comoSeVa,
        estimado: Boolean(v),
        sin_transito: true,
        para_decir:
          `De ${a.nombre} a ${b.nombre} hay ${km.toFixed(1)} kilómetros, ` +
          `${tiempo} ${comoSeVa}${v ? " aproximadamente" : " sin contar el tránsito"}.`,
      };
    } catch (e) {
      return { ok: false, motivo: `No pude calcular la ruta: ${motivoDe(e)}` };
    }
  },
};

export const TOOLS_MUNDO: Tool[] = [clima, feriados, ruta];
