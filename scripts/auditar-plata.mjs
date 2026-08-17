/**
 * Auditoría de las herramientas del asistente contra la BASE CRUDA.
 *
 * Por qué existe: hasta ahora las pruebas comparaban lo que DICE el modelo contra
 * lo que devuelve la herramienta. Eso encuentra que el modelo sume mal, pero no
 * encuentra que la herramienta esté mal — si el número está torcido desde el
 * origen, modelo y herramienta coinciden perfectamente en un dato falso.
 *
 * Así que esto no importa NADA de `lib/`. Lee las tablas con el cliente pelado y
 * vuelve a calcular cada cifra desde cero, siguiendo las reglas escritas en el
 * CLAUDE.md (cotización congelada para flujos y viva para saldos, préstamos y
 * cambio de divisas afuera, día argentino y no UTC, cuotas fuera de transactions).
 * Después llama a /api/tool y compara. Dos implementaciones independientes que
 * tienen que dar lo mismo.
 *
 *   node scripts/auditar-plata.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// --- config ----------------------------------------------------------------

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const jarvis = Object.fromEntries(
  readFileSync("F:/jarvis-pc/.env", "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const API_TOOL = jarvis.PC_API_URL.replace("/api/pc", "/api/tool");

async function tool(nombre, input = {}) {
  const r = await fetch(API_TOOL, {
    method: "POST",
    headers: { "x-pc-secret": jarvis.PC_CHANNEL_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ nombre, input }),
  });
  const j = await r.json();
  if (!j.resultado) throw new Error(`${nombre}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.resultado;
}

// --- fechas, en hora argentina y sin depender de lib/fechas.ts --------------

const ZONA = "America/Argentina/Buenos_Aires";
const diaAr = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: ZONA });
const mesAr = (iso) => diaAr(iso).slice(0, 7);
const HOY = new Date().toLocaleDateString("en-CA", { timeZone: ZONA });
const sumarDias = (f, k) => diaAr(new Date(new Date(`${f}T12:00:00-03:00`).getTime() + k * 864e5));
const sumarMeses = (ym, k) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
const diasDelMes = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const lunesDe = (f) => {
  const d = new Date(`${f}T12:00:00-03:00`).toLocaleDateString("en-US", { weekday: "short", timeZone: ZONA });
  return sumarDias(f, -["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(d));
};

// --- resultados ------------------------------------------------------------

const fallas = [];
let corridas = 0;
const P = (n) => (n == null ? "—" : Math.round(n).toLocaleString("es-AR"));

/** Compara con tolerancia de $1 (redondeos) salvo que se pida exacto. */
function cmp(que, base, herramienta, tol = 1) {
  corridas++;
  const ok = base == null || herramienta == null
    ? base === herramienta
    : Math.abs(base - herramienta) <= tol;
  if (!ok) fallas.push({ que, base, herramienta, dif: herramienta - base });
  console.log(`  ${ok ? "ok  " : "MAL "} ${que.padEnd(46)} base ${P(base).padStart(12)}  tool ${P(herramienta).padStart(12)}`);
  return ok;
}

function cmpTxt(que, base, herramienta) {
  corridas++;
  const ok = String(base) === String(herramienta);
  if (!ok) fallas.push({ que, base, herramienta });
  console.log(`  ${ok ? "ok  " : "MAL "} ${que.padEnd(46)} base ${String(base).padStart(12)}  tool ${String(herramienta).padStart(12)}`);
  return ok;
}

// --- carga de la base ------------------------------------------------------

async function todo(tabla, select, orden) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    let q = sb.from(tabla).select(select).range(desde, desde + 999);
    if (orden) q = q.order(orden);
    const { data, error } = await q;
    if (error) throw new Error(`${tabla}: ${error.message}`);
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

