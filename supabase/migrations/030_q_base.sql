-- 030 · Capa de consulta (q_) — base: auxiliares, saldos, patrimonio, deudas,
-- cotizaciones, cambios y movimientos.
--
-- Principio: TODO número de negocio sale de una función q_. La app y Claude
-- llaman a las mismas. Todas son de solo lectura, SECURITY INVOKER (respetan RLS)
-- y devuelven jsonb. El mes es SIEMPRE el calendario argentino (decisión del
-- 2026-11-08: antes Métricas/Cash Flow/Hormiga usaban el mes UTC).
-- Las q__ (doble guión bajo) son auxiliares internas: no van en el catálogo.

insert into public.rollback_funciones (migracion, funcion, definicion)
select '030', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('q__hoy','q__mes','q__mes_suma','q__meses_entre','q__inicio_mes','q__fx','q__ars',
                    'q_saldos','q_patrimonio','q_patrimonio_serie','q_deudas_personas','q_cotizaciones',
                    'q_cambios','q_movimientos');

-- ── Auxiliares ─────────────────────────────────────────────────────────────
create or replace function public.q__hoy() returns date
language sql stable set search_path = public as
$$ select (now() at time zone 'America/Argentina/Buenos_Aires')::date $$;

create or replace function public.q__mes(p_ts timestamptz) returns text
language sql stable set search_path = public as
$$ select to_char(p_ts at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM') $$;

create or replace function public.q__mes_suma(p_ym text, p_n int) returns text
language sql immutable set search_path = public as
$$ select to_char(to_date(p_ym || '-01', 'YYYY-MM-DD') + make_interval(months => p_n), 'YYYY-MM') $$;

create or replace function public.q__meses_entre(p_a text, p_b text) returns int
language sql immutable set search_path = public as
$$ select (substr(p_b,1,4)::int - substr(p_a,1,4)::int) * 12 + (substr(p_b,6,2)::int - substr(p_a,6,2)::int) $$;

-- 00:00 hora argentina del día 1 del mes 'YYYY-MM'.
create or replace function public.q__inicio_mes(p_ym text) returns timestamptz
language sql stable set search_path = public as
$$ select (p_ym || '-01')::timestamp at time zone 'America/Argentina/Buenos_Aires' $$;

-- Cotización VIVA, exactamente la misma expresión que get_metrics().
create or replace function public.q__fx(out usd numeric, out usdt numeric)
language sql stable set search_path = public as
$$ select coalesce(public.fx_rate_at('blue',   current_date, 'compra'), 1455)::numeric,
          coalesce(public.fx_rate_at('cripto', current_date, 'compra'), 1462)::numeric $$;

-- Monto en ARS: con la cotización CONGELADA si la hay (flujos), si no a la viva.
create or replace function public.q__ars(p_monto numeric, p_moneda text, p_fx numeric, p_usd numeric, p_usdt numeric) returns numeric
language sql immutable set search_path = public as
$$ select p_monto * coalesce(p_fx, case p_moneda when 'USD' then p_usd when 'USDT' then p_usdt else 1 end) $$;

-- ── Saldos ────────────────────────────────────────────────────────────────
create or replace function public.q_saldos() returns jsonb
language sql stable set search_path = public as $$
  with m as (select public.get_metrics() j),
  v as (select (j->>'ars_liquido')::numeric ars, (j->>'usd_liquido')::numeric usd, (j->>'usdt_liquido')::numeric usdt,
               (j->>'usd_ars')::numeric usd_ars, (j->>'usdt_ars')::numeric usdt_ars from m)
  select jsonb_build_object(
    'ars', ars, 'usd', usd, 'usdt', usdt,
    'usd_ars', usd_ars, 'usdt_ars', usdt_ars,
    'usd_en_ars', usd * usd_ars, 'usdt_en_ars', usdt * usdt_ars,
    'total_ars', ars + usd * usd_ars + usdt * usdt_ars,
    'reglas', jsonb_build_array(
      'saldo = ingresos - egresos que NO son con tarjeta de credito - resumenes de tarjeta PAGADOS (total congelado al pagar)',
      'pagar un resumen NO crea una transaccion: por eso sumar transactions a mano da otro numero',
      'Cambio Divisas y Prestamos SI mueven el saldo (no cuentan como gasto/ingreso, pero es plata que entra o sale)',
      'USD a blue compra y USDT a cripto compra de hoy (tabla fx_rates)',
      'no hay saldo por cuenta ni por medio de pago: es un pozo por moneda'))
  from v
$$;
comment on function public.q_saldos() is
'Saldo disponible HOY por moneda (ARS, USD, USDT), su valor en pesos y el total. Es el "Saldo total" del Resumen y las tenencias de Divisas. Ejemplo: select q_saldos();';

-- ── Patrimonio ────────────────────────────────────────────────────────────
create or replace function public.q_patrimonio(p_usd numeric default null, p_usdt numeric default null) returns jsonb
language sql stable set search_path = public as $$
  with m as (select public.get_metrics() j),
  v as (select (j->>'ars_liquido')::numeric ars, (j->>'usd_liquido')::numeric usd, (j->>'usdt_liquido')::numeric usdt,
               coalesce(p_usd,  (j->>'usd_ars')::numeric)  usd_ars,
               coalesce(p_usdt, (j->>'usdt_ars')::numeric) usdt_ars,
               (j->>'te_deben')::numeric te_deben, (j->>'debes')::numeric debes,
               (j->>'deuda_cuotas_ars')::numeric deuda_cuotas, (j->>'deuda_vencida_ars')::numeric deuda_vencida from m),
  c as (select v.*, usd * usd_ars usd_en_ars, usdt * usdt_ars usdt_en_ars,
               ars + usd * usd_ars + usdt * usdt_ars + te_deben activos,
               deuda_cuotas + deuda_vencida + debes pasivos from v)
  select jsonb_build_object(
    'patrimonio', activos - pasivos,
    'patrimonio_usd', case when usd_ars <> 0 then (activos - pasivos) / usd_ars else 0 end,
    'activos', activos, 'pasivos', pasivos,
    'componentes', jsonb_build_object(
      'ars', ars, 'usd', usd, 'usdt', usdt, 'usd_en_ars', usd_en_ars, 'usdt_en_ars', usdt_en_ars,
      'te_deben', te_deben, 'debes', debes,
      'cuotas_pendientes', deuda_cuotas, 'resumenes_vencidos_impagos', deuda_vencida),
    'cotizaciones', jsonb_build_object('usd', usd_ars, 'usdt', usdt_ars),
    'reglas', jsonb_build_array(
      'activos = saldo ARS + USD y USDT valuados + te deben',
      'pasivos = cuotas que faltan pagar (incluye la del mes) + resumenes vencidos sin marcar como pagados + debes',
      'te_deben/debes a cotizacion de hoy; p_usd/p_usdt solo cambian la valuacion de los saldos en USD/USDT (input editable de Metricas)'))
  from c
$$;
comment on function public.q_patrimonio(numeric, numeric) is
'Patrimonio neto de hoy con activos, pasivos y cada componente (Resumen y Métricas). p_usd/p_usdt: cotización a usar para los saldos (null = la de hoy). Ejemplo: select q_patrimonio(); select q_patrimonio(1600, null);';

create or replace function public.q_patrimonio_serie(p_meses int default 12) returns jsonb
language sql stable set search_path = public as $$
  with s as (
    select g.*, row_number() over (order by g.month) rn, count(*) over () n
    from public.get_networth_series(p_meses) g
  ),
  par as (select c.*, p.patrimonio p_patr, p.usd p_usd, p.usdt p_usdt, p.ars p_ars,
                 p.usd_ars p_usd_ars, p.usdt_ars p_usdt_ars
          from s c join s p on p.rn = c.rn - 1 where c.rn = c.n)
  select jsonb_build_object(
    'puntos', (select coalesce(jsonb_agg(jsonb_build_object(
        'mes', month, 'corte', cutoff, 'ars', ars, 'usd', usd, 'usdt', usdt,
        'usd_ars', usd_ars, 'usdt_ars', usdt_ars, 'te_deben', te_deben, 'debes', debes,
        'cuotas_pendientes', deuda_cuotas, 'resumenes_vencidos', deuda_vencida,
        'activos', activos, 'pasivos', pasivos, 'patrimonio', patrimonio,
        'patrimonio_usd', case when usd_ars <> 0 then patrimonio / usd_ars else 0 end) order by month), '[]'::jsonb) from s),
    'variacion_ultimo_mes', (select jsonb_build_object(
        'mes', month,
        'ars', jsonb_build_object(
          'total', patrimonio - p_patr,
          'por_el_dolar', p_usd * (usd_ars - p_usd_ars) + p_usdt * (usdt_ars - p_usdt_ars),
          'tuyo', (patrimonio - p_patr) - (p_usd * (usd_ars - p_usd_ars) + p_usdt * (usdt_ars - p_usdt_ars))),
        'usd', jsonb_build_object(
          'total', (case when usd_ars <> 0 then patrimonio / usd_ars else 0 end) - (case when p_usd_ars <> 0 then p_patr / p_usd_ars else 0 end),
          'por_tener_pesos', case when usd_ars <> 0 and p_usd_ars <> 0 then p_ars * (1 / usd_ars - 1 / p_usd_ars) else 0 end,
          'tuyo', ((case when usd_ars <> 0 then patrimonio / usd_ars else 0 end) - (case when p_usd_ars <> 0 then p_patr / p_usd_ars else 0 end))
                  - (case when usd_ars <> 0 and p_usd_ars <> 0 then p_ars * (1 / usd_ars - 1 / p_usd_ars) else 0 end)))
      from par),
    'reglas', jsonb_build_array(
      'cada punto reconstruye el patrimonio al cierre del mes con la cotizacion de ESE corte',
      'el ultimo punto coincide con q_patrimonio()',
      'en USD cada mes se divide por el blue de su propio corte'))
$$;
comment on function public.q_patrimonio_serie(int) is
'Patrimonio neto al cierre de cada uno de los últimos p_meses (gráfico de Métricas) y la variación del último mes separada en "tuyo" vs "por el dólar". Ejemplo: select q_patrimonio_serie(12);';

-- ── Deudas con personas ─────────────────────────────────────────────────────
create or replace function public.q_deudas_personas() returns jsonb
language sql stable set search_path = public as $$
  with fx as (select * from public.q__fx()),
  pagos as (
    select debt_id, sum(amount) pagado,
           jsonb_agg(jsonb_build_object('id', id, 'monto', amount, 'transaccion_id', transaction_id,
             'fecha', to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD')) order by occurred_at) lista
    from public.debt_payments group by debt_id),
  d as (
    select d.*, coalesce(p.name, '—') persona, coalesce(pg.pagado, 0) pagado,
           greatest(d.amount - coalesce(pg.pagado, 0), 0) pendiente, coalesce(pg.lista, '[]'::jsonb) pagos,
           greatest(d.amount - coalesce(pg.pagado, 0), 0)
             * case d.currency when 'USD' then fx.usd when 'USDT' then fx.usdt else 1 end pendiente_ars
    from public.debts d cross join fx
    left join public.persons p on p.id = d.person_id
    left join pagos pg on pg.debt_id = d.id),
  per as (
    select persona,
           coalesce(sum(pendiente_ars) filter (where status = 'pending' and direction = 'to_collect'), 0) te_debe,
           coalesce(sum(pendiente_ars) filter (where status = 'pending' and direction = 'to_pay'), 0) le_debes,
           count(*) filter (where status = 'pending') pendientes, count(*) total
    from d group by persona)
  select jsonb_build_object(
    'te_deben', (select coalesce(sum(pendiente_ars), 0) from d where status = 'pending' and direction = 'to_collect'),
    'debes',    (select coalesce(sum(pendiente_ars), 0) from d where status = 'pending' and direction = 'to_pay'),
    'personas', (select coalesce(jsonb_agg(jsonb_build_object('persona', persona, 'te_debe', te_debe, 'le_debes', le_debes,
                   'neto', te_debe - le_debes, 'pendientes', pendientes, 'total', total)
                   order by pendientes desc, abs(te_debe - le_debes) desc), '[]'::jsonb) from per),
    'deudas', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', id, 'persona', persona, 'tipo', kind, 'direccion', direction, 'estado', status,
                 'monto', amount, 'moneda', currency, 'pagado', pagado, 'pendiente', pendiente, 'pendiente_ars', pendiente_ars,
                 'descripcion', coalesce(description, ''),
                 'fecha', to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
                 'saldada_el', to_char(settled_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
                 'total_dividido', split_total, 'tu_parte', your_share, 'participantes', participants,
                 'pagos', pagos) order by occurred_at desc), '[]'::jsonb) from d),
    'cotizaciones', (select jsonb_build_object('usd', usd, 'usdt', usdt) from fx),
    'reglas', jsonb_build_array(
      'pendiente = monto original - suma de pagos (el monto original nunca se modifica)',
      'te_deben/debes suman solo deudas en estado pending, a cotizacion de hoy',
      'direccion to_collect = te deben; to_pay = debes'))
