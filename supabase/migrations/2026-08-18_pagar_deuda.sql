-- Pagar o saldar una deuda, de una sola vez.
--
-- Es el espejo atómico de payDebt/settleDebt (lib/db.ts:866-902), que son 2-3
-- escrituras desde el browser con compensación manual — el propio código pedía
-- esto («lo correcto de verdad sería una RPC, como register_exchange», db.ts:841).
-- Adentro de la función: o queda el movimiento + el pago + el estado + el
-- registro de Deshacer, o no queda nada.
--
-- Semántica calcada del código, con dos mejoras deliberadas:
--   1. El lock FOR UPDATE serializa pagos simultáneos sobre la misma deuda
--      (la carrera que PostgREST no podía cerrar).
--   2. TAMBIÉN saldar queda en activity_log: con la app vieja, saldar no era
--      deshacible (solo el pago parcial). El detail respeta la forma exacta
--      que espera deshacerOperacion: {debtId, paymentId, txId, saldoLaDeuda}.
--
-- p_monto NULL = saldar el resto. La moneda es SIEMPRE la de la deuda.
-- `security invoker`: RLS aplica cuando llama la app; el user_id de las filas
-- nuevas sale de la deuda misma (no de auth.uid(), que es NULL vía service_role).

create or replace function public.pagar_deuda(
  p_debt_id bigint,
  p_monto   numeric default null,
  p_nota    text    default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  d        public.debts;
  v_nombre text;
  v_cat    bigint;
  v_pm     bigint;
  v_pagado numeric;
  v_saldo  numeric;
  v_monto  numeric;
  v_desc   text;
  v_tx     bigint;
  v_pago   bigint;
  v_salda  boolean;
begin
  select * into d from public.debts where id = p_debt_id for update;
  if not found then
    raise exception 'No existe la deuda %', p_debt_id;
  end if;

  -- El saldo se calcula ADENTRO del lock: dos pagos simultáneos se serializan
  -- y el segundo ve el saldo que dejó el primero.
  select coalesce(sum(amount), 0) into v_pagado
    from public.debt_payments where debt_id = p_debt_id;
  v_saldo := greatest(d.amount - v_pagado, 0);

  if p_monto is null then
    v_monto := v_saldo;                                   -- saldar el resto
  else
    if p_monto <= 0 then
      raise exception 'El pago tiene que ser mayor a cero';
    end if;
    -- Tolerancia 0.5 EN LA MONEDA DE LA DEUDA, igual que la app (db.ts:890).
    if p_monto > v_saldo + 0.5 then
      raise exception 'El pago (%) supera el saldo pendiente (%)', p_monto, v_saldo;
    end if;
    v_monto := p_monto;
  end if;

  -- Resto despreciable: se asegura el estado y listo, sin movimiento. Es lo que
  -- hace settleDebt con outstanding <= 0.5 (db.ts:874).
  --
  -- ⚠️ La condición mira `p_monto is null` (o sea: pidió SALDAR) y el SALDO, no
  -- el monto del pago. La primera versión comparaba `v_monto <= 0.5` y eso tenía
  -- un agujero que perdía plata: pagar $0,30 de una deuda de $250.000 la marcaba
  -- saldada entera, sin registrar el pago, sin movimiento y sin nada que
  -- deshacer. Lo encontró la prueba adversarial del 19/08 con cinco casos
  -- reproducidos. Un pago chico explícito ahora se registra como cualquier otro.
  if p_monto is null and v_saldo <= 0.5 then
    update public.debts
       set status = 'settled', settled_at = coalesce(settled_at, now())
     where id = p_debt_id;
    return jsonb_build_object('debt_id', p_debt_id, 'pago_id', null, 'tx_id', null,
                              'monto', 0, 'saldada', true, 'restante', 0);
  end if;

  select name into v_nombre from public.persons where id = d.person_id;
  v_nombre := coalesce(v_nombre, 'alguien');

  -- Sin la categoría "Préstamos" la transacción caería en las métricas de gasto
  -- (decisión 3). Mejor fallar que falsear — igual que loanTransaction (db.ts:601).
  select id into v_cat from public.categories where name = 'Préstamos' limit 1;
  if v_cat is null then
    raise exception 'Falta la categoría "Préstamos". Creala antes de registrar movimientos de deuda.';
  end if;
  select id into v_pm from public.payment_methods where name ilike '%efectivo%' limit 1;

  -- Descripción calcada de debtCashMovement (db.ts:825-831).
  v_desc := case when d.direction = 'to_collect' then 'Cobro a ' else 'Pago a ' end
         || v_nombre
         || coalesce(' (' || nullif(d.description, '') || ')', '')
         || coalesce(' · ' || nullif(trim(p_nota), ''), '');

  insert into public.transactions
    (user_id, type, amount, currency, category_id, payment_method_id,
     description, is_paid, source)
  values
    (d.user_id,
     -- El cast es obligatorio: un CASE devuelve text y la columna es el enum
     -- tx_type — sin ::tx_type falla con 42804 (mordió en la primera prueba).
     (case when d.direction = 'to_collect' then 'ingreso' else 'egreso' end)::public.tx_type,
     v_monto, d.currency, v_cat, v_pm, v_desc, true, 'manual')
  returning id into v_tx;

  insert into public.debt_payments (user_id, debt_id, amount, transaction_id)
  values (d.user_id, p_debt_id, v_monto, v_tx)
  returning id into v_pago;

  v_salda := (v_saldo - v_monto) <= 0.5;
  if v_salda then
    update public.debts set status = 'settled', settled_at = now()
     where id = p_debt_id;
  end if;

  insert into public.activity_log (user_id, kind, label, detail)
  values (d.user_id, 'debt_payment',
          'Pago de ' || public.fmt_es_ar(v_monto) || ' ' || d.currency || ' de ' || v_nombre,
          jsonb_build_object('debtId', p_debt_id, 'paymentId', v_pago,
                             'txId', v_tx, 'saldoLaDeuda', v_salda));

  return jsonb_build_object('debt_id', p_debt_id, 'pago_id', v_pago, 'tx_id', v_tx,
                            'monto', v_monto, 'saldada', v_salda,
                            'restante', greatest(v_saldo - v_monto, 0));
end;
$$;

grant execute on function public.pagar_deuda(bigint, numeric, text) to authenticated;

-- ── Cómo se usa ─────────────────────────────────────────────────────────────
--   select pagar_deuda(12, 5000);            -- pago parcial de 5000
--   select pagar_deuda(12, 5000, 'transferencia');
--   select pagar_deuda(12);                  -- saldar el resto
--
-- ── Prueba de atomicidad (correr una vez tras instalar) ────────────────────
--   select pagar_deuda(999999, 100);
--   → debe fallar con «No existe la deuda» sin dejar transacción, pago ni
--     registro de actividad nuevos.
