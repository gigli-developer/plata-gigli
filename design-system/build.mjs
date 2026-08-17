// Genera los previews HTML del design system de Plata en ./dist.
//   node design-system/build.mjs
// Cada archivo lleva en la PRIMERA línea un marcador `<!-- @dsCard group="…" -->`,
// que es lo que claude.ai/design usa para armar el índice de cards.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLORS, TYPE, SURFACES } from "./tokens.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "dist");

// ── shell común ──────────────────────────────────────────────────────────────
// La atmósfera del body es parte del diseño: sin ella el vidrio se ve gris y
// plano, así que los previews la replican para mostrar los componentes en su
// contexto real.
const BASE = `
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:'Hanken Grotesk',system-ui,sans-serif;
  color:#f4f4f3;background-color:#0a0a0a;
  background-image:
    radial-gradient(520px 460px at 7% 90%, rgba(255,176,84,.50), rgba(255,150,54,0) 62%),
    radial-gradient(300px 300px at 3% 95%, rgba(255,205,120,.42), transparent 58%),
    radial-gradient(820px 1000px at -4% 40%, rgba(74,120,72,.30), transparent 58%),
    radial-gradient(980px 1080px at 102% 30%, rgba(96,152,206,.34), transparent 56%),
    radial-gradient(1300px 1200px at 50% 122%, rgba(6,6,9,0), rgba(5,5,8,.62) 72%),
    linear-gradient(158deg,#14110e 0%,#0d0b0d 46%,#0a0d12 100%);
  background-attachment:fixed;
  -webkit-font-smoothing:antialiased;
  padding:28px;
}
.panel{
  background:rgba(255,255,255,.08);
  --glass:blur(26px) saturate(170%);
  -webkit-backdrop-filter:var(--glass);backdrop-filter:var(--glass);
  border:1px solid rgba(255,255,255,.32);border-radius:20px;
  box-shadow:0 12px 44px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.42),inset 0 0 0 1px rgba(255,255,255,.06);
}
.panel-inner{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:14px}
.tnum{font-family:'JetBrains Mono',ui-monospace,monospace;font-feature-settings:'tnum' 1;letter-spacing:-.02em}
.disp{font-family:'Bricolage Grotesque',system-ui,sans-serif;letter-spacing:-.02em}
.label-micro{font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#9a9a9f}
h1.t{font-size:24px;font-weight:700;letter-spacing:-.03em;margin-bottom:6px;font-family:'Bricolage Grotesque',system-ui,sans-serif}
p.sub{font-size:13.5px;color:#9a9a9f;margin-bottom:22px;max-width:760px;line-height:1.5}
h2.s{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b6b70;margin:26px 0 12px}
.grid{display:grid;gap:14px}
code{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11.5px;color:#ffbf47;
  background:rgba(255,255,255,.06);padding:2px 6px;border-radius:5px;white-space:nowrap}
pre{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;line-height:1.65;color:#c2c2c6;
  background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.09);border-radius:11px;
  padding:13px 15px;overflow-x:auto;margin-top:11px}
.note{font-size:12.5px;color:#9a9a9f;line-height:1.55;margin-top:9px}
.warn{border-left:2px solid #ff9e1b;padding-left:11px;color:#c2c2c6;font-size:12.5px;line-height:1.55;margin-top:11px}
.bad{border-left:2px solid #ff433d;padding-left:11px}
.good{border-left:2px solid #35e08a;padding-left:11px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:#6b6b70;
  padding:0 10px 9px 0;font-weight:400;border-bottom:1px solid rgba(255,255,255,.1)}
td{padding:9px 10px 9px 0;border-bottom:1px solid rgba(255,255,255,.055);vertical-align:top;color:#c2c2c6}
`;

function page(title, cardGroup, body, subtitle = "") {
  return `<!-- @dsCard group="${cardGroup}" -->
<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Plata</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;800&display=swap" rel="stylesheet">
<style>${BASE}</style></head><body>
<h1 class="t">${title}</h1>${subtitle ? `<p class="sub">${subtitle}</p>` : ""}
${body}
</body></html>`;
}

