import type { SupabaseClient } from "@supabase/supabase-js";
// Solo el tipo: se borra al compilar, así que no hay ciclo en runtime aunque
// `tools.ts` importe este archivo.
import type { Tool } from "./tools";

/**
 * Resolución de targets: del alias que dijo Lucas a la fila de la tabla `targets`.
 *
 * Por qué existe este archivo. El match era exacto sin distinguir mayúsculas, y
 * este es un canal de VOZ: el STT le cambia los nombres todo el tiempo
 * ("spotifai", "cro me", "you tube"). Con match exacto el asistente contestaba
 * "no tengo nada con ese alias" para algo que sí está cargado.
 *
 * Dónde pasa: en el SERVIDOR, ANTES del modelo. La tabla `targets` NO viaja ni en
 * el schema de la herramienta ni en el system prompt. Es la regla de oro del
 * proyecto — al modelo le llegan conclusiones, no listas para elegir. Mandarle 30
 * aliases en cada consulta sería pagar tokens por algo que un `for` resuelve gratis.
 *
 * El plan pedía `rapidfuzz`, que es de Python. Acá es TypeScript y no se agregan
 * dependencias de npm, así que va Levenshtein normalizada + el equivalente del
 * `partial_ratio` de rapidfuzz, que son las dos señales que hacen el 95% del trabajo.
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Los cuatro tipos que acepta la tabla. `carpeta` todavía no la ejecuta la PC. */
export const TIPOS_TARGET = ["app", "url", "discord", "carpeta"] as const;
export type TipoTarget = (typeof TIPOS_TARGET)[number];

export type Target = {
  id: number;
  alias: string;
  tipo: TipoTarget;
  valor: string;
  aprobado: boolean;
};

/** Un candidato con su puntaje, para cuando hay que preguntar. */
export type Candidato = { alias: string; tipo: TipoTarget; puntaje: number };

export type Resolucion =
  /** Confianza alta y sin empate: se usa. `exacto` es false si hubo que adivinar. */
  | { estado: "resuelto"; target: Target; exacto: boolean; puntaje: number }
  /** Dudoso o empatado: NO se adivina, se devuelven los candidatos para preguntar. */
  | { estado: "ambiguo"; candidatos: Candidato[] }
  /** Ninguno se le parece lo suficiente. */
  | { estado: "sin_match" }
  /** No se pudo leer la tabla. */
  | { estado: "error"; motivo: string };

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/** Máximo que se compara. Un alias es una o dos palabras; el resto es ruido. */
const LARGO_MAX = 60;

/**
 * Minúsculas, sin tildes y sin nada que no sea letra o número.
 *
 * Sacar los espacios y guiones es lo que hace que "you tube" y "vs code" entren:
 * el STT parte los nombres propios donde se le canta y esa partición no lleva
 * información. Comparar "youtube" contra "youtube" da 1,0; contra "you tube",
 * con el espacio adentro, daba 0,875 y quedaba a un pelo del umbral.
 *
 * ⚠️ La prótesis del español: un hispanohablante le mete una "e" adelante a las
 * palabras que arrancan con s+consonante (esnob, estrés, "espotifai"). Es
 * sistemático, no un error de tipeo, así que se deshace acá y "espotify" pasa a
 * ser un match EXACTO de "spotify" en vez de uno dudoso.
 */
export function compactar(s: string): string {
  const plano = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, LARGO_MAX);
  return plano.replace(/^e(s[bcdfgjklmnpqtvwxz])/, "$1");
}

// ---------------------------------------------------------------------------
// Distancia
// ---------------------------------------------------------------------------

/**
 * Levenshtein con dos filas: O(n·m) en tiempo y O(m) en memoria. Con strings de
 * 60 caracteres como techo y una tabla de decenas de filas, esto es ruido frente
 * al ida y vuelta con Supabase.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previa = new Array<number>(b.length + 1);
  let actual = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previa[j] = j;

  for (let i = 1; i <= a.length; i++) {
    actual[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const costo = ca === b.charCodeAt(j - 1) ? 0 : 1;
      actual[j] = Math.min(actual[j - 1] + 1, previa[j] + 1, previa[j - 1] + costo);
    }
    [previa, actual] = [actual, previa];
  }
  return previa[b.length];
}

/** Levenshtein llevada a 0..1, donde 1 es idéntico. */
export function similitud(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const largo = Math.max(a.length, b.length);
  return largo === 0 ? 0 : 1 - levenshtein(a, b) / largo;
}