console.log("Leyendo la base…");
const [txs, cats, metodos, planes, statements, deudas, pagos, personas, cards, fxRows] =
  await Promise.all([
    todo("transactions", "id,type,amount,currency,fx_rate_ars,description,occurred_at,created_at,source,category_id,payment_method_id,statement_id,card_id"),
    todo("categories", "id,name"),
    todo("payment_methods", "id,name"),
    todo("installment_plans", "id,card_id,description,monthly_amount,currency,total_installments,first_charge_date"),
    todo("card_statements", "id,card_id,period_label,closing_date,due_date,is_paid,total_ars,total_usd,fx_rate_ars"),
    todo("debts", "id,person_id,kind,direction,status,amount,currency,description,occurred_at,settled_at"),
    todo("debt_payments", "id,debt_id,amount,occurred_at"),
    todo("persons", "id,name"),
    todo("cards", "id,name,is_archived"),
    todo("fx_rates", "day,casa,compra,venta"),
  ]);

const nombreCat = new Map(cats.map((c) => [c.id, c.name]));
const nombreMet = new Map(metodos.map((m) => [m.id, m.name]));
const nombrePer = new Map(personas.map((p) => [p.id, p.name]));
const nombreCard = new Map(cards.map((c) => [c.id, c.name]));

// Cotización VIVA: último día cargado. blue COMPRA para dólares, cripto COMPRA
// para USDT (decisión 5 del proyecto).
const ultimoDia = fxRows.map((f) => f.day).sort().at(-1);
const delDia = (casa) => fxRows.find((f) => f.day === ultimoDia && f.casa === casa);
const FX = { usd: Number(delDia("blue").compra), usdt: Number(delDia("cripto").compra) };

const catDe = (t) => nombreCat.get(t.category_id) ?? "Otros";
const metDe = (t) => nombreMet.get(t.payment_method_id) ?? "—";
const NO_ES_GASTO = new Set(["Cambio Divisas", "Préstamos"]);

/** Flujos: cotización CONGELADA del día del movimiento. */
const arsFlujo = (t) =>
  t.currency === "ARS" ? Number(t.amount)
    : t.fx_rate_ars != null ? Number(t.amount) * Number(t.fx_rate_ars)
    : Number(t.amount) * (t.currency === "USD" ? FX.usd : FX.usdt);

/** Stocks: cotización VIVA. */
const arsVivo = (monto, moneda) =>
  moneda === "ARS" ? Number(monto)
    : moneda === "USD" ? Number(monto) * FX.usd
    : Number(monto) * FX.usdt;

const enRango = (d1, d2) => txs.filter((t) => {
  const d = diaAr(t.occurred_at);
  return d >= d1 && d <= d2;
});

console.log(`\nBase: ${txs.length} movimientos · ${planes.length} planes de cuotas · ` +
            `${statements.length} resúmenes · ${deudas.length} deudas`);
console.log(`Cotización viva (${ultimoDia}): USD ${FX.usd} · USDT ${FX.usdt}\n`);

// ===========================================================================
console.log("=".repeat(96));
console.log("1. transacciones_ver — totales por período");
console.log("=".repeat(96));

const PERIODOS = [
  ["hoy", HOY, HOY],
  ["ayer", sumarDias(HOY, -1), sumarDias(HOY, -1)],
  ["ultimos_7_dias", sumarDias(HOY, -6), HOY],
  ["esta_semana", lunesDe(HOY), HOY],
  ["semana_pasada", sumarDias(lunesDe(HOY), -7), sumarDias(lunesDe(HOY), -1)],
  ["este_mes", `${HOY.slice(0, 7)}-01`, HOY],
  ["mes_pasado", `${sumarMeses(HOY.slice(0, 7), -1)}-01`,
    `${sumarMeses(HOY.slice(0, 7), -1)}-${diasDelMes(sumarMeses(HOY.slice(0, 7), -1))}`],
  ["ultimos_30_dias", sumarDias(HOY, -29), HOY],
];

