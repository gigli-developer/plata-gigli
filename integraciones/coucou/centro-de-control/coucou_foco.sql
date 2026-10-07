-- ============================================================================
--  COUCOU_FOCO — el día del Centro de Control para la isla de Coucou
--  Proyecto Supabase: cqnlceqghqqrlacbjhzj (Centro de Control, NO Plata).
--
--  Lo lee SOLO la Edge Function `coucou-foco` con la service role. Es SOLO
--  LECTURA: no escribe en ninguna tabla.
--
--  Mismas reglas que la app (Main.dc.html, panel "Inicio"):
--    - estado de la fecha con cdc.estado_fecha(vence, vence_fin, hoy); hoy = cdc.dia(ahora)
--    - una madre con hijas abiertas es un CONTENEDOR y no se lista, salvo que
--      tenga el cronómetro corriendo (esTarjeta del tablero)
--    - atrasadas = sin empezar y 'vencida'; para_hoy = sin empezar y 'en_curso'
--      (vence hoy, o ventana abierta que incluye hoy). Las en curso van aparte.
--    - quieta = la misma cuenta que cdc.pendientes: días desde el último paso a
--      in_progress o, si después hubo sesiones, desde la última sesión. Sin paso
--      conocido (antes del 07/09) es null: desconocido no es "quieta".
--    - pendientes = cdc.pendientes(usuario, ahora, null, 'real'), tal cual.
--
--  Se aplica con el MCP de Supabase (execute_sql). Si lo cambiás, re-ejecutalo.
--  ⚠️ El MCP corre todo en UNA transacción: si algo falla, no queda nada.
-- ============================================================================

