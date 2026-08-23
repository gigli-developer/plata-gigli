import type { SupabaseClient } from "@supabase/supabase-js";
import type { Tool } from "./tools";
import { ZONA } from "../fechas";

/**
 * Búsqueda web por ESCALAMIENTO.
 *
 * El modelo del canal (casi siempre Haiku) no busca: llama a `investigar_en_la_web`
 * con una pregunta, y el servidor abre una **conversación aparte** con un modelo más
 * fuerte que sí tiene la server tool `web_search` de la API. Al hilo principal vuelve
 * UNA conclusión de dos o tres frases y nada más.
 *
 * Por qué aislada y no la server tool colgada del hilo principal, que sería una línea:
 * los `web_search_tool_result` son enormes (varios miles de tokens por búsqueda) y
 * quedan en `messages` para siempre. Como cada turno reenvía el historial completo,
 * esos resultados se vuelven a pagar en CADA pregunta que venga después, aunque sean
 * sobre otra cosa. Acá el historial caro muere cuando termina esta función: lo único
 * que sobrevive es el string de la conclusión.
 *
 * Es además la combinación más cara del stack —búsquedas facturadas aparte, resultados
 * pesados, a precio del modelo grande—, así que todo lo de este archivo está pensado
 * para que se pague una vez y no vuelva a aparecer en la factura.
 */

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/**
 * El modelo fuerte sale de una env var, igual que `AGENT_MODEL` / `AGENT_MODEL_RAPIDO`
 * en run.ts: cambiarlo no puede requerir un deploy.
 *
 * ⚠️ El default es Sonnet y no Opus a propósito. El plan decía Opus 5, pero el costo es
 * la restricción central del proyecto y acá el modelo lee resultados de búsqueda —o sea,
 * miles de tokens de ENTRADA— para escribir dos frases. Con Opus la misma consulta sale
 * ~4 veces más y la tarea (resumir lo que ya está escrito en la página) no lo necesita.
 * Si alguna vez hace falta, es `AGENT_MODEL_WEB=claude-opus-5` y listo.
 */
export const MODELO_WEB = process.env.AGENT_MODEL_WEB ?? "claude-sonnet-5";

/** USD por millón de tokens. Si un modelo no está, se cobra como Opus: sobreestimar es el lado seguro. */
export const PRECIOS: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5": { in: 15, out: 75, cacheRead: 1.5 },
  "claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheRead: 0.1 },
};

/** La server tool se factura aparte: US$ 10 cada 1.000 búsquedas, además de los tokens. */
const USD_POR_BUSQUEDA = 10 / 1000;

/**
 * Techo de búsquedas por consulta.
 *
 * ⚠️ Bajado de 3 a 2 con el número medido en la mano. UNA búsqueda real contra la API
 * metió **14.739 tokens de entrada** —no los ~4.500 que se habían estimado— y salió
 * US$ 0,058 con Sonnet. A ese ritmo un techo de 3 dejaba consultas de ~US$ 0,15, que
 * son 40 consultas de finanzas. Con 2 alcanza para contrastar dos fuentes y el peor
 * caso queda en la mitad.
 */
const MAX_BUSQUEDAS = 2;

/**
 * Dos vueltas como mucho. La API resuelve las búsquedas del lado del servidor dentro de
 * la misma respuesta, así que lo normal es una sola llamada; la segunda existe solo para
 * el `stop_reason: "pause_turn"`, que es la API avisando que cortó una búsqueda larga por
 * la mitad y hay que devolverle lo que lleva para que siga.
 */
const MAX_VUELTAS = 2;

/**
 * Esto se escucha. Si a los 20 segundos no hay respuesta ya no sirve: es preferible
 * decirle "no lo pude averiguar" que dejarlo esperando frente al HUD sin saber si
 * pasó algo. `fetch` sin `signal` puede colgarse mucho más que eso.
 */
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// La clave
// ---------------------------------------------------------------------------

