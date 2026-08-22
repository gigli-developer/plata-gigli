import type { SupabaseClient } from "@supabase/supabase-js";
import { schemasPara, toolPorNombre, ejecutarTool, type Canal, type Accion } from "./tools";
import { descartar, existe, edadEnTurnos } from "./propuestas";
import { numerosSinRespaldo, candidatosPara } from "./numeros";

/** Precios en USD por millón de tokens. Si cambian, se toca acá y nada más. */
const PRECIOS: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  "claude-sonnet-5": { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * Los modelos salen de variables de entorno para poder cambiarlos sin deployar.
 * Si el que se elige no está en PRECIOS, el costo se calcula con el de análisis:
 * queda sobreestimado, que es el lado seguro para equivocarse.
 */
export const MODELO_ANALISIS = process.env.AGENT_MODEL ?? "claude-sonnet-5";
export const MODELO_RAPIDO = process.env.AGENT_MODEL_RAPIDO ?? "claude-haiku-4-5-20251001";
const MODELO_POR_DEFECTO = MODELO_ANALISIS;

// Techo de seguridad: cada vuelta es una llamada paga. Con 5 herramientas de lectura
// nunca hacen falta más de 3 ó 4; el corte evita que un bucle raro vacíe la cuenta.
const MAX_VUELTAS = 5;

export type Turno = { role: "user" | "assistant"; content: string };

export type Respuesta = {
  texto: string;
  costoUsd: number;
  toolsUsadas: string[];
  /**
   * Lo mismo pero con los argumentos, para diagnóstico. No se le manda al modelo
   * ni cuesta tokens: sirve para ver, desde afuera, si pidió el rango de fechas
   * que correspondía. Sin esto, un total equivocado no se distingue de una
   * herramienta mal llamada.
   */
  llamadas: { tool: string; input: Record<string, unknown> }[];
  /**
   * Números que dijo y no salían de ninguna herramienta. Si esto no viene vacío,
   * la respuesta se rehízo (ver el chequeo al final de `correrAgente`). Sirve para
   * medir cada cuánto pasa.
   */
  numerosCorregidos: number[];
  /**
   * Tokens que se leyeron del caché contra los que se pagaron enteros.
   *
   * Está acá porque el `CLAUDE.md` afirma que el `cache_control` **no** está
   * funcionando —el prefijo cacheable rondaba los 1.200 tokens y el mínimo de Haiku
   * es 2.048—, y esa nota es de cuando había 9 herramientas. Con 21 el prefijo pasó
   * los 5.000, así que debería estar pegando. Es una diferencia de 12x en el precio
   * de la entrada, o sea la mitad de la factura del canal: mejor medirlo que suponerlo.
   */
  cache: { leidos: number; escritos: number; sinCachear: number };
  vueltas: number;
  /** Lo que el canal PC tiene que ejecutar. Siempre vacío en Telegram. */
  acciones: Accion[];
  /**
   * Cambios propuestos y no ejecutados, para que la interfaz muestre cómo
   * quedaría antes de que el usuario confirme.
   */
  propuestas: Propuesta[];
  /**
   * Datos para dibujar en pantalla. NO se le mandan al modelo: él ya recibió su
   * resumen. Esto es el detalle que se ve, no el que se razona.
   */
  paneles: Panel[];
};

/** Lo que la interfaz sabe dibujar. */
export type Panel =
  | {
      tipo: "agenda";
      rango: { desde: string; hasta: string };
      dias: {
        fecha: string;
        dia: string;
        eventos: { id: string; titulo: string; hora: string; lugar?: string }[];
        huecos: { desde: string; hasta: string }[];
      }[];
    }
  | {
      tipo: "tarjetas";
      resumenes: { tarjeta: string; periodo: string; vence: string; total: number }[];
      cuotas: { que: string; monto: number; va_por: string; quedan: number }[];
    }
  | {
      tipo: "transacciones";
      rango: { desde: string; hasta: string };
      totales: { egresos: number; ingresos: number; resultado: number; no_gasto?: number };
      movimientos: {
        id: number; que: string; emoji: string; categoria: string; metodo: string;
        monto: number; moneda: string; ars: number;
        tipo: "ingreso" | "egreso"; cuando: string; dia: string;
      }[];
    }
  | {
      tipo: "resumen";
      fecha: string;
      hoy: {
        gasto: number; ingreso: number; promedio: number;
        movimientos: {
          que: string; emoji: string; categoria: string;
          monto: number; moneda: string; ars: number;
        }[];
      };
      mes: { cual: string; gastado: number; proyectado: number; anterior: number };
      novedades: {
        que: string; monto: number; moneda: string; con: string; cuando: string; ars: number;
      }[];
      tarjetas: {
        tarjeta: string; periodo: string; vence: string; en_dias: number; total_ars: number;
      }[];
      alertas: string[];
      agenda: { hoy: string[]; manana: string[] };
    }
  | {
      // El clima con horas. `horas` son las próximas 8 (hora como "17"),
      // `dias` hasta 3 (dia como "jue"). Lo arma `clima` en mundo.ts.
      tipo: "clima";
      lugar: string;
      ahora: { temperatura: number; sensacion: number; humedad_pct: number; cielo: string };
      horas: { hora: string; temp: number; lluvia_pct: number }[];
      dias: { dia: string; min: number; max: number; lluvia_pct: number; cielo: string }[];
      /** "llueve de 20 a 22 · 70%" si alguna hora próxima pasa el 50%; si no, null. */
      aviso_lluvia: string | null;
    }
  | {
      // Las tareas de Google Tasks, vencidas primero. Lo arma `tareas_ver` en tasks.ts.
      tipo: "tareas";
      listas: {
        nombre: string;
        tareas: { titulo: string; vence: string | null; nota: string | null }[];
      }[];
    };

/** Previsualización de un cambio pendiente. `antes`/`despues` son null según el tipo. */
export type Propuesta = {
  id: string;
  /**
   * Sobre qué es. La interfaz lo necesita para preguntar bien: la tarjeta decía
   * **"¿lo agendo?"** también cuando lo que se iba a hacer era cargar un gasto,
   * porque el rótulo se elegía sólo por el tipo y la agenda fue el primer dominio.
   */
  dominio?: "agenda" | "plata" | "codigo" | "tarea";
  tipo: "crear" | "editar" | "borrar";
  antes: { titulo: string; cuando: string; lugar?: string; nota?: string } | null;
  despues: { titulo: string; cuando: string; lugar?: string; nota?: string } | null;
  /**
   * Varios eventos en una sola propuesta. Existe para no obligar al usuario a
   * confirmar de a uno cuando pide borrar tres cosas.
   */
  lista?: { titulo: string; cuando: string }[];
};

export type Opciones = {
  /** Por defecto "telegram", para no cambiarle nada al webhook que ya existe. */
  canal?: Canal;
  modelo?: string;
  /**
   * Id de una propuesta que quedó esperando confirmación en el turno anterior.
   *
   * Hace falta porque el historial que se persiste entre requests es solo texto:
   * los bloques `tool_result` —donde vive el id— se descartan al terminar. Sin
   * esto, cuando el usuario dice "sí" el modelo no tiene ningún id que pasarle a
   * `agenda_confirmar`, y termina inventando uno o re-proponiendo.
   *
   * Lo manda de vuelta el cliente, que ya lo tiene porque dibuja la tarjeta.
   */
  propuestaPendiente?: string;
};

/**
 * El prompt del canal PC es otro texto, no una variante del de Telegram: se
 * escucha en vez de leerse y puede abrir cosas. El de Telegram queda intacto.
 */
const promptPc = (hoy: string) => `Sos el asistente personal de Lucas, que vive en Argentina.
Hoy es ${hoy}.

Corrés en su PC con Windows. Él te habla y tu respuesta se lee en voz alta por los parlantes.

Podés ABRIR cosas en la máquina con la herramienta \`abrir\`: le pasás el alias tal como él lo
nombró ("spotify", "chrome"), nunca una ruta ni una URL. Si el alias no existe, la herramienta
te lo dice: avisale con naturalidad y ofrecé registrarlo. NUNCA inventes una ruta ni des por
hecho que algo se abrió si la herramienta no lo confirmó.

También tenés herramientas para consultar sus finanzas reales (app "Plata"). Usalas siempre que
la pregunta toque plata: NUNCA inventes ni estimes un número que podés consultar.

ESCRIBIR SE CONFIRMA, SIEMPRE — vale para la agenda y para la plata:
- \`agenda_cambiar\` y \`plata_registrar\` NO ejecutan nada: arman una propuesta y te devuelven
  cómo quedaría. Decile qué va a pasar y esperá que confirme. Recién ahí llamás \`confirmar\`
  con el id de la propuesta. Si dice que no, cancelar=true.
- Nunca digas que agendaste, cargaste, cambiaste o borraste algo si no llamaste a \`confirmar\`
  y te devolvió \`ok: true\`. Una propuesta NO es un cambio hecho.
- Si te pide sacar VARIOS eventos, pasá todos los ids juntos en \`evento_ids\`: una sola
  propuesta y una sola confirmación, en vez de hacerlo pasar por una por una. Con los
  movimientos de plata es igual: \`transaccion_ids\`.
- ⚠️ Si te CORRIGE un dato mientras hay una propuesta esperando ("mejor que sean quince
  mil", "no, el viernes"), volvé a llamar la herramienta con los datos nuevos. Decir
  "perfecto, quince mil" y nada más NO cambia nada: la propuesta guardada sigue teniendo
  los datos viejos, y si después confirma se ejecuta lo que él ya descartó.
- Nunca te quedes preguntando sin proponer. Si falta un dato menor (el medio de pago, la
  hora), PROPONÉ igual con lo que tenés y aclarale qué quedó vacío en la misma frase: él
  confirma o te lo completa. Repreguntar sin llamar a la herramienta lo deja trabado, y
  encima la propuesta que quedó guardada es la vieja.
- Si te pide cargar un gasto, tu PRIMERA acción es \`plata_registrar\`. Siempre, aunque
  falte la categoría o el medio de pago: la herramienta los acepta vacíos. Contestar
  pidiendo datos antes de proponer nada es la forma más segura de que no se cargue.
- Las tareas de código son igual: \`tarea_codigo_dictar\` NO lanza nada. Vos expandís lo que
  te dijo en criollo a una consigna clara y autocontenida, se la LEÉS —el repo, los archivos
  y la consigna, tal cual— y esperás que confirme. Recién ahí \`tarea_codigo_lanzar\`. Los
  nombres de archivo se transcriben mal, y leérselos es el único momento en que eso se atrapa.
- ⚠️ **El monto que te dice es el monto. No lo discutas ni lo "corrijas".** Si te dice
  siete mil quinientos de transporte, son siete mil quinientos: no es tu trabajo decidir
  si un gasto es plausible, y cambiarlo por lo que a vos te parece —pasó: propuso 750 en
  vez de 7.500— es meterle un dato falso a la base. Si te llama la atención, cargalo como
  te lo dijo y comentáselo DESPUÉS.

LO QUE NO PODÉS HACER — decilo en vez de improvisar:
- **Deudas: solo lectura.** No hay herramienta para registrar un pago ni para saldar una
  deuda. Si te dice "fulano me pagó", decile que eso lo tiene que cargar él en Plata. Nunca
  afirmes que una deuda quedó saldada, y nunca inventes el saldo nuevo.
- Si no tenés una herramienta para algo, decí que no podés. **Nunca calcules un total de
  cabeza**: si necesitás la suma de dos períodos, pedí el rango completo a la herramienta.

LEER es libre, no hace falta confirmar nada:
- \`agenda_ver\` para la agenda y los ratos libres.
- \`transacciones_ver\` para los movimientos de un día o un período.
- Los dos sirven además para conseguir el id de algo antes de editarlo o borrarlo.
- ⚠️ Si CUALQUIER herramienta te devuelve \`ok: false\`, la acción NO se hizo. Decí qué pasó
  y qué hace falta. Anunciar un éxito que no ocurrió es el peor error posible acá: el usuario
  se queda creyendo que tiene algo agendado que no existe.
- Al proponer, mencioná lo importante en una frase: qué, qué día y a qué hora. La pantalla
  ya le muestra el detalle, no se lo leas entero.

CÓMO RESPONDER:
- Te escuchan, no te leen. Una o dos frases. Nada de listas, tablas, markdown ni emojis.
- Español argentino, voseo, tono directo y tranquilo.
- Los montos vienen calculados en las herramientas: repetilos tal cual, no los recalcules
  ni los sumes entre sí. Si necesitás un total que no vino, pedí la herramienta que lo tenga.
- Decí los números como se pronuncian: "un millón doscientos mil" mejor que "$1.200.000".
- Si una herramienta devuelve "nota" o "supuestos", tenelo en cuenta; mencionalo solo si
  cambia la conclusión.
- Si algo falla o no tenés el dato, decilo derecho. Nunca rellenes con un número inventado.`;

const promptTelegram = (hoy: string) => `Sos el asistente personal de Lucas, que vive en Argentina.
Hoy es ${hoy}.

Tenés herramientas para consultar sus finanzas reales (app "Plata"). Usalas siempre que la
pregunta toque plata: NUNCA inventes ni estimes un número que podés consultar.

CÓMO RESPONDER:
- Estás hablando por Telegram, muchas veces desde el celular y a veces por audio. Sé breve:
  2 o 3 frases, o una lista corta. Nada de tablas ni informes largos.
- Español argentino, voseo, tono directo y tranquilo. Sin emojis salvo que aporten.
- Los montos vienen calculados en las herramientas: repetilos tal cual, no los recalcules
  ni los sumes entre sí. Si necesitás un total que no vino, pedí la herramienta que lo tenga.
- Formato de plata: "$1.234.567" para pesos, "US$ 1.234" para dólares. Redondeá a miles
  cuando el número es grande y la precisión no cambia la respuesta.
- Si una herramienta devuelve un campo "nota" o "supuestos", tenelo en cuenta: son las
  limitaciones del dato. Mencionalas solo si cambian la conclusión.
- Si la pregunta no tiene que ver con plata, respondé normal sin usar herramientas.
- Si algo falla o no tenés el dato, decilo derecho. Nunca rellenes con un número inventado.`;

const systemPrompt = (hoy: string, canal: Canal) =>
  canal === "pc" ? promptPc(hoy) : promptTelegram(hoy);

// ---------------------------------------------------------------------------
// Aceptación del usuario
//
// El fallo más caro que quedaba: había una propuesta esperando, el usuario decía
// "sí, dale", y el modelo —en vez de llamar `confirmar`— volvía a proponer lo
// mismo. Resultado: propuesta nueva, la vieja huérfana, y nada escrito. El
// guardrail de más abajo evita que MIENTA, pero recién se arregla al turno
// siguiente: el usuario tiene que decir "sí" dos veces.
//
// Se resuelve mirando lo que dijo ÉL, no lo que el modelo decidió hacer. Si el
// último mensaje del usuario es una aceptación limpia y hay una propuesta viva,
// la re-propuesta se intercepta y se le devuelve al modelo un resultado que lo
// manda a `confirmar`. Se corrige dentro del mismo turno.
//
// El reconocimiento es DELIBERADAMENTE conservador: aceptación corta, sin matices.
// "sí, pero mejor el viernes" es una corrección, no un sí, y ahí re-proponer es
// exactamente lo correcto. Cuando duda, no intercepta: el peor caso es el de
// antes, que ya está cubierto.
const ACEPTA =
  /^(?:s[ií]+|dale|ok|okey|oka|claro|obvio|listo|correcto|exacto|perfecto|joya|barbaro|de una|va|vale|hacelo|confirma|confirmalo|confirmamelo|procede|adelante|afirmativo|por supuesto|asi es|tal cual|sip|bueno|anotalo|cargalo|borralo|guardalo|agendalo)\b/;

/** Todo lo que convierte un "sí" en otra cosa. Si aparece, no es una aceptación. */
const MATIZA = /\b(pero|mejor|en vez|cambi|corrig|salvo|aunque|espera|par[aá]|no)\b/;

const sinTildes = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[¿?¡!.,;:]/g, " ").replace(/\s+/g, " ").trim();

