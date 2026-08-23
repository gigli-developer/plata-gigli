/**
 * Batería del ciclo de estados de `tareas_codigo` contra PRODUCCIÓN.
 *
 * ⚠️⚠️ REGLA ABSOLUTA: solo toca datos de prueba. Todo lo que crea lo borra al
 * terminar (y si algo falla a mitad de camino, el finally borra igual). Los ids
 * de prueba llevan el prefijo "zz" — el alfabeto de los ids reales no genera
 * nada parecido con 4 letras... y aunque lo hiciera, acá se insertan y borran
 * por id exacto.
 *
 * Prueba las cuatro órdenes de /api/codigo (reclamar, latido, soltar, terminar),
 * la atomicidad del reclamo (el segundo pierde), el rescate de zombis vía
 * `tarea_codigo_lanzar`, y que `tareas_codigo_ver` diga «colgada» cuando el
 * latido venció.
 *
 * Correrla con el servidor NUEVO deployado y la migración 2026-08-23 corrida:
 *
 *   node scripts/probar-codigo-ciclo.mjs
 *
 * Ojo: usa /api/tool para las dos herramientas del modelo, y eso avanza el
 * contador de turnos del servidor. No correrla mientras Lucas está a mitad de
 * una conversación por voz con una propuesta sin confirmar.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

// La URL del proyecto es pública (está en el CLAUDE.md); la clave no, y sale del .env.local.
const SUPABASE_URL = "https://dsocdpxlvcufitvovydr.supabase.co";
const BASE = "https://plata-production.up.railway.app";

const sb = createClient(SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: secretos, error: errSecreto } = await sb
  .from("app_secrets").select("value").eq("key", "PC_CHANNEL_SECRET").single();
if (errSecreto || !secretos?.value) {
  console.error("No pude leer PC_CHANNEL_SECRET de app_secrets:", errSecreto?.message);
  process.exit(1);
}
const CAB = { "x-pc-secret": secretos.value, "content-type": "application/json" };

async function codigo(cuerpo) {
  const r = await fetch(`${BASE}/api/codigo`, {
    method: "POST", headers: CAB, body: JSON.stringify(cuerpo),
  });
  return r.json();
}

async function tool(nombre, input) {
  const r = await fetch(`${BASE}/api/tool`, {
    method: "POST", headers: CAB, body: JSON.stringify({ nombre, input }),
  });
  return r.json();
}

async function fila(id) {
  const { data } = await sb.from("tareas_codigo")
    .select("id,estado,exito,resumen,costo_usd,session_id,ultimo_latido").eq("id", id);
  return data?.[0] ?? null;
}

// ── el arnés ────────────────────────────────────────────────────────────────

let pasan = 0, fallan = 0;
function caso(nombre, condicion, detalle = "") {
  if (condicion) { pasan++; console.log(`  ✓ ${nombre}`); }
  else { fallan++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ""}`); }
}

const IDS = ["zzc1", "zzc2", "zzc3"];
const userId = (await sb.from("transactions").select("user_id").limit(1).single()).data.user_id;

async function crearTarea(id) {
  const { error } = await sb.from("tareas_codigo").insert({
    id, repo: "finanzas-app", archivos: [],
    prompt: "TAREA DE PRUEBA del ciclo de estados. No ejecutar.",
    estado: "lista", user_id: userId,
  });
  if (error) throw new Error(`no pude crear ${id}: ${error.message}`);
}

try {
  // Limpieza previa por si una corrida anterior murió a mitad de camino.
  await sb.from("tareas_codigo").delete().in("id", IDS);

  console.log("\n— reclamar / latido / terminar —");
  await crearTarea("zzc1");

  let r = await codigo({ orden: "reclamar", tarea_id: "zzc1" });
  caso("reclamar lista→ejecutando", r.ok === true && r.tarea?.estado === "ejecutando", JSON.stringify(r));

  r = await codigo({ orden: "reclamar", tarea_id: "zzc1" });
  caso("el segundo reclamo PIERDE", r.ok === false && /ejecutando/.test(r.motivo ?? ""), JSON.stringify(r));

  r = await codigo({ orden: "latido", tarea_id: "zzc1" });
  caso("latido en ejecutando", r.ok === true, JSON.stringify(r));

  r = await codigo({
    orden: "terminar", tarea_id: "zzc1", exito: true,
    resumen: "Prueba: terminó bien.", costo_usd: 0.07, session_id: "prueba-ciclo-1",
  });
  caso("terminar ejecutando→hecha", r.ok === true && r.tarea?.estado === "hecha", JSON.stringify(r));

  let f = await fila("zzc1");
  caso("la fila quedó hecha + exito + resumen + costo + session_id",
    f?.estado === "hecha" && f?.exito === true && f?.resumen === "Prueba: terminó bien." &&
    Number(f?.costo_usd) === 0.07 && f?.session_id === "prueba-ciclo-1", JSON.stringify(f));

  r = await codigo({ orden: "latido", tarea_id: "zzc1" });
  caso("latido después de hecha dice QUE NO", r.ok === false && /hecha/.test(r.motivo ?? ""), JSON.stringify(r));

  r = await codigo({ orden: "reclamar", tarea_id: "zzzz" });
  caso("reclamar un id inexistente lo dice", r.ok === false && /no existe/.test(r.motivo ?? ""), JSON.stringify(r));

  console.log("\n— soltar —");
  await crearTarea("zzc2");
  await codigo({ orden: "reclamar", tarea_id: "zzc2" });
  r = await codigo({ orden: "soltar", tarea_id: "zzc2" });
  f = await fila("zzc2");
  caso("soltar vuelve a lista y borra el latido",
    r.ok === true && f?.estado === "lista" && f?.ultimo_latido === null, JSON.stringify({ r, f }));
  r = await codigo({ orden: "reclamar", tarea_id: "zzc2" });
  caso("una tarea soltada se puede volver a reclamar", r.ok === true, JSON.stringify(r));
  await codigo({
    orden: "terminar", tarea_id: "zzc2", exito: false, resumen: "Prueba: falló a propósito.",
  });
  f = await fila("zzc2");
  caso("terminar con exito=false queda hecha + exito false",
    f?.estado === "hecha" && f?.exito === false, JSON.stringify(f));

  console.log("\n— zombis —");
  await crearTarea("zzc3");
  await codigo({ orden: "reclamar", tarea_id: "zzc3" });
  // La PC "muere": el latido queda 11 minutos en el pasado.
  await sb.from("tareas_codigo")
    .update({ ultimo_latido: new Date(Date.now() - 11 * 60 * 1000).toISOString() })
    .eq("id", "zzc3");

  r = await tool("tareas_codigo_ver", { estado: "ejecutando" });
  const vista = (r.resultado?.tareas ?? []).find((t) => t.id === "zzc3");
  caso("tareas_codigo_ver la marca colgada", vista?.colgada === true, JSON.stringify(vista));

  r = await tool("tarea_codigo_lanzar", { tarea_id: "zzc3" });
  caso("tarea_codigo_lanzar resucita al zombi (reenvio + acción)",
    r.resultado?.ok === true && r.resultado?.reenvio === true && !!r.resultado?.accion,
    JSON.stringify(r.resultado));
  f = await fila("zzc3");
  caso("el zombi volvió a lista sin latido", f?.estado === "lista" && f?.ultimo_latido === null,
    JSON.stringify(f));

  // Y un ejecutando SANO (latido fresco) no se deja relanzar:
  await codigo({ orden: "reclamar", tarea_id: "zzc3" });
  r = await tool("tarea_codigo_lanzar", { tarea_id: "zzc3" });
  caso("un ejecutando con latido fresco NO se relanza",
    r.resultado?.ok === false && /corriendo/.test(r.resultado?.motivo ?? ""),
    JSON.stringify(r.resultado));

  console.log("\n— hecha y el matiz del fallo —");
  r = await tool("tarea_codigo_lanzar", { tarea_id: "zzc2" });
  caso("lanzar una hecha-que-falló lo cuenta con el motivo",
    r.resultado?.ok === false && /FALLÓ/.test(r.resultado?.motivo ?? ""),
    JSON.stringify(r.resultado));
  r = await tool("tareas_codigo_ver", { estado: "hecha" });
  const hechas = (r.resultado?.tareas ?? []).filter((t) => IDS.includes(t.id));
  caso("ver estado=hecha trae exito y resumen",
    hechas.some((t) => t.id === "zzc1" && t.exito === true && /terminó bien/.test(t.resumen ?? "")),
    JSON.stringify(hechas));
} catch (e) {
  fallan++;
  console.error("EXPLOTÓ:", e);
} finally {
  const { error } = await sb.from("tareas_codigo").delete().in("id", IDS);
  const { data: quedan } = await sb.from("tareas_codigo").select("id").in("id", IDS);
  console.log(`\nLimpieza: ${error ? "FALLÓ: " + error.message : "ok"} · quedan: ${quedan?.length ?? "?"}`);
  if (quedan?.length) console.error("⚠️ QUEDARON FILAS DE PRUEBA — borralas a mano:", quedan);
}

console.log(`\n${pasan} pasan · ${fallan} fallan`);
process.exit(fallan ? 1 : 0);
