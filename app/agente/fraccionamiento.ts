/**
 * La tabla del fraccionamiento de una propuesta, como datos: por hecho y por capa.
 * `CONTEXTO_PANEL.md` §2.3.1, sobre las tres capas de `FRACCIONAMIENTO.md` §1.
 *
 * Es lógica pura, sin React ni base, a propósito: se prueba con las recetas de
 * `FRACCIONAMIENTO.md` como datos (`node central/scripts/probar-fraccionamiento.mjs`).
 * No importa nada con alias `@/`, para que Node lo pueda cargar directo, y por eso
 * mismo la pantalla `/agente` de adentro de Plata lo usa como copia textual.
 *
 * **El panel no calcula cifras acá.** Agrupa operaciones y elige qué frase va en
 * la línea de resultado; el número lo trae `control`, calculado por la tool.
 */

// ── Lo que viene de la fila (CONTRATOS §2.5, `kernel/propuestas.ts`) ─────────

export type OperacionPropuesta = {
  op: string;
  tabla?: string;
  fn?: string;
  texto?: string;
  /** La capa más baja que toca (0 a 3). La pone la tool. */
  capa?: number;
  /**
   * Todas las capas que cubre. Back lo agregó el 15/09 y ya llega en las RPC de
   * producción. Sigue siendo opcional: las propuestas viejas no lo tienen, y sin
   * él una RPC de varias capas trae solo la más baja (ver `capasQueCubre`).
   */
  capas?: number[];
  /** Id del hecho en `hechos`. Solo puede faltar en capa 0. */
  hecho?: string | null;
  /**
   * Los datos de la fila que se va a escribir. Acá se mira **una sola cosa**:
   * `direction` de una fila de `debts`, que dice de qué lado está la deuda. Es el
   * único dato que permite pintar la capa 3 sin leerle el texto a la operación,
   * que está escrito para una persona y no es un campo.
   */
  datos?: { direction?: string | null } | null;
};

export type HechoPropuesta = { id: string; titulo: string };

export type ControlMoneda = {
  moneda: string;
  variacion_patrimonio: number;
  incluye_credito_abierto?: boolean;
  corrige_registros?: boolean;
};

/**
 * `persona` es `unknown` a propósito y no se usa nunca: en una propuesta simple
 * puede venir como `{"$ref":"p1"}`, porque la persona recién se crea al aprobar
 * (Back, `0aa6e55`). Lo que se muestra es `nombre`, que viene siempre.
 */
export type NetoPersona = { persona: unknown; nombre: string; moneda: string; neto: number };

export type EntradaFraccionamiento = {
  tipo: string;
  operaciones: OperacionPropuesta[];
  /** Solo en una compuesta: el CHECK `propuestas_compuesta_tiene_hechos` lo ata al tipo. */
  hechos?: HechoPropuesta[] | null;
  /**
   * Desde `0aa6e55` los trae **toda** propuesta nueva, simple o compuesta. Antes
   * eran solo de las compuestas, y por eso la card no tenía qué poner arriba en el
   * caso más frecuente. Siguen siendo opcionales porque las propuestas viejas
   * (#2 y #3) nacieron sin ellos.
   *
   * `control: []` no es "no se calculó": es **"no mueve plata"**, y entonces no va
   * ningún número arriba. Se distingue de `null`, que es "no se sabe".
   */
  control?: ControlMoneda[] | null;
  neto_por_persona?: NetoPersona[] | null;
};

// ── Lo que dibuja la pantalla ────────────────────────────────────────────────

export type ItemCelda =
  /** `deuda` solo lo trae una fila de `debts`; en todo lo demás es `null`. */
  | { tipo: "operacion"; texto: string; deuda: "cobrar" | "pagar" | null }
  /** La capa la hace una operación anotada en una capa más baja: no es "Nada". */
  | { tipo: "incluida"; desdeCapa: number; texto: string };

/** Una celda sin items dice "Nada": una decisión, no un dato faltante. */
export type Celda = { capa: 1 | 2 | 3; items: ItemCelda[] };

export type FilaHecho = {
  /** `null` en una propuesta simple: una sola fila, sin columna de hecho. */
  hecho: HechoPropuesta | null;
  celdas: [Celda, Celda, Celda];
};

export type LineaResultado = {
  moneda: string;
  /**
   * `corrige`: sin número, porque el control mezcla la corrección con el hecho.
   * `oculto`: variación cero; la tabla ya lo dice todo.
   */
  como: "corrige" | "cuesta" | "deja" | "oculto";
  monto: number;
  creditoAbierto: boolean;
};

export type Fraccionamiento = {
  compuesta: boolean;
  /** Capa 0: lo que se hace antes, como crear personas. Aprobar la propuesta lo confirma. */
  antes: string[];
  filas: FilaHecho[];
  /** Operaciones que no se pueden ubicar. No deberían existir: si aparecen, son un bug y se ven. */
  sinClasificar: string[];
  resultado: LineaResultado[];
  neto: NetoPersona[];
  /** Lo que la tabla supuso por falta de un dato. Se muestra, no se esconde. */
  supuestos: string[];
};

const textoDe = (o: OperacionPropuesta) =>
  o.texto?.trim() || `${o.op} ${o.tabla ?? o.fn ?? ""}`.trim();

