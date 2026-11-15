-- 037 · activity_log acepta el tipo 'ajuste' (lo escribe registrar_ajuste; sin esto
-- el ajuste fallaba al confirmar) y pagar_deuda deja de ser ejecutable por anon.
alter table public.activity_log drop constraint activity_log_kind_check;
alter table public.activity_log add constraint activity_log_kind_check
  check (kind = any (array['split','exchange','debt_payment','movimiento','ajuste']));
revoke all on function public.pagar_deuda(bigint, numeric, text, timestamptz, text, text, numeric) from public, anon;
grant execute on function public.pagar_deuda(bigint, numeric, text, timestamptz, text, text, numeric) to authenticated, service_role;