/**
 * La clave vive en `app_secrets` (misma fuente única que el resto del proyecto), pero el
 * handler de una Tool solo recibe `sb`: la que ya tiene el route handler no llega hasta acá
 * sin cambiar la firma de TODAS las herramientas. Se lee de la tabla y se cachea en memoria
 * del proceso, como hace `spotify.ts` con su token — si no, cada búsqueda pagaría un viaje
 * de ida y vuelta a Supabase antes de empezar.
 */
let claveCacheada: string | null = null;

/** Exportada para los otros sub-agentes (razonar.ts): misma clave, mismo caché. */
export async function claveAnthropic(sb: SupabaseClient): Promise<string> {
  if (claveCacheada) return claveCacheada;
  const { data, error } = await sb
    .from("app_secrets")
    .select("value")
    .eq("key", "ANTHROPIC_API_KEY")
    .limit(1);
  if (error) throw new Error(`No pude leer la clave de Anthropic: ${error.message}`);
  const v = data?.[0]?.value;
  if (!v) throw new Error("Falta ANTHROPIC_API_KEY en app_secrets");
  claveCacheada = v;
  return v;
}

// ---------------------------------------------------------------------------
// Cuánto salió
// ---------------------------------------------------------------------------

export type CostoWeb = { usd: number; busquedas: number; entrada: number; salida: number };

/**
 * Lo que costó la última sub-llamada.
 *
 * El costo NO se devuelve en el resultado de la herramienta a propósito: iría al modelo,
 * que lo tiene prohibido inventar pero no leer en voz alta, y no aporta a la respuesta.
 * Queda acá para que `/api/pc` pueda sumarlo al costo del turno si algún día se quiere
 * (ver el diff sugerido en el informe) y, mientras tanto, en el log de Railway.
 */
let ultimo: CostoWeb = { usd: 0, busquedas: 0, entrada: 0, salida: 0 };
export const costoDeLaUltimaBusqueda = (): CostoWeb => ultimo;

/**
 * La fila de `costos_llamadas`: una por sub-llamada, de la herramienta que sea.
 *
 * Existe porque los costos de `web` e `interpretar` morían en el console.log de
 * Railway: para contestar "¿cuánto gasté en consultas?" por voz (`costos_ver`),
 * tienen que estar en una tabla. Vive acá y no en un helper nuevo porque
 * razonar.ts ya importa de este archivo: cero imports nuevos que cuidar.
 *
 * Fuego y olvido, mismo espíritu que `logActivity` en db.ts: registrar un costo
 * JAMÁS puede voltear la consulta que lo generó. Los llamadores hacen
 * `void registrarCosto(...)` sin await, y si el insert falla se pierde una fila
 * de la contabilidad y nada más.
 */
export async function registrarCosto(
  sb: SupabaseClient,
  herramienta: "pensar" | "interpretar" | "web",
  modelo: string,
  usd: number,
  entrada: number,
  salida: number,
): Promise<void> {
  try {
    await sb.from("costos_llamadas").insert({
      herramienta,
      modelo,
      usd,
      tokens_entrada: Math.round(entrada),
      tokens_salida: Math.round(salida),
    });
  } catch { /* noop: mejor una fila menos en la cuenta que una consulta caída */ }
}

// ---------------------------------------------------------------------------
// El prompt de la sub-llamada
// ---------------------------------------------------------------------------

/**
 * Este prompt es corto porque el modelo tiene un solo trabajo, y es duro con el formato
 * porque el destino no es una pantalla: es un parlante. Una respuesta con viñetas, links
 * y "según Reuters (2026)" está bien escrita y es insoportable escuchada.
 */
const promptBusqueda = (hoy: string) => `Buscás en internet y contestás en UNA sola tanda.
Hoy es ${hoy}. Estás en Argentina.

Buscá lo que haga falta y después contestá la pregunta en DOS O TRES FRASES, como se lo
dirías a alguien de al lado. Tu texto lo va a leer un sintetizador de voz.

- Español argentino, voseo, tono directo.
- Sin links, sin citas, sin nombres de sitios, sin markdown, sin viñetas, sin emojis.
  Si un dato solo vale con la fuente ("lo dijo el Banco Central"), nombrala en la frase,
  en criollo, y nada más.
- Nada de "según los resultados de búsqueda" ni "encontré que": andá al dato.
- Los números decilos como se pronuncian: "un millón doscientos mil", no "$1.200.000".
- Si el dato tiene fecha y la fecha importa (un precio, un resultado, un horario), decila.
- Si no lo encontraste o las fuentes se contradicen, decilo en una frase. Inventar acá es
  peor que no saber: del otro lado no hay pantalla para verificar nada.`;

