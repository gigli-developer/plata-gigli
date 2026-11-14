-- Sistema de vida en el Centro de Control (proyecto Supabase cqnlceqghqqrlacbjhzj) · 2026-11-14
--
-- Fuente única para lo que Lucas le cuenta a Claude Cowork: diario/journal, comidas y macros,
-- hábitos, Rocks/hitos/reuniones, mediciones de la nutricionista y sus turnos.
-- Antes Cowork lo guardaba en un JSON dentro de un artifact (tablero "Sistema Lucas v1"),
-- en paralelo a las tablas del Centro que ya existían (diario, alimentos, comidas, hábitos, tareas).
--
-- Reglas:
--  * Las tablas nuevas siguen el patrón del Centro: usuario_id + RLS "<tabla>_propias".
--  * Las funciones de carga viven en el schema cdc y resuelven el usuario con cdc.usuario_actual():
--    auth.uid() si hay sesión; si no (SQL directo por el conector de Supabase), Lucas.
--  * Las columnas nuevas de tablas que ya usa la app son todas NULLABLE o con default: la app no se entera.
--  * Idempotente: se puede volver a correr.
-- Se corre en tres llamadas al MCP (cada una es una transacción): PARTE 1, PARTE 2, PARTE 3.

-- ════════════════════════════════ PARTE 1 · esquema ════════════════════════════════

create or replace function cdc.usuario_actual() returns uuid
language sql stable as $$
  select coalesce(auth.uid(), '772701e0-5ad4-4a01-94ae-20b6760b099c'::uuid)
$$;

-- Diario: el journal va en `cuerpo` (columna que ya existía). Lo demás es nuevo.
alter table public.diario
  add column if not exists energia_n smallint check (energia_n between 1 and 10),
  add column if not exists sueno_h numeric(3,1) check (sueno_h between 0 and 16),
  add column if not exists bien text,
  add column if not exists mejorar text,
  add column if not exists aprendi text,
  add column if not exists nota text,
  add column if not exists etiquetas text[],
  add column if not exists prioridades_manana jsonb,
  add column if not exists estado_registro text check (estado_registro in ('completo','parcial','sin_registro')),
  add column if not exists origen text;

-- Alimentos: grupo para decidir "comida completa" sin que cada chat lo juzgue a ojo.
alter table public.alimentos
  add column if not exists grupo text check (grupo in ('proteina','hidrato','grasa_saludable','vegetal','otro'));

-- Comidas: si los gramos son medidos o estimados, y quién cargó la fila.
alter table public.comidas
  add column if not exists estimado boolean not null default false,
  add column if not exists origen text;

-- Una fila por comida del día: lo que contó, dónde comió, si la salteó.
create table if not exists public.comidas_momentos (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null,
  momento text not null check (momento in ('desayuno','almuerzo','merienda','cena','snack')),
  descripcion text,
  donde text check (donde in ('casa','delivery','afuera')),
  salteada boolean not null default false,
  creado timestamptz not null default now(),
  unique (usuario_id, fecha, momento)
);

create table if not exists public.metas_nutricion (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  desde date not null,
  kcal numeric not null, proteina_g numeric not null, carbos_g numeric not null, grasas_g numeric not null,
  fuente text,
  creado timestamptz not null default now(),
  unique (usuario_id, desde)
);

create table if not exists public.turnos_salud (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null,
  hora time,
  profesional text not null default 'nutricionista',
  evento_calendar text,
  estudios_pedidos_el date,
  estudios_recibidos_el date,
  sin_estudios boolean not null default false,   -- ese turno no hubo medición: no volver a pedir
  nota text,
  creado timestamptz not null default now(),
  unique (usuario_id, fecha, profesional)
);

create table if not exists public.mediciones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null,
  tipo text not null default 'isak',
  peso_kg numeric, talla_cm numeric,
  masa_grasa_kg numeric, masa_libre_grasa_kg numeric,
  tejido_muscular_kg numeric, tejido_adiposo_kg numeric,
  suma_6_pliegues_mm numeric, suma_8_pliegues_mm numeric,
  cintura_cm numeric, brazo_contraido_cm numeric, muslo_medio_cm numeric,
  archivo text,
  datos jsonb,
  turno_id uuid references public.turnos_salud(id) on delete set null,
  creado timestamptz not null default now(),
  unique (usuario_id, fecha, tipo)
);

create table if not exists public.rocks (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  numero smallint not null,
  titulo text not null,
  meta text,
  meta_num numeric,
  desde date not null,
  hasta date not null,
  area_id uuid,
  creado timestamptz not null default now(),
  unique (usuario_id, desde, numero),
  unique (id, usuario_id)
);

create table if not exists public.hitos (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  rock_id uuid not null,
  titulo text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','en_curso','hecho')),
  fecha_objetivo date,
  hecho_el date,
  orden smallint,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  foreign key (rock_id, usuario_id) references public.rocks(id, usuario_id) on delete cascade
);

create table if not exists public.reuniones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references auth.users(id) on delete cascade,
  fecha date not null,
  titulo text not null,
  rock_id uuid,
  agenda_previa boolean,
  cierre_proximos_pasos boolean,
  puntaje smallint check (puntaje between 1 and 10),
  evento_calendar text,
  nota text,
  creado timestamptz not null default now(),
  foreign key (rock_id, usuario_id) references public.rocks(id, usuario_id) on delete set null (rock_id)
);

-- Tareas: de qué Rock cuelgan (null = mantenimiento).
alter table public.tareas add column if not exists rock_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tareas_rock_id_fkey') then
    alter table public.tareas add constraint tareas_rock_id_fkey
      foreign key (rock_id, usuario_id) references public.rocks(id, usuario_id) on delete set null (rock_id);
  end if;
end $$;

