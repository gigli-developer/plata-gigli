-- Dos piezas de la capa de razonamiento conversacional (plan 22/08, pedido de Lucas):
--
-- 1) `pensar_sesiones`: la conversación del sub-agente, con TTL. «¿Y si lo pago
--    en marzo?» tiene que continuar el hilo, no arrancar de cero — y el costo
--    ACUMULADO de la conversación es el número que importa para saber si esto
--    es sostenible, así que vive en la fila y no en un log.
--
-- 2) `flujo_de_caja(p_meses)`: la cuenta pesada del cash flow la hace Postgres;
--    el modelo recibe una tabla chica y la interpreta. Sin esto, «entendeme el
--    flujo» no tiene de dónde salir.

-- ── 1 · la conversación del analista ────────────────────────────────────────
create table if not exists pensar_sesiones (
  id bigint generated always as identity primary key,
  -- El historial COMPLETO del sub-agente (bloques assistant + tool_results),
  -- tal como viaja a la API. Acá adentro sí están los agregados crudos: por
  -- eso esta tabla no se expone y muere por TTL, no se acumula.
  mensajes jsonb not null default '[]'::jsonb,
  turnos int not null default 0,
  llamadas int not null default 0,
  costo_usd numeric not null default 0,
  modelo text,
  creada timestamptz not null default now(),
  ultimo_uso timestamptz not null default now()
);
-- Solo el service role del servidor la toca. RLS prendida sin policies =
-- anon/authenticated no ven nada; el service la saltea.
alter table pensar_sesiones enable row level security;

-- ── 2 · la serie del flujo ──────────────────────────────────────────────────
--
-- ⚠️ SEMÁNTICA, para no pelearse con la página Cash Flow: esta es la serie
-- DEVENGADA del analista — componentes deterministas leídos de las tablas —,
-- no la vista de caja de la app, que maneja resúmenes/pagos con más matices y
-- sigue siendo la canónica para el usuario. Los supuestos van EXPLÍCITOS en la
-- respuesta para que el modelo los diga en vez de esconderlos.
--
-- Por mes, desde el actual:
--   ingresos_previstos  = recurrentes de ingreso activos (valuados hoy)
--   cuotas_ars          = las cuotas que caen ese mes (cotización viva: son
--                         compromisos a futuro, decisión 5b)
--   fijos_ars           = recurrentes de egreso activos no variables
--   variables_promedio  = promedio de egresos de los últimos 3 meses CERRADOS,
--                         a cotización congelada, sin Préstamos ni Cambio
--                         Divisas (no son gasto) y sin recurrentes fijos
--   neto_ars            = ingresos − cuotas − fijos − variables
create or replace function public.flujo_de_caja(p_meses int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_meses int := least(greatest(coalesce(p_meses, 3), 1), 6);
  v_fx_usd numeric := coalesce(fx_rate_at('blue', current_date, 'compra'), 0);
  v_fx_usdt numeric := coalesce(fx_rate_at('cripto', current_date, 'compra'), 0);
  v_ing numeric;
  v_fijos numeric;
  v_variables numeric;
  v_filas jsonb := '[]'::jsonb;
  v_mes date;
  v_cuotas numeric;
  i int;
begin
  -- Recurrentes, valuados a hoy (viva: es lo que van a costar cuando caigan).
  select coalesce(sum(base_amount * case currency when 'USD' then v_fx_usd
                                                  when 'USDT' then v_fx_usdt else 1 end), 0)
    into v_ing
  from recurring_templates where is_active and type = 'ingreso';

  select coalesce(sum(base_amount * case currency when 'USD' then v_fx_usd
                                                  when 'USDT' then v_fx_usdt else 1 end), 0)
    into v_fijos
  from recurring_templates where is_active and type = 'egreso' and not is_variable;

  -- Promedio variable: 3 meses cerrados, congelada (los flujos pasados no se
  -- mueven con el dólar), sin las categorías que no son gasto.
  select coalesce(sum(t.amount * coalesce(t.fx_rate_ars,
                       case t.currency when 'ARS' then 1 else 0 end)), 0) / 3.0
    into v_variables
  from transactions t
  left join categories c on c.id = t.category_id
  where t.type = 'egreso'
    and t.occurred_at >= date_trunc('month', current_date) - interval '3 months'
    and t.occurred_at <  date_trunc('month', current_date)
    and coalesce(c.name, '') not in ('Cambio Divisas', 'Préstamos');

  for i in 0 .. v_meses - 1 loop
    v_mes := (date_trunc('month', current_date) + make_interval(months => i))::date;

    -- La cuota k de un plan cae en first_charge + k meses, k en [0, total).
    select coalesce(sum(p.monthly_amount * case p.currency when 'USD' then v_fx_usd
                                                           when 'USDT' then v_fx_usdt else 1 end), 0)
      into v_cuotas
    from installment_plans p
    where date_trunc('month', p.first_charge_date)::date <= v_mes
      and (date_trunc('month', p.first_charge_date)
             + make_interval(months => p.total_installments - 1))::date >= v_mes;

    v_filas := v_filas || jsonb_build_object(
      'mes', to_char(v_mes, 'YYYY-MM'),
      'ingresos_previstos_ars', round(v_ing),
      'cuotas_ars', round(v_cuotas),
      'fijos_ars', round(v_fijos),
      'variables_promedio_ars', round(v_variables),
      'egresos_previstos_ars', round(v_cuotas + v_fijos + v_variables),
      'neto_ars', round(v_ing - v_cuotas - v_fijos - v_variables));
  end loop;

  return jsonb_build_object(
    'meses', v_filas,
    'cotizaciones', jsonb_build_object('usd_compra', v_fx_usd, 'usdt_compra', v_fx_usdt),
    'supuestos', jsonb_build_array(
      'serie devengada: las cuotas cuentan el mes que caen, no el mes que se paga el resumen',
      'variables = promedio de los últimos 3 meses cerrados, sin Préstamos ni Cambio Divisas',
      'las suscripciones detectadas por repetición NO están (viven en la app, no en una tabla)',
      'recurrentes y cuotas en moneda extranjera valuados al blue/cripto compra de hoy'));
end;
$$;

revoke execute on function public.flujo_de_caja(int) from anon, authenticated;
