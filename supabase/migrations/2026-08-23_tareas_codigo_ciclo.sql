-- ============================================================================
-- MIGRACIÓN · 2026-08-23 · Fase 6, segunda mitad — el ciclo de estados se cierra
--
-- Hasta hoy una tarea dictada moría en `lista`: el agente local corría Claude
-- Code pero nadie volvía a escribir la fila, así que «qué tareas dejé» listaba
-- como pendiente trabajo que terminó hace días. Esta migración agrega lo que la
-- PC necesita para contar la verdad:
--
--   · `ultimo_latido` — la PC late cada ~2 minutos mientras ejecuta. Si la fila
--     dice `ejecutando` y el latido tiene más de 10 minutos, la tarea es un
--     zombi (la PC se apagó a mitad de camino) y se puede relanzar.
--   · `exito` / `resumen` / `costo_usd` — cómo terminó, para poder contestar
--     «¿cómo salió la tarea?» por voz sin inventar.
--
-- El reclamo es atómico y NO vive acá: es un UPDATE condicionado por estado
-- (`where estado = 'lista'`) que hace `/api/codigo`. La tabla solo aporta las
-- columnas.
--
-- ⚠️ Correr ANTES de deployar el server (el código nuevo selecciona estas
--    columnas). Idempotente: se puede repetir sin romper nada.
-- ============================================================================

begin;

alter table public.tareas_codigo
  add column if not exists ultimo_latido timestamptz,
  add column if not exists exito         boolean,
  add column if not exists resumen       text check (resumen is null or length(resumen) <= 2000),
  add column if not exists costo_usd     numeric check (costo_usd is null or costo_usd >= 0);

comment on column public.tareas_codigo.ultimo_latido is
  'La PC lo refresca cada ~2 min mientras la tarea está `ejecutando`. Un `ejecutando` '
  'con latido de más de 10 min es un zombi: la PC murió a mitad de la tarea y se '
  'permite relanzar. Lo setea el reclamo y lo refresca /api/codigo.';

comment on column public.tareas_codigo.exito is
  'Cómo terminó: true = Claude Code cerró bien, false = falló, se canceló o Jarvis '
  'se reinició en el medio. NULL mientras no terminó. El estado queda `hecha` en '
  'todos los casos; este campo es el matiz.';

comment on column public.tareas_codigo.resumen is
  'Las últimas frases de la sesión de Claude Code (o el motivo del fallo), '
  'recortadas. Para contestar «¿cómo salió?» por voz.';

comment on table public.tareas_codigo is
  'Fase 6 — tareas de código dictadas por voz. `borrador` = dictada y sin confirmar; '
  '`lista` = confirmada y mandada al agente local; `ejecutando` = la PC la reclamó '
  '(UPDATE atómico vía /api/codigo) y Claude Code corre; `hecha` = terminó (ver '
  '`exito`). El servidor NUNCA arma un comando: manda datos y el cliente arma el argv.';

commit;

-- ── Verificación ────────────────────────────────────────────────────────────
--   -- las cuatro columnas existen:
--   select column_name from information_schema.columns
--   where table_name = 'tareas_codigo'
--     and column_name in ('ultimo_latido', 'exito', 'resumen', 'costo_usd');
--
--   -- el check del resumen rechaza un texto de 3000 caracteres (tiene que fallar):
--   update public.tareas_codigo set resumen = repeat('x', 3000) where false;

-- ── Vuelta atrás ────────────────────────────────────────────────────────────
--   alter table public.tareas_codigo
--     drop column if exists ultimo_latido,
--     drop column if exists exito,
--     drop column if exists resumen,
--     drop column if exists costo_usd;
