import { createServiceClient, loadSecrets } from "@/lib/supabase/service";
import { correrAgente, type Turno } from "@/lib/agent/run";

/**
 * Webhook del bot de Telegram.
 *
 * SEGURIDAD — esta ruta es pública y con el service role adentro lee toda la base,
 * así que tiene dos cerrojos y los dos tienen que pasar:
 *   1. El header `X-Telegram-Bot-Api-Secret-Token` (lo manda Telegram si lo configuraste
 *      en setWebhook). Sin esto, cualquiera que descubra la URL consulta tus finanzas.
 *   2. El `chat_id` contra TELEGRAM_CHAT_ID. Aunque alguien encuentre el bot por su
 *      @usuario y le escriba, no pasa de acá.
 *
 * Los secrets viven en `app_secrets`, igual que los de las Edge Functions.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TG = "https://api.telegram.org";

// Historial por chat, en memoria del proceso. Se pierde en cada deploy y es a propósito:
// para consultas sueltas alcanza y evita arrastrar contexto viejo (que además se paga).
const HISTORIAL = new Map<number, { turnos: Turno[]; ultimo: number }>();
const TTL_MS = 30 * 60 * 1000; // media hora sin hablar y arranca de cero
const MAX_TURNOS = 8;

function historialDe(chatId: number): Turno[] {
  const h = HISTORIAL.get(chatId);
  if (!h || Date.now() - h.ultimo > TTL_MS) return [];
  return h.turnos;
}

function guardarHistorial(chatId: number, turnos: Turno[]) {
  HISTORIAL.set(chatId, { turnos: turnos.slice(-MAX_TURNOS), ultimo: Date.now() });
}

async function telegram(token: string, metodo: string, body: Record<string, unknown>) {
  const r = await fetch(`${TG}/bot${token}/${metodo}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error(`telegram/${metodo}`, r.status, await r.text().catch(() => ""));
  return r;
}

/** Baja el audio del mensaje de voz y lo transcribe con Whisper (Groq). */
async function transcribir(token: string, groqKey: string, fileId: string): Promise<string> {
  const info = await fetch(`${TG}/bot${token}/getFile?file_id=${fileId}`).then((r) => r.json());
  const path = info?.result?.file_path;
  if (!path) throw new Error("Telegram no devolvió el archivo del audio");

  const audio = await fetch(`${TG}/file/bot${token}/${path}`);
  if (!audio.ok) throw new Error(`No pude bajar el audio (${audio.status})`);

  const form = new FormData();
  form.append("file", await audio.blob(), "audio.ogg");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "es");

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqKey}` },
    body: form,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Transcripción falló: ${JSON.stringify(data).slice(0, 200)}`);
  return String(data.text ?? "").trim();
}

/**
 * El trabajo pesado. Va fuera del ciclo de request: Telegram reintenta el update si
 * tarda, y una consulta con herramientas puede irse a 10-15 segundos.
 */
async function procesar(chatId: number, texto: string, token: string) {
  const sb = createServiceClient();
  try {
    const secrets = await loadSecrets(sb);
    const apiKey = secrets.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Falta ANTHROPIC_API_KEY en app_secrets");

    const previos = historialDe(chatId);
    const turnos: Turno[] = [...previos, { role: "user", content: texto }];

    const { texto: respuesta, costoUsd } = await correrAgente(sb, apiKey, turnos);

    guardarHistorial(chatId, [...turnos, { role: "assistant", content: respuesta }]);

    // El costo va como cita al pie: se ve chiquito y te deja controlar el gasto real.
    await telegram(token, "sendMessage", {
      chat_id: chatId,
      text: `${respuesta}\n\n<i>US$ ${costoUsd.toFixed(4)}</i>`,
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("agente", e);
    await telegram(token, "sendMessage", {
      chat_id: chatId,
      text: `Se me rompió algo: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export async function POST(request: Request) {
  const sb = createServiceClient();

  let secrets: Record<string, string>;
  try {
    secrets = await loadSecrets(sb);
  } catch (e) {
    console.error("app_secrets", e);
    return new Response("error", { status: 500 });
  }

  const token = secrets.TELEGRAM_BOT_TOKEN;
  const secretHeader = secrets.TELEGRAM_WEBHOOK_SECRET;
  const chatPermitido = Number(secrets.TELEGRAM_CHAT_ID);
  const groqKey = secrets.GROQ_API_KEY;

  if (!token || !secretHeader || !chatPermitido) {
    console.error("Faltan secrets de Telegram en app_secrets");
    return new Response("no configurado", { status: 500 });
  }

  // Cerrojo 1: el secreto que Telegram repite en cada update.
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secretHeader) {
    return new Response("no", { status: 401 });
  }

  const update = await request.json().catch(() => null);
  const msg = update?.message;
  const chatId = Number(msg?.chat?.id);

  // Cerrojo 2: solo tu chat. A cualquier otro no se le contesta ni que existe el bot.
  if (!msg || chatId !== chatPermitido) return new Response("ok");

  // A partir de acá siempre se devuelve 200: si respondemos error, Telegram reintenta
  // el mismo update en loop y se paga la consulta varias veces.
  try {
    let texto: string = msg.text ?? "";

    if (msg.voice || msg.audio) {
      if (!groqKey) {
        await telegram(token, "sendMessage", { chat_id: chatId, text: "Falta GROQ_API_KEY para transcribir audios." });
        return new Response("ok");
      }
      await telegram(token, "sendChatAction", { chat_id: chatId, action: "typing" });
      texto = await transcribir(token, groqKey, (msg.voice ?? msg.audio).file_id);
      if (!texto) {
        await telegram(token, "sendMessage", { chat_id: chatId, text: "No le entendí nada al audio, probá de nuevo." });
        return new Response("ok");
      }
    }

    if (!texto.trim()) return new Response("ok");

    if (texto.trim() === "/start" || texto.trim() === "/ayuda") {
      await telegram(token, "sendMessage", {
        chat_id: chatId,
        text:
          "Preguntame por tus finanzas, en texto o por audio. Por ejemplo:\n\n" +
          "· cómo estoy de plata\n" +
          "· qué pagos tengo los próximos meses\n" +
          "· llego a fin de mes\n" +
          "· en qué gasté más este mes\n" +
          "· quién me debe plata",
      });
      return new Response("ok");
    }

    await telegram(token, "sendChatAction", { chat_id: chatId, action: "typing" });

    // Sin await: Railway mantiene el proceso vivo, así Telegram recibe el 200 al toque.
    void procesar(chatId, texto, token);
  } catch (e) {
    console.error("webhook", e);
    await telegram(token, "sendMessage", {
      chat_id: chatId,
      text: `Se me rompió algo: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return new Response("ok");
}
