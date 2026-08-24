import type { SupabaseClient } from "@supabase/supabase-js";
import type { Tool } from "./tools";

/**
 * Avisos push al celular, vía **ntfy.sh**.
 *
 * Jarvis habla por un parlante o por Telegram: los dos exigen que Lucas esté
 * ahí en ese momento. Esto es el canal para cuando NO está — que el bolsillo
 * suene solo, sin que nadie tenga que mirar nada.
 *
 * ## Por qué ntfy y no otra cosa
 *
 * Un POST a `https://ntfy.sh` hace sonar el celular. Sin cuenta, sin token, sin
 * SDK, sin certificados de Apple ni de Firebase. La app del celular se suscribe
 * a un tópico y listo. Es la misma decisión que las APIs de `mundo.ts`: lo que
 * no pide credenciales no se rompe cuando la credencial vence.
 *
 * ## ⚠️ El tópico ES la contraseña
 *
 * ntfy no tiene usuarios: **quien sabe el nombre del tópico puede leer y
 * escribir en él**. Un tópico adivinable (`jarvis`, `lucas`, `avisos`) es un
 * canal abierto al público en el que cualquiera puede meter notificaciones.
 *
 * De ahí las dos reglas que sigue este archivo:
 *
 *  1. **El tópico NO está en el código.** Sale de `NTFY_TOPICO`, y si la
 *     variable no está definida esto falla con un motivo claro en vez de
 *     mandar a un tópico por defecto. Este repo es público: un tópico
 *     hardcodeado acá queda publicado para siempre, y no se "arregla"
 *     borrándolo después — queda en el historial de git.
 *  2. **El tópico nunca sale en un resultado.** Ni en el `ok`, ni en el
 *     `motivo` de un error, ni en el cuerpo crudo que devuelve ntfy. Los
 *     resultados de las herramientas viajan enteros al modelo (`crudos` en
 *     run.ts) y de ahí a transcripciones y logs. Por eso los errores acá dicen
 *     el código HTTP y nada más: es menos cómodo para depurar, pero un secreto
 *     que se filtra en un log es un secreto perdido.
 *
 * ## ⚠️ Por qué el cuerpo JSON y no las cabeceras
 *
 * ntfy admite dos formas: mandar el texto en el cuerpo y los metadatos en
 * cabeceras HTTP (`Title`, `Priority`, `Tags`), o mandar todo como un JSON a la
 * raíz del servidor. Acá se usa **siempre la segunda**, y no es cuestión de
 * gusto.
 *
 * Las cabeceras HTTP solo transportan latin-1. Un título en castellano lleva
 * acentos y eñes, y el resultado medido contra ntfy.sh el 24/08/2026 fue:
 *
 *     Title: "Terminó ñandú"  →  HTTP 200  →  llega "Termin� �and�"
 *
 * Lo peor no es que se rompa: es que **contesta 200**. No hay excepción, no hay
 * error, no hay nada que atajar — el aviso sale, llega, y llega mal. Un bug que
 * solo se descubre mirando el celular.
 *
 * Con el mismo texto en el cuerpo JSON, ida y vuelta exactos (`===` contra el
 * original, verificado además releyendo el mensaje guardado en el servidor, no
 * el eco de la propia respuesta). El JSON va en UTF-8 por definición y el
 * problema desaparece de raíz.
 *
 * ## La regla de oro
 *
 * Igual que en `tools.ts` y `mundo.ts`: la herramienta devuelve la CONCLUSIÓN
 * redactada en `para_decir`. Y la contracara, que acá importa más que en
 * ninguna otra: **si el aviso no salió, no se dice que salió**. Un "listo, te
 * lo mandé" sobre una notificación que nunca llegó es la peor respuesta
 * posible, porque Lucas se queda esperando un ruido que no va a venir.
 */

/**
 * Se postea a la RAÍZ del servidor, no a `/<topico>`: en la forma JSON el
 * tópico viaja adentro del cuerpo. Ventaja lateral y buscada — el tópico no
 * queda escrito en la URL, que es justo lo que se cuela en los logs de acceso.
 */
const SERVIDOR = "https://ntfy.sh";

