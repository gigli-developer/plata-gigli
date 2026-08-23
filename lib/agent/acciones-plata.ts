import type { SupabaseClient } from "@supabase/supabase-js";
// Solo el tipo: se borra al compilar, así que no hay ciclo en runtime aunque
// `tools.ts` importe este archivo. Mismo truco que en `targets.ts`.
import type { Tool } from "./tools";
import { fetchCategories, fetchDebts, fetchFxBoard, fetchPaymentMethods, fetchPersons, fetchTransactionsRange, type DebtView, type TxView } from "../db";
import { guardar, VENCE_MIN } from "./propuestas";
import { dia as diaAr, esFecha, sumarMeses, mesLargo } from "../fechas";

/**
 * Las tres operaciones que Plata sabía hacer y la voz no alcanzaba: cobrar o
 * pagar una deuda, partir un consumo en cuotas, y registrar un cambio de
 * divisas.
 *
 * ## Por qué son finitas
 *
 * Cada una ejecuta **una sola función de Postgres** —`pagar_deuda`,
 * `convertir_a_cuotas`, `register_exchange`—, y esa es toda la gracia: adentro
 * de una función, o pasa todo o no pasa nada. La versión a mano de «convertir a
 * cuotas» borró un consumo de $457.500 sin crear sus cuotas el 18/08/2026, y de
 * ahí salieron las tres RPCs.
 *
 * Acá NO se ejecuta nada. Las tres son proponedoras: resuelven a qué deuda o a
 * qué movimiento se refería, arman la previsualización y la guardan. La ejecuta
 * `confirmar` cuando el usuario dice que sí — el mismo cerrojo que ya protege
 * los movimientos y la agenda.
 *
 * ## La resolución es el trabajo
 *
 * «Thiago me pagó» no trae un id: hay que mirar las deudas pendientes y decidir
 * de cuál habla. Cuando hay más de una, **se pregunta**; adivinar mueve plata a
 * la deuda equivocada, y eso no se ve hasta que no cierran los números.
 */

// Copias locales de dos helpers de `tools.ts`. No se importan de allá a
// propósito: `tools.ts` importa este archivo para armar su lista, y traer algo
// suyo en runtime cerraría el ciclo. Son tres líneas.
const importe = (n: number, moneda: string) =>
  `${moneda === "ARS" ? "$" : `${moneda} `}` +
  n.toLocaleString("es-AR", { maximumFractionDigits: 2 });

/** Solo el número: `15000` → `"15.000"`. Copia local, igual que `importe`. */
const numero = (n: number) => n.toLocaleString("es-AR", { maximumFractionDigits: 2 });

/**
 * El número grande de la tarjeta rica: con signo y SIN el "$" (el contrato con
 * la cara es `"-15.000"`); las otras monedas llevan su nombre. Copia local de
 * `montoPanel` en tools.ts, por el mismo motivo del ciclo.
 */
const montoPanel = (n: number, moneda: string, signo: "" | "-" | "+" = "") =>
  `${signo}${moneda === "ARS" ? "" : `${moneda} `}${numero(n)}`;

const plano = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const MONEDAS = ["ARS", "USD", "USDT"] as const;

const moneda = (s: unknown): string | null => {
  const t = plano(String(s ?? ""));
  if (!t) return null;
  if (/^(ars|pesos?|peso|\$)$/.test(t)) return "ARS";
  if (/^(usdt|tether|cripto)$/.test(t)) return "USDT";
  if (/^(usd|dolar|dolares|u\$s|us\$)$/.test(t)) return "USD";
  const directo = MONEDAS.find((m) => plano(m) === t);
  return directo ?? null;
};

// ---------------------------------------------------------------------------
// Cobrar o pagar una deuda
// ---------------------------------------------------------------------------

