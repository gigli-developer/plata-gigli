-- 031 · Capa de consulta (q_) — flujos: ingresos/egresos por mes, gastos por
-- categoría/método, ratios y variación mes a mes.
-- Reglas comunes: cotización CONGELADA del día del movimiento; Cambio Divisas y
-- Préstamos fuera; mes argentino; las cuotas (installment_plans) se suman al mes
-- en que caen e imputan a "Tarjeta de Crédito".

insert into public.rollback_funciones (migracion, funcion, definicion)
select '031', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('q__tx','q__cuotas_meses','q_flujo_mensual','q_gastos','q_ratios','q_variacion');

-- Movimientos de una ventana con todo lo que hace falta para clasificarlos.
create or replace function public.q__tx(p_desde timestamptz, p_hasta timestamptz, p_usd numeric default null, p_usdt numeric default null)
returns table(id bigint, occurred_at timestamptz, mes text, tipo text, categoria text, emoji text, metodo text,
              moneda text, monto numeric, ars numeric, es_flujo boolean, es_credito boolean, card_id bigint,
              statement_id bigint, descripcion text, naturaleza text, es_cuota boolean)
language sql stable set search_path = public as $$
  select t.id, t.occurred_at, public.q__mes(t.occurred_at), t.type::text,
         coalesce(c.name, 'Otros'), coalesce(c.emoji, '✨'), coalesce(pm.name, '—'), t.currency, t.amount,
         public.q__ars(t.amount, t.currency, t.fx_rate_ars, coalesce(p_usd, fx.usd), coalesce(p_usdt, fx.usdt)),
         coalesce(c.name, '') not in ('Cambio Divisas', 'Préstamos'),
         lower(coalesce(pm.name, '')) like '%crédito%' or lower(coalesce(pm.name, '')) like '%credito%',
         t.card_id, t.statement_id, coalesce(nullif(t.description, ''), c.name, 'Movimiento'),
         t.nature::text, coalesce(t.installment_total, 0) > 1
  from public.transactions t cross join public.q__fx() fx
  left join public.categories c on c.id = t.category_id
  left join public.payment_methods pm on pm.id = t.payment_method_id
  where t.occurred_at >= p_desde and t.occurred_at < p_hasta
$$;

-- Cuotas que caen en cada mes de [p_desde, p_hasta] ('YYYY-MM'), valuadas a cotización viva.
create or replace function public.q__cuotas_meses(p_desde text, p_hasta text)
returns table(mes text, plan_id bigint, card_id bigint, descripcion text, categoria text, emoji text,
              moneda text, cuota numeric, cuota_ars numeric, n int, total int)
language sql stable set search_path = public as $$
  select m.mes, ip.id, ip.card_id, ip.description, coalesce(c.name, 'Cuotas'), coalesce(c.emoji, '💳'),
         ip.currency, ip.monthly_amount,
         ip.monthly_amount * case ip.currency when 'USD' then fx.usd when 'USDT' then fx.usdt else 1 end,
         public.q__meses_entre(to_char(ip.first_charge_date, 'YYYY-MM'), m.mes) + 1, ip.total_installments
  from (select public.q__mes_suma(p_desde, g) mes
        from generate_series(0, public.q__meses_entre(p_desde, p_hasta)) g) m
  cross join public.q__fx() fx
  join public.installment_plans ip
    on public.q__meses_entre(to_char(ip.first_charge_date, 'YYYY-MM'), m.mes) between 0 and ip.total_installments - 1
  left join public.categories c on c.id = ip.category_id
$$;