for (const [nombre, d1, d2] of PERIODOS) {
  const filas = enRango(d1, d2);
  const gasto = filas.filter((t) => t.type === "egreso" && !NO_ES_GASTO.has(catDe(t)));
  const cobro = filas.filter((t) => t.type === "ingreso" && !NO_ES_GASTO.has(catDe(t)));
  const r = await tool("transacciones_ver", { periodo: nombre });

  console.log(`\n  ${nombre}  (${d1} → ${d2})`);
  cmpTxt(`${nombre}: rango desde`, d1, r.rango?.desde);
  cmpTxt(`${nombre}: rango hasta`, d2, r.rango?.hasta);
  cmp(`${nombre}: egresos`, gasto.reduce((a, t) => a + arsFlujo(t), 0), r.egresos_ars);
  cmp(`${nombre}: ingresos`, cobro.reduce((a, t) => a + arsFlujo(t), 0), r.ingresos_ars);
  cmp(`${nombre}: cantidad`, filas.length, r.cantidad, 0);
}

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("2. transacciones_ver — filtro por categoría");
console.log("=".repeat(96));

const mesPas = sumarMeses(HOY.slice(0, 7), -1);
for (const categoria of ["Delivery", "Transporte", "Ocio"]) {
  const filas = enRango(`${mesPas}-01`, `${mesPas}-${diasDelMes(mesPas)}`)
    .filter((t) => catDe(t) === categoria && t.type === "egreso");
  const r = await tool("transacciones_ver", { periodo: "mes_pasado", categoria });
  cmp(`${categoria} en ${mesPas}`, filas.reduce((a, t) => a + arsFlujo(t), 0), r.egresos_ars);
}

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("3. gastos_por_categoria");
console.log("=".repeat(96));

const gpc = await tool("gastos_por_categoria", { meses: 3 });
for (const m of gpc.meses ?? []) {
  const filas = txs.filter((t) => mesAr(t.occurred_at) === m.mes && !NO_ES_GASTO.has(catDe(t)));
  const eg = filas.filter((t) => t.type === "egreso");
  const ing = filas.filter((t) => t.type === "ingreso");
  cmp(`${m.mes}: egresos`, eg.reduce((a, t) => a + arsFlujo(t), 0), m.egresos_ars);
  cmp(`${m.mes}: ingresos`, ing.reduce((a, t) => a + arsFlujo(t), 0), m.ingresos_ars);

  const porCat = new Map();
  for (const t of eg) porCat.set(catDe(t), (porCat.get(catDe(t)) ?? 0) + arsFlujo(t));
  const top = [...porCat.entries()].sort((a, b) => b[1] - a[1])[0];
  cmpTxt(`${m.mes}: categoría más grande`, top?.[0], m.top_categorias?.[0]?.categoria);
  cmp(`${m.mes}: monto de esa categoría`, top?.[1], m.top_categorias?.[0]?.ars);
}

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("4. deudas_con_personas");
console.log("=".repeat(96));

const pagadoDe = (id) => pagos.filter((p) => p.debt_id === id).reduce((a, p) => a + Number(p.amount), 0);
const vivas = deudas.filter((d) => d.status === "pending" && Number(d.amount) - pagadoDe(d.id) > 0);
const teDeben = vivas.filter((d) => d.direction === "to_collect");
const leDebes = vivas.filter((d) => d.direction === "to_pay");
const saldoArs = (d) => arsVivo(Number(d.amount) - pagadoDe(d.id), d.currency);

const dd = await tool("deudas_con_personas");
cmp("total te deben", teDeben.reduce((a, d) => a + saldoArs(d), 0), dd.total_te_deben_ars, 2);
cmp("total le debés", leDebes.reduce((a, d) => a + saldoArs(d), 0), dd.total_debes_ars, 2);
cmp("cantidad de deudas a cobrar", teDeben.length, dd.te_deben?.length, 0);
cmp("cantidad de deudas a pagar", leDebes.length, dd.le_debes?.length, 0);

for (const d of teDeben) {
  const fila = (dd.te_deben ?? []).find((x) => x.concepto === d.description);
  cmp(`  ${nombrePer.get(d.person_id)}: ${String(d.description).slice(0, 22)}`,
      Number(d.amount) - pagadoDe(d.id), fila?.pendiente);
}

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("5. tarjetas_ver — resúmenes sin pagar (consumos linkeados + cuotas)");
console.log("=".repeat(96));