const deudaPagar: Tool = {
  name: "deuda_pagar",
  description:
    "PROPONE registrar el cobro o el pago de una deuda con una persona. NO ejecuta: " +
    "devuelve una previsualización que hay que confirmar con `confirmar`.\n" +
    "Usar cuando diga que alguien le pagó o que él le pagó a alguien: 'Thiago me pagó', " +
    "'le pagué a Fran los diez mil', 'me devolvió la plata', 'saldá lo de Branko'.\n" +
    "Si no dice cuánto, se entiende que es TODO lo que quedaba y se salda. " +
    "Pasá el nombre tal como lo dijo: acá se busca contra sus deudas pendientes.\n" +
    "⚠️ Esto NO sirve para un ingreso o gasto suelto: si lo que pasó no salda ninguna " +
    "deuda cargada, usá `plata_registrar`.",
  input_schema: {
    type: "object",
    properties: {
      persona: {
        type: "string",
        description: "Cómo la nombró: 'Thiago', 'Fran'. Una o dos palabras.",
      },
      monto: {
        type: "number",
        description:
          "Cuánto, en la moneda de la deuda. OMITILO si dijo que le pagó todo o que " +
          "quedaron a mano: sin monto se salda el resto.",
      },
      nota: {
        type: "string",
        description: "Detalle opcional que quede en el movimiento: 'por transferencia'.",
      },
    },
    required: ["persona"],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    const quien = String(input?.persona ?? "").trim();
    if (!quien) return { ok: false, motivo: "No me dijiste de quién." };

    const monto = input?.monto === undefined || input?.monto === null
      ? null
      : Number(input.monto);
    if (monto !== null && (!Number.isFinite(monto) || monto <= 0)) {
      return { ok: false, motivo: "Ese monto no es válido." };
    }

    let deudas: DebtView[];
    try {
      deudas = await fetchDebts(sb);
    } catch (e) {
      return { ok: false, motivo: `No pude leer las deudas: ${e instanceof Error ? e.message : e}` };
    }

    const t = plano(quien);
    const suyas = deudas.filter(
      (d) => d.status === "pending" && d.outstanding > 0.5 &&
        (plano(d.person) === t || plano(d.person).includes(t) || t.includes(plano(d.person))),
    );

    if (!suyas.length) {
      const pendientes = [...new Set(
        deudas.filter((d) => d.status === "pending" && d.outstanding > 0.5).map((d) => d.person),
      )];
      return {
        ok: false,
        motivo: `No tengo ninguna deuda pendiente con "${quien}".`,
        con_deudas_pendientes: pendientes,
        que_hacer: pendientes.length
          ? "Decile con quién SÍ tiene deudas y preguntale a cuál se refería. NO registres nada por tu cuenta."
          : "Decile que no tiene ninguna deuda pendiente cargada. Si igual quiere anotar el movimiento, usá `plata_registrar`.",
      };
    }

    // Varias deudas candidatas: no se adivina. Pagar la equivocada deja las dos
    // mal y no se nota hasta que no cierran los números.
    if (suyas.length > 1) {
      // ⚠️ El match es por substring en las dos direcciones, así que «ZZA C»
      // puede traer deudas de VARIAS personas. Antes el mensaje se las
      // atribuía todas a la primera («Fulano tiene 3 deudas») y ningún ítem
      // decía de quién era cada una: el modelo no tenía con qué desambiguar
      // aunque quisiera.
      const personas = [...new Set(suyas.map((d) => d.person))];
      return {
        ok: false,
        motivo: personas.length === 1
          ? `${personas[0]} tiene ${suyas.length} deudas pendientes.`
          : `"${quien}" coincide con ${suyas.length} deudas de ${personas.length} personas distintas.`,
        deudas: suyas.map((d) => ({
          persona: d.person,
          que: d.description || (d.direction === "to_collect" ? "te debe" : "le debés"),
          pendiente: importe(d.outstanding, d.currency),
          desde: d.date,
        })),
        que_hacer:
          "Preguntale a cuál se refiere, nombrándolas CON su persona y su monto. NO elijas vos.",
      };
    }

    const d = suyas[0];
    if (monto !== null && monto > d.outstanding + 0.5) {
      return {
        ok: false,
        motivo: `${importe(monto, d.currency)} es más de lo que queda pendiente (${importe(d.outstanding, d.currency)}).`,
        que_hacer:
          "Confirmale el saldo real y preguntale si quiere saldarla del todo. Si dice que sí, " +
          "volvé a llamar esta herramienta SIN monto.",
      };
    }

    const efectivo = monto ?? d.outstanding;
    const salda = d.outstanding - efectivo <= 0.5;
    const cobro = d.direction === "to_collect";

    const p = guardar({
      dominio: "plata",
      tipo: "crear",
      pagoDeuda: {
        debtId: d.id,
        monto,                    // null = saldar el resto, la RPC lo entiende así
        nota: String(input?.nota ?? "").trim() || undefined,
        persona: d.person,
        moneda: d.currency,
        saldo: d.outstanding,
        direccion: d.direction,
      },
    });

    return {
      ok: true,
      propuesta: {
        id: p.id,
        dominio: "plata",
        tipo: "crear",
        antes: null,
        despues: {
          titulo: `${cobro ? "Cobro a" : "Pago a"} ${d.person}`,
          cuando: importe(efectivo, d.currency),
          nota: salda
            ? `queda saldada${d.description ? ` · ${d.description}` : ""}`
            : `quedan ${importe(d.outstanding - efectivo, d.currency)} de ${importe(d.outstanding, d.currency)}`,
        },
      },
      para_decir: salda
        ? `${cobro ? "Cobrás" : "Pagás"} ${importe(efectivo, d.currency)} y quedan a mano. ¿Lo registro?`
        : `${cobro ? "Cobrás" : "Pagás"} ${importe(efectivo, d.currency)} y quedan ${importe(d.outstanding - efectivo, d.currency)}. ¿Lo registro?`,
      que_hacer: "Leele la propuesta y ESPERÁ el sí. Recién ahí llamás `confirmar`.",
    };
  },
};

// ---------------------------------------------------------------------------
// Partir un consumo en cuotas
// ---------------------------------------------------------------------------