// Mismo plazo corto que en `mundo.ts` y por el mismo motivo: esto corre en
// medio de una conversación hablada. Ocho segundos de silencio ya son muchos;
// treinta esperando a un servidor colgado son insoportables.
const PLAZO = 8000;

/**
 * ⚠️ Arriba de 4096 caracteres ntfy contesta **HTTP 500**, no un 400.
 *
 * Medido: 4000 → 200, 4096 → 500, 4200 → 500. Un 500 es indistinguible de "se
 * cayó el servicio", así que sin este recorte un resumen largo de Claude Code
 * se vería como una caída de ntfy y nadie sabría por qué.
 *
 * El recorte real es bastante más abajo del techo: un push es un titular, no un
 * informe. Lo que no entra en la pantalla del celular no lo lee nadie.
 */
const LARGO_TEXTO = 1200;
const LARGO_TITULO = 120;

/** El charset que ntfy acepta en un nombre de tópico. */
const TOPICO_VALIDO = /^[-_A-Za-z0-9]{1,64}$/;

/** Un botón que aparece abajo de la notificación y abre una URL al tocarlo. */
export type BotonDeAviso = {
  /** Lo que dice el botón. Corto: en el celular entran dos o tres palabras. */
  texto: string;
  /** A dónde lleva. Solo http/https — ver la advertencia en `botonesDe`. */
  url: string;
};

export type OpcionesDeAviso = {
  /** El renglón en negrita. Si no va, el celular muestra el nombre del tópico. */
  titulo?: string;
  /**
   * 1 a 5. 3 es el default de ntfy (notificación normal); 4 suena y vibra;
   * 5 además insiste y puede saltarse el "no molestar" de Android.
   *
   * ⚠️ Fuera de rango ntfy contesta **HTTP 400** y el aviso no sale (medido con
   * `priority: 9`). Un 0 no da error pero se ignora en silencio. Por eso se
   * recorta al rango acá en vez de confiar en el llamador.
   */
  prioridad?: number;
  /**
   * Nombres de emoji de ntfy (`white_check_mark`, `warning`, `rocket`) o emoji
   * literales. Se dibujan al lado del título.
   *
   * ⚠️ Un nombre que ntfy no conoce NO da error: se muestra tal cual, como
   * texto pelado al lado del título (medido: `no_existe_este_tag_raro` → 200, y
   * eso mismo aparece en la pantalla). Por eso los nombres los eligen los
   * helpers de este archivo y no un modelo — ver `avisoAlCelular`.
   *
   * En la forma por cabeceras esto iría como una lista separada por comas y un
   * texto con coma adentro rompería la lista. En JSON es un array de verdad y
   * el problema no existe: otra razón para el cuerpo JSON.
   */
  etiquetas?: string[];
  /** Botones que abren una URL. Como mucho tres: ntfy no muestra más. */
  botones?: BotonDeAviso[];
};

/**
 * Nunca lleva el tópico, ni siquiera cuando sale bien. Ver la advertencia de
 * arriba: esto termina en el contexto del modelo y en los logs.
 */
export type ResultadoDeAviso =
  | { ok: true; id: string }
  | { ok: false; motivo: string };

/**
 * El tópico, o el motivo por el que no hay tópico.
 *
 * Fallar acá es lo correcto y es deliberado: la alternativa —un tópico por
 * defecto tipo `jarvis-avisos`— es peor que no mandar nada, porque manda los
 * avisos personales de Lucas a un canal público que ya puede estar escuchando
 * cualquiera. Silencio con motivo antes que un aviso mal dirigido.
 */
function topicoConfigurado(): { topico: string } | { motivo: string } {
  const crudo = (process.env.NTFY_TOPICO ?? "").trim().replace(/\/+$/, "");
  if (!crudo) {
    return {
      motivo:
        "No hay ningún tópico de avisos configurado (falta la variable de entorno " +
        "NTFY_TOPICO), así que no tengo a dónde mandarlo.",
    };
  }
  // El error típico es pegar la URL entera en vez del nombre. Se nombra el
  // síntoma sin repetir el valor: si alguien pegó algo que no era, ese algo
  // puede ser justamente un secreto y no va a un log.
  if (!TOPICO_VALIDO.test(crudo)) {
    return {
      motivo:
        "El tópico de avisos configurado en NTFY_TOPICO no tiene un formato válido " +
        "(va el nombre solo, sin la URL ni barras: letras, números, guiones y guiones bajos).",
    };
  }
  return { topico: crudo };
}

