# Coucou + Centro de Control: `coucou-foco`

La isla de Coucou le pregunta al **Centro de Control** cómo viene el día: atrasadas, lo que vence hoy, lo que está en curso (y hace cuánto que está quieto), las próximas fechas, los hábitos, los proyectos en curso, los avisos que ya te llegaron hoy y lo que el evaluador de avisos tiene pendiente. Es lo que usan las skills del Centro en el lanzador (F8). Desde la entrega 2, la misma función también **escribe**: las acciones de las tarjetas (tildar, cronómetro, mover de día, hábitos, "hoy no trabajo", tarea nueva).

Vive en el proyecto Supabase del Centro (`cqnlceqghqqrlacbjhzj`), **no** en el de Plata. Con el body vacío es **solo lectura**; con `{"accion", "args"}` escribe, siempre sobre las tareas de Lucas.

| Archivo | Qué es |
|---|---|
| `coucou_foco.sql` | `cdc.coucou_foco(usuario, ahora)` arma el JSON con las mismas reglas que la app (`cdc.estado_fecha`, `cdc.dia`, `cdc.pendientes`). `public.coucou_foco(secreto, usuario)` es la puerta para la Edge Function: compara el secreto contra Vault y, si no coincide, devuelve `null`. Las dos son `SECURITY DEFINER` y las ejecuta **solo `service_role`**. Crea el secreto de Vault `cdc_coucou_secret` si no existe |
| `coucou_accion.sql` | `cdc.coucou_accion(usuario, accion, args)`: las escrituras, con la misma semántica que la app (`Main.dc.html`). `public.coucou_accion(secreto, usuario, accion, args)` es la puerta, con el mismo control de secreto. Solo `service_role` |
| `index.ts` | Edge Function `coucou-foco`: `POST` con el header `x-coucou-secret`. Sin header o con uno distinto → **401**. Body vacío → el día. `{"accion": "...", "args": {...}}` → la acción; devuelve `{ok: true, ...}` o `{ok: false, error}` con un texto para mostrar |

URL: `https://cqnlceqghqqrlacbjhzj.supabase.co/functions/v1/coucou-foco`

## Deployar

Nada de esto se deploya solo ni con un repo. Con el MCP de Supabase, sobre el proyecto `cqnlceqghqqrlacbjhzj`:

1. **SQL:** `execute_sql` con el contenido entero de `coucou_foco.sql` y después el de `coucou_accion.sql`. Correrlo de nuevo es seguro: reemplaza las funciones y **no pisa** el secreto si ya existe. ⚠️ El MCP corre todo en una sola transacción: si algo falla, no queda nada aplicado.
2. **Función:** `deploy_edge_function` con `name: "coucou-foco"`, `verify_jwt: false` y `index.ts` como único archivo.
3. Probar: `curl -X POST <URL>` sin header tiene que dar 401.

## El secreto

Para copiarlo y pegarlo en Coucou (Ajustes → Centro de Control), en el **SQL Editor** del proyecto del Centro:

```sql
select decrypted_secret from vault.decrypted_secrets where name = 'cdc_coucou_secret';
```

Para cambiarlo (por ejemplo, si se filtró), generá uno nuevo y volvé a pegarlo en Coucou:

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'cdc_coucou_secret'),
  encode(extensions.gen_random_bytes(24), 'hex'));
```

## Las acciones

| `accion` | `args` | Qué hace | Para deshacer |
|---|---|---|---|
| `hecha` | `id` | Estado `done`, `cerrada_el` = hoy, cierra la sesión abierta de esa tarea | `reabrir` con `estado` = lo que devolvió en `antes` |
| `reabrir` | `id`, `estado`? | Vuelve a `not_started` (o `in_progress`) | |
| `empezar` | `id` | Cierra lo que corra, abre una sesión en `tiempos`, pasa a `in_progress` | `pausar` |
| `pausar` | — | Cierra la sesión abierta (si hay) | |
| `por_hacer` | `id` | Suelta una en curso: `not_started` y cierra su sesión | |
| `mover` | `id`, `vence` (o null) | Cambia la fecha y borra `vence_fin` (como `guardarTarea`). Acepta fechas pasadas | `mover` a lo que devolvió en `antes` |
| `nueva` | `titulo`, `vence`?, `area`?, `notas`? | Crea una tarea `not_started`, `origen = 'manual'` | `borrar_nueva` |
| `borrar_nueva` | `id` | Borra una tarea manual creada hace menos de 15 min | |
| `habito` | `id`, `hecho` | Marca o desmarca el hábito HOY (`cumplimientos`) | el mismo con `hecho` al revés |
| `no_trabajo` | `motivo`?, `nota`? | Anota hoy en `dias_sin_trabajo` (dos veces = una) | — (desde la app) |

Una `id` que no es de Lucas devuelve "No encontré esa tarea." y no toca nada.

**Cómo probar sin ensuciar:** un bloque `do $ ... raise exception 'RESULTADO %', r; end $;` sobre el usuario de prueba (`cdc-prueba-back@example.com`): la excepción revierte todo. ⚠️ Pero va en la misma transacción que lo que mandes antes: **no lo pongas en la misma llamada que el `create or replace`**, o se revierte también la función.

## Reglas que conviene no romper

- **Mismas reglas que la app.** Atrasadas = sin empezar y `estado_fecha = 'vencida'`. Para hoy = sin empezar y `'en_curso'` (vence hoy, o una ventana abierta que incluye hoy). Una madre con hijas abiertas es un contenedor y no se lista, salvo que tenga el cronómetro corriendo. Por eso `sin_fecha` puede dar menos que un `count(*)` crudo.
- **`quieta_dias`** es la cuenta de `cdc.pendientes`: días desde el último paso a en curso o, si después hubo sesiones, desde la última. Con el cronómetro corriendo es 0. Sin paso conocido es `null` (desconocido no es "quieta").
- **`avisos_hoy`** son solo los de `modo = 'real'` mandados hoy en hora de Buenos Aires. **`pendientes`** es `cdc.pendientes(usuario, now(), null, 'real')` tal cual.
- Si cambiás `cdc.pendientes`, `cdc.estado_fecha` o las columnas de `tareas`/`avisos`, volvé a correr una vez `select cdc.coucou_foco('<id de Lucas>')` para ver que siga armando bien.
