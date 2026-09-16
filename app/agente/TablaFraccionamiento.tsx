import { ars } from "@/lib/format";
import type { Celda, Fraccionamiento, LineaResultado } from "./fraccionamiento";

/**
 * La tabla del fraccionamiento: por hecho y por capa. CONTEXTO_PANEL.md §2.3.1.
 *
 * Solo dibuja. Qué va en cada celda y qué frase lleva el resultado lo decide
 * `armarFraccionamiento` (`lib/fraccionamiento.ts`), que está probado con las
 * recetas de FRACCIONAMIENTO.md. Acá no se agrupa ni se calcula nada.
 */

const CAPAS = [
  { n: 1, titulo: "Hecho", pregunta: "¿qué pasó y cuánto te toca?" },
  { n: 2, titulo: "Plata", pregunta: "¿quién puso la plata?" },
  { n: 3, titulo: "Deuda", pregunta: "¿quién le debe a quién?" },
] as const;

function plata(monto: number, moneda: string) {
  if (moneda === "ARS") return ars(monto);
  if (moneda === "USD") return `US$ ${monto.toLocaleString("es-AR")}`;
  return `${monto.toLocaleString("es-AR")} ${moneda}`;
}

function VistaCelda({ c }: { c: Celda }) {
  // Vacía es "Nada", a propósito: en la receta 3.1 que la capa 2 esté vacía es una
  // decisión ("pusiste lo que te tocaba"), no un dato que falta.
  if (c.items.length === 0) return <span className="text-faint">Nada</span>;
  return (
    <ul className="space-y-1">
      {c.items.map((i, k) =>
        i.tipo === "operacion" ? (
          <li key={k} className="text-fg">{i.texto}</li>
        ) : (
          <li key={k} className="text-faint" title={i.texto}>Lo hace la operación de la capa {i.desdeCapa}</li>
        ),
      )}
    </ul>
  );
}

function frase(r: LineaResultado) {
  switch (r.como) {
    case "corrige":
      return "Corrige lo registrado: el antes y el después están en la columna Hecho.";
    case "cuesta":
      return `Te cuesta ${plata(r.monto, r.moneda)}`;
    case "deja":
      return `Te deja ${plata(r.monto, r.moneda)}`;
    default:
      return null;
  }
}

export default function TablaFraccionamiento({ f }: { f: Fraccionamiento }) {
  const lineas = f.resultado.map((r) => ({ r, texto: frase(r) })).filter((x) => x.texto);
  const creditoAbierto = f.resultado.some((r) => r.creditoAbierto);

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
                <VistaCelda c={c} />
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

      {/* El resultado y el neto van abajo de TODA la tabla, no adentro del último
          hecho, para que no se lean como parte del truco. */}
      {lineas.map(({ r, texto }) => (
        <p key={r.moneda} className={`font-display ${r.como === "corrige" ? "text-sm text-muted" : "text-fg"}`}>
          {r.como === "corrige" ? texto : <>Resultado del pedido: <span className="tnum">{texto}</span></>}
        </p>
      ))}
      {creditoAbierto && (
        <p className="text-xs text-amber">Con tarjeta: en Plata el patrimonio no se mueve igual hasta que pagues el resumen.</p>
      )}
      {f.neto.length > 0 && (
        <p className="text-xs text-muted">
          <span className="text-fg">Cómo queda cada uno:</span>{" "}
          {f.neto
            .map((n) => (n.neto < 0 ? `${n.nombre}, le debés ${plata(-n.neto, n.moneda)}` : `${n.nombre} te debe ${plata(n.neto, n.moneda)}`))
            .join(" · ")}
        </p>
      )}
      {f.supuestos.length > 0 && (
        <p className="text-[0.7rem] text-faint" title={f.supuestos.join("\n")}>Hay columnas que la tabla supuso por falta de un dato. Pasá el mouse para ver cuáles.</p>
      )}
    </div>
  );
}
