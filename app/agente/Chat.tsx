"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../components/Shell";
import TarjetaPropuesta from "./TarjetaPropuesta";
import { leerEventos, type EventoLeido } from "./sse";

/**
 * El agente de Plata, adentro de Plata.
 *
 * Es la misma pantalla que la prueba de vida del panel de agentes
 * (`agentes/central/app/chat/[agente]/Chat.tsx`), traída acá por una razón
 * concreta: **las propuestas se aprueban con la sesión de Lucas**.
 * `aplicar_propuesta` no es SECURITY DEFINER y está otorgada a `authenticated`,
 * así que corre con la RLS del que la llama. Adentro de Plata esa sesión ya está,
 * y aprobar una propuesta escribe en la misma app que la muestra.
 *
 * Le habla a un servidor LOCAL (`npm run servir`, **en la carpeta del repo
 * `agentes`**, no en esta), no a uno hosteado. Por eso dos cosas que en otra
 * pantalla no pasarían:
 *
 *   · Solo funciona abierta en esta máquina, en `http://localhost:3100`. Desde el
 *     celular, `127.0.0.1` es el propio celular. Y desde otra dirección el origen
 *     es otro y CORS la rechaza. La página lo dice en vez de fallar muda.
 *   · Un servidor apagado y un rechazo de CORS le llegan al navegador como el
 *     mismo error, sin detalle. No se pueden distinguir, así que el mensaje
 *     nombra las dos causas.
 */

const API = process.env.NEXT_PUBLIC_AGENTES_API ?? "http://127.0.0.1:8787";
// El 3100 y no el 3000: el panel de agentes ya ocupa el 3000, y el servidor
// acepta los dos (`ORIGENES_PANEL` en `plata/servidor.ts`).
const ORIGEN_ESPERADO = "http://localhost:3100";
const AGENTE = "plata";

const numero = (n: number) => n.toLocaleString("es-AR");
// Copias de `central/app/components/ui.tsx`. Acá no se usa el `usd` de
// `@/lib/format` porque ese no fija decimales: deja los que le salgan a
// `toLocaleString`, o sea hasta tres. El costo de una llamada son fracciones de
// centavo, así que dos llamadas seguidas se leerían con distinta cantidad de
// dígitos, y una de US$ 0,0004 saldría como "US$ 0". Estos cuatro decimales son
// fijos, y la columna queda alineada.
const usd = (n: number, decimales: 2 | 4 = 2) =>
  "US$ " + n.toLocaleString("es-AR", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });

type Turno = { pregunta: string; eventos: EventoLeido[]; enCurso: boolean; cortado: string | null };
type Salud = { estado: "comprobando" } | { estado: "listo"; modelo: string } | { estado: "caido" };

/**
 * `crypto.randomUUID` solo existe en contexto seguro; `getRandomValues` en cualquiera.
 * Se chequea con `typeof` porque los tipos del DOM la declaran siempre presente, y
 * TypeScript rechaza el chequeo directo por "siempre verdadero": justo lo que en un
 * contexto no seguro no es.
 */
