import { createServiceClient, loadSecrets } from "@/lib/supabase/service";
import { secretoOk, rechazoTemprano, NO_AUTORIZADO } from "@/lib/agent/canal";
import {
  correrAgente,
  MODELO_RAPIDO,
  MODELO_ANALISIS,
  type Turno,
} from "@/lib/agent/run";
import { nuevoTurno } from "@/lib/agent/propuestas";

/**
 * Canal PC del asistente.
 *
 * El agente local (Python, en la máquina de Lucas) manda acá lo que él dijo y recibe
 * el texto para leer en voz alta más, si corresponde, la acción a ejecutar.
 *
 * SEGURIDAD — esta ruta es pública, tiene el service role adentro y del otro lado hay
 * un proceso que ejecuta cosas en una máquina personal. Los cerrojos:
 *   1. Header `x-pc-secret` contra `app_secrets.PC_CHANNEL_SECRET`, comparado en tiempo
 *      constante. Sin eso no se llega ni a llamar al modelo (no se gasta un token).
 *   2. La acción que sale de acá es SIEMPRE `{tipo, valor}` con tipo de un enum cerrado
 *      y valor sacado de la tabla `targets`. Nunca un comando armado por el modelo.
 *
 * Por qué HTTP y no WebSocket, como estaba en el plan: los route handlers de Next no
 * pueden hacer el upgrade a WS sin un custom server, y eso cambiaría cómo se deploya
 * Plata entera. Con pedido/respuesta alcanza — la PC sigue abriendo la conexión hacia
 * afuera y no expone ningún puerto. Si más adelante el servidor necesita empujar algo
 * sin que se lo pidan, se agrega un SSE, que sí funciona en un route handler.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Un solo interlocutor: la PC de Lucas. Mismo criterio que Telegram — el historial vive
// en memoria del proceso, se pierde en cada deploy y caduca solo.
const HISTORIAL = { turnos: [] as Turno[], ultimo: 0 };
const TTL_MS = 30 * 60 * 1000;
const MAX_TURNOS = 8;

/**
 * Ruteo de modelo por REGLA, no preguntándole a un modelo cuál usar (eso ya costaría
 * una llamada).
 *
 * ⚠️ La regla está INVERTIDA respecto de lo obvio, y es a propósito. Medido el
 * 12/08/2026 de punta a punta: la misma consulta tarda **2,98 s con Haiku y 8,17 s
 * con Sonnet**, y el modelo es el 79% de toda la latencia del canal. Como las
 * herramientas devuelven conclusiones YA CALCULADAS (regla de oro del proyecto),
 * en la enorme mayoría de las consultas el modelo solo tiene que redactar un
 * número que ya viene resuelto — y para eso Haiku sobra.
 *
 * Sonnet queda para lo que de verdad pide razonar: comparar, proyectar, explicar,
 * recomendar. Si una respuesta sale pobre, se agrega el verbo acá.
 */
const ANALISIS =
  /\b(analiz|compar|proyect|convien|deber[ií]a|por qu[eé]|explic|recomend|sugerenc|estrategia|tendencia|evoluci[oó]n|balance|alcanza|llego a fin|me rinde|vale la pena|qu[eé] opin|pens[aá]s)/i;
const elegirModelo = (texto: string) => (ANALISIS.test(texto) ? MODELO_ANALISIS : MODELO_RAPIDO);

export async function POST(request: Request) {
  // Rechazo antes de tocar la base. Sin esto, una request sin secreto igual
  // disparaba un SELECT a app_secrets: superficie de gasto para nada.
  if (rechazoTemprano(request)) return NO_AUTORIZADO;

  const sb = createServiceClient();

  let secrets: Record<string, string>;
  try {
    secrets = await loadSecrets(sb);
  } catch (e) {
    console.error("pc/app_secrets", e);
    return Response.json({ error: "no pude leer la config" }, { status: 500 });
  }

  const esperado = secrets.PC_CHANNEL_SECRET;
  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!esperado || !apiKey) {
    console.error("Faltan PC_CHANNEL_SECRET o ANTHROPIC_API_KEY en app_secrets");
    return Response.json({ error: "no configurado" }, { status: 500 });
  }

  if (!secretoOk(request.headers.get("x-pc-secret"), esperado)) {
    return Response.json({ error: "no" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  // Techo duro: lo que entra se paga por token y el historial lo reenvía en cada
  // vuelta. Sin esto, un body grande (o un bucle del cliente) es una factura fea.
  const texto = String(body?.texto ?? "").trim().slice(0, 2000);
  if (!texto) return Response.json({ error: "texto vacío" }, { status: 400 });

  // Abre un turno nuevo: `agenda_confirmar` no puede ejecutar una propuesta
  // creada en esta misma request (ver propuestas.ts).
  nuevoTurno();

  const pendiente =
    String(body?.propuesta_pendiente ?? "").trim().toLowerCase().slice(0, 8) || undefined;

  // `reset` desde el cliente arranca conversación nueva sin esperar el TTL.
  if (body?.reset) HISTORIAL.turnos = [];

  const vigente = Date.now() - HISTORIAL.ultimo <= TTL_MS;
  const previos = vigente ? HISTORIAL.turnos : [];
  const turnos: Turno[] = [...previos, { role: "user", content: texto }];

  try {
    const r = await correrAgente(sb, apiKey, turnos, {
      canal: "pc",
      modelo: elegirModelo(texto),
      propuestaPendiente: pendiente,
    });

    const completos: Turno[] = [...turnos, { role: "assistant", content: r.texto }];
    HISTORIAL.turnos = completos.slice(-MAX_TURNOS);
    HISTORIAL.ultimo = Date.now();

    return Response.json({
      texto: r.texto,
      acciones: r.acciones,
      propuestas: r.propuestas,
      paneles: r.paneles,
      costoUsd: Number(r.costoUsd.toFixed(6)),
      modelo: elegirModelo(texto),
      toolsUsadas: r.toolsUsadas,
      // Diagnóstico: qué propuesta pendiente recibió el servidor en esta request,
      // y con qué argumentos llamó cada herramienta. No cuesta tokens (nunca va al
      // modelo) y es lo único que permite ver desde afuera si pidió el rango correcto.
      pendienteRecibida: pendiente ?? null,
      llamadas: r.llamadas,
      numerosCorregidos: r.numerosCorregidos,
      cache: r.cache,
    });
  } catch (e) {
    console.error("pc/agente", e);
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
