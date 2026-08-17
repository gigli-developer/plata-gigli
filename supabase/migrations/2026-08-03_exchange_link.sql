-- ============================================================================
-- MIGRACIÓN ÚNICA · 2026-08-03
--
-- Dos cosas, para correr de una sola vez:
--   A) Vínculo entre un cambio de divisas y sus transacciones (poder editar/borrar)
--   B) Registro de operaciones, para el botón "Deshacer"
--
-- Correlo entero. Es idempotente: se puede repetir sin romper nada.
-- ============================================================================

begin;

-- ════════════════════════════════════════════════════════════════════════════
-- A · CAMBIOS DE DIVISAS EDITABLES Y BORRABLES
--
-- `register_exchange` escribe la fila en currency_exchanges MÁS dos transacciones
-- que mueven el saldo, pero no queda referencia entre ellas. Sin eso no se puede
-- borrar un cambio: hay que adivinar cuáles son sus transacciones por monto y
-- fecha, y con dos cambios iguales el mismo día se borra el equivocado.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.transactions
  add column if not exists exchange_id bigint
  references public.currency_exchanges(id) on delete cascade;

create index if not exists idx_transactions_exchange
  on public.transactions(exchange_id) where exchange_id is not null;

comment on column public.transactions.exchange_id is
  'Cambio de divisas que generó esta transacción. ON DELETE CASCADE: borrar el cambio borra su contrasiento.';

-- Rellenar los cambios que ya existen.
-- `register_exchange` no setea occurred_at en ninguna de las tres filas, así que
-- las tres toman el now() de la MISMA transacción → el timestamp es idéntico.
-- Igual se deja 2 segundos de tolerancia. Los dos row_number() evitan que dos
-- cambios gemelos se roben la misma transacción.
with candidatas as (
  select
    e.id as ex_id, t.id as tx_id, t.type,
    row_number() over (partition by t.id
      order by abs(extract(epoch from (t.occurred_at - e.occurred_at)))) as prioridad_tx,
    row_number() over (partition by e.id, t.type
      order by abs(extract(epoch from (t.occurred_at - e.occurred_at))), t.id) as prioridad_ex
  from public.currency_exchanges e
  join public.transactions t
    on t.user_id = e.user_id
   and t.exchange_id is null
   and t.category_id = (select id from public.categories
                         where name = 'Cambio Divisas' and user_id = e.user_id limit 1)
   and abs(extract(epoch from (t.occurred_at - e.occurred_at))) <= 2
   and ((t.type = 'egreso'  and t.currency = e.from_currency and t.amount = e.from_amount)
     or (t.type = 'ingreso' and t.currency = e.to_currency   and t.amount = e.to_amount))
)
update public.transactions t
   set exchange_id = c.ex_id
  from candidatas c
 where t.id = c.tx_id and c.prioridad_tx = 1 and c.prioridad_ex = 1;

-- Igual que la original, con un solo agregado: exchange_id en las transacciones.
create or replace function public.register_exchange(
  p_from text, p_to text, p_from_amount numeric, p_to_amount numeric,
  p_rate numeric, p_rate_source text default 'auto'::text
)
returns bigint language plpgsql set search_path to 'public'
as $function$
declare
  v_ex_id bigint; v_cat bigint; v_pm bigint; v_salida text; v_entrada text;
begin
  if p_from_amount is null or p_from_amount <= 0 or p_to_amount is null or p_to_amount <= 0 then
    raise exception 'Los montos del cambio tienen que ser mayores a cero';
  end if;
  if p_from = p_to then
    raise exception 'El cambio tiene que ser entre monedas distintas';
  end if;

  insert into public.currency_exchanges(from_currency, to_currency, from_amount, to_amount, rate, rate_source)
  values (p_from, p_to, p_from_amount, p_to_amount, p_rate, p_rate_source::rate_source)
  returning id into v_ex_id;

  select id into v_cat from public.categories where name = 'Cambio Divisas' limit 1;
  select id into v_pm  from public.payment_methods where name ilike '%transferencia%' limit 1;

  v_salida  := public.fmt_es_ar(p_from_amount) || ' ' || p_from;
  v_entrada := public.fmt_es_ar(p_to_amount) || ' ' || p_to;

  -- Categoría "Cambio Divisas": mueve el saldo pero está excluida de las métricas
  -- de gasto/ingreso, así un cambio no infla los egresos del mes.
  insert into public.transactions(type, amount, currency, category_id, payment_method_id, description, is_paid, source, exchange_id)
  values
    ('egreso',  p_from_amount, p_from, v_cat, v_pm, 'Cambio: Sale ' || v_salida || ' -> Entra ' || v_entrada, true, 'manual', v_ex_id),
    ('ingreso', p_to_amount,   p_to,   v_cat, v_pm, 'Cambio: Entra ' || v_entrada || ' <- Salió ' || v_salida, true, 'manual', v_ex_id);

  return v_ex_id;
