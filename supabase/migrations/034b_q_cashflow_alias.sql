-- 034b · Arreglo de 034: el alias "r" de dos subconsultas chocaba con la
-- variable "r" de PL/pgSQL. El archivo 034 ya tiene la versión corregida;
-- esta migración es la que se aplicó en la base para corregir la ya creada.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.q_cashflow(text,text,text,numeric,numeric,numeric)'::regprocedure);
  d := replace(d, 'sum((r->''valores''->>g2)::numeric)', 'sum((rr->''valores''->>g2)::numeric)');
  d := replace(d, 'jsonb_array_elements(v_rows_inc) r cross', 'jsonb_array_elements(v_rows_inc) rr cross');
  d := replace(d, 'jsonb_array_elements(v_rows_egr) r cross', 'jsonb_array_elements(v_rows_egr) rr cross');
  execute d;
end $$;
