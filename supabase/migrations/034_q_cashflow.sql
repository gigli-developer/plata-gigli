-- 034 · Capa de consulta (q_) — Cash Flow (proyección a 6 meses o histórico,
-- base caja o devengado). Espejo de app/cashflow/page.tsx, con dos cambios
-- acordados el 2026-11-08: mes argentino, y la preferencia "¿este ingreso se
-- ajusta por inflación?" pasa de localStorage a cashflow_config.infl_ingresos.
-- ⚠️ No es la vieja flujo_de_caja(): esa no tiene presupuestos, inflación, pago
-- de tarjeta ni planes manuales, y da otros números que la pantalla.

alter table public.cashflow_config
  add column if not exists infl_ingresos jsonb not null default '{}'::jsonb;
comment on column public.cashflow_config.infl_ingresos is
'Por categoría de ingreso: ¿se ajusta por inflación en la proyección del Cash Flow? {"Sueldo": true, ...}. Si falta, Sueldo = sí y el resto = no.';

insert into public.rollback_funciones (migracion, funcion, definicion)
select '034', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('q__suma', 'q_cashflow');

create or replace function public.q__suma(p_map jsonb, p_k text, p_v numeric) returns jsonb
language sql immutable set search_path = public as
$$ select jsonb_set(coalesce(p_map, '{}'::jsonb), array[p_k], to_jsonb(coalesce((p_map->>p_k)::numeric, 0) + coalesce(p_v, 0))) $$;

