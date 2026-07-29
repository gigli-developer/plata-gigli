"use client";

// Gráficos SVG hechos a mano (sin librerías) — estética fintech oscuro.
import { useState } from "react";

export const PALETTE = ["#ff9e1b", "#35e08a", "#5ec8ff", "#ffbf47", "#ff433d", "#a78bfa", "#f472b6", "#2dd4bf", "#7dd3fc", "#4ade80"];

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
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#35e08a" }} /> Ingresos</span>
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: "#ff433d" }} /> Egresos</span>
        {sel && <span className="tnum ml-auto text-fg">{sel.label}: <span className="text-emerald">{fmt(sel.ingreso)}</span> · <span className="text-coral">{fmt(sel.egreso)}</span> · neto <span className={sel.ingreso - sel.egreso >= 0 ? "text-emerald" : "text-coral"}>{fmt(sel.ingreso - sel.egreso)}</span></span>}
      </div>
      <div className="flex gap-2" style={{ height: height + 18 }}>
        {data.map((d, i) => (
          <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1.5" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} style={{ opacity: hover == null || hover === i ? 1 : 0.4, cursor: "default" }}>
            <div className="flex w-full items-end justify-center gap-1" style={{ height }}>
              <div className="grow-bar w-1/2 max-w-8 rounded-t-md" style={{ height: barH(d.ingreso), background: "#35e08a" }} />
              <div className="grow-bar w-1/2 max-w-8 rounded-t-md" style={{ height: barH(d.egreso), background: "#ff433d" }} />
            </div>
            <span className="text-[0.65rem] text-faint">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Patrimonio neto en el tiempo ----------
// Columnas apiladas: activos hacia arriba (pesos / dólares / cripto / te deben) y
// pasivos hacia abajo (cuotas + lo que debés), con la línea del NETO encima. El eje
// cero queda donde corresponda según cuánto pasivo haya.
export type NetWorthCol = {
  label: string; ars: number; usdArs: number; usdtArs: number;
  teDeben: number; pasivos: number; patrimonio: number;
};
const NW_COLORS = { ars: "#ff9e1b", usd: "#ffbf47", usdt: "#5ec8ff", deben: "#35e08a", pasivo: "#ff433d" };
export function NetWorthChart({ data, fmt, height = 220 }: { data: NetWorthCol[]; fmt: (n: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div className="grid h-48 place-items-center text-sm text-faint">Sin historia todavía</div>;

  const maxAct = Math.max(...data.map((d) => d.ars + d.usdArs + d.usdtArs + d.teDeben), 1);
  const maxPas = Math.max(...data.map((d) => d.pasivos), 0);
  const total = maxAct + maxPas;
  const hAct = (maxAct / total) * height;   // px por encima del cero
  const hPas = (maxPas / total) * height;   // px por debajo
  const px = (v: number) => (v > 0 ? Math.max((v / total) * height, v > 0 ? 1 : 0) : 0);
  const sel = hover != null ? data[hover] : data[data.length - 1];
  const selIdx = hover != null ? hover : data.length - 1;
  const prev = selIdx > 0 ? data[selIdx - 1] : null;

  // Puntos de la línea del neto, en el mismo sistema de coordenadas (0 = arriba del área de activos).
  const yNeto = (v: number) => hAct - (v / total) * height;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: NW_COLORS.ars }} /> Pesos</span>
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: NW_COLORS.usd }} /> Dólares</span>
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: NW_COLORS.usdt }} /> Cripto</span>
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: NW_COLORS.deben }} /> Te deben</span>
        <span className="flex items-center gap-1.5 text-muted"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: NW_COLORS.pasivo }} /> Pasivos</span>
      </div>

      {/* Sin gap entre columnas: así el centro de la columna i cae exacto en
          (i+0.5)/n del ancho y la línea del neto queda alineada con las barras.
          La separación visual la da el ancho de la barra (w-1/2). */}
      <div className="relative flex" style={{ height: height + 20 }}>
        {/* línea del neto, por encima de las columnas. El viewBox va 0..100 en X
            (porcentaje) y se estira; el trazo se compensa con vector-effect y los
            puntos son divs, que estirados se verían como elipses. */}
        <svg className="pointer-events-none absolute inset-x-0 top-0" width="100%" height={height} preserveAspectRatio="none" viewBox={`0 0 100 ${height}`}>
          <polyline
            fill="none" stroke="var(--color-fg)" strokeWidth={1.5} strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            points={data.map((d, i) => `${((i + 0.5) / data.length) * 100},${yNeto(d.patrimonio)}`).join(" ")}
          />
        </svg>
        {data.map((d, i) => (
          <span
            key={`dot${i}`}
            className="pointer-events-none absolute z-10 rounded-full border-[1.5px] border-fg bg-bg"
            style={{
              left: `${((i + 0.5) / data.length) * 100}%`,
              top: yNeto(d.patrimonio),
              width: i === selIdx ? 9 : 6, height: i === selIdx ? 9 : 6,
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}

        {data.map((d, i) => (
          <div
            key={i} className="flex flex-1 flex-col items-center"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            style={{ opacity: hover == null || hover === i ? 1 : 0.45, cursor: "default" }}
          >
            {/* activos */}
            <div className="flex w-full flex-col justify-end" style={{ height: hAct }}>
              <div className="mx-auto flex w-1/2 max-w-10 flex-col overflow-hidden rounded-t-md">
                <div className="grow-bar" style={{ height: px(d.teDeben), background: NW_COLORS.deben }} />
                <div className="grow-bar" style={{ height: px(d.usdtArs), background: NW_COLORS.usdt }} />
                <div className="grow-bar" style={{ height: px(d.usdArs), background: NW_COLORS.usd }} />
                <div className="grow-bar" style={{ height: px(d.ars), background: NW_COLORS.ars }} />
              </div>
            </div>
            {/* pasivos, hacia abajo */}
            <div className="flex w-full flex-col justify-start border-t border-line" style={{ height: hPas }}>
              <div className="mx-auto w-1/2 max-w-10 overflow-hidden rounded-b-md">
                <div className="grow-bar" style={{ height: px(d.pasivos), background: NW_COLORS.pasivo, opacity: 0.85 }} />
              </div>
            </div>
            <span className="mt-1 text-[0.65rem] text-faint">{d.label}</span>
          </div>
        ))}
      </div>

      {sel && (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line pt-3 text-xs">
          <span className="text-muted">{sel.label}</span>
          <span className="tnum text-fg">Neto {fmt(sel.patrimonio)}</span>
          <span className="tnum text-faint">Activos {fmt(sel.ars + sel.usdArs + sel.usdtArs + sel.teDeben)} · Pasivos {fmt(sel.pasivos)}</span>
          {prev && (
            <span className={`tnum ml-auto ${sel.patrimonio - prev.patrimonio >= 0 ? "text-emerald" : "text-coral"}`}>
              {sel.patrimonio - prev.patrimonio >= 0 ? "▲" : "▼"} {fmt(Math.abs(sel.patrimonio - prev.patrimonio))} vs mes anterior
            </span>
          )}
        </div>
      )}
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
                {showEst && <td className="tnum py-2.5 text-right text-accent/90">{d.est > 0 ? fmt(d.est) : "—"}</td>}
                <td className={`tnum py-2.5 text-right ${tone}`}>{tag}{pctTxt}<span className="block text-[0.6rem] text-faint">{delta >= 0 ? "+" : "−"}{fmt(Math.abs(delta))}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