create or replace function cdc.coucou_foco(p_usuario uuid, p_ahora timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = public, cdc, pg_temp
as $$
with
reloj as (
  select cdc.dia(p_ahora) as hoy,
         p_ahora at time zone 'America/Argentina/Buenos_Aires' as local
),
-- Sesión abierta a esta hora (la misma condición que cdc.pendientes).
corriendo as (
  select s.tarea_id, max(s.inicio) as inicio
    from tiempos s
   where s.usuario_id = p_usuario and s.inicio <= p_ahora
     and (s.fin is null or s.fin > p_ahora)
   group by s.tarea_id
),
tar as (
  select t.id, t.titulo, t.estado, t.vence, t.vence_fin, t.cerrada_el,
         p.nombre as proyecto, a.nombre as area, a.color,
         cdc.estado_fecha(t.vence, t.vence_fin, r.hoy) as ef,
         c.inicio as crono,
         r.hoy
    from tareas t
    cross join reloj r
    left join tareas m     on m.id = t.padre_id
    -- El proyecto de una subtarea puede venir de su madre.
    left join proyectos p  on p.id = coalesce(t.proyecto_id, m.proyecto_id)
    left join areas a      on a.id = coalesce(p.area_id, t.area_id, m.area_id)
    left join corriendo c  on c.tarea_id = t.id
   where t.usuario_id = p_usuario
),
-- Una madre con hijas abiertas es un contenedor, salvo que esté corriendo.
tarjeta as (
  select * from tar t
   where t.crono is not null
      or not exists (select 1 from tareas h
                      where h.padre_id = t.id and h.estado <> 'done')
),
en_curso as (
  select t.*, cdc.dia(e.desde) as desde,
         case when t.crono is not null then 0
              when e.desde is null then null
              else t.hoy - cdc.dia(greatest(e.desde, coalesce(s.ultima, e.desde)))
         end as quieta_dias
    from tarjeta t
    cross join lateral (select max(c.cuando) as desde from cambios_estado c
                         where c.tarea_id = t.id and c.a = 'in_progress'
                           and c.cuando <= p_ahora) e
    cross join lateral (select max(ts.inicio) as ultima from tiempos ts
                         where ts.tarea_id = t.id and ts.inicio >= e.desde
                           and ts.inicio <= p_ahora) s
   where t.estado = 'in_progress'
)
select jsonb_build_object(
  'hoy',        r.hoy,
  'dia_semana', (array['lunes','martes','miércoles','jueves','viernes','sábado','domingo'])
                  [extract(isodow from r.local)::int],
  'hora',       to_char(r.local, 'HH24:MI'),
  'no_trabaja', exists (select 1 from dias_sin_trabajo d
                         where d.usuario_id = p_usuario and d.dia = r.hoy),

  'atrasadas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id, 'titulo', t.titulo, 'area', t.area, 'color', t.color,
             'proyecto', t.proyecto, 'vence', t.vence, 'vence_fin', t.vence_fin,
             'dias_atraso', t.hoy - coalesce(t.vence_fin, t.vence))
           order by t.vence, t.titulo), '[]'::jsonb)
      from tarjeta t where t.estado = 'not_started' and t.ef = 'vencida'),

  'para_hoy', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id, 'titulo', t.titulo, 'area', t.area, 'color', t.color,
             'proyecto', t.proyecto, 'vence', t.vence, 'vence_fin', t.vence_fin)
           order by t.vence, t.titulo), '[]'::jsonb)
      from tarjeta t where t.estado = 'not_started' and t.ef = 'en_curso'),

  'en_curso', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', e.id, 'titulo', e.titulo, 'area', e.area, 'color', e.color,
             'proyecto', e.proyecto, 'desde', e.desde, 'quieta_dias', e.quieta_dias,
             'cronometro_desde', e.crono)
           order by e.crono is null, e.desde nulls last, e.titulo), '[]'::jsonb)
      from en_curso e),

  -- Próximos 10 días, sin las hechas (en curso incluidas, como "Próximas fechas").
  'proximas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', t.id, 'titulo', t.titulo, 'area', t.area, 'color', t.color,
             'vence', t.vence, 'vence_fin', t.vence_fin, 'en_dias', t.vence - t.hoy)
           order by t.vence, t.titulo), '[]'::jsonb)
      from tarjeta t
     where t.estado <> 'done' and t.vence > t.hoy and t.vence <= t.hoy + 10),

  'habitos', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', h.id, 'nombre', h.nombre, 'color', h.color,
             'hecho_hoy', exists (select 1 from cumplimientos k
                                   where k.habito_id = h.id and k.fecha = r.hoy and k.hecho))
           order by h.orden nulls last, h.nombre), '[]'::jsonb)
      from habitos h
     where h.usuario_id = p_usuario and coalesce(h.activo, true)),

  'proyectos', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'nombre', p.nombre, 'area', a.nombre, 'color', a.color,
             'hechas', (select count(*) from tareas t where t.proyecto_id = p.id and t.estado = 'done'),
             'total',  (select count(*) from tareas t where t.proyecto_id = p.id))
           order by p.nombre), '[]'::jsonb)
      from proyectos p left join areas a on a.id = p.area_id
     where p.usuario_id = p_usuario and p.estado = 'in_progress'),

  'sin_fecha',  (select count(*) from tarjeta t where t.estado <> 'done' and t.vence is null),
  'hechas_hoy', (select count(*) from tar t where t.estado = 'done' and t.cerrada_el = r.hoy),

  -- Avisos reales mandados hoy (hora de Buenos Aires).
  'avisos_hoy', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'tipo', v.tipo, 'nivel', v.nivel, 'titulo', v.titulo, 'cuerpo', v.cuerpo,
             'hora', to_char(v.enviado_el at time zone 'America/Argentina/Buenos_Aires', 'HH24:MI'),
             'entregado', v.entregado_el is not null)
           order by v.enviado_el), '[]'::jsonb)
      from avisos v
     where v.usuario_id = p_usuario and v.modo = 'real'
       and v.enviado_el is not null and cdc.dia(v.enviado_el) = r.hoy),

  'pendientes', (
    select coalesce(jsonb_agg(jsonb_build_object('tipo', x.tipo, 'datos', x.datos)), '[]'::jsonb)
      from cdc.pendientes(p_usuario, p_ahora, null, 'real') x)
)
from reloj r;
$$;

revoke all on function cdc.coucou_foco(uuid, timestamptz) from public, anon, authenticated;
grant execute on function cdc.coucou_foco(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
--  La puerta para la Edge Function. PostgREST expone solo `public`, así que la
--  RPC vive acá; el secreto se compara ADENTRO de la base (no sale de Vault).
--  Secreto distinto o ausente → null, y la función responde 401.
-- ---------------------------------------------------------------------------
create or replace function public.coucou_foco(p_secreto text, p_usuario uuid)
returns jsonb
language plpgsql
stable
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
  return cdc.coucou_foco(p_usuario, now());
end;
$$;

revoke all on function public.coucou_foco(text, uuid) from public, anon, authenticated;
grant execute on function public.coucou_foco(text, uuid) to service_role;

-- ---------------------------------------------------------------------------
--  El secreto (una sola vez; correrlo de nuevo no lo pisa). Para leerlo:
--    select decrypted_secret from vault.decrypted_secrets where name = 'cdc_coucou_secret';
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cdc_coucou_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(24), 'hex'),
      'cdc_coucou_secret',
      'Header x-coucou-secret de la Edge Function coucou-foco (isla de Coucou)');
  end if;
end;
$$;