/**
 * El `partial_ratio` de rapidfuzz: la mejor ventana del string largo contra el
 * corto. Es lo que hace que "el chrome ese" encuentre "chrome" — la basura de
 * alrededor deja de contar como error.
 */
function parcial(a: string, b: string): number {
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  if (!corto.length) return 0;
  if (corto.length === largo.length) return similitud(corto, largo);

  let mejor = 0;
  for (let i = 0; i + corto.length <= largo.length; i++) {
    mejor = Math.max(mejor, similitud(corto, largo.slice(i, i + corto.length)));
    if (mejor === 1) break;
  }
  return mejor;
}

// ---------------------------------------------------------------------------
// Puntaje
// ---------------------------------------------------------------------------

/** Por debajo de esto no se hace fuzzy: con 1 o 2 letras, "yo" matchea "youtube". */
const LARGO_MIN_FUZZY = 3;
/** El `partial_ratio` no se usa con menos de esto: "code" es señal, "co" es azar. */
const LARGO_MIN_PARCIAL = 4;
/** Cuánto vale un token suelto frente a la frase entera. Es señal, pero más floja. */
const CASTIGO_TOKEN = 0.9;

/**
 * El puntaje sobre dos strings ya compactados.
 *
 * Dos señales, se toma la mejor:
 *   · Levenshtein normalizada — cubre las letras cambiadas ("spotifai").
 *   · partial_ratio penalizado por diferencia de largo — cubre el relleno
 *     alrededor del nombre ("abrí el chrome ese").
 *
 * La penalización del parcial es lo que evita el peligro clásico: sin ella, una
 * palabra de 4 letras que aparece dentro de un alias de 20 puntúa 1,0 y se abre
 * cualquier cosa. Un parcial perfecto entre strings de largo parecido vale 0,95;
 * si uno es mucho más largo que el otro, 0,85.
 */
function puntoBase(q: string, a: string): number {
  if (!q.length || !a.length) return 0;
  if (q === a) return 1;
  if (q.length < LARGO_MIN_FUZZY) return 0;

  let puntaje = similitud(q, a);

  const corto = Math.min(q.length, a.length);
  const largo = Math.max(q.length, a.length);
  if (corto >= LARGO_MIN_PARCIAL) {
    const castigo = corto / largo >= 0.6 ? 0.95 : 0.85;
    puntaje = Math.max(puntaje, parcial(q, a) * castigo);
  }
  return puntaje;
}

/**
 * Puntaje de 0 a 1 entre lo que se dijo y un alias cargado.
 *
 * Además de la frase entera se puntúa cada palabra por separado, con un castigo.
 * Es lo que resuelve el nombre largo contra el alias corto: "visual estudio code"
 * comparado entero contra "vscode" da 0,57 (hay 11 letras que sobran y cuentan
 * todas como error), pero la palabra "code" sola da 0,95. Sin esta señal, el caso
 * caía en "preguntá" y Lucas perdía un turno entero de conversación para algo que
 * no tenía ninguna duda razonable.
 *
 * Solo entran palabras de 4 letras o más: con 3, la coincidencia es azar.
 */
export function puntuar(consulta: string, alias: string): number {
  const a = compactar(alias);
  if (!a.length) return 0;

  let puntaje = puntoBase(compactar(consulta), a);
  if (puntaje === 1) return 1;

  const tokens = String(consulta).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length > 1) {
    for (const tok of tokens) {
      const t = compactar(tok);
      if (t.length < LARGO_MIN_PARCIAL) continue;
      puntaje = Math.max(puntaje, puntoBase(t, a) * CASTIGO_TOKEN);
    }
  }
  return puntaje;
}

// ---------------------------------------------------------------------------
// Umbrales
// ---------------------------------------------------------------------------