-- RLS como el resto del Centro.
do $$
declare t text;
begin
  foreach t in array array['comidas_momentos','metas_nutricion','turnos_salud','mediciones','rocks','hitos','reuniones'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_propias') then
      execute format('create policy %I on public.%I for all using (usuario_id = auth.uid()) with check (usuario_id = auth.uid())', t || '_propias', t);
    end if;
  end loop;
end $$;

-- ════════════════════════ PARTE 2 · alimentos y platos genéricos ════════════════════════
-- Valores cada 100 g, aproximados (tablas USDA / Argenfoods). Sirven para que todos los chats
-- calculen igual; si Lucas escanea el producto real en la app, ese gana.
-- La carne y los fideos secos van en PESO CRUDO (como se compran); lo cocido lo dice el nombre.

do $$
declare
  u uuid := cdc.usuario_actual();
  r record;
begin
  for r in select * from (values
    ('Bife vacuno magro (peso crudo)',     150, 21,   0,   7,   100, 'proteina'),
    ('Pechuga de pollo (peso crudo)',      120, 22.5, 0,   2.6, 150, 'proteina'),
    ('Milanesa de pollo frita',            260, 20,  14,  14,   150, 'proteina'),
    ('Milanesa de carne frita',            280, 18,  14,  17,   150, 'proteina'),
    ('Huevo',                              143, 12.6, 0.7, 9.5,  50, 'proteina'),
    ('Atún al natural',                    116, 26,   0,   1,   120, 'proteina'),
    ('Fideos secos',                       371, 13,  75,   1.5, 100, 'hidrato'),
    ('Fideos cocidos',                     158, 5.8, 31,   0.9, 250, 'hidrato'),
    ('Arroz blanco seco',                  360, 7,   79,   0.6, 100, 'hidrato'),
    ('Arroz blanco cocido',                130, 2.7, 28,   0.3, 200, 'hidrato'),
    ('Papa hervida o al horno',             87, 1.9, 20,   0.1, 200, 'hidrato'),
    ('Papas fritas caseras',               280, 3.4, 36,  14,   200, 'hidrato'),
    ('Pan lactal (rebanada)',              265, 9,   49,   3.2,  25, 'hidrato'),
    ('Pan francés',                        272, 10.8,52,   2.4,  60, 'hidrato'),
    ('Avena',                              389, 16.9,66,   6.9,  40, 'hidrato'),
    ('Banana',                              89, 1.1, 23,   0.3, 150, 'hidrato'),
    ('Manzana',                             52, 0.3, 14,   0.2, 180, 'hidrato'),
    ('Queso cremoso',                      300, 20,   2,  24,    30, 'otro'),
    ('Manteca',                            717, 0.9,  0.1,81,    10, 'otro'),
    ('Dulce de leche',                     315, 6.8, 55,   7.5,  20, 'otro'),
    ('Aceite de oliva',                    884, 0,    0, 100,    13, 'grasa_saludable'),
    ('Palta',                              160, 2,    8.5,14.7,  70, 'grasa_saludable'),
    ('Nueces',                             654, 15,  14,  65,    30, 'grasa_saludable'),
    ('Ensalada / verduras crudas',          25, 1.5,  4.5, 0.2, 150, 'vegetal'),
    ('Verduras cocidas (horno o salteadas)',50, 2,    8,   1.5, 150, 'vegetal'),
    ('Café (solo)',                          2, 0.1,  0,   0,   100, 'otro'),
    ('Gaseosa común',                       42, 0,   10.6, 0,   500, 'otro'),
    ('Cerveza',                             43, 0.5,  3.6, 0,   500, 'otro')
  ) as t(nombre, kcal, p, c, g, porcion, grupo)
  loop
    if not exists (select 1 from public.alimentos where usuario_id = u and lower(nombre) = lower(r.nombre)) then
      insert into public.alimentos (usuario_id, nombre, kcal_100g, proteinas_100g, carbos_100g, grasas_100g, porcion_g, origen, grupo, datos)
      values (u, r.nombre, r.kcal, r.p, r.c, r.g, r.porcion, 'manual', r.grupo, jsonb_build_object('fuente', 'generico'));
    end if;
  end loop;

  -- Los que Lucas ya escaneó: solo se les asigna grupo y porción.
  update public.alimentos set grupo = 'proteina', porcion_g = coalesce(porcion_g, 30)  where usuario_id = u and nombre ilike 'Whey%' and grupo is null;
  update public.alimentos set grupo = 'grasa_saludable', porcion_g = coalesce(porcion_g, 15) where usuario_id = u and nombre ilike 'Manteca de maní%' and grupo is null;
  update public.alimentos set grupo = 'otro', porcion_g = coalesce(porcion_g, 200) where usuario_id = u and nombre ilike 'Leche%' and grupo is null;
  update public.alimentos set grupo = 'otro', porcion_g = coalesce(porcion_g, 30)  where usuario_id = u and nombre ilike 'Casancrem%' and grupo is null;

  -- Platos de todos los días.
  insert into public.platos (usuario_id, nombre) values (u, 'Café con leche') on conflict (usuario_id, nombre) do nothing;
  insert into public.platos (usuario_id, nombre) values (u, 'Tostada con queso cremoso') on conflict (usuario_id, nombre) do nothing;
  insert into public.platos (usuario_id, nombre) values (u, 'Desayuno del plan') on conflict (usuario_id, nombre) do nothing;

  insert into public.plato_items (usuario_id, plato_id, alimento_id, cantidad_g)
  select u, p.id, a.id, x.g
  from (values
    ('Café con leche', 'Leche%', 150), ('Café con leche', 'Café (solo)', 100),
    ('Tostada con queso cremoso', 'Pan lactal (rebanada)', 25), ('Tostada con queso cremoso', 'Queso cremoso', 20),
    ('Desayuno del plan', 'Whey%', 30), ('Desayuno del plan', 'Banana', 150), ('Desayuno del plan', 'Manteca de maní%', 15)
  ) as x(plato, alimento, g)
  join public.platos p on p.usuario_id = u and p.nombre = x.plato
  join lateral (select id from public.alimentos where usuario_id = u and nombre ilike x.alimento order by creado limit 1) a on true
  on conflict (plato_id, alimento_id) do nothing;

  insert into public.metas_nutricion (usuario_id, desde, kcal, proteina_g, carbos_g, grasas_g, fuente)
  values (u, '2026-10-29', 2700, 140, 370, 70, 'Calculadas por Claude con la antropometría ISAK del 29/10/2026 (70,8 kg; MLG 59,6 kg): mantenimiento ~2.450 + 250 para ganar músculo')
  on conflict (usuario_id, desde) do nothing;
end $$;

-- ════════════════════════════════ PARTE 3 · funciones ════════════════════════════════

-- Busca un alimento o plato por nombre. Exacto primero; si no, "contiene" con un solo resultado.
create or replace function cdc.buscar_alimento(p_texto text)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x order by x->>'tipo', x->>'nombre'), '[]'::jsonb) from (
    select jsonb_build_object('tipo','alimento','id',id,'nombre',nombre,'kcal_100g',kcal_100g,'proteinas_100g',proteinas_100g,
             'carbos_100g',carbos_100g,'grasas_100g',grasas_100g,'porcion_g',porcion_g,'grupo',grupo) x
    from public.alimentos where usuario_id = cdc.usuario_actual() and nombre ilike '%' || btrim(p_texto) || '%'
    union all
    select jsonb_build_object('tipo','plato','id',p.id,'nombre',p.nombre,
             'items', (select jsonb_agg(jsonb_build_object('alimento',a.nombre,'g',pi.cantidad_g)) from public.plato_items pi join public.alimentos a on a.id = pi.alimento_id where pi.plato_id = p.id))
    from public.platos p where p.usuario_id = cdc.usuario_actual() and p.nombre ilike '%' || btrim(p_texto) || '%'
  ) s