const cuotasConvertir: Tool = {
  name: "cuotas_convertir",
  description:
    "PROPONE convertir un consumo que está cargado como pago único en un plan de cuotas. " +
    "NO ejecuta: hay que confirmar con `confirmar`.\n" +
    "Usar para 'pasá ese consumo a tres cuotas', 'la matrícula fue en 6 cuotas', " +
    "'eso lo pagué en cuotas'.\n" +
    "Hace falta porque el importador de mails NO puede ver las cuotas: toda compra en " +
    "cuotas entra como un pago único y hay que corregirla después.\n" +
    "Pasá el movimiento como lo nombró ('la matrícula', 'lo de MercadoLibre'): acá se busca.",
  input_schema: {
    type: "object",
    properties: {
      movimiento: {
        type: "string",
        description: "Cómo nombró el consumo. Se busca por parecido en la descripción.",
      },
      cuotas: { type: "number", description: "En cuántas cuotas. Entre 2 y 60." },
      primera: {
        type: "string",
        description:
          "Solo si dijo desde qué mes arranca, en YYYY-MM-DD. Si lo omitís, arranca el " +
          "1° del mes del consumo, que es lo correcto casi siempre.",
      },
    },
    required: ["movimiento", "cuotas"],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    const aguja = String(input?.movimiento ?? "").trim();
    const cantidad = Math.round(Number(input?.cuotas));
    if (!aguja) return { ok: false, motivo: "No me dijiste qué consumo." };
    if (!Number.isFinite(cantidad) || cantidad < 2 || cantidad > 60) {
      return { ok: false, motivo: "Las cuotas tienen que ser un número entre 2 y 60." };
    }
    const primera = String(input?.primera ?? "").trim();
    if (primera && !esFecha(primera)) {
      return { ok: false, motivo: `"${primera}" no es una fecha válida (va YYYY-MM-DD).` };
    }

    let candidatos: TxView[];
    try {
      // Mismo criterio que `plata_registrar` para encontrar un movimiento por
      // lo que se dijo: se busca por descripción sobre una ventana amplia.
      candidatos = await fetchTransactionsRange(sb, "2000-01-01", "2100-01-01", aguja, 40);
    } catch (e) {
      return { ok: false, motivo: `No pude buscar el movimiento: ${e instanceof Error ? e.message : e}` };
    }

    const gastos = candidatos.filter((x) => x.type === "egreso");
    if (!gastos.length) {
      return {
        ok: false,
        motivo: `No encontré ningún gasto que se parezca a "${aguja}".`,
        que_hacer: "Pedile más datos (el comercio, el monto o la fecha). NO inventes cuál era.",
      };
    }
    if (gastos.length > 1) {
      return {
        ok: false,
        motivo: `Hay ${gastos.length} gastos que se parecen a "${aguja}".`,
        cuales: gastos.slice(0, 5).map((x) => ({
          que: x.desc, monto: importe(x.amount, x.currency), cuando: x.date,
        })),
        que_hacer: "Preguntale cuál era, nombrándolos con su monto. NO elijas vos.",
      };
    }

    const tx = gastos[0];

    /*
     * Dos guardas que salieron de la prueba adversarial del 19/08, y las dos
     * evitan que un consumo desaparezca:
     *
     * 1. La cuota que redondea a cero. La RPC hace `round(monto/cuotas, 2)`: si
     *    da 0, el plan no representa nada y el consumo —que era el único
     *    registro del gasto— ya se borró. Un plan de $0 es plata evaporada.
     * 2. La fecha imposible. Un error de un dígito al dictar el año («2015» por
     *    «2025») crea un plan que nace terminado: `fetchInstallments` descarta
     *    los planes cuyas cuotas ya vencieron, así que el plan queda INVISIBLE
     *    en todas las vistas y el consumo tampoco está. Se probó con 1900,
     *    2015 y 2400: las tres se tragaban el gasto entero.
     */
    const mensual = Math.round((tx.amount / cantidad) * 100) / 100;
    if (mensual <= 0) {
      return {
        ok: false,
        motivo:
          `${importe(tx.amount, tx.currency)} en ${cantidad} cuotas da menos de un centavo por cuota.`,
        que_hacer:
          "Decile que ese consumo es muy chico para partirlo en tantas cuotas, y proponé " +
          "menos cuotas. NO lo conviertas: el plan quedaría en cero y se perdería el gasto.",
      };
    }

    // El mes del consumo, en hora argentina (el `occurredAt` viene en UTC y un
    // gasto de las 22:00 del día 31 es del mes siguiente si se lo mira crudo).
    const mesDelConsumo = diaAr(tx.occurredAt).slice(0, 7);
    if (primera) {
      const mesPrimera = primera.slice(0, 7);
      if (mesPrimera < mesDelConsumo) {
        return {
          ok: false,
          motivo: `La primera cuota (${primera}) es anterior al consumo (${diaAr(tx.occurredAt)}).`,
          que_hacer:
            "Confirmale la fecha: con esa, el plan nacería ya terminado y el gasto " +
            "desaparecería de todas las vistas. Volvé a proponer con el mes correcto.",
        };
      }
      // Doce meses de aire alcanza para cualquier compra real; más que eso es
      // un año mal dictado.
      const tope = sumarMeses(mesDelConsumo, 12);
      if (mesPrimera > tope) {
        return {
          ok: false,
          motivo: `La primera cuota (${primera}) cae más de un año después del consumo.`,
          que_hacer: "Preguntale desde qué mes arranca de verdad. NO lo conviertas con esa fecha.",
        };
      }
    }

    const p = guardar({
      dominio: "plata",
      tipo: "editar",
      cuotas: {
        txId: tx.id,
        cantidad,
        primera: primera || undefined,
        desc: tx.desc,
        monto: tx.amount,
        moneda: tx.currency,
      },
    });

    // Lo que el plan va a sumar de verdad. El modelo guarda UN importe mensual,
    // así que con montos no divisibles el plan suma menos que el consumo — y eso
    // hay que decirlo, no esconderlo (el caso real: MercadoLibre 15.000,04).
    const suma = Math.round(mensual * cantidad * 100) / 100;
    const diferencia = Math.round((tx.amount - suma) * 100) / 100;

    // Un redondeo de centavos es tolerable; una distorsión del 1% ya no. Con
    // montos normales el desvío es de milésimas de por ciento — esto solo se
    // dispara con montos absurdos ($1 en 60 cuotas queda 20% arriba), donde el
    // plan dejaría de representar el gasto que reemplaza.
    if (Math.abs(diferencia) > tx.amount * 0.01) {
      return {
        ok: false,
        motivo:
          `Partido en ${cantidad}, el plan sumaría ${importe(suma, tx.currency)} en vez de ` +
          `${importe(tx.amount, tx.currency)}.`,
        que_hacer:
          "Ese monto no se puede partir en tantas cuotas sin deformarlo. Proponé menos cuotas.",
      };
    }
    // Para la tarjeta rica: el mes de la primera y la última cuota, resueltos
    // acá para que la cara no tenga que hacer aritmética de meses.
    const primeraMes = primera ? primera.slice(0, 7) : mesDelConsumo;
    const ultimaMes = sumarMeses(primeraMes, cantidad - 1);

    return {
      ok: true,
      propuesta: {
        id: p.id,
        dominio: "plata",
        tipo: "editar",
        antes: {
          titulo: tx.desc,
          cuando: `${importe(tx.amount, tx.currency)} en un pago`,
        },
        despues: {
          titulo: tx.desc,
          cuando: `${cantidad} cuotas de ${importe(mensual, tx.currency)}`,
          nota: (primera ? `desde ${primera}` : "desde el mes del consumo")
            + (diferencia !== 0 ? ` · suma ${importe(suma, tx.currency)}` : ""),
        },
        // La tarjeta rica: el total como número grande, los casilleros de
        // cuotas, y el aviso de qué pasa con el consumo original.
        monto: montoPanel(tx.amount, tx.currency),
        sub: tx.card ? `${tx.desc} · ${tx.card}` : tx.desc,
        cuotas_n: cantidad,
        campos: [
          { k: "cada mes", v: importe(mensual, tx.currency) },
          { k: "primera", v: mesLargo(primeraMes) },
          { k: "última", v: mesLargo(ultimaMes) },
        ],
        aviso:
          "El consumo se borra y queda en la papelera. Se hace en una sola " +
          "operación: o pasan las dos cosas o no pasa ninguna.",
        aviso_tono: "ambar",
      },
      suma_del_plan: suma,
      diferencia_con_el_consumo: diferencia,
      para_decir:
        `Paso ${tx.desc} de ${importe(tx.amount, tx.currency)} a ${cantidad} cuotas de ` +
        `${importe(mensual, tx.currency)}.` +
        (diferencia !== 0
          ? ` Ojo que el plan suma ${importe(suma, tx.currency)}, ${importe(Math.abs(diferencia), tx.currency)} ` +
            `${diferencia > 0 ? "menos" : "más"} que el consumo.`
          : "") +
        " ¿Lo hago?",
      que_hacer:
        "Leele la propuesta y ESPERÁ el sí. Recién ahí llamás `confirmar`." +
        (diferencia !== 0
          ? " Decile también la diferencia: el plan guarda un solo importe mensual y no " +
            "puede tener una última cuota distinta, así que después la corrige a mano si le importa."
          : ""),
    };
  },
};

