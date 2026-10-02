-- Estado de Plata para Coucou (la isla de escritorio). Lo lee SOLO la Edge Function
-- `coucou-health` con la service role: nadie más puede ejecutarlo.
--
-- Todo pre-agregado y chico: la isla lo pide cada 5 min.
-- Se aplica con el MCP de Supabase (execute_sql). Si lo cambiás, re-ejecutalo.
create or replace function public.coucou_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    -- Último cron de cada job (email-poller, fx-sync, inflation-sync).
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', j.jobname, 'status', r.status, 'at', r.start_time)
             order by j.jobname), '[]'::jsonb)
      from cron.job j
      left join lateral (
        select d.status, d.start_time from cron.job_run_details d
        where d.jobid = j.jobid order by d.start_time desc limit 1
      ) r on true
    ),
    'importer', jsonb_build_object(
      'lastProcessedAt', (select max(processed_at) from email_process_logs),
      'errors24h', (select count(*) from email_process_logs
                    where status = 'error' and processed_at > now() - interval '24 hours'),
      'lastError', (select error_message from email_process_logs
                    where status = 'error' order by processed_at desc limit 1)
    ),
    -- Último consumo importado de un mail que sigue existiendo (con el nombre ya
    -- renombrado por las reglas).
    'lastTx', (
      select jsonb_build_object(
               'id', t.id, 'description', t.description, 'amount', t.amount,
               'currency', t.currency, 'at', l.processed_at)
      from email_process_logs l
      join transactions t on t.id = l.transaction_id
      order by l.processed_at desc
      limit 1
    ),
    -- Misma fuente que la app: fx_rates, blue y cripto COMPRA del último día.
    'fx', (
      select jsonb_build_object(
               'day', max(day),
               'blue', max(compra) filter (where casa = 'blue'),
               'cripto', max(compra) filter (where casa = 'cripto'),
               'updatedAt', max(updated_at))
      from fx_rates
      where day = (select max(day) from fx_rates)
    )
  );
$$;

revoke all on function public.coucou_health() from public, anon, authenticated;
grant execute on function public.coucou_health() to service_role;
