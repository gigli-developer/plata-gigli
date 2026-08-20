import type { CamposEvento, Evento } from "./google";
import type { EditTx, NewTx, TxView } from "../db";

/**
 * Cambios propuestos y todavía no ejecutados.
 *
 * La regla del canal: **leer es libre, escribir se confirma**. Las herramientas de
 * escritura no tocan nada — arman una propuesta, la guardan acá y devuelven una
 * previsualización. Recién cuando el usuario dice que sí, `agenda_confirmar`
 * la busca por id y la ejecuta.
 *
 * Por qué el estado vive acá y no en el modelo: si la ejecución dependiera de que
 * el modelo repita los datos correctos en una segunda llamada, una alucinación o
 * una transcripción mala del "sí" podrían crear un evento distinto al que se
 * mostró. Así, lo que se confirma es exactamente lo que se previsualizó.
 *
 * En memoria del proceso, igual que el historial de conversación: se pierde en
 * cada deploy y caduca sola. Una propuesta vieja no debería ejecutarse nunca.
 */

export type TipoCambio = "crear" | "editar" | "borrar";

/** Sobre qué se propone el cambio. Una sola herramienta confirma los dos. */
export type Dominio = "agenda" | "plata" | "cerebro";

export type Pendiente = {
  id: string;
  dominio: Dominio;
  tipo: TipoCambio;
  creada: number;
  turno: number;        // en qué request se creó — ver `nuevoTurno`

  // --- agenda ---
  eventoId?: string;
  campos?: CamposEvento;
  base?: Evento;        // el evento tal como está HOY (para editar/borrar)
  /** Borrado en lote: varios eventos en UNA sola confirmación. */
  bases?: Evento[];

  // --- plata ---
  tx?: NewTx;                    // para crear
  txEdit?: EditTx;               // para editar
  txId?: number;                 // id de la transacción a editar o borrar
  txAntes?: TxView;              // cómo está hoy
  /** Borrado en lote, igual que `bases` en agenda: varios movimientos, UNA confirmación. */
  txVarios?: TxView[];

  /*
   * --- una nota para el cerebro ---
   *
   * `cerebro_anotar` propone y `confirmar` NO escribe nada acá: devuelve la
   * acción y la PC escribe en su disco, igual que la consulta. El servidor
   * nunca ve la bitácora — solo transporta lo que el modelo redactó y Lucas
   * aprobó mirando la tarjeta.
   */
  notaCerebro?: {
    tipo: "decision" | "correccion";
    titulo: string;
    /** La línea `que:` del encabezado — para una corrección, LA REGLA. */
    resumen: string;
    detalle: string;
    verificar?: string;
  };

  /*
   * --- operaciones sobre lo YA cargado ---
   *
   * Pagar una deuda, partir un consumo en cuotas y registrar un cambio de
   * divisas. Las tres van con `dominio: "plata"` a propósito: la tarjeta del HUD
   * elige el rótulo por dominio, y «se va a cargar / va a quedar así» es
   * exactamente lo que hay que preguntar. Un dominio nuevo caería en el
   * fallback de agenda y diría «¿lo agendo?» sobre un pago de deuda.
   *
   * Cada una guarda lo MÍNIMO para ejecutar (los ids) más lo que hace falta para
   * redactar la respuesta sin volver a consultar la base.
   */
  pagoDeuda?: {
    debtId: number;
    /** null = saldar el resto. La RPC lo interpreta así. */
    monto: number | null;
    nota?: string;
    persona: string;
    moneda: string;
    /** Lo que quedaba pendiente al momento de proponer, para poder redactar. */
    saldo: number;
    direccion: "to_collect" | "to_pay";
  };
  cuotas?: {
    txId: number;
    cantidad: number;
    primera?: string;
    desc: string;
    monto: number;
    moneda: string;
  };
  cambio?: {
    de: string;
    a: string;
    montoDe: number;
    montoA: number;
    rate: number;
    fuente: "auto" | "manual";
  };
};

const PENDIENTES = new Map<string, Pendiente>();

/**
 * Contador de requests. Sirve para una sola cosa, pero importante: una propuesta
 * NO se puede confirmar en la misma request en la que se creó.
 *
 * Sin esto, nada impedía que el modelo llamara `agenda_cambiar` y, leyendo el id
 * del propio resultado, encadenara `agenda_confirmar` en la vuelta siguiente —
 * todo dentro del mismo turno, sin que el usuario dijera una palabra. La regla
 * "escribir se confirma" quedaba sostenida solo por el prompt, que es una
 * sugerencia. Ahora es estructural.
 *
 * (Asume requests serializadas, que es el caso: un solo usuario y una réplica.)
 */
