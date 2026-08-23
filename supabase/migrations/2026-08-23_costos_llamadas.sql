-- El costo de cada sub-llamada a la API, fila por fila (plan 23/08).
--
-- `pensar` ya acumula el costo de su conversación en `pensar_sesiones`, pero los
-- de `interpretar` y `web` morían en el console.log de Railway: para contestar
-- «¿cuánto gasté en consultas?» por voz, los números tienen que estar en una
-- tabla, no en un log que rota. Cada llamada deja su fila acá vía
-- `registrarCosto` (web.ts) —fuego y olvido: registrar JAMÁS voltea la consulta
-- que lo generó— y `costos_ver` (costos.ts) las agrupa por herramienta y período.
--
-- ⚠️ El motor de voz de Gemini NO está acá: se factura aparte y no está medido.

create table if not exists costos_llamadas (
  id bigint generated always as identity primary key,
  herramienta text not null,        -- 'pensar' | 'interpretar' | 'web'
  modelo text,
  usd numeric not null default 0,
  tokens_entrada int not null default 0,
  tokens_salida int not null default 0,
  creada timestamptz not null default now()
);
-- RLS prendida sin policies = anon/authenticated no ven nada; solo el service
-- role del servidor escribe y lee. Mismo esquema que `pensar_sesiones`.
alter table costos_llamadas enable row level security;
