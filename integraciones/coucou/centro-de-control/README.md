# Coucou + Centro de Control: `coucou-foco`

La isla de Coucou le pregunta al **Centro de Control** cómo viene el día: atrasadas, lo que vence hoy, lo que está en curso (y hace cuánto que está quieto), las próximas fechas, los hábitos, los proyectos en curso, los avisos que ya te llegaron hoy y lo que el evaluador de avisos tiene pendiente. Es lo que usan las skills del Centro en el lanzador (F8).

Vive en el proyecto Supabase del Centro (`cqnlceqghqqrlacbjhzj`), **no** en el de Plata. Es **solo lectura**: no escribe nada en ninguna tabla.

| Archivo | Qué es |
|---|---|
| `coucou_foco.sql` | `cdc.coucou_foco(usuario, ahora)` arma el JSON con las mismas reglas que la app (`cdc.estado_fecha`, `cdc.dia`, `cdc.pendientes`). `public.coucou_foco(secreto, usuario)` es la puerta para la Edge Function: compara el secreto contra Vault y, si no coincide, devuelve `null`. Las dos son `SECURITY DEFINER` y las ejecuta **solo `service_role`**. Crea el secreto de Vault `cdc_coucou_secret` si no existe |
| `index.ts` | Edge Function `coucou-foco`: `POST` con el header `x-coucou-secret`. Sin header o con uno distinto → **401**. Si coincide, devuelve el JSON |

URL: `https://cqnlceqghqqrlacbjhzj.supabase.co/functions/v1/coucou-foco`

## Deployar

Nada de esto se deploya solo ni con un repo. Con el MCP de Supabase, sobre el proyecto `cqnlceqghqqrlacbjhzj`:

1. **SQL:** `execute_sql` con el contenido entero de `coucou_foco.sql`. Correrlo de nuevo es seguro: reemplaza las funciones y **no pisa** el secreto si ya existe. ⚠️ El MCP corre todo en una sola transacción: si algo falla, no queda nada aplicado.
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

## Reglas que conviene no romper

- **Mismas reglas que la app.** Atrasadas = sin empezar y `estado_fecha = 'vencida'`. Para hoy = sin empezar y `'en_curso'` (vence hoy, o una ventana abierta que incluye hoy). Una madre con hijas abiertas es un contenedor y no se lista, salvo que tenga el cronómetro corriendo. Por eso `sin_fecha` puede dar menos que un `count(*)` crudo.
- **`quieta_dias`** es la cuenta de `cdc.pendientes`: días desde el último paso a en curso o, si después hubo sesiones, desde la última. Con el cronómetro corriendo es 0. Sin paso conocido es `null` (desconocido no es "quieta").
- **`avisos_hoy`** son solo los de `modo = 'real'` mandados hoy en hora de Buenos Aires. **`pendientes`** es `cdc.pendientes(usuario, now(), null, 'real')` tal cual.
- Si cambiás `cdc.pendientes`, `cdc.estado_fecha` o las columnas de `tareas`/`avisos`, volvé a correr una vez `select cdc.coucou_foco('<id de Lucas>')` para ver que siga armando bien.
