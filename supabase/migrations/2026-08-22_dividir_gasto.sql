-- Dividir un gasto compartido, de cero y en UNA operación.
--
-- La escena: «fuimos a comer 5, la cuenta fue 80 mil, yo puse 50». El modelo
-- interpreta; ESTA función calcula nada — recibe las partes ya resueltas por la
-- herramienta y garantiza lo único que el TypeScript no puede: atomicidad. O se
-- escriben las dos transacciones, las N deudas y el renglón del deshacer, o no
-- se escribe nada. Es la misma razón de ser de convertir_a_cuotas y pagar_deuda
-- (la receta manual de borrar+crear evaporó una cuota de $457.500 un 18/08).
--
-- La semántica calca `splitTransaction` de lib/db.ts, que es la que el botón
-- Deshacer de la app ya sabe revertir:
--   · tu parte    → transacción con SU categoría real (el gasto que existió)
--   · la ajena    → hermana en «Préstamos», fuera de las métricas de gasto
--   · por persona → una deuda kind='split' to_collect con los metadatos
--   · activity_log kind='split' con el MISMO detail que espera deshacerOperacion
--     (originalTxId/hermanaTxId/debtIds/montoOriginal/descOriginal): al deshacer,
--     las dos transacciones se juntan en una sola por `montoOriginal` (lo que
--     pusiste) y las deudas se van — quedás como si hubieras cargado el gasto
--     pelado, que es exactamente el estado previo a dividir.
--
-- `p_user_id` explícito en cada insert: esto corre con service role y los
-- defaults auth.uid() dan NULL por ese camino (la misma trampa que ya mordió a
-- activity_log el 19/08).
--
-- Personas que no existen SE CREAN acá adentro (la tarjeta de propuesta ya
-- avisó cuáles): dividir con alguien nuevo no puede fallar por el orden de dos
-- escrituras.
create or replace function public.dividir_gasto(
  p_user_id uuid,
  p_total numeric,
  p_puse numeric,
  p_parte numeric,
  p_personas jsonb,             -- [{"nombre":"Nacho","debe":8500}, ...]
  p_descripcion text,
  p_categoria_id bigint default null,
  p_metodo_id bigint default null,
  p_fecha timestamptz default now(),
  p_moneda text default 'ARS'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prestamos bigint;
  v_tx bigint;
  v_hermana bigint;
  v_debt bigint;
  v_pid bigint;
  v_ids bigint[] := '{}';
  v_nuevas text[] := '{}';
  v_p jsonb;
  v_nombre text;
  v_debe numeric;
  v_ajeno numeric;
begin
  if p_user_id is null then
    raise exception 'falta el usuario';
  end if;
  if coalesce(p_total, 0) <= 0 or coalesce(p_puse, 0) <= 0 or coalesce(p_parte, 0) <= 0 then
    raise exception 'los montos tienen que ser mayores a cero';
  end if;
  if p_moneda not in ('ARS', 'USD', 'USDT') then
    raise exception 'moneda desconocida: %', p_moneda;
  end if;

  select sum((x->>'debe')::numeric) into v_ajeno from jsonb_array_elements(p_personas) x;
  if v_ajeno is null or v_ajeno <= 0 then
    raise exception 'no hay deudas que registrar';
  end if;
  -- La misma tolerancia de 0,5 en la moneda que usa splitTransaction.
  if abs(p_parte + v_ajeno - p_puse) > 0.5 then
    raise exception 'tu parte (%) más lo prestado (%) no suma lo que pusiste (%)',
      p_parte, v_ajeno, p_puse;
  end if;

  -- La categoría que mantiene el gasto ajeno fuera de tus métricas (decisión 3).
  select id into v_prestamos from categories where name = 'Préstamos' limit 1;
  if v_prestamos is null then
    raise exception 'falta la categoría Préstamos';
  end if;

  insert into transactions (user_id, type, amount, currency, category_id,
                            payment_method_id, occurred_at, description, is_paid, source)
  values (p_user_id, 'egreso', p_parte, p_moneda, p_categoria_id,
          p_metodo_id, p_fecha, p_descripcion, true, 'chat')
  returning id into v_tx;

  insert into transactions (user_id, type, amount, currency, category_id,
                            payment_method_id, occurred_at, description, is_paid, source)
  values (p_user_id, 'egreso', v_ajeno, p_moneda, v_prestamos,
          p_metodo_id, p_fecha, 'Parte de otros · ' || p_descripcion, true, 'chat')
  returning id into v_hermana;

  for v_p in select * from jsonb_array_elements(p_personas) loop
    v_nombre := btrim(v_p->>'nombre');
    v_debe := (v_p->>'debe')::numeric;
    if v_nombre is null or v_nombre = '' or v_debe is null or v_debe <= 0 then
      raise exception 'persona inválida en la lista: %', v_p;
    end if;

    select id into v_pid from persons
    where user_id = p_user_id and lower(name) = lower(v_nombre)
    limit 1;
    if v_pid is null then
      insert into persons (user_id, name) values (p_user_id, v_nombre)
      returning id into v_pid;
      v_nuevas := v_nuevas || v_nombre;
    end if;

    insert into debts (user_id, person_id, kind, direction, amount, currency,
                       description, occurred_at, split_total, your_share, participants)
    values (p_user_id, v_pid, 'split', 'to_collect', v_debe, p_moneda,
            p_descripcion, p_fecha, p_total, p_parte, jsonb_array_length(p_personas) + 1)
    returning id into v_debt;
    v_ids := v_ids || v_debt;
  end loop;

  insert into activity_log (user_id, kind, label, detail)
  values (p_user_id, 'split',
          'División de ' || p_descripcion,
          jsonb_build_object(
            'originalTxId', v_tx, 'hermanaTxId', v_hermana, 'debtIds', to_jsonb(v_ids),
            'montoOriginal', p_puse, 'descOriginal', p_descripcion));

  return jsonb_build_object(
    'tx_id', v_tx, 'hermana_id', v_hermana, 'debt_ids', to_jsonb(v_ids),
    'ajeno', v_ajeno, 'personas_nuevas', to_jsonb(v_nuevas));
end;
$$;

-- Solo el service role del servidor la llama; ni el browser ni un anónimo.
revoke execute on function public.dividir_gasto(uuid, numeric, numeric, numeric, jsonb, text, bigint, bigint, timestamptz, text) from anon, authenticated;
