-- 033 · Capa de consulta (q_) — Gastos hormiga.
-- Espejo de lib/hormiga.ts: el goteo (tickets chicos de categorías evitables) es
-- el protagonista; los consumos grandes van aparte como contexto; cuotas,
-- suscripciones y trámites obligatorios quedan afuera. Mes argentino.

insert into public.rollback_funciones (migracion, funcion, definicion)
select '033', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('q_hormiga');

create or replace function public.q_hormiga(p_meses int default 12, p_umbral numeric default null, p_detalle boolean default false) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  c_cats constant text[] := array['Delivery', 'Comida', 'Ocio', 'Transporte', 'Compras'];
  c_pista constant text := '(spotify|netflix|hbo|max|disney|paramount|apple|claude|anthropic|openai|chatgpt|prime|youtube|plus\y|pro\y|suscrip|abono|membres)';
  c_no_impulso constant text := '(gob\.ar|policia|polic[íi]a|rentas|arba|afip|multa|patente|infracci|vtv|seguro|aseguradora|impuesto|municipal|registro civil|migraciones)';
  v_ahora timestamp := now() at time zone 'America/Argentina/Buenos_Aires';
  v_n int := greatest(coalesce(p_meses, 12), 1);
  v_desde timestamptz;
  v_cur text := public.q__mes(now());
  v_usd numeric; v_usdt numeric;
  v_cant int; v_p70 numeric; v_umbral numeric;
