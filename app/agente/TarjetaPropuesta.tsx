"use client";

import { useEffect, useMemo, useState } from "react";
import { ars } from "@/lib/format";
import { aplicarPropuesta, rechazarPropuesta, traerPropuesta, type FilaPropuesta } from "./propuestas";
import { armarFraccionamiento, type LineaResultado } from "./fraccionamiento";
import TablaFraccionamiento from "./TablaFraccionamiento";

/**
 * La propuesta, tal como la ve Lucas. Una sola card para el chat y para
 * `/propuestas`: CONTEXTO_PANEL.md §2.3, §2.3.1 y §2.5.1.
 *
 * **Versión A (23/09), la que eligió Lucas.** El orden es: resumen → resultado del
 * pedido **grande** → por qué pide un sí → tabla por hecho y capa → cómo queda cada
 * uno, en fichas → vencimiento y botones. Antes el resultado era una línea al final,
 * debajo de la tabla: la conclusión leída como nota al pie.
 *
 * - En el chat llega con los siete campos del evento (`vivo`): la card lee la fila
 *   entera por `id` y la vuelve a leer mientras siga abierta, porque aprobarla o
 *   rechazarla no emite otro evento.
 * - En `/propuestas` llega con la fila entera y no lee nada: la pantalla refresca
 *   la lista, y cien cards leyendo cada una por su cuenta serían cien consultas.
 *
 * Aprobar y rechazar llaman a `aplicar_propuesta` y `rechazar_propuesta`, que
 * existen en producción desde el bloque E (verificado contra `pg_proc` el 15/09).
 *
 * **Aprobar escribe en los datos reales de Plata y no se deshace**, así que va en
 * dos pasos: el botón pide confirmación adentro de la card y recién el segundo
 * click llama a la base. No se usa el `confirm()` del navegador: se puede bloquear
 * y, cuando aparece, no dice qué se va a escribir.
 */

// ── Por qué pide confirmación ───────────────────────────────────────────────
// Los seis valores del CHECK de la 015, en su orden de precedencia. Los tres
// últimos llevan el texto de CONTRATOS §2.5; los tres primeros, el de §2.3 del
// brief. **Es una copia de un enum, que es lo que más se desactualiza**: el
// verificador (`verificar-contrato.mjs`) exige que haya una entrada por cada valor
// del CHECK de la última migración, y un valor que igual se cuele se muestra
// crudo, nunca vacío.
export const TEXTO_MOTIVO: Record<string, string> = {
  clase: "Es de las que no se deshacen solas: confirma siempre.",
  compuesta: "Tiene varias partes y se aplican todas juntas: confirma siempre.",
  personas_nuevas: "Confirmá que son personas nuevas y no una que ya tenés con otro nombre.",
  monto: "Supera el umbral de confirmación.",
  varias_filas: "Se aplican todas o ninguna.",
  sin_monto: "El monto lo calcula la base al aplicar.",
};

const SIN_MOTIVO = "Nada obligaba a confirmarla: quedó propuesta porque se pidió proponer.";

// Colores de CONTEXTO_PANEL.md §1.3.8: solo `fallida` es roja.
export const ESTADO: Record<string, { texto: string; clase: string }> = {
  pendiente: { texto: "Esperando tu sí", clase: "border-accent/40 text-accent" },
  aprobada: { texto: "Aprobada", clase: "border-sky/40 text-sky" },
  aplicada: { texto: "Aplicada", clase: "border-emerald/40 text-emerald" },
  rechazada: { texto: "Rechazada", clase: "text-subtle" },
  expirada: { texto: "Venció", clase: "text-faint" },
  obsoleta: { texto: "Quedó vieja", clase: "text-faint" },
  fallida: { texto: "Falló", clase: "border-coral/40 text-coral" },
};

export const ABIERTOS = new Set(["pendiente", "aprobada"]);

const hora = (iso: string) =>
  new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** `ars()` solo sabe de pesos, y el control viene por moneda, sin convertir. */
