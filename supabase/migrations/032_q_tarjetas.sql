-- 032 · Capa de consulta (q_) — tarjetas: suscripciones detectadas, resúmenes
-- (reales y proyectados), detalle de un resumen, cuotas y las tarjetas del Resumen.
-- Regla de oro de los resúmenes: PAGADO = total congelado al pagar; NO pagado =
-- en vivo (consumos linkeados sin cuotas + cuotas del período). Las suscripciones
-- detectadas SOLO se suman a resúmenes proyectados (los reales ya las tienen).

insert into public.rollback_funciones (migracion, funcion, definicion)
select '032', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('q__es_credito','q__resumenes','q_suscripciones','q_tarjetas','q_resumen','q_cuotas','q_tarjetas_home');

create or replace function public.q__es_credito(p_network text, p_name text) returns boolean
language sql immutable set search_path = public as $$
  select not (lower(coalesce(p_network, '')) like '%déb%' or lower(coalesce(p_network, '')) like '%deb%'
           or lower(coalesce(p_name, '')) like '%débito%' or lower(coalesce(p_name, '')) like '%debito%')
$$;

-- ── Suscripciones detectadas en las tarjetas ────────────────────────────────
create or replace function public.q_suscripciones(p_meses int default 8) returns jsonb
language sql stable set search_path = public as $$
  with par as (
    select least(greatest(coalesce(p_meses, 8), 1), 24) n, now() at time zone 'America/Argentina/Buenos_Aires' ahora),
  lim as (
    select ((ahora - make_interval(months => n)) - ((extract(day from (ahora - make_interval(months => n)))::int - 1) * interval '1 day'))
             at time zone 'America/Argentina/Buenos_Aires' desde,
           to_char(ahora - interval '2 months', 'YYYY-MM') min_mes, to_char(ahora, 'YYYY-MM') hoy_ym
    from par),
  fx as (select * from public.q__fx()),
  cargos as (
    select t.card_id, t.currency, t.amount,
           public.normalizar_comercio(coalesce(nullif(t.description, ''), c.name, 'Movimiento')) comercio,
           public.q__mes(t.occurred_at) mes, (t.nature::text = 'fijo') fija,
           coalesce(c.emoji, '🔁') emoji, coalesce(c.name, 'Otros') categoria
    from public.transactions t cross join lim
    left join public.categories c on c.id = t.category_id
    where t.type = 'egreso' and t.card_id is not null and t.occurred_at >= lim.desde
      and coalesce(t.installment_total, 0) <= 1),
  por_mes as (
    select card_id, comercio, currency, mes, sum(amount) monto, count(*)::int cobros,
           bool_or(fija) fija, min(emoji) emoji, min(categoria) categoria
    from cargos group by card_id, comercio, currency, mes),
  grupos as (
    select card_id, comercio, currency, array_agg(mes order by mes) meses, max(mes) ultimo_mes,
           sum(cobros)::numeric / count(*) cobros_por_mes, bool_or(fija) fija, min(emoji) emoji, min(categoria) categoria,
           percentile_cont(0.5) within group (order by monto) med
    from por_mes group by card_id, comercio, currency),
  cerca as (
    select g.card_id, g.comercio, g.currency, g.meses, g.ultimo_mes, g.cobros_por_mes, g.fija, g.emoji, g.categoria, g.med,
           array_agg(m.mes order by m.mes) filter (where abs(m.monto - g.med) <= g.med * 0.25) meses_cerca,
           percentile_cont(0.5) within group (order by m.monto) filter (where abs(m.monto - g.med) <= g.med * 0.25) monto_cerca
    from grupos g join por_mes m on m.card_id = g.card_id and m.comercio = g.comercio and m.currency = g.currency
    group by g.card_id, g.comercio, g.currency, g.meses, g.ultimo_mes, g.cobros_por_mes, g.fija, g.emoji, g.categoria, g.med),
  ev as (
    select c.*,
           (coalesce(array_length(c.meses_cerca, 1), 0) >= case when c.comercio ~* '(spotify|netflix|hbo|max|disney|paramount|apple|claude|anthropic|openai|chatgpt|prime|youtube|plus\y|pro\y|suscrip|abono|membres)' then 2 else 3 end
            and c.cobros_por_mes <= 1.5) repetida,
           coalesce(c.monto_cerca, c.med)::numeric monto, coalesce(c.meses_cerca, c.meses) meses_finales
    from cerca c),
  det as (
    select e.*, ca.name tarjeta, ca.last4,
           case e.currency when 'USD' then 0 when 'USDT' then e.monto * fx.usd else e.monto end aporte_ars,
           case e.currency when 'USD' then e.monto else 0 end aporte_usd,
           e.monto * case e.currency when 'USD' then fx.usd when 'USDT' then fx.usdt else 1 end monto_ars
    from ev e cross join lim cross join fx left join public.cards ca on ca.id = e.card_id
    where e.med > 0 and e.ultimo_mes >= lim.min_mes and (e.fija or e.repetida))
  select jsonb_build_object(
    'mes_de_referencia', (select hoy_ym from lim),
    'detectadas', (select count(*) from det),
    'mensual_estimado_ars', (select coalesce(sum(monto_ars), 0) from det),
    'por_tarjeta', (select coalesce(jsonb_agg(jsonb_build_object('card_id', card_id, 'tarjeta', tarjeta, 'ars', ars, 'usd', usd)), '[]'::jsonb)
                    from (select card_id, min(tarjeta) tarjeta, sum(aporte_ars) ars, sum(aporte_usd) usd from det group by card_id) x),
    'suscripciones', (select coalesce(jsonb_agg(jsonb_build_object(
        'card_id', card_id, 'tarjeta', tarjeta, 'last4', last4, 'comercio', comercio, 'emoji', emoji, 'categoria', categoria,
        'monto', monto, 'moneda', currency, 'monto_ars', monto_ars, 'meses', meses_finales, 'ultimo_cobro', ultimo_mes,
        'cobros_por_mes', cobros_por_mes,
        'motivo', case when fija and not repetida then 'marcada' else 'repetida' end) order by monto desc), '[]'::jsonb) from det),
    'reglas', jsonb_build_array(
      'entra un comercio si lo marcaste fijo, o si aparece en 3 meses (2 si el nombre delata suscripcion) con monto a +-25% de la mediana, a lo sumo 1,5 cobros por mes y con cobro en los ultimos 2 meses',
      'monto = mediana de los meses dentro de la tolerancia',
      'por_tarjeta: lo que en USD va a "usd"; ARS y USDT (valuado al blue) van a "ars", como en Tarjetas',
      'no es la misma lista que la de Gastos hormiga (q_hormiga): son dos detectores distintos'))