$$;
comment on function public.q_deudas_personas() is
'Deudas con personas: totales te deben / debés, resumen por persona y cada deuda con sus pagos (pantalla Deudas). Ejemplo: select q_deudas_personas();';

-- ── Cotizaciones y cambios ─────────────────────────────────────────────────
create or replace function public.q_cotizaciones(p_dias int default 90, p_con_series boolean default false) returns jsonb
language sql stable set search_path = public as $$
  with casas(casa, etiqueta, pista, ord) as (values ('blue','Blue','informal',1), ('bolsa','MEP','bolsa',2), ('cripto','Cripto','USDT',3), ('oficial','Oficial','BNA',4)),
  r as (select f.day, f.casa, f.compra, f.venta,
               row_number() over (partition by f.casa order by f.day desc) k
        from public.fx_rates f join casas c using (casa)
        where f.day >= current_date - p_dias)
  select jsonb_build_object(
    'cotizaciones', (select coalesce(jsonb_agg(jsonb_build_object(
        'casa', c.casa, 'etiqueta', c.etiqueta, 'pista', c.pista, 'dia', u.day, 'compra', u.compra, 'venta', u.venta,
        'variacion_pct', case when a.venta > 0 then (u.venta - a.venta) / a.venta * 100 end) order by c.ord), '[]'::jsonb)
      from casas c join r u on u.casa = c.casa and u.k = 1 left join r a on a.casa = c.casa and a.k = 2),
    'series', case when p_con_series then (select jsonb_object_agg(casa, s) from (
        select casa, jsonb_agg(jsonb_build_object('dia', day, 'compra', compra, 'venta', venta) order by day) s
        from r group by casa) x) end,
    'reglas', jsonb_build_array('para valuar se usa COMPRA: blue para USD y cripto para USDT', 'variacion_pct = venta de hoy contra el dia anterior con dato'))
