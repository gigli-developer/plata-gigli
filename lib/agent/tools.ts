import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchMetrics, fetchInstallments, fetchStatements, fetchMonthlyBreakdown,
  fetchDebts, fetchRecurring, fetchTransactionsRange, fetchCategories,
  fetchPaymentMethods, insertTransaction, updateTransaction, deleteTransaction,
  fetchStatementConsumos, fetchCardsFull, fetchNetWorthSeries, fetchFxBoard,
  fetchTransactionsNuevas, insertExchange,
  type Metrics, type MonthAgg, type TxView, type NewTx, type EditTx,
} from "../db";
import { fetchCardCharges, detectarSubs } from "../subs";
import {
  SinAutorizar, listarEventos, obtenerEvento, crearEvento, editarEvento, borrarEvento,
  type CamposEvento, type Evento,
} from "./google";
import {
  guardar, tomar, descartar, marcarEjecutada, yaEjecutada, type TipoCambio,
} from "./propuestas";
import { buscar, reproducir, sonando, SinCredenciales } from "./spotify";
import { resolverAlias, TOOL_REGISTRAR_TARGET } from "./targets";
import { investigarEnLaWeb } from "./web";
import { TOOLS_CODIGO } from "./codigo";
import { TOOLS_MUNDO } from "./mundo";
import { TOOLS_ACCIONES_PLATA } from "./acciones-plata";
import { TOOLS_CEREBRO } from "./cerebro";
import { TOOLS_TAREAS, crearTarea, editarTarea, completarTarea, borrarTarea } from "./tasks";
// ⚠️ TODO lo de fechas sale de acá. No agregues helpers de fecha en este archivo:
// `lib/fechas.ts` existe porque tenerlos desperdigados produjo siete bugs del
// mismo tipo, todos por el UTC del servidor contra el UTC-3 del usuario.
import {
  hoy as hoyAr, dia as diaAr, cuando as cuandoAr, mes as mesDe,
  sumarMeses, sumarDias, rango, esFecha, minutosDelDia, deMinutos, diaLargo, hora,
  diasDelMes, mediodia, OFFSET, periodo as periodoDe, PERIODOS, diaCorto,
} from "../fechas";

/**
 * Herramientas de LECTURA del agente.
 *
 * Regla de oro (y la razón de que esto sea barato): cada handler devuelve
 * CONCLUSIONES YA CALCULADAS, nunca filas crudas. El modelo redacta, no suma.
 * Un breakdown de 6 meses son ~400 tokens; las transacciones que lo generan
 * serían ~25.000. Es un factor 60 en la factura por consulta.
 *
 * Segunda regla: los importes salen calculados de acá. Si el modelo tiene que
 * hacer aritmética sobre 40 filas se equivoca, y encima te cobra por pensarlo.
 */

// Valuación en ARS. Se define acá y no se importa de lib/fx.ts a propósito:
// ese módulo arrastra el caché de localStorage, que no existe en el servidor.
type Fx = { usd: number; usdt: number };

/**
 * ⚠️ Una moneda desconocida se devolvía como si fueran pesos (el ternario no tenía
 * default), así que una fila mal cargada contaminaba los totales en silencio y sin
 * dejar rastro. Ahora se avisa por consola y se cuenta como cero: preferimos que
 * falte plata en el total, y quede registrado, antes que sumar un número inventado.
 * La entrada está cerrada por `validarTx`; esto es la red de abajo.
 */
const toArs = (amount: number, currency: string, fx: Fx) => {
  if (currency === "ARS") return amount;
  if (currency === "USD") return amount * fx.usd;
  if (currency === "USDT") return amount * fx.usdt;
  console.error(`[tools] moneda desconocida en la base: ${currency} (se cuenta como 0)`);
  return 0;
};

// Para los agregados de fetchMonthlyBreakdown, que ya traen separada la parte
// con cotización congelada (totalArs) de la que quedó sin resolver (totalPend).
// Ver decisión de diseño 5b del CLAUDE.md: los flujos van a cotización congelada.
const aggArs = (a: MonthAgg, fx: Fx) => a.totalArs + toArs(a.totalPend, a.currency, fx);

const redondear = (n: number) => Math.round(n);

/**
 * Un importe como se lee, para la tarjeta de previsualización.
 *
 * `ARS 15000` obliga a contar dígitos, y esa tarjeta es EL lugar donde se atrapa
 * un "cincuenta mil" que en realidad dijiste "quince mil". Si hay que contar
 * ceros para darse cuenta, no sirve.
 */
const importe = (n: number, moneda: string) =>
  `${moneda === "ARS" ? "$" : `${moneda} `}` +
  n.toLocaleString("es-AR", { maximumFractionDigits: 2 });

/**
 * Categorías que NO son gasto ni ingreso: mueven plata de un bolsillo a otro
 * (decisión 3 del proyecto). Prestarle $150.000 a alguien no es haber gastado
 * $150.000.
 *
 * ⚠️ `fetchMonthlyBreakdown` ya las descarta, pero `transacciones_ver` no lo hacía,
 * así que la MISMA pregunta daba dos números según qué herramienta eligiera el
 * modelo: "cuánto llevo gastado este mes" contestaba $1.295.946 por un camino y
 * $1.087.046 por el otro. La diferencia eran justo estas dos categorías.
 */
const NO_ES_GASTO = new Set(["Cambio Divisas", "Préstamos"]);

/**
 * Resuelve el rango de una consulta: período con nombre, o desde/hasta explícitos.
 *
 * El período con nombre tiene prioridad y es el camino recomendado — ver el
 * comentario de `periodo()` en fechas.ts para por qué.
 */
function rangoPedido(
  input: Record<string, unknown>,
): { desde: string; hasta: string; etiqueta?: string } | string {
  const nombre = input?.periodo ? String(input.periodo).trim().toLowerCase() : "";
  if (nombre) {
    const p = periodoDe(nombre);
    if (!p) return `No conozco el período "${nombre}". Los que valen: ${PERIODOS.join(", ")}.`;
    return p;
  }
  return rango(
    String(input?.desde ?? input?.hasta ?? hoyAr()).slice(0, 10),
    String(input?.hasta ?? input?.desde ?? hoyAr()).slice(0, 10),
  );
}

/** Alias corto de `mes()` de fechas.ts, para no tocar los llamadores viejos. */
const ym = (d: Date) => mesDe(d);

/**
 * Canales por los que entra una consulta. No todas las herramientas sirven en todos:
 * `abrir` solo tiene sentido desde la PC, y ofrecérsela a Telegram sería pedirle al
 * modelo que abra aplicaciones en una máquina que no está escuchando (además de
 * pagar sus tokens en cada consulta de finanzas).
 */
export type Canal = "telegram" | "pc";

/**
 * Lo que el canal PC tiene que ejecutar localmente. El enum es cerrado y el
 * ejecutar valida cada tipo por separado: es la garantía de que el modelo no
 * puede pedir nada que no esté acá.
 *   app      ruta absoluta, aprobada en la tabla `targets`
 *   url      http/https únicamente
 *   discord  ids numéricos, la URI se arma del lado cliente
 *   spotify  URI `spotify:...` con formato validado
 *   media    tecla multimedia de una lista fija
 */
export type Accion = {
  /**
   * `codigo` es distinto de los otros cinco: su `valor` no es una ruta ni una URI
   * sino un JSON con repo, consigna y archivos. Sigue sin ser un comando — el
   * servidor no manda un solo flag, y el cliente arma el `claude -p` con su propia
   * lista de argumentos. Ver el contrato en `codigo.ts`.
   */
  tipo: "app" | "url" | "discord" | "spotify" | "media" | "codigo" | "salir" | "setup" | "cerebro";
  valor: string;
};

export type Tool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** En qué canales se ofrece esta herramienta. */
  canales: Canal[];
  /**
   * Si es true, un resultado con `ok: true` alcanza como respuesta y no hace falta
   * una segunda llamada al modelo para que redacte. Ver el corte en run.ts.
   */
  esAccion?: boolean;
  handler: (sb: SupabaseClient, input: Record<string, unknown>) => Promise<unknown>;
};

// ---------------------------------------------------------------------------

const estadoFinanciero: Tool = {
  name: "estado_financiero",
  description:
    "Foto de HOY: saldos líquidos por moneda, patrimonio neto, cuánto te deben y debés, " +
    "e ingresos/egresos de lo que va del mes. Usar para 'cómo estoy', 'cuánta plata tengo', 'mi patrimonio'.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["telegram", "pc"],
  async handler(sb) {
    const [m, agg]: [Metrics, MonthAgg[]] = await Promise.all([
      fetchMetrics(sb),
      fetchMonthlyBreakdown(sb, 1),
    ]);
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };

    // Saldos: cotización VIVA (son stocks, valen el dólar de hoy — decisión 5b).
    const liquidoArs = m.ars_liquido + m.usd_liquido * fx.usd + m.usdt_liquido * fx.usdt;
    const patrimonio = liquidoArs + m.te_deben - m.debes - m.deuda_cuotas_ars;

    return {
      mes_en_curso: m.ref_month,
      saldos: {
        ars: redondear(m.ars_liquido),
        usd: redondear(m.usd_liquido),
        usdt: redondear(m.usdt_liquido),
        total_valuado_ars: redondear(liquidoArs),
      },
      patrimonio_neto_ars: redondear(patrimonio),
      te_deben_ars: redondear(m.te_deben),
      debes_ars: redondear(m.debes),
      deuda_en_cuotas_ars: redondear(m.deuda_cuotas_ars),
      deuda_vencida_ars: redondear(m.deuda_vencida_ars),
      // ⚠️ NO se usan `m.ing_mes_ars` / `m.egr_mes_ars` de la RPC.
      //
      // Esos campos parecen ser "las filas EN pesos", no "todo valuado en pesos"
      // (hay un `_usd` paralelo que nadie leía), así que el mes salía subcontado:
      // los movimientos en dólares simplemente no aparecían. Y era un camino que
      // NINGUNA pantalla de Plata usa —grep de `ing_mes_ars` en `app/` da cero—,
      // por eso pudo derivar sin que nadie lo notara.
      //
      // Se calcula igual que `gastos_por_categoria` y que /metricas: agregados de
      // `fetchMonthlyBreakdown` a cotización congelada (decisión 5b).
      mes_actual: (() => {
        const delMes = agg.filter((a) => a.month === m.ref_month);
        const ing = delMes.filter((a) => a.type === "ingreso").reduce((s, a) => s + aggArs(a, fx), 0);
        const egr = delMes.filter((a) => a.type === "egreso").reduce((s, a) => s + aggArs(a, fx), 0);
        return {
          ingresos_ars: redondear(ing),
          egresos_ars: redondear(egr),
          resultado_ars: redondear(ing - egr),
        };
      })(),
      cotizaciones: { usd_blue: fx.usd, usdt: fx.usdt },
    };
  },
};

// ---------------------------------------------------------------------------

const compromisosFuturos: Tool = {
  name: "compromisos_futuros",
  description:
    "Qué tenés que pagar en los próximos meses: cuotas de tarjeta activas + suscripciones " +
    "recurrentes detectadas, mes por mes. Usar para 'qué pagos tengo', 'cuánto debo los próximos meses', " +
    "'cuándo se me liberan las cuotas'.",
  input_schema: {
    type: "object",
    properties: {
      meses: { type: "number", description: "Cuántos meses hacia adelante (1 a 12). Por defecto 6." },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    const meses = Math.min(Math.max(Number(input?.meses) || 6, 1), 12);
    const hoy = ym(new Date());

    const [m, cuotas, charges] = await Promise.all([
      fetchMetrics(sb),
      fetchInstallments(sb),
      fetchCardCharges(sb),
    ]);
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };
    const subs = detectarSubs(charges, hoy);

    // Las suscripciones se repiten todos los meses por el mismo importe.
    const subsMensualArs = subs.reduce((a, s) => a + toArs(s.amount, s.currency, fx), 0);

    const porMes = [];
    for (let k = 0; k < meses; k++) {
      // Cuota número current+k del plan: si supera el total, el plan ya terminó.
      const activas = cuotas.filter((c) => c.current + k <= c.total);
      const cuotasArs = activas.reduce((a, c) => a + toArs(c.monthly, c.currency, fx), 0);
      porMes.push({
        mes: sumarMeses(hoy, k),
        cuotas_ars: redondear(cuotasArs),
        cantidad_de_cuotas: activas.length,
        suscripciones_ars: redondear(subsMensualArs),
        total_ars: redondear(cuotasArs + subsMensualArs),
      });
    }

    // Las que terminan pronto: es la pregunta que más se hace ("cuándo me libero").
    const terminan = cuotas
      .filter((c) => c.total - c.current < meses)
      .map((c) => ({
        que: c.desc,
        cuota_mensual_ars: redondear(toArs(c.monthly, c.currency, fx)),
        va_por: `${c.current} de ${c.total}`,
        ultimo_mes: sumarMeses(hoy, c.total - c.current),
      }))
      .sort((a, b) => a.ultimo_mes.localeCompare(b.ultimo_mes));

    return {
      por_mes: porMes,
      cuotas_que_terminan: terminan,
      suscripciones_detectadas: subs.map((s) => ({
        comercio: s.comercio,
        monto: redondear(s.amount),
        moneda: s.currency,
      })),
      nota: "Las suscripciones son una estimación por repetición de consumos, no un compromiso firmado.",
    };
  },
};

// ---------------------------------------------------------------------------

