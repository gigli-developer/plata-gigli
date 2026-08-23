import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCategories, fetchPaymentMethods, fetchTransactionsRange, type NewTx } from "../db";
import { hoy as hoyAr, sumarDias } from "../fechas";
import { CRITERIOS } from "./criterios";
import { guardar, VENCE_MIN } from "./propuestas";
import { PRECIOS, claveAnthropic, paraDecir } from "./web";
import type { Tool } from "./tools";

/**
 * La capa de razonamiento: dos sub-agentes con el molde de `investigar_en_la_web`.
 *
 * Gemini Live está optimizado para turnos, no para razonar — y tiene PROHIBIDO
 * calcular (`numeros.py` lo corrige si dice una cifra sin respaldo). Esa regla es
 * correcta y deja un hueco: cuando algo pide pensar, no había nadie habilitado.
 * Estos dos lo llenan sin tocar las tres redes:
 *
 *   · `plata_interpretar` — el razonamiento que TERMINA EN UN REGISTRO. Recibe lo
 *     dicho crudo, una sola llamada a Sonnet (sin ciclo de tools: eso lo hace
 *     barato y rápido), y desemboca en el camino de siempre: propone → tarjeta →
 *     tu sí → `confirmar`. No ejecuta nada por su cuenta.
 *
 *   · `pensar` — el razonamiento que DEVUELVE UNA CONCLUSIÓN. Solo lectura, con
 *     su propia lista corta de herramientas de Plata y tope de 4 llamadas (el
 *     equivalente del tope de 2 búsquedas de web.ts). Al hilo de voz vuelven dos
 *     o tres frases; los agregados crudos mueren acá adentro.
 *
 * El principio que resuelve todo: **el sub-agente recibe herramientas, no
 * datos**. Nunca ve las 30.000 filas — junta 3 o 4 agregados y razona sobre eso.
 * Y la aritmética pesada no la hace el modelo: la hacen las herramientas, que ya
 * la hacen. La regla de «Gemini no calcula» vale igual para Opus.
 */

// ---------------------------------------------------------------------------
// Modelos y costo — un modelo POR USO, no uno global
// ---------------------------------------------------------------------------

/** Interpretar un gasto no necesita el mismo músculo que aconsejar sobre uno. */
export const MODELO_INTERPRETAR = process.env.AGENT_MODEL_INTERPRETAR ?? "claude-sonnet-5";
export const MODELO_PENSAR = process.env.AGENT_MODEL_PENSAR ?? "claude-opus-5";

const TIMEOUT_MS = 25_000;

type Uso = Record<string, number> | undefined;
function sumarCosto(costo: { usd: number; entrada: number; salida: number }, u: Uso, modelo: string) {
  const p = PRECIOS[modelo] ?? PRECIOS["claude-opus-5"];
  costo.entrada += (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
  costo.salida += u?.output_tokens ?? 0;
  costo.usd +=
    ((u?.input_tokens ?? 0) * p.in +
      (u?.output_tokens ?? 0) * p.out +
      // La escritura de caché se cobra 25% más cara que la entrada normal.
      (u?.cache_creation_input_tokens ?? 0) * p.in * 1.25 +
      (u?.cache_read_input_tokens ?? 0) * p.cacheRead) / 1e6;
}

async function llamarApi(apiKey: string, body: unknown): Promise<{
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
  usage?: Record<string, number>;
  status: number;
  ok: boolean;
}> {
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    return { ...data, status: r.status, ok: r.ok };
  } finally {
    clearTimeout(reloj);
  }
}

// ---------------------------------------------------------------------------
// Compartido: resolver nombres como lo hace el resto del archivo de tools
// ---------------------------------------------------------------------------

const plano = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const porNombre = <T extends { name: string }>(lista: T[], nombre: string): T | null =>
  lista.find((x) => plano(x.name) === plano(nombre)) ??
  lista.find((x) => plano(x.name).includes(plano(nombre))) ?? null;