const files = {};

// ── 1 · Colores ──────────────────────────────────────────────────────────────
files["foundations/colors.html"] = page(
  "Color",
  "Foundations",
  COLORS.map((g) => `
    <h2 class="s">${g.group}</h2>
    <p class="note" style="margin-bottom:13px">${g.note}</p>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(232px,1fr))">
      ${g.items.map((c) => `
        <div class="panel-inner" style="padding:13px;display:flex;gap:12px;align-items:flex-start">
          <div style="width:42px;height:42px;border-radius:9px;flex-shrink:0;background:${c.value};
                      border:1px solid rgba(255,255,255,.18)"></div>
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600">${c.name}</div>
            <div class="tnum" style="font-size:10.5px;color:#6b6b70;margin:2px 0 4px">${c.value}</div>
            <div style="font-size:11.5px;color:#9a9a9f;line-height:1.45">${c.use}</div>
          </div>
        </div>`).join("")}
    </div>`).join(""),
  "Los tokens viven en <code>@theme</code> de app/globals.css. El acento se llama <code>accent</code> y no <code>orange</code> a propósito: ya cambió una vez (era lima ácido) y así el próximo cambio no obliga a tocar 129 clases en 22 archivos."
);

// ── 2 · Tipografía ───────────────────────────────────────────────────────────
files["foundations/typography.html"] = page(
  "Tipografía",
  "Foundations",
  TYPE.map((t) => `
    <h2 class="s">${t.role} — ${t.name}</h2>
    <div class="panel" style="padding:19px">
      <div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:15px">
        <code>${t.varName}</code><code>${t.cls}</code>
      </div>
      <p class="note" style="margin:0 0 15px">${t.use}</p>
      ${t.samples.map((s) => `
        <div style="padding:13px 0;border-top:1px solid rgba(255,255,255,.07)">
          <div class="label-micro" style="margin-bottom:7px">${s.label}</div>
          <div style="font-family:${t.name === "JetBrains Mono" ? "'JetBrains Mono',monospace" : t.name === "Bricolage Grotesque" ? "'Bricolage Grotesque',sans-serif" : "'Hanken Grotesk',sans-serif"};${s.css}">${s.text}</div>
        </div>`).join("")}
    </div>`).join("") + `
    <div class="warn" style="margin-top:22px"><strong>Regla dura:</strong> todo monto lleva <code>.tnum</code>.
    No es solo estética — es el marcador que usa el modo privacidad para taparlo.
    Un monto sin <code>.tnum</code> queda a la vista con la privacidad activada.</div>`,
  "Tres familias, tres roles que no se cruzan."
);

// ── 3 · Superficies ──────────────────────────────────────────────────────────
files["foundations/surfaces.html"] = page(
  "Superficies",
  "Foundations",
  SURFACES.map((s) => `
    <h2 class="s">${s.name}</h2>
    <div class="${s.name === ".panel-inner" ? "panel" : ""}" style="${s.name === ".panel-inner" ? "padding:17px" : ""}">
      <div class="${s.name === ".ai-glow" ? "" : s.name === ".chip" ? "" : s.name.replace(".", "")}"
           style="padding:17px;${s.name === ".ai-glow" ? "background:rgba(255,255,255,.06);border:1px solid rgba(255,158,27,.38);border-radius:20px;box-shadow:0 0 0 1px rgba(255,158,27,.06),0 18px 50px -22px rgba(255,158,27,.45)" : ""}${s.name === ".chip" ? "border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);border-radius:999px;display:inline-block;padding:7px 15px" : ""}">
        <div style="font-size:13.5px;color:#c2c2c6">${s.name === ".chip" ? "¿Cuánto gasté en Compras?" : "Contenido sobre " + s.name}</div>
      </div>
      <p class="note">${s.desc}</p>
      <pre>${s.css.replace(/</g, "&lt;")}</pre>
      ${s.gotcha ? `<div class="warn"><strong>Ojo:</strong> ${s.gotcha}</div>` : ""}
    </div>`).join(""),
  "El vidrio es la superficie firmada del rediseño. Flota sobre la atmósfera del body — si se saca el gradiente de fondo, las cards quedan grises y planas."
);