$$;

create or replace function cdc.crear_alimento(p_nombre text, p_kcal_100g numeric, p_proteinas_100g numeric, p_carbos_100g numeric,
  p_grasas_100g numeric, p_porcion_g numeric, p_grupo text, p_fuente text default 'estimado por Claude')
returns jsonb language plpgsql as $$
declare u uuid := cdc.usuario_actual(); v_id uuid;
begin
  if exists (select 1 from public.alimentos where usuario_id = u and lower(nombre) = lower(btrim(p_nombre))) then
    raise exception 'Ya existe un alimento "%". Usá ese o elegí otro nombre.', p_nombre;
  end if;
  insert into public.alimentos (usuario_id, nombre, kcal_100g, proteinas_100g, carbos_100g, grasas_100g, porcion_g, origen, grupo, datos)
  values (u, btrim(p_nombre), p_kcal_100g, p_proteinas_100g, p_carbos_100g, p_grasas_100g, p_porcion_g, 'manual', p_grupo, jsonb_build_object('fuente', p_fuente))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'nombre', btrim(p_nombre));
end $$;

-- Macros y "completa" de cada comida. Criterio (plan de la nutricionista):
--   proteína ≥ 20 g · hidratos ≥ 30 g · algún alimento de grupo grasa_saludable ·
--   en almuerzo y cena, además, ≥ 80 g de grupo vegetal. Merienda y snack no cuentan como principales.
create or replace view public.nutricion_comidas with (security_invoker = true) as
with filas as (
  select c.usuario_id, c.fecha, c.momento, c.cantidad_g, c.estimado, a.grupo,
         cdc.macro(c.cantidad_g, a.kcal_100g) kcal, cdc.macro(c.cantidad_g, a.proteinas_100g) prot,
         cdc.macro(c.cantidad_g, a.carbos_100g) carb, cdc.macro(c.cantidad_g, a.grasas_100g) gras,
         cdc.macros_incompletos(a.kcal_100g, a.proteinas_100g, a.carbos_100g, a.grasas_100g) incompleto
  from public.comidas c join public.alimentos a on a.id = c.alimento_id
), agg as (
  select usuario_id, fecha, momento,
         round(sum(kcal)) kcal, round(sum(prot),1) proteina_g, round(sum(carb),1) carbos_g, round(sum(gras),1) grasas_g,
         bool_or(estimado) estimado, bool_or(incompleto) macros_incompletos,
         sum(prot) >= 20 tiene_proteina, sum(carb) >= 30 tiene_hidrato,
         bool_or(grupo = 'grasa_saludable') tiene_grasa_saludable,
         coalesce(sum(cantidad_g) filter (where grupo = 'vegetal'), 0) >= 80 tiene_vegetales
  from filas group by 1,2,3
)
select coalesce(a.usuario_id, m.usuario_id) usuario_id, coalesce(a.fecha, m.fecha) fecha, coalesce(a.momento, m.momento) momento,
       m.descripcion, m.donde, coalesce(m.salteada, false) salteada,
       coalesce(a.kcal,0) kcal, coalesce(a.proteina_g,0) proteina_g, coalesce(a.carbos_g,0) carbos_g, coalesce(a.grasas_g,0) grasas_g,
       a.estimado, a.macros_incompletos,
       coalesce(a.tiene_proteina,false) tiene_proteina, coalesce(a.tiene_hidrato,false) tiene_hidrato,
       coalesce(a.tiene_grasa_saludable,false) tiene_grasa_saludable, coalesce(a.tiene_vegetales,false) tiene_vegetales,
       case when coalesce(a.momento, m.momento) not in ('desayuno','almuerzo','cena') then null
            else coalesce(a.tiene_proteina and a.tiene_hidrato and a.tiene_grasa_saludable
                          and (coalesce(a.momento, m.momento) = 'desayuno' or a.tiene_vegetales), false) end completa
from agg a full join public.comidas_momentos m on m.usuario_id = a.usuario_id and m.fecha = a.fecha and m.momento = a.momento;

create or replace view public.nutricion_dias with (security_invoker = true) as
select n.usuario_id, n.fecha,
       sum(n.kcal) kcal, sum(n.proteina_g) proteina_g, sum(n.carbos_g) carbos_g, sum(n.grasas_g) grasas_g,
       count(*) filter (where n.completa) comidas_completas,
       count(*) filter (where n.momento in ('desayuno','almuerzo','cena')) principales_registradas,
       bool_or(n.estimado) estimado,
       mt.kcal meta_kcal, mt.proteina_g meta_proteina_g, mt.carbos_g meta_carbos_g, mt.grasas_g meta_grasas_g
from public.nutricion_comidas n
left join lateral (select * from public.metas_nutricion m where m.usuario_id = n.usuario_id and m.desde <= n.fecha order by m.desde desc limit 1) mt on true
group by n.usuario_id, n.fecha, mt.kcal, mt.proteina_g, mt.carbos_g, mt.grasas_g;