begin
  select usd, usdt into v_usd, v_usdt from public.q__fx();
  v_desde := ((v_ahora - make_interval(months => v_n)) - ((extract(day from (v_ahora - make_interval(months => v_n)))::int - 1) * interval '1 day'))
             at time zone 'America/Argentina/Buenos_Aires';

  -- Umbral: percentil 70 del ticket de las categorías evitables (sin cuotas), redondeado a $500, mínimo $2.000.
  select count(*) into v_cant from public.q__tx(v_desde, 'infinity')
   where tipo = 'egreso' and not es_cuota and categoria = any(c_cats);
  if p_umbral is not null then v_umbral := p_umbral;
  elsif v_cant < 10 then v_umbral := 15000;
  else
    select ars into v_p70 from public.q__tx(v_desde, 'infinity')
     where tipo = 'egreso' and not es_cuota and categoria = any(c_cats)
     order by ars offset floor(v_cant * 0.7) limit 1;
    v_umbral := greatest(2000, round(v_p70 / 500) * 500);
  end if;

  return (
    with r as (
      select x.*, public.normalizar_comercio(x.descripcion) comercio
      from public.q__tx(v_desde, 'infinity') x where x.tipo = 'egreso'),
    subs as (
      select comercio, monto, moneda, array_agg(distinct mes order by mes) meses, array_agg(id) ids,
             bool_and(naturaleza = 'fijo') ya_fija,
             monto * case moneda when 'USD' then v_usd when 'USDT' then v_usdt else 1 end * 12 anual
      from r where not es_cuota group by comercio, monto, moneda
      having count(distinct mes) >= case when comercio ~* c_pista then 2 else 3 end),
    cand as (
      select r.* from r
      where not r.es_cuota and r.categoria = any(c_cats)
        and not exists (select 1 from subs s where r.id = any(s.ids))
        and not (r.comercio ~* c_no_impulso)),
    got as (select * from cand where ars <= v_umbral),
    gra as (select * from cand where ars > v_umbral),
    meses as (select mes from (select distinct mes from r) d order by mes desc limit 6),
    tot as (select mes, sum(ars) t from got group by mes),
    tg as (select mes, sum(ars) t from gra group by mes),
    k as (
      select coalesce((select t from tot where mes = v_cur), 0) total_mes,
             coalesce((select t from tg where mes = v_cur), 0) grandes_mes,
             (select count(*) from got where mes = v_cur) n_mes,
             (select mes from meses order by mes desc offset 1 limit 1) mes_prev,
             (select avg(coalesce(tot.t, 0)) from meses left join tot using (mes) where meses.mes <> v_cur) prom)
    select jsonb_build_object(
      'umbral', v_umbral, 'mes', v_cur,
      'total_mes', total_mes,
      'mes_anterior', mes_prev,
      'total_mes_anterior', coalesce((select t from tot where mes = k.mes_prev), 0),
      'ticket_promedio', case when n_mes > 0 then total_mes / n_mes else 0 end,
      'consumos_mes', n_mes,
      'grandes_mes', grandes_mes,
      'pct_goteo', case when total_mes + grandes_mes > 0 then round(total_mes / (total_mes + grandes_mes) * 100) else 0 end,
      'promedio_mensual', coalesce(prom, total_mes),
      'total_por_mes', coalesce((select jsonb_object_agg(mes, t) from tot), '{}'::jsonb),
      'grandes_por_mes', coalesce((select jsonb_object_agg(mes, t) from tg), '{}'::jsonb),
      'por_categoria_mes', coalesce((select jsonb_object_agg(categoria, m) from (
          select categoria, jsonb_object_agg(mes, s) m from (select categoria, mes, sum(ars) s from got group by categoria, mes) a group by categoria) b), '{}'::jsonb),
      'comercios', coalesce((select jsonb_agg(jsonb_build_object('comercio', comercio, 'veces', veces, 'total_ars', total, 'emoji', emoji, 'categoria', categoria) order by total desc)
          from (select comercio, count(*) veces, sum(ars) total, min(emoji) emoji, min(categoria) categoria from got group by comercio) c), '[]'::jsonb),
      'suscripciones', coalesce((select jsonb_agg(jsonb_build_object('comercio', comercio, 'monto', monto, 'moneda', moneda, 'meses', meses,
          'ids', ids, 'ya_fija', ya_fija, 'anual_ars', anual) order by anual desc) from subs), '[]'::jsonb),
      'goteo_mes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'fecha', to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
          'descripcion', descripcion, 'categoria', categoria, 'emoji', emoji, 'monto', monto, 'moneda', moneda, 'ars', ars) order by occurred_at desc)
          from got where mes = v_cur), '[]'::jsonb),
      'grandes_mes_lista', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'fecha', to_char(occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
          'descripcion', descripcion, 'categoria', categoria, 'emoji', emoji, 'monto', monto, 'moneda', moneda, 'ars', ars) order by ars desc)
          from gra where mes = v_cur), '[]'::jsonb),
      'detalle', case when p_detalle then jsonb_build_object(
          'goteo', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'mes', mes, 'descripcion', descripcion, 'categoria', categoria, 'ars', ars) order by occurred_at desc), '[]'::jsonb) from got),
          'grandes', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'mes', mes, 'descripcion', descripcion, 'categoria', categoria, 'ars', ars) order by ars desc), '[]'::jsonb) from gra)) end,
      'reglas', jsonb_build_array(
        'categorias evitables: Delivery, Comida, Ocio, Transporte y Compras; sin cuotas, sin suscripciones y sin tramites (multas, patentes, impuestos, seguros...)',
        'goteo = tickets <= umbral (percentil 70 auto-calibrado, redondeado a $500, minimo $2.000). Es el total de la pantalla',
        'grandes = > umbral: contexto, NO entran en el total',
        'suscripcion = mismo comercio y MISMO monto en 3 meses (2 si el nombre la delata); anual_ars a cotizacion de hoy',
        'cotizacion congelada del dia de cada gasto; mes argentino'))
    from k);
end $$;
comment on function public.q_hormiga(int, numeric, boolean) is
'Gastos hormiga: goteo del mes (tickets chicos evitables), umbral, comparación con el mes anterior, promedio mensual, comercios que más se repiten, consumos grandes y suscripciones detectadas por monto repetido (pantalla Gastos hormiga). p_umbral fuerza el umbral; p_detalle trae todos los consumos. Ejemplo: select q_hormiga(); select q_hormiga(12, 10000);';

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'q\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
