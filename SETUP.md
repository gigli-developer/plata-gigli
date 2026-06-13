# Plata — Guía para armar tu propio setup (con Claude)

Esta guía explica **cómo está hecha la app** y, sobre todo, **cómo usar Claude (Claude Code) para clonar este proyecto y dejarlo corriendo con tu propia infraestructura**: tu Supabase, tu Railway, tus tokens.

La idea es que NO tengas que escribir código: le vas dando instrucciones a Claude paso a paso y él ejecuta. Cada paso de abajo incluye **qué hacés vos a mano** (crear cuentas, copiar claves) y **qué le pedís a Claude**.

---

## Parte 1 — Cómo está hecha la app (mapa mental)

### Las pestañas
| Pestaña | Qué hace |
|---|---|
| **Resumen** (home) | Saldos en tiempo real (ARS/USD/USDT) + patrimonio neto, últimos movimientos, accesos rápidos. El asistente IA vive dentro de la barra de búsqueda. |
| **Transacciones** | Lista de ingresos/egresos con filtros (texto, tipo, categoría, método) + formulario de carga manual. |
| **Métricas** | KPIs, patrimonio, gráficos por categoría / método de pago, ingresos vs egresos, y tabla de variación mes a mes. |
| **Cash Flow** | Proyección a 6 meses (con inflación oficial argentina solo sobre el sueldo) + modo Histórico para ver meses pasados. |
| **Tarjetas** | Tarjetas de crédito, resúmenes (statements), cuotas y consumos. |
| **Deudas** | Quién te debe / a quién le debés, por persona, con pagos parciales e historial. |
| **Divisas / Recurrentes / Reglas** | Cambios de moneda, plantillas recurrentes y reglas de auto-categorización. |

### Las 3 piezas de infraestructura
1. **El frontend (este repo)** — Next.js 16, corre en **Railway**. Es lo que ves en el navegador.
2. **Supabase** — la base de datos (Postgres), el login (Auth), y los "robots de fondo" (Edge Functions + cron):
   - **Base de datos**: todas tus transacciones, tarjetas, deudas, etc. Cada tabla tiene RLS (`user_id = auth.uid()`) → solo vos ves tus datos.
   - **`get_metrics()`**: una función SQL que calcula los saldos y KPIs de un saque.
   - **Edge Functions** (mini-servidores):
     - `assistant` → el asistente IA (usa la API de Claude).
     - `email-poller` → lee tus mails de alertas de tarjeta y carga los consumos solos.
     - `inflation-sync` → baja la inflación oficial argentina.
   - **Crons**: el poller corre cada 15 min, la inflación una vez por día.
3. **Tokens / secrets** — claves que conectan todo. Las "públicas" van en `.env.local`; las **sensibles** (API key de Claude, token de Gmail) viven en una tabla `app_secrets` que **solo leen las Edge Functions**, nunca el navegador.

### Devengado vs caja (la decisión conceptual clave)
- **Gastos por categoría** = devengado (cuenta cuando consumís o cae la cuota).
- **Saldo líquido** = caja (la plata que tenés). Un consumo con crédito **no** te baja el saldo hasta que pagás el resumen.

---

## Parte 2 — Lo que tenés que crear a mano (cuentas)

Antes de pedirle nada a Claude, abrí estas cuentas (todas tienen plan gratis para empezar):

1. **Supabase** → https://supabase.com → creá un proyecto nuevo. Anotá:
   - El **Project URL** (`https://XXXX.supabase.co`)
   - La **anon/public key** (Settings → API)
   - El **project ref** (el `XXXX` de la URL)
   - El **service_role key** (para que Claude pueda crear tablas vía MCP) o, mejor, conectá el **MCP de Supabase** (ver Parte 3).
2. **Railway** → https://railway.app → creá un proyecto. En Account → Tokens generá un **API token**.
3. **Anthropic** → https://console.anthropic.com → sacá una **API key** (`sk-ant-...`) para el asistente IA. Cargá unos dólares de crédito.
4. **Google Cloud** (opcional, solo si querés el importador de mails) → creá un proyecto, activá la **Gmail API**, generá credenciales **OAuth** (Client ID + Client Secret).