const gastosPorCategoria: Tool = {
  name: "gastos_por_categoria",
  description:
    "En qué se te va la plata: gastos e ingresos agregados por categoría y por mes. " +
    "Usar para 'en qué gasté', 'cuánto gasto en comida', 'comparame este mes con el anterior'.\n" +
    "⚠️ `meses` cuenta HACIA ATRÁS INCLUYENDO el mes en curso: `meses: 1` devuelve " +
    "solo el mes actual, NO el pasado. Para el mes pasado usá `periodo: \"mes_pasado\"`.",
  input_schema: {
    type: "object",
    properties: {
      periodo: {
        type: "string",
        enum: ["este_mes", "mes_pasado", "ultimos_3_meses", "ultimos_6_meses", "ultimos_12_meses"],
        description: "Qué meses traer, por nombre. Preferilo a `meses`: no se presta a confusión.",
      },
      meses: { type: "number", description: "Cuántos meses hacia atrás contando el actual (1 a 12). Por defecto 3." },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    // El período con nombre decide dos cosas: cuántos meses traer y cuál devolver.
    // Con `meses: 1` el modelo pedía "el mes pasado" y recibía el mes EN CURSO, y
    // después lo contaba como si fuera el anterior. El nombre no admite ese error.
    const nombre = input?.periodo ? String(input.periodo) : "";
    const PORNOMBRE: Record<string, { traer: number; soloEl?: string }> = {
      este_mes: { traer: 1 },
      mes_pasado: { traer: 2, soloEl: sumarMeses(mesDe(new Date()), -1) },
      ultimos_3_meses: { traer: 3 },
      ultimos_6_meses: { traer: 6 },
      ultimos_12_meses: { traer: 12 },
    };
    const elegido = PORNOMBRE[nombre];
    const meses = elegido?.traer ?? Math.min(Math.max(Number(input?.meses) || 3, 1), 12);
    const [m, aggTodo] = await Promise.all([fetchMetrics(sb), fetchMonthlyBreakdown(sb, meses)]);
    const agg = elegido?.soloEl ? aggTodo.filter((a) => a.month === elegido.soloEl) : aggTodo;
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };

    // { mes -> { egreso: {cat: ars}, ingreso: total } }
    const meses_ = new Map<string, { egresos: Map<string, number>; ingresos: number }>();
    for (const a of agg) {
      const slot = meses_.get(a.month) ?? { egresos: new Map(), ingresos: 0 };
      const ars = aggArs(a, fx);
      if (a.type === "egreso") slot.egresos.set(a.category, (slot.egresos.get(a.category) ?? 0) + ars);
      else slot.ingresos += ars;
      meses_.set(a.month, slot);
    }

    const salida = [...meses_.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([mes, s]) => {
        const cats = [...s.egresos.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([categoria, ars]) => ({ categoria, ars: redondear(ars) }));
        // El total se redondea UNA vez, no se suman los redondeos: si no, queda
        // un peso de diferencia contra `transacciones_ver` para el mismo mes, y
        // dos números distintos para la misma pregunta es exactamente lo que se
        // estaba arreglando.
        const totalEgresos = redondear([...s.egresos.values()].reduce((a, b) => a + b, 0));
        return {
          mes,
          egresos_ars: totalEgresos,
          ingresos_ars: redondear(s.ingresos),
          resultado_ars: redondear(s.ingresos) - totalEgresos,
          top_categorias: cats.slice(0, 8),
        };
      });

    return {
      meses: salida,
      nota: "Valuado a la cotización del día de cada movimiento, así los meses cerrados no se mueven. Excluye Cambio Divisas y Préstamos.",
    };
  },
};

// ---------------------------------------------------------------------------

const deudasPersonas: Tool = {
  name: "deudas_con_personas",
  description:
    "Quién te debe y a quién le debés, con el saldo pendiente de cada uno. " +
    "Usar para 'quién me debe', 'cuánto le debo a X', 'a quién tengo que cobrarle'.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["telegram", "pc"],
  async handler(sb) {
    const [m, debts] = await Promise.all([fetchMetrics(sb), fetchDebts(sb)]);
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };
    const pendientes = debts.filter((d) => d.status === "pending" && d.outstanding > 0);

    const fila = (d: (typeof pendientes)[number]) => ({
      persona: d.person,
      pendiente: redondear(d.outstanding),
      moneda: d.currency,
      pendiente_ars: redondear(toArs(d.outstanding, d.currency, fx)),
      concepto: d.description,
      desde: d.date,
      ya_pago: d.paid > 0 ? redondear(d.paid) : undefined,
    });

    const teDeben = pendientes.filter((d) => d.direction === "to_collect").map(fila);
    const debes = pendientes.filter((d) => d.direction === "to_pay").map(fila);

    return {
      te_deben: teDeben,
      le_debes: debes,
      total_te_deben_ars: redondear(teDeben.reduce((a, d) => a + d.pendiente_ars, 0)),
      total_debes_ars: redondear(debes.reduce((a, d) => a + d.pendiente_ars, 0)),
      // Sin esto el modelo daba por saldada una deuda que seguía viva, sin
      // consultar nada. Prefiero que diga "no puedo" antes que inventar un número.
      solo_lectura:
        "NO existe ninguna herramienta para registrar pagos de deuda ni para saldarlas. " +
        "Si te dice que alguien le pagó: decile con todas las letras que eso hay que " +
        "cargarlo a mano en Plata, que vos no podés. NUNCA afirmes que una deuda quedó " +
        "saldada ni inventes el saldo nuevo: los únicos saldos válidos son los de acá. " +
        "Cargar un ingreso suelto NO actualiza la deuda — si lo hacés, aclarale que la " +
        "deuda sigue figurando igual.",
    };
  },
};

// ---------------------------------------------------------------------------