create or replace function public.q_cashflow(
  p_modo text default 'proyeccion', p_base text default 'caja', p_desde text default null,
  p_inflacion numeric default null, p_usd numeric default null, p_usdt numeric default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_cur text := public.q__mes(now());
  v_m jsonb := public.get_metrics();
  v_usd numeric := coalesce(p_usd, (public.get_metrics()->>'usd_ars')::numeric);
  v_usdt numeric := coalesce(p_usdt, (public.get_metrics()->>'usdt_ars')::numeric);
  v_bd_desde timestamptz := public.q__inicio_mes(public.q__mes_suma(public.q__mes(now()), -14));
  v_infl numeric; v_cfg jsonb; v_ini text; v_completos text[]; v_n int;
  v_seed jsonb; v_seed_cash jsonb; v_credit numeric; v_seed_ars jsonb; v_seed_cash_ars jsonb; v_credit_ars numeric;
  v_budgets jsonb; v_bud jsonb; v_bud_cash jsonb; v_bud_ars_tot numeric; v_bud_cash_ars_tot numeric;
  v_inc_all jsonb := '[]'::jsonb; v_egr_all jsonb := '[]'::jsonb; v_neto_ars numeric[] := '{}'; v_meses jsonb := '[]'::jsonb;
  v_mm text; v_fut boolean; v_f numeric; v_inc jsonb; v_egr jsonb; v_ia numeric; v_ea numeric;
  v_pago numeric; v_pago_ars numeric; v_prev text; v_fprev numeric; v_cuo numeric;
  v_emoji jsonb; v_rows_inc jsonb; v_rows_egr jsonb; v_tot_inc numeric[]; v_tot_egr numeric[];
  v_neto jsonb := '[]'::jsonb; v_acum jsonb := '[]'::jsonb; v_pesos jsonb := '[]'::jsonb;
  v_ini_saldo numeric; v_acc numeric; v_acc_ars numeric; r record; i int;
begin
  if coalesce(p_modo, '') not in ('proyeccion', 'historico') then raise exception 'p_modo: proyeccion o historico'; end if;
  if coalesce(p_base, '') not in ('caja', 'devengado') then raise exception 'p_base: caja o devengado'; end if;

  v_infl := coalesce(p_inflacion, (select round(avg(rate), 2) from (select rate from public.inflation_monthly order by month desc limit 6) x), 0);
  v_cfg := coalesce((select infl_ingresos from public.cashflow_config limit 1), '{}'::jsonb);
  v_ini := case when p_modo = 'proyeccion' then v_cur else coalesce(p_desde, public.q__mes_suma(v_cur, -6)) end;

  -- Base de los promedios: los últimos 3 meses CERRADOS con movimientos.
  select coalesce(array_agg(mes order by mes), '{}') into v_completos
    from (select distinct mes from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt) where es_flujo and mes < v_cur order by mes desc limit 3) x;
  v_n := greatest((select count(distinct mes) from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt)
                   where es_flujo and tipo = 'egreso' and mes = any(v_completos)), 1);

  select coalesce(jsonb_object_agg(categoria, s), '{}'::jsonb), coalesce(jsonb_object_agg(categoria, sc) filter (where sc is not null), '{}'::jsonb)
    into v_seed, v_seed_cash
    from (select categoria, sum(ars) s, sum(ars) filter (where not es_credito) sc
          from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt)
          where es_flujo and tipo = 'egreso' and mes = any(v_completos) group by categoria) x;
  select coalesce(sum(ars) filter (where es_credito), 0),
         coalesce(sum(monto) filter (where es_credito and moneda = 'ARS'), 0)
    into v_credit, v_credit_ars
    from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt) where es_flujo and tipo = 'egreso' and mes = any(v_completos);
  select coalesce(jsonb_object_agg(categoria, s), '{}'::jsonb), coalesce(jsonb_object_agg(categoria, sc) filter (where sc is not null), '{}'::jsonb)
    into v_seed_ars, v_seed_cash_ars
    from (select categoria, sum(monto) s, sum(monto) filter (where not es_credito) sc
          from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt)
          where es_flujo and tipo = 'egreso' and mes = any(v_completos) and moneda = 'ARS' group by categoria) x;

  -- Presupuesto por categoría = promedio de los 3 meses, pisado por lo que editaste (cashflow_budgets).
  v_budgets := coalesce((select jsonb_object_agg(category, monthly_amount) from public.cashflow_budgets), '{}'::jsonb);
  v_bud := coalesce((select jsonb_object_agg(key, value::numeric / v_n) from jsonb_each_text(v_seed)), '{}'::jsonb) || v_budgets;
  v_bud_cash := coalesce((select jsonb_object_agg(key, value::numeric / v_n) from jsonb_each_text(v_seed_cash)), '{}'::jsonb) || v_budgets;
  v_bud_ars_tot := coalesce((select sum(value::numeric) from jsonb_each_text(
      coalesce((select jsonb_object_agg(key, value::numeric / v_n) from jsonb_each_text(v_seed_ars)), '{}'::jsonb) || v_budgets)), 0);
  v_bud_cash_ars_tot := coalesce((select sum(value::numeric) from jsonb_each_text(
      coalesce((select jsonb_object_agg(key, value::numeric / v_n) from jsonb_each_text(v_seed_cash_ars)), '{}'::jsonb) || v_budgets)), 0);

  for i in 0 .. 5 loop
    v_mm := public.q__mes_suma(v_ini, i);
    v_fut := v_mm > v_cur;
    v_f := power(1 + v_infl / 100, greatest(public.q__meses_entre(v_cur, v_mm), 0));
    v_inc := '{}'::jsonb; v_egr := '{}'::jsonb; v_ia := 0; v_ea := 0;
    v_meses := v_meses || jsonb_build_object('mes', v_mm, 'futuro', v_fut);

    -- INGRESOS: pasado/actual = real; futuro = recurrentes (con inflación si corresponde).
    if v_fut then
      for r in select coalesce(c.name, 'Otros') cat, rt.base_amount amt
               from public.recurring_templates rt left join public.categories c on c.id = rt.category_id
               where rt.is_active and rt.type = 'ingreso' loop
        v_cuo := case when coalesce((v_cfg->>r.cat)::boolean, r.cat = 'Sueldo') then r.amt * v_f else r.amt end;
        v_inc := public.q__suma(v_inc, r.cat, v_cuo); v_ia := v_ia + v_cuo;
      end loop;
    else
      for r in select categoria cat, sum(ars) s, coalesce(sum(monto) filter (where moneda = 'ARS'), 0) sa
               from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt)
               where es_flujo and tipo = 'ingreso' and mes = v_mm group by categoria loop
        v_inc := public.q__suma(v_inc, r.cat, r.s); v_ia := v_ia + r.sa;
      end loop;
    end if;

    -- EGRESOS
    if p_base = 'devengado' then
      for r in select categoria cat, sum(cuota_ars) s from public.q__cuotas_meses(v_mm, v_mm) group by categoria loop
        v_egr := public.q__suma(v_egr, r.cat, r.s); v_ea := v_ea + r.s;
      end loop;
      if v_fut then
        for r in select key cat, value::numeric v from jsonb_each_text(v_bud) loop
          v_egr := public.q__suma(v_egr, r.cat, r.v * v_f);
        end loop;
        v_ea := v_ea + v_bud_ars_tot * v_f;
      else
        for r in select categoria cat, sum(ars) s, coalesce(sum(monto) filter (where moneda = 'ARS'), 0) sa
                 from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt)
                 where es_flujo and tipo = 'egreso' and mes = v_mm group by categoria loop
          v_egr := public.q__suma(v_egr, r.cat, r.s); v_ea := v_ea + r.sa;
        end loop;
      end if;
    else
      if v_fut then
        for r in select key cat, value::numeric v from jsonb_each_text(v_bud_cash) loop
          v_egr := public.q__suma(v_egr, r.cat, r.v * v_f);
        end loop;
        v_ea := v_ea + v_bud_cash_ars_tot * v_f;
      else
        for r in select categoria cat, sum(ars) s, coalesce(sum(monto) filter (where moneda = 'ARS'), 0) sa
                 from public.q__tx(v_bd_desde, 'infinity', v_usd, v_usdt)
                 where es_flujo and tipo = 'egreso' and not es_credito and mes = v_mm group by categoria loop
          v_egr := public.q__suma(v_egr, r.cat, r.s); v_ea := v_ea + r.sa;
        end loop;
      end if;
      -- Pago de tarjeta: los resúmenes que VENCEN en el mes (reales) o, si no hay, un estimado.
      if exists (select 1 from public.card_statements cs where to_char(cs.due_date, 'YYYY-MM') = v_mm) then
        select coalesce(sum(case when s.pagado then s.total_ars + s.total_usd * coalesce(s.fx_pago, v_usd)
                                 else s.total_ars + s.total_usd * v_usd end), 0),
               coalesce(sum(s.total_ars), 0)
          into v_pago, v_pago_ars
          from public.q__resumenes() s where to_char(s.vence, 'YYYY-MM') = v_mm;
      else
        v_prev := public.q__mes_suma(v_mm, -1);
        v_fprev := power(1 + v_infl / 100, greatest(public.q__meses_entre(v_cur, v_prev), 0));
        v_cuo := coalesce((select sum(cuota_ars) from public.q__cuotas_meses(v_prev, v_prev)), 0);
        v_pago := v_credit / v_n * v_fprev + v_cuo;
        v_pago_ars := v_credit_ars / v_n * v_fprev + v_cuo;
      end if;
      if v_pago > 0 then v_egr := public.q__suma(v_egr, 'Pago de tarjeta', v_pago); end if;
      v_ea := v_ea + v_pago_ars;
    end if;

    -- Planificación manual (puntual o en cuotas).
    for r in select type, concept, amount from public.cashflow_plans
             where public.q__meses_entre(start_month, v_mm) between 0 and months_count - 1 loop
      if r.type = 'ingreso' then v_inc := public.q__suma(v_inc, r.concept, r.amount); v_ia := v_ia + r.amount;
      else v_egr := public.q__suma(v_egr, r.concept, r.amount); v_ea := v_ea + r.amount; end if;
    end loop;

    v_inc_all := v_inc_all || jsonb_build_array(v_inc);
    v_egr_all := v_egr_all || jsonb_build_array(v_egr);
    v_neto_ars := v_neto_ars || (v_ia - v_ea);
  end loop;

  -- Emoji de cada fila.
  v_emoji := coalesce((select jsonb_object_agg(concept, '📌'::text) from public.cashflow_plans), '{}'::jsonb)
          || coalesce((select jsonb_object_agg(coalesce(c.name, 'Otros'), coalesce(c.emoji, '🔁')) from public.recurring_templates rt left join public.categories c on c.id = rt.category_id where rt.is_active), '{}'::jsonb)
          || coalesce((select jsonb_object_agg(coalesce(c.name, 'Cuotas'), coalesce(c.emoji, '💳')) from public.installment_plans ip left join public.categories c on c.id = ip.category_id), '{}'::jsonb)
          || coalesce((select jsonb_object_agg(coalesce(c.name, 'Otros'), coalesce(c.emoji, '✨')) from public.categories c), '{}'::jsonb)
          || jsonb_build_object('Pago de tarjeta', '💳');

  -- Filas: una por concepto, con los 6 valores; fuera las que nunca son > 0; de mayor a menor.
  select coalesce(jsonb_agg(jsonb_build_object('concepto', k, 'emoji', coalesce(v_emoji->>k, '•'), 'valores', vals) order by tot desc), '[]'::jsonb)
    into v_rows_inc
    from (select e.k, jsonb_agg(coalesce((m.obj->>e.k)::numeric, 0) order by m.ord) vals,
                 sum(coalesce((m.obj->>e.k)::numeric, 0)) tot, bool_or(coalesce((m.obj->>e.k)::numeric, 0) > 0) pos
          from jsonb_array_elements(v_inc_all) with ordinality m(obj, ord)
          cross join (select distinct jsonb_object_keys(o.v) k from jsonb_array_elements(v_inc_all) o(v)) e
          group by e.k) x where pos;
  select coalesce(jsonb_agg(jsonb_build_object('concepto', k, 'emoji', coalesce(v_emoji->>k, '•'), 'valores', vals) order by tot desc), '[]'::jsonb)
    into v_rows_egr
    from (select e.k, jsonb_agg(coalesce((m.obj->>e.k)::numeric, 0) order by m.ord) vals,
                 sum(coalesce((m.obj->>e.k)::numeric, 0)) tot, bool_or(coalesce((m.obj->>e.k)::numeric, 0) > 0) pos
          from jsonb_array_elements(v_egr_all) with ordinality m(obj, ord)
          cross join (select distinct jsonb_object_keys(o.v) k from jsonb_array_elements(v_egr_all) o(v)) e
          group by e.k) x where pos;

  select array_agg(coalesce(t, 0) order by g) into v_tot_inc
    from generate_series(0, 5) g left join (select g2, sum((rr->'valores'->>g2)::numeric) t
      from jsonb_array_elements(v_rows_inc) rr cross join generate_series(0, 5) g2 group by g2) s on s.g2 = g;
  select array_agg(coalesce(t, 0) order by g) into v_tot_egr
    from generate_series(0, 5) g left join (select g2, sum((rr->'valores'->>g2)::numeric) t
      from jsonb_array_elements(v_rows_egr) rr cross join generate_series(0, 5) g2 group by g2) s on s.g2 = g;

  -- Acumulados. En proyección el mes en curso ya está en el saldo de hoy: no se vuelve a sumar.
  v_ini_saldo := case when p_modo = 'proyeccion'
    then (v_m->>'ars_liquido')::numeric + (v_m->>'usd_liquido')::numeric * v_usd + (v_m->>'usdt_liquido')::numeric * v_usdt else 0 end;
  v_acc := v_ini_saldo; v_acc_ars := (v_m->>'ars_liquido')::numeric;
  for i in 1 .. 6 loop
    v_neto := v_neto || to_jsonb(v_tot_inc[i] - v_tot_egr[i]);
    if p_modo = 'proyeccion' and i = 1 then
      v_acum := v_acum || to_jsonb(v_ini_saldo);
      v_pesos := v_pesos || to_jsonb((v_m->>'ars_liquido')::numeric);
    else
      v_acc := v_acc + (v_tot_inc[i] - v_tot_egr[i]); v_acum := v_acum || to_jsonb(v_acc);
      v_acc_ars := v_acc_ars + v_neto_ars[i]; v_pesos := v_pesos || to_jsonb(v_acc_ars);
    end if;
  end loop;

  return jsonb_build_object(
    'modo', p_modo, 'base', p_base, 'meses', v_meses,
    'ingresos', v_rows_inc, 'egresos', v_rows_egr,
    'total_ingresos', to_jsonb(v_tot_inc), 'total_egresos', to_jsonb(v_tot_egr), 'neto', v_neto,
    'saldo_inicial', v_ini_saldo, 'saldo_acumulado', v_acum, 'pesos_acumulado', v_pesos,
    'inflacion_mensual', v_infl, 'cotizaciones', jsonb_build_object('usd', v_usd, 'usdt', v_usdt),
    'meses_base', coalesce(array_length(v_completos, 1), 0), 'meses_base_lista', to_jsonb(v_completos),
    'presupuestos', coalesce((select jsonb_agg(jsonb_build_object(
        'categoria', key, 'promedio', coalesce((v_seed->>key)::numeric / v_n, 0), 'presupuesto', value::numeric,
        'editado', v_budgets ? key) order by value::numeric desc) from jsonb_each_text(v_bud)), '[]'::jsonb),
    'inflacion_por_ingreso', v_cfg,
    'reglas', jsonb_build_array(
      'meses pasados y el actual = real; futuros = proyectados',
      'ingresos futuros = recurrentes activos; Sueldo (y lo que marques en cashflow_config.infl_ingresos) se ajusta por inflacion compuesta',
      'egresos futuros = promedio por categoria de los ultimos 3 meses cerrados, pisado por tus presupuestos, x inflacion',
      'base caja: gastos que no son con credito + "Pago de tarjeta" = resumenes que vencen ese mes (o un estimado si todavia no existen)',
      'base devengado: todos los gastos (con credito incluido) + cuotas del mes',
      'saldo_acumulado arranca en el saldo de hoy (ARS + USD + USDT en pesos); pesos_acumulado solo mira flujos en ARS',
      'inflacion por defecto = promedio de las ultimas 6 mensuales oficiales, redondeado a 2 decimales'));
end $$;
comment on function public.q_cashflow(text, text, text, numeric, numeric, numeric) is
'Cash Flow de 6 meses: ingresos y egresos por concepto, neto, saldo acumulado y pesos líquidos. p_modo proyeccion|historico (con p_desde ''YYYY-MM''), p_base caja|devengado, p_inflacion % mensual (null = oficial), p_usd/p_usdt cotización. Ejemplo: select q_cashflow(); select q_cashflow(''historico'',''devengado'',''2026-05'');';

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'q\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