/**
 * De qué lado está una deuda, para que la capa 3 se pinte sola: verde lo que te
 * deben, coral lo que debés (CONTEXTO_PANEL.md §1.3.8 y §2.3.1, versión A).
 *
 * Los dos valores son los que escribe `plata/tools/escritura-fraccion.ts` y los
 * mismos que lee para contestar «te debe» o «le debés». La base no tiene CHECK
 * sobre la columna, así que un valor nuevo devuelve `null` y la celda queda
 * neutra: un color de más diría algo que nadie verificó.
 */
function ladoDeLaDeuda(o: OperacionPropuesta): "cobrar" | "pagar" | null {
  if (o.tabla !== "debts") return null;
  const d = o.datos?.direction;
  return d === "to_collect" ? "cobrar" : d === "to_pay" ? "pagar" : null;
}

/**
 * Qué capas cubre una operación.
 *
 * Con `capas`, manda el dato. Sin él, una `rpc` se supone que cubre desde su
 * `capa` hasta la 3: es exacto para las tres RPC de hoy (`dividir_gasto_v2` y
 * `dividir_movimiento` hacen 1, 2 y 3; `pagar_deuda`, 2 y 3). Sin este supuesto,
 * una división dibujaría "Nada" en Plata y "Nada" en Deuda: le diría a Lucas que
 * nadie le debe nada, en la pantalla que existe para mostrárselo.
 *
 * Un insert, update o delete cubre solo su capa: las tools los arman una por capa.
 */
export function capasQueCubre(o: OperacionPropuesta): { capas: number[]; supuesto: boolean } {
  if (Array.isArray(o.capas) && o.capas.length) return { capas: [...o.capas].sort((a, b) => a - b), supuesto: false };
  if (typeof o.capa !== "number") return { capas: [], supuesto: false };
  if (o.op === "rpc" && o.capa >= 1) {
    const capas = [];
    for (let c = o.capa; c <= 3; c++) capas.push(c);
    return { capas, supuesto: capas.length > 1 };
  }
  return { capas: [o.capa], supuesto: false };
}

function comoResultado(c: ControlMoneda): LineaResultado {
  // Orden de CONTEXTO_PANEL §2.3.1, probado contra las recetas 3.1 a 3.8.
  const monto = Number(c.variacion_patrimonio);
  const como = c.corrige_registros ? "corrige" : monto === 0 ? "oculto" : monto < 0 ? "cuesta" : "deja";
  return { moneda: c.moneda, como, monto: Math.abs(monto), creditoAbierto: !!c.incluye_credito_abierto };
}

export function armarFraccionamiento(p: EntradaFraccionamiento): Fraccionamiento {
  const hechos = Array.isArray(p.hechos) ? p.hechos : [];
  // La tabla es por hecho solo si la fila lo dice: `tipo` y `hechos`. Nunca por la
  // forma de las operaciones (la lección del texto de los errores).
  const compuesta = p.tipo === "compuesta" && hechos.length > 0;

  const vacia = (): [Celda, Celda, Celda] => [
    { capa: 1, items: [] },
    { capa: 2, items: [] },
    { capa: 3, items: [] },
  ];
  const filas: FilaHecho[] = compuesta
    ? hechos.map((h) => ({ hecho: h, celdas: vacia() }))
    : [{ hecho: null, celdas: vacia() }];
  const filaDe = new Map(filas.map((f) => [f.hecho?.id ?? "", f]));

  const antes: string[] = [];
  const sinClasificar: string[] = [];
  const supuestos = new Set<string>();

  for (const o of p.operaciones ?? []) {
    const texto = textoDe(o);
    if (o.capa === 0) {
      antes.push(texto);
      continue;
    }
    const { capas, supuesto } = capasQueCubre(o);
    if (capas.length === 0 || capas.some((c) => c < 1 || c > 3)) {
      sinClasificar.push(`${texto} (sin capa válida)`);
      continue;
    }
    // Una operación sin `hecho` en una compuesta no cae en ninguna fila, y termina
    // abajo en `sinClasificar`.
    //
    // Acá había un centinela escrito como **byte NUL crudo** (`?? "\0"`) para que
    // nunca matcheara. Andaba, pero tenía dos costos: git trataba este archivo como
    // binario, así que nunca se pudo ver un diff del archivo con la lógica; y
    // cualquier editor o copia que normalizara el byte lo habría convertido en `""`,
    // que sí es una clave real del mapa. Preguntar por el hecho no necesita ninguna
    // clave imposible.
    const fila = compuesta ? (o.hecho ? filaDe.get(o.hecho) : undefined) : filas[0];
    if (!fila) {
      sinClasificar.push(`${texto} (hecho «${o.hecho ?? "ninguno"}» que no está en la lista de hechos)`);
      continue;
    }
    const [primera, ...resto] = capas;
    fila.celdas[primera - 1].items.push({ tipo: "operacion", texto, deuda: ladoDeLaDeuda(o) });
    for (const c of resto) fila.celdas[c - 1].items.push({ tipo: "incluida", desdeCapa: primera, texto });
    if (supuesto) {
      supuestos.add(
        `«${o.fn ?? o.op}» no dice qué capas cubre: se supone que desde la ${primera} hasta la 3. Cuando la operación traiga «capas», manda ese dato.`,
      );
    }
  }

  return {
    compuesta,
    antes,
    filas,
    sinClasificar,
    resultado: (p.control ?? []).map(comoResultado),
    neto: p.neto_por_persona ?? [],
    supuestos: [...supuestos],
  };
}
