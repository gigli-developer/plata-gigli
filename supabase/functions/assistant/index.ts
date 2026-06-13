import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOOL_REGISTRAR = {
  name: "registrar_movimientos",
  description: "Registra los movimientos financieros (transacciones y/o deudas) detectados. Usar SOLO cuando tengas TODOS los datos claros (monto, categoria, metodo de pago).",
  input_schema: {
    type: "object",
    properties: {
      resumen: { type: "string", description: "Resumen breve y amable (1-2 frases) de lo que se va a registrar, en espanol argentino." },
      transacciones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tipo: { type: "string", enum: ["ingreso", "egreso"] },
            monto: { type: "number" },
            moneda: { type: "string", enum: ["ARS", "USD", "USDT"] },
            categoria: { type: "string" },
            metodo_pago: { type: "string" },
            descripcion: { type: "string" },
          },
          required: ["tipo", "monto", "moneda", "categoria", "metodo_pago", "descripcion"],
        },
      },
      deudas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            persona: { type: "string" },
            direccion: { type: "string", enum: ["me_deben", "debo"] },
            tipo: { type: "string", enum: ["cash", "split", "in_kind"] },
            monto: { type: "number" },
            moneda: { type: "string", enum: ["ARS", "USD", "USDT"] },
            descripcion: { type: "string" },
            total_dividido: { type: "number" },
            tu_parte: { type: "number" },
            participantes: { type: "number" },
          },
          required: ["persona", "direccion", "tipo", "monto", "moneda", "descripcion"],
        },
      },
    },
    required: ["resumen"],
  },
};

const TOOL_PREGUNTAR = {
  name: "preguntar_opciones",
  description: "Hace UNA pregunta corta al usuario para aclarar un dato que falta (metodo de pago, que se compro, etc.), ofreciendo opciones para elegir. Usar cuando falte informacion para registrar bien.",
  input_schema: {
    type: "object",
    properties: {
      pregunta: { type: "string", description: "La pregunta, corta y clara, en espanol argentino." },
      opciones: { type: "array", items: { type: "string" }, description: "2 a 4 opciones cortas para que el usuario elija." },
    },
    required: ["pregunta", "opciones"],
  },
};

// Precios Claude Sonnet (USD por millon de tokens)
const PRICE = { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { messages } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: secrets } = await sb.from("app_secrets").select("key,value");
    const S: Record<string, string> = Object.fromEntries((secrets ?? []).map((s: any) => [s.key, s.value]));
    const apiKey = S.ANTHROPIC_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "no_api_key" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });

    const [{ data: cats }, { data: pms }, { data: persons }, { data: cards }] = await Promise.all([
      sb.from("categories").select("name,kind").eq("is_archived", false).order("name"),
      sb.from("payment_methods").select("name").order("id"),
      sb.from("persons").select("name").order("name"),
      sb.from("cards").select("name,last4,network").eq("is_archived", false),
    ]);
    const egreso = (cats ?? []).filter((c: any) => c.kind === "egreso" || c.kind === "ambos").map((c: any) => c.name).join(", ");
    const ingreso = (cats ?? []).filter((c: any) => c.kind === "ingreso" || c.kind === "ambos").map((c: any) => c.name).join(", ");
    const pmNames = (pms ?? []).map((p: any) => p.name).join(", ");
    const personNames = (persons ?? []).map((p: any) => p.name).join(", ") || "(ninguna todavia)";
    const cardNames = (cards ?? []).map((c: any) => `${c.name} (..${c.last4})`).join(", ");

    const today = new Date().toLocaleDateString("es-AR", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Argentina/Buenos_Aires" });

    const SYS = `Sos el asistente financiero de una app personal de finanzas (un solo usuario, Argentina). Hoy es ${today}.
Tu trabajo es interpretar lo que el usuario cuenta en lenguaje natural y registrar los movimientos.

CATALOGOS (usa EXACTAMENTE estos nombres):
- Categorias de egreso: ${egreso}
- Categorias de ingreso: ${ingreso}
- Metodos de pago: ${pmNames}
- Personas conocidas: ${personNames}
- Tarjetas: ${cardNames}

REGLAS GENERALES:
- Si el usuario pago/gasto algo -> transaccion "egreso". Si cobro/recibio -> "ingreso".
- MONEDA: asumi PESOS (ARS) SIEMPRE, salvo que el usuario aclare explicitamente dolares (USD) o USDT.
- Gasto COMPARTIDO donde el usuario pago y otros le deben: registra el egreso por el total que pago, y ademas una deuda por cada persona con direccion "me_deben", tipo "split" (total_dividido = total, tu_parte = parte del usuario, participantes = total incluido el usuario; monto de cada deuda = lo que esa persona debe).
- Si el usuario le debe a alguien -> deuda "debo". Prestamo simple de plata -> tipo "cash".
- Si una persona no figura, igual usa su nombre (se creara).

PREGUNTAR ANTES DE REGISTRAR (importante):
- Si falta el METODO DE PAGO, NO lo adivines: usa la herramienta "preguntar_opciones" (ej: "Como lo pagaste?" con opciones Efectivo / Tarjeta de debito / Tarjeta de credito / Transferencia, segun el catalogo).
- Si la categoria es ambigua o la descripcion es muy generica (ej: "compre en el super" sin mas detalle, o algo que podria ser de varias categorias), pregunta con opciones para precisar.
- Si falta el MONTO, pregunta el monto (con preguntar_opciones podes ofrecer rangos o pedirlo libremente en la pregunta).
- Hace UNA pregunta por vez. Cuando ya tengas TODO claro, recien ahi usa "registrar_movimientos".
- Si el usuario ya aclaro todo en su mensaje, registra directo sin preguntar de mas.

Habla en espanol argentino, breve y calido. No inventes datos.`;

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: [{ type: "text", text: SYS, cache_control: { type: "ephemeral" } }],
      tools: [TOOL_REGISTRAR, TOOL_PREGUNTAR],
      messages: (messages ?? []).map((m: any) => ({ role: m.role, content: String(m.content ?? "") })),
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return new Response(JSON.stringify({ error: "anthropic", detail: data }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });

    let reply = "";
    let proposal: any = null;
    let options: string[] | null = null;
    for (const block of data.content ?? []) {
      if (block.type === "text") reply += block.text;
      if (block.type === "tool_use" && block.name === "registrar_movimientos") proposal = block.input;
      if (block.type === "tool_use" && block.name === "preguntar_opciones") { reply = block.input?.pregunta ?? reply; options = block.input?.opciones ?? null; }
    }
    if (proposal && !reply) reply = proposal.resumen ?? "Te propongo registrar esto:";

    const u = data.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const costUsd = ((u.input_tokens ?? 0) * PRICE.in + (u.output_tokens ?? 0) * PRICE.out + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) / 1e6;

    return new Response(JSON.stringify({ reply: reply.trim(), proposal, options, tokens, costUsd }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "exception", detail: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