/**
 * Los tres números que deciden si se abre algo, se pregunta o se avisa.
 *
 * Elegidos MIDIENDO contra la tabla real, no a ojo — ver `scripts/probar-targets.mjs`.
 * Sobre 20 entradas de STT, la peor variante legítima ("yutub" → youtube) puntúa
 * 0,76 y el mejor candidato equivocado de toda la batería ("notion", que no está
 * cargado) puntúa 0,47. Entre 0,47 y 0,76 hay un valle vacío: cualquier corte ahí
 * adentro da los mismos 20 aciertos, así que se elige por criterio y no por dato.
 *
 * El corte no va en el medio del valle (0,61) sino más arriba porque el costo de
 * equivocarse no es simétrico: preguntar de más cuesta un turno de conversación,
 * abrir la app equivocada es lo único irreversible de todo este camino. 0,68 deja
 * 0,08 de aire sobre la peor transcripción buena y 0,21 sobre el mejor invento.
 *
 * ⚠️ Este número depende de qué tan parecidos entre sí sean los aliases cargados.
 * Cuando el script de escaneo de Windows precargue decenas de filas, volvé a
 * correr la prueba: si el valle se cierra, avisa solo.
 */
export const UMBRAL_ALTO = 0.68;
/** Debajo de esto ni se ofrece como candidato: es un parecido de casualidad. */
export const UMBRAL_DUDA = 0.5;
/**
 * Si el segundo está a menos de esto del primero, no hay ganador: se pregunta.
 * Con "chrome" y "chrome canary" en la misma tabla, el puntaje solo no alcanza.
 */
export const MARGEN = 0.06;
/** Cuántos candidatos se le ofrecen al modelo para que pregunte. Más es un menú. */
const MAX_CANDIDATOS = 3;

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

/** Puntúa la lista entera y ordena de mejor a peor. Exportada para la prueba. */
export function rankear(consulta: string, targets: Target[]): Candidato[] {
  return targets
    .map((t) => ({ alias: t.alias, tipo: t.tipo, puntaje: puntuar(consulta, t.alias) }))
    .sort((x, y) => y.puntaje - x.puntaje);
}

/** Aplica los umbrales a una lista ya puntuada. Separada para poder probarla sin red. */
export function decidir(consulta: string, targets: Target[]): Resolucion {
  if (!targets.length) return { estado: "sin_match" };

  const puntajes = targets
    .map((t) => ({ t, puntaje: puntuar(consulta, t.alias) }))
    .sort((x, y) => y.puntaje - x.puntaje);

  const [mejor, segundo] = puntajes;
  if (mejor.puntaje < UMBRAL_DUDA) return { estado: "sin_match" };

  // Un exacto gana siempre y no pasa por el margen de empate. Sin esta línea,
  // teniendo "spotify" y "spotify web" cargados, decir "spotify" quedaba ambiguo
  // (1,00 contra 0,95) y preguntaba por algo que Lucas había dicho tal cual.
  // Dos exactos a la vez no puede haber: el alta rechaza el alias duplicado.
  const empatado =
    mejor.puntaje < 1 && segundo !== undefined && mejor.puntaje - segundo.puntaje < MARGEN;

  if (mejor.puntaje >= UMBRAL_ALTO && !empatado) {
    return {
      estado: "resuelto",
      target: mejor.t,
      exacto: mejor.puntaje === 1,
      puntaje: mejor.puntaje,
    };
  }

  return {
    estado: "ambiguo",
    candidatos: puntajes
      .filter((p) => p.puntaje >= UMBRAL_DUDA)
      .slice(0, MAX_CANDIDATOS)
      .map(({ t, puntaje }) => ({ alias: t.alias, tipo: t.tipo, puntaje })),
  };
}

/** Techo de filas que se traen. La tabla es chica; esto es para que siga siéndolo. */
const MAX_FILAS = 500;

/** Trae la tabla entera. Son decenas de filas de tres campos: una query y listo. */
export async function listarTargets(
  sb: SupabaseClient,
): Promise<{ targets: Target[]; error?: string }> {
  const { data, error } = await sb
    .from("targets")
    .select("id,alias,tipo,valor,aprobado")
    .limit(MAX_FILAS);
  if (error) return { targets: [], error: error.message };
  return { targets: (data ?? []) as Target[] };
}