// ── 4 · Estados interactivos — LA CAPA QUE FALTA ─────────────────────────────
const pill = (active, label) =>
  `<button style="border:0;cursor:pointer;font:inherit;border-radius:999px;padding:5px 13px;font-size:12px;
    transition:color .15s ease,background-color .15s ease;
    ${active ? "background:rgba(255,158,27,.15);color:#ff9e1b" : "background:transparent;color:#c2c2c6"}">${label}</button>`;

files["foundations/states.html"] = page(
  "Estados interactivos",
  "Foundations",
  `
  <div class="warn" style="margin-bottom:24px">
    <strong>El problema que esto resuelve.</strong> Hoy la app tiene
    <strong>3 convenciones distintas de pill toggle</strong>, <strong>4 alfas distintos</strong> para el hover de una fila
    y <strong>28 inputs</strong> con <code>outline-none</code> sin reemplazo. Cada pantalla reimplementó lo mismo con su
    propio hover. Esta página fija el canon: el valor elegido es siempre el que ya usa la mayoría del código.
  </div>

  <h2 class="s">Pill toggle — el canon</h2>
  <div class="panel" style="padding:17px">
    <div style="display:inline-flex;border-radius:999px;border:1px solid rgba(255,255,255,.10);
                background:rgba(255,255,255,.06);padding:2px">
      ${pill(true, "Pesos")}${pill(false, "Dólares")}${pill(false, "USDT")}
    </div>
    <pre>activo    → bg-accent/15 text-accent
inactivo  → text-muted hover:text-fg
ítem      → rounded-full px-3 py-1 transition-colors
contenedor→ rounded-full border border-white/10 bg-white/[0.06] p-0.5</pre>
    <div class="note bad" style="margin-top:13px"><strong>Lo que hay que reemplazar:</strong>
      <code>bg-accent text-bg</code> (naranja sólido) y <code>bg-white/[0.09] text-fg</code> (blanco).
      El caso más visible es <code>cashflow/page.tsx:305-310</code>: dos grupos de píldoras pegados
      en la misma fila, uno pinta el activo naranja y el otro blanco.</div>
  </div>

  <h2 class="s">Hover por rol</h2>
  <div class="panel" style="padding:17px">
    <table>
      <tr><th>Rol</th><th>Hover</th><th>Nota</th></tr>
      <tr><td>Fila de lista</td><td><code>hover:bg-white/[0.05]</code></td><td>+ <code>transition-colors</code> siempre</td></tr>
      <tr><td>Botón de ícono</td><td><code>hover:bg-white/[0.07] hover:text-fg</code></td><td>el alfa más alto queda reservado acá</td></tr>
      <tr><td>Card clickeable</td><td><code>.panel-hover</code></td><td>sube 2px y aclara el borde</td></tr>
      <tr><td>Chip / filtro</td><td>activo <code>border-accent/40 bg-accent/10 text-accent</code></td><td>inactivo <code>text-muted hover:text-fg</code></td></tr>
      <tr><td>Botón primario</td><td><code>hover:scale-[1.02]</code></td><td>un solo valor de escala en toda la app</td></tr>
    </table>
    <div class="note bad" style="margin-top:13px"><strong>Hoy conviven</strong> cuatro alfas para el mismo hover de fila
      (<code>0.04</code>, <code>0.05</code>, <code>0.07</code>, <code>0.11</code>) y tres escalas
      (<code>1.02</code>, <code>1.03</code>, <code>105</code>).</div>
  </div>

  <h2 class="s">Foco — accesibilidad</h2>
  <div class="panel" style="padding:17px">
    <div style="display:flex;gap:11px;flex-wrap:wrap;align-items:center">
      <div style="border:1px solid rgba(255,255,255,.10);border-radius:11px;padding:9px 13px;font-size:13px;color:#6b6b70">
        sin foco</div>
      <div style="border:1px solid rgba(255,158,27,.40);border-radius:11px;padding:9px 13px;font-size:13px;color:#f4f4f3">
        con foco &nbsp;<span style="color:#ff9e1b">←</span></div>
    </div>
    <pre>input   → focus:border-accent/40      (un solo tono, siempre)
botón   → focus-visible:outline-2 focus-visible:outline-offset-2
          focus-visible:outline-accent</pre>
    <div class="note bad" style="margin-top:13px"><strong>Estado actual:</strong> 61 <code>outline-none</code> y solo 33
      <code>focus:border-*</code> → <strong>28 campos sin ninguna señal de foco</strong>. Y un solo elemento en toda la app
      tiene <code>focus-visible</code> propio (el rail de desktop). Navegar con teclado es prácticamente a ciegas.</div>
  </div>

  <h2 class="s">Disabled</h2>
  <div class="panel" style="padding:17px">
    <button style="border:0;font:inherit;border-radius:11px;padding:9px 17px;background:#ff9e1b;color:#0a0a0a;
                   font-weight:600;font-size:13px;opacity:.6;cursor:not-allowed">Guardando…</button>
    <pre>disabled:opacity-60 disabled:pointer-events-none</pre>
    <div class="note bad" style="margin-top:13px"><strong>Bug real:</strong> <code>:hover</code> matchea igual sobre un
      <code>&lt;button disabled&gt;</code>. Hoy hay <strong>12 botones</strong> que siguen agrandándose con
      <code>hover:scale-*</code> mientras están deshabilitados y dicen "Guardando…".
      Y el <code>disabled:opacity</code> va de 40 a 60 sin criterio.</div>
  </div>

  <h2 class="s">Touch — hover pegado</h2>
  <div class="panel" style="padding:17px">
    <p class="note" style="margin-top:0">Tailwind envuelve <code>hover:</code> en <code>@media (hover:hover)</code>,
    pero las clases escritas a mano en <code>globals.css</code> no. <code>.panel-hover</code> y <code>.chip</code>
    quedan <strong>pegadas tras un tap en el celular</strong>: la card se queda levantada y más clara hasta recargar.</p>
    <pre>@media (hover: hover) {
  .panel-hover:hover { … }
  .chip:hover { … }
}</pre>
    <div class="note" style="margin-top:11px">Lo mismo pasa con los gráficos: usan
      <code>onMouseEnter</code>/<code>onMouseLeave</code> sin equivalente táctil, así que en un tap el tooltip
      queda fijo y el resto de las barras atenuadas.</div>
  </div>`,
  "La capa que la app no tiene. Cada valor de acá es el que ya usa la mayoría del código — no es un rediseño, es unificar lo que se dispersó."
);