// Cuota que va corriendo este mes: 1 + meses transcurridos desde el primer cargo.
const cuotaActual = (p) => {
  const [y1, m1] = p.first_charge_date.slice(0, 7).split("-").map(Number);
  const [y2, m2] = HOY.slice(0, 7).split("-").map(Number);
  return (y2 * 12 + m2) - (y1 * 12 + m1) + 1;
};
const planesVivos = planes.filter((p) => {
  const c = cuotaActual(p);
  return c >= 1 && c <= p.total_installments;
});
const cuotasPorTarjeta = new Map();
for (const p of planesVivos) {
  if (p.card_id == null) continue;
  const ars = p.currency === "ARS" ? Number(p.monthly_amount) : arsVivo(p.monthly_amount, p.currency);
  cuotasPorTarjeta.set(p.card_id, (cuotasPorTarjeta.get(p.card_id) ?? 0) + ars);
}

const tv = await tool("tarjetas_ver");
const sinPagar = statements.filter((s) => !s.is_paid);
cmp("resúmenes sin pagar (cantidad)", sinPagar.length, tv.resumenes_sin_pagar?.length, 0);
cmp("cuotas activas", planesVivos.length, tv.cuotas_activas, 0);
cmp("cuota mensual total",
    planesVivos.reduce((a, p) => a + (p.currency === "ARS" ? Number(p.monthly_amount) : arsVivo(p.monthly_amount, p.currency)), 0),
    tv.cuota_mensual_total_ars, 2);

let totalSinPagar = 0;
for (const s of sinPagar) {
  const linkeados = txs.filter((t) => t.statement_id === s.id);
  const ars = linkeados.filter((t) => t.currency === "ARS").reduce((a, t) => a + Number(t.amount), 0);
  const usd = linkeados.filter((t) => t.currency === "USD").reduce((a, t) => a + Number(t.amount), 0);
  const esperado = ars + usd * FX.usd + (cuotasPorTarjeta.get(s.card_id) ?? 0);
  totalSinPagar += esperado;
  const fila = (tv.resumenes_sin_pagar ?? []).find((x) => x.id === s.id);
  cmp(`  ${nombreCard.get(s.card_id)} ${s.period_label}`, esperado, fila?.total_ars, 2);
}
cmp("total sin pagar", totalSinPagar, tv.total_sin_pagar_ars, 5);

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("6. estado_financiero");
console.log("=".repeat(96));

/**
 * Saldo líquido (decisión 6): ingresos − egresos que NO son crédito − resúmenes
 * pagados. Los consumos con crédito no bajan el saldo hasta que se paga el
 * resumen, para no contarlos dos veces.
 *
 * ⚠️ El resumen pagado se descuenta POR MONEDA, cada parte de su propio bolsillo:
 * `total_ars` sale de los pesos y `total_usd` sale de los dólares. La primera
 * versión de esta auditoría valuaba el `total_usd` con la cotización congelada y
 * se lo restaba a los PESOS, y ahí daban US$ 601,66 de más en dólares y $854.467
 * de menos en pesos — que es exactamente la suma de los `total_usd` de los diez
 * resúmenes pagados. O sea que se estaba pegando dos veces sobre el mismo pago.
 * La herramienta estaba bien; la que estaba mal era la comprobación.
 *
 * Confirmado con el usuario el 13/08/2026: sí, paga esa parte con dólares de su
 * cuenta en USD. Y el Cash Flow, que a primera vista parecía contradecir esto,
 * tampoco está mal — tiene dos cálculos y cada uno contesta una pregunta distinta
 * ("cuántos pesos salieron" vs "cuánto valor salió"). Ver decisión 6 del CLAUDE.md.
 */
const esCredito = (t) => metDe(t) === "Tarjeta de Crédito";
const pagadoDeResumenes = (moneda) => statements
  .filter((s) => s.is_paid)
  .reduce((a, s) => a + Number(moneda === "ARS" ? s.total_ars : moneda === "USD" ? s.total_usd : 0), 0);

const porMoneda = (moneda) => {
  const ing = txs.filter((t) => t.type === "ingreso" && t.currency === moneda)
    .reduce((a, t) => a + Number(t.amount), 0);
  const egr = txs.filter((t) => t.type === "egreso" && t.currency === moneda && !esCredito(t))
    .reduce((a, t) => a + Number(t.amount), 0);
  return ing - egr - pagadoDeResumenes(moneda);
};

