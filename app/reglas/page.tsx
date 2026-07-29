"use client";

import { useEffect, useState } from "react";
import { db, fetchRules, fetchCategories, insertRule, deleteRule, toggleRule, type Rule, type Category } from "@/lib/db";
import { ars } from "@/lib/format";
import { PageHeader } from "../components/Shell";
import { Trash, Plus } from "../icons";

const OPS: { v: string; label: string }[] = [
  { v: "contains", label: "contiene" },
  { v: "starts", label: "empieza con" },
  { v: "equals", label: "es igual a" },
];
const DAYS = [{ n: 1, l: "Lun" }, { n: 2, l: "Mar" }, { n: 3, l: "Mié" }, { n: 4, l: "Jue" }, { n: 5, l: "Vie" }, { n: 6, l: "Sáb" }, { n: 7, l: "Dom" }];

function ruleSentence(r: Rule): string {
  const parts: string[] = [];
  if (r.textValue) parts.push(`la descripción ${OPS.find((o) => o.v === r.textOp)?.label ?? "contiene"} «${r.textValue}»`);
  if (r.hourFrom != null || r.hourTo != null) parts.push(`entre ${r.hourFrom ?? 0}h y ${r.hourTo ?? 23}h`);
  if (r.days && r.days.length) parts.push(r.days.map((d) => DAYS.find((x) => x.n === d)?.l).join(", "));
  if (r.amountMin != null && r.amountMax != null) parts.push(`monto entre ${ars(r.amountMin)} y ${ars(r.amountMax)}`);
  else if (r.amountMin != null) parts.push(`monto mayor a ${ars(r.amountMin)}`);
  else if (r.amountMax != null) parts.push(`monto menor a ${ars(r.amountMax)}`);
  return parts.length ? `Si ${parts.join(" · ")}` : "Para todo consumo";
}

// Las acciones de la regla, para mostrarlas en la lista.
function ruleActions(r: Rule): { icon: string; text: string; cls: string }[] {
  const out: { icon: string; text: string; cls: string }[] = [];
  if (r.categoryId != null) out.push({ icon: r.emoji ?? "🏷️", text: `categoría ${r.category ?? "—"}`, cls: "text-accent" });
  if (r.renameTo) out.push({ icon: "✏️", text: `renombrar a «${r.renameTo}»`, cls: "text-sky" });
  if (r.setCurrency) out.push({ icon: "💱", text: `moneda ${r.setCurrency}`, cls: "text-amber" });
  return out;
}

