import type { Tool } from "./tools";
// ⚠️ El corte del período sale de fechas.ts, nunca de `toISOString().slice`:
// el servidor corre en UTC y el usuario en UTC-3 (gotcha histórico del proyecto).
import { hoy as hoyAr, sumarDias, desdeElDia, mesActual } from "../fechas";

/**
 * ¿Cuánto está gastando Jarvis en modelos?
 *
 * Cada sub-llamada a la API (pensar / interpretar / web) deja su fila en
 * `costos_llamadas` vía `registrarCosto` (web.ts). Esta herramienta las agrupa
 * por período y contesta la pregunta que antes moría en el log de Railway.
 *
 * Dos cosas para no confundirse:
 *  · `pensar` acumula el costo POR CONVERSACIÓN en `pensar_sesiones`; acá está
 *    el turno a turno. Se suman los turnos, no las sesiones: sumar los dos
 *    lados sería contar lo mismo dos veces.
 *  · El motor de voz de Gemini NO está: se factura aparte (Google) y este
 *    servidor no lo ve pasar. El "total" de acá es el de las consultas, no el
 *    de Jarvis entero — la salvedad va SIEMPRE en la respuesta.
 */

// ---------------------------------------------------------------------------
// Períodos y formato
// ---------------------------------------------------------------------------

/**
 * Los tres cortes que se entienden por voz. `semana` son los últimos 7 días
 * INCLUYENDO hoy (mismo criterio que "ultimos_7_dias" en fechas.ts) y `mes` es
 * el mes calendario en curso, no "los últimos 30 días".
 */
const PERIODOS_COSTOS: Record<string, { corte: () => string; etiqueta: "hoy" | "esta semana" | "este mes" }> = {
  hoy: { corte: () => desdeElDia(hoyAr()), etiqueta: "hoy" },
  semana: { corte: () => desdeElDia(sumarDias(hoyAr(), -6)), etiqueta: "esta semana" },
  mes: { corte: () => desdeElDia(`${mesActual()}-01`), etiqueta: "este mes" },
};

/** Cómo se nombra cada herramienta en voz alta: "pensar" pelado no le dice nada a nadie. */
const EN_CRIOLLO: Record<string, string> = {
  pensar: "el analista",
  interpretar: "el intérprete de gastos",
  web: "la búsqueda web",
};

/** "0,84": coma decimal es-AR y SIEMPRE dos decimales. Es el contrato exacto con la cara. */
const usd2 = (n: number) =>
  n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// La herramienta
// ---------------------------------------------------------------------------