> 💡 Guardá todo esto en un bloc de notas temporal. Se lo vas a ir pasando a Claude.

---

## Parte 3 — Conectar Claude a tus servicios (MCP)

Para que Claude pueda **crear tablas, deployar funciones y hacer el deploy** por vos, conviene darle acceso vía **MCP** (Model Context Protocol):

- **MCP de Supabase**: le permite a Claude correr SQL, crear tablas, deployar Edge Functions y ver logs. Configuralo con tu project ref y un token de Supabase. (Pedile a Claude: *"ayudame a conectar el MCP de Supabase a mi proyecto, mi project ref es XXXX"*.)
- **Railway**: no necesita MCP; Claude usa el CLI `railway` con tu token en una variable de entorno.

Si no querés configurar MCP, Claude igual puede generarte **todos los scripts SQL** y vos los pegás en el editor SQL de Supabase a mano. Es más lento pero funciona.

---

## Parte 4 — El paso a paso con Claude

A partir de acá, todo se lo pedís a Claude. Te dejo el orden y el "prompt" sugerido para cada paso.

### Paso 0 — Clonar y arrancar local
> **Vos:** copiás esta carpeta `finanzas-app` a tu compu.
>
> **A Claude:** *"Instalá las dependencias de finanzas-app y arrancá el server de desarrollo. Si falta algo, decime."*

Claude corre `npm install` y `npm run dev`. Todavía no va a andar del todo porque faltan las claves (siguiente paso).

### Paso 1 — Variables de entorno
> **Vos:** tenés a mano el Project URL y la anon key de Supabase.
>
> **A Claude:** *"Creá el archivo `.env.local` con mis claves de Supabase. URL: `https://XXXX.supabase.co`, anon key: `eyJ...`."*