// ---------------------------------------------------------------------------
// Registrar un cambio de divisas
// ---------------------------------------------------------------------------

/** Qué casa de cambio cotiza cada moneda. El peso vale uno y no se consulta. */
const CASA: Record<string, string | null> = { ARS: null, USD: "blue", USDT: "cripto" };

const divisasRegistrar: Tool = {
  name: "divisas_registrar",
  description:
    "PROPONE registrar un cambio de moneda (comprar o vender dólares o USDT). NO ejecuta: " +
    "hay que confirmar con `confirmar`.\n" +
    "Usar para 'compré cien dólares', 'vendí 200 USDT', 'cambié 500 mil pesos a dólares'.\n" +
    "Decí SIEMPRE qué moneda sale y cuál entra. El monto puede ser el de cualquiera de " +
    "los dos lados: el otro se calcula con la cotización del día.\n" +
    "Registrar el cambio mueve los dos saldos — no es solo anotar el dato.",
  input_schema: {
    type: "object",
    properties: {
      de: { type: "string", enum: ["ARS", "USD", "USDT"], description: "La moneda que SALE." },
      a: { type: "string", enum: ["ARS", "USD", "USDT"], description: "La moneda que ENTRA." },
      monto_de: { type: "number", description: "Cuánto sale. Pasá este o `monto_a`, no los dos." },
      monto_a: { type: "number", description: "Cuánto entra. Pasá este o `monto_de`." },
      cotizacion: {
        type: "number",
        description:
          "Solo si dijo a qué precio lo hizo (pesos por dólar). Si lo omitís se usa la " +
          "cotización del día, que es lo normal.",
      },
    },
    required: ["de", "a"],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    const de = moneda(input?.de);
    const a = moneda(input?.a);
    if (!de || !a) return { ok: false, motivo: "Las monedas válidas son ARS, USD y USDT." };
    if (de === a) return { ok: false, motivo: "El cambio tiene que ser entre monedas distintas." };

    const dadoDe = input?.monto_de !== undefined && input?.monto_de !== null ? Number(input.monto_de) : null;
    const dadoA = input?.monto_a !== undefined && input?.monto_a !== null ? Number(input.monto_a) : null;
    if (dadoDe === null && dadoA === null) {
      return { ok: false, motivo: "Necesito el monto de alguno de los dos lados." };
    }
    for (const v of [dadoDe, dadoA]) {
      if (v !== null && (!Number.isFinite(v) || v <= 0)) {
        return { ok: false, motivo: "Los montos tienen que ser mayores a cero." };
      }
    }

    // El valor de cada lado en pesos. Al ENTREGAR una moneda te pagan su compra;
    // al RECIBIRLA, pagás su venta. Ese spread es real y es lo que la app aplica.
    let valorDe = 1, valorA = 1, fuente: "auto" | "manual" = "auto";
    const manual = input?.cotizacion !== undefined && input?.cotizacion !== null
      ? Number(input.cotizacion) : null;

    // Los dos montos MÁS una cotización es información en conflicto: los montos
    // implican su propia cotización, que puede no ser la que dijo. Antes se
    // ignoraba la cotización en silencio y se le atribuía al usuario un número
    // que nunca mencionó («$3.000 por USD (la que dijiste)» cuando había dicho
    // 1.500). Se pregunta en vez de elegir.
    if (dadoDe !== null && dadoA !== null && manual !== null) {
      const implicita = de === "ARS" ? dadoDe / dadoA : dadoA / dadoDe;
      if (Math.abs(implicita - manual) / manual > 0.01) {
        return {
          ok: false,
          motivo:
            `Los montos dan ${importe(implicita, "ARS")} por unidad, pero me dijiste ` +
            `${importe(manual, "ARS")}.`,
          que_hacer:
            "Preguntale cuál vale: la cotización que dijo, o los dos montos. NO elijas vos " +
            "— cualquiera de las dos deja el otro número mal.",
        };
      }
    }

    if (manual !== null) {
      if (!Number.isFinite(manual) || manual <= 0) {
        return { ok: false, motivo: "Esa cotización no es válida." };
      }
      fuente = "manual";
      // Una cotización dicha a mano son siempre pesos por unidad de la moneda
      // extranjera, sin spread: el mismo número para los dos lados.
      if (de !== "ARS") valorDe = manual;
      if (a !== "ARS") valorA = manual;
    } else {
      try {
        const board = await fetchFxBoard(sb, 10);
        for (const [lado, m] of [["de", de], ["a", a]] as const) {
          const casa = CASA[m];
          if (!casa) continue;
          const q = board.quotes.find((x) => x.casa === casa);
          if (!q) {
            return {
              ok: false,
              motivo: `No tengo la cotización de ${m} hoy.`,
              que_hacer: "Pedile a qué precio lo hizo y volvé a llamar con `cotizacion`.",
            };
          }
          if (lado === "de") valorDe = q.compra; else valorA = q.venta;
        }
      } catch (e) {
        return { ok: false, motivo: `No pude leer las cotizaciones: ${e instanceof Error ? e.message : e}` };
      }
    }

    const montoDe = dadoDe ?? (dadoA! * valorA) / valorDe;
    const montoA = dadoA ?? (dadoDe! * valorDe) / valorA;
    if (!Number.isFinite(montoDe) || !Number.isFinite(montoA) || montoDe <= 0 || montoA <= 0) {
      return { ok: false, motivo: "No pude calcular el otro lado del cambio." };
    }

    const redondo = (n: number, m: string) => Number(n.toFixed(m === "ARS" ? 2 : 4));
    const salen = redondo(montoDe, de);
    const entran = redondo(montoA, a);

    // ⚠️ Si alguno de los dos lados se hace cero al redondear, no hay cambio que
    // registrar: la tasa saldría dividiendo por cero (Infinity) o NaN, y la
    // propuesta se ofrecía igual con ok:true. Peor todavía era el caso
    // intermedio: con montos chicos la cotización se recalculaba desde los
    // montos YA redondeados y daba un número creíble pero falso ($1.000 cuando
    // el día estaba $1.560) — el más peligroso, porque nadie lo duda.
    if (salen <= 0 || entran <= 0) {
      return {
        ok: false,
        motivo: "Ese monto es demasiado chico para registrar un cambio.",
        que_hacer: "Pedile el monto de nuevo. NO propongas un cambio con un lado en cero.",
      };
    }

    // Diez decimales a propósito: comprando dólares la tasa vale ~0,00065 y con
    // menos precisión se truncaba (está documentado en la migración del 03/08).
    const rate = Number((entran / salen).toFixed(10));
    if (!Number.isFinite(rate) || rate <= 0) {
      return { ok: false, motivo: "No pude calcular una cotización válida para ese cambio." };
    }

    // El precio por unidad, que es como lo piensa cualquiera; la tasa cruda de
    // la base (0,00065) no le dice nada a nadie.
    //
    // ⚠️ Sale de la cotización que se USÓ, no de dividir los montos ya
    // redondeados: con montos chicos eso devolvía un precio falso pero creíble.
    // Solo en el cruce entre dos monedas extranjeras se deriva, porque ahí «el
    // precio por unidad» no es un número que exista en ninguna casa de cambio.
    const cruceExtranjero = de !== "ARS" && a !== "ARS";
    const porUnidad = cruceExtranjero
      ? entran / salen
      : (de === "ARS" ? valorA : valorDe);
    const parExtranjero = de === "ARS" ? a : de;

    const p = guardar({
      dominio: "plata",
      tipo: "crear",
      // `porUnidad` viaja con la propuesta para que el panel de "hecho" no
      // tenga que derivarlo de los montos redondeados (ver el ⚠️ de arriba).
      cambio: {
        de, a, montoDe: salen, montoA: entran, rate, fuente,
        ...(cruceExtranjero ? {} : { porUnidad }),
      },
    });

    // Cómo se llama la fuente cuando la cotización es automática: la casa que
    // cotiza el par (blue para USD, cripto para USDT); en un cruce hay dos.
    const nombreFuente = fuente === "manual"
      ? "la que dijiste"
      : cruceExtranjero
        ? "cotizaciones del día"
        : `${CASA[parExtranjero]} del día`;
    const cotizacionTexto = cruceExtranjero
      ? `${entran / salen} ${a} por ${de}`
      : `${importe(porUnidad, "ARS")} por ${parExtranjero}`;

    return {
      ok: true,
      propuesta: {
        id: p.id,
        dominio: "plata",
        tipo: "crear",
        antes: null,
        despues: {
          titulo: `Cambio ${de} → ${a}`,
          cuando: `salen ${importe(salen, de)} · entran ${importe(entran, a)}`,
          nota: cruceExtranjero
            ? `${entran / salen} ${a} por ${de}`
            : `${importe(porUnidad, "ARS")} por ${parExtranjero}` +
              (fuente === "manual" ? " (la que dijiste)" : " (del día)"),
        },
        // La tarjeta rica: las dos patas del cambio, cada una con su moneda en
        // el rótulo (el `n` va pelado: repetirla sería decirla dos veces).
        patas: {
          sale: { n: numero(salen), l: `${de} salen` },
          entra: { n: numero(entran), l: `${a} entran` },
        },
        campos: [
          { k: "cotización", v: cotizacionTexto },
          { k: "fuente", v: nombreFuente },
        ],
        aviso: "El patrimonio no cambia: es la misma plata en otro bolsillo.",
        aviso_tono: "azul",
      },
      para_decir:
        `Salen ${importe(salen, de)} y entran ${importe(entran, a)}` +
        (cruceExtranjero ? "" : `, a ${importe(porUnidad, "ARS")} por ${parExtranjero}`) +
        ". ¿Lo registro?",
      que_hacer:
        "Leele los DOS montos y la cotización, y ESPERÁ el sí. Si te corrige un número, " +
        "volvé a proponer con el dato nuevo.",
    };
  },
};


