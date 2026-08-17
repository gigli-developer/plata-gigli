/**
 * Prueba del fuzzy match de alias contra la tabla `targets` REAL.
 *
 * Por qué contra la tabla real y no contra un mock: el umbral no se puede elegir
 * en abstracto. Depende de qué tan parecidos entre sí sean los aliases que están
 * cargados — con "chrome" y "chrome canary" en la misma tabla, el mismo puntaje
 * que hoy es seguro pasa a ser una moneda al aire. Este script es el que dice si
 * los números de `lib/agent/targets.ts` siguen siendo los correctos.
 *
 * Las entradas son transcripciones reales del STT (o del mismo tipo): el nombre
 * partido en dos, la "e" protética del español, la consonante final que se come.
 *
 * NO escribe nada: las altas que prueba son todas inválidas y rebotan en la
 * validación, antes de tocar la base.
 *
 *   node scripts/probar-targets.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  decidir, rankear, compactar, registrarTarget,
  UMBRAL_ALTO, UMBRAL_DUDA, MARGEN,
} from "../lib/agent/targets.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// --- casos ------------------------------------------------------------------
// `espera`: el alias que TIENE que salir, "" si no hay que resolver nada,
// o un array si lo correcto es preguntar entre esos.

const CASOS = [
  // Los seis que pidió el encargo.
  ["spotifai", "spotify"],
  ["spotify", "spotify"],
  ["espotifai", "spotify"],
  ["cro me", "chrome"],
  ["you tube", "youtube"],
  ["discor", ""],
  // Más ruido de STT del mismo tipo, para ver dónde está el borde.
  ["espotify", "spotify"],
  ["chrome", "chrome"],
  ["crome", "chrome"],
  ["yutub", "youtube"],
  ["youtu", "youtube"],
  ["vs code", "vscode"],
  ["visual estudio code", "vscode"],
  ["el chrome ese", "chrome"],
  ["SPOTIFY", "spotify"],
  // Controles negativos: NO tiene que abrir nada de esto.
  ["telegram", ""],
  ["notion", ""],
  ["excel", ""],
  ["whatsapp", ""],
  ["yo", ""],
];

// --- corrida ----------------------------------------------------------------

const { data, error } = await sb.from("targets").select("id,alias,tipo,valor,aprobado");
if (error) throw new Error(`No pude leer targets: ${error.message}`);
const targets = data ?? [];

console.log(`\nTabla real: ${targets.length} targets → ${targets.map((t) => `${t.alias} (${t.tipo}${t.aprobado ? "" : ", SIN APROBAR"})`).join(", ")}`);
console.log(`Umbrales: alto ${UMBRAL_ALTO} · duda ${UMBRAL_DUDA} · margen de empate ${MARGEN}\n`);

const p2 = (n) => n.toFixed(2);
let aciertos = 0;
const fallos = [];
const puntajesBuenos = [];   // el del match correcto
const puntajesMalos = [];    // el mejor de los que NO tenían que resolver

console.log("entrada".padEnd(22) + "→ resuelve".padEnd(16) + "pje   2º     esperado");
console.log("-".repeat(74));

for (const [entrada, espera] of CASOS) {
  const r = decidir(entrada, targets);
  const rank = rankear(entrada, targets);
  const mejor = rank[0]?.puntaje ?? 0;
  const segundo = rank[1]?.puntaje ?? 0;

  const salida =
    r.estado === "resuelto" ? r.target.alias
      : r.estado === "ambiguo" ? `? ${r.candidatos.map((c) => c.alias).join("/")}`
        : "—";

  const ok = Array.isArray(espera)
    ? r.estado === "ambiguo" && espera.every((a) => r.candidatos.some((c) => c.alias === a))
    : espera === ""
      ? r.estado === "sin_match"
      : r.estado === "resuelto" && r.target.alias === espera;

  if (ok) aciertos++; else fallos.push({ entrada, espera, salida, mejor });
  (espera === "" ? puntajesMalos : puntajesBuenos).push(mejor);

  console.log(
    `${ok ? "✓" : "✗"} ${entrada.padEnd(20)}` +
    `${salida.padEnd(16)}${p2(mejor)}  ${p2(segundo)}   ${espera === "" ? "(nada)" : espera}`,
  );
}

console.log("-".repeat(74));
console.log(`${aciertos}/${CASOS.length} casos.`);
if (fallos.length) {
  console.log("\nFALLOS:");
  for (const f of fallos) console.log(`  "${f.entrada}" → ${f.salida} (pje ${p2(f.mejor)}), esperaba ${f.espera || "nada"}`);
}

// --- el valle: por qué el umbral está donde está ----------------------------

const peorBueno = Math.min(...puntajesBuenos);
const mejorMalo = Math.max(...puntajesMalos);
console.log("\nDónde queda el corte");
console.log(`  peor match legítimo   ${p2(peorBueno)}`);
console.log(`  mejor falso positivo  ${p2(mejorMalo)}`);
console.log(`  umbral elegido        ${UMBRAL_ALTO}  (aire: ${p2(peorBueno - UMBRAL_ALTO)} arriba, ${p2(UMBRAL_ALTO - mejorMalo)} abajo)`);
if (peorBueno <= UMBRAL_ALTO || mejorMalo >= UMBRAL_ALTO) {
  console.log("  ⚠️  El valle se cerró: revisá el umbral o la tabla tiene aliases demasiado parecidos.");
}

// --- normalización ----------------------------------------------------------

console.log("\nNormalización (lo que realmente se compara)");
for (const s of ["Spotify", "espotifai", "cro me", "you tube", "Códigó", "VS Code"]) {
  console.log(`  ${s.padEnd(14)} → ${compactar(s)}`);
}

// --- empate simulado: dos aliases parecidos ---------------------------------
// La tabla de hoy no tiene ninguno, pero el script de escaneo de Windows va a
// meter decenas y ahí el margen de empate es lo único que evita abrir cualquiera.

const conEmpate = [
  ...targets,
  { id: -1, alias: "chrome canary", tipo: "app", valor: "C:\\x.exe", aprobado: true },
  { id: -2, alias: "spotify web", tipo: "url", valor: "https://open.spotify.com", aprobado: true },
];
console.log("\nEmpate simulado (se agregan 'chrome canary' y 'spotify web' a la tabla)");
for (const q of ["chrome canari", "crome", "spotify"]) {
  const e = decidir(q, conEmpate);
  const detalle = e.estado === "ambiguo"
    ? `pregunta entre ${e.candidatos.map((c) => `${c.alias} ${p2(c.puntaje)}`).join(" / ")}`
    : e.estado === "resuelto" ? `abre ${e.target.alias} (${p2(e.puntaje)})` : "nada";
  console.log(`  "${q}"`.padEnd(20) + `${e.estado.padEnd(10)} ${detalle}`);
  console.log("".padEnd(20) + `puntajes: ${rankear(q, conEmpate).slice(0, 3).map((c) => `${c.alias} ${p2(c.puntaje)}`).join(" · ")}`);
}

// --- validación de registrar_target (sin escribir) --------------------------

console.log("\nregistrar_target — validaciones (ninguna de estas llega al insert)");
const ALTAS = [
  ["tipo inventado", { alias: "algo", tipo: "script", valor: "x" }],
  ["ruta relativa", { alias: "notepad", tipo: "app", valor: "notepad.exe" }],
  ["ruta con ..", { alias: "notepad", tipo: "app", valor: "C:\\Windows\\..\\x.exe" }],
  ["app que no es ejecutable", { alias: "notepad", tipo: "app", valor: "C:\\Windows\\notepad.txt" }],
  ["url file://", { alias: "disco", tipo: "url", valor: "file:///C:/" }],
  ["url sin esquema", { alias: "gmail", tipo: "url", valor: "gmail.com" }],
  ["discord no numérico", { alias: "gaming", tipo: "discord", valor: "servidor/general" }],
  ["discord uri entera", { alias: "gaming", tipo: "discord", valor: "discord://x/1/2" }],
  ["alias con comodines", { alias: "%", tipo: "url", valor: "https://a.com" }],
  ["duplicado normalizado", { alias: "You Tube", tipo: "url", valor: "https://youtube.com" }],
];
for (const [caso, alta] of ALTAS) {
  const r = await registrarTarget(sb, alta);
  console.log(`  ${r.ok ? "✗ PASÓ (mal)" : "✓ rechazada"}  ${caso.padEnd(26)} ${r.ok ? "" : r.motivo}`);
}

// El caso que sí es válido no se ejecuta acá para no ensuciar la tabla real.
// Lo que importa de él es la regla de seguridad, y es una línea de código:
console.log("\n  (un alta válida de tipo 'app' nace con aprobado = false; url/discord/carpeta en true)");

console.log("");
process.exit(fallos.length ? 1 : 0);