end $function$;

-- Editar un cambio y su contrasiento en un solo paso.
create or replace function public.update_exchange(
  p_id bigint, p_from text, p_to text, p_from_amount numeric, p_to_amount numeric,
  p_rate numeric, p_rate_source text default 'manual'::text
)
returns void language plpgsql set search_path to 'public'
as $function$
declare v_salida text; v_entrada text; v_afectadas int;
begin
  if p_from_amount is null or p_from_amount <= 0 or p_to_amount is null or p_to_amount <= 0 then
    raise exception 'Los montos del cambio tienen que ser mayores a cero';
  end if;
  if p_from = p_to then
    raise exception 'El cambio tiene que ser entre monedas distintas';
  end if;

  update public.currency_exchanges
     set from_currency = p_from, to_currency = p_to,
         from_amount = p_from_amount, to_amount = p_to_amount,
         rate = p_rate, rate_source = p_rate_source::rate_source
   where id = p_id;

  get diagnostics v_afectadas = row_count;
  if v_afectadas = 0 then raise exception 'Ese cambio no existe o no es tuyo'; end if;

  v_salida  := public.fmt_es_ar(p_from_amount) || ' ' || p_from;
  v_entrada := public.fmt_es_ar(p_to_amount) || ' ' || p_to;

  update public.transactions
     set amount = p_from_amount, currency = p_from,
         description = 'Cambio: Sale ' || v_salida || ' -> Entra ' || v_entrada
   where exchange_id = p_id and type = 'egreso';

  update public.transactions
     set amount = p_to_amount, currency = p_to,
         description = 'Cambio: Entra ' || v_entrada || ' <- Salió ' || v_salida
   where exchange_id = p_id and type = 'ingreso';
end $function$;

-- La tasa se guardaba con 6 decimales: comprando dólares vale ~0,00065 y quedaba
-- truncada en 0,00066 (los montos nunca se vieron afectados, solo el TC mostrado).
alter table public.currency_exchanges
  alter column rate type numeric(20,10);


-- ════════════════════════════════════════════════════════════════════════════
-- B · REGISTRO DE OPERACIONES (para el botón "Deshacer")
--
-- Solo se registran las operaciones que crean VARIAS filas de una: dividir un
-- gasto, registrar un cambio, pagar una deuda. Deshacerlas a mano es engorroso y
-- fácil de dejar a medias.
--
-- Por qué una tabla y no "borrar el último registro": el email-poller importa
-- consumos cada 15 minutos y ensureNextStatements crea resúmenes solo. "Lo último
-- que pasó" no es "lo último que hiciste vos" — sin este registro, un deshacer
-- global borraría un consumo importado sin que te enteres.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.activity_log (
  id          bigserial primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('split', 'exchange', 'debt_payment')),
  label       text not null,          -- legible, se muestra en la confirmación
  detail      jsonb not null,         -- ids y valores previos para poder revertir
  undone_at   timestamptz,            -- null = todavía se puede deshacer
  created_at  timestamptz not null default now()
);

comment on table public.activity_log is
  'Operaciones en cascada hechas desde la app, para el botón Deshacer. NO registra lo que hace el email-poller.';

create index if not exists idx_activity_pendiente
  on public.activity_log(user_id, created_at desc) where undone_at is null;

alter table public.activity_log enable row level security;

drop policy if exists owner_all on public.activity_log;
create policy owner_all on public.activity_log
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;

-- ── Verificación ────────────────────────────────────────────────────────────
--   -- cada cambio con sus 2 transacciones:
--   select e.id, count(t.id) as txs from public.currency_exchanges e
--     left join public.transactions t on t.exchange_id = e.id group by e.id order by e.id;
--
--   -- transacciones de "Cambio Divisas" sin vincular (debería dar 0):
--   select count(*) from public.transactions where exchange_id is null
--     and category_id = (select id from public.categories where name = 'Cambio Divisas' limit 1);
--
--   -- la tabla nueva existe y está vacía:
--   select count(*) from public.activity_log;

-- ── Vuelta atrás ────────────────────────────────────────────────────────────
--   begin;
--   drop table if exists public.activity_log;
--   drop function if exists public.update_exchange(bigint, text, text, numeric, numeric, numeric, text);
--   alter table public.transactions drop column if exists exchange_id;
--   -- y volver a crear register_exchange sin `exchange_id` en el insert.
--   commit;