/** es-AR sin decimales: 154000 → "154.000". Copia local, mismo patrón anti-ciclo de acciones-plata. */
const numero = (n: number) =>
  Math.round(n).toLocaleString("es-AR", { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// 1 · plata_interpretar
// ---------------------------------------------------------------------------

const EMITIR = {
  name: "emitir",
  description: "Tu única salida: la interpretación estructurada de lo que dijo.",
  input_schema: {
    type: "object",
    properties: {
      accion: {
        type: "string",
        enum: ["movimientos", "division", "pregunta"],
        description:
          "movimientos = uno o más gastos/ingresos listos para proponer. division = un " +
          "gasto compartido (lo ejecuta plata_dividir). pregunta = falta UN dato y no " +
          "conviene adivinar.",
      },
      porque: {
        type: "string",
        description:
          "UNA línea con el razonamiento, para la tarjeta: «lo dividí en tres porque " +
          "dijiste “entre los chicos”». Es donde él caza un error de interpretación.",
      },
      movimientos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tipo: { type: "string", enum: ["ingreso", "egreso"] },
            monto: { type: "number" },
            moneda: { type: "string", enum: ["ARS", "USD", "USDT"] },
            categoria: { type: "string", description: "EXACTA de la lista del contexto, o vacío." },
            metodo: { type: "string", description: "EXACTO de la lista del contexto, o vacío." },
            descripcion: { type: "string" },
            fecha: { type: "string", description: "YYYY-MM-DD solo si NO es hoy." },
          },
          required: ["tipo", "monto", "descripcion"],
        },
      },
      division: {
        type: "object",
        properties: {
          total: { type: "number" },
          puse: { type: "number" },
          mi_parte: { type: "number" },
          descripcion: { type: "string" },
          categoria: { type: "string" },
          personas: {
            type: "array",
            items: {
              type: "object",
              properties: { nombre: { type: "string" }, puso: { type: "number" } },
              required: ["nombre"],
            },
          },
        },
        required: ["total", "puse", "descripcion", "personas"],
      },
      pregunta: {
        type: "object",
        properties: {
          texto: { type: "string" },
          opciones: { type: "array", items: { type: "string" } },
        },
        required: ["texto"],
      },
    },
    required: ["accion", "porque"],
  },
};

const promptInterpretar = () =>
  `Interpretás pedidos hablados sobre la plata de Lucas y los convertís en registros
estructurados. NO conversás: tu única salida es la herramienta \`emitir\`.

${CRITERIOS}

Reglas:
- El monto que dijo ES el monto. No lo corrijas porque te parezca raro.
- En una división, \`personas\` son SOLO los otros — Lucas jamás va en la lista. Y los
  nombres son OBLIGATORIOS (cada uno queda debiendo plata): si no los dijo, emití
  \`pregunta\` pidiéndolos. JAMÁS inventes nombres tipo "Chico 1" — un nombre inventado
  se convierte en una persona fantasma con una deuda real.
- La aritmética simple del reparto la podés hacer (mitades, "menos las 5 lucas que puso");
  la división de un gasto compartido NO: eso se emite como \`division\` y la calcula la
  herramienta plata_dividir, que es la que sabe.
- Si nombra algo de los últimos movimientos ("como ayer", "otra vez lo del chino"),
  usá ese contexto para completar categoría y descripción.
- Categoría y método: SOLO de las listas del contexto, escritos exactos. Si ninguna
  calza, dejalo vacío — mejor sin categoría que una inventada.
- Si falta UN dato que cambia el registro (¿con qué pagó?, ¿son pesos o dólares?),
  emití \`pregunta\` con ese único dato y opciones cortas. Una sola pregunta.
- \`porque\` siempre: una línea, en criollo, con lo que decidiste vos.`;

let costoInterpretar = { usd: 0, entrada: 0, salida: 0 };
export const costoDeLaUltimaInterpretacion = () => costoInterpretar;