function plata(monto: number, moneda: string) {
  if (moneda === "ARS") return ars(monto);
  if (moneda === "USD") return `US$ ${monto.toLocaleString("es-AR")}`;
  return `${monto.toLocaleString("es-AR")} ${moneda}`;
}

/**
 * La frase del número grande. Las cuatro salidas las decide
 * `lib/fraccionamiento.ts`, probado contra las recetas:
 *
 * - `corrige` va **sin número**: en una división de algo ya registrado, el +36.000
 *   que devuelve la cuenta se leería como una ganancia (§2.3.1).
 * - `oculto` (variación cero) no lleva frase: la tabla ya lo dice todo.
 *
 * Nunca dice "tu patrimonio baja": con tarjeta de crédito eso no coincide con lo
 * que muestra Plata, y Lucas vería subir el patrimonio después de aprobar.
 */
function frase(r: LineaResultado): string | null {
  switch (r.como) {
    case "corrige":
      return "Corrige lo registrado";
    case "cuesta":
      return `Te cuesta ${plata(r.monto, r.moneda)}`;
    case "deja":
      return `Te deja ${plata(r.monto, r.moneda)}`;
    default:
      return null;
  }
}

export default function TarjetaPropuesta({
  inicial,
  vivo = false,
  onResuelta,
}: {
  inicial: FilaPropuesta;
  vivo?: boolean;
  /** Para que la pantalla que agrupa por estado mueva la card de sección enseguida. */
  onResuelta?: () => void;
}) {
  const id = Number(inicial.id);
  const [fila, setFila] = useState<FilaPropuesta>(inicial);
  const [noEsta, setNoEsta] = useState(false);
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());
  /** `null` = los dos botones; si no, el que está pidiendo confirmación. */
  const [confirmando, setConfirmando] = useState<"aprobar" | "rechazar" | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState("");
  const [enviando, setEnviando] = useState(false);
  /** Lo que no quedó escrito en la fila: un error de red, o el sí que salió bien. */
  const [aviso, setAviso] = useState<{ tono: "ok" | "mal"; texto: string } | null>(null);

  // Sin `vivo`, la fila la maneja la pantalla que la contiene.
  useEffect(() => { if (!vivo) setFila(inicial); }, [inicial, vivo]);

  useEffect(() => {
    if (!vivo) return;
    let vigente = true;
    let reloj: ReturnType<typeof setInterval> | undefined;
    const leer = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await traerPropuesta(id);
        if (!vigente) return;
        setErrorLectura(null);
        setAhora(Date.now());
        if (!r) {
          setNoEsta(true);
          clearInterval(reloj);
        } else {
          setFila(r);
          if (!ABIERTOS.has(r.estado)) clearInterval(reloj);
        }
      } catch (e) {
        if (vigente) setErrorLectura(e instanceof Error ? e.message : String(e));
      }
    };
    leer();
    reloj = setInterval(leer, 10_000);
    return () => {
      vigente = false;
      clearInterval(reloj);
    };
  }, [id, vivo]);

  const fraccionamiento = useMemo(
    () => (Array.isArray(fila.operaciones) ? armarFraccionamiento({ ...fila, operaciones: fila.operaciones }) : null),
    [fila],
  );

  /**
   * Aprobar o rechazar. Las dos funciones de la base **no tiran excepción cuando
   * dicen que no**: devuelven `{ estado, error }` y la fila YA quedó cerrada así
   * (`obsoleta` si los datos cambiaron, `fallida` si una operación no entró). Por
   * eso lo que devuelven se trata como el estado nuevo, no como "no pasó nada".
   *
   * Lo único que sí es un "no pasó nada" es que la llamada no llegue (se tira, y
   * cae en el `catch`): ahí la propuesta sigue abierta y se puede reintentar.
   */
  async function resolver(que: "aprobar" | "rechazar") {
    setEnviando(true);
    setAviso(null);
    try {
      const r = que === "aprobar" ? await aplicarPropuesta(id) : await rechazarPropuesta(id, motivoRechazo);
      if (r.estado) setFila((f) => ({ ...f, estado: r.estado as string, error: r.error ?? null }));
      if (!r.error) setAviso({ tono: "ok", texto: que === "aprobar" ? "Aplicada." : "Rechazada." });
      // La fila entera (quién la resolvió, cuándo, el resultado) la sabe la base.
      // Si esta lectura falla no importa: el estado de arriba ya es el correcto.
      try {
        const fresca = await traerPropuesta(id);
        if (fresca) setFila(fresca);
      } catch {}
      setConfirmando(null);
      onResuelta?.();
    } catch (e) {
      setAviso({
        tono: "mal",
        texto: `No llegué a la base, así que la propuesta sigue como estaba: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setEnviando(false);
    }
  }

  /** Una línea por moneda, sin las que no llevan frase (`oculto`). */
  const lineas = (fraccionamiento?.resultado ?? [])
    .map((r) => ({ r, texto: frase(r) }))
    .filter((x): x is { r: LineaResultado; texto: string } => x.texto !== null);

  const vencida = ABIERTOS.has(fila.estado) && new Date(fila.expira_en).getTime() <= ahora;
  const e = ESTADO[fila.estado] ?? { texto: fila.estado, clase: "text-subtle" };
  const monto = fila.monto_ars == null ? null : Number(fila.monto_ars);
  const motivo = fila.motivo_confirmacion;

  return (
    <div className="rounded-2xl border border-accent/30 bg-accent/5 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="label-micro text-accent">Propuesta #{id}</p>
        {fila.tipo === "compuesta" && <span className="chip px-2 py-0.5 text-[0.65rem] text-subtle">varias partes</span>}
        <span className={`chip ml-auto px-2 py-0.5 text-[0.65rem] ${vencida ? "text-faint" : e.clase}`}>{vencida ? "Venció sin respuesta" : e.texto}</span>
      </div>

      <p className="mt-2 font-display text-fg">{fila.resumen}</p>

      {/* El resultado del pedido, grande y arriba: es lo que se mira para decidir.
          Sale de `control`, calculado por la tool — el panel no lo suma (§2.3.1).
          Cuando no hay ninguno se cae al `monto_ars` de la fila: es menos útil
          (es el tamaño de la operación, no lo que te cuesta) pero es un dato real,
          y las propuestas viejas, anteriores a `0aa6e55`, no tienen control. */}
      {lineas.length > 0 ? (
        lineas.map(({ r, texto }) => (
          <div key={r.moneda} className="mt-2">
            <p className={`font-display leading-none ${r.como === "corrige" ? "text-lg text-muted" : "text-[1.75rem] font-bold"} ${r.como === "deja" ? "text-emerald" : "text-fg"}`}>
              <span className={r.como === "corrige" ? "" : "tnum"}>{texto}</span>
            </p>
            <p className="mt-1 text-xs text-subtle">
              {r.como === "corrige"
                ? "El antes y el después están en la columna Hecho."
                : fraccionamiento?.compuesta
                  ? `la suma de la capa 1 de los ${fraccionamiento.filas.length} hechos`
                  : "lo que te tocó a vos"}
            </p>
          </div>
        ))
      ) : (
        <>
          {monto != null && Number.isFinite(monto) && <p className="tnum mt-1 text-sm text-fg">{ars(monto)}</p>}
          {monto == null && motivo === "sin_monto" && <p className="mt-1 text-sm text-muted">Monto a calcular al aplicar</p>}
        </>
      )}

      <p className="mt-3 text-xs text-muted">
        {motivo == null ? SIN_MOTIVO : TEXTO_MOTIVO[motivo] ?? `Pide confirmación (motivo «${motivo}»).`}
      </p>

      {fraccionamiento && <TablaFraccionamiento f={fraccionamiento} />}

      {fraccionamiento && fraccionamiento.neto.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-subtle">Cómo queda cada uno:</span>
          {fraccionamiento.neto.map((n, i) => {
            const teDebe = n.neto >= 0;
            return (
              <span
                key={`${n.nombre}-${n.moneda}-${i}`}
                className={`inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs ${teDebe ? "border-emerald/35" : "border-coral/35"}`}
              >
                <span className="grid h-5 w-5 place-items-center rounded-full bg-white/[0.08] font-display text-[0.6rem] font-bold text-muted">
                  {n.nombre.slice(0, 2).toUpperCase()}
                </span>
                {n.nombre}{" "}
                <span className={teDebe ? "text-emerald" : "text-coral"}>
                  {teDebe ? "te debe " : "le debés "}
                  <span className="tnum">{plata(Math.abs(n.neto), n.moneda)}</span>
                </span>
              </span>
            );
          })}
        </div>
      )}

      {fraccionamiento?.resultado.some((r) => r.creditoAbierto) && (
        <p className="mt-2 text-xs text-amber">Con tarjeta: en Plata el patrimonio no se mueve igual hasta que pagues el resumen.</p>
      )}

      {ABIERTOS.has(fila.estado) && !vencida && <p className="mt-2 text-[0.7rem] text-faint">Vence a las {hora(fila.expira_en)}.</p>}
      {fila.resuelta_por && (
        <p className="mt-1 text-[0.7rem] text-faint">
          {fila.resuelta_por === "usuario" ? "La resolviste vos" : "La resolvió el agente"}
          {fila.resuelta_en ? ` a las ${hora(fila.resuelta_en)}` : ""}.
        </p>
      )}
      {fila.error && <p className="mt-2 whitespace-pre-wrap text-xs text-coral">{fila.error}</p>}

      {noEsta && (
        <p className="mt-2 text-[0.7rem] text-faint">No la encontré en la base. Si estás usando el agente falso, es lo esperable: sus propuestas no existen.</p>
      )}
      {errorLectura && <p className="mt-2 text-[0.7rem] text-coral">No pude leer la propuesta: {errorLectura}</p>}

      {aviso && (
        <p className={`mt-2 text-xs ${aviso.tono === "ok" ? "text-emerald" : "text-coral"}`}>{aviso.texto}</p>
      )}

      {ABIERTOS.has(fila.estado) && !vencida && !noEsta && (
        <div className="mt-3 border-t border-accent/15 pt-3">
          {confirmando === null && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { setConfirmando("aprobar"); setAviso(null); }}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-bg"
              >
                Aprobar
              </button>
              <button
                onClick={() => { setConfirmando("rechazar"); setAviso(null); }}
                className="rounded-xl border border-line bg-white/[0.06] px-4 py-2 text-sm text-fg hover:border-coral/40 hover:text-coral"
              >
                Rechazar
              </button>
            </div>
          )}

          {confirmando === "aprobar" && (
            <div>
              {/* Dice qué se escribe, no "¿estás seguro?": lo que hay que revisar es
                  la tabla de arriba, y el aviso sirve para volver a mirarla. */}
              <p className="text-xs text-amber">
                Se escribe en tus datos reales de Plata y <b>no se deshace</b>. Mirá la tabla de acá arriba antes de decir que sí.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => resolver("aprobar")} disabled={enviando} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-40">
                  {enviando ? "Aplicando…" : "Sí, aplicar"}
                </button>
                <button onClick={() => setConfirmando(null)} disabled={enviando} className="rounded-xl border border-line bg-white/[0.06] px-4 py-2 text-sm text-fg disabled:opacity-40">
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {confirmando === "rechazar" && (
            <div>
              <label className="label-micro" htmlFor={`motivo-${id}`}>Motivo (opcional)</label>
              <input
                id={`motivo-${id}`}
                value={motivoRechazo}
                onChange={(ev) => setMotivoRechazo(ev.target.value)}
                onKeyDown={(ev) => { if (ev.key === "Enter" && !enviando) resolver("rechazar"); }}
                placeholder="Por qué no"
                maxLength={500}
                className="mt-1 w-full rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => resolver("rechazar")} disabled={enviando} className="rounded-xl border border-coral/40 bg-coral/10 px-4 py-2 text-sm text-coral disabled:opacity-40">
                  {enviando ? "Rechazando…" : "Rechazar"}
                </button>
                <button onClick={() => setConfirmando(null)} disabled={enviando} className="rounded-xl border border-line bg-white/[0.06] px-4 py-2 text-sm text-fg disabled:opacity-40">
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