/** Recorta sin cortar a la mitad de una palabra si se puede evitar. */
function recortar(texto: string, largo: number): string {
  const limpio = texto.trim();
  if (limpio.length <= largo) return limpio;
  const corte = limpio.slice(0, largo);
  const ultimoEspacio = corte.lastIndexOf(" ");
  return (ultimoEspacio > largo * 0.6 ? corte.slice(0, ultimoEspacio) : corte).trimEnd() + "…";
}

/**
 * ⚠️ Solo botones `view` (abrir una URL), y solo http/https.
 *
 * ntfy también acepta acciones de tipo `http`, que disparan un request arbitrario
 * —método, headers y cuerpo incluidos— cuando se toca el botón. Verificado que
 * las acepta (HTTP 200). Eso convierte una notificación en un disparador de
 * requests, y este archivo lo alimenta en parte un modelo de lenguaje: no hay
 * ninguna razón para abrir esa puerta cuando lo único que se necesita es un
 * "abrir el diff". Lo que no se construye acá, no se puede pedir.
 */
function botonesDe(botones: BotonDeAviso[] | undefined) {
  if (!Array.isArray(botones) || !botones.length) return undefined;
  const buenos = botones
    .filter((b) => b && typeof b.url === "string" && /^https?:\/\//i.test(b.url))
    .slice(0, 3)
    .map((b) => ({
      action: "view" as const,
      label: recortar(String(b.texto ?? "Abrir"), 30) || "Abrir",
      url: b.url,
      // Que la notificación se borre sola al tocar el botón: si ya la atendió,
      // dejarla ahí es basura que se acumula en la pantalla de bloqueo.
      clear: true,
    }));
  return buenos.length ? buenos : undefined;
}

/**
 * Manda una notificación al celular. **Nunca lanza una excepción.**
 *
 * Esa promesa es el punto entero de la firma. Un aviso es siempre algo
 * secundario: acompaña a una operación que ya pasó (una tarea que terminó, un
 * proceso que falló). Si ntfy está caído y esto tirara, se llevaría puesta la
 * operación de la que colgaba — y el usuario perdería el trabajo además del
 * aviso. El resultado se devuelve, no se tira: el que llama decide si le
 * importa, y casi siempre no le importa.
 */
export async function avisar(
  texto: string,
  opciones: OpcionesDeAviso = {},
): Promise<ResultadoDeAviso> {
  try {
    const cuerpo = recortar(String(texto ?? ""), LARGO_TEXTO);
    // ⚠️ ntfy acepta un mensaje vacío con HTTP 200 y lo reemplaza por la palabra
    // "triggered" (medido). Un celular que suena para decir "triggered" es peor
    // que un celular que no suena: cortamos acá.
    if (!cuerpo) return { ok: false, motivo: "No hay nada que avisar: el texto vino vacío." };

    const cual = topicoConfigurado();
    if ("motivo" in cual) return { ok: false, motivo: cual.motivo };

    const titulo = opciones.titulo ? recortar(String(opciones.titulo), LARGO_TITULO) : "";
    const etiquetas = (opciones.etiquetas ?? [])
      .map((e) => String(e ?? "").trim())
      .filter(Boolean)
      .slice(0, 5);

    const prioridad = Number.isFinite(opciones.prioridad)
      ? Math.min(Math.max(Math.round(Number(opciones.prioridad)), 1), 5)
      : undefined;

    const acciones = botonesDe(opciones.botones);

    const r = await fetch(SERVIDOR, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: cual.topico,
        message: cuerpo,
        ...(titulo ? { title: titulo } : {}),
        ...(prioridad ? { priority: prioridad } : {}),
        ...(etiquetas.length ? { tags: etiquetas } : {}),
        ...(acciones ? { actions: acciones } : {}),
      }),
      signal: AbortSignal.timeout(PLAZO),
    });

    if (!r.ok) {
      // ⚠️ A propósito NO se lee el cuerpo de la respuesta de error: puede
      // repetir el tópico, y de acá el texto se va derecho a un log o al
      // contexto del modelo. El código HTTP alcanza para saber qué pasó.
      return { ok: false, motivo: `ntfy rechazó el aviso (HTTP ${r.status}).` };
    }

    // El id lo genera ntfy y no dice nada del tópico: es seguro devolverlo, y
    // sirve para rastrear un aviso puntual si algún día hay que hacerlo.
    const eco = (await r.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: String(eco?.id ?? "") };
  } catch (e) {
    // El catch abraza TODO —incluido el `JSON.stringify` y la lectura de la
    // variable de entorno— justamente para que no exista ningún camino por el
    // que un aviso roto se propague hacia arriba.
    const motivo =
      e instanceof Error && e.name === "TimeoutError"
        ? "ntfy tardó demasiado en contestar."
        : e instanceof Error
          ? e.message
          : "Error desconocido";
    return { ok: false, motivo: `No pude mandar el aviso: ${motivo}` };
  }
}