export default function ReglasPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => { const sb = db(); const [r, c] = await Promise.all([fetchRules(sb), fetchCategories(sb)]); setRules(r); setCats(c.filter((x) => x.kind === "egreso" || x.kind === "ambos")); };
  useEffect(() => { reload().finally(() => setLoading(false)); }, []);

  const remove = async (id: number) => { setRules((p) => p.filter((r) => r.id !== id)); await deleteRule(db(), id); };
  const toggle = async (r: Rule) => { setRules((p) => p.map((x) => (x.id === r.id ? { ...x, isActive: !x.isActive } : x))); await toggleRule(db(), r.id, !r.isActive); };

  return (
    <>
      <PageHeader title="Reglas" subtitle="Categorizá, renombrá y corregí consumos nuevos" />
      <p className="mt-3 flex items-start gap-2 text-xs text-faint">
        <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-surface-3 text-[0.6rem]">i</span>
        Las reglas se aplican a los consumos <b className="text-muted">nuevos</b> que entran por mail. Una regla puede cambiar la categoría, renombrar la descripción y/o forzar la moneda (todo combinable). Las condiciones se evalúan sobre la descripción <b className="text-muted">original</b> del banco. Si varias reglas matchean, <b className="text-muted">cada acción</b> la define la primera regla (por prioridad y antigüedad) que la tenga: una puede poner la categoría y otra distinta el nombre. Lo ya cargado no se toca.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <section className="panel divide-y divide-line p-2 sm:p-4">
            {loading ? (
              <p className="px-2 py-10 text-center text-sm text-muted">Cargando…</p>
            ) : rules.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-muted">Todavía no creaste reglas. Armá la primera a la derecha →</p>
            ) : (
              rules.map((r) => {
                const acts = ruleActions(r);
                return (
                  <div key={r.id} className={`flex items-center gap-3 px-2 py-3.5 ${r.isActive ? "" : "opacity-50"}`}>
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-lg">{acts[0]?.icon ?? "🏷️"}</span>
                    <div className="min-w-0">
                      <p className="truncate text-[0.95rem] text-fg">{ruleSentence(r)}</p>
                      <p className="truncate text-xs text-faint">
                        {acts.map((a, i) => (
                          <span key={i}>{i > 0 && " · "}→ <span className={a.cls}>{a.icon} {a.text}</span></span>
                        ))}
                      </p>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <button onClick={() => toggle(r)} title={r.isActive ? "Desactivar" : "Activar"} className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${r.isActive ? "border-emerald/30 bg-emerald/10 text-emerald" : "border-line bg-surface-2 text-muted"}`}>{r.isActive ? "Activa" : "Off"}</button>
                      <button onClick={() => remove(r.id)} title="Borrar" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:border-coral/40 hover:text-coral"><Trash className="h-4 w-4" /></button>
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>

        <NewRuleForm cats={cats} onSaved={reload} />
      </div>
    </>
  );
}

function NewRuleForm({ cats, onSaved }: { cats: Category[]; onSaved: () => Promise<void> }) {
  const [op, setOp] = useState("contains");
  const [value, setValue] = useState("");
  const [useHour, setUseHour] = useState(false);
  const [hourFrom, setHourFrom] = useState("11");
  const [hourTo, setHourTo] = useState("15");
  const [days, setDays] = useState<number[]>([]);
  const [useAmount, setUseAmount] = useState(false);
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [categoryId, setCategoryId] = useState<string>(""); // "" = no cambiar
  const [renameTo, setRenameTo] = useState("");
  const [setCurrency, setSetCurrency] = useState(""); // "" = no cambiar
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleDay = (n: number) => setDays((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  // Números al estilo argentino: "10.000" (miles) y "1500,50" (coma decimal).
  const parseMonto = (s: string): number => Number(s.trim().replace(/\./g, "").replace(",", "."));

  const save = async () => {
    setErr(null);
    const min = useAmount && amountMin.trim() !== "" ? parseMonto(amountMin) : null;
    const max = useAmount && amountMax.trim() !== "" ? parseMonto(amountMax) : null;
    const hf = useHour && hourFrom.trim() !== "" ? Number(hourFrom) : null;
    const ht = useHour && hourTo.trim() !== "" ? Number(hourTo) : null;
    if (useHour && hf == null && ht == null) { setErr("Completá el horario (al menos una de las dos horas)."); return; }
    if ((hf != null && (!Number.isInteger(hf) || hf < 0 || hf > 23)) || (ht != null && (!Number.isInteger(ht) || ht < 0 || ht > 23))) { setErr("Las horas deben ser números enteros entre 0 y 23."); return; }
    if (useAmount && min == null && max == null) { setErr("Completá al menos un límite de monto (mínimo o máximo)."); return; }
    if (min != null && Number.isNaN(min)) { setErr("El monto mínimo no es un número válido."); return; }
    if (max != null && Number.isNaN(max)) { setErr("El monto máximo no es un número válido."); return; }
    if (min != null && max != null && min > max) { setErr("El monto mínimo no puede superar al máximo."); return; }
    const hasCondition = !!value.trim() || hf != null || ht != null || days.length > 0 || min != null || max != null;
    const hasAction = !!categoryId || !!renameTo.trim() || !!setCurrency;
    if (!hasCondition) { setErr("Agregá al menos una condición (texto, horario, días o monto)."); return; }
    if (!hasAction) { setErr("Elegí al menos una acción (categoría, renombre o moneda)."); return; }
    setSaving(true); setOk(false);
    try {
      await insertRule(db(), {
        textOp: value.trim() ? op : null,
        textValue: value.trim() || null,
        hourFrom: hf,
        hourTo: ht,
        days: days.length ? days.sort((a, b) => a - b) : null,
        amountMin: min,
        amountMax: max,
        categoryId: categoryId ? Number(categoryId) : null,
        renameTo: renameTo.trim() || null,
        setCurrency: setCurrency || null,
      });
      await onSaved();
      setValue(""); setDays([]); setUseHour(false); setUseAmount(false); setAmountMin(""); setAmountMax("");
      setCategoryId(""); setRenameTo(""); setSetCurrency("");
      setOk(true);
      setTimeout(() => setOk(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  };

  return (
    <aside className="xl:sticky xl:top-6 xl:self-start">
      <section className="panel p-6">
        <h2 className="font-display text-lg text-fg">Nueva regla</h2>
        <p className="text-xs text-faint">Condición(es) → acción(es)</p>

        <div className="mt-4">
          <label className="text-xs text-muted">Si la descripción…</label>
          <div className="mt-1 flex gap-2">
            <select value={op} onChange={(e) => setOp(e.target.value)} className="appearance-none rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-accent/40">
              {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ej: DLO*PedidosYa" className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent/40" />
          </div>
        </div>

        <div className="mt-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={useHour} onChange={(e) => setUseHour(e.target.checked)} className="accent-accent" /> Solo en cierto horario
          </label>
          {useHour && (
            <div className="mt-2 flex items-center gap-2 text-sm">
              <span className="text-faint">de</span>
              <input value={hourFrom} onChange={(e) => setHourFrom(e.target.value)} inputMode="numeric" className="tnum w-14 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-center text-fg outline-none" />
              <span className="text-faint">a</span>
              <input value={hourTo} onChange={(e) => setHourTo(e.target.value)} inputMode="numeric" className="tnum w-14 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-center text-fg outline-none" />
              <span className="text-faint">hs</span>
            </div>
          )}
          {useHour && <p className="mt-1 text-[0.68rem] text-faint">Vale un rango que cruza medianoche (ej: 22 a 2). Podés dejar una vacía.</p>}
        </div>

        <div className="mt-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={useAmount} onChange={(e) => setUseAmount(e.target.checked)} className="accent-accent" /> Solo por monto
          </label>
          {useAmount && (
            <div className="mt-2 flex items-center gap-2 text-sm">
              <span className="text-faint">de $</span>
              <input value={amountMin} onChange={(e) => setAmountMin(e.target.value)} inputMode="decimal" placeholder="mín" className="tnum w-24 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-center text-fg outline-none placeholder:text-faint" />
              <span className="text-faint">a $</span>
              <input value={amountMax} onChange={(e) => setAmountMax(e.target.value)} inputMode="decimal" placeholder="máx" className="tnum w-24 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-center text-fg outline-none placeholder:text-faint" />
            </div>
          )}
          {useAmount && <p className="mt-1 text-[0.68rem] text-faint">Podés dejar uno vacío (solo mínimo o solo máximo). En la moneda original del consumo. Punto = miles, coma = decimales (10.000 son diez mil).</p>}
        </div>

        <div className="mt-4">
          <label className="text-xs text-muted">Solo ciertos días <span className="text-faint">(opcional)</span></label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DAYS.map((d) => (
              <button key={d.n} onClick={() => toggleDay(d.n)} className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${days.includes(d.n) ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-surface-2 text-muted hover:text-fg"}`}>{d.l}</button>
            ))}
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-xs font-medium text-muted">Acciones <span className="font-normal text-faint">(al menos una)</span></p>

          <div className="mt-3">
            <label className="text-xs text-muted">→ Categoría</label>
            <div className="relative mt-1">
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full appearance-none rounded-xl border border-line bg-surface-2 py-2.5 pl-3 pr-9 text-sm text-fg outline-none focus:border-accent/40">
                <option value="">— no cambiar —</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint">▾</span>
            </div>
          </div>

          <div className="mt-3">
            <label className="text-xs text-muted">→ Renombrar a <span className="text-faint">(opcional)</span></label>
            <input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder="Ej: PedidosYa" className="mt-1 w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-sky/40" />
          </div>

          <div className="mt-3">
            <label className="text-xs text-muted">→ Forzar moneda <span className="text-faint">(para suscripciones en USD que la alerta reporta en pesos: convierte el monto a la cotización)</span></label>
            <div className="relative mt-1">
              <select value={setCurrency} onChange={(e) => setSetCurrency(e.target.value)} className="w-full appearance-none rounded-xl border border-line bg-surface-2 py-2.5 pl-3 pr-9 text-sm text-fg outline-none focus:border-amber/40">
                <option value="">— no cambiar —</option>
                <option value="USD">USD</option>
                <option value="ARS">ARS</option>
              </select>
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint">▾</span>
            </div>
          </div>
        </div>

        <button onClick={save} disabled={saving} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">
          <Plus className="h-4 w-4" /> {saving ? "Guardando…" : "Crear regla"}
        </button>
        {ok && <p className="mt-3 rounded-lg border border-emerald/30 bg-emerald/10 px-3 py-2 text-center text-xs text-emerald">✓ Regla creada</p>}
        {err && <p className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-center text-xs text-coral">{err}</p>}
      </section>
    </aside>
  );
}