-- Carga una comida. p_items: [{"alimento":"Bife vacuno magro (peso crudo)","g":200}, {"plato":"Café con leche"},
--   {"alimento":"Fideos cocidos"} ← sin g usa la porción y queda estimado, {"plato":"Tostada con queso cremoso","veces":3}].
-- "g" con "medido": true si Lucas pesó o leyó el paquete; si no, estimado.
-- Reemplaza lo que Cowork había cargado para esa fecha y momento (no toca lo cargado desde la app).
-- p_salteada => true y p_items vacío: la comida no se hizo.
create or replace function cdc.registrar_comida(p_fecha date, p_momento text, p_items jsonb default '[]'::jsonb,
  p_descripcion text default null, p_donde text default null, p_salteada boolean default false)
returns jsonb language plpgsql as $$
declare
  u uuid := cdc.usuario_actual();
  it jsonb; v_alim record; v_plato record; v_g numeric; v_veces numeric; v_est boolean; n int;
  v_borradas int;
begin
  if p_momento not in ('desayuno','almuerzo','merienda','cena','snack') then
    raise exception 'Momento inválido: %. Usá desayuno, almuerzo, merienda, cena o snack.', p_momento;
  end if;
  if p_fecha > cdc.hoy() then raise exception 'La fecha % es futura.', p_fecha; end if;

  delete from public.comidas where usuario_id = u and fecha = p_fecha and momento = p_momento and origen = 'cowork';
  get diagnostics v_borradas = row_count;

  insert into public.comidas_momentos (usuario_id, fecha, momento, descripcion, donde, salteada)
  values (u, p_fecha, p_momento, p_descripcion, p_donde, p_salteada)
  on conflict (usuario_id, fecha, momento) do update
    set descripcion = coalesce(excluded.descripcion, comidas_momentos.descripcion),
        donde = coalesce(excluded.donde, comidas_momentos.donde),
        salteada = excluded.salteada;

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_veces := coalesce((it->>'veces')::numeric, 1);
    if it ? 'plato' then
      select * into v_plato from public.platos where usuario_id = u and lower(nombre) = lower(btrim(it->>'plato'));
      if not found then
        select count(*) into n from public.platos where usuario_id = u and nombre ilike '%' || btrim(it->>'plato') || '%';
        if n = 1 then select * into v_plato from public.platos where usuario_id = u and nombre ilike '%' || btrim(it->>'plato') || '%';
        else raise exception 'No encontré un único plato "%" (% coincidencias). Probá cdc.buscar_alimento().', it->>'plato', n; end if;
      end if;
      insert into public.comidas (usuario_id, alimento_id, fecha, momento, cantidad_g, plato_id, estimado, origen)
      select u, pi.alimento_id, p_fecha, p_momento, pi.cantidad_g * v_veces, v_plato.id, not coalesce((it->>'medido')::boolean, false), 'cowork'
      from public.plato_items pi where pi.plato_id = v_plato.id;
    else
      select * into v_alim from public.alimentos where usuario_id = u and lower(nombre) = lower(btrim(it->>'alimento'));
      if not found then
        select count(*) into n from public.alimentos where usuario_id = u and nombre ilike '%' || btrim(it->>'alimento') || '%';
        if n = 1 then select * into v_alim from public.alimentos where usuario_id = u and nombre ilike '%' || btrim(it->>'alimento') || '%';
        else raise exception 'No encontré un único alimento "%" (% coincidencias). Probá cdc.buscar_alimento() o cdc.crear_alimento().', it->>'alimento', n; end if;
      end if;
      v_g := coalesce((it->>'g')::numeric, v_alim.porcion_g * v_veces);
      if v_g is null then raise exception 'Falta "g" para "%" y no tiene porción por defecto.', v_alim.nombre; end if;
      v_est := not coalesce((it->>'medido')::boolean, false);
      insert into public.comidas (usuario_id, alimento_id, fecha, momento, cantidad_g, estimado, origen)
      values (u, v_alim.id, p_fecha, p_momento, v_g, v_est, 'cowork');
    end if;
  end loop;

  perform cdc.refrescar_estado_dia(u, p_fecha);

  return jsonb_build_object(
    'ok', true, 'reemplazadas', v_borradas,
    'comida', (select to_jsonb(nc) - 'usuario_id' from public.nutricion_comidas nc where nc.usuario_id = u and nc.fecha = p_fecha and nc.momento = p_momento),
    'dia', (select to_jsonb(nd) - 'usuario_id' from public.nutricion_dias nd where nd.usuario_id = u and nd.fecha = p_fecha));
end $$;

-- Estado del día: completo si tiene energía, sueño y alguna comida. Lo llaman registrar_dia y registrar_comida.
create or replace function cdc.refrescar_estado_dia(p_usuario uuid, p_fecha date)
returns void language sql as $$
  update public.diario d set estado_registro =
    case when d.energia_n is not null and d.sueno_h is not null
              and exists (select 1 from public.comidas_momentos m where m.usuario_id = p_usuario and m.fecha = p_fecha) then 'completo'
         else 'parcial' end
  where d.usuario_id = p_usuario and d.fecha = p_fecha and coalesce(d.estado_registro, '') <> 'sin_registro'
$$;

-- Marca un hábito por nombre (Gimnasio, Lectura, Journaling nocturno).
create or replace function cdc.marcar_habito(p_nombre text, p_fecha date, p_hecho boolean)
returns void language plpgsql as $$
declare u uuid := cdc.usuario_actual(); v_h uuid;
begin
  select id into v_h from public.habitos where usuario_id = u and lower(nombre) = lower(p_nombre);
  if v_h is null then raise exception 'No existe el hábito "%".', p_nombre; end if;
  insert into public.cumplimientos (usuario_id, habito_id, fecha, hecho) values (u, v_h, p_fecha, p_hecho)
  on conflict (habito_id, fecha) do update set hecho = excluded.hecho;
end $$;

