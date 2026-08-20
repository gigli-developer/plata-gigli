import type { SupabaseClient } from "@supabase/supabase-js";
import type { Tool } from "./tools";

/**
 * La consulta al cerebro: las notas de Lucas, en su propia máquina.
 *
 * ## Por qué el servidor no lee nada
 *
 * El cerebro vive en `Desktop\Claude\cerebro\`, fuera de todo repo y fuera de
 * Railway. Esta herramienta **no lo lee**: devuelve una acción y la PC hace el
 * trabajo, igual que `abrir` o `desplegar_setup`. El servidor nunca ve el
 * contenido, que es exactamente como tiene que ser — son notas personales, y
 * mandarlas a un servicio expuesto a internet para que las devuelva sería
 * paseo de datos sin motivo.
 *
 * ## Por qué UNA herramienta y no varias
 *
 * Regla 7 del contrato del cerebro: se agrega una sola vez. Cada cambio en la
 * lista de herramientas rompe el prefijo del caché de prompt, que viene pegando
 * al 94%. Una herramienta que recibe la pregunta entera y devuelve la
 * conclusión no necesita hermanas.
 *
 * ## Lo que devuelve la PC
 *
 * La nota que corresponde, ya navegada por índice (mapa → índice → nota), no la
 * carpeta entera. Es la misma regla de oro que rige las herramientas de Plata:
 * lo que vuelve es una conclusión, no material crudo.
 */
const cerebro: Tool = {
  name: "cerebro",
  description:
    "Consulta las notas personales de Lucas sobre sus propios proyectos: cómo funciona " +
    "algo que él construyó, por qué se decidió de una manera, qué trampa ya mordió, o " +
    "dónde quedó algo.\n" +
    "Usar para '¿cómo se hace X en Plata?', '¿por qué habíamos decidido Y?', '¿qué " +
    "sabemos de las palmadas?', '¿dónde quedó lo de Boulevard?', '¿qué es el portero?'.\n" +
    "Cubre: Plata (la app de finanzas), Jarvis (vos), Momentum, Boulevard, la PC, más " +
    "las decisiones y correcciones ya anotadas.\n" +
    "⚠️ NO es para datos de plata (saldos, gastos, tarjetas): para eso están las " +
    "herramientas de Plata. Esto es cómo están HECHAS las cosas, no cuánto hay.\n" +
    "Si vuelve una nota, contala con tus palabras y en dos o tres frases: es material " +
    "escrito para leer, no para decir en voz alta. Si no vuelve nada, decílo — no " +
    "inventes lo que podría decir la nota.",
  input_schema: {
    type: "object",
    properties: {
      pregunta: {
        type: "string",
        description:
          "La pregunta completa, tal como la hizo. No la recortes a palabras sueltas: " +
          "del otro lado se busca por parecido y el contexto ayuda.",
      },
    },
    required: ["pregunta"],
  },
  // Solo PC: las notas están en su disco. Por Telegram no hay forma de leerlas.
  canales: ["pc"],
  // `esAccion` NO: el contenido lo tiene que decir el modelo con sus palabras.
  // Con esAccion, el canal HTTP corta la segunda vuelta y contestaría con una
  // frase fija, sin llegar a leer lo que la PC encontró.
  async handler(_sb: SupabaseClient, input: Record<string, unknown>) {
    const pregunta = String(input?.pregunta ?? "").trim();
    if (!pregunta) return { ok: false, motivo: "No me dijiste qué buscar." };
    if (pregunta.length > 300) {
      return { ok: false, motivo: "Esa pregunta es demasiado larga para buscar." };
    }
    return {
      ok: true,
      buscando: pregunta,
      accion: { tipo: "cerebro", valor: pregunta },
    };
  },
};

export const TOOLS_CEREBRO: Tool[] = [cerebro];
