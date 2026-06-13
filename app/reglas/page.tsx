"use client";

import { useEffect, useState } from "react";
import { db, fetchRules, fetchCategories, insertRule, deleteRule, toggleRule, type Rule, type Category } from "@/lib/db";
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
  return parts.length ? `Si ${parts.join(" · ")}` : "Para todo consumo";
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
      <PageHeader title="Reglas" subtitle="Auto-categorización de consumos nuevos" />
      <p className="mt-3 flex items-start gap-2 text-xs text-faint">
        <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-surface-3 text-[0.6rem]">i</span>
        Las reglas se aplican a los consumos <b className="text-muted">nuevos</b> que entran por mail. Si un consumo matchea una regla, se le asigna esa categoría (gana la de mayor prioridad). Lo ya cargado no se toca.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <section className="panel divide-y divide-line p-2 sm:p-4">
            {loading ? (
              <p className="px-2 py-10 text-center text-sm text-muted">Cargando…</p>
            ) : rules.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-muted">Todavía no creaste reglas. Armá la primera a la derecha →</p>
            ) : (
              rules.map((r) => (
                <div key={r.id} className={`flex items-center gap-3 px-2 py-3.5 ${r.isActive ? "" : "opacity-50"}`}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 text-lg">{r.emoji ?? "🏷️"}</span>
                  <div className="min-w-0">
                    <p className="truncate text-[0.95rem] text-fg">{ruleSentence(r)}</p>
                    <p className="text-xs text-faint">→ categoría <span className="text-lime">{r.emoji} {r.category}</span></p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button onClick={() => toggle(r)} title={r.isActive ? "Desactivar" : "Activar"} className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${r.isActive ? "border-emerald/30 bg-emerald/10 text-emerald" : "border-line bg-surface-2 text-muted"}`}>{r.isActive ? "Activa" : "Off"}</button>
                    <button onClick={() => remove(r.id)} title="Borrar" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:border-coral/40 hover:text-coral"><Trash className="h-4 w-4" /></button>
                  </div>
                </div>
              ))
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
  const [categoryId, setCategoryId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => { if (cats.length && !categoryId) setCategoryId(String(cats[0].id)); }, [cats]);

  const toggleDay = (n: number) => setDays((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]));

  const save = async () => {
    if (!value.trim() && !useHour && days.length === 0) return; // al menos una condición
    if (!categoryId) return;
    setSaving(true); setOk(false);
    try {
      await insertRule(db(), {
        textOp: value.trim() ? op : null,
        textValue: value.trim() || null,
        hourFrom: useHour ? Number(hourFrom) : null,
        hourTo: useHour ? Number(hourTo) : null,
        days: days.length ? days.sort((a, b) => a - b) : null,
        categoryId: Number(categoryId),
      });
      await onSaved();
      setValue(""); setDays([]); setUseHour(false); setOk(true);
      setTimeout(() => setOk(false), 2500);
    } finally { setSaving(false); }
  };

  return (
    <aside className="xl:sticky xl:top-6 xl:self-start">
      <section className="panel p-6">
        <h2 className="font-display text-lg text-fg">Nueva regla</h2>
        <p className="text-xs text-faint">Condición(es) → categoría</p>

        <div className="mt-4">
          <label className="text-xs text-muted">Si la descripción…</label>
          <div className="mt-1 flex gap-2">
            <select value={op} onChange={(e) => setOp(e.target.value)} className="appearance-none rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-lime/40">
              {OPS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ej: DELIOFFICE" className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-lime/40" />
          </div>
        </div>

        <div className="mt-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={useHour} onChange={(e) => setUseHour(e.target.checked)} className="accent-lime" /> Solo en cierto horario
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
        </div>

        <div className="mt-4">
          <label className="text-xs text-muted">Solo ciertos días <span className="text-faint">(opcional)</span></label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DAYS.map((d) => (
              <button key={d.n} onClick={() => toggleDay(d.n)} className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${days.includes(d.n) ? "border-lime/40 bg-lime/10 text-lime" : "border-line bg-surface-2 text-muted hover:text-fg"}`}>{d.l}</button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <label className="text-xs text-muted">→ Categoría</label>
          <div className="relative mt-1">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full appearance-none rounded-xl border border-line bg-surface-2 py-2.5 pl-3 pr-9 text-sm text-fg outline-none focus:border-lime/40">
              {cats.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </select>
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint">▾</span>
          </div>
        </div>

        <button onClick={save} disabled={saving} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-lime py-3 text-sm font-medium text-bg transition-transform hover:scale-[1.02] disabled:opacity-60">
          <Plus className="h-4 w-4" /> {saving ? "Guardando…" : "Crear regla"}
        </button>
        {ok && <p className="mt-3 rounded-lg border border-emerald/30 bg-emerald/10 px-3 py-2 text-center text-xs text-emerald">✓ Regla creada</p>}
      </section>
    </aside>
  );
}
