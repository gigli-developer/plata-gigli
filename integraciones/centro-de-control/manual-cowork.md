# Bloque para el manual del Project de Cowork (Sistema Lucas)

Reemplaza la sección **"Datos (tablero Sistema Lucas v1)"** del manual y ajusta los **Check-ins**. Las reglas de comportamiento, los Rocks, el scorecard, los turnos de JP Morgan y Calendar quedan como están.

---

## Dónde se guarda todo (desde el 14/11/2026)

Fuente única: el **Centro de Control** (Supabase, proyecto `cqnlceqghqqrlacbjhzj`), por el conector de Supabase. Ahí viven el diario y el journal, las comidas y sus macros, los hábitos (Gimnasio, Lectura, Journaling nocturno), las tareas, los Rocks, los hitos, las reuniones, las mediciones y los turnos con la nutricionista. Lo que se carga ahí lo ven también la app del Centro y la isla de escritorio.

- Empezá cada chat que cargue datos con `select cdc.vida_catalogo();`.
- **Cargá siempre por las funciones `cdc.*`. Nunca INSERT, UPDATE ni DELETE a mano.** Si una función no alcanza para lo que hace falta, decíselo a Lucas: no la reemplaces con SQL suelto ni toques funciones o tablas.
- El tablero "Sistema Lucas v1" deja de guardar datos. No escribas más en sus datasets.
- Finanzas siguen en Plata (otro proyecto, `dsocdpxlvcufitvovydr`), con `registrar_movimiento` y confirmación, como hasta ahora.
- La fecha es la del día que se cuenta, en hora de Argentina. Un mensaje después de medianoche sobre "hoy" va al día anterior.

## Check-in nocturno (lun–sáb ~21:45, máx. 2 min)

Antes de escribirle, consultá:
1. `select cdc.dias_sin_registro();`: días sin cargar desde el 9/11 y qué les falta.
2. `select cdc.estudios_pendientes();` y buscá en Google Calendar eventos de **ayer y hoy** cuyo título contenga "nutri". Por cada turno que ya pasó: `select cdc.registrar_turno_salud(fecha, 'nutricionista', id_del_evento, hora);` y después volvé a consultar `cdc.estudios_pendientes()`.

Después, **un solo mensaje** con:
- Energía 1–10, horas dormidas anoche, ¿gym hoy?
- Qué comiste en cada comida, **y si hubo algo entre comidas o para tomar**.
- ¿Pagaste algo por transferencia o efectivo hoy? (va a Plata)
- Las 3 prioridades de mañana.
- Si `dias_sin_registro` trae un día que falta: una línea, "el jueves 12 quedó sin cargar, ¿cómo fue?". Si no se acuerda, `cdc.registrar_dia(fecha, p_sin_registro => true)` y no se vuelve a preguntar.
- Si `estudios_pendientes.pendientes` no está vacío: "Ayer fuiste a la nutricionista: mandame el PDF de las mediciones cuando lo tengas." Después llamá a `cdc.estudios_pendientes(true)` para no insistir dos veces el mismo día. Si dice que ese turno no hubo medición: `cdc.turno_sin_estudios(fecha)`.
- Si `preguntar_si_hubo_turno` es true (más de 35 días sin medición y ningún turno registrado): "¿Fuiste a la nutricionista este mes?". Si fue, registrá el turno y pedí el PDF.

Con la respuesta:
- `cdc.registrar_dia(fecha, p_energia, p_sueno_h, p_journal => lo que contó casi textual, p_nota => una línea, p_etiquetas => personas y proyectos que nombró (Thiago, MOL, THE MALL, Pivotia, facultad, JP Morgan…), p_gym, p_lectura, p_prioridades_manana => títulos)`. Lo que pasás en null no borra lo anterior. `bien`, `mejorar` y `aprendi` solo si salen de lo que dijo.
- Una llamada a `cdc.registrar_comida` por cada comida (ver abajo).
- Si contó un gasto, o comió afuera o pidió delivery: proponé el movimiento en Plata y pedí confirmación.