const plataInterpretar: Tool = {
  name: "plata_interpretar",
  description:
    "Interpreta un pedido de plata ENREDADO y lo convierte en la propuesta correcta: " +
    "varios gastos en una frase, restas de por medio ('gasté 40 pero 15 me los devolvió " +
    "mi vieja'), referencias a movimientos previos ('lo mismo que ayer'), o cuando no " +
    "estás seguro de cómo estructurarlo. Pasale el TEXTO CRUDO tal como lo dijo — no lo " +
    "proceses vos: el que interpreta es un modelo más fuerte con el contexto de sus " +
    "categorías y últimos movimientos.\n" +
    "Para un gasto simple y claro ('cargá 15 lucas de sushi') seguí usando " +
    "`plata_registrar` directo, que es más rápido.\n" +
    "Devuelve una propuesta (la confirma él), una derivación a `plata_dividir`, o UNA " +
    "pregunta si falta un dato.",
  input_schema: {
    type: "object",
    properties: {
      dicho: {
        type: "string",
        description:
          "Lo que dijo, CRUDO y completo. Si esto responde una pregunta previa de esta " +
          "misma herramienta, incluí también lo dicho antes.",
      },
    },
    required: ["dicho"],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    const dicho = String(input?.dicho ?? "").trim();
    if (!dicho) return { ok: false, motivo: "No me pasaste qué dijo." };
    if (dicho.length > 600) return { ok: false, motivo: "Demasiado largo para interpretar de una." };

    const apiKey = await claveAnthropic(sb);
    const dHoy = hoyAr();
    // El contexto mínimo del plan: categorías, métodos y los últimos movimientos.
    const [cats, mets, recientes] = await Promise.all([
      fetchCategories(sb),
      fetchPaymentMethods(sb),
      fetchTransactionsRange(sb, sumarDias(dHoy, -7), dHoy, undefined, 12),
    ]);

    const contexto =
      `HOY: ${dHoy}\n` +
      `CATEGORÍAS: ${cats.map((c) => c.name).join(", ")}\n` +
      `MÉTODOS DE PAGO: ${mets.map((m) => m.name).join(", ")}\n` +
      `ÚLTIMOS MOVIMIENTOS (7 días):\n` +
      (recientes.slice(0, 12).map((t) =>
        `- ${t.type === "egreso" ? "-" : "+"}${numero(t.amount)} ${t.currency} ${t.desc}` +
        `${t.category ? ` (${t.category})` : ""}`).join("\n") || "- (ninguno)");

    const costo = { usd: 0, entrada: 0, salida: 0 };
    let data: Awaited<ReturnType<typeof llamarApi>>;
    try {
      data = await llamarApi(apiKey, {
        model: MODELO_INTERPRETAR,
        max_tokens: 800,
        // El prompt y el schema son estables: se marcan para caché y las
        // interpretaciones siguientes pagan el 10% de ese prefijo.
        system: [{ type: "text", text: promptInterpretar(), cache_control: { type: "ephemeral" } }],
        tools: [EMITIR],
        tool_choice: { type: "tool", name: "emitir" },
        messages: [{ role: "user", content: `${contexto}\n\nDIJO: «${dicho}»` }],
      });
    } catch (e) {
      const abortado = e instanceof Error && e.name === "AbortError";
      return { ok: false, motivo: abortado ? "El intérprete tardó demasiado." : "No pude interpretar." };
    } finally {
      // nada: el costo se suma abajo con `data.usage` si hubo respuesta
    }
    sumarCosto(costo, data.usage, MODELO_INTERPRETAR);
    costoInterpretar = costo;
    console.log(`[interpretar] ${costo.entrada} in / ${costo.salida} out · US$ ${costo.usd.toFixed(4)} · ${MODELO_INTERPRETAR}`);

    if (!data.ok) return { ok: false, motivo: `El intérprete contestó ${data.status}.` };
    const tu = (data.content ?? []).find((b) => b.type === "tool_use");
    const r = (tu?.input ?? null) as {
      accion?: string; porque?: string;
      movimientos?: { tipo?: string; monto?: number; moneda?: string; categoria?: string; metodo?: string; descripcion?: string; fecha?: string }[];
      division?: { total?: number; puse?: number; mi_parte?: number; descripcion?: string; categoria?: string; personas?: { nombre?: string; puso?: number }[] };
      pregunta?: { texto?: string; opciones?: string[] };
    } | null;
    if (!r?.accion) return { ok: false, motivo: "El intérprete no emitió nada usable." };
    const porque = String(r.porque ?? "").trim();

    // --- falta un dato: UNA pregunta, con la tarjeta de elección ---
    if (r.accion === "pregunta") {
      const texto = String(r.pregunta?.texto ?? "").trim() || "Me falta un dato.";
      const opciones = (r.pregunta?.opciones ?? []).map(String).filter(Boolean).slice(0, 4);
      return {
        ok: false,
        motivo: texto,
        opciones,
        que_hacer:
          "Preguntáselo tal cual y volvé a llamar plata_interpretar con el dicho original " +
          "MÁS su respuesta. No propongas nada todavía.",
        ...(opciones.length ? {
          panel: {
            tipo: "eleccion", titulo: "", sub: dicho.slice(0, 60), pregunta: texto,
            opciones: opciones.map((v) => ({ v })),
          },
        } : {}),
      };
    }

    // --- gasto compartido: lo calcula la herramienta que sabe, no este modelo ---
    if (r.accion === "division") {
      const d = r.division ?? {};
      return {
        ok: true,
        derivar: "plata_dividir",
        parametros: {
          total: d.total, puse: d.puse,
          // `!= null` y no `!== undefined`: el modelo emite null para "no lo dijo",
          // y un mi_parte null llegaba a plata_dividir como 0 y la volteaba.
          ...(d.mi_parte != null ? { mi_parte: d.mi_parte } : {}),
          descripcion: d.descripcion,
          ...(d.categoria ? { categoria: d.categoria } : {}),
          personas: (d.personas ?? []).map((p) => ({
            nombre: p.nombre, ...(p.puso != null ? { puso: p.puso } : {}),
          })),
        },
        para_decir: porque,
        que_hacer:
          "Es una división: llamá YA a plata_dividir con exactamente estos `parametros`, " +
          "sin cambiarles nada. Esa herramienta calcula las partes y propone.",
      };
    }

    // --- movimientos: desembocan en el MISMO lote que plata_registrar ---
    const crudos = (r.movimientos ?? []).filter((m) => Number(m?.monto) > 0 && m?.descripcion);
    if (!crudos.length) return { ok: false, motivo: "No salió ningún movimiento válido de ahí." };
    if (crudos.length > 12) return { ok: false, motivo: "Demasiados movimientos para una sola tanda." };

    const filas = crudos.map((item) => {
      const cat = item.categoria ? porNombre(cats, String(item.categoria)) : null;
      const met = item.metodo ? porNombre(mets, String(item.metodo)) : null;
      const fecha = String(item.fecha ?? dHoy).slice(0, 10);
      const tx: NewTx = {
        type: (item.tipo === "ingreso" ? "ingreso" : "egreso"),
        amount: Number(item.monto),
        currency: String(item.moneda ?? "ARS"),
        categoryId: cat?.id ?? null,
        paymentMethodId: met?.id ?? null,
        description: String(item.descripcion),
        occurredAt: `${fecha}T12:00:00-03:00`,
      };
      return { tx, cat };
    });

    const p = guardar({ dominio: "plata", tipo: "crear", txNuevas: filas.map((f) => f.tx) });

    // Total por moneda, sin mezclar (regla del proyecto).
    const porMoneda = new Map<string, number>();
    for (const f of filas) {
      const signo = f.tx.type === "egreso" ? -1 : 1;
      porMoneda.set(f.tx.currency, (porMoneda.get(f.tx.currency) ?? 0) + signo * f.tx.amount);
    }
    const montoTotal = [...porMoneda.entries()]
      .map(([mon, tot]) => `${tot < 0 ? "-" : "+"}${mon === "ARS" ? "" : mon + " "}${numero(Math.abs(tot))}`)
      .join(" · ");

    return {
      ok: true,
      propuesta: {
        id: p.id, dominio: "plata", tipo: "crear", antes: null,
        monto: montoTotal,
        sub: filas.length === 1 ? filas[0].tx.description : `${filas.length} movimientos`,
        lista_rica: filas.map((f) => ({
          monto: `${f.tx.type === "egreso" ? "-" : "+"}${f.tx.currency === "ARS" ? "" : f.tx.currency + " "}${numero(f.tx.amount)}`,
          titulo: f.tx.description ?? "",
          detalle: f.cat?.name,
        })),
        // El razonamiento A LA VISTA: acá se caza una interpretación torcida,
        // igual que el monto grande caza el «quince mil» → «cincuenta mil».
        aviso: porque || undefined,
        aviso_tono: "azul",
        vence_min: VENCE_MIN,
      },
      para_decir:
        `${porque ? porque + " " : ""}` +
        (filas.length === 1
          ? `Cargar ${montoTotal} de ${filas[0].tx.description}.`
          : `Cargar ${filas.length} movimientos (${montoTotal} en total).`),
      que_hacer: `Contale cómo lo interpretaste y ESPERÁ el sí. Si confirma, confirmar con id "${p.id}".`,
    };
  },
};