function esAceptacion(texto: string): boolean {
  const t = sinTildes(texto);
  if (!t || t.split(" ").length > 5) return false;   // largo = está diciendo otra cosa
  return ACEPTA.test(t) && !MATIZA.test(t);
}

/** Las que arman una propuesta en vez de ejecutar. */
const PROPONEN = new Set([
  "plata_registrar", "agenda_cambiar",
  // Las tres de `acciones-plata.ts`: proponen igual, y necesitan las mismas
  // redes (no confirmar una propuesta vieja, no confirmar una corrección).
  "deuda_pagar", "cuotas_convertir", "divisas_registrar",
  // Escribe un archivo en el disco de la PC: mismas redes que las de plata.
  "cerebro_anotar",
  // Escribe en Google Tasks: propone igual que la agenda.
  "tareas_cambiar",
]);

/**
 * Un "sí" a secas, sin decir a qué.
 *
 * Distinguirlo importa por este caso, medido: propuso cargar $12.000, el usuario
 * preguntó a cuánto estaba el dólar, y al mensaje siguiente dijo "sí" — y se
 * cargaron los $12.000. Nadie diría que ese "sí" era para el gasto: la
 * conversación ya se había ido a otro lado. Un "sí, cargalo" sí lo sería.
 *
 * Así que la regla queda: un sí PELADO solo confirma la propuesta del turno
 * inmediatamente anterior. Si pasó más, hay que nombrar qué se confirma.
 */
