# Centro de Control: sistema de vida para Cowork

El **Centro de Control** es la app de tareas y hábitos de Lucas (Supabase `cqnlceqghqqrlacbjhzj`, no es Plata). Desde el 14/11/2026 también es la **fuente única** de lo que Lucas le cuenta a Claude Cowork en los check-ins: diario y journal, comidas y macros, hábitos, Rocks, hitos, reuniones, mediciones de la nutricionista y sus turnos. Antes Cowork guardaba todo en un JSON dentro de un artifact (tablero "Sistema Lucas v1"), en paralelo a tablas del Centro que ya existían.

| Archivo | Qué es |
|---|---|
| `sistema_vida.sql` | Esquema, alimentos y platos genéricos, vistas y funciones `cdc.*`. Idempotente. Se corre por el MCP de Supabase en tres llamadas (PARTE 1, 2 y 3), porque cada llamada es una transacción. |
| `manual-cowork.md` | El bloque que va en el manual del Project de Cowork: cómo cargar, el check-in, el recordatorio de la nutricionista. |

Los datos que se migraron del tablero (3 días, 5 tareas, 3 hitos, 3 mediciones) se cargaron con estas mismas funciones y **no están en el repo** porque son personales.

## Cómo está armado

- **Usuario:** `cdc.usuario_actual()` = `auth.uid()` o, si se llama por SQL directo (conector de Supabase), Lucas. Las funciones no las puede ejecutar `anon`.
- **Diario** (`public.diario`, ya existía, una fila por fecha): el journal va en `cuerpo`. Columnas nuevas: `energia_n` (1–10; también completa `energia` alta/media/baja para la app), `sueno_h`, `bien`, `mejorar`, `aprendi`, `nota`, `etiquetas`, `prioridades_manana` (linkeadas a tareas), `estado_registro` y `origen`. Gym y lectura no son columnas: son `cumplimientos` de los hábitos.
- **Comidas:** `alimentos` (macros cada 100 g, más un `grupo` nuevo) × `comidas` (gramos, más `estimado` y `origen`), y `comidas_momentos` (qué contó, dónde comió, si la salteó). Las vistas `nutricion_comidas` y `nutricion_dias` calculan los macros y si la comida fue **completa** (proteína ≥ 20 g, hidratos ≥ 30 g, grasa saludable, y en almuerzo y cena ≥ 80 g de verdura). Ese criterio no lo decide el modelo. `registrar_comida` reemplaza solo las filas con `origen = 'cowork'`: lo que se cargó desde la app (código de barras) no se toca.
- **Alimentos genéricos:** 28 alimentos con valores aproximados (USDA / Argenfoods), marcados con `datos.fuente = 'generico'`. La carne y los fideos secos van en peso crudo. Si Lucas escanea el producto real, ese es el que vale.
- **Salud:** `turnos_salud` y `mediciones`. El recordatorio (`estudios_pendientes`) tiene dos disparadores: un turno ya pasado sin estudios, que sale de Calendar; o más de 35 días sin medición nueva, porque **el turno del 29/10 no estaba en Calendar** y las fechas de los eventos (21/07, 27/08) no coinciden con las de las mediciones (23/07, 03/09).
- **Rocks:** `rocks`, `hitos` y `reuniones`, más `tareas.rock_id`. `cdc.scorecard(lunes)` arma la semana.
- **Tareas:** se crean, cierran y mueven con `cdc.coucou_accion` (la misma semántica que la app; ver `../coucou/centro-de-control/`).

## Pendiente

- **Tareas viejas:** el Centro tiene 24 tareas abiertas importadas de Notion en septiembre, sin fecha, entre ellas cripto e inversiones, y Trading está congelado. Hay que repasarlas con Lucas.
- **Seguridad:** `cdc.prueba_en_curso` tiene RLS desactivado (aviso crítico de Supabase). Si no se usa, borrarla.