Esto crea:
```
NEXT_PUBLIC_SUPABASE_URL=https://XXXX.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```
(Si vas a usar el importador de mails, también `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — ver Paso 6.)

### Paso 2 — Crear la base de datos
> **A Claude:** *"Creá todo el schema de la base en mi Supabase: las tablas (`transactions`, `categories`, `payment_methods`, `cards`, `card_statements`, `installment_plans`, `debts`, `debt_payments`, `persons`, `currency_exchanges`, `recurring_templates`, `cashflow_budgets`, `cashflow_config`, `inflation_monthly`, `rules`, `app_secrets`, `profiles`), con RLS `owner_all` (`user_id = auth.uid()`) en cada una. Después creá la función `get_metrics()`. Usá el MCP de Supabase."*

Claude crea las tablas y la función. **Importante:** revisá que cada tabla tenga RLS activado — es lo que hace que tus datos sean privados.

### Paso 3 — Crear tu usuario
> **Vos:** en Supabase → Authentication → Users → **Add user**, creá tu usuario con tu email y contraseña. (Anthropic/Claude **no** crea cuentas por vos por seguridad — esto lo hacés a mano.)
>
> Esta app es **mono-usuario**: pensada para una sola persona. Tu `user_id` es el dueño de todos los registros.

### Paso 4 — Datos iniciales (semilla)
> **A Claude:** *"Cargá las categorías base (Comida, Transporte, Sueldo, etc.), mis métodos de pago y mis tarjetas. Mi tarjeta es Visa Galicia, cierra el 25 y vence el 6."*

Claude inserta las filas iniciales. También podés pedirle que importe un Excel/CSV de tu banco si lo tenés.

### Paso 5 — El asistente IA
> **Vos:** tenés tu API key de Anthropic (`sk-ant-...`).
>
> **A Claude:** *"Deployá la Edge Function `assistant` y guardá mi `ANTHROPIC_API_KEY` en la tabla `app_secrets`. La key es `sk-ant-...`."*

Claude deploya la función (vía MCP) y guarda la key en `app_secrets` (no en el navegador, por seguridad). El asistente usa **tool use**: interpreta tu mensaje, **propone** los movimientos, y vos **confirmás** antes de que se escriban.

### Paso 6 — Importador de mails (opcional)
> **Vos:** tenés Client ID + Secret de Google Cloud y activaste la Gmail API.
>
> **A Claude:** *"Configurá el importador de mails: corré el script de OAuth de Gmail, guardá el refresh token y las credenciales en `app_secrets`, deployá la Edge Function `email-poller` y programá el cron cada 15 minutos."*

Claude corre `node scripts/gmail-auth.mjs` (vos autorizás en el navegador), guarda el `GOOGLE_REFRESH_TOKEN`, deploya la función y crea el cron con pg_cron.

> ⚠️ **Gotcha del token de Gmail:** mientras tu app de Google esté en modo **"Testing"**, el refresh token **caduca cada 7 días**. Para que deje de caducar: Google Cloud → OAuth consent screen → **Publicar app** (pasar a Producción). Si se rompe, le decís a Claude *"el importador de mails dejó de andar"* y él revisa los logs (`invalid_grant`) y te guía para re-autorizar.

### Paso 7 — Inflación (opcional, para el Cash Flow)
> **A Claude:** *"Deployá la función `inflation-sync` que baja la inflación oficial de argentinadatos a la tabla `inflation_monthly`, corréla una vez y programá el cron diario."*

### Paso 8 — Deploy a producción (Railway)
> **Vos:** tenés tu Railway API token.
>
> **A Claude:** *"Deployá la app a Railway. Acá está mi token: `XXXX`. Configurá las variables de entorno (`NEXT_PUBLIC_SUPABASE_*`) en el servicio y hacé el deploy."*

Claude setea `$env:RAILWAY_API_TOKEN`, configura las env vars en Railway y corre:
```powershell
railway up --service plata --ci
```
Cuando termina, te da la URL pública (algo como `https://tuapp.up.railway.app`).

### Paso 9 — Probar
Abrís la URL, te logueás con el usuario del Paso 3, y deberías ver tu Resumen. Cargás un gasto de prueba con el asistente: *"gasté 5000 en el super"* → confirmás → aparece en Transacciones.

---

## Parte 5 — Mantenimiento (cosas que le vas a pedir a Claude seguido)

- *"Agregá una transacción / corregí esta categoría / borrá este duplicado."* — Claude edita la base directo.
- *"El importador de mails dejó de andar."* — re-autorización de Gmail (token caducado).
- *"Cuadrá el resumen de la tarjeta con este PDF del banco."* — reconciliación.
- *"Hacé un cambio en tal pantalla y deployalo."* — edita el código, `npm run build`, `railway up`.
- *"¿Cuánto gasté este mes en comida?"* — consultas sobre tus datos.

---

## Resumen de claves y dónde va cada una

| Clave | Dónde vive | Quién la usa |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` | `.env.local` + Railway env | El navegador (público, es seguro) |
| `ANTHROPIC_API_KEY` | tabla `app_secrets` | Edge Function `assistant` |
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | tabla `app_secrets` | Edge Function `email-poller` |
| `RAILWAY_API_TOKEN` | variable de entorno local (no se commitea) | El deploy |
| Supabase `service_role` | MCP / nunca en el repo | Claude para administrar la base |

> 🔒 **Regla de oro:** las claves sensibles (Anthropic, Google, service_role) **nunca** van en `.env.local` con prefijo `NEXT_PUBLIC_` ni en el código del navegador. Van en `app_secrets` (que solo leen las Edge Functions) o en variables de entorno del servidor.

---

## Stack técnico (referencia rápida)
- **Next.js 16** (App Router, Turbopack). El middleware se llama `proxy.ts`. ⚠️ Tiene breaking changes vs versiones viejas — ver `AGENTS.md`.
- **Supabase**: Postgres + Auth + Edge Functions (Deno) + RLS + pg_cron + pg_net.
- **Tailwind v4** (config CSS con `@theme` en `app/globals.css`).
- **Railway** (Node 22). `.railwayignore` excluye `node_modules`/`.next`.
- Gráficos: **SVG hechos a mano**, sin librerías.
- Capa de datos central: **`lib/db.ts`** (todos los fetch/insert/update + tipos).

Para el detalle de decisiones de diseño y gotchas, ver **`CLAUDE.md`**.