/**
 * Punto de entrada: del alias dicho a una fila, o a una pregunta.
 *
 * No filtra por `aprobado`: una app cargada y sin aprobar tiene que resolver igual,
 * para poder contestar "está cargado pero no lo habilitaste" en vez de "no existe",
 * que manda a Lucas a registrar algo que ya estaba. El cerrojo se aplica después.
 */
export async function resolverAlias(sb: SupabaseClient, alias: string): Promise<Resolucion> {
  const q = String(alias ?? "").trim();
  if (!q) return { estado: "sin_match" };

  const { targets, error } = await listarTargets(sb);
  if (error) return { estado: "error", motivo: error };
  return decidir(q, targets);
}

// ---------------------------------------------------------------------------
// Alta
// ---------------------------------------------------------------------------

export type AltaTarget = { alias: string; tipo: string; valor: string };
export type ResultadoAlta =
  | { ok: true; alias: string; tipo: TipoTarget; aprobado: boolean; nota?: string }
  | { ok: false; motivo: string };

const ALIAS_MAX = 40;
/** Letras, números, espacios y guiones. Nada de rutas ni comodines metidos de alias. */
const RE_ALIAS = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
/** Ruta absoluta de Windows: unidad con letra o UNC. Lo mismo que exige el ejecutor. */
const RE_RUTA_ABS = /^([a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/])/;

/**
 * Da de alta un target nuevo.
 *
 * La regla de seguridad del proyecto, textual: las filas de `tipo='app'` NACEN
 * con `aprobado = false` y las habilita Lucas a mano. Un `app` es una ruta a un
 * ejecutable que corre en su máquina personal, y el servicio de Railway está
 * expuesto a internet: si el camino "decir un nombre por voz" alcanzara para
 * ejecutar un binario nuevo, no habría cerrojo en ningún lado.
 *
 * `url`, `discord` y `carpeta` se aprueban solas porque el peor caso es una
 * pestaña de más.
 */
