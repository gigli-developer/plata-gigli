-- Migración 037 · origen "cowork" en los movimientos (2026-11-14)
--
-- Problema: lo que carga Claude Cowork por el conector de Supabase quedaba como
-- 'chat' (igual que el asistente de la app y el agente de la isla) o, en los cobros
-- de deuda, como 'manual'. No había forma de auditar qué cargó cada canal.
--
-- Solución: valor nuevo 'cowork' en tx_source y una función origen_actual(defecto)
-- que lo detecta sola. El conector de Supabase (Cowork, Claude Code) corre SQL directo
-- contra Postgres, sin pasar por PostgREST, así que no hay request.jwt.claims.
-- La app y los agentes con sesión SIEMPRE pasan por PostgREST, que setea los claims
-- (incluso para anon y service_role). Sin claims => 'cowork'; con claims => el de antes.
--
-- Se corre en DOS llamadas separadas: un valor nuevo de enum no se puede usar en la
-- misma transacción que lo crea, y el MCP corre cada llamada en una sola transacción.
-- Rollback: select definicion from rollback_funciones where migracion = '037';

-- ── Paso 1 (llamada aparte) ─────────────────────────────────────────────────────
alter type public.tx_source add value if not exists 'cowork';

-- ── Paso 2 ──────────────────────────────────────────────────────────────────────
create or replace function public.origen_actual(p_defecto public.tx_source)
returns public.tx_source
language sql
stable
set search_path to 'public'
as $$
  select case
    when coalesce(current_setting('request.jwt.claims', true), '') = '' then 'cowork'::public.tx_source
    else p_defecto
  end
$$;
comment on function public.origen_actual(public.tx_source) is
  'Origen de un movimiento según quién llama: SQL directo sin JWT (conector de Supabase: Cowork / Claude Code) => cowork; por PostgREST (app, agentes) => p_defecto. Migración 037.';

-- Reemplaza el literal del origen en las funciones que escriben transactions.
-- Si un patrón no aparece exactamente las veces esperadas, aborta todo (la función
-- cambió desde que se escribió esto: revisarla a mano).
do $mig$
declare
  r record;
  v_def text;
  v_new text;
  v_hits int;
begin
  for r in
    select * from (values
      ('registrar_movimiento', $p$v_fecha, 'chat')$p$,        $p$v_fecha, public.origen_actual('chat'))$p$,         1),
      ('registrar_ajuste',     $p$now(), 'chat')$p$,          $p$now(), public.origen_actual('chat'))$p$,           1),
      ('pagar_deuda',          $p$true, 'manual', v_fecha)$p$, $p$true, public.origen_actual('chat'), v_fecha)$p$, 1),
      ('dividir_gasto_v2',     $p$true, 'chat')$p$,           $p$true, public.origen_actual('chat'))$p$,            2),
      ('register_exchange',    $p$'manual', v_ex_id, v_cuando)$p$, $p$public.origen_actual('manual'), v_ex_id, v_cuando)$p$, 2)
    ) as t(fn, viejo, nuevo, esperado)
  loop
    select pg_get_functiondef(p.oid) into strict v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = r.fn;

    v_hits := (length(v_def) - length(replace(v_def, r.viejo, ''))) / length(r.viejo);
    if v_hits <> r.esperado then
      raise exception 'Migración 037: % tiene % apariciones de «%» (esperaba %)', r.fn, v_hits, r.viejo, r.esperado;
    end if;

    insert into public.rollback_funciones (migracion, funcion, definicion) values ('037', r.fn, v_def);
    v_new := replace(v_def, r.viejo, r.nuevo);
    execute v_new;
  end loop;
end
$mig$;

-- Backfill: lo que Cowork cargó el 11/11 (kiosco + cobro a Branko repartido en 3).
update public.transactions set source = 'cowork' where id in (1223, 1224, 1225, 1226);