// ---------------------------------------------------------------------------
// 2 · pensar
// ---------------------------------------------------------------------------

/**
 * La lista corta del sub-agente. NO son las 35: pagar ~7.000 tokens de esquemas
 * para un trabajo que usa cuatro sería tirar el presupuesto. Y es FIJA, para
 * que el prefijo del sub-agente cachee igual que el del canal principal.
 */
const TOOLS_PENSAR = [
  "estado_financiero", "gastos_por_categoria", "transacciones_ver", "tarjetas_ver",
  "deudas_con_personas", "compromisos_futuros", "proyeccion_fin_de_mes",
  "cotizaciones", "patrimonio_evolucion",
] as const;

const MAX_LLAMADAS = 4;   // el equivalente del tope de 2 búsquedas de web.ts
const MAX_VUELTAS = 7;    // llamadas a la API: 4 de tools + la de cierre + margen

let esquemasPensar: { name: string; description: string; input_schema: unknown; cache_control?: unknown }[] | null = null;

const promptPensar = () =>
  `Analizás las finanzas de Lucas y contestás UNA pregunta con una conclusión corta.

${CRITERIOS}

Cómo trabajás:
- Tenés herramientas de SOLO LECTURA sobre sus datos reales. Llamá las que necesites
  (máximo ${MAX_LLAMADAS}) y razoná sobre los agregados que devuelven.
- TODO número que digas tiene que salir de una herramienta o ser una cuenta simple y
  visible entre dos de ellos («la diferencia son…»). Nunca estimes de memoria.
- No propongas registrar nada ni digas que hiciste cambios: sos solo lectura.
- Si los datos no alcanzan para responder, decilo y qué faltaría.

El formato de salida es para un PARLANTE: DOS O TRES FRASES, español argentino, voseo,
sin viñetas ni markdown ni símbolos. Los números como se pronuncian. Primero la
conclusión, después el porqué en una frase.`;