function idDeSesion(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return crypto.randomUUID();
  const h = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const EJEMPLOS = ["¿Cuánto tengo hoy en pesos y en dólares?", "¿Cuánto gasté este mes por categoría?", "¿Cuáles son mis suscripciones?"];

export default function Chat() {
  const [salud, setSalud] = useState<Salud>({ estado: "comprobando" });
  const [sesion, setSesion] = useState(idDeSesion);
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [texto, setTexto] = useState("");
  const abortar = useRef<AbortController | null>(null);
  const fondo = useRef<HTMLDivElement>(null);

  const comprobar = useCallback(async () => {
    setSalud({ estado: "comprobando" });
    try {
      const r = await fetch(`${API}/salud`, { signal: AbortSignal.timeout(3000) });
      const s = await r.json();
      setSalud(s?.ok ? { estado: "listo", modelo: String(s.modelo ?? "?") } : { estado: "caido" });
    } catch {
      setSalud({ estado: "caido" });
    }
  }, []);

  useEffect(() => { comprobar(); }, [comprobar]);
  useEffect(() => () => abortar.current?.abort(), []);
  useEffect(() => { fondo.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turnos]);

  const enCurso = turnos.some((t) => t.enCurso);

  /** Modifica solo el último turno, que es el único que puede estar en curso. */
  const alUltimo = (f: (t: Turno) => Turno) => setTurnos((ts) => ts.map((t, i) => (i === ts.length - 1 ? f(t) : t)));

  async function enviar(pregunta: string) {
    pregunta = pregunta.trim();
    if (!pregunta || enCurso || salud.estado !== "listo") return;
    setTexto("");
    setTurnos((ts) => [...ts, { pregunta, eventos: [], enCurso: true, cortado: null }]);
    const control = new AbortController();
    abortar.current = control;
    let terminoBien = false;

    try {
      const r = await fetch(`${API}/agentes/${AGENTE}/mensaje`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: pregunta, sesion_id: sesion }),
        signal: control.signal,
      });
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("text/event-stream") || !r.body) {
        // El servidor responde sus errores como `{ error }` en castellano: 409 si la
        // sesión sigue contestando, 503 si hay 4 ocupadas, 400/413 por tamaño. Se
        // muestra ese texto tal cual, no el JSON crudo.
        const crudo = await r.text().catch(() => "");
        let mensaje = crudo.slice(0, 300);
        try {
          const j = JSON.parse(crudo);
          if (typeof j?.error === "string") mensaje = j.error;
        } catch {}
        throw new Error(mensaje || `El servidor respondió ${r.status}.`);
      }
      await leerEventos(r.body, (e) => {
        if (e.tipo === "fin" || e.tipo === "error") terminoBien = true;
        alUltimo((t) => ({ ...t, eventos: [...t.eventos, e] }));
      });
      // Un turno puede cerrarse sin `fin` si se cae la sesión del SDK.
      alUltimo((t) => ({ ...t, enCurso: false, cortado: terminoBien ? null : "La respuesta se cortó antes de terminar." }));
    } catch (e) {
      if (control.signal.aborted) return;
      const red = e instanceof TypeError;
      alUltimo((t) => ({ ...t, enCurso: false, cortado: red ? "Se perdió la conexión con el agente." : (e as Error).message }));
      if (red) comprobar();
    }
  }

  // El acumulado es la suma de lo que el servidor ya devolvió, turno por turno. Un
  // uso con `precio_conocido: false` trae `usd: 0` porque el modelo no tiene precio
  // en la tabla, no porque haya sido gratis: el total lo aclara en vez de sumarlo
  // como un cero.
  const usos = turnos.flatMap((t) => t.eventos.flatMap((e) => (e.tipo === "fin" ? e.usos : [])));
  const costoSesion = usos.reduce((s, u) => s + u.usd, 0);
  const sinPrecio = usos.some((u) => u.precio_conocido === false);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <PageHeader title="Agente" subtitle="Contale y te propone qué registrar">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* En el panel este chip es violeta. Acá no: `--color-violet` está marcado
              como legacy en el `globals.css` de Plata («se va migrando») y no lo usa
              ninguna otra pantalla. Sumar un uso nuevo empujaría para el otro lado. */}
          {salud.estado === "listo" && <span className="chip px-2.5 py-1 text-subtle">{salud.modelo}</span>}
          <span className="chip px-2.5 py-1 text-subtle" title={sesion}>sesión {sesion.slice(0, 8)}</span>
          {usos.length > 0 && (
            <span className="chip tnum px-2.5 py-1 text-fg">{usd(costoSesion, 4)}{sinPrecio && <span className="text-amber"> + sin precio</span>}</span>
          )}
          <button
            onClick={() => { setSesion(idDeSesion()); setTurnos([]); }}
            disabled={enCurso || turnos.length === 0}
            className="chip px-2.5 py-1 text-accent disabled:opacity-40"
          >
            Nueva sesión
          </button>
        </div>
      </PageHeader>

      {salud.estado === "caido" && <Caido onReintentar={comprobar} />}

      {turnos.length === 0 && salud.estado === "listo" && (
        <div className="panel ai-glow p-5 text-sm text-muted">
          <p>Preguntale lo que quieras sobre tus finanzas. Vas a ver qué herramientas usa antes de responder.</p>
          {/* Este aviso no nombra qué se puede aprobar y qué no: eso depende de qué
              migraciones estén aplicadas y ya cambió dos veces en dos días. */}
          <p className="mt-2 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
            Ojo: <b>puede registrar</b>. Un movimiento chico lo carga directo en tus datos reales; lo que supera el umbral o
            pide confirmación queda como propuesta, con su tabla, para que la apruebes vos. No le pidas cargar nada de prueba.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {EJEMPLOS.map((q) => <button key={q} onClick={() => setTexto(q)} className="chip px-3 py-1 text-xs text-muted">{q}</button>)}
          </div>
        </div>
      )}

      {turnos.map((t, i) => <VistaTurno key={i} t={t} />)}
      <div ref={fondo} />

      <form
        onSubmit={(e) => { e.preventDefault(); enviar(texto); }}
        className="panel sticky bottom-[calc(var(--nav-safe)+0.5rem)] flex items-end gap-2 p-2 lg:bottom-4"
      >
        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(texto); }
          }}
          rows={Math.min(6, texto.split("\n").length)}
          // El servidor rechaza con 400 un texto de más de 8.000 caracteres, y los
          // cuenta con `.length`, en unidades UTF-16: las mismas que cuenta maxLength.
          maxLength={8000}
          placeholder={salud.estado === "listo" ? "Escribile al agente…" : "Esperando al agente…"}
          disabled={salud.estado !== "listo"}
          className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-fg outline-none placeholder:text-faint"
        />
        <button type="submit" disabled={!texto.trim() || enCurso || salud.estado !== "listo"} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-40">
          {enCurso ? "…" : "Enviar"}
        </button>
      </form>
    </div>
  );
}