export async function registrarTarget(
  sb: SupabaseClient,
  input: AltaTarget,
): Promise<ResultadoAlta> {
  const alias = String(input?.alias ?? "").trim().replace(/\s+/g, " ");
  const tipo = String(input?.tipo ?? "").trim().toLowerCase();
  const valor = String(input?.valor ?? "").trim();

  if (!alias) return { ok: false, motivo: "Falta el alias." };
  if (alias.length > ALIAS_MAX) return { ok: false, motivo: "Ese alias es demasiado largo." };
  if (!RE_ALIAS.test(alias)) {
    return { ok: false, motivo: `El alias "${alias}" tiene caracteres raros. Solo letras, números, espacios y guiones.` };
  }
  if (!compactar(alias)) return { ok: false, motivo: "Ese alias queda vacío al normalizarlo." };
  if (!(TIPOS_TARGET as readonly string[]).includes(tipo)) {
    return { ok: false, motivo: `Tipo inválido: "${tipo}". Los que valen: ${TIPOS_TARGET.join(", ")}.` };
  }
  if (!valor) return { ok: false, motivo: "Falta el valor (la ruta, la URL o los IDs)." };

  const t = tipo as TipoTarget;

  // Validación por tipo. Es la MISMA que hace `ejecutor.py` en la máquina, repetida
  // acá a propósito: si el dato entra torcido, preferimos que falle al registrarlo
  // y no seis meses después, cuando lo abra y nadie se acuerde de dónde salió.
  if (t === "app" || t === "carpeta") {
    if (!RE_RUTA_ABS.test(valor)) {
      return { ok: false, motivo: "La ruta tiene que ser absoluta (C:\\... o \\\\servidor\\...)." };
    }
    if (valor.includes("..")) {
      return { ok: false, motivo: "La ruta no puede tener '..'." };
    }
    if (t === "app" && !/\.(exe|lnk|bat|cmd|com)$/i.test(valor)) {
      return { ok: false, motivo: "Una app tiene que apuntar a un ejecutable (.exe o .lnk)." };
    }
  } else if (t === "url") {
    let u: URL;
    try {
      u = new URL(valor);
    } catch {
      return { ok: false, motivo: `"${valor}" no es una URL válida.` };
    }
    // Solo http/https: `file://` leería el disco y los esquemas raros son el agujero.
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, motivo: "Solo se guardan URLs http o https." };
    }
  } else {
    // Discord: se guardan los IDs, la URI la arma el ejecutor con las partes ya
    // validadas como numéricas. Nunca una URI completa venida del modelo.
    const ok = valor.startsWith("@")
      ? /^\d{5,25}$/.test(valor.slice(1))
      : /^\d{5,25}\/\d{5,25}$/.test(valor);
    if (!ok) {
      return { ok: false, motivo: "Discord se guarda como 'guild/canal' o '@usuario', con IDs numéricos." };
    }
  }

  // Duplicado por alias normalizado, no por string: "You Tube" y "youtube" son el
  // mismo target, y dos filas que compactan igual empatarían para siempre en el
  // fuzzy match — quedaría preguntando "¿cuál de los dos?" sobre dos cosas iguales.
  const { targets, error } = await listarTargets(sb);
  if (error) return { ok: false, motivo: `No pude leer los targets: ${error}` };
  const choque = targets.find((x) => compactar(x.alias) === compactar(alias));
  if (choque) {
    return { ok: false, motivo: `Ya existe "${choque.alias}" (${choque.tipo}). Si querés cambiarlo, editalo en Supabase.` };
  }

  const aprobado = t !== "app";
  const { error: alta } = await sb.from("targets").insert({ alias, tipo: t, valor, aprobado });
  if (alta) return { ok: false, motivo: `No pude guardarlo: ${alta.message}` };

  return {
    ok: true,
    alias,
    tipo: t,
    aprobado,
    nota: aprobado
      ? undefined
      : "Queda cargado pero SIN aprobar: hasta que Lucas lo habilite a mano en Supabase, no se abre.",
  };
}

// ---------------------------------------------------------------------------

/**
 * La herramienta `registrar_target`, lista para enchufar.
 *
 * ⚠️ NO está en el array `TOOLS` de `tools.ts`: el encargo de esta tanda decía
 * explícitamente no tocar ese array. Enchufarla es agregar `TOOL_REGISTRAR_TARGET`
 * a la lista, una línea. Hasta que eso pase, el modelo no la ve y `abrir` se limita
 * a avisar que el alias no existe.
 *
 * Cuando se enchufe, ojo con dos cosas: `canales: ["pc"]` (Telegram no tiene por
 * qué dar de alta ejecutables de una máquina que no está escuchando) y `esAccion`
 * en false a propósito — un alta no devuelve ninguna acción para ejecutar y hay
 * que dejar que el modelo redacte, sobre todo para avisar que quedó sin aprobar.
 */
export const TOOL_REGISTRAR_TARGET: Tool = {
  name: "registrar_target",
  description:
    "Guarda algo nuevo para poder abrirlo después por su alias. Usar SOLO cuando `abrir` avisó " +
    "que no tiene nada cargado con ese nombre y Lucas te pasó el dato. " +
    "`valor` es la ruta absoluta del .exe para 'app', la URL completa para 'url', " +
    "'guild/canal' o '@usuario' con IDs numéricos para 'discord', y la ruta de la carpeta para " +
    "'carpeta'. NUNCA inventes una ruta ni una URL: si no te la dio, pedísela.",
  input_schema: {
    type: "object",
    properties: {
      alias: { type: "string", description: "Cómo lo va a nombrar. Una o dos palabras." },
      tipo: { type: "string", enum: [...TIPOS_TARGET] },
      valor: { type: "string", description: "La ruta, la URL o los IDs. Tal cual te lo dio." },
    },
    required: ["alias", "tipo", "valor"],
  },
  canales: ["pc"],
  handler: (sb, input) =>
    registrarTarget(sb, {
      alias: String(input?.alias ?? ""),
      tipo: String(input?.tipo ?? ""),
      valor: String(input?.valor ?? ""),
    }),
};
