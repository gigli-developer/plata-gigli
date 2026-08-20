import type { SupabaseClient } from "@supabase/supabase-js";
import { guardar } from "./propuestas";
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

/**
 * Anotar en la bitácora por voz — la regla 5 del contrato dice que se escribe
 * EN EL MOMENTO, y el momento suele ser hablando, no frente al teclado.
 *
 * Escribe archivos en el disco desde una orden de voz, así que va con propuesta
 * y confirmación como todo lo que escribe: esta herramienta solo arma la
 * tarjeta; el archivo lo crea la PC cuando `confirmar` devuelve la acción. La
 * tarjeta es EL lugar donde se atrapa un «quinientos» transcripto como
 * «cincuenta»: lo que se confirma es exactamente lo que se previsualizó.
 */
const cerebroAnotar: Tool = {
  name: "cerebro_anotar",
  description:
    "Anota una DECISIÓN o una CORRECCIÓN en la bitácora del cerebro de Lucas. " +
    "Usar cuando cierran una discusión ('quedamos en X porque Z'), cuando él te " +
    "corrige algo de verdad ('no, eso no es así, es asá'), o cuando lo pide " +
    "('anotá esto', 'que quede registrado').\n" +
    "decision = se eligió X en vez de Y, y el PORQUÉ es lo único que importa. " +
    "correccion = algo estaba mal, y lo que vale es LA REGLA que sale (no la " +
    "anécdota: 'se equivocó con las fechas' no sirve, 'los períodos los calcula " +
    "el servidor' sí).\n" +
    "⚠️ NO es para gastos ni recordatorios (eso es `plata_registrar` / " +
    "`agenda_cambiar`). Es para lo que mañana explica por qué las cosas son como " +
    "son.\n" +
    "Propone y espera el sí: mostrá el resumen, preguntá, y recién con su " +
    "confirmación llamá `confirmar` con el id.",
  input_schema: {
    type: "object",
    properties: {
      tipo: {
        type: "string",
        enum: ["decision", "correccion"],
        description: "decision (se eligió X porque Z) o correccion (estaba mal, la regla es Y).",
      },
      titulo: {
        type: "string",
        description: "Título corto y concreto, como un titular. Ej: 'El interruptor es manual'.",
      },
      resumen: {
        type: "string",
        description:
          "UNA línea que afirma lo decidido o la regla que salió. Va al encabezado " +
          "de la nota y es lo que la búsqueda por voz va a leer: usá las palabras " +
          "que se dirían en voz alta.",
      },
      detalle: {
        type: "string",
        description:
          "El cuerpo: el porqué de la decisión (qué se descartó y por qué), o qué " +
          "pasó y cómo se llegó a la regla. Dos a cinco frases, con los datos " +
          "concretos que se dijeron.",
      },
      verificar: {
        type: "string",
        description:
          "Solo para correcciones y solo si existe: el comando o archivo que " +
          "confirma la regla. Las decisiones no llevan (no tienen verdad objetiva).",
      },
    },
    required: ["tipo", "titulo", "resumen", "detalle"],
  },
  canales: ["pc"],
  async handler(_sb: SupabaseClient, input: Record<string, unknown>) {
    const tipo = String(input?.tipo ?? "");
    const titulo = String(input?.titulo ?? "").trim();
    const resumen = String(input?.resumen ?? "").trim();
    const detalle = String(input?.detalle ?? "").trim();
    const verificar = input?.verificar ? String(input.verificar).trim() : undefined;
    if (tipo !== "decision" && tipo !== "correccion") {
      return { ok: false, motivo: "El tipo tiene que ser decision o correccion." };
    }
    if (!titulo || !resumen || !detalle) {
      return { ok: false, motivo: "Falta título, resumen o detalle: la nota quedaría coja." };
    }
    if (titulo.length > 80 || resumen.length > 300 || detalle.length > 2000) {
      return { ok: false, motivo: "Demasiado largo para una nota de bitácora: resumí." };
    }
    const p = guardar({
      dominio: "cerebro", tipo: "crear",
      notaCerebro: { tipo, titulo, resumen, detalle, verificar },
    });
    return {
      ok: true,
      propuesta: {
        id: p.id, dominio: "cerebro", tipo: "crear", antes: null,
        // La tarjeta dibuja `titulo` y `nota` — alcanza para leer lo que se va a escribir.
        despues: { titulo: `${tipo === "decision" ? "Decisión" : "Corrección"}: ${titulo}`, nota: resumen },
      },
      para_decir: `Anoto ${tipo === "decision" ? "la decisión" : "la corrección"}: ${resumen}`,
      que_hacer: `Leele el resumen y preguntale si lo anota. Si confirma, confirmar con id "${p.id}".`,
    };
  },
};

/**
 * «¿Qué notas quedaron viejas?» — corre el revalidador de la PC y devuelve el
 * resumen. Solo lectura: el revalidador no escribe ni borra nada por contrato.
 */
const cerebroRevalidar: Tool = {
  name: "cerebro_revalidar",
  description:
    "Revisa qué notas del cerebro ya no se confirman: corre los chequeos de cada " +
    "nota y compara los índices contra el disco. Usar cuando pregunta '¿qué notas " +
    "quedaron viejas?', '¿el cerebro está sano?', o después de un cambio grande. " +
    "Devuelve un reporte: contá los problemas si los hay, o que está todo sano. " +
    "No arregla nada — solo mira.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["pc"],
  async handler() {
    return {
      ok: true,
      buscando: "el estado del cerebro",
      // `valor` es string en el contrato de Accion; el JSON es la misma
      // convención que ya usa `codigo`. Un string pelado sigue siendo consulta.
      accion: { tipo: "cerebro", valor: JSON.stringify({ accion: "revalidar" }) },
    };
  },
};

export const TOOLS_CEREBRO: Tool[] = [cerebro, cerebroAnotar, cerebroRevalidar];
