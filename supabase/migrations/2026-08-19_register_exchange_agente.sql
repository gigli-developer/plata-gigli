-- register_exchange usable desde el agente (voz y Telegram).
--
-- El problema: la función original no setea `user_id` en ninguno de sus tres
-- inserts — confía en el default `auth.uid()`. Eso funciona desde la app, que
-- escribe con la sesión del usuario, pero el agente corre con service role,
-- donde `auth.uid()` es NULL y las tres columnas son NOT NULL. O sea: la
-- herramienta de voz fallaría en el primer insert, siempre.
--
-- El arreglo es un parámetro opcional al final. `coalesce(auth.uid(), p_user_id)`
-- deja la app EXACTAMENTE como estaba (PostgREST resuelve por nombre, así que la
-- llamada de 6 argumentos de lib/db.ts sigue siendo válida) y le da al agente la
-- forma de decir por quién escribe.
--
-- Lo demás es idéntico a 2026-08-03_exchange_link.sql: mismos montos, misma
-- categoría, mismo contrasiento, mismo vínculo exchange_id.

create or replace function public.register_exchange(
  p_from text, p_to text, p_from_amount numeric, p_to_amount numeric,
  p_rate numeric, p_rate_source text default 'auto'::text,
  p_user_id uuid default null
)
returns bigint language plpgsql set search_path to 'public'
as $function$
declare
  v_ex_id bigint; v_cat bigint; v_pm bigint; v_salida text; v_entrada text; v_uid uuid;
begin
  if p_from_amount is null or p_from_amount <= 0 or p_to_amount is null or p_to_amount <= 0 then
    raise exception 'Los montos del cambio tienen que ser mayores a cero';
  end if;
  if p_from = p_to then
    raise exception 'El cambio tiene que ser entre monedas distintas';
  end if;

  -- La sesión manda; el parámetro es el respaldo para quien no tiene sesión.
  v_uid := coalesce(auth.uid(), p_user_id);
  if v_uid is null then
    raise exception 'No sé de quién es este cambio: pasá p_user_id o llamá con sesión';
  end if;

  insert into public.currency_exchanges(user_id, from_currency, to_currency, from_amount, to_amount, rate, rate_source)
  values (v_uid, p_from, p_to, p_from_amount, p_to_amount, p_rate, p_rate_source::rate_source)
  returning id into v_ex_id;

  -- Se filtra por usuario, que la original no hacía: con `limit 1` a secas, una
  -- base con más de un usuario tomaba la categoría de cualquiera.
  select id into v_cat from public.categories
   where name = 'Cambio Divisas' and user_id = v_uid limit 1;
  select id into v_pm from public.payment_methods
   where name ilike '%transferencia%' and user_id = v_uid limit 1;

  v_salida  := public.fmt_es_ar(p_from_amount) || ' ' || p_from;
  v_entrada := public.fmt_es_ar(p_to_amount) || ' ' || p_to;

  -- Categoría "Cambio Divisas": mueve el saldo pero está excluida de las métricas
  -- de gasto/ingreso, así un cambio no infla los egresos del mes.
  insert into public.transactions(user_id, type, amount, currency, category_id, payment_method_id, description, is_paid, source, exchange_id)
  values
    (v_uid, 'egreso',  p_from_amount, p_from, v_cat, v_pm, 'Cambio: Sale ' || v_salida || ' -> Entra ' || v_entrada, true, 'manual', v_ex_id),
    (v_uid, 'ingreso', p_to_amount,   p_to,   v_cat, v_pm, 'Cambio: Entra ' || v_entrada || ' <- Salió ' || v_salida, true, 'manual', v_ex_id);

  return v_ex_id;
end $function$;

grant execute on function public.register_exchange(text, text, numeric, numeric, numeric, text, uuid) to authenticated;

-- ── Prueba ──────────────────────────────────────────────────────────────────
--   select register_exchange('USD','ARS',0,0,1,'auto',null);
--   → debe fallar con «montos mayores a cero», sin escribir nada.