// ---------------------------------------------------------------------------
// Avisos con forma propia
// ---------------------------------------------------------------------------

/**
 * "Terminó la tarea de código". El primer uso real de todo esto.
 *
 * Una tarea de Claude Code puede tardar varios minutos (ver `codigo.ts`): Lucas
 * la larga por voz y se va a hacer otra cosa. Sin esto, la única forma de saber
 * si terminó es volver a preguntar cada tanto, que es exactamente el trabajo
 * que el asistente tendría que estar sacándole de encima.
 *
 * Los campos son los mismos de `TareaCodigo` en `codigo.ts` —admiten `null` con
 * el mismo significado, así que una tarea entra tal cual sin adaptar nada— pero
 * van sueltos y sin importar el tipo: este archivo no tiene por qué depender de
 * aquel para armar una frase, y así el helper sirve igual para cualquier otra
 * cosa larga que termine.
 */
export async function avisoDeTareaTerminada(tarea: {
  /** El repo donde corrió. Es lo primero que Lucas necesita para ubicarse. */
  repo: string;
  /** Lo que contó Claude Code al terminar. Si no hay, se dice que no hay. */
  resumen?: string | null;
  /** `false` = falló. `null`/`undefined` = terminó sin veredicto, que no es lo mismo. */
  exito?: boolean | null;
  /** Lo que salió en dólares, si se midió. */
  costo_usd?: number | null;
}): Promise<ResultadoDeAviso> {
  const repo = String(tarea?.repo ?? "").trim() || "un repo";
  const fallo = tarea?.exito === false;

  // ⚠️ Tres estados, no dos. Una tarea sin veredicto NO se anuncia como éxito:
  // decir "salió bien" sin saberlo es inventar un dato, y encima es el dato del
  // que depende que Lucas decida si va a mirar el resultado o no.
  const titulo = fallo
    ? `Falló la tarea en ${repo}`
    : tarea?.exito === true
      ? `Terminó la tarea en ${repo}`
      : `Terminó la tarea en ${repo} (sin resultado claro)`;

  const partes: string[] = [];
  const resumen = String(tarea?.resumen ?? "").trim();
  partes.push(resumen || "Terminó sin dejar resumen.");
  // Coma decimal: lo lee un argentino, no un parser. Mismo criterio que
  // `compact()` en lib/format.ts, que también reemplaza el punto a mano.
  if (Number.isFinite(tarea?.costo_usd)) {
    partes.push(`Costó US$ ${Number(tarea.costo_usd).toFixed(2).replace(".", ",")}.`);
  }

  return avisar(partes.join(" "), {
    titulo,
    // Una que falló va en 5 y no en 4 porque es la única de las dos que pide
    // que haga algo: la que salió bien puede esperar a que mire el celular.
    prioridad: fallo ? 5 : 4,
    etiquetas: [fallo ? "x" : "white_check_mark"],
  });
}

// ---------------------------------------------------------------------------
// La herramienta del modelo
// ---------------------------------------------------------------------------