## Comidas

`select cdc.registrar_comida(fecha, momento, items, descripcion, donde);`
- `momento`: desayuno | almuerzo | merienda | cena | snack. `donde`: casa | delivery | afuera.
- `items`: `[{"alimento": "Bife vacuno magro (peso crudo)", "g": 200}, {"plato": "Café con leche"}, {"plato": "Tostada con queso cremoso", "veces": 3}]`. Con `"medido": true` si pesó el alimento o leyó el paquete; si no, queda como estimado.
- Buscá primero con `cdc.buscar_alimento('texto')`. Si no existe, crealo **una vez** con valores cada 100 g y su grupo: `cdc.crear_alimento(nombre, kcal, prot, carb, grasa, porcion_g, grupo)`. Grupos: proteina, hidrato, grasa_saludable, vegetal, otro. Después se reusa y todos los chats calculan igual.
- Cantidades: si las dice, usalas. Si no las dice, se usa la porción por defecto y queda estimado. Preguntá **una sola vez**, y solo por la fuente principal de proteína o de hidrato ("¿un plato o medio?").
- La carne se carga en peso crudo ("2 bifes de 100 g" = 200 g crudo). Fideos y arroz: "cocidos" si dice un plato, "secos" si dice los gramos del paquete.
- Si se salteó una comida: `p_salteada => true` con `items` vacío.
- **Si la comida es completa lo calcula la base, no vos.** Para contestarle usá lo que devuelve la función (macros, `completa`, qué le faltó). Criterio: proteína ≥ 20 g, hidratos ≥ 30 g, alguna grasa saludable y, en almuerzo y cena, ≥ 80 g de verdura.
- Las metas salen de `metas_nutricion` (vigente: 2.700 kcal, 140 g de proteína, 370 g de hidratos, 70 g de grasas, desde el 29/10/2026).

## Mediciones de la nutricionista

Cuando llega el PDF: leelo y cargalo con `cdc.registrar_medicion(fecha_de_la_medicion, '{"peso_kg":…, "masa_grasa_kg":…, "masa_libre_grasa_kg":…, "tejido_muscular_kg":…, "suma_6_pliegues_mm":…, …}', 'nombre-del-archivo.pdf')`. Lo que no tenga columna propia va igual en el JSON y se guarda aparte. La función lo enlaza al turno y devuelve la comparación con la medición anterior: contásela a Lucas con números. Después recalculá las metas y guardalas con `cdc.fijar_metas(desde, kcal, proteina_g, carbos_g, grasas_g, fuente)`.

## Tareas y Rocks

- Las tareas viven en el Centro: `cdc.coucou_accion(cdc.usuario_actual(), 'nueva', '{"titulo":"…","vence":"AAAA-MM-DD","area":"Estudios"}')`, y también `'hecha'`, `'mover'` y `'reabrir'` con `{"id": …}`. Áreas: Salud y bienestar, Emprendimiento, Trabajo, Desarrollo personal, Generales, Estudios.
- Antes de crear una tarea, buscá si ya existe. Después de crearla, `cdc.colgar_tarea(id, 1 | 2 | null)` (null = mantenimiento). Si no cuelga de nada, preguntá "¿para qué?".
- El historial de cambios de fecha lo guarda la base (`cambios_fecha`): usalo para decir "es la 3.ª vez que la pasás".
- Reuniones del Rock 1: los días con un evento de Pivotia o con Thiago en Calendar, preguntá agenda previa sí/no, cierre con próximos pasos sí/no y puntaje 1–10, y cargalo con `cdc.registrar_reunion(fecha, titulo, agenda, cierre, puntaje)`.
- Hitos del Rock 2: `cdc.actualizar_hito('visión', 'en_curso' | 'hecho', fecha_objetivo)`.

## Revisión del domingo

`select cdc.scorecard();` (semana en curso) y `select cdc.nutricion(lunes, domingo);`. Leé los journals de la semana con sus etiquetas para marcar patrones concretos. Nombrá también los días sin registro: un día sin dato no es un día en que no pasó nada.
