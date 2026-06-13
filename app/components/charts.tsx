"use client";

// Gráficos SVG hechos a mano (sin librerías) — estética fintech oscuro.
import { useState } from "react";

export const PALETTE = ["#c8ff4d", "#34e1a0", "#5ec8ff", "#a78bfa", "#ff9f5e", "#ff6b6b", "#f5d76e", "#7dd3fc", "#c084fc", "#4ade80"];

export type Slice = { label: string; value: number; emoji?: string };

// ---------- Donut ----------
export function Donut({ data, fmt, size = 220, thickness = 28 }: { data: Slice[]; fmt: (n: number) => string; size?: number; thickness?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  const cx = size / 2;

  if (total <= 0) return <div className="grid h-44 place-items-center text-sm text-faint">Sin datos en el período</div>;

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-center sm:gap-8">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth={thickness} />
        {data.map((d, i) => {
          const dash = (d.value / total) * c;
          const seg = (
            <circle
              key={i}
              cx={cx} cy={cx} r={r} fill="none"
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-acc}
              strokeLinecap="butt"
            />
          );
          acc += dash;
          return seg;
        })}
        {/* total en el centro (estático) */}
        <text x={cx} y={cx} transform={`rotate(90 ${cx} ${cx})`} textAnchor="middle" dominantBaseline="central" className="tnum" fill="var(--color-fg)" fontSize={size * 0.13} fontWeight={600}>{fmt(total)}</text>
      </svg>
      <ul className="w-full sm:w-auto sm:min-w-[15rem]">
        {data.map((d, i) => (
          <li key={i} className="grid grid-cols-[11px_1fr_auto] items-center gap-2.5 px-1 py-1 text-sm">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="truncate text-muted">{d.emoji ? `${d.emoji} ` : ""}{d.label}</span>
            <span className="tnum text-fg">{((d.value / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Barras horizontales ----------
export function BarList({ data, fmt }: { data: Slice[]; fmt: (n: number) => string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  if (!data.length) return <div className="grid h-32 place-items-center text-sm text-faint">Sin datos</div>;
  return (
    <ul className="flex flex-col gap-2.5">
      {data.map((d, i) => (
        <li key={i} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
          <span className="truncate text-sm text-muted">{d.emoji ? `${d.emoji} ` : ""}{d.label}</span>
          <span className="tnum text-sm text-fg">{fmt(d.value)}</span>
          <div className="col-span-2 h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------- Columnas agrupadas: ingresos vs egresos por mes ----------
export type MonthCol = { label: string; ingreso: number; egreso: number };
export function GroupedColumns({ data, fmt, height = 200 }: { data: MonthCol[]; fmt: (n: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.flatMap((d) => [d.ingreso, d.egreso]), 1);
  if (!data.length) return <div className="grid h-40 place-items-center text-sm text-faint">Sin datos</div>;
  const sel = hover != null ? data[hover] : null;
  const barH = (v: number) => (v > 0 ? Math.max((v / max) * height, 2) : 0); // alto en px sobre un área fija
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#34e1a0" }} /> Ingresos</span>
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#ff6b6b" }} /> Egresos</span>
        {sel && <span className="tnum ml-auto text-fg">{sel.label}: <span className="text-emerald">{fmt(sel.ingreso)}</span> · <span className="text-coral">{fmt(sel.egreso)}</span> · neto <span className={sel.ingreso - sel.egreso >= 0 ? "text-emerald" : "text-coral"}>{fmt(sel.ingreso - sel.egreso)}</span></span>}
      </div>
      <div className="flex gap-2" style={{ height: height + 18 }}>
        {data.map((d, i) => (
          <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1.5" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ opacity: hover == null || hover === i ? 1 : 0.4, cursor: "default" }}>
            <div className="flex w-full items-end justify-center gap-1" style={{ height }}>
              <div className="grow-bar w-1/2 max-w-8 rounded-t-md" style={{ height: barH(d.ingreso), background: "#34e1a0" }} />
              <div className="grow-bar w-1/2 max-w-8 rounded-t-md" style={{ height: barH(d.egreso), background: "#ff6b6b" }} />
            </div>
            <span className="text-[0.65rem] text-faint">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Variación por categoría (tabla comparativa entre dos meses) ----------
export type VarRow = { label: string; emoji?: string; cur: number; prev: number; est: number; pct: number | null };
type SortKey = "cat" | "prev" | "cur" | "est" | "var";
export function VariationTable({ data, fmt, labelA, labelB, showEst }: { data: VarRow[]; fmt: (n: number) => string; labelA: string; labelB: string; showEst: boolean }) {
  const [sortKey, setSortKey] = useState<SortKey>("var");
  const [asc, setAsc] = useState(false);
  if (!data.length) return <div className="grid h-32 place-items-center text-sm text-faint">Sin datos para comparar en esos meses</div>;

  const sorted = [...data].sort((a, b) => {
    if (sortKey === "cat") return asc ? a.label.localeCompare(b.label) : b.label.localeCompare(a.label);
    const v = (r: VarRow) => (sortKey === "prev" ? r.prev : sortKey === "cur" ? r.cur : sortKey === "est" ? r.est : r.cur - r.prev);
    return asc ? v(a) - v(b) : v(b) - v(a);
  });
  const click = (k: SortKey) => { if (sortKey === k) setAsc(!asc); else { setSortKey(k); setAsc(k === "cat"); } };
  const arrow = (k: SortKey) => (sortKey === k ? (asc ? " ▲" : " ▼") : "");
  const Th = ({ k, right, children }: { k: SortKey; right?: boolean; children: React.ReactNode }) => (
    <th onClick={() => click(k)} className={`cursor-pointer select-none py-2 font-medium transition-colors hover:text-fg ${right ? "text-right" : "text-left"} ${sortKey === k ? "text-fg" : ""}`}>{children}{arrow(k)}</th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-faint">
            <Th k="cat">Categoría</Th>
            <Th k="prev" right>{labelA}</Th>
            <Th k="cur" right>{labelB}</Th>
            {showEst && <Th k="est" right>Estimado fin de mes</Th>}
            <Th k="var" right>Variación</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d, i) => {
            const delta = d.cur - d.prev;
            const up = delta > 0;
            const tone = d.pct === null ? "text-sky" : d.cur === 0 ? "text-faint" : up ? "text-coral" : "text-emerald";
            const tag = d.pct === null ? "nuevo" : d.cur === 0 ? "saldó" : up ? "▲" : "▼";
            const pctTxt = d.pct === null || d.cur === 0 ? "" : ` ${d.pct > 0 ? "+" : ""}${(d.pct * 100).toFixed(0)}%`;
            return (
              <tr key={i} className="border-b border-line/40">
                <td className="py-2.5 text-muted">{d.emoji ? `${d.emoji} ` : ""}{d.label}</td>
                <td className="tnum py-2.5 text-right text-fg/70">{d.prev > 0 ? fmt(d.prev) : "—"}</td>
                <td className="tnum py-2.5 text-right text-fg">{d.cur > 0 ? fmt(d.cur) : "—"}</td>
                {showEst && <td className="tnum py-2.5 text-right text-lime/90">{d.est > 0 ? fmt(d.est) : "—"}</td>}
                <td className={`tnum py-2.5 text-right ${tone}`}>{tag}{pctTxt}<span className="block text-[0.6rem] text-faint">{delta >= 0 ? "+" : "−"}{fmt(Math.abs(delta))}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