-- ── Ingresos / egresos por mes ─────────────────────────────────────────────
create or replace function public.q_flujo_mensual(p_meses int default 6, p_hasta text default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_n int := greatest(coalesce(p_meses, 6), 1);
  v_hasta text := coalesce(p_hasta,
    (select public.q__mes(max(occurred_at)) from public.transactions where occurred_at <= now()),
    public.q__mes(now()));
  v_desde text := public.q__mes_suma(v_hasta, -(v_n - 1));
begin
  return (
    with meses as (select public.q__mes_suma(v_desde, g) mes from generate_series(0, v_n - 1) g),
    a as (select mes, sum(ars) filter (where tipo = 'ingreso') ing, sum(ars) filter (where tipo = 'egreso') egr
          from public.q__tx(public.q__inicio_mes(v_desde), public.q__inicio_mes(public.q__mes_suma(v_hasta, 1)))
          where es_flujo group by mes),
    cu as (select mes, sum(cuota_ars) cuo from public.q__cuotas_meses(v_desde, v_hasta) group by mes)
    select jsonb_build_object(
      'desde', v_desde, 'hasta', v_hasta,
      'meses', jsonb_agg(jsonb_build_object(
        'mes', m.mes, 'ingresos', coalesce(a.ing, 0), 'egresos', coalesce(a.egr, 0),
        'cuotas', coalesce(cu.cuo, 0), 'neto', coalesce(a.ing, 0) - coalesce(a.egr, 0)) order by m.mes),
      'reglas', jsonb_build_array(
        'egresos = TODOS los gastos del mes, incluidos los hechos con tarjeta de credito (cuando consumis, no cuando pagas)',
        'egresos NO incluye cuotas: vienen aparte en "cuotas" (el grafico del Resumen y el de Metricas no las suman)',
        'cotizacion congelada del dia de cada movimiento; sin Cambio Divisas ni Prestamos',
        'p_hasta por defecto = mes del ultimo movimiento hasta hoy (criterio del Resumen)'))
    from meses m left join a using (mes) left join cu using (mes));
end $$;
comment on function public.q_flujo_mensual(int, text) is
'Ingresos y egresos de cada mes (los últimos p_meses hasta p_hasta ''YYYY-MM''), más las cuotas de cada mes aparte. Gráfico "Flujo de caja" del Resumen y columnas de Métricas. Ejemplo: select q_flujo_mensual(6); select q_flujo_mensual(7, ''2026-11'');';

-- ── Gastos por categoría / método / mes / moneda ───────────────────────────
create or replace function public.q_gastos(
  p_desde date default null, p_hasta date default null, p_categoria text default null,
  p_agrupar text default 'categoria', p_con_cuotas boolean default true) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_desde date := coalesce(p_desde, date_trunc('month', public.q__hoy())::date);
  v_hasta date := coalesce(p_hasta, public.q__hoy());
begin
  if coalesce(p_agrupar, '') not in ('categoria', 'metodo', 'mes', 'moneda', 'total') then
    raise exception 'p_agrupar tiene que ser categoria, metodo, mes, moneda o total (vino %)', p_agrupar;
  end if;
  return (
    with x as (
      select categoria, emoji, metodo, mes, moneda, ars, 'transaccion' origen
      from public.q__tx(v_desde::timestamp at time zone 'America/Argentina/Buenos_Aires',
                        (v_hasta + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
      where tipo = 'egreso' and es_flujo and (p_categoria is null or categoria = p_categoria)
      union all
      select categoria, emoji, 'Tarjeta de Crédito', mes, moneda, cuota_ars, 'cuota'
      from public.q__cuotas_meses(to_char(v_desde, 'YYYY-MM'), to_char(v_hasta, 'YYYY-MM'))
      where p_con_cuotas and (p_categoria is null or categoria = p_categoria)),
    g as (
      select case p_agrupar when 'categoria' then categoria when 'metodo' then metodo
                            when 'mes' then mes when 'moneda' then moneda else 'total' end clave,
             coalesce(min(emoji) filter (where origen = 'transaccion'), min(emoji)) emoji,
             sum(ars) total,
             coalesce(sum(ars) filter (where origen = 'transaccion'), 0) tx,
             coalesce(sum(ars) filter (where origen = 'cuota'), 0) cuo,
             count(*) filter (where origen = 'transaccion') n_tx,
             count(*) filter (where origen = 'cuota') n_cuo
      from x group by 1)
    select jsonb_build_object(
      'desde', v_desde, 'hasta', v_hasta, 'agrupado_por', p_agrupar, 'categoria', p_categoria,
      'total_ars', coalesce((select sum(total) from g), 0),
      'transacciones_ars', coalesce((select sum(tx) from g), 0),
      'cuotas_ars', coalesce((select sum(cuo) from g), 0),
      'grupos', coalesce((select jsonb_agg(jsonb_build_object(
          'clave', clave, 'emoji', case when p_agrupar = 'categoria' then emoji end,
          'total_ars', total, 'transacciones_ars', tx, 'cuotas_ars', cuo,
          'movimientos', n_tx, 'cuotas', n_cuo) order by total desc) from g), '[]'::jsonb),
      'reglas', jsonb_build_array(
        'gasto devengado: cuenta cuando consumis (tarjeta de credito incluida), no cuando pagas el resumen',
        'incluye las CUOTAS de cada mes del rango (mes completo, aunque p_desde/p_hasta corten el mes), imputadas a Tarjeta de Credito',
        'cotizacion congelada del dia de cada movimiento; cuotas a cotizacion de hoy',
        'excluye Cambio Divisas y Prestamos; fechas en hora argentina, p_hasta inclusive')));
end $$;
comment on function public.q_gastos(date, date, text, text, boolean) is
'Gasto real (con cuotas) entre p_desde y p_hasta (por defecto, el mes en curso), agrupado por categoria | metodo | mes | moneda | total, opcionalmente de una sola categoría. Dona del Resumen y gráficos de Métricas. Ejemplos: select q_gastos(); select q_gastos(''2026-10-01'',''2026-10-31''); select q_gastos(''2026-06-01'',''2026-10-31'',''Delivery'',''mes'');';

-- ── Ratios ────────────────────────────────────────────────────────────────
create or replace function public.q_ratios(p_desde_mes text default null, p_hasta_mes text default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_d text := coalesce(p_desde_mes, public.q__mes(now()));
  v_h text := coalesce(p_hasta_mes, coalesce(p_desde_mes, public.q__mes(now())));
  v_n int := greatest(public.q__meses_entre(v_d, v_h) + 1, 1);
begin
  return (
    with s as (
      select coalesce(sum(ars) filter (where tipo = 'ingreso'), 0) ing,
             coalesce(sum(ars) filter (where tipo = 'egreso'), 0) egr_tx
      from public.q__tx(public.q__inicio_mes(v_d), public.q__inicio_mes(public.q__mes_suma(v_h, 1))) where es_flujo),
    c as (select coalesce(sum(cuota_ars), 0) cuo from public.q__cuotas_meses(v_d, v_h)),
    r as (select ing, egr_tx, cuo, egr_tx + cuo egr, ing - egr_tx - cuo ahorro from s, c)
    select jsonb_build_object(
      'desde', v_d, 'hasta', v_h, 'meses', v_n,
      'ingresos', ing, 'egresos', egr, 'egresos_transacciones', egr_tx, 'cuotas', cuo,
      'ahorro', ahorro, 'ahorro_mensual', ahorro / v_n,
      'dti', case when ing <> 0 then cuo / ing else 0 end,
      'tasa_ahorro', case when ing <> 0 then ahorro / ing else 0 end,
      'cobertura', case when egr <> 0 then ing / egr else 0 end,
      'reglas', jsonb_build_array(
        'egresos = gastos + cuotas del periodo (igual que los graficos de Metricas)',
        'dti = cuotas / ingresos; tasa_ahorro = ahorro / ingresos; cobertura = ingresos / egresos',
        'sin Cambio Divisas ni Prestamos; cotizacion congelada'))
    from r);
end $$;
comment on function public.q_ratios(text, text) is
'Ratios de un mes o rango de meses ''YYYY-MM'': ingresos, egresos (con cuotas), ahorro, DTI, tasa de ahorro y cobertura (Métricas). Ejemplo: select q_ratios(''2026-10''); select q_ratios(''2026-05'',''2026-11'');';

-- ── Variación por categoría ────────────────────────────────────────────────
create or replace function public.q_variacion(p_mes_a text default null, p_mes_b text default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_b text := coalesce(p_mes_b, public.q__mes(now()));
  v_a text := coalesce(p_mes_a, public.q__mes_suma(coalesce(p_mes_b, public.q__mes(now())), -1));
  v_dias int := extract(day from (to_date(v_b || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day'))::int;
  v_trans int;
  v_factor numeric;
begin
  v_trans := case when v_b = public.q__mes(now()) then greatest(extract(day from public.q__hoy())::int, 1) else v_dias end;
  v_factor := v_dias::numeric / v_trans;
  return (
    with x as (
      select mes, categoria, emoji, ars, 'transaccion' origen
      from public.q__tx(public.q__inicio_mes(least(v_a, v_b)), public.q__inicio_mes(public.q__mes_suma(greatest(v_a, v_b), 1)))
      where tipo = 'egreso' and es_flujo and mes in (v_a, v_b)
      union all
      select mes, categoria, emoji, cuota_ars, 'cuota'
      from public.q__cuotas_meses(least(v_a, v_b), greatest(v_a, v_b)) where mes in (v_a, v_b)),
    per as (
      select categoria, coalesce(min(emoji) filter (where origen = 'transaccion'), min(emoji)) emoji,
             coalesce(sum(ars) filter (where mes = v_b), 0) cur,
             coalesce(sum(ars) filter (where mes = v_a), 0) prev,
             coalesce(sum(ars) filter (where mes = v_b and origen = 'transaccion'), 0) cons_b,
             coalesce(sum(ars) filter (where mes = v_b and origen = 'cuota'), 0) cuo_b
      from x group by categoria)
    select jsonb_build_object(
      'mes_a', v_a, 'mes_b', v_b, 'factor_estimado', v_factor, 'mes_b_en_curso', v_b = public.q__mes(now()),
      'categorias', coalesce((select jsonb_agg(jsonb_build_object(
          'categoria', categoria, 'emoji', emoji, 'mes_b', cur, 'mes_a', prev,
          'estimado_fin_de_mes', cons_b * v_factor + cuo_b,
          'variacion_pct', case when prev > 0 then (cur - prev) / prev end)
          order by abs(cur - prev) desc) from per where cur > 0 or prev > 0), '[]'::jsonb),
      'reglas', jsonb_build_array(
        'gasto por categoria con cuotas, mes B contra mes A',
        'estimado_fin_de_mes = consumos de B * (dias del mes / dias transcurridos) + cuotas de B (las cuotas no se proyectan, van enteras)')));
end $$;
comment on function public.q_variacion(text, text) is
'Variación del gasto por categoría entre dos meses ''YYYY-MM'' (por defecto, el mes en curso contra el anterior), con estimado a fin de mes. Tabla de variación de Métricas. Ejemplo: select q_variacion(); select q_variacion(''2026-09'',''2026-10'');';

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'q\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