function VistaTurno({ t }: { t: Turno }) {
  // Los avisos van arriba de la respuesta; el resto, en el orden en que llegó.
  const avisos = t.eventos.filter((e) => e.tipo === "aviso");
  const resto = t.eventos.filter((e) => e.tipo !== "aviso");
  return (
    <div className="flex flex-col gap-2">
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-accent/20 px-3.5 py-2 text-sm text-fg">{t.pregunta}</div>
      {avisos.map((e, i) => e.tipo === "aviso" && <p key={`a${i}`} className="rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">{e.texto}</p>)}
      {resto.map((e, i) => <VistaEvento key={i} e={e} />)}
      {t.enCurso && <p className="pulse-dot text-sm text-muted">Pensando…</p>}
      {t.cortado && <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">{t.cortado}</p>}
    </div>
  );
}

function VistaEvento({ e }: { e: EventoLeido }) {
  switch (e.tipo) {
    case "propuesta":
      // Llega antes de que el modelo hable de ella, así que la card queda arriba de
      // la explicación del agente, que es el orden natural.
      return (
        <div className="max-w-[92%]">
          <TarjetaPropuesta inicial={{ ...e.propuesta, id: Number(e.propuesta.id) }} vivo />
        </div>
      );
    case "texto":
      return <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl bg-white/[0.06] px-3.5 py-2 text-sm text-fg/90">{e.texto}</div>;
    case "tool": {
      const json = JSON.stringify(e.entrada ?? {});
      return (
        <details className="text-xs text-faint">
          <summary className="cursor-pointer select-none font-mono">· {e.nombre} <span className="text-faint/70">{json.length > 60 ? json.slice(0, 57) + "…" : json}</span></summary>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-white/[0.04] p-2 font-mono text-[0.7rem]">{JSON.stringify(e.entrada ?? {}, null, 2)}</pre>
        </details>
      );
    }
    case "error":
      return <p className="whitespace-pre-wrap rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">{e.texto}</p>;
    case "fin":
      return (
        <p className="text-[0.7rem] text-faint">
          {e.usos.length === 0 && "sin llamadas al modelo"}
          {e.usos.map((u, i) => {
            const tokens = u.uso.tokensEntrada + u.uso.tokensSalida + (u.uso.tokensCacheRead ?? 0) + (u.uso.tokensCacheWrite ?? 0);
            return (
              <span key={i} title={`entrada ${u.uso.tokensEntrada} · salida ${u.uso.tokensSalida} · caché leída ${u.uso.tokensCacheRead ?? 0} · escrita ${u.uso.tokensCacheWrite ?? 0}`}>
                {i > 0 && " · "}{u.modelo.replace("claude-", "")} · {numero(tokens)} tokens · <span className="tnum">{u.precio_conocido === false ? "sin precio" : usd(u.usd, 4)}</span>
              </span>
            );
          })}
          {" · "}{(e.duracionMs / 1000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} s
        </p>
      );
    case "desconocido":
      return <p className="text-xs text-faint">El agente mandó un evento «{e.nombre}» que esta página todavía no sabe mostrar.</p>;
    case "ilegible":
      return <p className="text-xs text-coral" title={e.crudo}>Llegó un evento que no se pudo leer.</p>;
    default:
      return null;
  }
}

function Caido({ onReintentar }: { onReintentar: () => void }) {
  const origen = typeof window === "undefined" ? ORIGEN_ESPERADO : window.location.origin;
  return (
    <div className="panel p-5">
      <p className="text-sm text-fg">No pude hablar con el agente en <code className="font-mono text-xs">{API}</code></p>
      <p className="mt-2 text-sm text-muted">
        Casi seguro no está corriendo. Levantalo en una terminal, <b>desde la carpeta del repo <code className="font-mono text-xs">agentes</code></b> — no desde esta app:
      </p>
      <pre className="mt-2 rounded-lg bg-white/[0.04] p-2 font-mono text-xs text-fg">npm run servir</pre>
      <p className="mt-2 text-xs text-faint">
        Si al correrlo dice que no hay sesión guardada, antes hace falta <code className="font-mono">npm run login</code>, una
        sola vez. Y la <code className="font-mono">ANTHROPIC_API_KEY</code> en el <code className="font-mono">.env</code> de la raíz.
      </p>
      {origen !== ORIGEN_ESPERADO && (
        <p className="mt-3 rounded-lg border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
          Además, esta página está abierta en <b>{origen}</b>. El agente solo acepta <b>{ORIGEN_ESPERADO}</b> (y el 3000 del
          panel), en esta misma computadora: desde otra dirección o desde el celular no va a funcionar aunque esté corriendo.
          Levantá Plata con <code className="font-mono">npm run dev:agente</code>.
        </p>
      )}
      <button onClick={onReintentar} className="mt-3 rounded-lg border border-line bg-white/[0.06] px-3 py-1.5 text-xs text-fg hover:border-accent/40">Reintentar</button>
    </div>
  );
}
