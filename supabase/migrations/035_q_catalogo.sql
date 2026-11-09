-- 035 · Catálogo de la capa de consulta: lista las funciones q_ con su firma y
-- su descripción (COMMENT), para que Claude descubra qué puede consultar.

insert into public.rollback_funciones (migracion, funcion, definicion)
select '035', p.oid::regprocedure::text, pg_get_functiondef(p.oid)
from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'q_catalogo';

create or replace function public.q_catalogo() returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'funciones', coalesce(jsonb_agg(jsonb_build_object(
        'funcion', p.proname,
        'firma', p.proname || '(' || pg_get_function_arguments(p.oid) || ')',
        'descripcion', obj_description(p.oid, 'pg_proc')) order by p.proname), '[]'::jsonb),
    'escritura', jsonb_build_array(
      'registrar_movimiento(...) — unica forma de cargar gastos, ingresos y transferencias',
      'registrar_ajuste(moneda, monto, motivo) — para cuadrar el saldo contra el banco'),
    'reglas', jsonb_build_array(
      'NUNCA calcular desde tablas crudas: usar estas funciones, que son las mismas que usa la app',
      'nunca INSERT/UPDATE/DELETE directo: escribir solo con registrar_movimiento / registrar_ajuste',
      'antes de escribir, mostrar la fila que se va a cargar y pedir confirmacion',
      'cada respuesta trae "reglas": leerlas antes de interpretar un numero'))
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname like 'q\_%' and p.proname not like 'q\_\_%'
$$;
comment on function public.q_catalogo() is
'Catálogo de la capa de consulta de Plata: cada función q_ con su firma y qué devuelve. Empezar por acá. Ejemplo: select q_catalogo();';

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'q\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
