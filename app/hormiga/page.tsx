"use client";

import { useEffect, useMemo, useState } from "react";
import { db, fetchExpenseDetail, setTxNature, type ExpenseRow } from "@/lib/db";
import { readCache, writeCache } from "@/lib/cache";
import { fxSync, loadFx, arsDe } from "@/lib/fx";
import { analizarHormiga, CATEGORIAS_HORMIGA, type Suscripcion } from "@/lib/hormiga";
import { ars, compact } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import CountUp from "../components/CountUp";
import { ArrowUpRight, ArrowDownRight, Repeat, Chevron } from "../icons";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const mesLabel = (ym: string) => { const [y, m] = ym.split("-").map(Number); return `${MESES[(m || 1) - 1]} '${String(y).slice(2)}`; };
const mesActual = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

export default function HormigaPage() {
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [marcando, setMarcando] = useState(false);
  const [verExcluidos, setVerExcluidos] = useState(false);

  const reload = async () => {
    const r = await fetchExpenseDetail(db(), 12);
    setRows(r);
    writeCache("hormiga", { r });
  };

  useEffect(() => {
    const s = readCache<{ r: ExpenseRow[] }>("hormiga");
    if (s) { setRows(s.r); setLoading(false); }
    loadFx().then(() => setRows((p) => [...p]));
    reload().finally(() => setLoading(false));
  }, []);

  const fx = fxSync();
  const a = useMemo(() => analizarHormiga(rows, fx), [rows, fx.usd, fx.usdt]);

  const cur = mesActual();
  const meses = useMemo(() => [...new Set(rows.map((r) => r.month))].sort().slice(-6), [rows]);
  const totalMes = a.totalPorMes[cur] ?? 0;
  const mesPrev = meses[meses.length - 2];
  const totalPrev = mesPrev ? (a.totalPorMes[mesPrev] ?? 0) : 0;
  const delMes = a.hormiga.filter((r) => r.month === cur);
  const ticket = delMes.length ? totalMes / delMes.length : 0;
  // Qué parte del total es goteo chico y qué parte son pocos consumos gordos.
  const enArs = (r: ExpenseRow) => arsDe(r.amount, r.currency, r.fxRate, fx);
  const totGoteo = a.goteo.filter((r) => r.month === cur).reduce((s, r) => s + enArs(r), 0);
  const pctGoteo = totalMes ? Math.round((totGoteo / totalMes) * 100) : 0;
  const grandesMes = a.grandes.filter((r) => r.month === cur);
  // Proyección anual: promedio de los meses COMPLETOS (el actual va por la mitad).
  const completos = meses.filter((m) => m !== cur);
  const promMensual = completos.length ? completos.reduce((s, m) => s + (a.totalPorMes[m] ?? 0), 0) / completos.length : totalMes;

  const marcarFijo = async (s: Suscripcion) => {
    setMarcando(true);
    try { await setTxNature(db(), s.ids, s.yaFija ? "variable" : "fijo"); await reload(); }
    finally { setMarcando(false); }
  };

  if (loading) return (<><PageHeader title="Gastos hormiga" subtitle="Cargando…" /><div className="panel mt-6 p-10 text-center text-sm text-muted">Analizando tus gastos…</div></>);

  return (
    <>
      <PageHeader title="Gastos hormiga" subtitle="El goteo chico y repetido" />

      {/* 1 · HERO */}
      <section className="rise panel relative mt-6 overflow-hidden p-6">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-coral/10 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted">Este mes en gasto evitable</p>
            <CountUp value={totalMes} format={ars} className="tnum mt-1.5 block text-[38px] font-extrabold leading-none text-fg sm:text-[42px]" />
            {mesPrev && (
              <p className={`mt-1 flex items-center gap-1 text-sm ${totalMes > totalPrev ? "text-coral" : "text-emerald"}`}>
                {totalMes > totalPrev ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                <span className="tnum">{totalPrev ? `${Math.abs(Math.round(((totalMes - totalPrev) / totalPrev) * 100))}%` : "—"}</span>
                <span className="text-faint">vs {mesLabel(mesPrev)}</span>
              </p>
            )}
          </div>
          <div className="rounded-2xl border border-coral/25 bg-coral/8 px-4 py-3 text-right">
            <p className="text-[0.65rem] uppercase tracking-widest text-faint">A este ritmo, en un año</p>
            <p className="tnum mt-0.5 text-[22px] font-bold text-coral">{compact(promMensual * 12)}</p>
          </div>
        </div>
        <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Mini label="Gastos evitables" value={String(delMes.length)} sub="este mes" />
          <Mini label="Ticket promedio" value={ars(ticket)} sub="por gasto" />
          <Mini label="Goteo vs bultos" value={`${pctGoteo}%`} sub={`del total son tickets < ${compact(a.umbral)}`} />
        </div>
      </section>

      {/* 2 · TERMÓMETRO */}
      <section className="panel mt-5 p-6">
        <h2 className="font-display text-lg text-fg">Mes a mes</h2>
        <p className="text-xs text-faint">Últimos {meses.length} meses · todo el gasto evitable</p>
        <Barras meses={meses} valores={a.totalPorMes} actual={cur} />
      </section>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        {/* 4 · RANKING DE COMERCIOS */}
        <section className="panel p-6">
          <h2 className="font-display text-lg text-fg">Dónde se va</h2>
          <p className="text-xs text-faint">Comercios que más te cuestan · {meses.length} meses</p>
          <ul className="mt-4 space-y-2.5">
            {a.comercios.slice(0, 10).map((c) => {
              const max = a.comercios[0]?.totalArs || 1;
              return (
                <li key={c.comercio}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-base">{c.emoji}</span>
                    <span className="min-w-0 truncate text-fg">{c.comercio}</span>
                    <span className="shrink-0 rounded-full border border-line bg-white/[0.06] px-1.5 text-[0.62rem] text-muted">{c.veces}×</span>
                    <span className="tnum ml-auto shrink-0 text-fg">{compact(c.totalArs)}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.09]">
                    <div className="h-full rounded-full bg-gradient-to-r from-coral/60 to-coral" style={{ width: `${(c.totalArs / max) * 100}%` }} />
                  </div>
                </li>
              );
            })}
            {a.comercios.length === 0 && <li className="py-6 text-center text-sm text-muted">Sin gastos hormiga en el período.</li>}
          </ul>
        </section>

        {/* 3 · VARIACIÓN POR CATEGORÍA */}
        <section className="panel p-6">
          <h2 className="font-display text-lg text-fg">Variación por categoría</h2>
          <p className="text-xs text-faint">{mesPrev ? `${mesLabel(mesPrev)} vs ${mesLabel(cur)}` : "mes actual"}</p>
          <ul className="mt-4 divide-y divide-line">
            {CATEGORIAS_HORMIGA.map((cat) => {
              const hoy = a.porCategoriaMes[cat]?.[cur] ?? 0;
              const antes = mesPrev ? (a.porCategoriaMes[cat]?.[mesPrev] ?? 0) : 0;
              if (!hoy && !antes) return null;
              const dif = hoy - antes;
              const pct = antes ? Math.round((dif / antes) * 100) : null;
              return (
                <li key={cat} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="text-muted">{cat}</span>
                  <span className="tnum ml-auto text-faint">{compact(antes)}</span>
                  <span className="text-faint">→</span>
                  <span className="tnum w-16 text-right text-fg">{compact(hoy)}</span>
                  <span className={`tnum w-14 shrink-0 text-right text-xs ${dif > 0 ? "text-coral" : dif < 0 ? "text-emerald" : "text-faint"}`}>
                    {pct === null ? "nuevo" : `${pct > 0 ? "+" : ""}${pct}%`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* 5 · SUSCRIPCIONES */}
      <section className="panel mt-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-display text-lg text-fg"><Repeat className="h-5 w-5 text-accent" /> Suscripciones detectadas</h2>
            <p className="text-xs text-faint">Cargos que se repiten con el mismo monto. No cuentan como hormiga: se analizan aparte.</p>
          </div>
          {a.suscripciones.length > 0 && (
            <div className="rounded-2xl border border-accent/25 bg-accent/8 px-4 py-2 text-right">
              <p className="text-[0.65rem] uppercase tracking-widest text-faint">Total al año</p>
              <p className="tnum font-display text-xl text-accent">{compact(a.suscripciones.reduce((s, x) => s + x.anual, 0))}</p>
            </div>
          )}
        </div>
        <ul className="mt-4 divide-y divide-line">
          {a.suscripciones.map((s) => (
            <li key={`${s.comercio}-${s.monto}`} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-fg">{s.comercio}</p>
                <p className="text-xs text-faint">{s.meses.length} meses · {s.meses.map(mesLabel).join(", ")}</p>
              </div>
              <div className="text-right">
                <p className="tnum text-sm text-fg">{s.currency === "ARS" ? ars(s.monto) : `US$ ${s.monto}`}<span className="text-xs text-faint">/mes</span></p>
                <p className="tnum text-[0.7rem] text-faint">{compact(s.anual)} al año</p>
              </div>
              <button
                onClick={() => marcarFijo(s)}
                disabled={marcando}
                title="Marcarlo como gasto fijo hace que el Cash Flow no lo promedie ni lo infle"
                className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${
                  s.yaFija ? "border-emerald/40 bg-emerald/10 text-emerald" : "border-line bg-white/[0.06] text-muted hover:text-fg"
                }`}
              >
                {s.yaFija ? "✓ Fijo" : "Marcar fijo"}
              </button>
            </li>
          ))}
          {a.suscripciones.length === 0 && <li className="py-6 text-center text-sm text-muted">No detecté suscripciones todavía. Hacen falta 3 meses del mismo cargo.</li>}
        </ul>
      </section>

      {/* 6 · LOS QUE MÁS PESAN */}
      <section className="panel mt-5 p-6">
        <button onClick={() => setVerExcluidos((v) => !v)} className="flex w-full items-center gap-2 text-left">
          <div>
            <h2 className="font-display text-lg text-fg">Los que más pesan</h2>
            <p className="text-xs text-faint">
              {grandesMes.length} consumos de más de {ars(a.umbral)} este mes · las salidas y deliverys grandes son los que más mueven la aguja
            </p>
          </div>
          <Chevron className={`ml-auto h-4 w-4 shrink-0 text-faint transition-transform ${verExcluidos ? "rotate-180 text-accent" : ""}`} />
        </button>
        {verExcluidos && (
          <ul className="mt-4 max-h-80 divide-y divide-line overflow-y-auto pr-1">
            {a.grandes.slice(0, 40).map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                <span>{r.emoji}</span>
                <span className="min-w-0 truncate text-fg">{r.desc}</span>
                <span className="shrink-0 text-xs text-faint">{r.category} · {mesLabel(r.month)}</span>
                <span className="tnum ml-auto shrink-0 text-fg">{ars(r.amount)}</span>
              </li>
            ))}
            {a.grandes.length === 0 && <li className="py-6 text-center text-sm text-muted">Ningún consumo superó el umbral.</li>}
          </ul>
        )}
      </section>

      <p className="mt-6 text-xs text-faint">
        Cuenta todo el gasto <b className="text-muted">evitable</b>: {CATEGORIAS_HORMIGA.join(", ")} — sin importar el monto, porque una cena de $30.000 es más recortable que un café de $4.000.
        El umbral de <b className="text-muted">{ars(a.umbral)}</b> (percentil 70 de tus tickets, se recalcula solo) no excluye nada: solo separa el goteo de los consumos grandes.
        Quedan afuera las <b className="text-muted">cuotas</b> de tarjeta (no son decisión de este mes) y las <b className="text-muted">suscripciones</b> (se analizan aparte), por eso el total no coincide con “Gastos por categoría” de Métricas.
      </p>
    </>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white/[0.05] p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="tnum mt-1 text-lg text-fg">{value}</p>
      <p className="mt-0.5 text-[0.7rem] text-faint">{sub}</p>
    </div>
  );
}

function Barras({ meses, valores, actual }: { meses: string[]; valores: Record<string, number>; actual: string }) {
  const max = Math.max(...meses.map((m) => valores[m] ?? 0), 1);
  return (
    <div className="mt-5 flex items-end justify-between gap-3">
      {meses.map((m) => {
        const v = valores[m] ?? 0;
        const esActual = m === actual;
        return (
          <div key={m} className="flex flex-1 flex-col items-center gap-2">
            <span className="tnum text-[0.62rem] text-faint">{v > 0 ? compact(v) : ""}</span>
            <div className="flex h-32 w-full items-end justify-center">
              <span className="grow-bar w-2/3 max-w-10 rounded-t-md" style={{ height: `${Math.max((v / max) * 100, v > 0 ? 2 : 0)}%`, background: esActual ? "linear-gradient(to top, #ff6b6b55, #ff6b6b)" : "linear-gradient(to top, #ff6b6b22, #ff6b6b77)" }} />
            </div>
            <span className={`text-[0.68rem] ${esActual ? "text-fg" : "text-faint"}`}>{mesLabel(m)}{esActual ? " *" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