// ── 5 · Grilla ───────────────────────────────────────────────────────────────
files["foundations/layout.html"] = page(
  "Grilla y espaciado",
  "Foundations",
  `
  <div class="note good" style="margin-bottom:22px"><strong>La referencia es /divisas.</strong>
  Es la pantalla donde los KPIs, los gráficos y las cards cierran en un rectángulo parejo.
  El resto debería replicar su receta.</div>

  <h2 class="s">La receta</h2>
  <div class="panel" style="padding:17px">
    <table>
      <tr><th>Decisión</th><th>Valor</th></tr>
      <tr><td>Gap del grid principal</td><td><code>gap-4</code></td></tr>
      <tr><td>Padding de panel</td><td><code>p-5</code> (cards de contenido) · <code>p-4</code> (KPI chicos)</td></tr>
      <tr><td>Separación entre secciones</td><td><code>mt-6</code></td></tr>
      <tr><td>Altura pareja en una fila</td><td><code>items-stretch</code> + <code>h-full</code> en la card</td></tr>
      <tr><td>Columnas</td><td>arrancan en <code>grid-cols-1</code> y suben con <code>sm:</code>/<code>lg:</code></td></tr>
    </table>
  </div>

  <h2 class="s">Lo que rompe el rectángulo</h2>
  <div class="panel" style="padding:17px">
    <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
      <div>
        <div class="label-micro" style="margin-bottom:9px;color:#ff433d">✗ desfasado</div>
        <div style="display:grid;gap:9px">
          <div class="panel-inner" style="height:78px"></div>
          <div class="panel-inner" style="height:52px"></div>
        </div>
        <div class="note" style="font-size:11.5px">Cards de distinta altura en la misma fila: sin
        <code>h-full</code>, cada una mide lo que mide su contenido y abajo queda un escalón.</div>
      </div>
      <div>
        <div class="label-micro" style="margin-bottom:9px;color:#35e08a">✓ cuadrado</div>
        <div style="display:grid;gap:9px">
          <div class="panel-inner" style="height:65px"></div>
          <div class="panel-inner" style="height:65px"></div>
        </div>
        <div class="note" style="font-size:11.5px">Con <code>items-stretch</code> + <code>h-full</code> las dos
        terminan al mismo nivel y la sección cierra en un rectángulo.</div>
      </div>
    </div>
    <div class="note" style="margin-top:15px">La otra causa: <strong>grids que no cierran</strong> —
    3 columnas con 4 items deja uno solo abajo. O se completa la fila, o se baja a 2 columnas.</div>
  </div>`,
  "El usuario lo describió así: «en divisas está todo en un cuadrado y todo forma un cuadrado; en resumen no forma un cuadrado, y eso me choca»."
);

