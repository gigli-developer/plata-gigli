-- Las acciones del Centro de Control desde Coucou (Atajos de la isla, entrega 2).
-- Proyecto Supabase: cqnlceqghqqrlacbjhzj (Centro de Control, NO Plata).
-- Se aplica con execute_sql del MCP. La Edge Function coucou-foco las llama cuando
-- el pedido trae {"accion": ..., "args": {...}} (ver index.ts).
--
-- Cada acción escribe lo MISMO que la app (app-notion/Main.dc.html: cambiarEstadoTarea,
-- iniciarCronometro, pausarLoQueCorra, guardarTarea, crearTarea, marcarCumplimiento,
-- hoyNoTrabajo). Lo demás lo hacen los triggers de siempre: cerrada_el, el historial
-- de estados y fechas, cerrar el cronómetro de una tarea hecha.
--
-- Todo filtra por usuario_id = p_usuario: una id ajena no toca nada (no encontrada).

create or replace function cdc.coucou_accion(p_usuario uuid, p_accion text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, cdc, pg_temp
as $$
declare
  v_id uuid := nullif(p_args->>'id', '')::uuid;
  v_hoy date := cdc.hoy();
  v_fecha date;
  v_n int := 0;
  v_titulo text;
  v_area uuid;
  v_nueva uuid;
  v_antes record;
begin
  if p_usuario is null then
    raise exception 'sin usuario' using errcode = '22023';
  end if;

  -- Las que actúan sobre una tarea: tiene que existir y ser del usuario.
  if p_accion in ('hecha', 'reabrir', 'empezar', 'mover', 'por_hacer', 'borrar_nueva') then
    if v_id is null or not exists (select 1 from tareas where id = v_id and usuario_id = p_usuario) then
      return jsonb_build_object('ok', false, 'error', 'No encontré esa tarea.');
    end if;
    -- Cómo estaba: la isla lo guarda para "Deshacer".
    select estado, vence into v_antes from tareas where id = v_id;
  end if;

  case p_accion
    -- Tildarla. Como cambiarEstadoTarea(id, 'done'): la sesión abierta de ESA tarea se cierra.
    when 'hecha' then
      update tiempos set fin = now() where tarea_id = v_id and usuario_id = p_usuario and fin is null;
      update tareas set estado = 'done', cerrada_el = v_hoy where id = v_id and usuario_id = p_usuario;
      return jsonb_build_object('ok', true, 'id', v_id, 'estado', 'done', 'antes', v_antes.estado);

    -- Deshacer el tilde: vuelve a como estaba (`estado`: not_started o in_progress).
    when 'reabrir' then
      update tareas
         set estado = case when p_args->>'estado' = 'in_progress' then 'in_progress' else 'not_started' end,
             cerrada_el = null
       where id = v_id and usuario_id = p_usuario;
      return jsonb_build_object('ok', true, 'id', v_id, 'estado', (select estado from tareas where id = v_id));

    -- La quieta que se suelta: vuelve a Por hacer (la sesión abierta, si hay, se cierra).
    when 'por_hacer' then
      update tiempos set fin = now() where tarea_id = v_id and usuario_id = p_usuario and fin is null;
      update tareas set estado = 'not_started', cerrada_el = null where id = v_id and usuario_id = p_usuario and estado <> 'done';
      return jsonb_build_object('ok', true, 'id', v_id, 'estado', 'not_started');

    -- Empezar = cronómetro. Como iniciarCronometro: cierra lo que corra (el índice
    -- único es por usuario), abre la sesión y la pasa a En curso.
    when 'empezar' then
      update tiempos set fin = now() where usuario_id = p_usuario and fin is null;
      insert into tiempos (usuario_id, tarea_id, inicio) values (p_usuario, v_id, now());
      update tareas set estado = 'in_progress' where id = v_id and usuario_id = p_usuario and estado <> 'done';
      return jsonb_build_object('ok', true, 'id', v_id, 'estado', 'in_progress', 'cronometro_desde', now());

    -- Pausar lo que esté corriendo.
    when 'pausar' then
      update tiempos set fin = now() where usuario_id = p_usuario and fin is null;
      get diagnostics v_n = row_count;
      return jsonb_build_object('ok', true, 'pausadas', v_n);

    -- Otro día. `vence` null = sin fecha. Como guardarTarea: sin vence no hay vence_fin (F61),
    -- y mover un día no arrastra la ventana vieja. Una fecha pasada vale: es lo que usa
    -- "Deshacer" para devolver una atrasada a donde estaba.
    when 'mover' then
      v_fecha := nullif(p_args->>'vence', '')::date;
      update tareas set vence = v_fecha, vence_fin = null where id = v_id and usuario_id = p_usuario;
      return jsonb_build_object('ok', true, 'id', v_id, 'vence', v_fecha, 'antes', v_antes.vence);

    -- Tarea nueva. Como crearTarea: not_started, origen manual, el área por nombre (opcional).
    when 'nueva' then
      v_titulo := btrim(coalesce(p_args->>'titulo', ''));
      if v_titulo = '' then
        return jsonb_build_object('ok', false, 'error', 'Falta el título.');
      end if;
      v_fecha := nullif(p_args->>'vence', '')::date;
      if nullif(p_args->>'area', '') is not null then
        select id into v_area from areas
         where usuario_id = p_usuario and lower(nombre) = lower(p_args->>'area')
         limit 1;
      end if;
      insert into tareas (usuario_id, titulo, area_id, proyecto_id, padre_id, estado, vence, vence_fin, notas, origen)
      values (p_usuario, v_titulo, v_area, null, null, 'not_started', v_fecha, null, nullif(btrim(coalesce(p_args->>'notas', '')), ''), 'manual')
      returning id into v_nueva;
      return jsonb_build_object('ok', true, 'id', v_nueva, 'titulo', v_titulo, 'vence', v_fecha,
                                'area', (select nombre from areas where id = v_area));

    -- Deshacer "nueva": solo una tarea manual creada hace menos de 15 minutos.
    when 'borrar_nueva' then
      delete from tareas
       where id = v_id and usuario_id = p_usuario and origen = 'manual'
         and creado > now() - interval '15 minutes';
      get diagnostics v_n = row_count;
      if v_n = 0 then
        return jsonb_build_object('ok', false, 'error', 'Esa tarea ya no se puede deshacer desde la isla.');
      end if;
      return jsonb_build_object('ok', true, 'id', v_id, 'borrada', true);

    -- Un hábito de hoy, marcado o no. Como marcarCumplimiento.
    when 'habito' then
      v_id := nullif(p_args->>'id', '')::uuid;
      if v_id is null or not exists (select 1 from habitos where id = v_id and usuario_id = p_usuario) then
        return jsonb_build_object('ok', false, 'error', 'No encontré ese hábito.');
      end if;
      if coalesce((p_args->>'hecho')::boolean, true) then
        insert into cumplimientos (usuario_id, habito_id, fecha, hecho) values (p_usuario, v_id, v_hoy, true)
        on conflict (habito_id, fecha) do update set hecho = true;
      else
        delete from cumplimientos where habito_id = v_id and fecha = v_hoy and usuario_id = p_usuario;
      end if;
      return jsonb_build_object('ok', true, 'id', v_id, 'hecho', coalesce((p_args->>'hecho')::boolean, true));

    -- "Hoy no trabajo". Dos veces el mismo día es lo mismo que una.
    when 'no_trabajo' then
      insert into dias_sin_trabajo (usuario_id, dia, motivo, nota)
      values (p_usuario, v_hoy,
              case when p_args->>'motivo' in ('enfermo', 'dia_libre', 'otro') then p_args->>'motivo' else 'dia_libre' end,
              nullif(btrim(coalesce(p_args->>'nota', '')), ''))
      on conflict (usuario_id, dia) do nothing;
      return jsonb_build_object('ok', true, 'dia', v_hoy);

    else
      return jsonb_build_object('ok', false, 'error', format('No conozco la acción %s.', coalesce(p_accion, '(vacía)')));
  end case;
end;
$$;

revoke all on function cdc.coucou_accion(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function cdc.coucou_accion(uuid, text, jsonb) to service_role;

-- Lo que llama la Edge Function: mismo control de secreto que public.coucou_foco.
create or replace function public.coucou_accion(p_secreto text, p_usuario uuid, p_accion text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secreto text;
begin
  select decrypted_secret into v_secreto
    from vault.decrypted_secrets where name = 'cdc_coucou_secret';
  if v_secreto is null or p_secreto is null
     or extensions.digest(p_secreto, 'sha256') <> extensions.digest(v_secreto, 'sha256') then
    return null;
  end if;
  return cdc.coucou_accion(p_usuario, p_accion, coalesce(p_args, '{}'::jsonb));
end;
$$;

revoke all on function public.coucou_accion(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.coucou_accion(text, uuid, text, jsonb) to service_role;