-- Carga (o completa) el día. Los parámetros null NO borran lo que ya había.
-- p_journal: lo que Lucas contó, casi textual. Con p_journal_modo 'agregar' (default) se suma a lo anterior del día.
-- p_prioridades_manana: títulos; si coinciden con una tarea abierta del Centro, queda linkeada.
create or replace function cdc.registrar_dia(
  p_fecha date,
  p_energia integer default null, p_sueno_h numeric default null,
  p_journal text default null, p_bien text default null, p_mejorar text default null, p_aprendi text default null,
  p_nota text default null, p_etiquetas text[] default null,
  p_gym boolean default null, p_lectura boolean default null,
  p_prioridades_manana text[] default null,
  p_sin_registro boolean default false,
  p_journal_modo text default 'agregar')
returns jsonb language plpgsql as $$
declare
  u uuid := cdc.usuario_actual(); d public.diario; v_prio jsonb; t text; v_tid uuid; v_tit text;
begin
  if p_fecha > cdc.hoy() then raise exception 'La fecha % es futura.', p_fecha; end if;

  if p_prioridades_manana is not null then
    v_prio := '[]'::jsonb;
    foreach t in array p_prioridades_manana loop
      v_tid := null; v_tit := null;
      select id, titulo into v_tid, v_tit from public.tareas
       where usuario_id = u and estado <> 'done' and (lower(titulo) = lower(btrim(t)) or titulo ilike '%' || btrim(t) || '%')
       order by (lower(titulo) = lower(btrim(t))) desc, creado desc limit 1;
      v_prio := v_prio || jsonb_build_object('titulo', coalesce(v_tit, btrim(t)), 'tarea_id', v_tid);
    end loop;
  end if;

  insert into public.diario (usuario_id, fecha, tipo) values (u, p_fecha, 'diaria')
  on conflict (usuario_id, fecha) do nothing;

  update public.diario set
    energia_n = coalesce(p_energia, energia_n),
    energia   = case when p_energia is null then energia when p_energia >= 8 then 'alta' when p_energia >= 5 then 'media' else 'baja' end,
    sueno_h   = coalesce(p_sueno_h, sueno_h),
    cuerpo    = case when p_journal is null then cuerpo
                     when p_journal_modo = 'reemplazar' or cuerpo is null then p_journal
                     else cuerpo || E'\n\n' || p_journal end,
    bien = coalesce(p_bien, bien), mejorar = coalesce(p_mejorar, mejorar), aprendi = coalesce(p_aprendi, aprendi),
    nota = coalesce(p_nota, nota),
    etiquetas = case when p_etiquetas is null then etiquetas
                     else (select array_agg(distinct e order by e) from unnest(coalesce(etiquetas, '{}') || p_etiquetas) e) end,
    prioridades_manana = coalesce(v_prio, prioridades_manana),
    origen = coalesce(origen, 'cowork')
  where usuario_id = u and fecha = p_fecha
  returning * into d;

  if p_gym is not null then perform cdc.marcar_habito('Gimnasio', p_fecha, p_gym); end if;
  if p_lectura is not null then perform cdc.marcar_habito('Lectura', p_fecha, p_lectura); end if;
  if p_journal is not null then perform cdc.marcar_habito('Journaling nocturno', p_fecha, true); end if;

  if p_sin_registro then
    update public.diario set estado_registro = 'sin_registro' where id = d.id;
  else
    perform cdc.refrescar_estado_dia(u, p_fecha);
  end if;
  select * into d from public.diario where id = d.id;

  return jsonb_build_object('ok', true, 'dia', to_jsonb(d) - 'usuario_id' - 'id',
    'habitos', (select jsonb_object_agg(h.nombre, c.hecho) from public.cumplimientos c join public.habitos h on h.id = c.habito_id where c.usuario_id = u and c.fecha = p_fecha));
end $$;

-- Días desde p_desde hasta ayer que no tienen registro (para preguntar en el check-in).
create or replace function cdc.dias_sin_registro(p_desde date default '2026-11-09')
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('fecha', x.fecha, 'falta', x.falta) order by x.fecha), '[]'::jsonb)
  from (
    select f::date fecha, array_remove(array[
             case when d.energia_n is null then 'energia' end,
             case when d.sueno_h is null then 'sueno' end,
             case when d.cuerpo is null then 'journal' end,
             case when not exists (select 1 from public.comidas_momentos m where m.usuario_id = cdc.usuario_actual() and m.fecha = f::date) then 'comidas' end
           ], null) falta
    from generate_series(p_desde, cdc.hoy() - 1, interval '1 day') f
    left join public.diario d on d.usuario_id = cdc.usuario_actual() and d.fecha = f::date
    where coalesce(d.estado_registro, '') <> 'sin_registro'
  ) x
  where cardinality(x.falta) > 0
$$;

-- Nutrición de un rango: cada día con sus comidas, totales vs meta y cobertura.
create or replace function cdc.nutricion(p_desde date default null, p_hasta date default null)
returns jsonb language sql stable as $$
  with r as (select coalesce(p_desde, cdc.hoy() - 6) desde, coalesce(p_hasta, cdc.hoy()) hasta),
  dias as (
    select d.*, (select jsonb_agg(to_jsonb(c) - 'usuario_id' - 'fecha' order by array_position(array['desayuno','almuerzo','merienda','cena','snack'], c.momento))
                 from public.nutricion_comidas c where c.usuario_id = d.usuario_id and c.fecha = d.fecha) comidas
    from public.nutricion_dias d, r where d.usuario_id = cdc.usuario_actual() and d.fecha between r.desde and r.hasta)
  select jsonb_build_object(
    'desde', (select desde from r), 'hasta', (select hasta from r),
    'dias_con_comidas', (select count(*) from dias),
    'dias_del_rango', (select hasta - desde + 1 from r),
    'promedio', (select jsonb_build_object('kcal', round(avg(kcal)), 'proteina_g', round(avg(proteina_g)), 'carbos_g', round(avg(carbos_g)),
                   'grasas_g', round(avg(grasas_g)), 'comidas_completas', round(avg(comidas_completas), 1)) from dias),
    'meta', (select jsonb_build_object('kcal', meta_kcal, 'proteina_g', meta_proteina_g, 'carbos_g', meta_carbos_g, 'grasas_g', meta_grasas_g) from dias order by fecha desc limit 1),
    'fallas', (select jsonb_build_object(
                 'sin_proteina', count(*) filter (where not tiene_proteina and not salteada),
                 'sin_hidrato', count(*) filter (where not tiene_hidrato and not salteada),
                 'sin_grasa_saludable', count(*) filter (where not tiene_grasa_saludable and not salteada),
                 'sin_vegetales', count(*) filter (where not tiene_vegetales and momento in ('almuerzo','cena') and not salteada),
                 'salteadas', count(*) filter (where salteada),
                 'principales', count(*))
               from public.nutricion_comidas c, r where c.usuario_id = cdc.usuario_actual() and c.fecha between r.desde and r.hasta and c.momento in ('desayuno','almuerzo','cena')),
    'dias', (select coalesce(jsonb_agg(to_jsonb(dd) - 'usuario_id' order by dd.fecha), '[]'::jsonb) from dias dd))
