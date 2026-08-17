// Fuente única del design system de Plata.
// Todo lo de acá está COPIADO de app/globals.css (@theme) — si cambia allá, cambia acá.
// El generador (build.mjs) arma los previews HTML que se suben a claude.ai/design.

export const COLORS = [
  {
    group: "Base",
    note: "El fondo real no es plano: body pinta 7 radial-gradients encima de #0a0a0a. Las superficies son translúcidas y flotan sobre esa atmósfera.",
    items: [
      { name: "bg", value: "#0a0a0a", use: "fondo de la app (debajo del gradiente de atmósfera)" },
      { name: "surface", value: "#101111", use: "card de modal sólida (Modal.tsx)" },
      { name: "surface-2", value: "#141515", use: "definido, hoy sin uso directo" },
      { name: "surface-3", value: "#1c1d1d", use: "fallback de dona vacía" },
      { name: "line", value: "rgba(255,255,255,0.10)", use: "borde por defecto de todo" },
    ],
  },
  {
    group: "Texto",
    note: "Cuatro niveles, de más a menos peso visual. La regla: un dato es fg, su etiqueta es subtle, el apoyo es faint.",
    items: [
      { name: "fg", value: "#f4f4f3", use: "dato principal, títulos" },
      { name: "muted", value: "#c2c2c6", use: "texto secundario legible" },
      { name: "subtle", value: "#9a9a9f", use: "labels, estado inactivo de pills" },
      { name: "faint", value: "#6b6b70", use: "apoyo, hints, metadatos" },
    ],
  },
  {
    group: "Semánticos",
    note: "Cada color tiene UN significado en el dominio. No se usan por estética: el verde siempre es plata que entra.",
    items: [
      { name: "accent", value: "#ff9e1b", use: "acento principal · pesos (ARS) · acción primaria" },
      { name: "accent-hover", value: "#ffb84d", use: "hover del acento" },
      { name: "gold", value: "#ffbf47", use: "dólares (USD)" },
      { name: "sky", value: "#5ec8ff", use: "USDT / cripto / serie secundaria" },
      { name: "emerald", value: "#35e08a", use: "positivo · ingresos · te deben" },
      { name: "coral", value: "#ff433d", use: "negativo · egresos · pasivos" },
      { name: "violet", value: "#a78bfa", use: "LEGACY — se está migrando, no usar en nuevo código" },
      { name: "amber", value: "#ffbf47", use: "alias exacto de gold — duplicado histórico, preferí gold" },
    ],
  },
];

export const TYPE = [
  {
    name: "Bricolage Grotesque",
    varName: "--font-display",
    cls: ".font-display",
    role: "Display",
    use: "Títulos de página y de card. Siempre con letter-spacing -0.02em.",
    samples: [
      { label: "Hero de página", css: "font-size:32px;font-weight:700;letter-spacing:-0.03em", text: "Tu resumen" },
      { label: "Título de card", css: "font-size:17px;font-weight:600", text: "Gastos por categoría" },
    ],
  },
  {
    name: "Hanken Grotesk",
    varName: "--font-sans",
    cls: "(default en body)",
    role: "Texto",
    use: "Todo el texto corrido, labels y descripciones.",
    samples: [
      { label: "Cuerpo", css: "font-size:14px", text: "Los préstamos no se cuentan como gasto." },
      { label: "Label micro", css: "font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#9a9a9f", text: "Saldo total" },
    ],
  },
  {
    name: "JetBrains Mono",
    varName: "--font-mono",
    cls: ".tnum",
    role: "Números",
    use: "TODO monto lleva .tnum. No es solo estética: es el marcador que usa el modo privacidad para taparlos.",
    samples: [
      { label: "Monto hero", css: "font-size:36px;font-weight:800;font-feature-settings:'tnum' 1;letter-spacing:-0.02em", text: "$ 14.729.456" },
      { label: "Monto en tabla", css: "font-size:15px;font-feature-settings:'tnum' 1", text: "$ 1.938.412" },
    ],
  },
];

// Clases de superficie, tal cual están en globals.css
export const SURFACES = [
  {
    name: ".panel",
    desc: "La superficie de las cards: fondo translúcido sobre la atmósfera del body, borde claro y sombra. Fue vidrio real (backdrop-filter) hasta el 2026-08-03.",
    css: `background: rgba(255,255,255,0.07);
border: 1px solid rgba(255,255,255,0.32);
border-radius: 20px;
box-shadow: 0 12px 44px rgba(0,0,0,.32),
            inset 0 1px 0 rgba(255,255,255,.42),
            inset 0 0 0 1px rgba(255,255,255,.06);`,
    gotcha: "NO le devuelvas el <code>backdrop-filter</code>. Provocaba un bug de rasterizado de Chrome: al forzarse un repaint (pasar el cursor por el rail) aparecían franjas sombreadas sobre las cards y no se iban. Se probaron 13 variantes en el navegador del usuario — will-change, contain:paint, translateZ, isolation, tocar el fondo, bajar el blur hasta 4px — y ninguna lo evitó conservando el efecto. Lo único que lo elimina es no tener backdrop-filter.",
  },
  {
    name: ".panel-inner",
    desc: "Sub-panel dentro de una card de vidrio. NO lleva blur propio: apilar backdrop-filters multiplica el costo y casi no se nota.",
    css: `background: rgba(255,255,255,0.05);
border: 1px solid rgba(255,255,255,0.10);
border-radius: 14px;`,
    gotcha: null,
  },
  {
    name: ".panel-hover",
    desc: "Estado hover para paneles clickeables. Sube 2px y aclara el borde.",
    css: `transition: border-color .15s ease, transform .15s ease, background .15s ease;
/* :hover */
border-color: rgba(255,255,255,0.45);
background: rgba(255,255,255,0.11);
transform: translateY(-2px);`,
    gotcha: null,
  },
  {
    name: ".ai-glow",
    desc: "Reservado para el asistente IA. Borde naranja con gradiente enmascarado naranja→sky.",
    css: `background: rgba(255,255,255,0.06);
border: 1px solid rgba(255,158,27,0.38);
box-shadow: 0 0 0 1px rgba(255,158,27,.06),
            0 18px 50px -22px rgba(255,158,27,.45);`,
    gotcha: "El gradiente del borde se hace con ::before + mask-composite: exclude.",
  },
  {
    name: ".chip",
    desc: "Píldora de filtro o sugerencia.",
    css: `border: 1px solid rgba(255,255,255,0.10);
background: rgba(255,255,255,0.06);
border-radius: 999px;
transition: all .15s ease;
/* :hover */
border-color: rgba(255,158,27,0.45);
color: var(--color-fg);`,
    gotcha: null,
  },
];