const SI_PELADO = /^(?:s[ií]+|dale|ok|okey|oka|claro|obvio|listo|va|vale|sip|bueno|perfecto|joya)$/;

function esSiPelado(texto: string): boolean {
  const partes = sinTildes(texto).split(" ").filter(Boolean);
  return partes.length > 0 && partes.length <= 2 && partes.every((p) => SI_PELADO.test(p));
}

/**
 * ¿Te está corrigiendo un dato? Entonces no está confirmando nada.
 *
 * Medido: propuso cargar $9.000, el usuario dijo **"pará, mejor que sean quince
 * mil"**, y el modelo —en la misma vuelta— llamó `confirmar` sobre la propuesta
 * vieja Y armó una nueva por 15.000. Quedaron cargados los 9.000: exactamente el
 * número que el usuario acababa de descartar, y encima sin que dijera que sí.
 *
 * Es más específico que `MATIZA` a propósito: acá alcanza con no confundir un
 * "pará" o un "mejor" con una aceptación, y no se puede usar cualquier palabra
 * suelta ("para" aparece en media conversación) sin romper confirmaciones buenas.
 */
const CORRIGE =
  /(?:^par[aá]\b|^esper[aá]\b|\bpero\b|\bmejor\b|\ben vez\b|\ben lugar\b|\bcambi[aá]\b|\bcorreg[ií]|\bme equivoqu|\bmentira\b|\bnada de\b|^no\b)/;