/**
 * «Fuimos a comer con amigos, la cuenta fue X y yo puse Y» — la división que
 * Jarvis no podía razonar, convertida en calculadora con oídos.
 *
 * El reparto del trabajo es la regla de la casa: el MODELO interpreta la escena
 * (cuántos eran, cuánto puso cada uno) y ESTA herramienta hace la aritmética.
 * Sin esto, el modelo tiene prohibido calcular (numeros.py le dispara a toda
 * cifra sin respaldo) y degradaba a «registro lo que pusiste» — las deudas de
 * los demás se perdían. Pasó de verdad, y motivó la herramienta.
 *
 * La cuenta, para leerla una vez y no rederivarla:
 *   n        = personas.length + 1 (los otros + Lucas)
 *   tu parte = mi_parte, o total / n si no la dijo
 *   resto    = total − puse   → lo que pusieron los otros EN CONJUNTO
 *   cada otro debe: su parte − lo que puso (si no se sabe quién puso qué, el
 *   resto se reparte parejo entre los que no tienen `puso` explícito)
 *
 * v1 solo cobra: si vos pusiste menos que tu parte, o alguien puso de más, se
 * contesta con el motivo y qué anotar en su lugar — nunca una deuda negativa.
 */
const plataDividir: Tool = {
  name: "plata_dividir",
  description:
    "Divide un gasto compartido que TODAVÍA no está cargado: calcula la parte de cada " +
    "uno, propone cargar TU parte como gasto real y el resto como préstamos, y deja " +
    "UNA deuda por persona. Usar para 'fuimos a comer y puse yo', 'pagué la cena de " +
    "todos', 'dividí la cuenta con...'.\n" +
    "Vos solo pasás la escena: total de la cuenta, cuánto puso él, y quiénes más " +
    "estaban (con lo que puso cada uno SI lo dijo). La herramienta calcula todo y " +
    "devuelve las cifras: repetilas de ahí, no las calcules vos.\n" +
    "⚠️ Para dividir un gasto YA cargado está el botón de la app, no esto. Y si él " +
    "puso MENOS que su parte, la herramienta te va a decir qué proponer en su lugar.",
  input_schema: {
    type: "object",
    properties: {
      total: { type: "number", description: "La cuenta completa, lo que salió todo." },
      puse: { type: "number", description: "Lo que puso él de su bolsillo." },
      personas: {
        type: "array",
        description:
          "Los OTROS comensales (él no va acá). Si dijo cuánto puso alguno, va en `puso`.",
        items: {
          type: "object",
          properties: {
            nombre: { type: "string" },
            puso: { type: "number", description: "Solo si lo dijo; si no, se reparte parejo." },
          },
          required: ["nombre"],
        },
      },
      mi_parte: {
        type: "number",
        description: "Solo si dijo cuánto le tocaba a él; si no, total dividido cabezas.",
      },
      descripcion: { type: "string", description: "Qué fue: 'Cena en lo de Rafa', 'Asado'." },
      categoria: { type: "string", description: "Categoría de SU parte (Comida, Ocio...)." },
      metodo: { type: "string", description: "Con qué pagó, si lo dijo." },
      fecha: { type: "string", description: "YYYY-MM-DD solo si NO fue hoy." },
    },
    required: ["total", "puse", "personas", "descripcion"],
  },
  canales: ["telegram", "pc"],
  async handler(sb: SupabaseClient, input: Record<string, unknown>) {
    const total = Number(input?.total ?? 0);
    const puse = Number(input?.puse ?? 0);
    const descripcion = String(input?.descripcion ?? "").trim();
    const crudas = Array.isArray(input?.personas) ? (input.personas as { nombre?: unknown; puso?: unknown }[]) : [];
    if (!(total > 0) || !(puse > 0)) return { ok: false, motivo: "Falta el total o lo que puso." };
    if (!descripcion) return { ok: false, motivo: "Falta qué fue (la descripción)." };
    if (!crudas.length) return { ok: false, motivo: "Falta con quiénes lo dividió." };
    if (puse > total + 0.5) {
      return { ok: false, motivo: `Puso ${numero(puse)} y la cuenta fue ${numero(total)}: revisá los montos con él.` };
    }
    const fecha = input?.fecha !== undefined ? String(input.fecha).trim() : "";
    if (fecha && !esFecha(fecha)) return { ok: false, motivo: `"${fecha}" no es una fecha válida.` };

    const redondo2 = (x: number) => Math.round(x * 100) / 100;
    const n = crudas.length + 1;
    const parte = redondo2(input?.mi_parte !== undefined ? Number(input.mi_parte) : total / n);
    if (!(parte > 0) || parte > total) return { ok: false, motivo: "Su parte no puede ser eso." };
    if (puse < parte - 0.5) {
      return {
        ok: false,
        motivo:
          `Puso ${numero(puse)} pero su parte es ${numero(parte)}: acá no hay nada que cobrar. ` +
          "Lo que corresponde es cargar lo que puso como gasto suyo (`plata_registrar`), y si " +
          "le quedó debiendo a alguien, que lo diga y se anota como deuda aparte.",
      };
    }

    // Lo que pusieron los otros en conjunto, repartido entre los que no
    // declararon cuánto. La parte de cada OTRO sale de lo que no es de Lucas.
    const parteOtro = redondo2((total - parte) / crudas.length);
    const restoAjeno = total - puse;
    const declarados = crudas.filter((c) => c.puso !== undefined);
    const sumaDeclarada = declarados.reduce((a, c) => a + Number(c.puso), 0);
    if (sumaDeclarada > restoAjeno + 0.5) {
      return { ok: false, motivo: "Lo que pusieron los demás supera lo que faltaba de la cuenta: revisá los montos." };
    }
    const sinDeclarar = crudas.length - declarados.length;
    const parejo = sinDeclarar > 0 ? redondo2(Math.max(0, restoAjeno - sumaDeclarada) / sinDeclarar) : 0;

    const partes: { nombre: string; debe: number }[] = [];
    for (const c of crudas) {
      const nombre = String(c.nombre ?? "").trim();
      if (!nombre) return { ok: false, motivo: "Hay una persona sin nombre en la lista." };
      const puso = c.puso !== undefined ? Number(c.puso) : parejo;
      const debe = redondo2(parteOtro - puso);
      if (debe <= 0) {
        return {
          ok: false,
          motivo:
            `${nombre} puso su parte o más (${numero(puso)} contra ${numero(parteOtro)}): dejalo ` +
            "afuera de la lista y volvé a proponer con los demás.",
        };
      }
      partes.push({ nombre, debe });
    }
    // Los centavos del redondeo se absorben en la deuda más grande, para que la
    // suma cierre EXACTA contra lo que puso (la RPC valida con 0,5 de tolerancia,
    // pero acá se puede cerrar a cero y se cierra).
    const diff = redondo2(puse - parte - partes.reduce((a, x) => a + x.debe, 0));
    if (Math.abs(diff) > 0.5) return { ok: false, motivo: "Las partes no cierran contra lo que puso: revisá los montos." };
    if (diff !== 0) {
      const mayor = partes.reduce((a, b) => (b.debe > a.debe ? b : a));
      mayor.debe = redondo2(mayor.debe + diff);
    }
    const ajeno = redondo2(puse - parte);

    // Personas: existentes por nombre (sin tildes ni mayúsculas); las que no
    // están se marcan como nuevas y las crea la RPC — la tarjeta lo avisa.
    const plano = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const existentes = await fetchPersons(sb);
    const nuevas: string[] = [];
    for (const pa of partes) {
      const hit = existentes.find((e) => plano(e.name) === plano(pa.nombre));
      if (hit) pa.nombre = hit.name;         // el nombre canónico de la base
      else nuevas.push(pa.nombre);
    }

    const [cats, mets] = await Promise.all([fetchCategories(sb), fetchPaymentMethods(sb)]);
    const cat = input?.categoria
      ? cats.find((c) => plano(c.name) === plano(String(input.categoria))) ?? null : null;
    const met = input?.metodo
      ? mets.find((m) => plano(m.name) === plano(String(input.metodo))) ?? null : null;

    const iso = fecha ? `${fecha}T12:00:00-03:00` : new Date().toISOString();
    const pdte = guardar({
      dominio: "plata", tipo: "crear",
      division: {
        total, puse, parte, descripcion,
        categoriaId: cat?.id, metodoId: met?.id,
        fecha: iso, moneda: "ARS",
        personas: partes, nuevas,
      },
    });

    const porCabeza = partes.every((x) => x.debe === partes[0].debe)
      ? ` (${numero(partes[0].debe)} cada uno)` : "";
    return {
      ok: true,
      propuesta: {
        id: pdte.id, dominio: "plata", tipo: "crear", antes: null,
        monto: `-${numero(parte)}`,
        sub: `${descripcion}${cat ? ` · ${cat.name}` : ""}${met ? ` · ${met.name}` : ""}`,
        campos: [
          { k: "la cuenta", v: `${numero(total)} entre ${n}` },
          { k: "pusiste", v: numero(puse) },
          { k: "te tocaba", v: numero(parte) },
        ],
        lista_rica: partes.map((x) => ({
          monto: numero(x.debe), titulo: x.nombre, detalle: "te debe",
        })),
        aviso:
          `Tu parte queda como gasto real; los ${numero(ajeno)} prestados van a Préstamos, ` +
          "no cuentan como gasto y el patrimonio no cambia: se vuelven «te deben»." +
          (nuevas.length ? ` Se agregan como personas nuevas: ${nuevas.join(", ")}.` : ""),
        aviso_tono: "azul",
        vence_min: VENCE_MIN,
      },
      para_decir:
        `Dividir ${descripcion}: tu parte ${numero(parte)}, y te deben ${numero(ajeno)} en total${porCabeza}.`,
      que_hacer:
        `Contale la división y ESPERÁ el sí. Si confirma, llamá confirmar con id "${pdte.id}". ` +
        "Si corrige un monto o una persona, volvé a proponer con los datos nuevos.",
    };
  },
};

export const TOOLS_ACCIONES_PLATA: Tool[] = [deudaPagar, cuotasConvertir, divisasRegistrar, plataDividir];

/** Las que arman propuesta: `run.ts` las necesita para su red de seguridad. */
export const NOMBRES_PROPONEN = TOOLS_ACCIONES_PLATA.map((t) => t.name);
