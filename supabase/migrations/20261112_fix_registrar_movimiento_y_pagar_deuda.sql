-- fix_registrar_movimiento_y_pagar_deuda (versión 20261112020801 en la base).
-- La aplicó otra sesión de Claude (desde claude.ai, con el conector de Supabase) el
-- 2026-11-11 por la noche, entre 036c y 036d. Se copia acá tal cual quedó registrada
-- en supabase_migrations.schema_migrations para que el repo refleje la base.
-- La 037 le suma 'ajuste' al CHECK y le saca a anon el permiso sobre pagar_deuda.

-- 1) activity_log acepta los movimientos cargados por chat
alter table public.activity_log drop constraint activity_log_kind_check;
alter table public.activity_log add constraint activity_log_kind_check
  check (kind = any (array['split','exchange','debt_payment','movimiento']));

-- 2) pagar_deuda: fecha, medio y pago en otra moneda (opcionales; llamadas viejas siguen igual)
drop function public.pagar_deuda(bigint, numeric, text);
create function public.pagar_deuda(p_debt_id bigint, p_monto numeric default null, p_nota text default null,
  p_fecha timestamptz default null, p_medio text default null,
  p_moneda_pago text default null, p_monto_pago numeric default null)
returns jsonb language plpgsql set search_path to 'public' as $function$
declare
  d public.debts; v_nombre text; v_cat bigint; v_pm bigint; v_pagado numeric; v_saldo numeric; v_monto numeric;
  v_desc text; v_tx bigint; v_pago bigint; v_salda boolean;
  v_fecha timestamptz := coalesce(p_fecha, now());
  v_mon_tx text; v_monto_tx numeric; v_fx numeric;
begin
  select * into d from public.debts where id = p_debt_id for update;
  if not found then raise exception 'No existe la deuda %', p_debt_id; end if;
  select coalesce(sum(amount), 0) into v_pagado from public.debt_payments where debt_id = p_debt_id;
  v_saldo := greatest(d.amount - v_pagado, 0);
  if p_monto is null then v_monto := v_saldo;
  else
    if p_monto <= 0 then raise exception 'El pago tiene que ser mayor a cero'; end if;
    if p_monto > v_saldo + 0.5 then raise exception 'El pago (%) supera el saldo pendiente (%)', p_monto, v_saldo; end if;
    v_monto := p_monto;
  end if;
  -- ⚠️ El atajo mira `p_monto is null` (pidió SALDAR) y el SALDO, no el monto del pago (prueba adversarial 19/08).
  if p_monto is null and v_saldo <= 0.5 then
    update public.debts set status = 'settled', settled_at = coalesce(settled_at, now()) where id = p_debt_id;
    return jsonb_build_object('debt_id', p_debt_id, 'pago_id', null, 'tx_id', null, 'monto', 0, 'saldada', true, 'restante', 0);
  end if;

  v_mon_tx := upper(coalesce(p_moneda_pago, d.currency));
  if v_mon_tx <> d.currency then
    if p_monto_pago is null or p_monto_pago <= 0 then
      raise exception 'Pago en otra moneda: falta p_monto_pago (cuánto entró/salió en %)', v_mon_tx; end if;
    if v_mon_tx <> 'ARS' and d.currency <> 'ARS' then
      raise exception 'Pago en otra moneda solo entre ARS y USD/USDT'; end if;
    v_monto_tx := p_monto_pago;
    v_fx := case when v_mon_tx = 'ARS' then p_monto_pago / v_monto else v_monto / p_monto_pago end;
  else
    v_monto_tx := v_monto;
  end if;

  select name into v_nombre from public.persons where id = d.person_id;
  v_nombre := coalesce(v_nombre, 'alguien');
  select id into v_cat from public.categories where name = 'Préstamos' limit 1;
  if v_cat is null then raise exception 'Falta la categoría "Préstamos". Creala antes de registrar movimientos de deuda.'; end if;
  if p_medio is not null then
    select id into v_pm from public.payment_methods
     where translate(lower(name), 'áéíóú', 'aeiou') like '%' || translate(lower(btrim(p_medio)), 'áéíóú', 'aeiou') || '%'
     order by length(name) limit 1;
  end if;
  if v_pm is null then select id into v_pm from public.payment_methods where name ilike '%efectivo%' limit 1; end if;

  v_desc := case when d.direction = 'to_collect' then 'Cobro a ' else 'Pago a ' end || v_nombre
         || coalesce(' (' || nullif(d.description, '') || ')', '')
         || coalesce(' · ' || nullif(trim(p_nota), ''), '');

  insert into public.transactions (user_id, type, amount, currency, category_id, payment_method_id, description, is_paid, source, occurred_at)
  values (d.user_id, (case when d.direction = 'to_collect' then 'ingreso' else 'egreso' end)::public.tx_type,
          v_monto_tx, v_mon_tx, v_cat, v_pm, v_desc, true, 'manual', v_fecha)
  returning id into v_tx;

  insert into public.debt_payments (user_id, debt_id, amount, transaction_id, occurred_at, fx_rate_ars)
  values (d.user_id, p_debt_id, v_monto, v_tx, v_fecha, v_fx)
  returning id into v_pago;

  v_salda := (v_saldo - v_monto) <= 0.5;
  if v_salda then update public.debts set status = 'settled', settled_at = v_fecha where id = p_debt_id; end if;

  insert into public.activity_log (user_id, kind, label, detail)
  values (d.user_id, 'debt_payment', 'Pago de ' || public.fmt_es_ar(v_monto_tx) || ' ' || v_mon_tx || ' de ' || v_nombre,
          jsonb_build_object('debtId', p_debt_id, 'paymentId', v_pago, 'txId', v_tx, 'saldoLaDeuda', v_salda));

  return jsonb_build_object('debt_id', p_debt_id, 'pago_id', v_pago, 'tx_id', v_tx, 'monto', v_monto, 'moneda_deuda', d.currency,
                            'pagado_en', jsonb_build_object('monto', v_monto_tx, 'moneda', v_mon_tx),
                            'saldada', v_salda, 'restante', greatest(v_saldo - v_monto, 0));
end;
$function$;
grant execute on function public.pagar_deuda(bigint, numeric, text, timestamptz, text, text, numeric) to anon, authenticated, service_role;

-- 3) registrar_movimiento: comparación enum/texto y pasar fecha y medio al cobro de deudas
do $$
declare src text;
begin
  src := pg_get_functiondef('public.registrar_movimiento'::regproc);
  if position('and d.direction = case' in src) = 0 or position('public.pagar_deuda(v_debt.deuda_id, v_debt.paga, v_desc)' in src) = 0 then
    raise exception 'registrar_movimiento cambió: revisar a mano'; end if;
  src := replace(src, 'and d.direction = case', 'and d.direction::text = case');
  src := replace(src, 'public.pagar_deuda(v_debt.deuda_id, v_debt.paga, v_desc)', 'public.pagar_deuda(v_debt.deuda_id, v_debt.paga, v_desc, v_fecha, p_medio)');
  execute src;
end $$;
