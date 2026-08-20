-- Convertir un consumo en un plan de cuotas, de una sola vez.
--
-- El 18/08/2026 esta operación, hecha a mano en dos pasos, borró un consumo de
-- $457.500 y creó solo dos de las tres cuotas. La plata que faltaba se recuperó
-- de casualidad. La causa no fue el paso que falló: fue que **la operación no
-- existía** — era una receta que cada quien (la app, el asistente, un script)
-- ejecutaba de a un paso, sin nada que garantizara que llegara al final.
--
-- Adentro de una función, Postgres garantiza lo único que hacía falta: o pasa
-- todo, o no pasa nada. Si el `delete` falla, el plan no queda; si el `insert`
-- falla, el consumo sigue vivo. **No existe el estado intermedio**, y deja de
-- depender de que quien llama se acuerde de hacer los dos pasos.
--
-- Va como `security invoker` (el default) a propósito, y NO como definer: así
-- las políticas de RLS siguen aplicando y solo se puede convertir lo propio.
-- Una definer acá sería una función que convierte transacciones de cualquiera.
--
-- Las cuotas van a `installment_plans` y no a `transactions` porque ese es el
-- modelo (decisión 2 de CLAUDE.md): meterlas como transacciones las cuenta dos
-- veces en los gastos por categoría. Es el otro error que se cometió ese día.

create or replace function public.convertir_a_cuotas(
  p_tx_id   bigint,
  p_cuotas  smallint,
  p_primera date default null      -- si se omite, el 1° del mes del consumo
)
returns public.installment_plans
language plpgsql
set search_path = public
as $$
declare
  t    public.transactions;
  plan public.installment_plans;
begin
  if p_cuotas < 2 or p_cuotas > 60 then
    raise exception 'Cuotas fuera de rango (2 a 60): %', p_cuotas;
  end if;

  -- `for update` traba la fila hasta el final: sin eso, dos conversiones
  -- simultáneas del mismo consumo crearían dos planes y borrarían una vez.
  select * into t from public.transactions where id = p_tx_id for update;
  if not found then
    raise exception 'No existe la transacción %', p_tx_id;
  end if;
  if t.type <> 'egreso' then
    raise exception 'Solo se convierten egresos; la % es "%"', p_tx_id, t.type;
  end if;
  if t.amount is null or t.amount <= 0 then
    raise exception 'La transacción % no tiene un monto válido', p_tx_id;
  end if;

  insert into public.installment_plans (
    user_id, card_id, description, monthly_amount, currency,
    total_installments, first_charge_date, category_id
  ) values (
    t.user_id,
    t.card_id,                    -- admite nulo: un consumo sin tarjeta también se puede cuotificar
    t.description,
    -- ⚠️ El modelo guarda UN importe mensual, así que no puede representar una
    -- última cuota distinta. Con montos no divisibles se pierden centavos
    -- (100 / 3 = 33,33 y el plan suma 99,99). Cuando el banco cobra un importe
    -- exacto, conviene pasarlo con `p_primera` y corregir el plan a mano —
    -- pasó con MercadoLibre: 15.000,04 contra 15.000,00.
    round(t.amount / p_cuotas, 2),
    t.currency,
    p_cuotas,
    coalesce(
      p_primera,
      -- La fecha se saca en hora argentina, no en UTC: un consumo del 1° a las
      -- 21:00 ART es del día 2 en UTC y caería en el mes equivocado.
      date_trunc('month', (t.occurred_at at time zone 'America/Argentina/Buenos_Aires'))::date
    ),
    t.category_id
  ) returning * into plan;

  delete from public.transactions where id = p_tx_id;

  return plan;
end;
$$;

grant execute on function public.convertir_a_cuotas(bigint, smallint, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Cómo se usa
-- ---------------------------------------------------------------------------
--   select * from public.convertir_a_cuotas(868, 3::smallint);
--   select * from public.convertir_a_cuotas(868, 3::smallint, '2026-08-01');
--
-- Desde la app o el asistente: sb.rpc('convertir_a_cuotas', { p_tx_id, p_cuotas })
--
-- Prueba de que es atómica, para correr una vez después de instalarla:
--   select * from public.convertir_a_cuotas(999999, 3::smallint);
--   → tiene que dar «No existe la transacción 999999» y NO dejar ningún plan
--     nuevo en installment_plans.