$$;
comment on function public.q_suscripciones(int) is
'Suscripciones y abonos detectados en las tarjetas (últimos p_meses), con total mensual por tarjeta. Alimentan la proyección de resúmenes futuros en Tarjetas. Ejemplo: select q_suscripciones();';

-- ── Total en vivo/congelado de cada resumen (auxiliar) ──────────────────────
create or replace function public.q__resumenes()
returns table(id bigint, card_id bigint, tarjeta text, last4 text, periodo text, cierre date, vence date, pagado boolean,
              estado text, total_ars numeric, total_usd numeric, total_combinado numeric, guardado_ars numeric, guardado_usd numeric,
              fx_pago numeric, pagado_el date, consumos int, cuotas int)
language sql stable set search_path = public as $$
  with fx as (select * from public.q__fx()),
  con as (
    select t.statement_id, sum(t.amount) filter (where t.currency = 'ARS') ars,
           sum(t.amount) filter (where t.currency <> 'ARS') usd, count(*)::int n
    from public.transactions t
    where t.statement_id is not null and coalesce(t.installment_total, 0) <= 1 group by t.statement_id),
  cuo as (
    select cs.id, sum(ip.monthly_amount * case ip.currency when 'USD' then fx.usd when 'USDT' then fx.usdt else 1 end) ars, count(*)::int n
    from public.card_statements cs cross join fx
    join public.installment_plans ip on ip.card_id = cs.card_id
     and public.q__meses_entre(to_char(ip.first_charge_date, 'YYYY-MM'), cs.period_label) between 0 and ip.total_installments - 1
    group by cs.id)
  select cs.id, cs.card_id, ca.name, ca.last4, cs.period_label, cs.closing_date, cs.due_date, cs.is_paid,
         case when cs.is_paid then 'pagado'
              when cs.closing_date > public.q__hoy() then 'en_curso'
              when cs.due_date < public.q__hoy() then 'vencido'
              else 'a_pagar' end,
         case when cs.is_paid then cs.total_ars else coalesce(con.ars, 0) + coalesce(cuo.ars, 0) end,
         case when cs.is_paid then cs.total_usd else coalesce(con.usd, 0) end,
         case when cs.is_paid then cs.total_ars + cs.total_usd * coalesce(cs.fx_rate_ars, fx.usd)
              else coalesce(con.ars, 0) + coalesce(con.usd, 0) * fx.usd + coalesce(cuo.ars, 0) end,
         cs.total_ars, cs.total_usd, cs.fx_rate_ars,
         (cs.paid_at at time zone 'America/Argentina/Buenos_Aires')::date,
         coalesce(con.n, 0), coalesce(cuo.n, 0)
  from public.card_statements cs cross join fx
  join public.cards ca on ca.id = cs.card_id
  left join con on con.statement_id = cs.id
  left join cuo on cuo.id = cs.id
