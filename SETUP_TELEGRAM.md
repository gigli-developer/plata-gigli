# Asistente por Telegram

Le hablás al bot (texto o audio) y te contesta consultando Plata. Corre en Railway,
dentro de la misma app Next, y reusa la lógica de `lib/db.ts`.

```
Telegram → app/api/telegram/route.ts → lib/agent/run.ts → API de Claude
                                              ↓
                                       lib/agent/tools.ts → Supabase
```

## Archivos

| Archivo | Qué hace |
|---|---|
| `lib/agent/tools.ts` | Las 5 herramientas de lectura. Devuelven totales, nunca filas crudas. |
| `lib/agent/run.ts` | Loop con Claude: pide herramientas, las resuelve, redacta. Calcula el costo. |
| `lib/supabase/service.ts` | Cliente service-role + lectura de `app_secrets`. |
| `app/api/telegram/route.ts` | Webhook: valida, transcribe audios, responde. |

## Puesta en marcha

### 1. Crear el bot

En Telegram, hablarle a **@BotFather** → `/newbot` → nombre y usuario. Devuelve el
**token** (`123456:ABC-DEF...`).

### 2. API key de Groq (para los audios)

En <https://console.groq.com> → API Keys. El free tier alcanza de sobra: transcribir
un audio de 15 segundos son fracciones de centavo, y Whisper turbo tarda ~1 segundo.

Si solo vas a escribir, salteá esto: el bot avisa y sigue andando con texto.

### 3. Averiguar tu chat_id

Mandale cualquier mensaje al bot y después abrí en el navegador:

```
https://api.telegram.org/bot<TU_TOKEN>/getUpdates
```

Buscá `"chat":{"id":123456789`. Ese número es tu `TELEGRAM_CHAT_ID`.

### 4. Inventar el secreto del webhook

Cualquier string largo al azar, por ejemplo:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. Guardar los secrets

En el SQL editor de Supabase (proyecto `dsocdpxlvcufitvovydr`):

```sql
insert into app_secrets (key, value) values
  ('TELEGRAM_BOT_TOKEN',      'el token de BotFather'),
  ('TELEGRAM_CHAT_ID',        'tu chat id'),
  ('TELEGRAM_WEBHOOK_SECRET', 'el string random del paso 4'),
  ('GROQ_API_KEY',            'la key de Groq')
on conflict (key) do update set value = excluded.value;
```

`ANTHROPIC_API_KEY` ya está ahí desde el asistente de la web: se reusa.

### 6. Variable de entorno en Railway

La única que hace falta, porque es la que abre la puerta a `app_secrets`:

```
SUPABASE_SERVICE_ROLE_KEY = <service_role key de Supabase → Settings → API>
```

⚠️ Es la key que saltea RLS. Va **solo** en Railway, nunca en `.env.local` que se
commitea ni en nada con prefijo `NEXT_PUBLIC_`.

### 7. Deploy

```bash
railway up --service plata --ci
```

### 8. Registrar el webhook

Una sola vez, reemplazando los dos valores:

```bash
curl -X POST "https://api.telegram.org/bot<TU_TOKEN>/setWebhook" -H "Content-Type: application/json" -d "{\"url\":\"https://plata-production.up.railway.app/api/telegram\",\"secret_token\":\"<EL_SECRETO_DEL_PASO_4>\",\"allowed_updates\":[\"message\"]}"
```

Verificar que quedó bien:

```bash
curl "https://api.telegram.org/bot<TU_TOKEN>/getWebhookInfo"
```

`pending_update_count: 0` y `last_error_message` ausente = anda.

### 9. Probar

Mandale `/start` al bot. Después:

- *cómo estoy de plata*
- *qué pagos tengo los próximos 3 meses*
- *llego a fin de mes*
- *en qué gasté más este mes*
- *quién me debe plata*

Cada respuesta trae abajo el costo real en USD.

## Seguridad

Esta ruta es pública y tiene el service role adentro, así que hay dos cerrojos:

1. **Header `X-Telegram-Bot-Api-Secret-Token`** — sin el secreto del paso 4, devuelve 401.
2. **`chat_id` contra el tuyo** — a cualquier otro chat no se le contesta nada.

Los dos tienen que pasar. Si alguna vez filtrás el token del bot, revocalo en BotFather
y volvé a correr `setWebhook` con un secreto nuevo.

## Costos

Con Sonnet, una consulta con herramientas cuesta **~US$ 0,01**. Diez consultas por día
son unos **US$ 3 al mes**. La transcripción de audios es despreciable.

Lo que dispara la factura es devolverle filas crudas al modelo. Por eso las herramientas
devuelven totales ya calculados: mismo resultado, 60 veces más barato. Si agregás
herramientas, respetá esa regla.

Para bajarlo más, el cuarto parámetro de `correrAgente` es un objeto de opciones:
`correrAgente(sb, apiKey, turnos, { modelo: "claude-haiku-4-5-20251001" })` — ya está en la
tabla de precios. Por defecto sale de la variable de entorno `AGENT_MODEL`.

⚠️ **Requisito para que el webhook funcione:** `api/` tiene que estar excluido del matcher de
`proxy.ts`. Si no, el proxy redirige el POST de Telegram a `/login` y devuelve HTML con un 200
— no falla, simplemente no pasa nada. Quedó arreglado el 11/08/2026.

## Límites conocidos

- **El historial vive en memoria del proceso**: se borra en cada deploy y a los 30
  minutos de inactividad. Para consultas sueltas alcanza. Si querés que recuerde entre
  deploys, hay que persistirlo en `chat_messages`.
- **Solo lee, no escribe.** Cargar gastos por Telegram es el próximo paso: la
  herramienta `registrar_movimientos` ya existe en la Edge Function `assistant`.
- **Momentum todavía no está conectado.** Cuando el esquema esté firme, se agregan
  herramientas nuevas a `lib/agent/tools.ts` — el resto no se toca.
