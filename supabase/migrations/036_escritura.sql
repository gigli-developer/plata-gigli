-- 036 · Escritura segura: registrar_movimiento, registrar_ajuste y deshacer_operacion.
--
-- Claude escribe SOLO por acá (nunca INSERT directo). Las tres funciones son de
-- dos pasos: sin p_confirmar devuelven la fila que VAN a escribir (para mostrarla y
-- pedir confirmación); con p_confirmar => true escriben. Todo lo que escriben deja
-- una fila en activity_log, así se puede deshacer.
--
-- Categoría nueva "Ajuste": mueve el saldo pero, como Cambio Divisas y Préstamos,
-- NO cuenta como gasto ni ingreso. Se agrega a las exclusiones de get_metrics y de
-- la capa q_ (q__tx, q_movimientos).

insert into public.rollback_funciones (migracion, funcion, definicion)
select '036', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('get_metrics', 'q__tx', 'q_movimientos', 'registrar_movimiento', 'registrar_ajuste', 'deshacer_operacion', 'q__usuario');

-- ── Categoría Ajuste ───────────────────────────────────────────────────────
insert into public.categories (user_id, name, emoji, kind)
select distinct c.user_id, 'Ajuste', '⚖️', 'ambos'::public.cat_kind
from public.categories c
where not exists (select 1 from public.categories x where x.user_id = c.user_id and x.name = 'Ajuste');

do $$
declare d text;
begin
  d := pg_get_functiondef('public.get_metrics()'::regprocedure);
  d := replace(d, $q$not in ('Cambio Divisas','Préstamos')$q$, $q$not in ('Cambio Divisas','Préstamos','Ajuste')$q$);
  execute d;
  d := pg_get_functiondef('public.q__tx(timestamptz,timestamptz,numeric,numeric)'::regprocedure);
  d := replace(d, $q$not in ('Cambio Divisas', 'Préstamos')$q$, $q$not in ('Cambio Divisas', 'Préstamos', 'Ajuste')$q$);
  execute d;
  d := pg_get_functiondef('public.q_movimientos(date,date,text,text,text,int)'::regprocedure);
  d := replace(d, $q$not in ('Cambio Divisas','Préstamos')$q$, $q$not in ('Cambio Divisas','Préstamos','Ajuste')$q$);
  execute d;
end $$;

-- Dueño de los datos: la sesión si la hay; si no (Claude por el conector, con
-- service role), el único usuario de Plata.
create or replace function public.q__usuario() returns uuid
language sql stable set search_path = public as
$$ select coalesce(auth.uid(), (select user_id from public.categories order by id limit 1)) $$;

-- ── registrar_movimiento ───────────────────────────────────────────────────
create or replace function public.registrar_movimiento(
  p_tipo text, p_monto numeric, p_moneda text default 'ARS', p_descripcion text default null,
  p_categoria text default null, p_medio text default null, p_fecha timestamptz default null,
  p_tarjeta text default null, p_persona text default null,
  p_moneda_destino text default null, p_monto_destino numeric default null,
  p_confirmar boolean default false) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_uid uuid := public.q__usuario();
  v_tipo text := lower(btrim(coalesce(p_tipo, '')));
  v_moneda text := upper(btrim(coalesce(p_moneda, 'ARS')));
  v_fecha timestamptz := coalesce(p_fecha, now());
  v_dia date := (coalesce(p_fecha, now()) at time zone 'America/Argentina/Buenos_Aires')::date;
  v_desc text := nullif(btrim(coalesce(p_descripcion, '')), '');
  v_norm text;
  v_cat record; v_pm record; v_card record; v_st record; v_per record; v_debt record;
  v_rule_cat bigint; v_rename text; v_rule_moneda text; v_hora int; v_dow int; r record;
  v_avisos text[] := '{}'; v_es_credito boolean := false; v_es_debito boolean := false;
  v_st_id bigint; v_st_nuevo jsonb; v_close date; v_due date; v_cd int; v_dd int; v_off int;
  v_fila jsonb; v_tx bigint; v_ex bigint; v_rate numeric; v_rest numeric; v_aplica numeric; v_pagos jsonb := '[]'::jsonb;
  v_pendiente numeric; v_res jsonb; v_dups jsonb; v_card_id bigint; v_card_label text;