const proyeccionFinDeMes: Tool = {
  name: "proyeccion_fin_de_mes",
  description:
    "Con cuánta plata terminás el mes: parte del saldo de hoy, suma los ingresos recurrentes que " +
    "todavía no cayeron, y resta el gasto estimado de los días que faltan más los resúmenes a pagar. " +
    "Usar para 'cuánto me queda a fin de mes', 'llego', 'me alcanza'.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["telegram", "pc"],
  async handler(sb) {
    const [m, agg, recurrentes, statements, consumos, cuotas] = await Promise.all([
      fetchMetrics(sb),
      fetchMonthlyBreakdown(sb, 3),
      fetchRecurring(sb),
      fetchStatements(sb),
      fetchStatementConsumos(sb),
      fetchInstallments(sb),
    ]);
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };

    // Todo el calendario en hora de Argentina: en UTC, después de las 21:00 el
    // servidor ya está en el día siguiente y el cálculo se corre entero.
    const [anioAr, mesAr, diaActual] = hoyAr().split("-").map(Number);
    const diasDelMes = new Date(anioAr, mesAr, 0).getDate();
    const diasQueFaltan = diasDelMes - diaActual;
    const mesActual = `${anioAr}-${String(mesAr).padStart(2, "0")}`;

    // Ritmo de gasto: promedio diario de los meses COMPLETOS anteriores, que es más
    // estable que extrapolar lo que va del mes en curso (arranca sesgado por el día 1).
    const porMes = new Map<string, number>();
    for (const a of agg) {
      if (a.type !== "egreso" || a.month === mesActual) continue;
      porMes.set(a.month, (porMes.get(a.month) ?? 0) + aggArs(a, fx));
    }
    const mesesPrevios = [...porMes.values()];
    const gastoMensualTipico = mesesPrevios.length
      ? mesesPrevios.reduce((a, b) => a + b, 0) / mesesPrevios.length
      : m.egr_mes_ars;
    const gastoQueFalta = (gastoMensualTipico / diasDelMes) * diasQueFaltan;

    // Ingresos recurrentes cuyo día todavía no pasó.
    const ingresosPendientes = recurrentes
      .filter((r) => r.type === "ingreso" && (r.preferredDay ?? 1) > diaActual)
      .reduce((a, r) => a + r.baseAmount, 0);

    // Resúmenes que vencen este mes y siguen sin pagar.
    //
    // ⚠️ NO se usa `s.totalArs`: la decisión 7 del proyecto es explícita en que el
    // total guardado de un resumen SIN pagar queda stale (a veces $0), y acá eso
    // hacía contestar "sí, llegás" con cientos de miles de pesos de menos. El
    // total en vivo es consumos linkeados + cuotas del período de esa tarjeta.
    const aPagar = statements.filter(
      (s) => !s.paid && s.dueRaw && s.dueRaw.slice(0, 7) === mesActual,
    );
    const cuotasPorTarjeta = new Map<number, number>();
    for (const c of cuotas) {
      if (c.cardId == null) continue;
      // `monthly` viene en la moneda del plan: una cuota de US$ 100 no son $100.
      cuotasPorTarjeta.set(c.cardId, (cuotasPorTarjeta.get(c.cardId) ?? 0) + toArs(c.monthly, c.currency, fx));
    }
    const tarjetasArs = aPagar.reduce((a, s) => {
      const c = consumos[s.id] ?? { ars: 0, usd: 0 };
      return a + c.ars + c.usd * fx.usd + (cuotasPorTarjeta.get(s.cardId) ?? 0);
    }, 0);

    const saldoHoy = m.ars_liquido;
    const proyectado = saldoHoy + ingresosPendientes - gastoQueFalta - tarjetasArs;

    return {
      saldo_ars_hoy: redondear(saldoHoy),
      dias_que_faltan: diasQueFaltan,
      ingresos_recurrentes_por_caer_ars: redondear(ingresosPendientes),
      gasto_estimado_restante_ars: redondear(gastoQueFalta),
      resumenes_a_pagar_este_mes_ars: redondear(tarjetasArs),
      saldo_proyectado_fin_de_mes_ars: redondear(proyectado),
      alcanza: proyectado > 0,
      supuestos: {
        gasto_mensual_tipico_ars: redondear(gastoMensualTipico),
        basado_en_meses: mesesPrevios.length,
        aclaracion:
          "Solo cuenta pesos líquidos: no toca los dólares ni el USDT. Los resúmenes sin " +
          "pagar se calculan en vivo (consumos + cuotas) y pueden crecer si seguís usando " +
          "la tarjeta.",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

// Franja en la que tiene sentido buscar huecos. Fuera de esto "estar libre" no
// significa nada útil: a las 4 de la mañana siempre estás libre.
const DIA_DESDE = 8 * 60;    // 08:00
const DIA_HASTA = 22 * 60;   // 22:00
const HUECO_MINIMO = 30;     // minutos; menos que esto no es un rato libre

/** Fecha en castellano, para que se entienda leída en voz alta. */
/*
 * ⚠️ Una fecha-hora SIN zona se interpreta como hora argentina.
 *
 * El modelo manda `2026-08-22T09:00:00` a secas. `new Date()` de un ISO sin
 * sufijo usa la zona del proceso, y en Railway eso es UTC: la previsualización
 * mostraba 06:00 mientras el evento se creaba a las 09:00, porque la ejecución
 * sí le pasa la zona a Google. Tres horas de diferencia entre lo que el usuario
 * aprueba y lo que pasa — y la tarjeta es LO ÚNICO que ve antes de decir que sí.
 *
 * Lo encontró la prueba adversarial del 19/08. Solo toca las cadenas sin zona:
 * un evento leído de Google ya viene con offset y pasa de largo.
 */
const enHoraLocal = (iso: string): string =>
  /T\d{2}:\d{2}/.test(iso) && !/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso + OFFSET : iso;

function cuando(e: { inicio: string; fin: string; todo_el_dia: boolean }): string {
  if (!e.inicio) return "";
  if (e.todo_el_dia) return `${diaLargo(e.inicio.slice(0, 10))}, todo el día`;
  const desde = enHoraLocal(e.inicio);
  const hasta = enHoraLocal(e.fin);
  return `${diaLargo(diaAr(desde))}, de ${hora(desde)} a ${hora(hasta)}`;
}

/** Lo que se le muestra al usuario en la previsualización. */
const vista = (e: Evento) => ({
  titulo: e.titulo,
  cuando: cuando(e),
  lugar: e.lugar,
  nota: e.nota,
});

/**
 * Saca un mensaje legible de cualquier cosa que se haya tirado.
 *
 * Supabase no tira `Error`: tira un objeto plano `{message, details, hint, code}`.
 * Con `String(e)` eso quedaba en **"[object Object]"** y escondía la causa real —
 * costó un rato de depuración.
 */
function mensajeDeError(e: unknown): string {
  // Techo duro: un WAF delante de Supabase puede contestar una página HTML
  // entera, y eso terminaba metiendo ~1.200 tokens de markup de Cloudflare en
  // el contexto del modelo. Un error no necesita más de un renglón.
  const cortar = (s: string) => (s.length > 200 ? s.slice(0, 200) + "…" : s);

  if (e instanceof Error) return cortar(e.message);
  if (e && typeof e === "object") {
    const o = e as { message?: string; details?: string; hint?: string; code?: string };
    const partes = [o.message, o.details, o.hint].filter(Boolean);
    if (partes.length) return cortar(partes.join(" · ") + (o.code ? ` [${o.code}]` : ""));
    return cortar(JSON.stringify(e));
  }
  return cortar(String(e));
}


/** Traduce los errores de Google a algo que el modelo pueda decir sin inventar. */
function errorGoogle(e: unknown) {
  if (e instanceof SinAutorizar) {
    return {
      ok: false,
      motivo: "Todavía no está autorizado el acceso a Google Calendar.",
      que_hacer: "Decile que tiene que correr `node scripts/google-agenda-auth.mjs` una vez.",
    };
  }
  return { ok: false, motivo: mensajeDeError(e) };
}

/**
 * El id del único usuario de Plata. Hace falta para escribir con el service role,
 * que no tiene sesión. Se saca de un movimiento existente y se cachea: es una app
 * mono-usuario, no cambia.
 */
let cacheUsuario: string | null = null;
async function idDeUsuario(sb: SupabaseClient): Promise<string> {
  if (cacheUsuario) return cacheUsuario;
  const { data, error } = await sb.from("transactions").select("user_id").limit(1).single();
  if (error || !data?.user_id) {
    throw new Error(`No pude averiguar el user_id: ${mensajeDeError(error)}`);
  }
  cacheUsuario = String(data.user_id);
  return cacheUsuario;
}

const agendaVer: Tool = {
  name: "agenda_ver",
  description:
    "Mira el Google Calendar: qué tiene agendado en un rango de fechas, y qué días le quedan libres. " +
    "Usar para 'qué tengo mañana', 'qué días tengo libres', 'estoy ocupado el jueves', " +
    "y SIEMPRE antes de editar o borrar algo, para conseguir el id del evento.\n" +
    "Para períodos relativos ('esta semana', 'la semana que viene') usá `periodo`: " +
    "no calcules las fechas vos.",
  input_schema: {
    type: "object",
    properties: {
      periodo: {
        type: "string",
        enum: ["hoy", "manana", "esta_semana", "semana_que_viene", "proximos_7_dias", "este_mes"],
        description: "El rango, por nombre. Preferilo a desde/hasta cuando él habla en relativo.",
      },
      desde: { type: "string", description: "Primer día del rango, YYYY-MM-DD. Por defecto hoy." },
      hasta: { type: "string", description: "Último día del rango, YYYY-MM-DD. Por defecto 7 días después de 'desde'." },
      busqueda: { type: "string", description: "Filtra por texto del título. Opcional." },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    try {
      // La agenda mira para ADELANTE, así que sus períodos son otros que los de
      // plata (que miran para atrás). Mismo principio: los resuelve el servidor.
      const h = hoyAr();
      const lunes = periodoDe("esta_semana")!.desde;
      const HACIA_ADELANTE: Record<string, { desde: string; hasta: string }> = {
        hoy: { desde: h, hasta: h },
        manana: { desde: sumarDias(h, 1), hasta: sumarDias(h, 1) },
        esta_semana: { desde: h, hasta: sumarDias(lunes, 6) },
        semana_que_viene: { desde: sumarDias(lunes, 7), hasta: sumarDias(lunes, 13) },
        proximos_7_dias: { desde: h, hasta: sumarDias(h, 6) },
        este_mes: { desde: h, hasta: `${h.slice(0, 7)}-${diasDelMes(h.slice(0, 7))}` },
      };
      const nombrado = input?.periodo ? HACIA_ADELANTE[String(input.periodo)] : undefined;

      const pedidoDesde = nombrado?.desde ?? String(input?.desde ?? h).slice(0, 10);
      const hastaDef = esFecha(pedidoDesde) ? sumarDias(pedidoDesde, 7) : pedidoDesde;
      const r = rango(pedidoDesde, nombrado?.hasta ?? String(input?.hasta ?? hastaDef).slice(0, 10));
      if (typeof r === "string") return { ok: false, motivo: r };
      const { desde, hasta } = r;

      const desdeIso = new Date(`${desde}T00:00:00-03:00`).toISOString();
      const hastaIso = new Date(`${hasta}T23:59:59-03:00`).toISOString();
      const buscado = input?.busqueda ? String(input.busqueda) : undefined;

      let eventos = await listarEventos(sb, desdeIso, hastaIso, buscado);

      // Si la búsqueda no encontró nada, se muestra igual lo que HAY en el rango.
      // Contestar "no tenés nada" porque una palabra no coincidió es peor que no
      // haber filtrado: el evento estaba ahí y el usuario se queda pensando que lo
      // perdió. Pasó con "la entrega del 25 de agosto".
      let sinCoincidencias = false;
      if (buscado && eventos.length === 0) {
        eventos = await listarEventos(sb, desdeIso, hastaIso);
        sinCoincidencias = true;
      }

      // Armado día por día, con los huecos reales entre eventos. El "qué días
      // tengo libres" barato es la lista de días vacíos; el "cuándo tengo un rato
      // el jueves a la tarde" necesita los huecos, y calcularlos acá es la única
      // forma de que el modelo no tenga que razonar sobre horarios (se equivoca).
      // ⚠️ Con `getHours()` esto estaba MAL en producción: Railway corre en UTC,
      // así que devolvía la hora UTC y todo el panel salía corrido 3 horas (la
      // cena de las 21:30 aparecía como 00:30). Hay que forzar el huso de Buenos
      // Aires, igual que hace `cuando()`.
      const minutos = minutosDelDia;
      const hhmm = deMinutos;

      const dias = [];
      for (let iso = desde; iso <= hasta; iso = sumarDias(iso, 1)) {
        // El día de un evento sale de `diaAr`, no de recortar el ISO: uno de las
        // 22:30 se guarda en UTC como del día siguiente.
        const delDia = eventos.filter(
          (e) => (e.todo_el_dia ? e.inicio.slice(0, 10) : diaAr(e.inicio)) === iso,
        );

        // Huecos dentro de la franja despierta. Los eventos de día completo no
        // bloquean: un "cumpleaños de X" no te impide agendar una reunión.
        const ocupaciones = delDia
          .filter((e) => !e.todo_el_dia)
          .map((e) => ({ de: minutos(e.inicio), a: minutos(e.fin) }))
          .sort((x, y) => x.de - y.de);

        const huecos: { desde: string; hasta: string }[] = [];
        let cursor = DIA_DESDE;
        for (const o of ocupaciones) {
          if (o.de - cursor >= HUECO_MINIMO) huecos.push({ desde: hhmm(cursor), hasta: hhmm(o.de) });
          cursor = Math.max(cursor, o.a);
        }
        if (DIA_HASTA - cursor >= HUECO_MINIMO) {
          huecos.push({ desde: hhmm(cursor), hasta: hhmm(DIA_HASTA) });
        }

        dias.push({
          fecha: iso,
          dia: diaLargo(iso),
          eventos: delDia.map((e) => ({
            id: e.id,
            titulo: e.titulo,
            hora: e.todo_el_dia
              ? "todo el día"
              : `${hhmm(minutos(e.inicio))}–${hhmm(minutos(e.fin))}`,
            lugar: e.lugar,
          })),
          huecos,
        });
      }

      return {
        ok: true,
        rango: { desde, hasta },
        cantidad: eventos.length,
        dias_sin_eventos: dias.filter((d) => !d.eventos.length).map((d) => d.fecha),
        dias: dias.map((d) => ({
          fecha: d.fecha,
          eventos: d.eventos.map((e) => ({ id: e.id, titulo: e.titulo, hora: e.hora })),
          libre: d.huecos.map((h) => `${h.desde}-${h.hasta}`).join(", "),
        })),
        ...(sinCoincidencias
          ? {
              busqueda_sin_resultados:
                `Nada coincide con "${buscado}", así que va TODO lo que hay en el rango. ` +
                `Decíselo así: que con ese nombre no encontraste nada, y leéle lo que sí ` +
                `tiene. Puede estar anotado con otras palabras.`,
            }
          : {}),
        nota: `Huecos calculados entre las ${hhmm(DIA_DESDE)} y las ${hhmm(DIA_HASTA)}, ` +
          `ignorando los de día completo. Los de "todo el día" aparecen con hora ` +
          `"todo el día" y son eventos como cualquier otro. Los ids sirven para editar o borrar.`,
        // `panel` NO se le manda al modelo: run.ts lo saca antes. Es el detalle
        // para dibujar en pantalla, y pagarlo en tokens no tendría sentido.
        panel: { tipo: "agenda", rango: { desde, hasta }, dias },
      };
    } catch (e) {
      return errorGoogle(e);
    }
  },
};

const agendaCambiar: Tool = {
  name: "agenda_cambiar",
  description:
    "PROPONE crear, editar o borrar un evento del calendario. NO ejecuta nada: devuelve una " +
    "previsualización de cómo quedaría, y hay que confirmarla con `confirmar`. " +
    "Para editar o borrar necesitás el `evento_id`, que sale de `agenda_ver`. " +
    "Mostrale la previsualización al usuario y preguntale si confirma.",
  input_schema: {
    type: "object",
    properties: {
      accion: { type: "string", enum: ["crear", "editar", "borrar"], description: "Qué se quiere hacer." },
      evento_id: { type: "string", description: "Id del evento. Obligatorio para editar." },
      evento_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Para BORRAR VARIOS de una: la lista de ids. Usalo siempre que el usuario " +
          "pida sacar más de una cosa, así confirma una sola vez en vez de una por una.",
      },
      titulo: { type: "string", description: "Título del evento." },
      inicio: { type: "string", description: "Inicio en ISO con hora, ej. 2026-08-14T15:00:00-03:00. Si es de día completo, YYYY-MM-DD." },
      fin: { type: "string", description: "Fin, mismo formato que inicio. Si no se aclara, asumí una hora después del inicio." },
      todo_el_dia: { type: "boolean", description: "true si ocupa el día entero." },
      lugar: { type: "string", description: "Dónde." },
      nota: { type: "string", description: "Descripción o detalle." },
    },
    required: ["accion"],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    try {
      const accion = String(input?.accion ?? "") as TipoCambio;
      if (!["crear", "editar", "borrar"].includes(accion)) {
        return { ok: false, motivo: `Acción desconocida: ${accion}` };
      }

      const campos: CamposEvento = {};
      for (const k of ["titulo", "inicio", "fin", "lugar", "nota"] as const) {
        if (input?.[k] !== undefined) campos[k] = String(input[k]);
      }
      if (input?.todo_el_dia !== undefined) campos.todo_el_dia = Boolean(input.todo_el_dia);

      if (accion === "crear") {
        if (!campos.titulo || !campos.inicio) {
          return { ok: false, motivo: "Para crear hace falta al menos título y fecha de inicio." };
        }
        if (!campos.fin) {
          if (campos.todo_el_dia) {
            // Google exige `end` también en los de día completo, y lo quiere
            // EXCLUSIVO: un evento de un día termina al día siguiente. Sin esto
            // fallaba con "Missing end time" justo en el caso más común
            // ("agendame el 21 todo el día").
            campos.fin = sumarDias(campos.inicio.slice(0, 10), 1);
          } else {
            // Sin fin explícito: una hora. Es lo que espera cualquiera al decir "a las 3".
            campos.fin = new Date(new Date(campos.inicio).getTime() + 36e5).toISOString();
          }
        }
        if (!campos.todo_el_dia && new Date(campos.fin) <= new Date(campos.inicio)) {
          return { ok: false, motivo: "El evento terminaría antes de empezar: revisá la hora de fin." };
        }
        const p = guardar({ tipo: "crear", campos });
        const previa = { titulo: campos.titulo, cuando: cuando({
          inicio: campos.inicio, fin: campos.fin ?? campos.inicio,
          todo_el_dia: Boolean(campos.todo_el_dia),
        }), lugar: campos.lugar, nota: campos.nota };

        return {
          ok: true,
          propuesta: { id: p.id, dominio: "agenda", tipo: "crear", antes: null, despues: previa },
          para_decir: `Crear "${previa.titulo}" el ${previa.cuando}.`,
          que_hacer: `Mostrale esto y preguntale si confirma. Si dice que sí, llamá confirmar con id "${p.id}".`,
        };
      }

      // Borrado en lote: una sola propuesta para todos, una sola confirmación.
      const varios = Array.isArray(input?.evento_ids)
        ? (input.evento_ids as unknown[]).map((x) => String(x).trim()).filter(Boolean)
        : [];

      if (accion === "borrar" && varios.length > 1) {
        // Un id viejo o inexistente NO puede voltear la propuesta entera: antes
        // un solo 404 abortaba todo y encima no decía cuál era. Se separan los
        // que existen de los que no, y se sigue con los que sí.
        const resueltos = await Promise.all(
          varios.map(async (i) => {
            try {
              return await obtenerEvento(sb, i);
            } catch {
              return null;
            }
          }),
        );
        const bases = resueltos.filter((e): e is Evento => e !== null);
        const noEstan = varios.filter((_, k) => resueltos[k] === null);

        if (!bases.length) {
          return { ok: false, motivo: "Ninguno de esos eventos existe.", no_encontrados: noEstan };
        }

        const p = guardar({ tipo: "borrar", bases });
        const lista = bases.map((b) => ({ titulo: b.titulo, cuando: cuando(b) }));
        return {
          ok: true,
          propuesta: { id: p.id, dominio: "agenda", tipo: "borrar", antes: null, despues: null, lista },
          ...(noEstan.length ? { no_encontrados: noEstan } : {}),
          para_decir:
            `Borrar ${bases.length} evento${bases.length === 1 ? "" : "s"}: ` +
            `${bases.map((b) => `"${b.titulo}"`).join(", ")}.` +
            (noEstan.length ? ` (${noEstan.length} de los que pediste ya no existen.)` : ""),
          que_hacer: `Es destructivo y son varios: leéselos y confirmá UNA sola vez con id "${p.id}".`,
        };
      }

      const id = String(input?.evento_id ?? "").trim() || varios[0] || "";
      if (!id) return { ok: false, motivo: `Para ${accion} necesito el evento_id. Buscalo con agenda_ver.` };

      const base = await obtenerEvento(sb, id);

      if (accion === "borrar") {
        const p = guardar({ tipo: "borrar", eventoId: id, base });
        return {
          ok: true,
          propuesta: { id: p.id, dominio: "agenda", tipo: "borrar", antes: vista(base), despues: null },
          para_decir: `Borrar "${base.titulo}" del ${cuando(base)}.`,
          que_hacer: `Es destructivo: confirmá con el usuario ANTES de llamar confirmar con id "${p.id}".`,
        };
      }

      // Mover solo el inicio arrastra el fin: si no, el evento queda invertido
      // ("de 20:00 a 09:15") y Google lo rechaza con "time range is empty".
      // Se conserva la duración original, que es lo que uno espera al decir
      // "movelo a las ocho".
      if (campos.inicio && !campos.fin && !base.todo_el_dia) {
        const duracion = new Date(base.fin).getTime() - new Date(base.inicio).getTime();
        campos.fin = new Date(new Date(campos.inicio).getTime() + duracion).toISOString();
      }

      // Editar: la previsualización muestra el antes y el después ya resueltos.
      const despues: Evento = {
        ...base,
        titulo: campos.titulo ?? base.titulo,
        inicio: campos.inicio ?? base.inicio,
        fin: campos.fin ?? base.fin,
        todo_el_dia: campos.todo_el_dia ?? base.todo_el_dia,
        lugar: campos.lugar ?? base.lugar,
        nota: campos.nota ?? base.nota,
      };
      const p = guardar({ tipo: "editar", eventoId: id, campos, base });
      return {
        ok: true,
        propuesta: { id: p.id, dominio: "agenda", tipo: "editar", antes: vista(base), despues: vista(despues) },
        para_decir: `Cambiar "${base.titulo}": queda "${despues.titulo}" el ${cuando(despues)}.`,
        que_hacer: `Mostrale el antes y el después, y preguntale. Si confirma, confirmar con id "${p.id}".`,
      };
    } catch (e) {
      return errorGoogle(e);
    }
  },
};

const confirmar: Tool = {
  name: "confirmar",
  description:
    "Ejecuta un cambio que ya se propuso y que el usuario ACEPTÓ. Sirve para TODAS las " +
    "que proponen: `agenda_cambiar`, `plata_registrar`, `deuda_pagar`, `cuotas_convertir`, " +
    "`divisas_registrar`, `tareas_cambiar` y `cerebro_anotar`. " +
    "Nunca la llames sin que haya dicho explícitamente que sí. Si dijo que no, usá cancelar=true.",
  input_schema: {
    type: "object",
    properties: {
      propuesta_id: { type: "string", description: "El id que devolvió la propuesta." },
      cancelar: { type: "boolean", description: "true para descartar la propuesta sin ejecutarla." },
    },
    required: ["propuesta_id"],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    const id = String(input?.propuesta_id ?? "").trim().toLowerCase();
    if (input?.cancelar) {
      // ⚠️ Cancelar una propuesta que YA se ejecutó no la deshace: cancelar solo
      // saca de la lista lo que todavía no pasó. Antes contestaba "no toco nada"
      // igual, y el usuario quedaba creyendo que el gasto no se había cargado.
      const hecha = yaEjecutada(id);
      if (hecha) {
        return {
          ok: true,
          cancelada: false,
          ya_estaba: true,
          para_decir: `Eso ya lo había hecho: ${hecha}. Cancelar ahora no lo deshace.`,
          que_hacer:
            "Decíselo claro. Si lo quiere revertir de verdad, hay que borrar el movimiento " +
            "(con `plata_registrar` en modo borrar) o deshacerlo desde la app.",
        };
      }
      descartar(id);
      return { ok: true, cancelada: true, para_decir: "Listo, no toco nada." };
    }

    const p = tomar(id);
    if (p === "mismo_turno") {
      return {
        ok: false,
        motivo: "Recién la propuse: el usuario todavía no dijo si la acepta.",
        que_hacer:
          "Mostrale la propuesta y PREGUNTALE. No la confirmes vos. Cuando te conteste " +
          "que sí, en su próximo mensaje, ahí llamás confirmar.",
      };
    }
    if (p === "inexistente") {
      // ¿La acabo de ejecutar? Entonces esto es un "sí" repetido, no un error: la
      // respuesta correcta es "ya está", NO volver a proponer (eso lo cargaría dos veces).
      const que = yaEjecutada(id);
      if (que) {
        return {
          ok: true,
          ya_estaba: true,
          para_decir: `Eso ya lo hice recién: ${que}.`,
          que_hacer: "NO lo vuelvas a proponer ni a ejecutar. Solo confirmale que ya está.",
        };
      }
      // El id puede no existir por cuatro motivos distintos, y decir siempre
      // "se venció a los 10 minutos" manda a buscar donde no está. Lo único
      // que se puede distinguir desde acá es si el id tiene forma de id: los
      // nuestros son cuatro caracteres de un alfabeto sin i, l, o, 0 ni 1.
      const pareceId = /^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/.test(id);
      return {
        ok: false,
        motivo: pareceId
          ? "Esa propuesta ya no está: se venció (duran 10 minutos), la desalojó una más " +
            "nueva, o hubo un deploy en el medio."
          : `"${id}" no tiene forma de id de propuesta (son cuatro letras o números).`,
        que_hacer:
          "Volvé a proponerlo con la herramienta que corresponda (`plata_registrar`, " +
          "`agenda_cambiar`, `deuda_pagar`, `cuotas_convertir`, `divisas_registrar` o " +
          "`tareas_cambiar`) y esperá que confirme de nuevo. NO inventes que se hizo.",
      };
    }

    /** Deja registrado qué se hizo, para poder contestar un segundo "sí". */
    const hecho = <T extends { para_decir: string }>(r: T): T => {
      marcarEjecutada(id, r.para_decir.replace(/^Listo,?\s*/i, "").replace(/\.$/, ""));
      return r;
    };

    try {
      // --- una nota para el cerebro ---
      // El servidor no escribe: devuelve la acción y la PC crea el archivo en su
      // bitácora. El resultado real (en qué archivo quedó) vuelve por el mismo
      // merge que usa la consulta — la acción es tipo "cerebro", como todas.
      if (p.dominio === "cerebro" && p.notaCerebro) {
        const n = p.notaCerebro;
        return hecho({
          ok: true,
          que: "nota para el cerebro",
          para_decir: `Listo, anoto ${n.tipo === "decision" ? "la decisión" : "la corrección"} "${n.titulo}".`,
          accion: { tipo: "cerebro", valor: JSON.stringify({ accion: "anotar", ...n }) },
        });
      }

      // --- tareas de Google ---
      // El `taskId` ya viene resuelto de la propuesta: acá no se vuelve a buscar
      // por título. Lo que se ejecuta es exactamente la tarea que se mostró.
      if (p.dominio === "tarea" && p.tarea) {
        const t = p.tarea;
        if (t.accion === "crear") {
          const creada = await crearTarea(sb, { titulo: t.titulo, notas: t.notas, vence: t.vence });
          return hecho({ ok: true, que: "tarea creada", para_decir: `Listo, anoté "${creada.titulo}".` });
        }
        if (t.accion === "completar") {
          await completarTarea(sb, t.listaId ?? "@default", t.taskId!);
          return hecho({ ok: true, que: "tarea completada", para_decir: `Listo, "${t.titulo}" quedó como hecha.` });
        }
        if (t.accion === "editar") {
          await editarTarea(sb, t.listaId ?? "@default", t.taskId!, { titulo: t.tituloNuevo, notas: t.notas, vence: t.vence });
          return hecho({ ok: true, que: "tarea editada", para_decir: `Listo, cambié "${t.titulo}".` });
        }
        await borrarTarea(sb, t.listaId ?? "@default", t.taskId!);
        return hecho({ ok: true, que: "tarea borrada", para_decir: `Listo, borré "${t.titulo}".` });
      }

      // --- movimientos de Plata ---
      if (p.dominio === "plata") {
        /*
         * Las tres operaciones sobre lo YA cargado van primero, y cada una es UNA
         * llamada a una función de Postgres: o pasa todo o no pasa nada. No se
         * arman acá con varias escrituras sueltas, que es exactamente lo que un
         * 18/08 borró un consumo de $457.500 sin crear sus cuotas.
         */
        if (p.pagoDeuda) {
          const d = p.pagoDeuda;
          const { data, error } = await sb.rpc("pagar_deuda", {
            p_debt_id: d.debtId,
            p_monto: d.monto,          // null = saldar el resto
            p_nota: d.nota ?? null,
          });
          if (error) throw error;
          const r = (data ?? {}) as { monto?: number; saldada?: boolean; restante?: number };
          const cobro = d.direccion === "to_collect";
          const cuanto = importe(Number(r.monto ?? 0), d.moneda);
          return hecho({
            ok: true,
            que: "pago de deuda",
            saldada: !!r.saldada,
            restante: Number(r.restante ?? 0),
            para_decir: r.saldada
              ? `Listo, ${cobro ? "cobré" : "pagué"} ${cuanto} y con ${d.persona} quedás a mano.`
              : `Listo, ${cobro ? "cobré" : "pagué"} ${cuanto}. Quedan ${importe(Number(r.restante ?? 0), d.moneda)}.`,
          });
        }

        if (p.cuotas) {
          const c = p.cuotas;
          const { data, error } = await sb.rpc("convertir_a_cuotas", {
            p_tx_id: c.txId,
            p_cuotas: c.cantidad,
            p_primera: c.primera ?? null,
          });
          if (error) throw error;
          const plan = (data ?? {}) as { monthly_amount?: number };
          const mensual = Number(plan.monthly_amount ?? c.monto / c.cantidad);
          return hecho({
            ok: true,
            que: "pasado a cuotas",
            para_decir: `Listo, ${c.desc} quedó en ${c.cantidad} cuotas de ${importe(mensual, c.moneda)}.`,
          });
        }

        if (p.cambio) {
          const c = p.cambio;
          // Va por `insertExchange` y no por la RPC pelada para que quede también
          // el registro del botón Deshacer, igual que cuando lo hacés en la app.
          await insertExchange(
            sb,
            { from: c.de, to: c.a, fromAmount: c.montoDe, toAmount: c.montoA, rate: c.rate, rateSource: c.fuente },
            await idDeUsuario(sb),
          );
          return hecho({
            ok: true,
            que: "cambio registrado",
            para_decir: `Listo, salieron ${importe(c.montoDe, c.de)} y entraron ${importe(c.montoA, c.a)}.`,
          });
        }

        if (p.tipo === "crear") {
          await insertTransaction(sb, p.tx!, await idDeUsuario(sb));
          const t = p.tx!;
          return hecho({
            ok: true, que: "registrado",
            para_decir: `Listo, cargué ${t.currency} ${t.amount}${t.description ? ` de ${t.description}` : ""}.`,
          });
        }
        if (p.tipo === "editar") {
          await updateTransaction(sb, p.txId!, p.txEdit!);
          return hecho({ ok: true, que: "editado", para_decir: "Listo, lo cambié." });
        }
        // Lote, mismo criterio que la agenda: se borran todos y se informa si
        // alguno falló, en vez de cortar en el primero.
        if (p.txVarios?.length) {
          const fallaron: string[] = [];
          for (const t of p.txVarios) {
            try {
              await deleteTransaction(sb, t.id);
            } catch {
              fallaron.push(t.desc);
            }
          }
          const cuantos = p.txVarios.length - fallaron.length;
          return hecho({
            ok: fallaron.length === 0,
            que: "borrados",
            cuantos,
            fallaron,
            para_decir: fallaron.length
              ? `Borré ${cuantos} de ${p.txVarios.length}. No pude con: ${fallaron.join(", ")}.`
              : `Listo, borré los ${cuantos} movimientos.`,
          });
        }
        await deleteTransaction(sb, p.txId!);
        return hecho({
          ok: true, que: "borrado",
          para_decir: `Listo, borré "${p.txAntes?.desc ?? "el movimiento"}".`,
        });
      }

      // --- agenda ---
      if (p.tipo === "crear") {
        const e = await crearEvento(sb, p.campos!);
        return hecho({ ok: true, que: "creado", evento: vista(e), para_decir: `Listo, agendé "${e.titulo}".` });
      }
      if (p.tipo === "editar") {
        const e = await editarEvento(sb, p.eventoId!, p.campos!, p.base!);
        return hecho({ ok: true, que: "editado", evento: vista(e), para_decir: `Listo, quedó "${e.titulo}" el ${cuando(e)}.` });
      }
      // Lote: se borran todos y se informa si alguno falló, en vez de cortar al primero.
      if (p.bases?.length) {
        const fallaron: string[] = [];
        for (const b of p.bases) {
          try {
            await borrarEvento(sb, b.id);
          } catch {
            fallaron.push(b.titulo);
          }
        }
        const cuantos = p.bases.length - fallaron.length;
        return hecho({
          ok: fallaron.length === 0,
          que: "borrados",
          cuantos,
          fallaron,
          para_decir: fallaron.length
            ? `Borré ${cuantos} de ${p.bases.length}. No pude con: ${fallaron.join(", ")}.`
            : `Listo, borré los ${cuantos}.`,
        });
      }

      await borrarEvento(sb, p.eventoId!);
      return hecho({ ok: true, que: "borrado", evento: vista(p.base!), para_decir: `Listo, borré "${p.base!.titulo}".` });
    } catch (e) {
      return errorGoogle(e);
    }
  },
};

// ---------------------------------------------------------------------------
// Transacciones de Plata
// ---------------------------------------------------------------------------

/**
 * Valúa un movimiento en ARS con su cotización CONGELADA (decisión 5b del
 * proyecto): un gasto de abril vale el dólar de abril, no el de hoy. Si la fila
 * no tiene rate —no debería pasar, lo pone un trigger— se usa la de hoy.
 */
const arsCongelado = (t: TxView, fx: Fx) =>
  t.currency === "ARS" ? t.amount
    : t.fxRate ? t.amount * t.fxRate
    : toArs(t.amount, t.currency, fx);

const transaccionesVer: Tool = {
  name: "transacciones_ver",
  description:
    "Los movimientos de Plata en un período: qué gastó y qué cobró, con totales. " +
    "Usar para 'qué gasté hoy', 'movimientos del martes', 'cuánto gasté esta semana', " +
    "'en qué gasté en Rappi'. También sirve para conseguir el id de un movimiento " +
    "antes de editarlo o borrarlo.\n" +
    "⚠️ Para cualquier período relativo usá `periodo`, NUNCA calcules vos las fechas: " +
    "'esta semana', 'los últimos 7 días', 'el mes pasado' tienen su nombre en la lista. " +
    "`desde`/`hasta` son solo para fechas de calendario que él dijo explícitamente " +
    "('del 3 al 10 de agosto').",
  input_schema: {
    type: "object",
    properties: {
      periodo: {
        type: "string",
        enum: PERIODOS,
        description:
          "El período, por nombre. Es la forma preferida: la semana arranca el lunes, " +
          "'últimos N días' incluye hoy, y 'mes_pasado' es el mes calendario completo.",
      },
      desde: { type: "string", description: "Primer día, YYYY-MM-DD. Solo para fechas explícitas." },
      hasta: { type: "string", description: "Último día, YYYY-MM-DD. Por defecto igual que desde." },
      busqueda: { type: "string", description: "Filtra por texto de la descripción. Opcional." },
      categoria: {
        type: "string",
        description:
          "Filtra por categoría (Comida, Delivery, Ocio, Transporte, Servicios, Salud, " +
          "Educación, Compras, Inversiones, Sueldo, Regalos, Otros). Usalo para 'cuánto " +
          "gasté en delivery' en vez de `busqueda`: la categoría es un campo, no el texto.",
      },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    const r = rangoPedido(input ?? {});
    if (typeof r === "string") return { ok: false, motivo: r };
    const { desde, hasta } = r;
    const busqueda = input?.busqueda ? String(input.busqueda) : undefined;

    const [m, todas] = await Promise.all([
      fetchMetrics(sb),
      fetchTransactionsRange(sb, desde, hasta, busqueda),
    ]);
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };

    // El filtro por categoría va acá y no en la consulta: el rango ya está acotado,
    // y así el nombre se puede matchear de forma aproximada ("delivery", "deliveri").
    const pedida = input?.categoria ? String(input.categoria) : "";
    const txs = pedida
      ? todas.filter((t) => _plano(t.category).includes(_plano(pedida))
          || _plano(pedida).includes(_plano(t.category)))
      : todas;
    if (pedida && !txs.length) {
      return {
        ok: true,
        rango: { desde, hasta },
        cantidad: 0,
        egresos_ars: 0,
        motivo: `No hay movimientos de "${pedida}" en ese período.`,
        categorias_que_existen: [...new Set(todas.map((t) => t.category))],
      };
    }

    let ingresos = 0;
    let egresos = 0;
    let noGasto = 0;
    const porCategoria = new Map<string, number>();
    for (const t of txs) {
      const ars = arsCongelado(t, fx);
      // Préstamos y cambios de divisa se cuentan aparte: no son gasto ni ingreso.
      if (NO_ES_GASTO.has(t.category)) {
        noGasto += ars;
        continue;
      }
      if (t.type === "ingreso") ingresos += ars;
      else {
        egresos += ars;
        porCategoria.set(t.category, (porCategoria.get(t.category) ?? 0) + ars);
      }
    }

    const top = [...porCategoria.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([categoria, ars]) => ({ categoria, ars: redondear(ars) }));

    // El gasto más grande, ya elegido. "¿Cuál fue el más caro?" obligaba al modelo
    // a recorrer la lista y leer un importe, y en la prueba dijo **19.122** donde
    // la base tenía 18.122: un dígito de más, dicho con total naturalidad. Es la
    // misma regla de siempre — si hay que buscar o comparar, se hace acá.
    const gastos = txs.filter((t) => t.type === "egreso" && !NO_ES_GASTO.has(t.category));
    const mayor = gastos.length
      ? gastos.reduce((a, b) => (arsCongelado(b, fx) > arsCongelado(a, fx) ? b : a))
      : null;

    // Al modelo, lo justo para que redacte. El detalle va al panel.
    return {
      ok: true,
      rango: { desde, hasta },
      ...(r.etiqueta ? { periodo: r.etiqueta } : {}),
      cantidad: txs.length,
      egresos_ars: redondear(egresos),
      ingresos_ars: redondear(ingresos),
      resultado_ars: redondear(ingresos - egresos),
      ...(noGasto > 0
        ? {
            movimientos_que_no_son_gasto_ars: redondear(noGasto),
            aclaracion_no_gasto:
              "Préstamos y cambios de divisa: NO están en egresos_ars porque no son " +
              "gasto (cambiás plata de lugar). Mencionalos solo si pregunta por ellos.",
          }
        : {}),
      top_categorias: top,
      ...(mayor
        ? {
            gasto_mas_grande: {
              que: mayor.desc,
              monto: mayor.amount,
              moneda: mayor.currency,
              ars: redondear(arsCongelado(mayor, fx)),
              categoria: mayor.category,
              cuando: cuandoAr(mayor.occurredAt),
            },
          }
        : {}),
      movimientos: txs.slice(0, 15).map((t) => ({
        id: t.id,
        que: t.desc,
        // Sin redondear: un movimiento de 1234,56 se leía como 1235, así que si
        // el modelo releía lo que acababa de cargar veía otro número.
        monto: t.amount,
        moneda: t.currency,
        tipo: t.type,
        categoria: t.category,
        cuando: cuandoAr(t.occurredAt),
      })),
      nota:
        (txs.length > 15
          ? `Se listan 15 de ${txs.length}; los totales incluyen todos. La pantalla los muestra completos. `
          : "Valuado a la cotización del día de cada movimiento. ") +
        // El modelo sumaba dos consultas de cabeza y erraba por $100. La regla va
        // acá y no solo en el prompt para que valga también en el motor de voz,
        // que usa otro prompt pero las mismas herramientas.
        "⚠️ Si te piden el total de varios días juntos, volvé a llamar esta herramienta " +
        "con el rango completo. NO sumes los totales de consultas anteriores: para eso " +
        "está la herramienta.",
      panel: {
        tipo: "transacciones",
        rango: { desde, hasta },
        totales: {
          egresos: redondear(egresos),
          ingresos: redondear(ingresos),
          resultado: redondear(ingresos - egresos),
          // Se muestra aparte para que la lista cierre contra el total: si no, el
          // panel suma un préstamo que el encabezado no cuenta.
          no_gasto: redondear(noGasto),
        },
        movimientos: txs.map((t) => ({
          id: t.id,
          que: t.desc,
          emoji: t.emoji,
          categoria: t.category,
          metodo: t.method,
          monto: t.amount,
          moneda: t.currency,
          ars: redondear(arsCongelado(t, fx)),
          tipo: t.type,
          cuando: cuandoAr(t.occurredAt),
          dia: diaAr(t.occurredAt),
        })),
      },
    };
  },
};

const MONEDAS = ["ARS", "USD", "USDT"] as const;
const TIPOS_TX = ["egreso", "ingreso"] as const;
// `numeric(18,2)` en Postgres: más que esto revienta con "numeric field overflow".
const MONTO_MAX = 1e15;

/**
 * Valida lo que va a terminar en la base ANTES de proponerlo.
 *
 * Antes esto no existía y las consecuencias eran feas: `moneda: "EUR"` pasaba la
 * propuesta, se grababa, y se valuaba **con la cotización del dólar** —basura
 * silenciosa en el patrimonio—; una fecha como "ayer" o "2026-13-45" mostraba una
 * previsualización tranquila y reventaba al confirmar con un volcado de Postgres;
 * y `tipo: "transferencia"` se dibujaba como "Ingreso" y fallaba después. En los
 * tres casos el usuario decía que sí a algo distinto de lo que se intentaba hacer.
 */
function validarTx(input: Record<string, unknown>): string | null {
  if (input?.moneda !== undefined) {
    const m = String(input.moneda).toUpperCase();
    if (!MONEDAS.includes(m as (typeof MONEDAS)[number])) {
      return `No manejo la moneda "${input.moneda}". Solo ${MONEDAS.join(", ")}.`;
    }
  }
  if (input?.tipo !== undefined) {
    const t = String(input.tipo).toLowerCase();
    if (!TIPOS_TX.includes(t as (typeof TIPOS_TX)[number])) {
      return `"${input.tipo}" no es un tipo válido: tiene que ser gasto (egreso) o ingreso.`;
    }
  }
  if (input?.monto !== undefined) {
    const n = Number(input.monto);
    if (!Number.isFinite(n) || n <= 0) return "El monto tiene que ser un número positivo.";
    if (n >= MONTO_MAX) return "Ese monto es demasiado grande para registrarlo.";
  }
  if (input?.fecha !== undefined && !esFecha(String(input.fecha).slice(0, 10))) {
    return `No entiendo la fecha "${input.fecha}". Tiene que ser YYYY-MM-DD, y existir.`;
  }
  return null;
}

/** Busca una categoría o método por nombre aproximado. Devuelve el id o null. */
function porNombre<T extends { id: number; name: string }>(lista: T[], texto: string): T | null {
  if (!texto) return null;
  const t = _plano(texto);
  return (
    lista.find((x) => _plano(x.name) === t) ??
    lista.find((x) => _plano(x.name).includes(t) || t.includes(_plano(x.name))) ??
    null
  );
}

/** Minúsculas y sin tildes, para comparar nombres de categorías dichos en voz. */
const _plano = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const plataRegistrar: Tool = {
  name: "plata_registrar",
  description:
    "PROPONE cargar, editar o borrar un movimiento en Plata. NO ejecuta nada: devuelve una " +
    "previsualización y hay que confirmarla con `confirmar`. " +
    "Para cargar: monto, si es gasto o ingreso, y una descripción. La categoría y el medio " +
    "de pago se buscan por nombre; si no los aclara, se deja vacío y se avisa. " +
    "Para editar o borrar necesitás el id, que sale de `transacciones_ver`. " +
    "Si no aclara la moneda, es ARS. Si no aclara la fecha, es hoy.",
  input_schema: {
    type: "object",
    properties: {
      accion: { type: "string", enum: ["crear", "editar", "borrar"] },
      transaccion_id: { type: "number", description: "Obligatorio para editar y borrar de a uno." },
      transaccion_ids: {
        type: "array",
        items: { type: "number" },
        description:
          "Para BORRAR VARIOS de una: la lista de ids. Usalo siempre que pida sacar más " +
          "de un movimiento, así confirma una sola vez en vez de uno por uno.",
      },
      tipo: { type: "string", enum: ["egreso", "ingreso"], description: "Gasto o cobro. Por defecto egreso." },
      monto: { type: "number", description: "Importe, positivo." },
      moneda: { type: "string", enum: ["ARS", "USD", "USDT"], description: "Por defecto ARS." },
      descripcion: { type: "string", description: "Qué fue. Ej: 'almuerzo con Nico'." },
      categoria: { type: "string", description: "Nombre de la categoría, aproximado." },
      metodo: { type: "string", description: "Medio de pago, aproximado. Ej: 'efectivo', 'débito'." },
      fecha: { type: "string", description: "YYYY-MM-DD. Por defecto hoy." },
    },
    required: ["accion"],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    const accion = String(input?.accion ?? "") as TipoCambio;
    if (!["crear", "editar", "borrar"].includes(accion)) {
      return {
        ok: false,
        motivo: `Acción desconocida: "${accion}". Las válidas son crear, editar o borrar.`,
      };
    }

    // Validar ANTES de proponer: lo que no sirve no llega a la previsualización.
    const problema = validarTx(input ?? {});
    if (problema) return { ok: false, motivo: problema };

    // Borrar y editar necesitan el movimiento actual.
    if (accion !== "crear") {
      const varios = Array.isArray(input?.transaccion_ids)
        ? [...new Set((input.transaccion_ids as unknown[]).map(Number).filter(Number.isFinite))]
        : [];
      const id = Number(input?.transaccion_id ?? varios[0]);
      if (!Number.isFinite(id)) {
        return { ok: false, motivo: "Necesito el transaccion_id. Buscalo con transacciones_ver." };
      }
      const todas = await fetchTransactionsRange(sb, "2000-01-01", "2100-01-01", undefined, 1000);

      // Borrado en lote: una sola propuesta, una sola confirmación. Los ids que no
      // existen no voltean la propuesta entera — se avisan aparte y se sigue con
      // los que sí, igual que en la agenda.
      if (accion === "borrar" && varios.length > 1) {
        const encontradas = varios
          .map((i) => todas.find((t) => t.id === i))
          .filter((t): t is TxView => t !== undefined);
        const noEstan = varios.filter((i) => !encontradas.some((t) => t.id === i));
        if (!encontradas.length) {
          return { ok: false, motivo: "Ninguno de esos movimientos existe.", no_encontrados: noEstan };
        }

        const p = guardar({ dominio: "plata", tipo: "borrar", txVarios: encontradas });
        const lista = encontradas.map((t) => ({
          titulo: t.desc,
          cuando: `${diaCorto(diaAr(t.occurredAt))} · ${importe(t.amount, t.currency)}`,
        }));
        return {
          ok: true,
          propuesta: { id: p.id, dominio: "plata", tipo: "borrar", antes: null, despues: null, lista },
          ...(noEstan.length ? { no_encontrados: noEstan } : {}),
          para_decir:
            `Borrar ${encontradas.length} movimiento${encontradas.length === 1 ? "" : "s"}: ` +
            `${encontradas.map((t) => `"${t.desc}"`).join(", ")}.` +
            (noEstan.length ? ` (${noEstan.length} de los que pediste ya no existen.)` : ""),
          que_hacer: `Es destructivo y son varios: leéselos y confirmá UNA sola vez con id "${p.id}".`,
        };
      }

      const antes = todas.find((t) => t.id === id);
      if (!antes) return { ok: false, motivo: `No encontré el movimiento ${id}.` };

      if (accion === "borrar") {
        const p = guardar({ dominio: "plata", tipo: "borrar", txId: id, txAntes: antes });
        return {
          ok: true,
          propuesta: {
            id: p.id, dominio: "plata", tipo: "borrar",
            antes: {
              titulo: antes.desc,
              cuando: `${diaCorto(diaAr(antes.occurredAt))} · ${importe(antes.amount, antes.currency)}`,
            },
            despues: null,
          },
          para_decir: `Borrar "${antes.desc}" de ${antes.currency} ${antes.amount}.`,
          que_hacer: `Es destructivo: preguntale y recién ahí llamá confirmar con id "${p.id}".`,
        };
      }

      const [cats, mets] = await Promise.all([fetchCategories(sb), fetchPaymentMethods(sb)]);
      const cat = input?.categoria ? porNombre(cats, String(input.categoria)) : null;
      const met = input?.metodo ? porNombre(mets, String(input.metodo)) : null;
      const edit: EditTx = {
        type: (input?.tipo ? String(input.tipo) : antes.type) as "ingreso" | "egreso",
        amount: Number(input?.monto ?? antes.amount),
        currency: String(input?.moneda ?? antes.currency),
        categoryId: cat ? cat.id : antes.categoryId,
        paymentMethodId: met ? met.id : antes.paymentMethodId,
        description: input?.descripcion ? String(input.descripcion) : antes.desc,
        occurredAt: input?.fecha ? `${String(input.fecha).slice(0, 10)}T12:00:00-03:00` : antes.occurredAt,
      };
      const p = guardar({ dominio: "plata", tipo: "editar", txId: id, txAntes: antes, txEdit: edit });

      // La previsualización tiene que mostrar TODO lo que puede cambiar. Antes
      // solo mostraba categoría y monto, así que cambiar egreso→ingreso o mover
      // la fecha se veía idéntico y el usuario confirmaba a ciegas algo que le
      // daba vuelta el signo a un movimiento.
      const resumenTx = (
        tipo: string, cat_: string, moneda: string, monto: number, iso: string,
      ) => `${tipo === "ingreso" ? "ingreso" : "gasto"} · ${cat_} · ` +
        `${importe(monto, moneda)} · ${diaCorto(diaAr(iso))}`;

      return {
        ok: true,
        propuesta: {
          id: p.id, dominio: "plata", tipo: "editar",
          antes: {
            titulo: antes.desc,
            cuando: resumenTx(antes.type, antes.category, antes.currency, antes.amount, antes.occurredAt),
          },
          despues: {
            titulo: edit.description ?? "",
            cuando: resumenTx(edit.type, cat?.name ?? antes.category, edit.currency, edit.amount, edit.occurredAt),
          },
        },
        para_decir: `Cambiar "${antes.desc}": queda ${resumenTx(edit.type, cat?.name ?? antes.category, edit.currency, edit.amount, edit.occurredAt)}.`,
        que_hacer: `Mostrale el antes y el después y preguntale. Si confirma, llamá \`confirmar\` con id "${p.id}".`,
      };
    }

    // Crear
    const monto = Number(input?.monto);
    if (!Number.isFinite(monto) || monto <= 0) {
      return { ok: false, motivo: "Necesito el monto, positivo." };
    }
    const [cats, mets] = await Promise.all([fetchCategories(sb), fetchPaymentMethods(sb)]);
    const cat = input?.categoria ? porNombre(cats, String(input.categoria)) : null;
    const met = input?.metodo ? porNombre(mets, String(input.metodo)) : null;
    const fecha = String(input?.fecha ?? hoyAr()).slice(0, 10);

    const tx: NewTx = {
      type: (input?.tipo ? String(input.tipo) : "egreso") as "ingreso" | "egreso",
      amount: monto,
      currency: String(input?.moneda ?? "ARS"),
      categoryId: cat?.id ?? null,
      paymentMethodId: met?.id ?? null,
      description: input?.descripcion ? String(input.descripcion) : null,
      occurredAt: `${fecha}T12:00:00-03:00`,
    };

    const p = guardar({ dominio: "plata", tipo: "crear", tx });
    // Distinguir "no lo dijo" de "lo dijo y no existe": antes las dos daban el
    // mismo aviso y lo pedido se descartaba en silencio.
    const faltantes: string[] = [];
    const noEncontrados: string[] = [];
    if (!cat) (input?.categoria ? noEncontrados : faltantes).push(
      input?.categoria ? `categoría "${input.categoria}"` : "categoría");
    if (!met) (input?.metodo ? noEncontrados : faltantes).push(
      input?.metodo ? `medio de pago "${input.metodo}"` : "medio de pago");

    return {
      ok: true,
      propuesta: {
        id: p.id, dominio: "plata", tipo: "crear", antes: null,
        despues: {
          titulo: tx.description ?? "(sin descripción)",
          // El tipo va PRIMERO: sin él, una propuesta de ingreso y una de gasto
          // se veían idénticas y el usuario confirmaba sin saber el signo.
          cuando: `${tx.type === "ingreso" ? "ingreso" : "gasto"} · ` +
            `${cat?.name ?? "sin categoría"} · ${importe(tx.amount, tx.currency)} · ${diaCorto(fecha)}`,
          lugar: met?.name,
        },
      },
      sin_resolver: faltantes,
      ...(noEncontrados.length ? { no_encontrados: noEncontrados } : {}),
      para_decir:
        `${tx.type === "egreso" ? "Gasto" : "Ingreso"} de ${tx.currency} ${tx.amount}` +
        `${tx.description ? ` por ${tx.description}` : ""}` +
        `${cat ? ` en ${cat.name}` : ""}.`,
      que_hacer: [
        noEncontrados.length
          ? `No existe ${noEncontrados.join(" ni ")} — decíselo, no lo tapes.`
          : "",
        // "preguntáselo" a secas lo dejaba repreguntando el medio de pago tres
        // turnos seguidos sin proponer nada. La propuesta YA está hecha: falta un
        // campo, no falta la propuesta.
        faltantes.length
          ? `Quedó sin ${faltantes.join(" ni ")}. Se puede cargar igual: contale la ` +
            `propuesta y mencionalo de paso, en la misma frase. No repreguntes.`
          : "",
        `Cuando confirme, llamá \`confirmar\` con id "${p.id}".`,
      ].filter(Boolean).join(" "),
    };
  },
};

// ---------------------------------------------------------------------------
// Tarjetas, cotizaciones y patrimonio
// ---------------------------------------------------------------------------

const tarjetasVer: Tool = {
  name: "tarjetas_ver",
  description:
    "Las tarjetas de crédito: cuánto hay que pagar en cada resumen, cuándo vence, y qué " +
    "cuotas están corriendo. Usar para 'cuánto tengo que pagar de la tarjeta', 'cuándo " +
    "vence el resumen', 'qué cuotas me quedan', 'cuándo termino de pagar tal cosa'.\n" +
    "Es el ESTADO de los resúmenes, no las novedades: si pregunta qué consumos nuevos " +
    "entraron o si hay algo nuevo en la tarjeta, eso es `resumen_diario`.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["telegram", "pc"],
  async handler(sb) {
    const [m, cards, statements, consumos, cuotas] = await Promise.all([
      fetchMetrics(sb),
      fetchCardsFull(sb),
      fetchStatements(sb),
      fetchStatementConsumos(sb),
      fetchInstallments(sb),
    ]);
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };
    const nombreDe = new Map(cards.map((c) => [c.id, c.name]));

    const cuotasPorTarjeta = new Map<number, number>();
    for (const c of cuotas) {
      if (c.cardId == null) continue;
      // `monthly` viene en la moneda del plan: una cuota de US$ 100 no son $100.
      cuotasPorTarjeta.set(c.cardId, (cuotasPorTarjeta.get(c.cardId) ?? 0) + toArs(c.monthly, c.currency, fx));
    }

    // Un resumen PAGADO tiene su total congelado; uno SIN pagar se calcula en vivo
    // (consumos linkeados + cuotas del período). Decisión 7 del proyecto.
    const abiertos = statements
      .filter((s) => !s.paid)
      .slice(0, 6)
      .map((s) => {
        const c = consumos[s.id] ?? { ars: 0, usd: 0 };
        const cuotasArs = cuotasPorTarjeta.get(s.cardId) ?? 0;
        const usdEnPesos = c.usd * fx.usd;
        return {
          id: s.id,
          tarjeta: nombreDe.get(s.cardId) ?? "—",
          periodo: s.period,
          vence: s.due,
          venceRaw: s.dueRaw,
          // ⚠️ La parte en dólares va SIEMPRE con su equivalente en pesos al lado,
          // nunca sola. Antes acá había un `consumos_usd: 51` suelto junto a un
          // `consumos_ars: 634358`, y el modelo hacía la conversión de cabeza: dijo
          // que **51 dólares eran 40 mil pesos** (son 77.520) y mezcló las dos
          // monedas en el mismo total. Un número en otra moneda, sin convertir, es
          // una invitación a que lo convierta mal.
          consumos_ars: redondear(c.ars),
          ...(c.usd > 0
            ? {
                consumos_en_dolares: {
                  usd: Number(c.usd.toFixed(2)),
                  equivalen_a_ars: redondear(usdEnPesos),
                  al_cambio: fx.usd,
                },
              }
            : {}),
          cuotas_ars: redondear(cuotasArs),
          total_ars: redondear(c.ars + usdEnPesos + cuotasArs),
          // Ya sumado y en palabras: no hay nada que combinar.
          como_se_arma: [
            c.ars > 0 ? `${redondear(c.ars)} de consumos en pesos` : "",
            c.usd > 0 ? `${c.usd.toFixed(2)} dólares, que son ${redondear(usdEnPesos)} pesos` : "",
            cuotasArs > 0 ? `${redondear(cuotasArs)} de cuotas` : "",
          ].filter(Boolean).join(" + ") || "sin consumos todavía",
        };
      })
      .sort((a, b) => (a.venceRaw ?? "").localeCompare(b.venceRaw ?? ""));

    const terminan = cuotas
      .slice()
      .sort((a, b) => (a.total - a.current) - (b.total - b.current))
      .slice(0, 8)
      .map((c) => ({
        que: c.desc,
        tarjeta: c.cardId != null ? nombreDe.get(c.cardId) ?? "—" : "—",
        cuota_ars: redondear(toArs(c.monthly, c.currency, fx)),
        va_por: `${c.current} de ${c.total}`,
        le_quedan: c.total - c.current,
      }));

    return {
      ok: true,
      resumenes_sin_pagar: abiertos,
      total_sin_pagar_ars: redondear(abiertos.reduce((a, s) => a + s.total_ars, 0)),
      cuotas_activas: cuotas.length,
      cuota_mensual_total_ars: redondear(cuotas.reduce((a, c) => a + toArs(c.monthly, c.currency, fx), 0)),
      cuotas: terminan,
      // Frase armada, igual que en `resumen_diario`. Con cuatro resúmenes, tres
      // monedas y siete cuotas a la vista, pedirle que redacte el total es pedirle
      // que lo recalcule — y ahí es donde se equivoca.
      para_decir:
        abiertos.length === 0
          ? "No tenés resúmenes sin pagar."
          : `Tenés que pagar ${redondear(abiertos.reduce((a, s) => a + s.total_ars, 0))} pesos ` +
            `en total, que vencen el ${abiertos[0].vence}. ` +
            (abiertos.filter((s) => s.total_ars > 0).length > 1
              ? `Se reparte entre ${abiertos.filter((s) => s.total_ars > 0)
                  .map((s) => `${s.tarjeta} con ${s.total_ars}`).join(", ")}.`
              : ""),
      nota:
        "Los resúmenes sin pagar se calculan en vivo: consumos linkeados + cuotas del período. " +
        "TODOS los totales ya están en pesos, con la parte en dólares convertida. " +
        "⚠️ No sumes ni conviertas nada vos: usá `total_ars` y, si te preguntan el detalle, " +
        "`como_se_arma`, que ya viene escrito.",
      panel: {
        tipo: "tarjetas",
        resumenes: abiertos.map((s) => ({
          tarjeta: s.tarjeta, periodo: s.periodo, vence: s.vence, total: s.total_ars,
        })),
        cuotas: terminan.map((c) => ({
          que: c.que, monto: c.cuota_ars, va_por: c.va_por, quedan: c.le_quedan,
        })),
      },
    };
  },
};

const cotizaciones: Tool = {
  name: "cotizaciones",
  description:
    "A cuánto están el dólar y el USDT hoy, con la variación del día. Usar para " +
    "'a cuánto está el dólar', 'cómo está el blue', 'cuánto vale el USDT'.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["telegram", "pc"],
  async handler(sb) {
    const board = await fetchFxBoard(sb, 10);
    return {
      ok: true,
      cotizaciones: board.quotes.map((q) => ({
        cual: q.label,
        compra: redondear(q.compra),
        venta: redondear(q.venta),
        variacion_pct: q.changePct != null ? Number(q.changePct.toFixed(2)) : null,
        dia: q.day,
      })),
      nota: "Para valuar tenencias se usa blue COMPRA (dólares) y cripto COMPRA (USDT).",
    };
  },
};

const patrimonioEvolucion: Tool = {
  name: "patrimonio_evolucion",
  description:
    "Cómo viene el patrimonio neto mes a mes, y cuánto de la variación fue por lo que " +
    "hizo él y cuánto por el dólar. Usar para 'cómo viene mi patrimonio', 'crecí este " +
    "mes', 'cuánto me movió el dólar'.",
  input_schema: {
    type: "object",
    properties: {
      meses: { type: "number", description: "Cuántos meses hacia atrás (3 a 24). Por defecto 6." },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    const meses = Math.min(Math.max(Number(input?.meses) || 6, 3), 24);
    const serie = await fetchNetWorthSeries(sb, meses);
    if (serie.length < 2) return { ok: true, nota: "Todavía no hay historia suficiente." };

    const ultimo = serie[serie.length - 1];
    const previo = serie[serie.length - 2];
    const variacion = ultimo.patrimonio - previo.patrimonio;

    // La misma descomposición que muestra /metricas: el efecto cambiario se mide
    // sobre las tenencias con las que ARRANCÓ el mes.
    const porDolar =
      previo.usd * (ultimo.usdArs - previo.usdArs) +
      previo.usdt * (ultimo.usdtArs - previo.usdtArs);

    return {
      ok: true,
      patrimonio_hoy_ars: redondear(ultimo.patrimonio),
      variacion_del_mes_ars: redondear(variacion),
      variacion_pct: previo.patrimonio
        ? Number(((variacion / previo.patrimonio) * 100).toFixed(1))
        : null,
      de_eso_por_el_dolar_ars: redondear(porDolar),
      de_eso_tuyo_ars: redondear(variacion - porDolar),
      serie: serie.map((p) => ({
        mes: p.month,
        patrimonio: redondear(p.patrimonio),
        activos: redondear(p.activos),
        pasivos: redondear(p.pasivos),
      })),
      nota: "Las tenencias se valúan con la cotización vigente a cada cierre de mes.",
    };
  },
};

// ---------------------------------------------------------------------------
// El parte del día
// ---------------------------------------------------------------------------

const resumenDiario: Tool = {
  name: "resumen_diario",
  description:
    "El parte del día, todo junto y ya calculado: cuánto gastó hoy y cómo viene contra su " +
    "ritmo habitual, qué consumos NUEVOS entraron por mail (los de tarjeta que él todavía " +
    "no vio), qué resúmenes vencen pronto, cómo viene el mes y qué le queda en la agenda. " +
    "Usar para 'el resumen del día', 'novedades', 'cómo viene el día', 'qué me perdí', " +
    "'ponete al día'. Una sola llamada: NO hace falta pedir las otras herramientas además.",
  input_schema: {
    type: "object",
    properties: {
      desde_horas: {
        type: "number",
        description:
          "Qué tan atrás buscar novedades, en horas. Por defecto 24. Subilo si estuvo " +
          "varios días sin mirar (un finde son 72).",
      },
    },
    required: [],
  },
  canales: ["telegram", "pc"],
  async handler(sb, input) {
    const horas = Math.min(Math.max(Number(input?.desde_horas) || 24, 1), 24 * 30);
    const desdeIso = new Date(Date.now() - horas * 36e5).toISOString();
    const dHoy = hoyAr();
    const dManana = sumarDias(dHoy, 1);
    const mesEste = dHoy.slice(0, 7);
    const mesPrevio = sumarMeses(mesEste, -1);
    const diaDelMes = Number(dHoy.slice(8, 10));

    const [m, delDia, nuevas, agg, statements, consumos, cuotas, cards] = await Promise.all([
      fetchMetrics(sb),
      fetchTransactionsRange(sb, dHoy, dHoy),
      fetchTransactionsNuevas(sb, desdeIso),
      fetchMonthlyBreakdown(sb, 2),
      fetchStatements(sb),
      fetchStatementConsumos(sb),
      fetchInstallments(sb),
      fetchCardsFull(sb),
    ]);
    const fx = { usd: m.usd_ars, usdt: m.usdt_ars };

    // --- lo de hoy ------------------------------------------------------------
    // Se descuentan préstamos y cambios de divisa: no son gasto, y sin sacarlos un
    // día en que prestaste plata parecía el día más caro del año.
    const gastosHoy = delDia.filter((t) => t.type === "egreso" && !NO_ES_GASTO.has(t.category));
    const gastoHoy = gastosHoy.reduce((a, t) => a + arsCongelado(t, fx), 0);
    const ingresoHoy = delDia
      .filter((t) => t.type === "ingreso" && !NO_ES_GASTO.has(t.category))
      .reduce((a, t) => a + arsCongelado(t, fx), 0);

    // --- el ritmo -------------------------------------------------------------
    const egresosDe = (mes: string) =>
      agg.filter((a) => a.month === mes && a.type === "egreso").reduce((s, a) => s + aggArs(a, fx), 0);
    const mesHastaHoy = egresosDe(mesEste);
    const mesPasadoTotal = egresosDe(mesPrevio);
    // El promedio sale del mes pasado COMPLETO, no de los últimos días: el mes en
    // curso todavía tiene la mitad de los días vacíos y arrastraría el promedio abajo.
    const promedioDiario = mesPasadoTotal / diasDelMes(mesPrevio);
    const ritmo = diaDelMes > 0 ? (mesHastaHoy / diaDelMes) * diasDelMes(mesEste) : 0;

    // --- novedades: lo que entró solo, sin que él lo cargara -------------------
    const importadas = nuevas.filter((t) => t.source === "email" && t.type === "egreso");
    const esCredito = (t: TxView) => _plano(t.method).includes("credito");
    const novedades = importadas.map((t) => ({
      que: t.desc,
      monto: t.amount,
      moneda: t.currency,
      con: esCredito(t) ? "crédito" : t.method,
      cuando: cuandoAr(t.occurredAt),
      ars: redondear(arsCongelado(t, fx)),
    }));
    const totalNuevo = novedades.reduce((a, n) => a + n.ars, 0);
    const nuevoCredito = importadas.filter(esCredito).reduce((a, t) => a + arsCongelado(t, fx), 0);

    // --- tarjetas: solo lo que apremia ----------------------------------------
    const nombreDe = new Map(cards.map((c) => [c.id, c.name]));
    const cuotasPorTarjeta = new Map<number, number>();
    for (const c of cuotas) {
      if (c.cardId == null) continue;
      // `monthly` viene en la moneda del plan: una cuota de US$ 100 no son $100.
      cuotasPorTarjeta.set(c.cardId, (cuotasPorTarjeta.get(c.cardId) ?? 0) + toArs(c.monthly, c.currency, fx));
    }
    // Un resumen sin pagar se calcula EN VIVO (decisión 7): el total guardado queda
    // stale y a veces en cero.
    const totalDe = (s: (typeof statements)[number]) => {
      const c = consumos[s.id] ?? { ars: 0, usd: 0 };
      return c.ars + c.usd * fx.usd + (cuotasPorTarjeta.get(s.cardId) ?? 0);
    };
    // ⚠️ Al principio esto filtraba por "vence dentro de 12 días" y quedaba SIEMPRE
    // vacío: el próximo resumen vencía en 24. O sea que el parte del día nunca
    // hablaba de tarjetas, que es justo una de las cosas que se quieren saber. Va
    // el más próximo aunque falte, con los días que faltan al lado; lo que decide
    // si es urgente es `alertas`, no este corte.
    const limite = sumarDias(dHoy, 12);
    const pendientes = statements
      .filter((s) => !s.paid && s.dueRaw)
      .sort((a, b) => (a.dueRaw ?? "").localeCompare(b.dueRaw ?? ""));
    const cercanos = pendientes.filter((s) => s.dueRaw! <= limite);
    // Si no hay ninguno cerca, van TODOS los que vencen el mismo primer día. Con
    // uno solo la cifra quedaba corta y engañosa: son cuatro resúmenes que caen
    // juntos el 6 de septiembre, no quince mil pesos sueltos.
    const primerVto = pendientes[0]?.dueRaw;
    const porVencer = (cercanos.length ? cercanos : pendientes.filter((s) => s.dueRaw === primerVto))
      .map((s) => ({
        tarjeta: nombreDe.get(s.cardId) ?? "—",
        periodo: s.period,
        vence: s.due,
        en_dias: Math.round(
          (new Date(mediodia(s.dueRaw!.slice(0, 10))).getTime()
            - new Date(mediodia(dHoy)).getTime()) / 864e5,
        ),
        total_ars: redondear(totalDe(s)),
      }));

    // --- agenda: lo que le queda hoy y lo de mañana ---------------------------
    let agenda: { hoy: string[]; manana: string[] } | { no_disponible: string } = {
      no_disponible: "Google Calendar no está autorizado.",
    };
    try {
      const eventos = await listarEventos(
        sb,
        new Date().toISOString(),
        `${dManana}T23:59:59${OFFSET}`,
      );
      const linea = (e: Evento) =>
        e.todo_el_dia ? `${e.titulo} (todo el día)` : `${hora(e.inicio)} ${e.titulo}`;
      agenda = {
        hoy: eventos.filter((e) => (e.todo_el_dia ? e.inicio.slice(0, 10) : diaAr(e.inicio)) === dHoy).map(linea),
        manana: eventos.filter((e) => (e.todo_el_dia ? e.inicio.slice(0, 10) : diaAr(e.inicio)) === dManana).map(linea),
      };
    } catch {
      // La agenda es opcional acá: si Google no contesta, el resumen de plata sale igual.
    }

    // Lo que amerita que él haga algo. Vacío es la respuesta normal, y sirve: el
    // modelo no tiene que decidir qué es urgente, ya viene decidido.
    const alertas: string[] = [];
    if (m.deuda_vencida_ars > 0) {
      alertas.push(`Tenés ${redondear(m.deuda_vencida_ars)} pesos de resumen vencido sin pagar.`);
    }
    for (const s of porVencer) {
      if (s.en_dias <= 3) alertas.push(`El resumen de ${s.tarjeta} vence en ${s.en_dias} días.`);
    }
    if (promedioDiario > 0 && gastoHoy > promedioDiario * 2) {
      alertas.push("Hoy gastaste más del doble de un día normal.");
    }

    return {
      ok: true,
      fecha: diaLargo(dHoy),
      hoy: {
        gasto_ars: redondear(gastoHoy),
        ingreso_ars: redondear(ingresoHoy),
        movimientos: gastosHoy.length,
        promedio_diario_ars: redondear(promedioDiario),
        // Resuelto acá para que el modelo no tenga que dividir ni comparar: dice
        // lo que ya está dicho.
        contra_un_dia_normal:
          promedioDiario <= 0 ? "todavía no hay con qué comparar"
            : gastoHoy < promedioDiario * 0.6 ? "bastante menos que un día normal"
            : gastoHoy > promedioDiario * 1.6 ? "bastante más que un día normal"
            : "más o menos como un día normal",
        detalle: gastosHoy.slice(0, 8).map((t) => ({
          que: t.desc, monto: t.amount, moneda: t.currency, categoria: t.category,
        })),
      },
      mes: {
        cual: mesEste,
        gastado_ars: redondear(mesHastaHoy),
        a_este_ritmo_termina_en_ars: redondear(ritmo),
        mes_pasado_completo_ars: redondear(mesPasadoTotal),
      },
      novedades: {
        ventana_horas: horas,
        cantidad: novedades.length,
        total_ars: redondear(totalNuevo),
        de_eso_con_credito_ars: redondear(nuevoCredito),
        movimientos: novedades.slice(0, 10),
      },
      tarjetas_por_vencer: porVencer,
      total_a_pagar_ars: redondear(porVencer.reduce((a, s) => a + s.total_ars, 0)),
      alertas,
      agenda,
      // Borrador ya redactado. Existe porque con seis o siete cifras sueltas el
      // modelo termina inventando una: en una prueba dijo "casi dieciséis mil"
      // donde la herramienta decía 28.107. Si la frase ya viene armada, no hay
      // nada que recalcular — es la misma idea que `para_decir` en las acciones.
      para_decir: [
        alertas.length ? alertas[0] : "",
        gastosHoy.length
          ? `Hoy gastaste ${redondear(gastoHoy)} pesos, ${
              promedioDiario > 0 && gastoHoy < promedioDiario * 0.6 ? "poco para lo que suele ser"
                : promedioDiario > 0 && gastoHoy > promedioDiario * 1.6 ? "bastante más de lo normal"
                : "más o menos lo de siempre"}.`
          : "Hoy todavía no gastaste nada.",
        novedades.length
          ? `Entraron ${novedades.length} consumo${novedades.length === 1 ? "" : "s"} nuevo${
              novedades.length === 1 ? "" : "s"} por mail, ${redondear(totalNuevo)} pesos en total` +
            `${nuevoCredito > 0 ? `, ${redondear(nuevoCredito)} con crédito` : ""}.`
          : "No entró nada nuevo por mail.",
        porVencer.length
          ? `El resumen ${porVencer.length > 1 ? `de ${porVencer.length} tarjetas vence` : "vence"}` +
            ` en ${porVencer[0].en_dias} días: ${redondear(porVencer.reduce((a, s) => a + s.total_ars, 0))} pesos.`
          : "",
      ].filter(Boolean).join(" "),
      nota:
        "Las novedades son consumos que entraron SOLOS por el importador de mails: él " +
        "todavía no los vio. Los préstamos y los cambios de divisa no cuentan como gasto.",
      como_contarlo:
        "Usá `para_decir` casi tal cual —ya está redactado y los números son los buenos, " +
        "no los recalcules— y agregale una frase con lo próximo de la agenda. Tres o " +
        "cuatro frases seguidas, sin saltos de línea ni enumeraciones. La pantalla ya le " +
        "muestra el detalle: no le leas la lista de eventos ni la de consumos.",
      panel: {
        tipo: "resumen",
        fecha: diaLargo(dHoy),
        hoy: {
          gasto: redondear(gastoHoy),
          ingreso: redondear(ingresoHoy),
          promedio: redondear(promedioDiario),
          movimientos: gastosHoy.map((t) => ({
            que: t.desc, emoji: t.emoji, categoria: t.category,
            monto: t.amount, moneda: t.currency, ars: redondear(arsCongelado(t, fx)),
          })),
        },
        mes: {
          cual: mesEste,
          gastado: redondear(mesHastaHoy),
          proyectado: redondear(ritmo),
          anterior: redondear(mesPasadoTotal),
        },
        novedades: novedades.slice(0, 12),
        tarjetas: porVencer,
        alertas,
        agenda: "hoy" in agenda ? agenda : { hoy: [], manana: [] },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Música
// ---------------------------------------------------------------------------

/**
 * Un solo control para todo lo de música, con la acción adentro. Dos caminos:
 *
 *  · **Transporte** (pausa, siguiente, volumen) → teclas multimedia de Windows.
 *    Instantáneas, sin red, y funcionan aunque Spotify no tenga sesión activa en
 *    la Web API. Controlan lo que esté sonando, sea Spotify o YouTube.
 *  · **Reproducir algo puntual** → se busca en Spotify y se devuelve la URI, que
 *    la app de escritorio abre y reproduce sola. No hace falta ni Premium ni que
 *    el usuario autorice nada: alcanza con las credenciales de la app.
 */
const TRANSPORTE: Record<string, string> = {
  pausar: "play_pause",
  seguir: "play_pause",
  siguiente: "siguiente",
  anterior: "anterior",
  subir_volumen: "volumen_mas",
  bajar_volumen: "volumen_menos",
  silenciar: "silencio",
};

const musica: Tool = {
  name: "musica",
  description:
    "Controla la música en la PC. Para pausar, seguir, cambiar de tema o mover el volumen usá " +
    "la acción correspondiente (no hace falta nada más). Para poner algo concreto usá " +
    "'reproducir' con `que` (el nombre del tema, artista, disco o playlist) y `tipo`. " +
    "'me_gusta' abre sus canciones guardadas. Usar cuando pida poner, sacar, pausar, saltear o " +
    "subir/bajar la música.",
  input_schema: {
    type: "object",
    properties: {
      accion: {
        type: "string",
        enum: ["reproducir", "me_gusta", "que_suena", "pausar", "seguir", "siguiente",
               "anterior", "subir_volumen", "bajar_volumen", "silenciar"],
        description: "Qué hacer.",
      },
      que: {
        type: "string",
        description: "Solo para 'reproducir': qué buscar. Ej: 'Bohemian Rhapsody', 'Pink Floyd'.",
      },
      tipo: {
        type: "string",
        enum: ["track", "album", "artist", "playlist"],
        description: "Qué clase de cosa es. Por defecto 'track' (un tema suelto).",
      },
    },
    required: ["accion"],
  },
  canales: ["pc"],
  esAccion: true,
  async handler(sb, input) {
    const accion = String(input?.accion ?? "").trim();

    // Transporte: no toca ninguna API, va derecho al sistema.
    const tecla = TRANSPORTE[accion];
    if (tecla) {
      return {
        ok: true,
        abriendo: accion.replace("_", " "),
        frase:
          accion === "pausar" ? "Listo, pausado." :
          accion === "seguir" ? "Dale, sigo." :
          accion === "siguiente" ? "Siguiente." :
          accion === "anterior" ? "Vuelvo al anterior." :
          accion === "silenciar" ? "Silenciado." :
          "Listo.",
        accion: { tipo: "media", valor: tecla } satisfies Accion,
      };
    }

    if (accion === "que_suena") {
      const q = await sonando(sb);
      return q
        ? { ok: true, sonando: q }
        : { ok: true, sonando: null, nota: "No hay nada sonando (o falta autorizar Spotify)." };
    }

    if (accion === "me_gusta") {
      return {
        ok: true,
        abriendo: "tus me gusta",
        frase: "Dale, pongo tus me gusta.",
        accion: { tipo: "spotify", valor: "spotify:collection:tracks" } satisfies Accion,
      };
    }

    if (accion !== "reproducir") return { ok: false, motivo: `Acción desconocida: ${accion}` };

    const que = String(input?.que ?? "").trim();
    if (!que) return { ok: false, motivo: "No me dijiste qué poner." };
    const tipo = (["track", "album", "artist", "playlist"].includes(String(input?.tipo))
      ? String(input?.tipo) : "track") as "track" | "album" | "artist" | "playlist";

    try {
      const h = await buscar(sb, que, tipo);
      if (!h) return { ok: false, motivo: `No encontré "${que}" en Spotify.` };
      const como = h.de ? `${h.titulo} de ${h.de}` : h.titulo;

      // Con autorización del usuario se reproduce de verdad. Es la única forma de
      // que una playlist o un disco ARRANQUEN: abrir su URI solo navega hasta ella.
      const r = await reproducir(sb, h.uri);

      if (r.estado === "sonando") {
        return { ok: true, abriendo: como, sonando_en: r.donde, frase: `Dale, pongo ${como}.` };
      }

      if (r.estado === "sin_dispositivo") {
        // Spotify cerrado: se abre con la URI (un tema arranca solo) y se avisa
        // que para una playlist hay que reintentar cuando la app esté levantada.
        return {
          ok: true,
          abriendo: como,
          frase: `Dale, abro ${como}.`,
          accion: { tipo: "spotify", valor: h.uri } satisfies Accion,
          nota: h.tipo === "track"
            ? "Spotify estaba cerrado; el tema arranca al abrirse."
            : "Spotify estaba cerrado. Volvé a llamar `musica reproducir` con lo mismo " +
              "en unos segundos para que efectivamente arranque.",
        };
      }

      if (r.estado === "error") {
        return { ok: false, motivo: `Spotify no lo pudo reproducir: ${r.motivo}` };
      }

      // sin_autorizar: se abre la URI igual. Sirve para temas sueltos.
      return {
        ok: true,
        abriendo: como,
        frase: `Dale, pongo ${como}.`,
        accion: { tipo: "spotify", valor: h.uri } satisfies Accion,
        nota: h.tipo === "track" ? undefined
          : "Ojo: sin autorizar Spotify esto abre la playlist pero no le da play. " +
            "Decile que corra `node scripts/spotify-auth.mjs` una vez.",
      };
    } catch (e) {
      if (e instanceof SinCredenciales) {
        return {
          ok: false,
          motivo: "Todavía no están cargadas las credenciales de Spotify.",
          que_hacer: "Decile que hay que crear una app en developer.spotify.com y guardar " +
            "SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET. Los controles de pausa y volumen " +
            "funcionan igual sin eso.",
        };
      }
      return { ok: false, motivo: mensajeDeError(e) };
    }
  },
};

// ---------------------------------------------------------------------------

const abrirEnLaPc: Tool = {
  name: "abrir",
  description:
    "Abre algo en la PC: una aplicación, una página web o un canal de Discord. " +
    "Recibe el ALIAS con el que Lucas lo nombró ('spotify', 'chrome', 'youtube'), nunca una ruta ni una URL. " +
    "Usar cuando pida abrir, poner, arrancar, largar o ir a algo.",
  input_schema: {
    type: "object",
    properties: {
      alias: {
        type: "string",
        description: "Cómo lo llamó, una o dos palabras. Sin rutas, sin URLs, sin extensiones.",
      },
    },
    required: ["alias"],
  },
  canales: ["pc"],
  esAccion: true,
  async handler(sb, input) {
    const alias = String(input?.alias ?? "").trim();
    if (!alias) return { ok: false, motivo: "No me dijiste qué abrir." };

    // El alias se resuelve con fuzzy match EN EL SERVIDOR (lib/agent/targets.ts),
    // antes de que el modelo vea nada. La tabla no viaja ni en este schema ni en el
    // system prompt: al modelo le llega la conclusión, no la lista para elegir.
    const r = await resolverAlias(sb, alias);

    if (r.estado === "error") {
      return { ok: false, motivo: `No pude leer los targets: ${r.motivo}` };
    }

    if (r.estado === "sin_match") {
      return {
        ok: false,
        motivo: `No tengo nada cargado que se parezca a "${alias}".`,
        que_hacer:
          "Preguntale qué es y de dónde sacarlo (la ruta del .exe o la URL) para poder " +
          "registrarlo. NO inventes una ruta ni lo des por abierto.",
      };
    }

    // Dudoso o con dos candidatos empatados: no se adivina. Abrir la app equivocada
    // es lo único irreversible de todo este camino, así que acá pregunta el modelo.
    if (r.estado === "ambiguo") {
      return {
        ok: false,
        motivo: `No estoy seguro de a qué se refiere con "${alias}".`,
        candidatos: r.candidatos.map((c) => c.alias),
        que_hacer:
          "Preguntale cuál de esos quiso decir, nombrándolos. NO elijas vos ni abras ninguno.",
      };
    }

    const t = r.target;

    // Cerrojo del lado servidor: una app sin aprobar no se ejecuta, aunque el modelo insista.
    // Las de tipo url/discord no lo necesitan (el peor caso es una pestaña de más).
    if (t.tipo === "app" && !t.aprobado) {
      return {
        ok: false,
        motivo: `"${t.alias}" está cargado pero todavía no lo aprobaste, así que no lo abro.`,
      };
    }

    // `carpeta` existe en la tabla (la usa la búsqueda de archivos) pero el ejecutor
    // de la PC no la sabe abrir: sus tipos son app/url/discord/spotify/media. Se avisa
    // en vez de mandarle una acción que va a rebotar del otro lado.
    if (t.tipo === "carpeta") {
      return {
        ok: false,
        motivo: `"${t.alias}" es una carpeta y todavía no sé abrir carpetas en la PC.`,
      };
    }

    return {
      ok: true,
      abriendo: t.alias,
      // La frase la arma la herramienta y no el modelo (corte de la 2ª vuelta en
      // run.ts). Va el alias REAL, que es cómo Lucas se entera de qué se resolvió
      // cuando dijo "espotifai" y esto entendió "spotify".
      frase: `Dale, abro ${t.alias}.`,
      accion: { tipo: t.tipo, valor: t.valor } satisfies Accion,
    };
  },
};

// ---------------------------------------------------------------------------

const desplegarSetup: Tool = {
  name: "desplegar_setup",
  description:
    "Arma un escritorio entero de una: abre varias aplicaciones y las acomoda, cada " +
    "una maximizada en el monitor que le toca. Usar cuando pida 'desplegá el setup X', " +
    "'armá el escritorio X', 'poné el setup de X'.\n" +
    "Pasá SOLO el nombre del setup, tal como él lo dijo. Qué se abre y dónde está " +
    "definido en su máquina, no acá: si el nombre no existe, la PC te lo va a decir " +
    "y ahí se lo contás. NUNCA inventes qué contiene un setup ni des por hecho que se " +
    "abrió algo que no te confirmaron.",
  input_schema: {
    type: "object",
    properties: {
      nombre: {
        type: "string",
        description: "Cómo lo llamó: 'daily', 'trabajo', 'gaming'. Una palabra.",
      },
    },
    required: ["nombre"],
  },
  canales: ["pc"],
  esAccion: true,
  async handler(_sb, input) {
    const nombre = String(input?.nombre ?? "").trim().toLowerCase();
    if (!nombre) return { ok: false, motivo: "No me dijiste qué setup." };
    // Solo letras, números, espacios y guiones: el nombre es una CLAVE en un
    // archivo local, no una ruta ni un comando. Igual del otro lado se busca en un
    // diccionario cerrado, así que esto es la red de arriba.
    if (!/^[a-z0-9áéíóúñ][a-z0-9áéíóúñ \-_]{0,30}$/i.test(nombre)) {
      return { ok: false, motivo: `"${nombre}" no parece el nombre de un setup.` };
    }
    return {
      ok: true,
      abriendo: `el setup ${nombre}`,
      frase: `Dale, armo el setup ${nombre}.`,
      accion: { tipo: "setup", valor: nombre } satisfies Accion,
    };
  },
};

const cerrarse: Tool = {
  name: "cerrarse",
  description:
    "Cierra Jarvis. Despedite en tres o cuatro palabras y llamala.\n" +
    "Hace falta una señal EXPLÍCITA de que se va o de que te cierres: 'cerrate', " +
    "'podés cerrarte', 'chau', 'nos vemos', 'me voy', 'hasta mañana', 'apagate'.\n" +
    "⚠️ Una palabra de cierre SOLA no alcanza: 'listo', 'ya está', 'dale', 'gracias', " +
    "'perfecto', 'ok' son lo que dice cualquiera al terminar UNA TAREA, no al irse. " +
    "Medido: con esta herramienta suelta, un 'listo' pelado cerraba la aplicación en " +
    "la mitad de un trabajo. Si no nombró irse ni cerrar, NO la llames — seguí " +
    "conversando normal. Si de verdad dudás, preguntale si quiere que te cierres.",
  input_schema: { type: "object", properties: {}, required: [] },
  canales: ["pc"],
  esAccion: true,
  async handler() {
    // No lleva confirmación a propósito, al revés que las escrituras: cerrarse no
    // destruye nada y se deshace aplaudiendo dos veces. Pedir permiso para irse
    // sería más molesto que el peor caso de equivocarse.
    return {
      ok: true,
      abriendo: "el cierre",
      frase: "Listo, me cierro. Aplaudí cuando me necesites.",
      accion: { tipo: "salir", valor: "jarvis" } satisfies Accion,
    };
  },
};

// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  estadoFinanciero,
  compromisosFuturos,
  gastosPorCategoria,
  deudasPersonas,
  proyeccionFinDeMes,
  abrirEnLaPc,
  musica,
  agendaVer,
  agendaCambiar,
  transaccionesVer,
  plataRegistrar,
  tarjetasVer,
  cotizaciones,
  patrimonioEvolucion,
  resumenDiario,
  confirmar,
  // Fase 2: registrar algo nuevo cuando `abrir` no lo encontró. Las de tipo `app`
  // nacen sin aprobar y las habilita Lucas a mano — el modelo no puede saltearlo.
  TOOL_REGISTRAR_TARGET,
  // Fase 5: búsqueda web por escalamiento. Los resultados crudos NUNCA llegan hasta
  // acá; lo que vuelve es una conclusión de dos o tres frases. Ver `web.ts`.
  investigarEnLaWeb,
  // Fase 6: dictar y lanzar tareas de código. `dictar` guarda un borrador y `lanzar`
  // devuelve la acción; entre las dos tiene que haber hablado él. Ver `codigo.ts`.
  ...TOOLS_CODIGO,
  // Clima, feriados (AR y US) y rutas. Las únicas que no tocan Supabase: son el
  // mundo de afuera, y por eso viven aparte. Ver `mundo.ts`.
  ...TOOLS_MUNDO,
  // Cobrar/pagar deudas, pasar un consumo a cuotas y registrar cambios de
  // divisas. Proponen igual que `plata_registrar`; las ejecuta `confirmar`
  // llamando a UNA función de Postgres cada una. Ver `acciones-plata.ts`.
  ...TOOLS_ACCIONES_PLATA,
  // Las notas de Lucas. El servidor solo devuelve la acción: el contenido lo
  // lee la PC de su propio disco y nunca pasa por acá. Ver `cerebro.ts`.
  ...TOOLS_CEREBRO,
  // Google Tasks: ver pendientes y proponer crear/completar/editar/borrar (las
  // ejecuta `confirmar`). Mismo refresh token que la agenda. Ver `tasks.ts`.
  ...TOOLS_TAREAS,
  desplegarSetup,
  cerrarse,
];

/** Los esquemas que se le mandan a Claude (sin los handlers), filtrados por canal. */
export const schemasPara = (canal: Canal) =>
  TOOLS.filter((t) => t.canales.includes(canal)).map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));

export const toolPorNombre = (name: string) => TOOLS.find((t) => t.name === name);

export async function ejecutarTool(
  sb: SupabaseClient,
  name: string,
  input: Record<string, unknown>,
  canal: Canal,
): Promise<unknown> {
  const tool = toolPorNombre(name);
  if (!tool) return { error: `No existe la herramienta ${name}` };
  // Defensa en profundidad: aunque el schema no se haya mandado, no se ejecuta
  // una herramienta que no corresponde al canal.
  if (!tool.canales.includes(canal)) return { error: `${name} no está disponible en este canal` };
  try {
    return await tool.handler(sb, input);
  } catch (e) {
    // El error vuelve al modelo como resultado para que avise en vez de inventar.
    return { error: `Falló ${name}: ${mensajeDeError(e)}` };
  }
}
