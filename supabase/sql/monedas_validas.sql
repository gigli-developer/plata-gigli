-- Monedas válidas (2026-11-08).
-- Plata solo sabe valuar ARS, USD y USDT. Cualquier otra moneda (pasó con
-- CLP: una compra en falabella.cl de CLP 219.990) la trataba el trigger
-- tx_freeze_fx como dólar y metía un egreso de $334M.
-- Con este CHECK el insert falla: el email-poller lo registra como
-- status='error' en email_process_logs y Coucou lo avisa en problems[].
alter table public.transactions        add constraint transactions_currency_chk        check (currency in ('ARS','USD','USDT'));
alter table public.debts               add constraint debts_currency_chk               check (currency in ('ARS','USD','USDT'));
alter table public.installment_plans   add constraint installment_plans_currency_chk   check (currency in ('ARS','USD','USDT'));
alter table public.recurring_templates add constraint recurring_templates_currency_chk check (currency in ('ARS','USD','USDT'));

-- Rollback:
-- alter table public.transactions        drop constraint transactions_currency_chk;
-- alter table public.debts               drop constraint debts_currency_chk;
-- alter table public.installment_plans   drop constraint installment_plans_currency_chk;
-- alter table public.recurring_templates drop constraint recurring_templates_currency_chk;
