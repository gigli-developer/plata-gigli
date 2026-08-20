-- Papelera automática: nada que se borre desaparece de verdad.
--
-- Por qué existe, con fecha y monto: el 18/08/2026 una conversión de consumo a
-- cuotas se cortó a la mitad. Borró un consumo de $457.500 y creó solo dos de
-- las tres cuotas. Se recuperó de casualidad, porque ese consumo había entrado
-- por mail y `email_process_logs` guardaba el monto original. Si hubiera sido
-- una carga a mano, no había forma de recuperarlo.
--
-- La red va acá abajo y no en la aplicación a propósito: un trigger de base
-- atrapa TODOS los borrados, vengan de donde vengan — la app, el asistente, un
-- MCP futuro, un script, o alguien escribiendo SQL a mano. Una salvaguarda que
-- vive en la app solo protege a los que se acuerdan de usarla.
--
-- Cuesta una fila por borrado en una tabla que nadie lee. A cambio, «se borró
-- algo y no sé qué era» pasa a ser una consulta de diez segundos.

create table if not exists public.papelera (
  id          bigserial primary key,
  tabla       text        not null,
  fila        jsonb       not null,
  borrado_en  timestamptz not null default now()
);

create index if not exists papelera_cuando on public.papelera (borrado_en desc);
create index if not exists papelera_tabla  on public.papelera (tabla);

-- `security definer` para que el trigger pueda escribir sin importar quién
-- borró; `search_path` fijo porque una función definer sin eso es un agujero
-- clásico (alguien redefine `papelera` en otro esquema y te escribe ahí).
create or replace function public.a_la_papelera()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.papelera (tabla, fila) values (tg_table_name, to_jsonb(old));
  return old;
end;
$$;

-- AFTER y no BEFORE: así solo se anota lo que realmente se borró. Si la
-- transacción de base se revierte, la fila de la papelera se revierte con ella
-- y no queda un fantasma de algo que sigue vivo.
drop trigger if exists trg_papelera_transactions on public.transactions;
create trigger trg_papelera_transactions
  after delete on public.transactions
  for each row execute function public.a_la_papelera();

drop trigger if exists trg_papelera_installment_plans on public.installment_plans;
create trigger trg_papelera_installment_plans
  after delete on public.installment_plans
  for each row execute function public.a_la_papelera();

drop trigger if exists trg_papelera_debts on public.debts;
create trigger trg_papelera_debts
  after delete on public.debts
  for each row execute function public.a_la_papelera();

drop trigger if exists trg_papelera_debt_payments on public.debt_payments;
create trigger trg_papelera_debt_payments
  after delete on public.debt_payments
  for each row execute function public.a_la_papelera();

drop trigger if exists trg_papelera_card_statements on public.card_statements;
create trigger trg_papelera_card_statements
  after delete on public.card_statements
  for each row execute function public.a_la_papelera();

-- RLS, igual que el resto del esquema: se ve lo propio y nada más.
alter table public.papelera enable row level security;

drop policy if exists papelera_owner on public.papelera;
create policy papelera_owner on public.papelera
  for select using ((fila ->> 'user_id')::uuid = auth.uid());

-- ---------------------------------------------------------------------------
-- Cómo se usa el día que haga falta
-- ---------------------------------------------------------------------------
--
-- Qué se borró hoy:
--   select id, tabla, borrado_en, fila->>'description' as que, fila->>'amount' as cuanto
--     from public.papelera
--    where borrado_en > now() - interval '1 day'
--    order by borrado_en desc;
--
-- Devolver una transacción a la vida (el jsonb tiene la fila entera, con su id):
--   insert into public.transactions
--   select * from jsonb_populate_record(null::public.transactions, (select fila from public.papelera where id = <id>));
