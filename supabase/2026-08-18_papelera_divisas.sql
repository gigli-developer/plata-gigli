-- Extensión de la papelera: currency_exchanges también deja copia al borrarse.
--
-- El barrido del 18/08 encontró el hueco: borrar un cambio de divisas dejaba en
-- la papelera sus DOS transacciones (por el trigger de transactions) pero perdía
-- la fila del cambio en sí — la restauración quedaba a medias. Con esto, las
-- tres piezas de un cambio borrado quedan recuperables.
--
-- Requiere que 2026-08-18_papelera.sql ya esté corrido (usa a_la_papelera()).

drop trigger if exists trg_papelera_currency_exchanges on public.currency_exchanges;
create trigger trg_papelera_currency_exchanges
  after delete on public.currency_exchanges
  for each row execute function public.a_la_papelera();