begin
  -- 1. Validaciones generales
  if v_uid is null then raise exception 'No hay usuario: llamá con sesión o desde el conector de Supabase'; end if;
  if v_tipo not in ('egreso', 'ingreso', 'transferencia') then
    raise exception 'p_tipo tiene que ser egreso, ingreso o transferencia (vino "%")', p_tipo; end if;
  if p_monto is null or p_monto <= 0 then raise exception 'p_monto tiene que ser mayor a cero (vino %)', p_monto; end if;
  if v_moneda not in ('ARS', 'USD', 'USDT') then raise exception 'p_moneda tiene que ser ARS, USD o USDT (vino %)', p_moneda; end if;
  if v_fecha > now() + interval '5 minutes' then raise exception 'La fecha no puede ser futura (%)', v_fecha; end if;

  -- 2. Transferencia entre monedas = cambio de divisas (mueve los dos saldos)
  if v_tipo = 'transferencia' then
    if p_moneda_destino is null or p_monto_destino is null or p_monto_destino <= 0 then
      raise exception 'Una transferencia entre monedas necesita p_moneda_destino y p_monto_destino. Entre cuentas propias de la MISMA moneda no hay nada que registrar: Plata no separa cuentas.'; end if;
    if upper(p_moneda_destino) not in ('ARS', 'USD', 'USDT') or upper(p_moneda_destino) = v_moneda then
      raise exception 'p_moneda_destino tiene que ser ARS, USD o USDT y distinta de p_moneda'; end if;
    v_rate := case when v_moneda = 'ARS' then p_monto / p_monto_destino
                   when upper(p_moneda_destino) = 'ARS' then p_monto_destino / p_monto
                   else p_monto_destino / p_monto end;
    v_fila := jsonb_build_object('operacion', 'cambio de moneda', 'sale', jsonb_build_object('monto', p_monto, 'moneda', v_moneda),
      'entra', jsonb_build_object('monto', p_monto_destino, 'moneda', upper(p_moneda_destino)), 'tasa', v_rate,
      'fecha', to_char(v_fecha at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI'),
      'efecto', 'dos movimientos "Cambio Divisas": baja el saldo de ' || v_moneda || ' y sube el de ' || upper(p_moneda_destino) || '. No cuenta como gasto ni ingreso.');
    if not p_confirmar then
      return jsonb_build_object('ok', true, 'confirmado', false, 'fila', v_fila, 'avisos', to_jsonb(v_avisos),
        'para_confirmar', 'volver a llamar con los mismos datos y p_confirmar => true');
    end if;
    v_ex := public.register_exchange(v_moneda, upper(p_moneda_destino), p_monto, p_monto_destino, v_rate, 'manual', v_uid, v_fecha);
    insert into public.activity_log (user_id, kind, label, detail)
    values (v_uid, 'exchange', 'Cambio de ' || public.fmt_es_ar(p_monto) || ' ' || v_moneda || ' a ' || public.fmt_es_ar(p_monto_destino) || ' ' || upper(p_moneda_destino),
            jsonb_build_object('exchangeId', v_ex));
    return jsonb_build_object('ok', true, 'confirmado', true, 'cambio_id', v_ex, 'fila', v_fila);
  end if;

  if v_desc is null then raise exception 'Falta p_descripcion (qué fue: comercio, concepto o de quién)'; end if;

  -- 3. Pago de una deuda con una persona (ingreso = te pagan; egreso = le pagás)
  if p_persona is not null then
    select * into r from public.persons p where lower(p.name) = lower(btrim(p_persona));
    if not found then
      raise exception 'No conozco a "%". Personas: %', p_persona, (select string_agg(name, ', ' order by name) from public.persons); end if;
    v_rest := p_monto;
    for v_debt in
      select d.*, greatest(d.amount - coalesce((select sum(dp.amount) from public.debt_payments dp where dp.debt_id = d.id), 0), 0) pend
      from public.debts d
      where d.person_id = r.id and d.status = 'pending' and d.currency = v_moneda
        and d.direction = case when v_tipo = 'ingreso' then 'to_collect' else 'to_pay' end
      order by d.occurred_at loop
      exit when v_rest <= 0;
      continue when v_debt.pend <= 0;
      v_aplica := least(v_rest, v_debt.pend);
      v_pagos := v_pagos || jsonb_build_object('deuda_id', v_debt.id, 'descripcion', v_debt.description, 'pendiente', v_debt.pend,
                                               'paga', v_aplica, 'queda', v_debt.pend - v_aplica);
      v_rest := v_rest - v_aplica;
    end loop;
    if jsonb_array_length(v_pagos) = 0 then
      raise exception 'No hay deudas pendientes en % con % (%). Si es un préstamo nuevo, cargalo desde la pantalla Deudas.',
        v_moneda, r.name, case when v_tipo = 'ingreso' then 'que te deba' else 'que le debas' end; end if;
    if v_rest > 0.5 then
      raise exception 'El monto (% %) supera lo pendiente con % (% %). Revisá el monto o cargá el resto como movimiento aparte.',
        p_monto, v_moneda, r.name, p_monto - v_rest, v_moneda; end if;
    v_fila := jsonb_build_object('operacion', case when v_tipo = 'ingreso' then 'cobro de deuda' else 'pago de deuda' end,
      'persona', r.name, 'monto', p_monto, 'moneda', v_moneda, 'pagos', v_pagos,
      'efecto', 'cada pago crea un movimiento "Préstamos" (mueve el saldo, no es gasto/ingreso) y baja lo pendiente de la deuda');
    if not p_confirmar then
      return jsonb_build_object('ok', true, 'confirmado', false, 'fila', v_fila, 'avisos', to_jsonb(v_avisos),
        'para_confirmar', 'volver a llamar con los mismos datos y p_confirmar => true');
    end if;
    for v_debt in select * from jsonb_to_recordset(v_pagos) as x(deuda_id bigint, paga numeric) loop
      v_res := public.pagar_deuda(v_debt.deuda_id, v_debt.paga, v_desc);
    end loop;
    return jsonb_build_object('ok', true, 'confirmado', true, 'fila', v_fila);
  end if;

  -- 4. Gasto o ingreso común
  if p_medio is null then
    raise exception 'Falta p_medio. Opciones: %', (select string_agg(name, ', ' order by id) from public.payment_methods); end if;
  select * into v_pm from public.payment_methods pm
   where translate(lower(pm.name), 'áéíóú', 'aeiou') = translate(lower(btrim(p_medio)), 'áéíóú', 'aeiou')
      or translate(lower(pm.name), 'áéíóú', 'aeiou') like '%' || translate(lower(btrim(p_medio)), 'áéíóú', 'aeiou') || '%'
   order by length(pm.name) limit 1;
  if not found then
    raise exception 'Medio "%" desconocido. Opciones: %', p_medio, (select string_agg(name, ', ' order by id) from public.payment_methods); end if;
  v_es_credito := translate(lower(v_pm.name), 'áéíóú', 'aeiou') like '%credito%';
  v_es_debito := translate(lower(v_pm.name), 'áéíóú', 'aeiou') like '%debito%';
  if v_es_credito and v_tipo = 'ingreso' then
    raise exception 'Un ingreso no se carga con tarjeta de crédito (no entra plata a la caja). Usá Transferencia o Efectivo.'; end if;

  if v_es_credito or v_es_debito then
    if p_tarjeta is null then
      raise exception 'Con % hay que decir qué tarjeta (p_tarjeta: nombre o últimos 4). Tarjetas: %', v_pm.name,
        (select string_agg(name || ' ' || coalesce(last4, ''), ', ' order by id) from public.cards where not is_archived
          and public.q__es_credito(network, name) = v_es_credito); end if;
    select * into v_card from public.cards ca
     where not ca.is_archived and public.q__es_credito(ca.network, ca.name) = v_es_credito
       and (ca.last4 = btrim(p_tarjeta) or lower(ca.name) = lower(btrim(p_tarjeta)) or lower(ca.name) like '%' || lower(btrim(p_tarjeta)) || '%')
     order by (ca.last4 = btrim(p_tarjeta)) desc, length(ca.name) limit 1;
    if found then v_card_id := v_card.id; v_card_label := v_card.name || ' ' || coalesce(v_card.last4, ''); end if;
    if not found then
      raise exception 'No encontré la tarjeta "%" de % . Tarjetas: %', p_tarjeta, v_pm.name,
        (select string_agg(name || ' ' || coalesce(last4, ''), ', ' order by id) from public.cards where not is_archived
          and public.q__es_credito(network, name) = v_es_credito); end if;
  elsif p_tarjeta is not null then
    raise exception 'p_tarjeta solo va con Tarjeta de Crédito o de Débito (el medio es %)', v_pm.name;
  end if;

  -- Reglas de /reglas, igual que el importador: contra la descripción ORIGINAL; cada
  -- acción la define la primera regla (prioridad desc, id asc) que la tenga.
  v_hora := extract(hour from v_fecha at time zone 'America/Argentina/Buenos_Aires')::int;
  v_dow := extract(isodow from v_fecha at time zone 'America/Argentina/Buenos_Aires')::int;
  for r in select * from public.rules where is_active order by priority desc, id asc loop
    if r.text_value is not null then
      continue when not case r.text_op
        when 'starts' then lower(v_desc) like lower(r.text_value) || '%'
        when 'equals' then lower(v_desc) = lower(r.text_value)
        else position(lower(r.text_value) in lower(v_desc)) > 0 end;
    end if;
    if r.hour_from is not null or r.hour_to is not null then
      continue when not case when coalesce(r.hour_from, 0) <= coalesce(r.hour_to, 23)
        then v_hora between coalesce(r.hour_from, 0) and coalesce(r.hour_to, 23)
        else v_hora >= coalesce(r.hour_from, 0) or v_hora <= coalesce(r.hour_to, 23) end;
    end if;
    continue when r.days is not null and array_length(r.days, 1) > 0 and not (v_dow = any(r.days));
    continue when r.amount_min is not null and p_monto < r.amount_min;
    continue when r.amount_max is not null and p_monto > r.amount_max;
    if v_rule_cat is null and r.category_id is not null then v_rule_cat := r.category_id; end if;
    if v_rename is null and r.rename_to is not null then v_rename := r.rename_to; end if;
    if v_rule_moneda is null and r.set_currency is not null then v_rule_moneda := r.set_currency; end if;
  end loop;
  if v_rule_moneda is not null and v_rule_moneda <> v_moneda then
    v_avisos := v_avisos || format('Hay una regla que en los mails del banco pasa "%s" a %s. Acá NO se aplica: se carga en la moneda que indicaste (%s).', v_desc, v_rule_moneda, v_moneda);
  end if;

  -- Categoría: la indicada; si no, la de la regla. Nunca las que no son gasto/ingreso.
  if p_categoria is not null then
    select * into v_cat from public.categories c
     where translate(lower(c.name), 'áéíóú', 'aeiou') = translate(lower(btrim(p_categoria)), 'áéíóú', 'aeiou');
    if not found then
      raise exception 'Categoría "%" desconocida. Opciones: %', p_categoria,
        (select string_agg(name, ', ' order by name) from public.categories where name not in ('Cambio Divisas', 'Préstamos', 'Ajuste')); end if;
    if v_rule_cat is not null and v_rule_cat <> v_cat.id then
      v_avisos := v_avisos || format('Una regla la clasificaría como %s; queda la que indicaste (%s).',
                                     (select name from public.categories where id = v_rule_cat), v_cat.name);
    end if;
  elsif v_rule_cat is not null then
    select * into v_cat from public.categories where id = v_rule_cat;
    v_avisos := v_avisos || format('Categoría %s puesta por una regla.', v_cat.name);
  else
    raise exception 'Falta p_categoria. Opciones: %',
      (select string_agg(name, ', ' order by name) from public.categories where name not in ('Cambio Divisas', 'Préstamos', 'Ajuste')
         and kind::text in (v_tipo, 'ambos'));
  end if;
  if v_cat.name in ('Cambio Divisas', 'Préstamos', 'Ajuste') then
    raise exception 'La categoría % no se carga acá: cambio de moneda → p_tipo transferencia; deuda → p_persona; ajuste de saldo → registrar_ajuste()', v_cat.name; end if;
  if v_cat.kind::text not in (v_tipo, 'ambos') then
    raise exception 'La categoría % es de %, no de %', v_cat.name, v_cat.kind, v_tipo; end if;

  v_norm := coalesce(v_rename, v_desc);

  -- Resumen de tarjeta de crédito: el primero que cierra en o después de la fecha.
  if v_es_credito then
    select * into v_st from public.card_statements cs where cs.card_id = v_card.id and cs.closing_date >= v_dia order by cs.closing_date limit 1;
    if found then
      if v_st.is_paid then
        raise exception 'El resumen % de % ya está pagado (total congelado). Un consumo de esa fecha no cambiaría nada: revisá la fecha.', v_st.period_label, v_card.name; end if;
      v_st_id := v_st.id;
      v_st_nuevo := jsonb_build_object('id', v_st.id, 'periodo', v_st.period_label, 'cierre', v_st.closing_date, 'nuevo', false);
    else
      if v_card.closing_day is null then
        raise exception 'La tarjeta % no tiene día de cierre: no sé a qué resumen va. Cargalo en Tarjetas.', v_card.name; end if;
      v_cd := v_card.closing_day; v_dd := coalesce(v_card.due_day, v_card.closing_day);
      v_off := case when extract(day from v_dia) <= v_cd then 0 else 1 end;
      v_close := (date_trunc('month', v_dia) + make_interval(months => v_off))::date;
      v_close := v_close + (least(v_cd, extract(day from (v_close + interval '1 month' - interval '1 day'))::int) - 1);
      v_due := (date_trunc('month', v_close) + make_interval(months => case when v_dd < v_cd then 1 else 0 end))::date;
      v_due := v_due + (least(v_dd, extract(day from (v_due + interval '1 month' - interval '1 day'))::int) - 1);
      v_st_nuevo := jsonb_build_object('periodo', to_char(v_close, 'YYYY-MM'), 'cierre', v_close, 'vence', v_due, 'nuevo', true);
    end if;
  end if;

  -- Posibles duplicados: mismo monto y moneda, ±1 día.
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'fecha', to_char(t.occurred_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI'),
           'descripcion', t.description, 'origen', t.source)), '[]'::jsonb)
    into v_dups from public.transactions t
   where t.amount = p_monto and t.currency = v_moneda and t.type::text = v_tipo
     and t.occurred_at between v_fecha - interval '1 day' and v_fecha + interval '1 day';
  if jsonb_array_length(v_dups) > 0 then
    v_avisos := v_avisos || format('Ya hay %s movimiento(s) del mismo monto y moneda en ±1 día: ¿no está cargado? %s', jsonb_array_length(v_dups), v_dups::text);
  end if;

  v_fila := jsonb_build_object(
    'tipo', v_tipo, 'monto', p_monto, 'moneda', v_moneda, 'descripcion', v_norm,
    'categoria', v_cat.name, 'medio', v_pm.name, 'tarjeta', v_card_label,
    'resumen', v_st_nuevo,
    'fecha', to_char(v_fecha at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI'),
    'efecto_en_saldo', case when v_es_credito then 'ninguno hoy: es deuda de la tarjeta hasta que pagues el resumen'
                            when v_tipo = 'ingreso' then 'suma ' || public.fmt_es_ar(p_monto) || ' al saldo en ' || v_moneda
                            else 'resta ' || public.fmt_es_ar(p_monto) || ' del saldo en ' || v_moneda end,
    'cuenta_como', case when v_tipo = 'ingreso' then 'ingreso' else 'gasto' end || ' de ' || v_cat.name);
  if not p_confirmar then
    return jsonb_build_object('ok', true, 'confirmado', false, 'fila', v_fila, 'avisos', to_jsonb(v_avisos),
      'para_confirmar', 'mostrar la fila, pedir confirmacion y volver a llamar con los mismos datos y p_confirmar => true');
  end if;

  if v_es_credito and v_st_id is null then
    insert into public.card_statements (user_id, card_id, period_label, closing_date, due_date)
    values (v_uid, v_card.id, to_char(v_close, 'YYYY-MM'), v_close, v_due)
    on conflict (card_id, period_label) do nothing;
    select id into v_st_id from public.card_statements where card_id = v_card.id and period_label = to_char(v_close, 'YYYY-MM');
  end if;

  insert into public.transactions (user_id, type, nature, category_id, payment_method_id, amount, currency, description,
                                   is_paid, card_id, statement_id, occurred_at, source)
  values (v_uid, v_tipo::public.tx_type, 'variable', v_cat.id, v_pm.id, p_monto, v_moneda, v_norm,
          not v_es_credito, v_card_id, v_st_id, v_fecha, 'chat')
  returning id into v_tx;

  insert into public.activity_log (user_id, kind, label, detail)
  values (v_uid, 'movimiento',
          case when v_tipo = 'ingreso' then 'Ingreso' else 'Gasto' end || ' de ' || public.fmt_es_ar(p_monto) || ' ' || v_moneda || ' · ' || v_norm,
          jsonb_build_object('txId', v_tx));

  return jsonb_build_object('ok', true, 'confirmado', true, 'transaccion_id', v_tx, 'fila', v_fila, 'avisos', to_jsonb(v_avisos));
end $$;
comment on function public.registrar_movimiento(text, numeric, text, text, text, text, timestamptz, text, text, text, numeric, boolean) is
'ÚNICA forma de cargar movimientos. p_tipo egreso|ingreso|transferencia (cambio entre monedas, con p_moneda_destino y p_monto_destino). Con p_persona registra un cobro/pago de deuda. Aplica las reglas de /reglas, asigna el resumen de la tarjeta, valida todo y avisa posibles duplicados. Sin p_confirmar devuelve la fila a mostrar; con p_confirmar => true escribe y deja registro para deshacer. Ejemplo: select registrar_movimiento(''egreso'', 5600, ''ARS'', ''Café'', ''Comida'', ''Efectivo''); select registrar_movimiento(''egreso'', 18500, ''ARS'', ''Rappi'', ''Delivery'', ''Tarjeta de Crédito'', p_tarjeta => ''2811'', p_confirmar => true);';

-- ── registrar_ajuste ───────────────────────────────────────────────────────
create or replace function public.registrar_ajuste(p_moneda text, p_monto numeric, p_motivo text, p_confirmar boolean default false) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  v_uid uuid := public.q__usuario();
  v_moneda text := upper(btrim(coalesce(p_moneda, '')));
  v_cat bigint; v_saldo numeric; v_tx bigint; v_fila jsonb;
begin
  if v_moneda not in ('ARS', 'USD', 'USDT') then raise exception 'p_moneda tiene que ser ARS, USD o USDT'; end if;
  if p_monto is null or p_monto = 0 then raise exception 'p_monto es la diferencia a corregir: positivo suma al saldo, negativo resta'; end if;
  if nullif(btrim(coalesce(p_motivo, '')), '') is null then raise exception 'Falta p_motivo (por qué se ajusta: ej. "conciliación con el extracto de Galicia al 08/11")'; end if;
  select id into v_cat from public.categories where name = 'Ajuste' and user_id = v_uid;
  if v_cat is null then raise exception 'No existe la categoría Ajuste (migración 036)'; end if;
  v_saldo := (public.q_saldos()->>lower(v_moneda))::numeric;
  v_fila := jsonb_build_object('tipo', case when p_monto > 0 then 'ingreso' else 'egreso' end, 'monto', abs(p_monto), 'moneda', v_moneda,
    'categoria', 'Ajuste', 'descripcion', 'Ajuste: ' || btrim(p_motivo),
    'saldo_actual', v_saldo, 'saldo_despues', v_saldo + p_monto,
    'efecto', 'mueve el saldo pero NO cuenta como gasto ni ingreso');
  if not p_confirmar then
    return jsonb_build_object('ok', true, 'confirmado', false, 'fila', v_fila,
      'para_confirmar', 'mostrar la fila, pedir confirmacion y volver a llamar con p_confirmar => true');
  end if;
  insert into public.transactions (user_id, type, nature, category_id, payment_method_id, amount, currency, description, is_paid, occurred_at, source)
  values (v_uid, (case when p_monto > 0 then 'ingreso' else 'egreso' end)::public.tx_type, 'variable', v_cat, null,
          abs(p_monto), v_moneda, 'Ajuste: ' || btrim(p_motivo), true, now(), 'chat')
  returning id into v_tx;
  insert into public.activity_log (user_id, kind, label, detail)
  values (v_uid, 'ajuste', 'Ajuste de ' || public.fmt_es_ar(p_monto) || ' ' || v_moneda || ' · ' || btrim(p_motivo), jsonb_build_object('txId', v_tx));
  return jsonb_build_object('ok', true, 'confirmado', true, 'transaccion_id', v_tx, 'fila', v_fila);
end $$;
comment on function public.registrar_ajuste(text, numeric, text, boolean) is
'Cuadra el saldo de una moneda contra el real: p_monto = diferencia (positivo suma, negativo resta). Queda como categoría Ajuste, que mueve el saldo sin contar como gasto/ingreso. Para cuadrar: diferencia = saldo real - q_saldos(). Ejemplo: select registrar_ajuste(''ARS'', -87805, ''Conciliación con extracto Galicia''); y después con p_confirmar => true.';

-- ── deshacer_operacion ─────────────────────────────────────────────────────
create or replace function public.deshacer_operacion(p_id bigint default null, p_confirmar boolean default false) returns jsonb
language plpgsql volatile set search_path = public as $$
declare
  op record; d jsonb; v_pagado numeric; v_monto numeric;
begin
  select * into op from public.activity_log a
   where a.undone_at is null and (p_id is null or a.id = p_id)
   order by a.created_at desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'No hay nada para deshacer'); end if;
  d := coalesce(op.detail, '{}'::jsonb);
  if not p_confirmar then
    return jsonb_build_object('ok', true, 'confirmado', false,
      'operacion', jsonb_build_object('id', op.id, 'tipo', op.kind, 'descripcion', op.label,
        'cuando', to_char(op.created_at at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI')),
      'que_hace', case op.kind
        when 'movimiento' then 'borra el movimiento'
        when 'ajuste' then 'borra el ajuste: el saldo vuelve a como estaba'
        when 'exchange' then 'borra el cambio y sus dos movimientos'
        when 'debt_payment' then 'borra el pago y su movimiento; si había saldado la deuda, vuelve a pendiente'
        when 'split' then 'junta el gasto otra vez en un movimiento y borra las deudas que había creado'
        else 'no sé deshacer este tipo' end,
      'para_confirmar', 'volver a llamar con p_id => ' || op.id || ', p_confirmar => true');
  end if;

  if op.kind in ('movimiento', 'ajuste') then
    delete from public.transactions where id = (d->>'txId')::bigint;
  elsif op.kind = 'exchange' then
    delete from public.transactions where exchange_id = (d->>'exchangeId')::bigint;
    delete from public.currency_exchanges where id = (d->>'exchangeId')::bigint;
  elsif op.kind = 'debt_payment' then
    if d ? 'txId' and d->>'txId' is not null then delete from public.transactions where id = (d->>'txId')::bigint; end if;
    delete from public.debt_payments where id = (d->>'paymentId')::bigint;
    if coalesce((d->>'saldoLaDeuda')::boolean, false) then
      update public.debts set status = 'pending', settled_at = null where id = (d->>'debtId')::bigint;
    end if;
  elsif op.kind = 'split' then
    update public.transactions set amount = (d->>'montoOriginal')::numeric, description = d->>'descOriginal' where id = (d->>'originalTxId')::bigint;
    if d->>'hermanaTxId' is not null then delete from public.transactions where id = (d->>'hermanaTxId')::bigint; end if;
    if d ? 'debtIds' then delete from public.debts where id in (select (jsonb_array_elements_text(d->'debtIds'))::bigint); end if;
  else
    raise exception 'No sé deshacer una operación de tipo %', op.kind;
  end if;
  update public.activity_log set undone_at = now() where id = op.id;
  return jsonb_build_object('ok', true, 'confirmado', true, 'deshecho', op.label);
end $$;
comment on function public.deshacer_operacion(bigint, boolean) is
'Deshace la última operación registrada (o la p_id): movimiento, ajuste, cambio de moneda, pago de deuda o división de gasto. Sin p_confirmar muestra qué va a deshacer. Las filas borradas quedan en la papelera. Ejemplo: select deshacer_operacion(); select deshacer_operacion(41, true);';

revoke all on function public.registrar_movimiento(text, numeric, text, text, text, text, timestamptz, text, text, text, numeric, boolean) from public, anon;
revoke all on function public.registrar_ajuste(text, numeric, text, boolean) from public, anon;
revoke all on function public.deshacer_operacion(bigint, boolean) from public, anon;
revoke all on function public.q__usuario() from public, anon;
grant execute on function public.registrar_movimiento(text, numeric, text, text, text, text, timestamptz, text, text, text, numeric, boolean) to authenticated, service_role;
grant execute on function public.registrar_ajuste(text, numeric, text, boolean) to authenticated, service_role;
grant execute on function public.deshacer_operacion(bigint, boolean) to authenticated, service_role;
grant execute on function public.q__usuario() to authenticated, service_role;