const arsLiquido = porMoneda("ARS");
const usdLiquido = porMoneda("USD");
const usdtLiquido = porMoneda("USDT");

const ef = await tool("estado_financiero");
cmp("saldo ARS", arsLiquido, ef.saldos?.ars, 2);
cmp("saldo USD", usdLiquido, ef.saldos?.usd, 1);
cmp("saldo USDT", usdtLiquido, ef.saldos?.usdt, 1);
cmp("líquido total valuado",
    arsLiquido + usdLiquido * FX.usd + usdtLiquido * FX.usdt, ef.saldos?.total_valuado_ars, 5);
cmp("te deben", teDeben.reduce((a, d) => a + saldoArs(d), 0), ef.te_deben_ars, 2);
cmp("debés", leDebes.reduce((a, d) => a + saldoArs(d), 0), ef.debes_ars, 2);

const deudaCuotas = planesVivos.reduce((a, p) => {
  const quedan = p.total_installments - cuotaActual(p) + 1;
  const m = p.currency === "ARS" ? Number(p.monthly_amount) : arsVivo(p.monthly_amount, p.currency);
  return a + m * quedan;
}, 0);
cmp("deuda en cuotas", deudaCuotas, ef.deuda_en_cuotas_ars, 5);

cmp("patrimonio neto",
    arsLiquido + usdLiquido * FX.usd + usdtLiquido * FX.usdt
      + teDeben.reduce((a, d) => a + saldoArs(d), 0)
      - leDebes.reduce((a, d) => a + saldoArs(d), 0) - deudaCuotas,
    ef.patrimonio_neto_ars, 10);

const mesEste = HOY.slice(0, 7);
const delMes = txs.filter((t) => mesAr(t.occurred_at) === mesEste && !NO_ES_GASTO.has(catDe(t)));
cmp("mes en curso: egresos",
    delMes.filter((t) => t.type === "egreso").reduce((a, t) => a + arsFlujo(t), 0),
    ef.mes_actual?.egresos_ars);
cmp("mes en curso: ingresos",
    delMes.filter((t) => t.type === "ingreso").reduce((a, t) => a + arsFlujo(t), 0),
    ef.mes_actual?.ingresos_ars);
cmp("cotización USD", FX.usd, ef.cotizaciones?.usd_blue, 0.01);

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("7. resumen_diario");
console.log("=".repeat(96));

const rd = await tool("resumen_diario");
const hoyGasto = enRango(HOY, HOY).filter((t) => t.type === "egreso" && !NO_ES_GASTO.has(catDe(t)));
cmp("gasto de hoy", hoyGasto.reduce((a, t) => a + arsFlujo(t), 0), rd.hoy?.gasto_ars);
cmp("movimientos de hoy", hoyGasto.length, rd.hoy?.movimientos, 0);

const desde24 = Date.now() - 24 * 36e5;
const nuevas = txs.filter((t) => t.source === "email" && t.type === "egreso"
  && new Date(t.created_at).getTime() >= desde24);
cmp("novedades: cantidad", nuevas.length, rd.novedades?.cantidad, 0);
cmp("novedades: total", nuevas.reduce((a, t) => a + arsFlujo(t), 0), rd.novedades?.total_ars, 2);
cmp("novedades: con crédito",
    nuevas.filter(esCredito).reduce((a, t) => a + arsFlujo(t), 0),
    rd.novedades?.de_eso_con_credito_ars, 2);

const mesPrev = sumarMeses(mesEste, -1);
const egrPrev = txs.filter((t) => mesAr(t.occurred_at) === mesPrev && t.type === "egreso" && !NO_ES_GASTO.has(catDe(t)))
  .reduce((a, t) => a + arsFlujo(t), 0);
cmp("mes pasado completo", egrPrev, rd.mes?.mes_pasado_completo_ars);
cmp("promedio diario", egrPrev / diasDelMes(mesPrev), rd.hoy?.promedio_diario_ars);

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("8. compromisos_futuros");
console.log("=".repeat(96));

