// Set de íconos SVG (stroke) hechos a mano para no depender de librerías.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

export const Grid = (p: P) => (
  <svg {...base(p)}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const Swap = (p: P) => (
  <svg {...base(p)}><path d="M7 7h11l-3-3" /><path d="M17 17H6l3 3" /></svg>
);
export const Card = (p: P) => (
  <svg {...base(p)}><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 9.5h19" /><path d="M6 15h4" /></svg>
);
export const Handshake = (p: P) => (
  <svg {...base(p)}><path d="M12 9 9.5 6.5a2 2 0 0 0-2.8 0L3 10.2v5.3l2 2" /><path d="m12 9 2.5-2.5a2 2 0 0 1 2.8 0L21 10.2v5.3l-2 2" /><path d="M7 14l2.5 2.5a1.7 1.7 0 0 0 2.4 0L14 15" /></svg>
);
export const Repeat = (p: P) => (
  <svg {...base(p)}><path d="M17 2.5 20.5 6 17 9.5" /><path d="M3.5 11V9a3 3 0 0 1 3-3h14" /><path d="M7 21.5 3.5 18 7 14.5" /><path d="M20.5 13v2a3 3 0 0 1-3 3h-14" /></svg>
);
export const Coins = (p: P) => (
  <svg {...base(p)}><ellipse cx="9" cy="7" rx="6" ry="3" /><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" /><path d="M9 12.9V18c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.3-1.6-2.4-3.9-2.8" /></svg>
);
export const Sparkle = (p: P) => (
  <svg {...base(p)}><path d="M12 3.5c.6 3.6 1.9 4.9 5.5 5.5-3.6.6-4.9 1.9-5.5 5.5-.6-3.6-1.9-4.9-5.5-5.5 3.6-.6 4.9-1.9 5.5-5.5Z" /><path d="M18.5 14.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5Z" /></svg>
);
export const Gear = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6h.1A1.6 1.6 0 0 0 8.5 1.1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 14 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.4 1.1Z" /></svg>
);
export const Bell = (p: P) => (
  <svg {...base(p)}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
);
export const Search = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
);
export const Plus = (p: P) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const ArrowUpRight = (p: P) => (
  <svg {...base(p)}><path d="M7 17 17 7M8 7h9v9" /></svg>
);
export const ArrowDownRight = (p: P) => (
  <svg {...base(p)}><path d="M7 7 17 17M17 8v9H8" /></svg>
);
export const Camera = (p: P) => (
  <svg {...base(p)}><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z" /><circle cx="12" cy="13" r="3.2" /></svg>
);
export const Mail = (p: P) => (
  <svg {...base(p)}><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="m3.5 7 8.5 6 8.5-6" /></svg>
);
export const Mic = (p: P) => (
  <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" /></svg>
);
export const Send = (p: P) => (
  <svg {...base(p)}><path d="M4 12 20 4l-6 16-2.5-6.5L4 12Z" /></svg>
);
export const Pencil = (p: P) => (
  <svg {...base(p)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
export const Trash = (p: P) => (
  <svg {...base(p)}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" /></svg>
);
export const X = (p: P) => (
  <svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const Chart = (p: P) => (
  <svg {...base(p)}><path d="M3 3v18h18" /><path d="M7 15l3-4 3 2 4-6" /></svg>
);
export const Chevron = (p: P) => (
  <svg {...base(p)}><path d="m6 9 6 6 6-6" /></svg>
);
export const Tag = (p: P) => (
  <svg {...base(p)}><path d="M3 7v5a2 2 0 0 0 .6 1.4l7 7a2 2 0 0 0 2.8 0l5-5a2 2 0 0 0 0-2.8l-7-7A2 2 0 0 0 12 5H5a2 2 0 0 0-2 2Z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>
);
export const Flow = (p: P) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11M15 4v16" /></svg>
);
