/**
 * Lector del stream del agente (`text/event-stream`), sin dependencias.
 *
 * Vive aparte de la página a propósito: es la parte donde un error no se ve en
 * pantalla hasta que un evento llega partido, y así se puede probar con Node
 * directo (`node central/scripts/probar-sse.mjs`), con el mismo código que corre
 * en el navegador. No importa nada con alias `@/` por la misma razón.
 *
 * Dos cosas que no se ven a simple vista y rompen un lector ingenuo:
 *
 *   · **Un evento puede llegar partido en dos trozos**, y dos eventos pueden
 *     llegar en uno. El lector junta texto hasta ver la línea en blanco que
 *     cierra cada evento, nunca asume que un trozo es un evento.
 *   · **Una `ñ` o una `é` pueden quedar partidas entre dos trozos de bytes.** El
 *     agente habla en castellano ("Préstamos", "débito"), así que decodificar cada
 *     trozo por separado llenaría el texto de `�`. `TextDecoder` con
 *     `stream: true` guarda el byte suelto hasta que llega el resto.
 */

// ── El contrato ─────────────────────────────────────────────────────────────
// Copia del tipo `Evento` de `plata/agente.ts` (leído el 14/09/2026, con
// `precio_conocido` de `2de3c65`). No se importa porque el kernel es otro
// paquete, con otras dependencias. Si cambia allá, cambia acá.

export type Uso = {
  tokensEntrada: number;
  tokensSalida: number;
  tokensCacheWrite?: number;
  tokensCacheRead?: number;
};

/**
 * Los siete campos de la fila de `propuestas` que trae el evento, tal cual
 * (`EventoPropuesta` en `plata/agente.ts`, desde `c9c2229`). El resto —estado
 * actual, operaciones, hechos— se lee de la tabla por `id`: aprobarla o
 * rechazarla después no emite otro evento.
 */
export type EventoPropuesta = {
  id: number;
  tipo: string;
  estado: string;
  motivo_confirmacion: string | null;
  resumen: string;
  /** `numeric` en la base: puede llegar como número o como texto. */
  monto_ars: number | string | null;
  /** En UTC, como lo devuelve la base. */
  expira_en: string;
};

export type Evento =
  | { tipo: "propuesta"; propuesta: EventoPropuesta }
  | { tipo: "texto"; texto: string }
  | { tipo: "tool"; nombre: string; entrada: unknown }
  | { tipo: "aviso"; texto: string }
  /**
   * `precio_conocido: false` es "no sé": `usd` vale 0 porque el modelo no está en
   * la tabla de precios, no porque haya sido gratis.
   */
  | { tipo: "fin"; usos: Array<{ modelo: string; uso: Uso; usd: number; precio_conocido: boolean }>; duracionMs: number; tools: Record<string, number> }
  | { tipo: "error"; texto: string };

/**
 * Lo que la página recibe: un `Evento` del contrato, o una de dos variantes que
 * solo existen del lado del panel, para que un evento raro **se vea** en vez de
 * perderse o de romper el turno.
 *
 * `desconocido` importa más de lo que parece. Las propuestas llegaron así, como un
 * tipo nuevo, antes de que esta página lo conociera: si hubiera descartado en
 * silencio lo que no conoce, una propuesta que espera la aprobación de Lucas
 * habría desaparecido de la pantalla sin aviso. El próximo tipo nuevo va a hacer
 * lo mismo.
 */
export type EventoLeido =
  | Evento
  | { tipo: "desconocido"; nombre: string }
  | { tipo: "ilegible"; crudo: string };

const esTexto = (o: Record<string, unknown>) => typeof o.texto === "string";