$$;

-- ── Tarjetas: resúmenes reales + proyectados + gráfico ──────────────────────
create or replace function public.q_tarjetas(p_card_id bigint default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_hoy date := public.q__hoy();
  v_hoy_ym text := to_char(public.q__hoy(), 'YYYY-MM');
  v_usd numeric := (select usd from public.q__fx());
  v_subs jsonb := public.q_suscripciones(8);
  v_hay_subs boolean := jsonb_array_length(v_subs->'suscripciones') > 0;
  v_tarjetas jsonb := '[]'::jsonb;
  v_grafico jsonb := '[]'::jsonb;
  c record; v_actual record; v_apagar record;
  v_last text; v_horizon int; v_nsubs int; v_count int; v_close int; v_due int;
  v_per text; v_due_ym text; v_proy jsonb; v_sub_ars numeric; v_sub_usd numeric; v_cuo numeric; v_k int;
  v_last_real text; v_chart_h int; v_p text; v_vals jsonb; r record;
begin
  for c in select * from public.cards ca
           where not ca.is_archived and public.q__es_credito(ca.network, ca.name)
             and (p_card_id is null or ca.id = p_card_id) order by ca.id loop
    -- resumen "a pagar" = el último cerrado sin pagar; si no hay, el abierto más lejano; si no, el último.
    select * into v_apagar from public.q__resumenes() s where s.card_id = c.id and s.cierre <= v_hoy and not s.pagado order by s.cierre desc limit 1;
    if found then v_actual := v_apagar;
    else
      select * into v_actual from public.q__resumenes() s where s.card_id = c.id and s.cierre > v_hoy order by s.cierre desc limit 1;
      if not found then select * into v_actual from public.q__resumenes() s where s.card_id = c.id order by s.cierre desc limit 1; end if;
    end if;

    -- proyección de próximos resúmenes: cuotas + suscripciones de la tarjeta
    v_last := coalesce((select s.periodo from public.q__resumenes() s where s.card_id = c.id order by s.cierre desc limit 1), v_hoy_ym);
    v_horizon := greatest(0, coalesce((select max(public.q__meses_entre(v_last, to_char(ip.first_charge_date + make_interval(months => ip.total_installments - 1), 'YYYY-MM')))
                                       from public.installment_plans ip where ip.card_id = c.id), 0));
    select count(*), coalesce(sum(case s->>'moneda' when 'USD' then 0 when 'USDT' then (s->>'monto')::numeric * v_usd else (s->>'monto')::numeric end), 0),
           coalesce(sum(case s->>'moneda' when 'USD' then (s->>'monto')::numeric else 0 end), 0)
      into v_nsubs, v_sub_ars, v_sub_usd
      from jsonb_array_elements(v_subs->'suscripciones') s where (s->>'card_id')::bigint = c.id;
    v_count := least(6, greatest(case when v_nsubs > 0 then 3 else 1 end, v_horizon));
    v_close := coalesce(c.closing_day, extract(day from v_actual.cierre)::int, 25);
    v_due := coalesce(c.due_day, extract(day from v_actual.vence)::int, 6);
    v_proy := '[]'::jsonb;
    for v_k in 1 .. v_count loop
      v_per := public.q__mes_suma(v_last, v_k);
      continue when exists (select 1 from public.card_statements cs where cs.card_id = c.id and cs.period_label = v_per);
      v_due_ym := case when v_due < v_close then public.q__mes_suma(v_per, 1) else v_per end;
      select coalesce(sum(cuota_ars), 0) into v_cuo from public.q__cuotas_meses(v_per, v_per) q where q.card_id = c.id;
      v_proy := v_proy || jsonb_build_object(
        'periodo', v_per, 'estado', 'proyectado',
        'cierre', to_date(v_per || '-01', 'YYYY-MM-DD') + (least(v_close, extract(day from (to_date(v_per || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day'))::int) - 1),
        'vence', to_date(v_due_ym || '-01', 'YYYY-MM-DD') + (least(v_due, extract(day from (to_date(v_due_ym || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day'))::int) - 1),
        'total_ars', v_cuo + v_sub_ars, 'total_usd', v_sub_usd, 'cuotas_ars', v_cuo, 'suscripciones_ars', v_sub_ars, 'suscripciones_usd', v_sub_usd);
    end loop;

    v_tarjetas := v_tarjetas || jsonb_build_object(
      'id', c.id, 'nombre', c.name, 'banco', c.bank, 'red', c.network, 'last4', c.last4, 'limite_ars', c.limit_ars,
      'dia_cierre', c.closing_day, 'dia_vence', c.due_day,
      'al_dia', v_apagar.id is null,
      'actual', case when v_actual.id is not null then jsonb_build_object('id', v_actual.id, 'periodo', v_actual.periodo, 'estado', v_actual.estado,
                  'total_ars', v_actual.total_ars, 'total_usd', v_actual.total_usd) end,
      'uso_limite_pct', case when coalesce(c.limit_ars, 0) > 0 and v_actual.id is not null then least(100, round(v_actual.total_ars / c.limit_ars * 100)) else 0 end,
      'resumenes', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'periodo', s.periodo, 'cierre', s.cierre, 'vence', s.vence, 'estado', s.estado, 'pagado', s.pagado,
          'total_ars', s.total_ars, 'total_usd', s.total_usd, 'total_combinado', s.total_combinado,
          'fx_pago', s.fx_pago, 'pagado_el', s.pagado_el, 'consumos', s.consumos, 'cuotas', s.cuotas) order by s.cierre desc), '[]'::jsonb)
        from public.q__resumenes() s where s.card_id = c.id),
      'proyectados', v_proy);
    v_apagar := null; v_actual := null;
  end loop;

  -- Gráfico "Totales por mes": todas las tarjetas de crédito, períodos reales + horizonte proyectado.
  v_last_real := (select max(period_label) from public.card_statements);
  if v_last_real is not null and p_card_id is null then
    v_chart_h := least(6, greatest(case when v_hay_subs then 3 else 1 end,
      coalesce((select max(public.q__meses_entre(v_last_real, to_char(ip.first_charge_date + make_interval(months => ip.total_installments - 1), 'YYYY-MM'))) from public.installment_plans ip), 0)));
    for v_p in select distinct period_label from public.card_statements
               union select public.q__mes_suma(v_last_real, g) from generate_series(1, v_chart_h) g
               order by 1 loop
      v_vals := '[]'::jsonb;
      for r in select ca.id, ca.name from public.cards ca where not ca.is_archived and public.q__es_credito(ca.network, ca.name) order by ca.id loop
        select coalesce(sum(case s->>'moneda' when 'USD' then 0 when 'USDT' then (s->>'monto')::numeric * v_usd else (s->>'monto')::numeric end), 0),
               coalesce(sum(case s->>'moneda' when 'USD' then (s->>'monto')::numeric else 0 end), 0)
          into v_sub_ars, v_sub_usd from jsonb_array_elements(v_subs->'suscripciones') s where (s->>'card_id')::bigint = r.id;
        select coalesce(sum(cuota_ars), 0) into v_cuo from public.q__cuotas_meses(v_p, v_p) q where q.card_id = r.id;
        v_vals := v_vals || coalesce(
          (select jsonb_build_object('card_id', r.id, 'tarjeta', r.name, 'ars', s.total_ars, 'usd', s.total_usd, 'abierto', s.estado = 'en_curso', 'proyectado', false)
           from public.q__resumenes() s where s.card_id = r.id and s.periodo = v_p limit 1),
          case when v_p > coalesce((select max(cs.period_label) from public.card_statements cs where cs.card_id = r.id), '9999')
               then jsonb_build_object('card_id', r.id, 'tarjeta', r.name, 'ars', v_cuo + v_sub_ars, 'usd', v_sub_usd, 'abierto', false, 'proyectado', true)
               else jsonb_build_object('card_id', r.id, 'tarjeta', r.name, 'ars', null, 'usd', null, 'abierto', false, 'proyectado', false) end);
      end loop;
      v_grafico := v_grafico || jsonb_build_object('periodo', v_p, 'futuro', v_p > v_last_real, 'valores', v_vals);
    end loop;
  end if;

  return jsonb_build_object(
    'tarjetas', v_tarjetas, 'grafico', v_grafico,
    'cotizacion_usd', v_usd,
    'reglas', jsonb_build_array(
      'resumen PAGADO: total congelado al pagar (reconciliable con el PDF del banco). NO pagado: en vivo = consumos linkeados (sin cuotas) + cuotas del periodo',
      'estado: pagado | en_curso (todavia no cerro) | a_pagar (cerro, no vencio) | vencido (vencio sin marcarse pagado)',
      'proyectados = periodos que todavia no existen: cuotas + suscripciones detectadas (q_suscripciones). A un resumen real NUNCA se le suman suscripciones',
      'total_combinado = ARS + USD en pesos (USD congelado al pagar o a cotizacion de hoy si no esta pagado): es el que usa el Cash Flow',
      'lo que no es ARS en un resumen se cuenta como USD'));
end $$;
comment on function public.q_tarjetas(bigint) is
'Tarjetas de crédito con todos sus resúmenes (pagado, en curso, a pagar, vencido) y totales, el resumen "actual", los próximos resúmenes proyectados (cuotas + suscripciones) y el gráfico de totales por mes (pantalla Tarjetas). Ejemplo: select q_tarjetas(); select q_tarjetas(1);';

-- ── Detalle de un resumen ─────────────────────────────────────────────────
create or replace function public.q_resumen(p_id bigint) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  s record; v_usd numeric := (select usd from public.q__fx()); v_items jsonb; v_reg_ars numeric; v_reg_usd numeric;
  v_gap_ars numeric := 0; v_gap_usd numeric := 0;
begin
  select * into s from public.q__resumenes() r where r.id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', format('No existe el resumen %s.', p_id)); end if;
  with it as (
    select 'cuota' tipo, q.plan_id id, q.emoji, q.descripcion, format('Cuota %s/%s', q.n, q.total) sub, q.categoria, q.cuota monto, 'ARS' moneda
    from public.q__cuotas_meses(s.periodo, s.periodo) q where q.card_id = s.card_id
    union all
    select 'consumo', t.id, coalesce(c.emoji, '✨'), coalesce(nullif(t.description, ''), c.name, 'Consumo'),
           to_char(t.occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'), coalesce(c.name, 'Otros'), t.amount, t.currency
    from public.transactions t left join public.categories c on c.id = t.category_id
    where t.statement_id = p_id and coalesce(t.installment_total, 0) <= 1)
  select jsonb_agg(to_jsonb(it) order by it.monto * case when it.moneda = 'ARS' then 1 else v_usd end desc),
         coalesce(sum(monto) filter (where moneda = 'ARS'), 0), coalesce(sum(monto) filter (where moneda = 'USD'), 0)
    into v_items, v_reg_ars, v_reg_usd from it;
  if s.estado <> 'en_curso' then
    v_gap_ars := greatest(0, s.guardado_ars - v_reg_ars);
    v_gap_usd := greatest(0, s.guardado_usd - v_reg_usd);
  end if;
  return jsonb_build_object(
    'id', s.id, 'tarjeta', s.tarjeta, 'last4', s.last4, 'periodo', s.periodo, 'cierre', s.cierre, 'vence', s.vence,
    'estado', s.estado, 'total_ars', s.total_ars, 'total_usd', s.total_usd, 'total_combinado', s.total_combinado,
    'fx_pago', s.fx_pago, 'pagado_el', s.pagado_el,
    'items', coalesce(v_items, '[]'::jsonb),
    'no_detallado_ars', case when v_gap_ars > 1 then v_gap_ars else 0 end,
    'no_detallado_usd', case when v_gap_usd > 0.5 then v_gap_usd else 0 end,
    'reglas', jsonb_build_array(
      'items = cuotas del periodo + consumos linkeados (sin cuotas), ordenados por monto en pesos',
      'no_detallado = diferencia entre el total guardado y lo registrado en resumenes cerrados (consumos viejos que nunca se importaron)'));
end $$;
comment on function public.q_resumen(bigint) is
'Detalle de un resumen de tarjeta: cuotas y consumos que lo componen, totales y lo "no detallado" (pantalla Tarjetas → ver movimientos). Ejemplo: select q_resumen(97);';

-- ── Cuotas activas ────────────────────────────────────────────────────────
create or replace function public.q_cuotas() returns jsonb
language sql stable set search_path = public as $$ select public.cuotas_activas() $$;
comment on function public.q_cuotas() is
'Planes de cuotas vigentes: cuota actual, restantes, monto mensual y lo que falta pagar en pesos. Las cuotas NO son transacciones. Ejemplo: select q_cuotas();';

-- ── Tarjetas del Resumen (home) ────────────────────────────────────────────
create or replace function public.q_tarjetas_home() returns jsonb
language sql stable set search_path = public as $$
  with ref as (select coalesce((select public.q__mes(max(occurred_at)) from public.transactions where occurred_at <= now()), public.q__mes(now())) mes),
  abierto as (
    select distinct on (cs.card_id) cs.card_id, cs.id
    from public.card_statements cs where cs.closing_date > public.q__hoy() order by cs.card_id, cs.closing_date desc),
  cuo as (
    select ip.card_id, sum(ip.monthly_amount) cuotas
    from public.installment_plans ip
    where public.q__meses_entre(to_char(ip.first_charge_date, 'YYYY-MM'), public.q__mes(now())) < ip.total_installments
    group by ip.card_id)
  select jsonb_build_object(
    'mes', (select mes from ref),
    'tarjetas', coalesce(jsonb_agg(jsonb_build_object(
      'id', ca.id, 'nombre', ca.name, 'banco', coalesce(ca.bank, ''), 'red', coalesce(ca.network, ''), 'last4', coalesce(ca.last4, '----'),
      'limite_ars', ca.limit_ars, 'dia_cierre', ca.closing_day, 'dia_vence', ca.due_day,
      'etiqueta', case when ca.network ilike '%déb%' or ca.network ilike '%deb%' then 'Gasto del mes' else 'Resumen en curso' end,
      'monto', case when ca.network ilike '%déb%' or ca.network ilike '%deb%'
        then (select coalesce(sum(t.amount), 0) from public.transactions t cross join ref
              where t.card_id = ca.id and t.type = 'egreso' and public.q__mes(t.occurred_at) = ref.mes)
        else coalesce(cuo.cuotas, 0) + coalesce((select sum(t.amount) from public.transactions t
              where t.statement_id = ab.id and t.currency = 'ARS' and coalesce(t.installment_total, 0) <= 1), 0) end
      ) order by ca.id), '[]'::jsonb),
    'reglas', jsonb_build_array(
      'credito: cuotas activas de la tarjeta + consumos en ARS del resumen abierto (sin USD)',
      'debito: suma de los egresos del mes con esa tarjeta, en su moneda original (no convierte USD)'))
  from public.cards ca left join cuo on cuo.card_id = ca.id left join abierto ab on ab.card_id = ca.id
  where not ca.is_archived
$$;
comment on function public.q_tarjetas_home() is
'Las tarjetas como se ven en el Resumen: "Resumen en curso" (crédito) o "Gasto del mes" (débito). Ejemplo: select q_tarjetas_home();';

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'q\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