const cf = await tool("compromisos_futuros", { meses: 4 });
for (let k = 0; k < 4; k++) {
  const mes = sumarMeses(mesEste, k);
  const activos = planes.filter((p) => {
    const c = cuotaActual(p) + k;
    return c >= 1 && c <= p.total_installments;
  });
  const fila = (cf.por_mes ?? []).find((x) => x.mes === mes);
  cmp(`${mes}: cuotas`,
      activos.reduce((a, p) => a + (p.currency === "ARS" ? Number(p.monthly_amount) : arsVivo(p.monthly_amount, p.currency)), 0),
      fila?.cuotas_ars, 2);
  cmp(`${mes}: cantidad de cuotas`, activos.length, fila?.cantidad_de_cuotas, 0);
}

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("9. patrimonio_evolucion — invariante del proyecto");
console.log("=".repeat(96));

// La regla escrita en el CLAUDE.md: el último punto de la serie tiene que dar
// igual que el patrimonio de hoy. Si alguien toca `get_metrics` o la RPC de la
// serie sin tocar la otra, se separan en silencio y nadie se entera.
const pe = await tool("patrimonio_evolucion", { meses: 6 });
cmp("último punto de la serie = patrimonio de hoy",
    ef.patrimonio_neto_ars, pe.patrimonio_hoy_ars, 1);
cmp("último punto de la serie = último de `serie`",
    pe.patrimonio_hoy_ars, pe.serie?.at(-1)?.patrimonio, 1);
cmp("variación = último − anteúltimo",
    (pe.serie?.at(-1)?.patrimonio ?? 0) - (pe.serie?.at(-2)?.patrimonio ?? 0),
    pe.variacion_del_mes_ars, 1);
cmp("la variación se descompone entera",
    pe.variacion_del_mes_ars, (pe.de_eso_por_el_dolar_ars ?? 0) + (pe.de_eso_tuyo_ars ?? 0), 1);

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("10. movimientos fila por fila (los últimos 20)");
console.log("=".repeat(96));

// Los totales pueden cerrar con filas equivocadas adentro. Esto compara cada
// movimiento que se le muestra al usuario contra su fila en la base.
const tvHoy = await tool("transacciones_ver", { periodo: "ultimos_7_dias" });
const enPanel = tvHoy.panel?.movimientos ?? [];
const crudas = new Map(enRango(sumarDias(HOY, -6), HOY).map((t) => [t.id, t]));
cmp("filas en el panel = filas en la base", crudas.size, enPanel.length, 0);
let filasMal = 0;
for (const m of enPanel.slice(0, 20)) {
  const t = crudas.get(m.id);
  if (!t) { filasMal++; console.log(`  MAL  id ${m.id} no existe en la base`); continue; }
  const problemas = [];
  if (Math.abs(Number(t.amount) - m.monto) > 0.005) problemas.push(`monto ${t.amount} vs ${m.monto}`);
  if (t.currency !== m.moneda) problemas.push(`moneda ${t.currency} vs ${m.moneda}`);
  if (t.type !== m.tipo) problemas.push(`tipo ${t.type} vs ${m.tipo}`);
  if (catDe(t) !== m.categoria) problemas.push(`categoría ${catDe(t)} vs ${m.categoria}`);
  if (metDe(t) !== m.metodo) problemas.push(`método ${metDe(t)} vs ${m.metodo}`);
  if (diaAr(t.occurred_at) !== m.dia) problemas.push(`día ${diaAr(t.occurred_at)} vs ${m.dia}`);
  if (Math.abs(arsFlujo(t) - m.ars) > 1) problemas.push(`ars ${Math.round(arsFlujo(t))} vs ${m.ars}`);
  if (problemas.length) { filasMal++; console.log(`  MAL  id ${m.id}: ${problemas.join(" · ")}`); }
}
cmp("filas con algún campo mal", 0, filasMal, 0);

// ===========================================================================
console.log("\n" + "=".repeat(96));
console.log("11. cotizaciones");
console.log("=".repeat(96));

const cz = await tool("cotizaciones");
for (const casa of ["blue", "oficial", "cripto"]) {
  const f = delDia(casa);
  const q = (cz.cotizaciones ?? []).find((x) => String(x.cual).toLowerCase().includes(casa));
  cmp(`${casa} compra`, Number(f.compra), q?.compra, 1);
  cmp(`${casa} venta`, Number(f.venta), q?.venta, 1);
}