let costoPensar = { usd: 0, entrada: 0, salida: 0, llamadas: 0 };
export const costoDelUltimoPensar = () => costoPensar;

const pensar: Tool = {
  name: "pensar",
  description:
    "Analiza SU situación financiera real y devuelve una conclusión razonada: '¿me " +
    "conviene X o Y?', '¿estoy gastando más que antes?', '¿puedo afrontar tal cosa?', " +
    "'¿qué pasa si…?'. Un analista consulta sus datos y piensa la respuesta.\n" +
    "Tarda varios segundos: avisale antes ('dejame pensarlo un momento').\n" +
    "Devuelve la respuesta YA REDACTADA para voz: repetila tal cual, no le cambies " +
    "ningún número.\n" +
    "⚠️ NO es para consultas simples ('¿cuánto gasté?' va directo a la herramienta) ni " +
    "para cosas del mundo (eso es investigar_en_la_web). Es para cuando hay que RAZONAR " +
    "sobre sus números.",
  input_schema: {
    type: "object",
    properties: {
      pregunta: {
        type: "string",
        description:
          "La pregunta completa y autocontenida, con todo el contexto que dio " +
          "('¿me conviene pagar el resumen de 300 lucas de una o en 3 cuotas al 12%?').",
      },
    },
    required: ["pregunta"],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    const pregunta = String(input?.pregunta ?? "").trim();
    if (!pregunta) return { ok: false, motivo: "No me dijiste qué pensar." };

    const apiKey = await claveAnthropic(sb);
    // Import dinámico para no cerrar el ciclo tools → razonar → tools en la
    // carga del módulo: acá adentro ya está todo inicializado.
    const { ejecutarTool, toolPorNombre } = await import("./tools");

    if (!esquemasPensar) {
      esquemasPensar = TOOLS_PENSAR.map((n) => {
        const t = toolPorNombre(n);
        if (!t) throw new Error(`pensar: no existe la herramienta ${n}`);
        return { name: t.name, description: t.description, input_schema: t.input_schema };
      });
      // El breakpoint de caché va en el último bloque del prefijo.
      esquemasPensar[esquemasPensar.length - 1].cache_control = { type: "ephemeral" };
    }

    const costo = { usd: 0, entrada: 0, salida: 0, llamadas: 0 };
    const mensajes: unknown[] = [{ role: "user", content: pregunta }];
    let texto = "";

    try {
      for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
        const data = await llamarApi(apiKey, {
          model: MODELO_PENSAR,
          max_tokens: 700,
          system: [{ type: "text", text: promptPensar(), cache_control: { type: "ephemeral" } }],
          tools: esquemasPensar,
          messages: mensajes,
        });
        sumarCosto(costo, data.usage, MODELO_PENSAR);
        if (!data.ok) return { ok: false, motivo: `el analista contestó ${data.status}` };

        const bloques = data.content ?? [];
        texto = bloques.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();

        if (data.stop_reason !== "tool_use") break;

        mensajes.push({ role: "assistant", content: bloques });
        const resultados: unknown[] = [];
        for (const b of bloques) {
          if (b.type !== "tool_use") continue;
          costo.llamadas++;
          if (costo.llamadas > MAX_LLAMADAS) {
            resultados.push({
              type: "tool_result", tool_use_id: b.id,
              content: "Tope de consultas alcanzado: respondé con lo que ya tenés.",
            });
            continue;
          }
          const salida = await ejecutarTool(sb, String(b.name), (b.input ?? {}) as Record<string, unknown>, "pc");
          // El panel es para la cara del hilo principal; acá solo infla la cuenta.
          const limpio = salida && typeof salida === "object"
            ? Object.fromEntries(Object.entries(salida as Record<string, unknown>).filter(([k]) => k !== "panel"))
            : salida;
          resultados.push({
            type: "tool_result", tool_use_id: b.id,
            content: JSON.stringify(limpio).slice(0, 6000),
          });
        }
        mensajes.push({ role: "user", content: resultados });
      }
    } catch (e) {
      const abortado = e instanceof Error && e.name === "AbortError";
      return { ok: false, motivo: abortado ? "tardó demasiado" : (e instanceof Error ? e.message : String(e)) };
    } finally {
      costoPensar = costo;
      console.log(
        `[pensar] ${costo.llamadas} consulta(s) · ${costo.entrada} in / ${costo.salida} out · ` +
          `US$ ${costo.usd.toFixed(4)} · ${MODELO_PENSAR}`,
      );
    }

    const dicho = paraDecir(texto);
    if (!dicho) return { ok: false, motivo: "no llegué a una conclusión" };
    return {
      ok: true,
      respuesta: dicho,
      nota:
        "Ya está pensado sobre sus datos reales y redactado para voz. Repetilo tal cual " +
        "o casi: no agregues números tuyos ni cambies los que trae.",
    };
  },
};

export const TOOLS_RAZONAR: Tool[] = [plataInterpretar, pensar];