const esCorreccion = (texto: string) => CORRIGE.test(sinTildes(texto));

/**
 * Corre una consulta contra Claude, resolviendo las herramientas que pida.
 *
 * El system prompt va con cache_control, y **el caché está pegando**: medido el
 * 14/08/2026, después de la primera consulta el 94% de la entrada sale del caché
 * (16.792 leídos contra ~1.050 nuevos) y el costo cae de US$ 0,0126 a US$ 0,0031.
 * Este comentario decía lo contrario, de cuando había 9 herramientas y el prefijo no
 * llegaba al mínimo de 2.048 de Haiku; hoy son 23 y lo pasa cómodo. (Si volvés a
 * contarlas y no da 23, el número de acá quedó viejo, no el argumento.)
 *
 * ⚠️ Por eso NO conviene filtrar la lista de herramientas según la consulta: cambiar
 * los `tools` cambia el prefijo y tira el caché, y reescribirlo cuesta ~100 veces más
 * que los schemas que uno se ahorra de mandar. La lista estable es la optimización.
 */
export async function correrAgente(
  sb: SupabaseClient,
  apiKey: string,
  historial: Turno[],
  opciones: Opciones = {},
): Promise<Respuesta> {
  const canal: Canal = opciones.canal ?? "telegram";
  const modelo = opciones.modelo ?? MODELO_POR_DEFECTO;
  const hoy = new Date().toLocaleDateString("es-AR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  });

  const mensajes: unknown[] = historial.map((t) => ({ role: t.role, content: t.content }));
  const precio = PRECIOS[modelo] ?? PRECIOS[MODELO_POR_DEFECTO];
  const tools = schemasPara(canal);
  const toolsUsadas: string[] = [];
  const llamadas: { tool: string; input: Record<string, unknown> }[] = [];
  const acciones: Accion[] = [];
  const propuestas: Propuesta[] = [];
  const paneles: Panel[] = [];
  let costoUsd = 0;
  let texto = "";
  let vueltas = 0;
  /** Todo lo que devolvieron las herramientas, para poder chequear los números. */
  const crudos: unknown[] = [];
  const cache = { leidos: 0, escritos: 0, sinCachear: 0 };

  // ¿Lo último que dijo el usuario fue un "sí" a la propuesta que quedó abierta?
  const ultimoDelUsuario = [...historial].reverse().find((t) => t.role === "user")?.content ?? "";
  const acepto = Boolean(opciones.propuestaPendiente) && esAceptacion(ultimoDelUsuario);
  const siPelado = esSiPelado(ultimoDelUsuario);
  const corrige = esCorreccion(ultimoDelUsuario);

  while (vueltas < MAX_VUELTAS) {
    vueltas++;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: 1200,
        // Dos bloques: el fijo (cacheable) y el variable. Así lo que cambia de
        // turno a turno no invalida el prefijo cacheado.
        system: [
          { type: "text", text: systemPrompt(hoy, canal), cache_control: { type: "ephemeral" } },
          ...(opciones.propuestaPendiente
            ? [{
                type: "text",
                text:
                  `HAY UNA PROPUESTA ESPERANDO RESPUESTA, id "${opciones.propuestaPendiente}".\n` +
                  `Si el usuario la acaba de aceptar ("sí", "dale", "confirmá", "hacelo"):\n` +
                  `  · Tu ÚNICA herramienta debe ser confirmar con propuesta_id="${opciones.propuestaPendiente}".\n` +
                  `  · NO vuelvas a proponer lo mismo. La propuesta YA existe; proponerla de\n` +
                  `    nuevo crea otra distinta y la confirmación falla.\n` +
                  `Si la rechazó, confirmar con cancelar=true. Si cambió de tema, ignorala.`,
              }]
            : []),
        ],
        tools,
        messages: mensajes,
      }),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);

    const u = data.usage ?? {};
    costoUsd +=
      ((u.input_tokens ?? 0) * precio.in +
        (u.output_tokens ?? 0) * precio.out +
        (u.cache_creation_input_tokens ?? 0) * precio.cacheWrite +
        (u.cache_read_input_tokens ?? 0) * precio.cacheRead) / 1e6;
    cache.leidos += u.cache_read_input_tokens ?? 0;
    cache.escritos += u.cache_creation_input_tokens ?? 0;
    cache.sinCachear += u.input_tokens ?? 0;

    const bloques = data.content ?? [];
    texto = bloques.filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text).join("").trim();

    const pedidos = bloques.filter((b: { type: string }) => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || pedidos.length === 0) break;

    // Ejecutar las herramientas pedidas.
    const salidas = await Promise.all(
      pedidos.map(async (p: { id: string; name: string; input: Record<string, unknown> }) => {
        toolsUsadas.push(p.name);
        llamadas.push({ tool: p.name, input: p.input ?? {} });

        // Un "sí" pelado no puede ejecutar una propuesta de hace varios turnos:
        // la conversación ya siguió y no se sabe a qué le está diciendo que sí.
        if (p.name === "confirmar" && !(p.input ?? {}).cancelar) {
          const id = String((p.input ?? {}).propuesta_id ?? "").trim().toLowerCase();
          const edad = edadEnTurnos(id);

          // Te está corrigiendo, no aceptando.
          if (corrige) {
            return {
              p,
              salida: {
                ok: false,
                motivo: "El usuario está corrigiendo un dato, no aceptando la propuesta.",
                que_hacer:
                  "Volvé a llamar la herramienta que corresponda con los datos NUEVOS y " +
                  "esperá que confirme eso. No ejecutes la propuesta anterior: tiene los " +
                  "datos que él acaba de descartar.",
              },
            };
          }

          if (siPelado && edad !== null && edad > 1) {
            return {
              p,
              salida: {
                ok: false,
                motivo:
                  "Esa propuesta quedó de hace varios turnos y él dijo solo \"sí\", sin " +
                  "decir a qué. Puede estar contestando otra cosa.",
                que_hacer:
                  "NO la ejecutes. Preguntale con todas las letras si se refiere a eso, " +
                  "diciéndole qué es. Si te dice que sí nombrándolo, ahí confirmás.",
              },
            };
          }
        }

        // El usuario dijo que sí y esto es una re-propuesta: no se ejecuta. Si se
        // ejecutara quedaría una propuesta nueva —que él nunca vio— y la que sí
        // aceptó sin usar. Se le devuelve el id vivo para que confirme ahora.
        const pendiente = opciones.propuestaPendiente;
        if (acepto && PROPONEN.has(p.name) && pendiente && existe(pendiente)) {
          return {
            p,
            salida: {
              ok: false,
              motivo: "El usuario ya aceptó la propuesta que estaba esperando. Esto sería proponerla de nuevo.",
              que_hacer: `Llamá \`confirmar\` con propuesta_id "${pendiente}". No propongas nada más.`,
            },
          };
        }

        return { p, salida: await ejecutarTool(sb, p.name, p.input ?? {}, canal) };
      }),
    );

    // Separar las acciones que salieron bien de todo lo demás.
    const confirmadas: string[] = [];
    const frases: string[] = [];
    let soloAcciones = salidas.length > 0;
    for (const { p, salida } of salidas) {
      const s = salida as {
        ok?: boolean; accion?: Accion; abriendo?: string; frase?: string;
        propuesta?: Propuesta; panel?: Panel;
      };
      // Una propuesta se muestra apenas aparece, aunque el turno siga: es lo que
      // el usuario tiene que mirar para decidir si confirma.
      if (s?.propuesta) {
        propuestas.push(s.propuesta);
        // Si había otra esperando, se descarta. Dos propuestas vivas es el peor
        // escenario: el usuario corrige ("mejor el viernes"), después dice "sí", y
        // no hay forma de saber a cuál de las dos le dijo que sí.
        const vieja = opciones.propuestaPendiente;
        if (vieja && vieja !== s.propuesta.id) descartar(vieja);
      }
      if (s?.panel) paneles.push(s.panel);
      if (toolPorNombre(p.name)?.esAccion && s?.ok === true && s.accion) {
        acciones.push(s.accion);
        confirmadas.push(s.abriendo ?? p.name);
        if (s.frase) frases.push(s.frase);
      } else {
        soloAcciones = false;
      }
    }

    // CORTE: si todo lo que pidió fueron acciones y todas salieron bien, no hace falta
    // una segunda llamada al modelo solo para que escriba "listo". Es la mitad del costo
    // por comando y la mitad de la latencia, que en un canal de voz se nota más.
    // Si alguna falló, seguimos: ahí sí queremos que el modelo explique o pregunte.
    if (soloAcciones) {
      // Si la herramienta trajo su propia frase, se usa esa: "abro pausar" no
      // se entiende, "Listo, pausado" sí.
      texto = frases.length === confirmadas.length
        ? frases.join(" ")
        : `Listo, abro ${confirmadas.join(" y ")}.`;
      break;
    }

    const resultados = salidas.map(({ p, salida }) => ({
      type: "tool_result",
      tool_use_id: p.id,
      // El `panel` se saca ANTES de mandárselo al modelo: es el detalle para
      // dibujar en pantalla (día por día, con horarios), y el modelo ya tiene su
      // propio resumen en el mismo resultado. Mandarle los dos sería pagar dos
      // veces por el mismo dato y contra la regla del proyecto: conclusiones al
      // modelo, detalle a la interfaz.
      content: JSON.stringify(salida, (k, v) => (k === "panel" ? undefined : v)),
    }));

    for (const { salida } of salidas) crudos.push(salida);
    mensajes.push({ role: "assistant", content: bloques });
    mensajes.push({ role: "user", content: resultados });
  }

  if (!texto) texto = "No pude armar la respuesta. Probá preguntándomelo de otra forma.";

  // ---------------------------------------------------------------------------
  // Cerrar el lazo: aceptaste y el modelo no ejecutó.
  //
  // Con el bloqueo de re-propuesta alcanzaba para que no se escribiera lo
  // equivocado, pero no para que se escribiera lo correcto: medido, en 2 de cada
  // 4 corridas el modelo recibía el "confirmá con el id tal" y en vez de hacerlo
  // te lo CONTABA —"todavía está la otra propuesta esperando"— dejando la
  // conversación trabada y obligándote a decir que sí otra vez.
  //
  // Si dijiste que sí, la propuesta que estabas mirando sigue viva y es del turno
  // anterior, no hay nada que interpretar: se ejecuta. Las condiciones son
  // estrechas a propósito — aceptación limpia, propuesta de recién, y que el
  // modelo no haya propuesto nada nuevo en este turno (si propuso algo nuevo, eso
  // es lo que está en pantalla y confirmar lo viejo sería justo el error opuesto).
  const pendId = opciones.propuestaPendiente;
  if (acepto && pendId && propuestas.length === 0 && !toolsUsadas.includes("confirmar")) {
    const edad = edadEnTurnos(pendId);
    if (edad !== null && edad <= 1) {
      const salida = (await ejecutarTool(sb, "confirmar", { propuesta_id: pendId }, canal)) as {
        ok?: boolean; para_decir?: string;
      };
      toolsUsadas.push("confirmar");
      llamadas.push({ tool: "confirmar", input: { propuesta_id: pendId, lo_cerro: "el servidor" } });
      crudos.push(salida);
      if (salida?.ok && salida.para_decir) texto = salida.para_decir;
    }
  }

  // ---------------------------------------------------------------------------
  // Que ningún número salga de la nada.
  //
  // Las herramientas están auditadas contra la base cruda y cierran al peso. El
  // eslabón que quedaba suelto es el modelo redactando: preguntado por el gasto
  // más grande de la semana contestó "diecinueve mil ciento veintidós" sobre una
  // fila que dice 18.122. Un dígito. Con datos correctos y una frase impecable.
  //
  // Acá se leen los números que dijo —vienen en palabras, es un canal de voz— y
  // se comparan contra TODO lo que devolvieron las herramientas. Si alguno no se
  // puede justificar, se le devuelve al modelo para que reescriba, una sola vez.
  // Reescribir y no tachar: la respuesta sigue siendo suya, solo que con los
  // números que existen.
  const sospechosos = numerosSinRespaldo(texto, crudos);
  let numerosCorregidos: number[] = [];

  if (sospechosos.length && crudos.length && vueltas < MAX_VUELTAS) {
    numerosCorregidos = sospechosos;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelo,
        max_tokens: 1200,
        system: [{ type: "text", text: systemPrompt(hoy, canal), cache_control: { type: "ephemeral" } }],
        // Sin `tools`: no queremos que vuelva a consultar, queremos que reescriba
        // con lo que ya tiene.
        // `mensajes` termina en el bloque de tool_results, así que alcanza con
        // agregarle lo que dijo y el reclamo.
        messages: [
          ...mensajes,
          { role: "assistant", content: texto },
          {
            role: "user",
            content:
              `PARÁ. Estos números que dijiste no salen de ninguna herramienta:\n` +
              sospechosos.map((n) => {
                const cerca = candidatosPara(n, crudos);
                return `  · ${n}${cerca.length ? ` — lo que sí está es ${cerca.join(" o ")}` : ""}`;
              }).join("\n") +
              `\nVolvé a escribir la respuesta usando SOLO los números de los resultados ` +
              `de arriba, leídos tal cual. Si un dato no lo tenés, no lo digas. Misma ` +
              `respuesta, mismo tono, sin aclarar que te equivocaste.`,
          },
        ],
      }),
    });
    const data = await r.json();
    if (r.ok) {
      const u = data.usage ?? {};
      costoUsd +=
        ((u.input_tokens ?? 0) * precio.in +
          (u.output_tokens ?? 0) * precio.out +
          (u.cache_creation_input_tokens ?? 0) * precio.cacheWrite +
          (u.cache_read_input_tokens ?? 0) * precio.cacheRead) / 1e6;
      const rehecho = (data.content ?? [])
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text).join("").trim();
      // Se acepta si mejoró, aunque no quede perfecta: una respuesta con un
      // número dudoso es mejor que una con tres.
      const quedan = rehecho ? numerosSinRespaldo(rehecho, crudos) : null;
      if (rehecho && quedan && quedan.length < sospechosos.length) {
        texto = rehecho;
        numerosCorregidos = sospechosos.filter((n) => !quedan.includes(n));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // El canal PC se escucha, no se lee.
  //
  // El prompt dice "nada de listas, tablas, markdown ni emojis" y aun así contesta
  // con **negritas** y viñetas cuando la respuesta tiene dos partes. Leído por el
  // sintetizador eso sale como "asterisco asterisco Thiago asterisco asterisco".
  // Sacarlo es determinístico, así que se saca acá en vez de volver a pedirlo.
  if (canal === "pc") {
    texto = texto
      .replace(/\*\*|__|`+/g, "")
      .replace(/^\s*[-*•]\s+/gm, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\s*\n+\s*/g, " ")
      .replace(/ {2,}/g, " ")
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Guardrail: no dejar que anuncie algo que no pasó.
  //
  // El system prompt se lo prohíbe explícitamente y aun así lo hace: medido, tres
  // casos de "Listo, anoté el gasto" con CERO escrituras — en vez de confirmar,
  // volvía a proponer. Para el usuario es el peor error posible, porque se queda
  // creyendo que registró algo que no existe. Como el prompt no alcanza, la
  // corrección se aplica acá.
  //
  // La condición es precisa: solo cuando quedó una propuesta viva (o sea, algo
  // esperando confirmación) Y el texto habla en pasado. Las acciones inmediatas
  // como "Listo, abro Spotify" no entran, porque ahí no hay propuestas.
  //
  // ⚠️ La primera versión buscaba solo la primera persona ("cargué", "anoté") y se
  // le escapó **"Está cargado"** — el modelo canta victoria en participio tanto
  // como en pasado. Van las dos formas, más los "ya está / hecho / listo" sueltos.
  const CANTA_VICTORIA = new RegExp(
    [
      // primera persona: cargué, anoté, agendé, borré, moví…
      "\\b(?:anot|carg|agend|borr|elimin|guard|registr|cambi|actualic|mov)[a-zéíó]*\\b",
      // participios: cargado, anotada, agendado, borrado…
      "\\b(?:cargad|anotad|agendad|borrad|eliminad|guardad|registrad|actualizad)[oa]s?\\b",
      // fórmulas de cierre
      "\\b(?:list[oa]|hecho|ya est[áa]|qued[óo] (?:hecho|cargad|agendad|guardad|registrad))",
    ].join("|"),
    "i",
  );

  // ...pero sin comerse los mensajes honestos. "Listo" y "hecho" son muletillas
  // rioplatenses antes que afirmaciones: **"Listo, te lo dejo propuesto: gasto de
  // siete mil en Transporte, ¿lo cargo?"** no miente en nada, y la primera versión
  // igual lo reemplazaba por el reto genérico. Perdía el detalle útil en TODAS las
  // propuestas de escritura, que es la operación más común del canal.
  //
  // Si el texto dice explícitamente que está proponiendo o pregunta si confirma,
  // no hay victoria que cantar: se deja como está.
  const ES_PROPUESTA =
    /\b(?:propuest|propongo|confirm|te parece|lo cargo|lo borro|lo cambio|lo anoto|quer[eé]s que|va[?]|as[ií]\?)/i;

  if (propuestas.length > 0 && CANTA_VICTORIA.test(texto) && !ES_PROPUESTA.test(texto)) {
    const que = propuestas[0].tipo === "borrar" ? "¿Lo borro?"
      : propuestas[0].tipo === "editar" ? "¿Lo cambio?" : "¿Lo cargo?";
    texto = `Pará, todavía no lo hice: te lo dejo propuesto. ${que}`;
  }

  return {
    texto, costoUsd, toolsUsadas, llamadas, vueltas, acciones, propuestas, paneles,
    numerosCorregidos, cache,
  };
}