let turnoActual = 0;
export const nuevoTurno = () => ++turnoActual;
const TTL_MS = 10 * 60 * 1000;   // 10 minutos: si tardaste más, mejor volver a proponer
const MAX = 20;

/** Ids cortos y fáciles de decir en voz alta, sin caracteres ambiguos. */
function nuevoId(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789"; // sin i, l, o, 0, 1
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function limpiar() {
  const ahora = Date.now();
  for (const [id, p] of PENDIENTES) {
    if (ahora - p.creada > TTL_MS) PENDIENTES.delete(id);
  }
  // Techo duro por si algo genera propuestas en loop.
  while (PENDIENTES.size > MAX) {
    const masVieja = [...PENDIENTES.entries()].sort((a, b) => a[1].creada - b[1].creada)[0];
    PENDIENTES.delete(masVieja[0]);
  }
}

export function guardar(
  p: Omit<Pendiente, "id" | "creada" | "turno" | "dominio"> & { dominio?: Dominio },
): Pendiente {
  limpiar();
  let id = nuevoId();
  while (PENDIENTES.has(id)) id = nuevoId();
  // "agenda" por defecto: fue el primer dominio y sus llamadas no lo pasan.
  const pendiente: Pendiente = {
    dominio: "agenda", ...p, id, creada: Date.now(), turno: turnoActual,
  };
  PENDIENTES.set(id, pendiente);
  return pendiente;
}

/**
 * Propuestas que YA se ejecutaron, con qué fue cada una.
 *
 * Existe por el "sí" repetido. Una propuesta se consume al confirmarla, así que un
 * segundo "sí, dale" —común cuando el usuario habla y no está seguro de que lo
 * escuchaste— caía en "inexistente", y de ahí el modelo tomaba uno de dos caminos,
 * los dos malos: volvía a proponer lo mismo (camino a cargarlo dos veces) o decía
 * que no existía, cuando en realidad acababa de hacerlo.
 *
 * Con esto la respuesta correcta está disponible: "eso ya lo hice recién".
 */
const EJECUTADAS = new Map<string, { cuando: number; que: string }>();
const TTL_EJECUTADA_MS = 30 * 60 * 1000;

export function marcarEjecutada(id: string, que: string) {
  const ahora = Date.now();
  for (const [k, v] of EJECUTADAS) {
    if (ahora - v.cuando > TTL_EJECUTADA_MS) EJECUTADAS.delete(k);
  }
  while (EJECUTADAS.size > MAX) EJECUTADAS.delete(EJECUTADAS.keys().next().value!);
  EJECUTADAS.set(String(id).trim().toLowerCase(), { cuando: ahora, que });
}

export function yaEjecutada(id: string): string | null {
  const v = EJECUTADAS.get(String(id).trim().toLowerCase());
  if (!v) return null;
  if (Date.now() - v.cuando > TTL_EJECUTADA_MS) {
    EJECUTADAS.delete(String(id).trim().toLowerCase());
    return null;
  }
  return v.que;
}

/** ¿Sigue viva esta propuesta? Sin consumirla. */
export const existe = (id: string): boolean =>
  PENDIENTES.has(String(id).trim().toLowerCase());

/**
 * Cuántos turnos pasaron desde que se propuso. 1 = se propuso en el turno anterior,
 * que es el caso normal. Más que eso significa que la conversación siguió por otro
 * lado, y un "sí" pelado deja de ser inequívoco. `null` si ya no existe.
 */
export function edadEnTurnos(id: string): number | null {
  const p = PENDIENTES.get(String(id).trim().toLowerCase());
  return p ? turnoActual - p.turno : null;
}

/** Motivo por el que no se pudo tomar, para poder explicarlo distinto. */
export type NoSePudo = "inexistente" | "mismo_turno";

export function tomar(id: string): Pendiente | NoSePudo {
  limpiar();
  const p = PENDIENTES.get(String(id).trim().toLowerCase());
  if (!p) return "inexistente";

  // El cerrojo: propuesta y confirmación no pueden ser el mismo turno. El
  // usuario tiene que haber hablado en el medio.
  if (p.turno === turnoActual) return "mismo_turno";
  // Se consume: una propuesta se ejecuta una sola vez. Si el usuario repite
  // "sí, dale", no queremos dos eventos iguales.
  PENDIENTES.delete(p.id);
  return p;
}

export function descartar(id: string): boolean {
  return PENDIENTES.delete(String(id).trim().toLowerCase());
}