/** De un `data:` crudo a un evento. Nunca tira: lo que no entiende, lo nombra. */
export function interpretar(crudo: string): EventoLeido {
  let o: unknown;
  try {
    o = JSON.parse(crudo);
  } catch {
    return { tipo: "ilegible", crudo };
  }
  if (!o || typeof o !== "object" || typeof (o as { tipo?: unknown }).tipo !== "string") {
    return { tipo: "ilegible", crudo };
  }
  const e = o as Record<string, unknown> & { tipo: string };
  switch (e.tipo) {
    case "texto":
    case "aviso":
    case "error":
      return esTexto(e) ? (e as Evento) : { tipo: "ilegible", crudo };
    case "tool":
      return typeof e.nombre === "string" ? (e as Evento) : { tipo: "ilegible", crudo };
    case "fin":
      return Array.isArray(e.usos) ? (e as Evento) : { tipo: "ilegible", crudo };
    case "propuesta": {
      // Sin id no hay card: no se puede leer su estado ni aprobarla. Mejor
      // "ilegible", que se ve, que una card rota.
      const p = e.propuesta as Record<string, unknown> | undefined;
      const valida = !!p && typeof p === "object" && Number.isFinite(Number(p.id)) && typeof p.resumen === "string";
      return valida ? (e as Evento) : { tipo: "ilegible", crudo };
    }
    default:
      return { tipo: "desconocido", nombre: e.tipo };
  }
}

/**
 * Lector incremental. `empujar` recibe texto ya decodificado, en trozos de
 * cualquier tamaño, y devuelve los eventos que quedaron completos. `terminar`
 * procesa lo que haya quedado sin cerrar cuando el stream se corta.
 *
 * Sigue la especificación de `text/event-stream` en lo que usa el contrato:
 * líneas que empiezan con `:` son comentarios, varias líneas `data:` de un mismo
 * evento se unen con salto de línea, y el resto de los campos se ignora. Acepta
 * finales de línea `\n` y `\r\n`, incluso con el `\r` y el `\n` en trozos
 * distintos.
 */
export function crearLectorSSE() {
  let resto = "";
  let datos: string[] = [];

  const despachar = (): EventoLeido[] => {
    if (datos.length === 0) return [];
    const crudo = datos.join("\n");
    datos = [];
    return [interpretar(crudo)];
  };

  const procesarLinea = (linea: string): EventoLeido[] => {
    if (linea.endsWith("\r")) linea = linea.slice(0, -1);
    if (linea === "") return despachar();
    if (linea.startsWith(":")) return [];
    const i = linea.indexOf(":");
    const campo = i === -1 ? linea : linea.slice(0, i);
    let valor = i === -1 ? "" : linea.slice(i + 1);
    if (valor.startsWith(" ")) valor = valor.slice(1);
    if (campo === "data") datos.push(valor);
    return [];
  };

  return {
    empujar(trozo: string): EventoLeido[] {
      resto += trozo;
      const salida: EventoLeido[] = [];
      let n: number;
      while ((n = resto.indexOf("\n")) !== -1) {
        const linea = resto.slice(0, n);
        resto = resto.slice(n + 1);
        salida.push(...procesarLinea(linea));
      }
      return salida;
    },
    terminar(): EventoLeido[] {
      const salida: EventoLeido[] = [];
      if (resto) {
        salida.push(...procesarLinea(resto));
        resto = "";
      }
      salida.push(...despachar());
      return salida;
    },
  };
}

/**
 * Lee un cuerpo de respuesta entero y avisa cada evento apenas llega. Es lo que
 * usa la página, y lo que usa la prueba: el mismo código en los dos lados.
 */
export async function leerEventos(
  cuerpo: ReadableStream<Uint8Array>,
  alEvento: (e: EventoLeido) => void
): Promise<void> {
  const lector = crearLectorSSE();
  const decodificador = new TextDecoder();
  const trozos = cuerpo.getReader();
  const emitir = (es: EventoLeido[]) => es.forEach(alEvento);

  while (true) {
    const { done, value } = await trozos.read();
    if (done) break;
    emitir(lector.empujar(decodificador.decode(value, { stream: true })));
  }
  emitir(lector.empujar(decodificador.decode()));
  emitir(lector.terminar());
}