// ── 6 · Modo privacidad ──────────────────────────────────────────────────────
files["patterns/privacy.html"] = page(
  "Modo privacidad",
  "Patterns",
  `
  <div class="panel" style="padding:19px;max-width:430px">
    <div class="label-micro">Saldo total</div>
    <div class="tnum" style="font-size:38px;font-weight:800;line-height:1.05;margin:5px 0 3px;position:relative;visibility:hidden">
      <span style="visibility:visible;position:absolute;inset:0;letter-spacing:.06em">****</span>$ 14.729.456</div>
    <div style="font-size:13.5px;color:#6b6b70">≈ <span class="tnum" style="position:relative;visibility:hidden"><span style="visibility:visible;position:absolute;inset:0;letter-spacing:.06em">****</span>$ 1.245.300</span> al blue de hoy</div>
    <div style="display:flex;gap:9px;margin-top:17px">
      ${[["Ingresos", "#35e08a"], ["Egresos", "#ff433d"], ["Patrimonio", "#f4f4f3"]].map(([l, c]) => `
        <div class="panel-inner" style="flex:1;padding:11px">
          <div class="label-micro">${l}</div>
          <div class="tnum" style="font-size:19px;font-weight:600;color:${c};margin-top:4px;position:relative;visibility:hidden">
            <span style="visibility:visible;position:absolute;inset:0;letter-spacing:.06em">****</span>$ 2.480.000</div>
        </div>`).join("")}
    </div>
  </div>
  <pre>.privacy .tnum {
  visibility: hidden;      /* heredable → se revierte en el ::after */
  position: relative;
}
.privacy .tnum::after {
  content: "****";
  visibility: visible;
  position: absolute; inset: 0;
  letter-spacing: .06em;
  text-align: inherit;     /* respeta los montos alineados a la derecha */
}</pre>
  <div class="warn"><strong>Por qué <code>visibility</code> y no <code>color:transparent</code>:</strong>
  visibility es heredable y se puede revertir en el pseudo-elemento, así que los asteriscos conservan solos
  el color semántico del monto (verde/coral/dorado) y su tamaño. Con <code>color:transparent</code> el
  <code>::after</code> heredaría transparent y habría que repetir cada color a mano.</div>
  <div class="note">El elemento conserva su ancho real, así que el layout no salta al togglear.
  <strong>Alcance:</strong> solo tapa elementos con <code>.tnum</code> — un monto sin esa clase queda a la vista.</div>`,
  "Reemplaza los montos por asteriscos. Antes era <code>filter: blur(8px)</code>."
);

// ── escribir ─────────────────────────────────────────────────────────────────
let n = 0;
for (const [path, html] of Object.entries(files)) {
  const full = join(OUT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html, "utf8");
  n++;
}
console.log(`${n} previews generados en ${OUT}`);
for (const p of Object.keys(files)) console.log("  " + p);