const costosVer: Tool = {
  name: "costos_ver",
  description:
    "Cuánto está gastando Jarvis en modelos: el costo de las consultas de razonamiento, " +
    "interpretación y búsqueda. Usar para '¿cuánto gastaste?', '¿cuánto me salió el " +
    "analista?', '¿qué costo llevan las consultas?'. ⚠️ NO incluye el motor de voz de " +
    "Gemini (se factura aparte y no está medido acá): decilo si pregunta por el total.",
  input_schema: {
    type: "object",
    properties: {
      periodo: {
        type: "string",
        enum: ["hoy", "semana", "mes"],
        description:
          "Qué ventana contar: hoy (el día argentino), semana (los últimos 7 días, " +
          "incluyendo hoy) o mes (el mes calendario en curso). Si no aclara, semana.",
      },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    const nombre = input?.periodo ? String(input.periodo).trim().toLowerCase() : "semana";
    const p = PERIODOS_COSTOS[nombre];
    if (!p) return { ok: false, motivo: `No conozco el período "${nombre}": va hoy, semana o mes.` };
    const corte = p.corte();

    // Filas crudas y suma acá, no agregación SQL: son decenas de filas chicas
    // por período y PostgREST no agrega sin una RPC — no vale una función más
    // en la base para esto. Si algún día la tabla crece de verdad, se migra.
    const [llamadas, sesiones] = await Promise.all([
      sb.from("costos_llamadas").select("herramienta,usd,tokens_entrada,tokens_salida").gte("creada", corte),
      // Cuántas CONVERSACIONES del analista arrancaron en el período, para el
      // detalle "N conversaciones" (7 llamadas de pensar pueden ser 2 charlas).
      sb.from("pensar_sesiones").select("costo_usd").gte("creada", corte),
    ]);
    if (llamadas.error) return { ok: false, motivo: `No pude leer los costos: ${llamadas.error.message}` };

    const por = new Map<string, { usd: number; llamadas: number; entrada: number; salida: number }>();
    for (const r of llamadas.data ?? []) {
      const s = por.get(r.herramienta) ?? { usd: 0, llamadas: 0, entrada: 0, salida: 0 };
      // `usd` es numeric: Number() por las dudas, mismo trato que le da
      // razonar.ts al `costo_usd` de las sesiones.
      s.usd += Number(r.usd ?? 0);
      s.llamadas += 1;
      s.entrada += Number(r.tokens_entrada ?? 0);
      s.salida += Number(r.tokens_salida ?? 0);
      por.set(r.herramienta, s);
    }

    // Ordenado por plata, no alfabético: la primera fila es la respuesta a
    // "¿qué es lo que más me está costando?".
    const porHerramienta = [...por.entries()]
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([herramienta, s]) => ({
        herramienta,
        usd: Number(s.usd.toFixed(4)),
        llamadas: s.llamadas,
        entrada: s.entrada,
        salida: s.salida,
      }));
    // El total se suma sobre los crudos y se redondea UNA vez (misma lección
    // que gastos_por_categoria: sumar redondeos deja el total descolgado).
    const totalCrudo = [...por.values()].reduce((a, s) => a + s.usd, 0);

    // Si `pensar_sesiones` falla se pierde el detalle de conversaciones y nada más.
    const convs = sesiones.data?.length ?? 0;
    const costoConvs = (sesiones.data ?? []).reduce((a, r) => a + Number(r.costo_usd ?? 0), 0);

    const masCara = porHerramienta[0];
    const para_decir = masCara
      ? `${cap(p.etiqueta)} las consultas salieron US$ ${usd2(totalCrudo)}, y lo que más costó ` +
        `fue ${EN_CRIOLLO[masCara.herramienta] ?? masCara.herramienta}: US$ ${usd2(masCara.usd)} ` +
        `en ${masCara.llamadas === 1 ? "una llamada" : `${masCara.llamadas} llamadas`}. ` +
        `Ojo: eso no incluye el motor de voz de Gemini, que se factura aparte y no está medido acá.`
      : `${cap(p.etiqueta)} no hay ninguna consulta registrada: US$ 0,00 en modelos. ` +
        `Ojo: el motor de voz de Gemini se factura aparte y no está medido acá.`;

    return {
      ok: true,
      periodo: p.etiqueta,
      total_usd: Number(totalCrudo.toFixed(4)),
      por_herramienta: porHerramienta,
      // Lo que costaron esas conversaciones completas del analista. Va aparte y
      // NO se suma al total: sus turnos ya están contados en por_herramienta.
      conversaciones_pensar: { cantidad: convs, costo_usd: Number(costoConvs.toFixed(4)) },
      para_decir,
      // El detalle para dibujar; run.ts lo saca antes de que cueste tokens.
      // Contrato exacto con la cara: strings es-AR con coma y dos decimales.
      panel: {
        tipo: "costos",
        periodo: p.etiqueta,
        total_usd: usd2(totalCrudo),
        filas: porHerramienta.map((h) => ({
          herramienta: h.herramienta,
          usd: usd2(h.usd),
          llamadas: h.llamadas,
          detalle: h.herramienta === "pensar" && convs > 0
            ? `${convs} ${convs === 1 ? "conversación" : "conversaciones"}`
            : null,
        })),
        nota: "no incluye el motor de voz de Gemini",
      },
    };
  },
};

export const TOOLS_COSTOS: Tool[] = [costosVer];