// ---------------------------------------------------------------------------
// Limpieza de la respuesta
// ---------------------------------------------------------------------------

/**
 * El prompt pide texto hablado y aun así vuelven links y asteriscos cuando la respuesta
 * tiene dos partes — pasa lo mismo en `run.ts`, que limpia el markdown a mano por esto.
 * Es determinístico, así que se arregla acá en vez de volver a pedírselo y pagar otra vuelta.
 */
export function paraDecir(t: string): string {
  const limpio = t
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")   // [texto](link) → texto
    .replace(/https?:\/\/\S+/g, "")            // URLs sueltas
    .replace(/\*\*|__|`+/g, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    // "Fuente: …" / "Fuentes: …" al final: es exactamente lo que no queremos que suene.
    .replace(/\n\s*fuentes?\s*:[\s\S]*$/i, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();

  // Tope duro de tres frases. El prompt ya las pide, pero cuando el tema es largo se
  // entusiasma, y en voz una frase de más es medio minuto de más.
  const frases = limpio.split(/(?<=[.!?])\s+/).filter(Boolean);
  return frases.length > 3 ? frases.slice(0, 3).join(" ") : limpio;
}

// ---------------------------------------------------------------------------
// La sub-llamada
// ---------------------------------------------------------------------------

type Bloque = { type: string; text?: string };

async function investigar(sb: SupabaseClient, pregunta: string): Promise<
  { ok: true; texto: string } | { ok: false; motivo: string }
> {
  const apiKey = await claveAnthropic(sb);
  const hoy = new Date().toLocaleDateString("es-AR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: ZONA,
  });
  const precio = PRECIOS[MODELO_WEB] ?? PRECIOS["claude-opus-5"];

  // Historial LOCAL: nace y muere en esta función. Acá adentro sí van los resultados
  // crudos de la búsqueda, porque el modelo los necesita para redactar; lo que no puede
  // pasar es que salgan de este scope.
  const mensajes: unknown[] = [{ role: "user", content: pregunta }];
  const costo: CostoWeb = { usd: 0, busquedas: 0, entrada: 0, salida: 0 };
  let texto = "";

  try {
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const ctrl = new AbortController();
      const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let data: {
        content?: Bloque[];
        stop_reason?: string;
        usage?: Record<string, number> & { server_tool_use?: { web_search_requests?: number } };
      };
      let ok = false;
      let status = 0;

      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: MODELO_WEB,
            // Dos o tres frases entran de sobra; el resto del techo es para las consultas
            // de búsqueda que genera en el camino. Un max_tokens alto acá solo habilita
            // que se vaya de tema y cueste más.
            max_tokens: 600,
            system: promptBusqueda(hoy),
            // La server tool: la búsqueda la ejecuta la API, no hay nada que programar
            // ni ningún loop de tool_result que atender de este lado.
            tools: [
              {
                type: "web_search_20250305",
                name: "web_search",
                max_uses: MAX_BUSQUEDAS,
                // Sin esto, "el clima" o "a qué hora abre" se responden desde donde
                // esté el datacenter, que es cualquier lado menos Argentina.
                user_location: { type: "approximate", country: "AR", timezone: ZONA },
              },
            ],
            messages: mensajes,
          }),
        });
        status = r.status;
        data = await r.json();
        ok = r.ok;
      } finally {
        clearTimeout(reloj);
      }

      if (!ok) {
        return { ok: false, motivo: `la API contestó ${status}` };
      }

      const u = data.usage ?? {};
      costo.entrada += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      costo.salida += u.output_tokens ?? 0;
      costo.busquedas += u.server_tool_use?.web_search_requests ?? 0;
      costo.usd +=
        ((u.input_tokens ?? 0) * precio.in +
          (u.output_tokens ?? 0) * precio.out +
          (u.cache_read_input_tokens ?? 0) * precio.cacheRead) / 1e6;

      const bloques = data.content ?? [];
      texto = bloques
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();

      // Cortó una búsqueda larga por la mitad: se le devuelve lo que lleva y sigue.
      // Cualquier otro stop_reason significa que ya terminó de hablar.
      if (data.stop_reason !== "pause_turn") break;
      mensajes.push({ role: "assistant", content: bloques });
    }
  } catch (e) {
    const abortado = e instanceof Error && e.name === "AbortError";
    return { ok: false, motivo: abortado ? "tardó demasiado" : mensajeDeError(e) };
  } finally {
    // El cargo por búsqueda se suma acá y no en el loop porque se cobra aunque la
    // llamada haya fallado después: una búsqueda que se cortó a la mitad igual se pagó.
    costo.usd += costo.busquedas * USD_POR_BUSQUEDA;
    ultimo = costo;
    // Sin await: la contabilidad no demora la respuesta (ver registrarCosto).
    void registrarCosto(sb, "web", MODELO_WEB, costo.usd, costo.entrada, costo.salida);
    console.log(
      `[web] ${costo.busquedas} búsqueda(s) · ${costo.entrada} in / ${costo.salida} out · ` +
        `US$ ${costo.usd.toFixed(4)} · ${MODELO_WEB}`,
    );
  }

  const dicho = paraDecir(texto);
  if (!dicho) return { ok: false, motivo: "no encontré nada que valga la pena" };
  return { ok: true, texto: dicho };
}

const mensajeDeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// La herramienta
// ---------------------------------------------------------------------------

export const investigarEnLaWeb: Tool = {
  name: "investigar_en_la_web",
  description:
    "Busca en internet algo que no sabés o que puede haber cambiado: noticias, resultados, " +
    "precios de cosas que no son suyas, horarios, clima, cómo se hace algo, quién es alguien. " +
    "Devuelve la respuesta YA REDACTADA para decir en voz alta: repetila tal cual. " +
    "Pasá la pregunta completa y entendible sola, no dos palabras sueltas. " +
    "NO la uses para su plata, sus tarjetas, sus deudas ni su agenda: para eso están las otras " +
    "herramientas, que leen sus datos reales. Tampoco para cosas que ya sabés: tarda unos " +
    "segundos y se paga aparte.",
  input_schema: {
    type: "object",
    properties: {
      pregunta: {
        type: "string",
        description:
          "La pregunta completa y autocontenida, en español. Si él dijo 'y mañana?' después " +
          "de preguntar por el clima, acá va 'qué clima va a hacer mañana en Buenos Aires'.",
      },
    },
    required: ["pregunta"],
  },
  // Por ahora solo la PC. En Telegram sumaría los schemas (y su costo) a cada consulta de
  // finanzas sin que nadie la haya pedido ahí.
  canales: ["pc"],
  async handler(sb, input) {
    const pregunta = String(input?.pregunta ?? "").trim();
    if (!pregunta) return { ok: false, motivo: "No me dijiste qué averiguar." };

    const r = await investigar(sb, pregunta);
    if (!r.ok) {
      return {
        ok: false,
        motivo: `No pude buscarlo: ${r.motivo}.`,
        que_hacer:
          "Decíselo en una frase y ofrecé volver a intentar. NUNCA contestes la pregunta " +
          "de memoria haciendo como que la buscaste.",
      };
    }

    // Lo único que cruza al hilo principal. Los resultados de búsqueda quedaron adentro
    // de `investigar` y ya no existen: si volvieran acá, se pagarían en cada turno siguiente.
    return {
      ok: true,
      respuesta: r.texto,
      nota:
        "Esto ya está buscado, verificado y escrito para decir en voz alta. Repetilo tal " +
        "cual o casi: no lo amplíes con lo que vos sepas, no agregues fuentes ni links, y " +
        "no cambies ningún número.",
    };
  },
};