$$;
comment on function public.q_cotizaciones(int, boolean) is
'Cotizaciones del dólar (blue, MEP, cripto, oficial): última compra/venta y variación diaria; con p_con_series=true trae la serie de los últimos p_dias (Divisas). Ejemplo: select q_cotizaciones(); select q_cotizaciones(30, true);';

create or replace function public.q_cambios(p_limite int default 50) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object('cambios', coalesce(jsonb_agg(x order by x->>'fecha' desc), '[]'::jsonb))
  from (select jsonb_build_object('id', id, 'de', from_currency, 'a', to_currency, 'monto_de', from_amount, 'monto_a', to_amount,
               'tasa', rate, 'origen_tasa', rate_source,
               'fecha', to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD')) x
        from public.currency_exchanges order by occurred_at desc limit p_limite) s
$$;
comment on function public.q_cambios(int) is
'Historial de cambios de moneda (compra/venta de USD y USDT). Cada cambio generó dos transacciones "Cambio Divisas" que mueven los saldos. Ejemplo: select q_cambios(20);';

-- ── Movimientos ───────────────────────────────────────────────────────────
create or replace function public.q_movimientos(
  p_desde date default null, p_hasta date default null, p_texto text default null,
  p_categoria text default null, p_tipo text default null, p_limite int default 100) returns jsonb
language sql stable set search_path = public as $$
  with fx as (select * from public.q__fx()),
  t as (
    select t.id, t.type, t.amount, t.currency, t.fx_rate_ars, t.description, t.occurred_at, t.source,
           t.statement_id, t.nature, coalesce(c.name, 'Otros') categoria, coalesce(pm.name, '—') metodo, ca.name tarjeta,
           public.q__ars(t.amount, t.currency, t.fx_rate_ars, fx.usd, fx.usdt) ars
    from public.transactions t cross join fx
    left join public.categories c on c.id = t.category_id
    left join public.payment_methods pm on pm.id = t.payment_method_id
    left join public.cards ca on ca.id = t.card_id
    where (p_desde is null or t.occurred_at >= p_desde::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and (p_hasta is null or t.occurred_at <  (p_hasta + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')
      and (p_texto is null or t.description ilike '%' || p_texto || '%')
      and (p_categoria is null or coalesce(c.name, 'Otros') = p_categoria)
      and (p_tipo is null or t.type::text = p_tipo))
  select jsonb_build_object(
    'cantidad', (select count(*) from t),
    'ingresos_ars', (select coalesce(sum(ars), 0) from t where type = 'ingreso' and categoria not in ('Cambio Divisas','Préstamos')),
    'egresos_ars',  (select coalesce(sum(ars), 0) from t where type = 'egreso'  and categoria not in ('Cambio Divisas','Préstamos')),
    'movimientos', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'fecha', to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI'),
        'tipo', type, 'monto', amount, 'moneda', currency, 'monto_ars', ars, 'cotizacion', fx_rate_ars,
        'descripcion', description, 'categoria', categoria, 'metodo', metodo, 'tarjeta', tarjeta,
        'resumen_id', statement_id, 'naturaleza', nature, 'origen', source) order by occurred_at desc), '[]'::jsonb)
      from (select * from t order by occurred_at desc limit p_limite) l),
    'reglas', jsonb_build_array(
      'monto_ars usa la cotizacion congelada del dia del movimiento',
      'ingresos_ars/egresos_ars excluyen Cambio Divisas y Prestamos y NO incluyen cuotas (para gasto real usar q_gastos)',
      'fechas en hora argentina; p_hasta inclusive'))
$$;
comment on function public.q_movimientos(date, date, text, text, text, int) is
'Lista de movimientos filtrable (fechas inclusive, texto en la descripción, categoría exacta, tipo ingreso/egreso) con su valor en pesos. Para buscar, no para sumar gastos: eso es q_gastos. Ejemplo: select q_movimientos(''2026-10-01'', ''2026-10-31'', ''rappi'');';

-- Permisos: solo el usuario logueado (RLS filtra) y service_role (Claude vía conector).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'q\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
