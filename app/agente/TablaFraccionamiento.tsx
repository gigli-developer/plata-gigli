import type { Celda, Fraccionamiento, ItemCelda } from "./fraccionamiento";

/**
 * La tabla del fraccionamiento: por hecho y por capa. CONTEXTO_PANEL.md §2.3.1.
 *
 * Solo dibuja. Qué va en cada celda lo decide `armarFraccionamiento`
 * (`lib/fraccionamiento.ts`), que está probado con las recetas de
 * FRACCIONAMIENTO.md. Acá no se agrupa ni se calcula nada.
 *
 * **Versión A (23/09):** cada capa tiene su color, en una barra de 2px a la
 * izquierda del renglón. Es lo que reemplaza al título de columna cuando la tabla
 * se apila en mobile, donde las tres columnas no entran.
 *
 * El resultado del pedido y el neto por persona **ya no viven acá**: van arriba,
 * antes de la tabla, en `TarjetaPropuesta`. Abajo quedaba como una nota al pie de
 * algo que es la conclusión.
 */

const CAPAS = [
  { n: 1, titulo: "Hecho", pregunta: "¿qué pasó y cuánto te toca?", barra: "border-l-accent" },
  { n: 2, titulo: "Plata", pregunta: "¿quién puso la plata?", barra: "border-l-sky" },
  { n: 3, titulo: "Deuda", pregunta: "¿quién le debe a quién?", barra: "border-l-emerald" },
] as const;

/**
 * El color del renglón. La capa 3 es la única que cambia según el dato: coral
 * cuando la deuda es tuya. Ese coral **no significa error** (§1.3.8): el rojo de
 * "falló" es el borde entero de la card, no una barra adentro de una celda.
 */
function barra(capa: 1 | 2 | 3, i: ItemCelda) {
  if (i.tipo !== "operacion") return "border-l-line";
  if (capa === 3 && i.deuda === "pagar") return "border-l-coral";
  if (capa === 3 && i.deuda === null) return "border-l-line";
  return CAPAS[capa - 1].barra;
}

function VistaCelda({ c }: { c: Celda }) {
  // Vacía es "Nada", a propósito: en la receta 3.1 que la capa 2 esté vacía es una
  // decisión ("pusiste lo que te tocaba"), no un dato que falta.
  if (c.items.length === 0) return <span className="text-faint italic">Nada</span>;
  return (
    <ul className="space-y-1.5">
      {c.items.map((i, k) => (
        <li key={k} className={`border-l-2 pl-2.5 ${barra(c.capa, i)}`}>
          {i.tipo === "operacion" ? (
            <span className="text-fg">{i.texto}</span>
          ) : (
            <span className="text-faint" title={i.texto}>Lo hace la operación de la capa {i.desdeCapa}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function TablaFraccionamiento({ f }: { f: Fraccionamiento }) {
  return (
    <div className="mt-3 space-y-3 text-sm">
      {f.antes.length > 0 && (
        <p className="rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-muted">
          <span className="text-fg">Antes de aplicar:</span> {f.antes.join(" · ")}
        </p>
      )}

      <div className="overflow-x-auto">
        <div className={`hidden gap-x-4 border-b border-line pb-2 lg:grid ${f.compuesta ? "lg:grid-cols-[8rem_1fr_1fr_1fr]" : "lg:grid-cols-3"}`}>
          {f.compuesta && <p className="label-micro">Hecho</p>}
          {CAPAS.map((c) => (
            <p key={c.n} className="label-micro">
              Capa {c.n} · {c.titulo}
              <span className="block normal-case tracking-normal text-faint">{c.pregunta}</span>
            </p>
          ))}
        </div>

        {f.filas.map((fila, i) => (
          <div
            key={fila.hecho?.id ?? i}
            className={`gap-x-4 border-b border-line/50 py-2.5 lg:grid ${f.compuesta ? "lg:grid-cols-[8rem_1fr_1fr_1fr]" : "lg:grid-cols-3"}`}
          >
            {f.compuesta && <p className="mb-1 font-display text-fg lg:mb-0">{fila.hecho?.titulo}</p>}
            {fila.celdas.map((c, k) => (
              <div key={c.capa} className="flex gap-2 py-0.5 lg:block">
                {/* En mobile la columna no se ve: cada celda lleva su capa escrita. */}
                <span className="label-micro w-14 shrink-0 pt-0.5 lg:hidden">{CAPAS[k].titulo}</span>
                <div className="min-w-0 flex-1">
                  <VistaCelda c={c} />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {f.sinClasificar.length > 0 && (
        <div className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">
          <p>Operaciones que no se pudieron ubicar en el fraccionamiento. No debería pasar: es un error del agente.</p>
          <ul className="mt-1 list-disc pl-4">{f.sinClasificar.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}

      {f.supuestos.length > 0 && (
        <p className="text-[0.7rem] text-faint" title={f.supuestos.join("\n")}>Hay columnas que la tabla supuso por falta de un dato. Pasá el mouse para ver cuáles.</p>
      )}
    </div>
  );
}