$$;

-- ── Salud: turnos con la nutricionista y mediciones ──
create or replace function cdc.registrar_turno_salud(p_fecha date, p_profesional text default 'nutricionista',
  p_evento_calendar text default null, p_hora time default null, p_nota text default null)
returns jsonb language plpgsql as $$
declare u uuid := cdc.usuario_actual(); t public.turnos_salud;
begin
  insert into public.turnos_salud (usuario_id, fecha, hora, profesional, evento_calendar, nota)
  values (u, p_fecha, p_hora, lower(btrim(p_profesional)), p_evento_calendar, p_nota)
  on conflict (usuario_id, fecha, profesional) do update
    set evento_calendar = coalesce(excluded.evento_calendar, turnos_salud.evento_calendar),
        hora = coalesce(excluded.hora, turnos_salud.hora), nota = coalesce(excluded.nota, turnos_salud.nota)
  returning * into t;
  return jsonb_build_object('ok', true, 'turno', to_jsonb(t) - 'usuario_id');
end $$;

-- Qué hay que pedirle a Lucas: turnos ya pasados (desde ayer) sin estudios cargados, y aviso si hace
-- más de 35 días que no hay medición (por si el turno no estaba en Calendar).
-- p_marcar_pedido => true: deja anotado que hoy se pidieron (para no insistir dos veces el mismo día).
create or replace function cdc.estudios_pendientes(p_marcar_pedido boolean default false)
returns jsonb language plpgsql as $$
declare u uuid := cdc.usuario_actual(); v_pend jsonb; v_ult date;
begin
  select coalesce(jsonb_agg(jsonb_build_object('turno_id', id, 'fecha', fecha, 'profesional', profesional,
           'dias_desde_turno', cdc.hoy() - fecha, 'ya_pedido_el', estudios_pedidos_el) order by fecha), '[]'::jsonb)
    into v_pend
  from public.turnos_salud
  where usuario_id = u and fecha < cdc.hoy() and estudios_recibidos_el is null and not sin_estudios
    and fecha >= cdc.hoy() - 30
    and (estudios_pedidos_el is null or estudios_pedidos_el < cdc.hoy());

  if p_marcar_pedido then
    update public.turnos_salud set estudios_pedidos_el = cdc.hoy()
    where usuario_id = u and id in (select (x->>'turno_id')::uuid from jsonb_array_elements(v_pend) x);
  end if;

  select max(fecha) into v_ult from public.mediciones where usuario_id = u;
  return jsonb_build_object('pendientes', v_pend, 'ultima_medicion', v_ult,
    'dias_sin_medicion', cdc.hoy() - v_ult,
    'preguntar_si_hubo_turno', v_ult is not null and cdc.hoy() - v_ult > 35 and jsonb_array_length(v_pend) = 0);
end $$;

-- Carga una medición (claves = columnas de mediciones; lo que no tenga columna va a `datos`).
-- La linkea al turno de esa fecha o de los 10 días anteriores, y lo marca como recibido.
-- Devuelve la comparación contra la medición anterior.
create or replace function cdc.registrar_medicion(p_fecha date, p_datos jsonb, p_archivo text default null, p_tipo text default 'isak')
returns jsonb language plpgsql as $$
declare
  u uuid := cdc.usuario_actual(); m public.mediciones; ant public.mediciones; v_turno uuid;
  cols text[] := array['peso_kg','talla_cm','masa_grasa_kg','masa_libre_grasa_kg','tejido_muscular_kg','tejido_adiposo_kg',
                       'suma_6_pliegues_mm','suma_8_pliegues_mm','cintura_cm','brazo_contraido_cm','muslo_medio_cm'];
  extra jsonb := '{}'::jsonb; k text;