// ===========================================================================
// La verdad, para que la use la prueba de punta a punta (que corre en Python y
// verifica que el asistente DIGA estos números, no otros).
// ===========================================================================
const verdad = {
  hoy: HOY,
  fx: FX,
  periodos: Object.fromEntries(PERIODOS.map(([n, d1, d2]) => {
    const filas = enRango(d1, d2);
    return [n, {
      desde: d1, hasta: d2,
      egresos: Math.round(filas.filter((t) => t.type === "egreso" && !NO_ES_GASTO.has(catDe(t)))
        .reduce((a, t) => a + arsFlujo(t), 0)),
      ingresos: Math.round(filas.filter((t) => t.type === "ingreso" && !NO_ES_GASTO.has(catDe(t)))
        .reduce((a, t) => a + arsFlujo(t), 0)),
      cantidad: filas.length,
    }];
  })),
  categorias_mes_pasado: Object.fromEntries(["Delivery", "Transporte", "Ocio", "Comida"].map((c) => [
    c, Math.round(enRango(`${mesPas}-01`, `${mesPas}-${diasDelMes(mesPas)}`)
      .filter((t) => catDe(t) === c && t.type === "egreso")
      .reduce((a, t) => a + arsFlujo(t), 0)),
  ])),
  saldos: {
    ars: Math.round(arsLiquido), usd: Math.round(usdLiquido), usdt: Math.round(usdtLiquido),
    patrimonio: Math.round(arsLiquido + usdLiquido * FX.usd + usdtLiquido * FX.usdt
      + teDeben.reduce((a, d) => a + saldoArs(d), 0)
      - leDebes.reduce((a, d) => a + saldoArs(d), 0) - deudaCuotas),
  },
  deudas: {
    te_deben: Math.round(teDeben.reduce((a, d) => a + saldoArs(d), 0)),
    le_debes: Math.round(leDebes.reduce((a, d) => a + saldoArs(d), 0)),
    por_persona: Object.fromEntries([...new Set(vivas.map((d) => nombrePer.get(d.person_id)))].map((p) => [
      p, Math.round(vivas.filter((d) => nombrePer.get(d.person_id) === p)
        .reduce((a, d) => a + (d.direction === "to_collect" ? 1 : -1) * saldoArs(d), 0)),
    ])),
  },
  tarjetas: { total_sin_pagar: Math.round(totalSinPagar), cuota_mensual: Math.round(
    planesVivos.reduce((a, p) => a + (p.currency === "ARS" ? Number(p.monthly_amount) : arsVivo(p.monthly_amount, p.currency)), 0)) },
  cotizaciones: { blue_compra: Number(delDia("blue").compra), blue_venta: Number(delDia("blue").venta) },
  gasto_mas_grande_semana: (() => {
    const g = enRango(lunesDe(HOY), HOY)
      .filter((t) => t.type === "egreso" && !NO_ES_GASTO.has(catDe(t)))
      .sort((a, b) => arsFlujo(b) - arsFlujo(a))[0];
    return g ? { que: g.description, ars: Math.round(arsFlujo(g)), dia: diaAr(g.occurred_at) } : null;
  })(),
};
const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./.verdad.json", import.meta.url), JSON.stringify(verdad, null, 2), "utf8");
console.log("\n(verdad de referencia escrita en scripts/.verdad.json)");

// ===========================================================================
console.log("\n" + "=".repeat(96));
if (!fallas.length) {
  console.log(`TODO CIERRA — ${corridas} comprobaciones contra la base cruda.`);
} else {
  console.log(`${fallas.length} de ${corridas} NO CIERRAN:\n`);
  for (const f of fallas) {
    console.log(`  · ${f.que}`);
    console.log(`      base ${P(f.base)}  ·  herramienta ${P(f.herramienta)}` +
                (f.dif != null ? `  ·  diferencia ${P(f.dif)}` : ""));
  }
}
console.log("=".repeat(96));
process.exit(fallas.length ? 1 : 0);