const avisoAlCelular: Tool = {
  name: "avisar_al_celular",
  description:
    "Manda AHORA MISMO una notificación push al celular de Lucas: le suena el teléfono " +
    "en el momento, esté donde esté. Usar para 'mandame un aviso al celular', 'tirame " +
    "una notificación', 'avisame al teléfono', 'mandame esto al celu', 'recordámelo en " +
    "el celular'.\n" +
    "⚠️ Es para avisos INMEDIATOS, no programados. Si te pide que le avises MÁS TARDE " +
    "—'avisame a las 3', 'recordame mañana a la mañana', 'tocame el timbre en una hora'— " +
    "esta herramienta NO sirve: sonaría ya mismo, no a la hora que pidió. Para eso va un " +
    "evento de Calendar con recordatorio. La pregunta que te tenés que hacer es si el " +
    "aviso tiene que sonar ahora o después; si es después, no es acá.\n" +
    "Tampoco hace falta para contestarle algo que te está preguntando en este momento: " +
    "si te está escuchando, contestale y ya. Esto es para cuando no va a estar mirando.",
  input_schema: {
    type: "object",
    properties: {
      texto: {
        type: "string",
        description:
          "El cuerpo del aviso, ya redactado y entendible solo. Lo va a leer en la " +
          "pantalla del celular, quizás horas después y sin el contexto de esta charla: " +
          "escribilo completo, no como una respuesta a algo. Cortito, dos o tres frases.",
      },
      titulo: {
        type: "string",
        description:
          "El renglón en negrita de arriba, de pocas palabras. Es lo único que se lee " +
          "de un vistazo en la pantalla de bloqueo, así que que diga de qué se trata.",
      },
      urgente: {
        type: "boolean",
        description:
          "true SOLO si tiene que interrumpirlo aunque el teléfono esté en silencio. " +
          "Por defecto false, que ya hace sonar y vibrar. Un aviso urgente de más es " +
          "un aviso que la próxima vez va a ignorar.",
      },
    },
    required: ["texto"],
  },
  canales: ["telegram", "pc"],
  // `esAccion` NO: el aviso lo manda ESTE servidor, no la PC. No hay ninguna
  // `accion` para que el cliente ejecute, así que el corte de la segunda vuelta
  // en run.ts no se dispararía igual — y encima conviene que no se dispare,
  // porque si ntfy falla el modelo tiene que poder explicar qué pasó en vez de
  // contestar un "listo" fijo sobre algo que no salió.
  async handler(_sb: SupabaseClient, input: Record<string, unknown>) {
    const texto = String(input?.texto ?? "").trim();
    if (!texto) {
      return { ok: false, motivo: "No me dijiste qué avisar." };
    }
    const titulo = String(input?.titulo ?? "").trim();

    // La prioridad no se le ofrece al modelo como número: un 1-5 sin escala a la
    // vista se elige a ojo y termina mandando todo en 5. Se le pregunta lo único
    // que puede juzgar de verdad —si esto interrumpe o no— y el número lo pone
    // el servidor. Mismo criterio con las etiquetas: un nombre de emoji que ntfy
    // no conoce se imprime como texto pelado al lado del título (medido), así
    // que el emoji se elige acá, de una lista que existe, y no se adivina.
    const urgente = input?.urgente === true;

    const r = await avisar(texto, {
      titulo: titulo || "Jarvis",
      prioridad: urgente ? 5 : 4,
      etiquetas: [urgente ? "rotating_light" : "bell"],
    });

    if (!r.ok) {
      return {
        ok: false,
        motivo: r.motivo,
        // Sin esto el modelo tiende a redondear un fallo en un "listo". Acá el
        // error importa más que en otras herramientas: Lucas se queda esperando
        // un ruido que no va a llegar, y no tiene forma de darse cuenta.
        que_hacer:
          "Decile que el aviso NO salió y por qué. No le digas que se lo mandaste ni " +
          "que le va a llegar en un rato.",
      };
    }

    return {
      ok: true,
      // Ni el tópico ni nada que lo deje adivinar: esto se lo lleva el modelo.
      enviado: true,
      para_decir: "Listo, te lo mandé al celular.",
    };
  },
};

export const TOOLS_AVISOS: Tool[] = [avisoAlCelular];
