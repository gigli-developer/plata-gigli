-- ============================================================================
-- MIGRACIÓN · 2026-08-14 · Fase 6 — Puente con Claude Code
--
-- Tabla `tareas_codigo`: consignas de código dictadas por voz, que esperan
-- confirmación antes de largarse en la máquina de Lucas.
--
-- ⚠️ NO APLICADA. Correla vos (MCP de Supabase → `execute_sql`, o el SQL editor).
--    Es idempotente: se puede repetir sin romper nada.
--
-- Por qué una tabla y no la memoria del proceso, como `lib/agent/propuestas.ts`:
-- una propuesta de agenda vive 10 minutos y morir en un deploy es lo correcto.
-- Una tarea de código, no — el flujo de la Fase 6 es explícitamente diferido
-- ("dicto la consigna, queda en `lista`, y mañana digo 'mandá la que dejé'").
-- Si viviera en memoria, un deploy de Plata te borraría el laburo dictado.
-- ============================================================================

begin;

create table if not exists public.tareas_codigo (
  -- Id corto y fácil de decir en voz alta (alfabeto sin i, l, o, 0, 1), igual
  -- que los ids de `propuestas.ts`. Es un canal de voz: un uuid es indecible, y
  -- este id se dice en cada "mandá la tarea tal".
  id          text primary key,

  -- NOMBRE de la carpeta, nunca una ruta. El check es la misma gramática que
  -- valida el servidor: sin barras, sin `..`, sin letra de unidad. La ruta
  -- absoluta la resuelve el cliente local contra su propio mapa — es el único
  -- que sabe dónde están los repos, y el único que debe saberlo.
  repo        text not null check (repo ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),

  -- Rutas RELATIVAS al repo. Vacío es válido y frecuente.
  archivos    text[] not null default '{}',

  -- El prompt final que recibe Claude Code: contexto + consigna + reglas fijas.
  prompt      text not null check (length(prompt) between 1 and 8000),

  estado      text not null default 'borrador'
              check (estado in ('borrador', 'lista', 'ejecutando', 'hecha')),

  -- El `session_id` de Claude Code, para poder retomar con `claude --resume`.
  -- Lo llena el cliente local cuando la sesión arranca.
  session_id  text,

  creado_en   timestamptz not null default now(),

  user_id     uuid not null default auth.uid()
              references auth.users(id) on delete cascade
);

comment on table public.tareas_codigo is
  'Fase 6 — tareas de código dictadas por voz. `borrador` = dictada y sin confirmar; '
  '`lista` = confirmada y mandada al agente local; `ejecutando` = Claude Code corriendo; '
  '`hecha` = terminó. El servidor NUNCA arma un comando: manda datos y el cliente arma el argv.';

comment on column public.tareas_codigo.repo is
  'Nombre de la carpeta, no una ruta. El cliente local lo resuelve contra su propio mapa.';

comment on column public.tareas_codigo.archivos is
  'Rutas relativas al repo. Sin `..` ni absolutas: el servidor las rechaza y el cliente '
  'igual verifica que la ruta resuelta siga adentro de la carpeta.';

comment on column public.tareas_codigo.session_id is
  'session_id de Claude Code, para `claude --resume`. Lo escribe el cliente local.';

-- Lo que se consulta siempre: "qué me quedó pendiente", lo más nuevo primero.
create index if not exists idx_tareas_codigo_pendientes
  on public.tareas_codigo(user_id, creado_en desc)
  where estado <> 'hecha';

-- Misma política que el resto de las tablas de Plata.
alter table public.tareas_codigo enable row level security;

drop policy if exists owner_all on public.tareas_codigo;
create policy owner_all on public.tareas_codigo
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

commit;

-- ── Verificación ────────────────────────────────────────────────────────────
--   -- la tabla existe y está vacía:
--   select count(*) from public.tareas_codigo;
--
--   -- RLS prendida y con la política:
--   select relrowsecurity from pg_class where oid = 'public.tareas_codigo'::regclass;
--   select polname from pg_policy where polrelid = 'public.tareas_codigo'::regclass;
--
--   -- el check del repo rechaza una ruta (tiene que fallar):
--   insert into public.tareas_codigo(id, repo, prompt, user_id)
--   values ('test', '../../etc', 'x', (select user_id from public.transactions limit 1));

-- ── Vuelta atrás ────────────────────────────────────────────────────────────
--   drop table if exists public.tareas_codigo;