begin
  for k in select jsonb_object_keys(p_datos) loop
    if not (k = any(cols)) then extra := extra || jsonb_build_object(k, p_datos->k); end if;
  end loop;

  select id into v_turno from public.turnos_salud
   where usuario_id = u and fecha between p_fecha - 10 and p_fecha order by fecha desc limit 1;
  if v_turno is null then
    insert into public.turnos_salud (usuario_id, fecha, profesional, nota)
    values (u, p_fecha, 'nutricionista', 'Creado al cargar la medición: el turno no estaba registrado')
    on conflict (usuario_id, fecha, profesional) do nothing;
    select id into v_turno from public.turnos_salud where usuario_id = u and fecha = p_fecha and profesional = 'nutricionista';
  end if;

  insert into public.mediciones (usuario_id, fecha, tipo, peso_kg, talla_cm, masa_grasa_kg, masa_libre_grasa_kg, tejido_muscular_kg,
    tejido_adiposo_kg, suma_6_pliegues_mm, suma_8_pliegues_mm, cintura_cm, brazo_contraido_cm, muslo_medio_cm, archivo, datos, turno_id)
  values (u, p_fecha, p_tipo, (p_datos->>'peso_kg')::numeric, (p_datos->>'talla_cm')::numeric, (p_datos->>'masa_grasa_kg')::numeric,
    (p_datos->>'masa_libre_grasa_kg')::numeric, (p_datos->>'tejido_muscular_kg')::numeric, (p_datos->>'tejido_adiposo_kg')::numeric,
    (p_datos->>'suma_6_pliegues_mm')::numeric, (p_datos->>'suma_8_pliegues_mm')::numeric, (p_datos->>'cintura_cm')::numeric,
    (p_datos->>'brazo_contraido_cm')::numeric, (p_datos->>'muslo_medio_cm')::numeric, p_archivo, nullif(extra, '{}'::jsonb), v_turno)
  on conflict (usuario_id, fecha, tipo) do update set
    peso_kg = excluded.peso_kg, talla_cm = excluded.talla_cm, masa_grasa_kg = excluded.masa_grasa_kg,
    masa_libre_grasa_kg = excluded.masa_libre_grasa_kg, tejido_muscular_kg = excluded.tejido_muscular_kg,
    tejido_adiposo_kg = excluded.tejido_adiposo_kg, suma_6_pliegues_mm = excluded.suma_6_pliegues_mm,
    suma_8_pliegues_mm = excluded.suma_8_pliegues_mm, cintura_cm = excluded.cintura_cm,
    brazo_contraido_cm = excluded.brazo_contraido_cm, muslo_medio_cm = excluded.muslo_medio_cm,
    archivo = coalesce(excluded.archivo, mediciones.archivo), datos = coalesce(excluded.datos, mediciones.datos), turno_id = excluded.turno_id
  returning * into m;

  update public.turnos_salud set estudios_recibidos_el = cdc.hoy() where id = v_turno and estudios_recibidos_el is null;

  select * into ant from public.mediciones where usuario_id = u and tipo = p_tipo and fecha < p_fecha order by fecha desc limit 1;
  return jsonb_build_object('ok', true, 'medicion', to_jsonb(m) - 'usuario_id',
    'vs_anterior', case when ant.id is null then null else jsonb_build_object(
      'fecha_anterior', ant.fecha, 'dias', p_fecha - ant.fecha,
      'peso_kg', m.peso_kg - ant.peso_kg, 'masa_grasa_kg', m.masa_grasa_kg - ant.masa_grasa_kg,
      'masa_libre_grasa_kg', m.masa_libre_grasa_kg - ant.masa_libre_grasa_kg,
      'tejido_muscular_kg', m.tejido_muscular_kg - ant.tejido_muscular_kg,
      'suma_6_pliegues_mm', m.suma_6_pliegues_mm - ant.suma_6_pliegues_mm) end,
    'recordatorio', 'Recalcular metas con cdc.fijar_metas() si cambió el peso o la masa libre de grasa.');
end $$;

create or replace function cdc.fijar_metas(p_desde date, p_kcal numeric, p_proteina_g numeric, p_carbos_g numeric, p_grasas_g numeric, p_fuente text)
returns jsonb language plpgsql as $$
begin
  insert into public.metas_nutricion (usuario_id, desde, kcal, proteina_g, carbos_g, grasas_g, fuente)
  values (cdc.usuario_actual(), p_desde, p_kcal, p_proteina_g, p_carbos_g, p_grasas_g, p_fuente)
  on conflict (usuario_id, desde) do update set kcal = excluded.kcal, proteina_g = excluded.proteina_g,
    carbos_g = excluded.carbos_g, grasas_g = excluded.grasas_g, fuente = excluded.fuente;
  return jsonb_build_object('ok', true);
end $$;


-- El turno no tuvo medición (consulta de control, etc.): no volver a pedir estudios.
create or replace function cdc.turno_sin_estudios(p_fecha date, p_nota text default null, p_profesional text default 'nutricionista')
returns jsonb language plpgsql as $$
declare t public.turnos_salud;
begin
  update public.turnos_salud set sin_estudios = true, nota = coalesce(p_nota, nota)
  where usuario_id = cdc.usuario_actual() and fecha = p_fecha and profesional = lower(btrim(p_profesional))
  returning * into t;
  if t.id is null then raise exception 'No hay turno de % el %.', p_profesional, p_fecha; end if;
  return jsonb_build_object('ok', true, 'turno', to_jsonb(t) - 'usuario_id');
end $$;

-- De qué Rock cuelga una tarea (p_rock null = mantenimiento). La tarea se crea con cdc.coucou_accion('nueva').
create or replace function cdc.colgar_tarea(p_tarea_id uuid, p_rock integer)
returns jsonb language plpgsql as $$
declare u uuid := cdc.usuario_actual(); v_rock uuid; n int;
begin
  if p_rock is not null then
    select id into v_rock from public.rocks where usuario_id = u and numero = p_rock and cdc.hoy() between desde and hasta;
    if v_rock is null then raise exception 'No hay Rock % vigente.', p_rock; end if;
  end if;
  update public.tareas set rock_id = v_rock where id = p_tarea_id and usuario_id = u;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'No encontré esa tarea.'; end if;
  return jsonb_build_object('ok', true, 'tarea_id', p_tarea_id, 'rock', p_rock);
end $$;

-- ── Rocks ──
create or replace function cdc.registrar_reunion(p_fecha date, p_titulo text, p_agenda_previa boolean, p_cierre_proximos_pasos boolean,
  p_puntaje integer, p_rock integer default 1, p_evento_calendar text default null, p_nota text default null)
returns jsonb language plpgsql as $$
declare u uuid := cdc.usuario_actual(); v_rock uuid; r public.reuniones;
begin
  select id into v_rock from public.rocks where usuario_id = u and numero = p_rock and p_fecha between desde and hasta order by desde desc limit 1;
  insert into public.reuniones (usuario_id, fecha, titulo, rock_id, agenda_previa, cierre_proximos_pasos, puntaje, evento_calendar, nota)
  values (u, p_fecha, p_titulo, v_rock, p_agenda_previa, p_cierre_proximos_pasos, p_puntaje, p_evento_calendar, p_nota)
  returning * into r;
  return jsonb_build_object('ok', true, 'reunion', to_jsonb(r) - 'usuario_id',
    'validas_en_el_rock', (select count(*) from public.reuniones where rock_id = v_rock and agenda_previa and cierre_proximos_pasos));
end $$;

create or replace function cdc.actualizar_hito(p_hito text, p_estado text, p_fecha_objetivo date default null)
returns jsonb language plpgsql as $$
declare u uuid := cdc.usuario_actual(); h public.hitos; n int;
begin
  select count(*) into n from public.hitos where usuario_id = u and titulo ilike '%' || btrim(p_hito) || '%';
  if n <> 1 then raise exception 'No encontré un único hito "%" (% coincidencias).', p_hito, n; end if;
  update public.hitos set estado = p_estado, fecha_objetivo = coalesce(p_fecha_objetivo, fecha_objetivo),
         hecho_el = case when p_estado = 'hecho' then coalesce(hecho_el, cdc.hoy()) else null end, actualizado = now()
  where usuario_id = u and titulo ilike '%' || btrim(p_hito) || '%' returning * into h;
  return jsonb_build_object('ok', true, 'hito', to_jsonb(h) - 'usuario_id');
end $$;

-- Scorecard de una semana (lunes a domingo). Por defecto, la semana en curso.
create or replace function cdc.scorecard(p_lunes date default null)
returns jsonb language sql stable as $$
  with s as (select coalesce(p_lunes, cdc.hoy() - ((extract(isodow from cdc.hoy())::int) - 1)) lunes),
  w as (select lunes, lunes + 6 domingo from s),
  rk as (select * from public.rocks where usuario_id = cdc.usuario_actual() and (select lunes from w) between desde and hasta),
  dia as (select d.* from public.diario d, w where d.usuario_id = cdc.usuario_actual() and d.fecha between w.lunes and w.domingo),
  hab as (select h.nombre, count(*) filter (where c.hecho) n from public.cumplimientos c join public.habitos h on h.id = c.habito_id, w
          where c.usuario_id = cdc.usuario_actual() and c.fecha between w.lunes and w.domingo group by h.nombre),
  nut as (select n.* from public.nutricion_dias n, w where n.usuario_id = cdc.usuario_actual() and n.fecha between w.lunes and w.domingo)
  select jsonb_build_object(
    'semana', (select lunes from w), 'hasta', (select domingo from w),
    'semana_n', (select (((select lunes from w) - min(desde)) / 7) + 1 from rk),
    'gym', jsonb_build_object('hechos', coalesce((select n from hab where nombre = 'Gimnasio'), 0), 'meta', 3),
    'lectura', jsonb_build_object('hechos', coalesce((select n from hab where nombre = 'Lectura'), 0), 'meta', 1),
    'sueno', (select jsonb_build_object('dias_con_dato', count(sueno_h), 'dias_7h_o_mas', count(*) filter (where sueno_h >= 7), 'promedio', round(avg(sueno_h), 1), 'meta_h', 7) from dia),
    'energia', (select jsonb_build_object('dias_con_dato', count(energia_n), 'promedio', round(avg(energia_n), 1)) from dia),
    'comidas', (select jsonb_build_object('dias', count(*), 'completas_promedio', round(avg(comidas_completas), 1), 'meta_desde', '2026-11-30',
                  'kcal_promedio', round(avg(kcal)), 'proteina_promedio', round(avg(proteina_g)), 'meta_kcal', max(meta_kcal), 'meta_proteina_g', max(meta_proteina_g)) from nut),
    'rock1_reuniones', (select jsonb_build_object('validas', count(*) filter (where r.agenda_previa and r.cierre_proximos_pasos), 'total', count(*),
                  'puntaje_promedio', round(avg(r.puntaje), 1), 'meta', 10)
                  from public.reuniones r where r.rock_id in (select id from rk where numero = 1)),
    'rock2_hitos', (select jsonb_agg(jsonb_build_object('hito', h.titulo, 'estado', h.estado, 'fecha_objetivo', h.fecha_objetivo) order by h.orden)
                  from public.hitos h where h.rock_id in (select id from rk where numero = 2)),
    'dias_sin_registro', cdc.dias_sin_registro((select lunes from w)))
$$;

create or replace function cdc.vida_catalogo()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'regla', 'Cargá siempre por estas funciones, nunca con INSERT/UPDATE a mano. Fecha = el día que se cuenta (ART); un mensaje después de medianoche sobre "hoy" va al día anterior.',
    'funciones', jsonb_build_array(
      'cdc.registrar_dia(p_fecha, p_energia, p_sueno_h, p_journal, p_bien, p_mejorar, p_aprendi, p_nota, p_etiquetas, p_gym, p_lectura, p_prioridades_manana, p_sin_registro, p_journal_modo) — null no borra',
      'cdc.registrar_comida(p_fecha, p_momento, p_items, p_descripcion, p_donde, p_salteada) — items [{"alimento":..,"g":..,"medido":bool} | {"plato":..,"veces":..}]',
      'cdc.buscar_alimento(texto) · cdc.crear_alimento(nombre, kcal, prot, carb, grasa, porcion_g, grupo, fuente)',
      'cdc.nutricion(desde, hasta) — totales, promedio vs meta, qué falla',
      'cdc.dias_sin_registro(desde) — qué días faltan cargar',
      'cdc.registrar_turno_salud(fecha, profesional, evento_calendar, hora) · cdc.estudios_pendientes(p_marcar_pedido) · cdc.turno_sin_estudios(fecha, nota) · cdc.registrar_medicion(fecha, datos, archivo) · cdc.fijar_metas(...)',
      'cdc.registrar_reunion(fecha, titulo, agenda_previa, cierre_proximos_pasos, puntaje, rock) · cdc.actualizar_hito(hito, estado, fecha_objetivo)',
      'cdc.scorecard(lunes) — scorecard de la semana',
      'Tareas: cdc.coucou_accion(cdc.usuario_actual(), accion, args) con nueva | hecha | mover | reabrir (misma semántica que la app del Centro) · cdc.colgar_tarea(tarea_id, rock) (null = mantenimiento)'),
    'grupos_alimento', '["proteina","hidrato","grasa_saludable","vegetal","otro"]',
    'comida_completa', 'proteína ≥ 20 g, hidratos ≥ 30 g, algún alimento grasa_saludable y, en almuerzo y cena, ≥ 80 g de vegetales')
$$;

-- Solo usuarios con sesión (y el conector, que entra como postgres). Nada para anon.
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
           where p.pronamespace = 'cdc'::regnamespace
             and p.proname in ('usuario_actual','refrescar_estado_dia','buscar_alimento','crear_alimento','registrar_comida','marcar_habito','registrar_dia',
                               'dias_sin_registro','nutricion','registrar_turno_salud','estudios_pendientes','registrar_medicion',
                               'fijar_metas','registrar_reunion','actualizar_hito','scorecard','vida_catalogo','turno_sin_estudios','colgar_tarea') loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
