# Plata — Documentación end-to-end

> **Para qué sirve este archivo.** Es el documento de arranque: si abrís un chat nuevo (con Claude o con quien sea) y pegás esto, la otra punta entiende la app entera — qué hace, cómo está construida, dónde vive cada pieza, cómo se accede, qué reglas de negocio explican cada número y qué está roto o pendiente. No reemplaza a `CLAUDE.md` (que son las instrucciones operativas para el agente) ni a `CONTEXTO_DISENO.md` (que es el brief visual): los complementa y, donde hay contradicción, **manda este archivo**, porque se escribió leyendo el código y la base de datos reales.
>
> **Verificado contra producción el 07/09/2026** — schema, funciones SQL, triggers, crons y Edge Functions leídos en vivo del proyecto Supabase, no de memoria.

---

## Índice

1. [Qué es Plata](#1-qué-es-plata)
2. [Accesos: dónde está todo y cómo entrar](#2-accesos-dónde-está-todo-y-cómo-entrar)
3. [Arquitectura en una página](#3-arquitectura-en-una-página)
4. [El repositorio](#4-el-repositorio)
5. [Modelo de datos](#5-modelo-de-datos)
6. [Las reglas de negocio que hacen cerrar los números](#6-las-reglas-de-negocio-que-hacen-cerrar-los-números)
7. [Funciones SQL y RPCs](#7-funciones-sql-y-rpcs)
8. [Triggers](#8-triggers)
9. [Edge Functions y automatizaciones](#9-edge-functions-y-automatizaciones)
10. [El frontend, pantalla por pantalla](#10-el-frontend-pantalla-por-pantalla)
11. [La capa de datos (`lib/db.ts`)](#11-la-capa-de-datos-libdbts)
12. [Sistema de diseño](#12-sistema-de-diseño)
13. [Seguridad](#13-seguridad)
14. [Operación: deploy y runbooks](#14-operación-deploy-y-runbooks)
15. [Gotchas técnicos](#15-gotchas-técnicos)
16. [Estado actual y backlog](#16-estado-actual-y-backlog)
17. [Lo que vive en la misma base pero NO es Plata](#17-lo-que-vive-en-la-misma-base-pero-no-es-plata)

---

## 1. Qué es Plata

App de finanzas personales **mono-usuario**, **multi-moneda (ARS / USD / USDT)**, en **español argentino**. Está **en producción y en uso diario real** — no es un demo. Migrada desde una app vieja que vivía en el mismo Supabase (el schema `legacy` es el backup de aquella).

Lleva el seguimiento completo de las finanzas de una persona:

- **Saldos en tiempo real** en las tres monedas + patrimonio neto.
- **Transacciones** (ingresos / egresos) con categorías y métodos de pago.
- **Tarjetas de crédito**: resúmenes (statements), cuotas (installment plans), consumos.
- **Deudas** por persona (te deben / debés), con pagos parciales e historial.
- **Cash Flow** proyectado a 6 meses, con inflación oficial argentina.
- **Métricas**: patrimonio neto en el tiempo, ratios, gráficos por categoría y método, variación mes a mes.
- **Gastos hormiga**: análisis del microgasto evitable y detección de suscripciones.
- **Divisas**: tablero de cotizaciones reales y registro de cambios de moneda.
- **Automatización**: importa los consumos de tarjeta leyendo las alertas de Gmail, cada 15 minutos, solo.
- **Asistente IA**: cargás gastos en lenguaje natural (o por voz) y Claude los propone; vos confirmás.

**Escala real hoy (07/09/2026):** 439 transacciones (desde 30/03/2026), 5 tarjetas, 18 resúmenes, 21 planes de cuotas, 10 deudas, 289 mails procesados, 28.802 cotizaciones diarias desde 2011, 1 usuario.

---

## 2. Accesos: dónde está todo y cómo entrar

### 2.1 Las cuatro puertas

| Qué | Dónde | Cómo se entra |
|---|---|---|
| **La app** | https://plata-production.up.railway.app | Usuario y contraseña de Supabase Auth (ver abajo) |
| **El código** | https://github.com/gigli-developer/plata-gigli | Cuenta de GitHub `gigli-developer` |
| **La base de datos + backend** | Supabase, project ref **`dsocdpxlvcufitvovydr`** | https://supabase.com/dashboard/project/dsocdpxlvcufitvovydr |
| **El hosting del frontend** | Railway, proyecto y servicio **`plata`** | https://railway.app + API token |

### 2.2 Usuario de la app

- **Email:** `giglilangonelucas@gmail.com` — es el **único** usuario que existe y puede existir.
- **Registro bloqueado a nivel base:** el trigger `solo_mi_usuario` en `auth.users` (BEFORE INSERT) rechaza cualquier alta que no sea esa casilla. La pantalla de login tampoco ofrece signup.
- **Olvidé la contraseña:** hay un botón en `/login` que manda el mail de recuperación **siempre a esa casilla** (está hardcodeada en `app/login/page.tsx`, no hay campo de destino — así nadie puede usar el botón para mandar mails a otro lado). El link aterriza en `/auth/reset`, que soporta los tres formatos de Supabase: PKCE (`?code=`), `token_hash` (funciona desde cualquier dispositivo) y tokens en el fragmento (`#access_token=`, formato viejo).

### 2.3 Supabase

- **Project ref:** `dsocdpxlvcufitvovydr`
- **Nombre en el dashboard:** `gigli-developer's Project` · **Región:** `us-east-1` · **Postgres 17.6** · estado `ACTIVE_HEALTHY`
- **API URL:** `https://dsocdpxlvcufitvovydr.supabase.co`
- **Host de la DB:** `db.dsocdpxlvcufitvovydr.supabase.co`
- Ojo: en la misma organización hay otros dos proyectos (`Momentum`, inactivo; `Task Manager`) que **no tienen nada que ver con Plata**.

**Cómo opera un agente sobre esta base:** con el **MCP de Supabase** (`execute_sql`, `apply_migration`, `deploy_edge_function`, `get_advisors`, `query_logs`). No hay migraciones versionadas en el repo — el schema se fue construyendo con SQL vía MCP. Esto es importante: **la base es la fuente de verdad del schema**, no el repo.

### 2.4 Las llaves: cuál es cuál y dónde vive

Esta es la parte que siempre se pregunta. Hay tres niveles:

| Llave | Dónde vive | Quién la usa | ¿Es secreta? |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local` (local) + variables de entorno de Railway (prod) | El navegador | No, es pública por diseño |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Ídem | El navegador | No — la protege RLS |
| `ANTHROPIC_API_KEY` | Tabla **`app_secrets`** | Edge Function `assistant` | **Sí** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Tabla **`app_secrets`** | Edge Function `email-poller` | **Sí** |
| `POLLER_SECRET` | Tabla **`app_secrets`** + en el `command` de los cron jobs | `email-poller` y `fx-sync` (header `x-poller-secret`) | **Sí** |
| `SUPABASE_SERVICE_ROLE_KEY` | Inyectada por Supabase en el runtime de las Edge Functions | Las Edge Functions | **Sí, la más sensible** |
| `RAILWAY_API_TOKEN` | Variable de entorno de la máquina de quien deploya (`$env:RAILWAY_API_TOKEN` en PowerShell) | El deploy | **Sí** |

**Regla de oro:** nada sensible lleva prefijo `NEXT_PUBLIC_` ni entra al bundle del navegador. Los secretos viven en la tabla `app_secrets`, que **no tiene ninguna policy de RLS** — con RLS activado y cero policies, el `anon` no lee nada; solo el `service_role` (o sea, las Edge Functions) accede.

**Para leer qué claves hay** (nombres, no valores): `select key from app_secrets order by key;`

Hoy hay 12 filas, de las cuales **Plata usa 5**: `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `POLLER_SECRET`. Las otras siete (`GCAL_*`, `SPOTIFY_*`, `OPENROUTER_API_KEY`, `PC_CHANNEL_SECRET`) son de otro proyecto que comparte la base — ver [sección 17](#17-lo-que-vive-en-la-misma-base-pero-no-es-plata).

### 2.5 Correr la app en local

```bash
npm install
npm run dev          # http://localhost:3000 (launch.json de VS Code usa el 3100)
```

Necesitás un `.env.local` (no está en el repo, `.gitignore` excluye `.env*`):

```
NEXT_PUBLIC_SUPABASE_URL=https://dsocdpxlvcufitvovydr.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key del dashboard: Settings → API>
# solo si vas a correr los scripts de Gmail:
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

Con eso el local pega contra la **base de producción** (no hay entorno de staging). Cualquier cosa que escribas en local es real.

---

## 3. Arquitectura en una página

```
┌───────────────────────────────────────────────────────────────────────┐
│  NAVEGADOR                                                            │
│  Next.js 16 (App Router) — casi todo "use client", funciona como SPA  │
│  · lee/escribe Supabase directo con la anon key                       │
│  · RLS (user_id = auth.uid()) es lo único que separa los datos        │
│  · caché local stale-while-revalidate en localStorage (plata:v2:*)    │
└──────────────┬────────────────────────────────────────────────────────┘
               │ HTTPS
               ▼
┌───────────────────────────────────────────────────────────────────────┐
│  RAILWAY — servicio `plata` (Node 22, Nixpacks/railpack)              │
│  Sirve el frontend. `proxy.ts` (ex-middleware) refresca la sesión de   │
│  Supabase en cada request y redirige a /login si no hay usuario.       │
└──────────────┬────────────────────────────────────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────────────────┐
│  SUPABASE (dsocdpxlvcufitvovydr, us-east-1, Postgres 17)              │
│                                                                       │
│  Auth ── 1 usuario, registro bloqueado por trigger                    │
│                                                                       │
│  Postgres ── ~23 tablas de Plata, todas con RLS owner_all             │
│    ├─ RPCs: get_metrics, get_networth_series, register_exchange…      │
│    ├─ Triggers: congelan cotización, papelera de borrados             │
│    └─ schema `legacy` (10 tablas) = backup de la app vieja            │
│                                                                       │
│  Edge Functions (Deno)          pg_cron + pg_net                      │
│    ├─ email-poller  ◄────────── cada 15 min                           │
│    ├─ fx-sync       ◄────────── cada hora                             │
│    ├─ inflation-sync ◄───────── 14:00 UTC (11:00 ART)                 │
│    └─ assistant     ◄────────── la llama el navegador                 │
└──────────────┬────────────────────────────────────────────────────────┘
               │
               ▼
   APIs externas: Gmail API · api.anthropic.com · dolarapi.com · argentinadatos.com
```

**Lo importante de este dibujo:** no hay backend propio. El navegador habla con Postgres directo. Todo lo que parece "servidor" son cuatro Edge Functions de Deno que corren en Supabase y las dispara un cron dentro de la misma base.

---

## 4. El repositorio

```
plata-gigli/
├─ CLAUDE.md               Instrucciones operativas para el agente (importa AGENTS.md)
├─ AGENTS.md               ⚠️ "Este NO es el Next.js que conocés" — leer docs de node_modules/next/dist/docs/
├─ CONTEXTO_DISENO.md      Brief visual completo (para Claude Design)
├─ SETUP.md                Guía para clonar el proyecto con TU propia infra
├─ PLATA.md                ← este archivo
├─ proxy.ts                Middleware de Next 16: refresca sesión + protege rutas
├─ app/
│  ├─ layout.tsx           Fuentes (Bricolage/Hanken/JetBrains), viewport, Shell
│  ├─ page.tsx             Resumen (home) — 514 líneas, incluye el asistente embebido
│  ├─ metricas/            KPIs, patrimonio en el tiempo, gráficos
│  ├─ hormiga/             Gastos hormiga
│  ├─ cashflow/            Proyección a 6 meses
│  ├─ transacciones/       Lista + filtros + alta manual
│  ├─ tarjetas/            Tarjetas, resúmenes, cuotas, proyección
│  ├─ deudas/              Deudas por persona, pagos parciales
│  ├─ divisas/             Tablero de cotizaciones + registro de cambios
│  ├─ reglas/              Reglas de auto-categorización
│  ├─ recurrentes/         ComingSoon (vacía)
│  ├─ login/ · auth/reset/ Sin shell
│  ├─ icons.tsx            Íconos SVG a mano
│  ├─ globals.css          Design tokens (@theme) + clases (.panel, .ai-glow, .tnum…)
│  └─ components/
│     ├─ Shell.tsx         Layout, nav desktop + bottom nav mobile, PageHeader, ComingSoon
│     ├─ charts.tsx        Donut, BarList, GroupedColumns, VariationTable, NetWorthChart
│     ├─ assistantChat.tsx Hook useAssistantChat + MessageList + ProposalCard
│     ├─ useDictation.ts   Dictado por voz (Web Speech API, corta a 3s de silencio)
│     ├─ CountUp.tsx       Animación de números al aparecer
│     ├─ PrivacyToggle.tsx Modo privacidad (difumina los montos)
│     ├─ Modal / MoreSheet / CardModal / EditTxModal / EditPlanModal / EditDatesModal
│     └─ Providers.tsx
├─ lib/
│  ├─ db.ts                ★ CAPA DE DATOS CENTRAL — 829 líneas, todos los fetch/insert + tipos
│  ├─ fx.ts                Cotizaciones compartidas: fxSync(), loadFx(), toArs(), arsDe(), aggArs()
│  ├─ cache.ts             Caché localStorage stale-while-revalidate (prefijo plata:v2:)
│  ├─ hormiga.ts           Lógica pura de Gastos hormiga (sin JSX ni fetch)
│  ├─ subs.ts              Detección de suscripciones para proyectar resúmenes futuros
│  ├─ format.ts            ars(), usd(), compact(), compactUsd()
│  └─ supabase/            Clientes browser (client.ts) y server (server.ts) con @supabase/ssr
├─ supabase/functions/
│  ├─ assistant/index.ts   Copia versionada — se deploya con MCP, no con el repo
│  └─ email-poller/index.ts  Ídem
│     (fx-sync e inflation-sync NO están en el repo: viven solo deployadas)
└─ scripts/
   ├─ gmail-auth.mjs       OAuth de Gmail → imprime el refresh token
   ├─ gmail-explore.mjs · gmail-body.mjs · gmail-parse-test.mjs   Debug del parser
   └─ email-poller.mjs     Versión standalone del poller (para correr a mano)
```

### Stack

- **Next.js 16.2.6** (App Router, Turbopack) + **React 19.2.4**. ⚠️ Versión con breaking changes: el middleware se llama **`proxy.ts`** y exporta `proxy()`, no `middleware()`. La documentación está en `node_modules/next/dist/docs/` — `AGENTS.md` ordena leerla antes de escribir código.
- **Supabase**: `@supabase/ssr` 0.10 + `@supabase/supabase-js` 2.106.
- **Tailwind v4** — config en CSS con `@theme`, no hay `tailwind.config.js`.
- **SWR** está instalado pero el patrón dominante es `useEffect` + `readCache`/`writeCache` a mano.
- **Sin librerías de gráficos ni de componentes**: todos los charts son SVG escritos a mano; toda la UI es HTML + Tailwind.

---

## 5. Modelo de datos

Schema `public`. Salvo que se aclare, **todas las tablas tienen RLS activado con una única policy `owner_all`: `user_id = auth.uid()` (USING y WITH CHECK)** y `user_id` con default `auth.uid()`.

### 5.1 Núcleo transaccional

**`transactions`** (439 filas) — el corazón de la app.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | bigint identity | |
| `user_id` | uuid | default `auth.uid()` |
| `type` | enum `tx_type` | `ingreso` \| `egreso` |
| `nature` | enum `tx_nature` | `fijo` \| `variable` (default `variable`) — lo usa /hormiga y debería usarlo Cash Flow |
| `category_id` → `categories` | bigint | nullable |
| `payment_method_id` → `payment_methods` | bigint | nullable |
| `amount` | numeric | **en su moneda original** |
| `currency` | text | `ARS` \| `USD` \| `USDT` (default ARS) |
| `description` / `keyword` | text | |
| `is_paid` | bool | default true |
| `card_id` → `cards` | bigint | |
| `statement_id` → `card_statements` | bigint | linkea el consumo a su resumen |
| `installment_current` / `installment_total` | smallint | casi sin uso: las cuotas viven en `installment_plans` |
| `occurred_at` | timestamptz | fecha real del movimiento |
| `source` | enum `tx_source` | `manual` \| `ocr` \| `email` \| `chat` |
| `fx_rate_ars` | numeric | **cotización congelada** del día del movimiento. NULL en ARS. La setea el trigger `trg_tx_freeze_fx` |
| `exchange_id` → `currency_exchanges` | bigint | ON DELETE CASCADE: borrar el cambio borra su contrasiento |

**`categories`** (14) — `name`, `emoji`, `kind` (enum `cat_kind`: `ingreso`/`egreso`/`ambos`), `is_archived`.
**`payment_methods`** (4) — solo `name`. El string exacto **`'Tarjeta de Crédito'`** es semántico: `get_metrics` lo usa para excluir esos egresos del saldo líquido. Si se renombra, el patrimonio se rompe.
**`persons`** (6) — `name`, `emoji`.

### 5.2 Tarjetas

**`cards`** (5) — `name`, `bank`, `network`, `last4`, `currencies`, `limit_ars`, `closing_day`, `due_day`, `is_archived`.
Los **`last4` son la clave del importador de mails**: `cardByLast4` mapea la alerta a la tarjeta. Si se repiten, los consumos se imputan mal — por eso `db.ts` expone `last4EnUso()` para validar en el alta. **No se expone borrar tarjetas** (`card_statements.card_id` es CASCADE y se llevaría todo el historial): se archivan.

**`card_statements`** (18) — `card_id`, `period_label` (`YYYY-MM`), `closing_date`, `due_date`, `is_paid`, `paid_usd`, `total_ars`, `total_usd`, `fx_rate_ars`, `paid_at`.
Índice único `(card_id, period_label)` que evita duplicados cuando la app y el poller crean el próximo resumen a la vez.
`fx_rate_ars` = blue compra del día en que se **pagó** (no del consumo). `paid_at` en los históricos se backfilleó con `due_date` porque no había registro del pago real — es una aproximación conocida.

**`installment_plans`** (21) — `card_id`, `description`, `emoji`, `monthly_amount`, `currency`, `total_installments`, `first_charge_date`, `category_id`.
**Las cuotas NO son transacciones.** Viven solo acá; las cuota-transacciones se borraron para no duplicar. La cuota vigente se calcula por diferencia de meses contra `first_charge_date`.

### 5.3 Deudas

**`debts`** (10) — `person_id`, `kind` (enum `debt_kind`: `cash`/`in_kind`/`split`), `direction` (enum `debt_direction`: `to_collect`/`to_pay`), `status` (enum `debt_status`: `pending`/`settled`), `amount`, `currency`, `description`, `occurred_at`, `settled_at`, `split_total`, `your_share`, `participants`, `linked_transaction_id`.

**`debt_payments`** (5) — `debt_id`, `amount`, `occurred_at`, `transaction_id`, `fx_rate_ars` (congelada al pagar, leyendo la moneda de `debts`).
**El monto original de una deuda nunca se modifica.** Saldo pendiente = `amount − Σ pagos`.

### 5.4 Cotizaciones e inflación

**`fx_rates`** (28.802 filas, **RLS con policy `read_all` de solo lectura — pública**) — PK `(day, casa)`, columnas `compra`, `venta`, `source`.
Casas: `oficial`, `blue`, `bolsa`, `contadoconliqui`, `mayorista`, `cripto`, `tarjeta`. Histórico completo **desde 2011-01-03 hasta hoy**. Es la **fuente única de cotizaciones** de toda la app.

**`inflation_monthly`** (1.001 filas, también `read_all`) — PK `month` (`YYYY-MM`), `rate`. Inflación oficial argentina, para el Cash Flow.

**`currency_exchanges`** (8) — `from_currency`, `to_currency`, `from_amount`, `to_amount`, `rate`, `rate_source` (enum `rate_source`: `auto`/`manual`).

### 5.5 Cash Flow

- **`cashflow_config`** (1) — PK `user_id`, `inflation_monthly` (%). Override manual de la inflación proyectada.
- **`cashflow_budgets`** (6) — PK `(user_id, category)`, `monthly_amount`. Override del promedio automático por categoría.
- **`cashflow_plans`** (4) — movimientos futuros cargados a mano: `type`, `concept`, `amount`, `start_month`, `months_count` (permite planificar algo en cuotas).
- **`recurring_templates`** (3) — plantillas de ingresos/egresos recurrentes: `name`, `base_amount`, `type`, `currency`, `preferred_day`, `is_variable`, `is_active`. La pantalla /recurrentes está vacía, pero el Cash Flow **sí las lee** para sembrar la proyección.

### 5.6 Automatización

**`rules`** (9) — reglas de auto-categorización que aplica **solo el email-poller** a consumos nuevos.
Condiciones combinables: `text_op` (`contains`/`starts`/`equals`) + `text_value`, `hour_from`/`hour_to`, `days` (int[] 1=Lun…7=Dom), `amount_min`/`amount_max`.
Acciones combinables: `category_id`, `rename_to`, `set_currency` (`ARS`|`USD`).
Orden: `priority` desc, `id` asc.

**`email_process_logs`** (289) — una fila por mail visto: `email_id`, `subject`, `merchant`, `amount`, `currency`, `card_last4`, `transaction_id`, `status` (`ok` / `skip_no_card` / `skip_duplicate` / `error`), `error_message`. Es el **libro de idempotencia** del poller: si el `email_id` ya está, no se reprocesa.

**`chat_messages`** (0 filas) — historial del asistente. Existe pero no se está usando: el chat es efímero en el cliente.

### 5.7 Auditoría y recuperación

**`papelera`** (4) — `tabla`, `fila` (jsonb con la fila entera), `borrado_en`. La llena el trigger `a_la_papelera` en cada DELETE de `transactions`, `debts`, `debt_payments`, `installment_plans`, `card_statements` y `currency_exchanges`. Policy de solo SELECT y solo si `fila->>'user_id'` es tuyo. **Es la red de seguridad ante un borrado accidental.**

**`activity_log`** (2) — operaciones en cascada hechas desde la app (`kind`: `split` / `exchange` / `debt_payment`), con `detail` jsonb y `undone_at`, para un botón "Deshacer". Comentario en la base: **no registra lo que hace el email-poller**.

**`profiles`** (1) — PK = `auth.users.id`. La crea el trigger `handle_new_user`. El poller la usa para resolver el `user_id` dueño de todo (`select id from profiles limit 1`).

**`app_secrets`** (12) — PK `key`, `value`. RLS activado y **cero policies**: solo el `service_role`.

### 5.8 Restos de la app vieja (ignorar)

En `public` quedaron cuatro tablas de la migración, todas con 0 filas salvo `users` (1): **`users`**, **`credit_cards`**, **`debt_records`**, **`raw_messages`**. No las toca nadie. El backup completo está en el schema **`legacy`** (10 tablas), que **no está expuesto por la API** — eso resuelve los warnings de RLS del linter de Supabase.

---

## 6. Las reglas de negocio que hacen cerrar los números

Esta sección es la más importante del documento. Son decisiones deliberadas: si alguien "corrige" una sin entenderla, los números dejan de cerrar.

### 6.1 Devengado vs caja

- **"Gastos por categoría" = devengado.** Cuenta cuando consumís o cuando cae la cuota.
- **"Saldo líquido" = caja.** Es la plata que tenés.
- **Un consumo con crédito NO baja el saldo** hasta que pagás el resumen: mientras tanto es deuda. Si restara al consumir y otra vez al pagar el resumen, contaría doble.

### 6.2 Consumos vs cuotas

Los consumos sueltos viven en `transactions`, linkeados a su resumen por `statement_id`. **Las cuotas viven en `installment_plans`** y no son transacciones. Ambos se suman en "gastos por categoría" y en "por método de pago" (las cuotas imputan a Tarjeta de Crédito).

### 6.3 Préstamos en efectivo

Las deudas `cash` y `split` crean una transacción de categoría **"Préstamos"**: es visible y mueve el saldo, pero está **excluida de las métricas de gasto/ingreso** (igual que "Cambio Divisas"). Prestar = egreso; que te paguen = ingreso. **El patrimonio neto no cambia**: cambiás efectivo por "te deben". Las `in_kind` no mueven saldo al crearse, pero sí al cobrarse en plata.

### 6.4 Pagos de deuda

Tabla `debt_payments` aparte; **el monto original nunca se toca**. Pendiente = `amount − Σ pagos`. Hay pago parcial (botón "Pago") y saldar total. Borrar un pago elimina también su movimiento de plata y reabre la deuda si estaba saldada.

### 6.5 Multi-moneda: una sola fuente de cotizaciones

Cada registro guarda su moneda; **los totales se valúan en ARS**. La fuente única es `fx_rates`, sincronizada cada hora por `fx-sync`.

- **USD se valúa a `blue` COMPRA** — el precio real al que convertís billetes.
- **USDT se valúa a `cripto` COMPRA** — tiene ~4% de spread propio.
- En SQL se lee con `fx_rate_at(casa, fecha, lado)`, que resuelve fines de semana y feriados tomando el último día ≤ fecha.
- En el front: `lib/fx.ts` con `fxSync()` (síncrono, del caché) y `loadFx()` (fetch). `get_metrics` devuelve `usd_ars` / `usdt_ars` ya resueltos.
- **Ningún archivo debe volver a hardcodear una cotización.** Quedan dos excepciones vivas y conocidas: `FX_FALLBACK = { usd: 1525, usdt: 1593 }` en `db.ts` (solo si no hay red ni caché) y `USD_ARS = 1455` en el email-poller (ver 6.9).

### 6.6 ★ Cotización congelada (flujos) vs viva (saldos)

La decisión conceptual más fina de la app.

**Flujos** — gastos e ingresos ya ocurridos → **cotización congelada**. `transactions.fx_rate_ars` guarda la cotización del día del movimiento y la setea el trigger `trg_tx_freeze_fx`, que cubre **todo** camino de escritura (app, asistente, poller, SQL a mano) y recalcula si un update cambia la moneda o el día. Se lee con `arsDe(amount, currency, fxRate, fx)` para filas sueltas y `aggArs(agg, fx)` para los agregados. Aplica en `/`, `/metricas`, `/cashflow` y `/hormiga`.
**Objetivo: que abril quede valuado como abril** y que los meses cerrados no se muevan cada vez que cambia el dólar.

**Saldos y compromisos a futuro** → **cotización viva** (`toArs`). Saldos USD/USDT y patrimonio (`get_metrics` devuelve los saldos sin valuar, en su moneda), deudas pendientes, consumos de un resumen sin pagar, y el costo anual proyectado de una suscripción. **Tener USD 1.000 vale el dólar de hoy**, no el del día que entraron.

`card_statements` y `debt_payments` tienen su propio rate congelado, pero **al pagar, no al consumir**: un resumen pagado saldó sus dólares al dólar de ese día; uno **sin pagar** sigue en vivo, porque todavía es deuda en dólares. Si se revierte el pago, `stmt_freeze_fx` limpia `fx_rate_ars` y `paid_at` y el total vuelve a calcularse en vivo.

⚠️ **El caché de `lib/cache.ts` está en `v2` por este cambio de forma.** Si volvés a cambiar la forma de un snapshot, bumpeá el prefijo o el snapshot viejo pinta NaN hasta que llegue el fetch.

### 6.7 Patrimonio neto en el tiempo

La RPC `get_networth_series(p_months)` reconstruye, para el cierre de cada mes, los mismos componentes que `get_metrics()` calcula para hoy.

- Las tenencias se valúan con la cotización **vigente a cada corte** (`fx_rate_at(casa, cutoff, 'compra')`), no con la congelada: son **stocks**. Este es el otro gran uso del histórico de `fx_rates`.
- **Invariante de regresión: el último punto de la serie debe dar exactamente igual que el patrimonio de `/metricas`.** Si tocás `get_metrics` o la RPC, verificalo.
- Tres cosas que costaron y no hay que romper:
  1. Las cuotas usan `total - k` (la del mes en curso **todavía se debe**, el resumen se paga al mes siguiente). Con `total - k - 1` la serie quedaba $117.056 abajo.
  2. Una deuda `settled` **sin pagos registrados** (hay 2 así) tiene que mirar `settled_at`, o queda pendiente para siempre.
  3. La serie arranca en el mes de la primera transacción; antes, los meses previos mostraban solo cuotas heredadas y daban patrimonio negativo falso.
- En `/metricas` la dibuja `NetWorthChart`: columnas apiladas (activos arriba, pasivos abajo) + línea del neto. **El contenedor no lleva `gap` a propósito**, para que el centro de cada columna caiga en `(i+0.5)/n` y la línea quede alineada. Los puntos son divs absolutos, no `<circle>`: el SVG usa `preserveAspectRatio="none"` y los círculos se verían elipses.
- Arriba del gráfico se descompone la variación del mes en **"tuyo" vs "por el dólar"**: el efecto cambiario se mide sobre las tenencias con las que arrancó el mes (`usd_prev * Δusd_ars + usdt_prev * Δusdt_ars`) y el resto es flujo.
- **Toggle $ / US$** (default pesos). En dólares cada punto se divide por el blue **de su propio corte**, no por el de hoy. La descomposición se invierte y pasa a ser "lo que te costó tener PESOS": `ars_prev * (1/usd_ars_cur − 1/usd_ars_prev)`, negativo cuando el dólar sube.

### 6.8 Resúmenes de tarjeta

- **Pagado = fijo.** El total se congela al pagar, para poder reconciliarlo contra el PDF del banco.
- **No pagado = en vivo**: consumos linkeados + cuotas del período. **Nunca usar el total guardado de un resumen sin pagar** — queda stale, a veces en $0.
- El importador de mails es en tiempo real, así que **la app puede ir adelantada al banco**.
- Cierre y vencimiento son editables; los resúmenes nuevos heredan el día por defecto de la tarjeta. Galicia Visa 2811: cierra 25, vence 6.
- **Auto-generación del próximo resumen** por dos caminos: `ensureNextStatements` (en `db.ts`, corre al cargar Tarjetas) y el email-poller (si no encuentra resumen abierto al importar). El índice único `(card_id, period_label)` evita el duplicado.

### 6.9 Proyección de resúmenes futuros = cuotas + suscripciones

Antes, un mes futuro mostraba solo las cuotas y quedaba en ~$0 aunque todos los meses caen Spotify, HBO, Apple y compañía. `lib/subs.ts` lo resuelve:

`fetchCardCharges` trae los consumos con tarjeta (8 meses, sin cuotas) y `detectarSubs` agrupa por (tarjeta, comercio normalizado, moneda) por mes. Entra un comercio si lo marcaste `fijo` en /hormiga, **o** si cumple las tres:
1. 3 meses con monto dentro de ±25% de la mediana (2 si el nombre delata suscripción);
2. ≤1,5 cobros por mes;
3. último cobro dentro de los últimos 2 meses.

El criterio (2) es el que salva todo: AUSA (peajes) aparece 8,75 veces por mes y Rappi 5,25 — sin él entrarían como "abono". El (1) usa mediana con tolerancia porque las suscripciones en USD varían (Spotify 2,27 → 2,42) y porque Apple mezcla el abono con compras sueltas de US$ 0,39.

⚠️ **Solo se suman a resúmenes PROYECTADOS (`id < 0`).** En un resumen real los consumos entran por el importador; sumarles la proyección los contaría dos veces.

**Limitación conocida:** si el comercio cambia de nombre entre meses (`ANTHROPIC* CLAUDE SUB` / `CLAUDE.AI SUBSCRIPTION`, o `GOOGLE *GOOGLE ONE` / `GOOGLE *GOOGLE O`) cada variante cuenta por separado y ninguna llega al mínimo. La salida es marcarla `fijo` en /hormiga.

### 6.10 Gastos hormiga

El eje es **lo evitable, no lo chico**. Entran Delivery, Comida, Ocio, Transporte y Compras.

- Se excluyen las **cuotas** (no son decisión del mes) y las **suscripciones** (no son impulso).
- Se excluye lo que **no es impulso** aunque caiga en esas categorías: trámites, multas, impuestos, seguros, patentes, VTV. Salió de mirar los datos reales — una multa de la policía de Entre Ríos y un trámite de `buenosaires.gob.ar` encabezaban el ranking con casi $300.000 cada uno.
- El **umbral** es el percentil 70 del ticket, auto-calibrado (mínimo $2.000, redondeado a $500; si hay menos de 10 movimientos, $15.000 por defecto). **No excluye**: parte el total en `goteo` (≤ umbral, *el* análisis) y `grandes` (> umbral, contexto que **no** entra en los totales).
- **Suscripciones**: mismo comercio normalizado + mismo monto en 3 meses distintos (2 si el nombre lo delata: spotify, netflix, hbo, apple, claude, openai, prime, "abono", "membres"…). Desde ahí se marcan `nature='fijo'`. El costo anual proyectado usa cotización de **hoy** (es gasto futuro).
- `normalizarComercio()` limpia prefijos de pasarela (`MERPAGO*`, `MP*`, `DLO*`, `PEDIDOSYA*`, `EBANX*`…), acentos, número de sucursal al final y enmascarados `XXXX`.

### 6.11 Reglas de consumos: semántica de merge por campo

Las aplica **solo el email-poller**, a consumos nuevos. Se evalúan **todas** (prioridad desc, id asc) contra la descripción **original**, y **cada acción la define la primera regla que la tenga** — pueden venir de reglas distintas (una recategoriza, otra renombra, otra fuerza moneda).

**`set_currency` CONVIERTE el monto** usando `USD_ARS = 1455` hardcodeado en el poller. Razón: la alerta de Galicia **siempre** reporta el equivalente en pesos (ej. TACTIQ llega como $6.000 y es USD 4,11). Re-etiquetar sin convertir sería un desastre. *(Punto de deuda técnica: debería leer `fx_rate_at('blue', hoy, 'compra')`.)*

El **dup-check no filtra por moneda** (una moneda forzada colaría duplicados) y corre **después** de aplicar las reglas, con el monto final: tarjeta + monto + ventana de ±2 minutos.

---

## 7. Funciones SQL y RPCs

### 7.1 Las que usa la app

**`get_metrics() → jsonb`** (STABLE) — el KPI de un saque. Devuelve:
`ref_month`, `ars_liquido`, `usd_liquido`, `usdt_liquido`, `deuda_cuotas_ars`, `deuda_vencida_ars`, `te_deben`, `debes`, `ing_mes_ars`, `ing_mes_usd`, `egr_mes_ars`, `egr_mes_usd`, `usd_ars`, `usdt_ars`.

Cómo calcula:
- `ars_liquido = ingresos_ARS − egresos_ARS_no_crédito − resúmenes_pagados`. "No crédito" = el método de pago no se llama exactamente `'Tarjeta de Crédito'`.
- Los saldos vienen **sin valuar**, en su moneda; la valuación la hace el cliente.
- `te_deben` / `debes` usan el **saldo pendiente** (`amount − Σ pagos`), valuado a cotización viva.
- `ref_month` es el mes de la **última transacción de ingreso**, no el mes calendario. Así el "mes en curso" no queda vacío los primeros días.
- El mes excluye las categorías `'Cambio Divisas'` y `'Préstamos'`.
- El egreso del mes suma el resumen del período: en vivo si no está pagado (consumos + cuotas), fijo si está pagado.
- ⚠️ **CLAUDE.md dice que `usd_ars` está fijo en 1455 — eso ya no es cierto.** Hoy hace `coalesce(fx_rate_at('blue', current_date,'compra'), 1455)` y `coalesce(fx_rate_at('cripto',…), 1462)`: los números son un último recurso si `fx_rates` está vacía.

**`get_networth_series(p_months int) → TABLE(...)`** — la serie de patrimonio de la sección 6.7. Devuelve por mes: `month`, `cutoff`, `ars`, `usd`, `usdt`, `usd_ars`, `usdt_ars`, `te_deben`, `debes`, `deuda_cuotas`, `deuda_vencida`, `activos`, `pasivos`, `patrimonio`.

**`register_exchange(p_from, p_to, p_from_amount, p_to_amount, p_rate, p_rate_source, p_user_id) → bigint`** — registra un cambio de divisas **y genera las dos transacciones "Cambio Divisas"** que mueven los saldos, linkeadas por `exchange_id`. Esto resuelve un bug histórico donde `insertExchange` escribía solo `currency_exchanges` y el balance no se movía.

**`fx_rate_at(p_casa, p_day, p_lado) → numeric`** — la cotización de una casa a una fecha, resolviendo hacia atrás (último día ≤ fecha). Es lo que hace que fines de semana y feriados no den NULL.

### 7.2 Las que existen en la base pero este repo NO llama

Están escritas y funcionan; las consume el asistente de voz externo (sección 17). **Si estás tocando Plata, saber que existen te evita reimplementarlas:**

- **`dividir_gasto(p_user_id, p_total, p_puse, p_parte, p_personas jsonb, p_descripcion, p_categoria_id, p_metodo_id, p_fecha, p_moneda) → jsonb`** (SECURITY DEFINER) — gasto compartido completo: transacción + una deuda por persona.
- **`pagar_deuda(p_debt_id, p_monto, p_nota) → jsonb`** — pago parcial o total con su contrasiento.
- **`convertir_a_cuotas(p_tx_id, p_cuotas, p_primera) → installment_plans`** — convierte un consumo suelto en plan de cuotas. **Es exactamente el "botón convertir a cuotas" que el backlog pide en la UI: la lógica ya está hecha, falta el front.**
- **`flujo_de_caja(p_meses) → jsonb`** (SECURITY DEFINER) — proyección de cash flow calculada en la base.
- **`update_exchange(...)`** — editar un cambio de divisas.
- **`fmt_es_ar(numeric) → text`** — formateo de números en castellano, para respuestas habladas.

---

## 8. Triggers

| Tabla | Trigger | Cuándo | Qué hace |
|---|---|---|---|
| `transactions` | `trg_tx_freeze_fx` | BEFORE INSERT OR UPDATE | Congela `fx_rate_ars` con la cotización del día (blue compra si USD, cripto compra si USDT). Recalcula si cambia moneda o día. **Cubre todo camino de escritura.** |
| `card_statements` | `trg_stmt_freeze_fx` | BEFORE UPDATE | Congela el blue al marcar pagado y **limpia `fx_rate_ars` + `paid_at` si se revierte el pago**. |
| `debt_payments` | `trg_debt_payment_freeze_fx` | BEFORE INSERT OR UPDATE | Ídem, leyendo la moneda de `debts`. |
| `transactions`, `debts`, `debt_payments`, `installment_plans`, `card_statements`, `currency_exchanges` | `trg_papelera_*` | AFTER DELETE | Copia la fila entera a `papelera` (jsonb). Red de seguridad ante borrados. |
| `auth.users` | `solo_mi_usuario` | BEFORE INSERT | Rechaza cualquier alta que no sea la casilla del dueño. |
| `auth.users` | `on_auth_user_created` | AFTER INSERT | Crea la fila en `profiles`. |

---

## 9. Edge Functions y automatizaciones

Cuatro funciones Deno, todas deployadas **con el MCP de Supabase (`deploy_edge_function`), no con el repo**. Dos tienen copia versionada en `supabase/functions/`; dos viven solo deployadas.

| Función | Versión | `verify_jwt` | En el repo | Quién la dispara |
|---|---|---|---|---|
| `email-poller` | 10 | **false** | Sí (verificado: idéntica a la v10 desplegada) | cron cada 15 min |
| `assistant` | 2 | true | Sí | El navegador con la sesión del usuario |
| `fx-sync` | 1 | **false** | **No** | cron cada hora |
| `inflation-sync` | 1 | **false** | **No** | cron diario 14:00 UTC |

### Cron jobs (pg_cron + pg_net)

| # | Nombre | Schedule | Destino |
|---|---|---|---|
| 1 | `email-poller-15min` | `*/15 * * * *` | `email-poller`, con header `x-poller-secret` |
| 2 | `inflation-sync-daily` | `0 14 * * *` (11:00 ART) | `inflation-sync`, sin secreto |
| 3 | `fx-sync` | `0 * * * *` | `fx-sync`, con header `x-poller-secret` |

Ver estado: `select jobid, jobname, schedule, active from cron.job;` · Ver respuestas HTTP: `select * from net._http_response order by created desc limit 20;`

### 9.1 `email-poller` — el importador de consumos

El corazón de la automatización. Flujo:

1. **Auth.** Como `verify_jwt=false`, se protege con secreto compartido: exige `x-poller-secret` == `app_secrets.POLLER_SECRET`. Sin ese header devuelve **401**. *(Si redeployás, mantené el chequeo.)*
2. Carga secretos, `profiles` (para el `user_id`), `cards`, `payment_methods`, `categories` y las `rules` activas.
3. Renueva el access token de Gmail con el `GOOGLE_REFRESH_TOKEN`.
4. Busca en Gmail: `subject:"Alerta de Compras Visa" newer_than:4d`, hasta 100 mensajes.
5. Descarta los `email_id` que ya están en `email_process_logs` (idempotencia).
6. Parsea el cuerpo con regex: `Comercio:`, `Tarjeta:` (últimos 4), `Moneda:`, `Monto:`.
7. Resuelve la tarjeta por `last4`. Si no matchea → log `skip_no_card`.
8. **Aplica las reglas** (merge por campo) y, si hay `set_currency`, convierte el monto.
9. **Dup-check** con el monto final: misma tarjeta, mismo monto, ±2 minutos.
10. Si la tarjeta es de débito → `is_paid=true`, sin resumen. Si es crédito → busca el resumen abierto y, **si no existe, lo crea** (upsert con `onConflict: card_id,period_label`).
11. Inserta la transacción con `source='email'` y loguea el resultado.

**Categorización de fallback** (si ninguna regla matchea): una lista de regex → categoría, hardcodeada en la función (rappi/pedidosya → Delivery; burger/café/mcdonald/parrilla → Comida; hoyts/spotify/netflix → Ocio; claude/openai/github/apple → Servicios; carrefour/coto/farmacity → Compras; ausa/sube/uber/ypf → Transporte; resto → Otros).

**Limitación estructural:** la alerta de Galicia **no trae si la compra fue en cuotas** (verificado). Toda compra en cuotas entra como pago único y hay que convertirla a mano.

### 9.2 `assistant` — el asistente IA

- Modelo **`claude-sonnet-4-6`**, key desde `app_secrets`, `max_tokens: 1500`.
- Arma el system prompt en caliente con los **catálogos reales** (categorías de egreso/ingreso, métodos de pago, personas, tarjetas) y la fecha de hoy en ART. Usa **prompt caching** (`cache_control: ephemeral`) sobre el system.
- **Tool use con dos herramientas**:
  - `registrar_movimientos` — propone transacciones y/o deudas. **Nunca ejecuta**: devuelve la propuesta, el cliente la muestra, el usuario confirma y **se escribe desde el navegador con su sesión** (RLS-safe).
  - `preguntar_opciones` — hace **una** pregunta con 2 a 4 opciones cuando falta un dato (típicamente el método de pago, que tiene prohibido adivinar).
- Reglas del prompt: **asume ARS siempre** salvo aclaración; un gasto compartido genera el egreso por el total **más** una deuda `split` por persona; una persona desconocida igual se usa (se crea).
- Devuelve `{ reply, proposal, options, tokens, costUsd }` — **el costo de cada consulta se muestra en pantalla**, calculado con precios de Sonnet ($3/$15 por millón, $3,75 cache write, $0,30 cache read).
- `verify_jwt=true`: solo un usuario logueado la llama.

### 9.3 `fx-sync` — cotizaciones

- Corrida normal: `GET https://dolarapi.com/v1/dolares` → upsert de todas las casas del día en `fx_rates`.
- La fecha se calcula **en horario argentino** (`America/Argentina/Buenos_Aires`), no en UTC: a las 21:00 ART ya sería mañana en UTC.
- `?backfill=1`: baja el histórico diario completo de `api.argentinadatos.com` para las 7 casas, de a 1.000 filas por upsert. Así se armaron las 28.802 filas desde 2011.
- Protegida con el mismo `x-poller-secret`.

### 9.4 `inflation-sync` — inflación oficial

Baja `api.argentinadatos.com/v1/finanzas/indices/inflacion` y hace upsert en `inflation_monthly` por mes. **No valida ningún secreto** — ver sección 13.

---

## 10. El frontend, pantalla por pantalla

Diez módulos. `Shell.tsx` monta el layout: nav lateral en desktop, **bottom nav en mobile con 5 módulos fijos** (`MOBILE_FIJOS = ["/", "/metricas", "/hormiga", "/transacciones", "/tarjetas"]`) + botón "Más" que abre `MoreSheet` con el resto. `/login` y `/auth/reset` van **sin** shell.

| Ruta | Qué hace |
|---|---|
| **`/`** Resumen | Saldos en las tres monedas + patrimonio (con `CountUp`), últimos movimientos, accesos rápidos, tarjetas y deudas resumidas. **El asistente IA vive dentro de la barra de búsqueda**: al activarlo, la home se desvanece y el chat toma la barra. Botones de dictado (`useDictation`) y cámara (placeholder de OCR). |
| **`/metricas`** | KPIs, **patrimonio neto en el tiempo** (`NetWorthChart` con toggle $ / US$ y descomposición "tuyo vs por el dólar"), donut por categoría, barras por método de pago, ingresos vs egresos agrupados, tabla de variación mes a mes. Filtro por mes. |
| **`/hormiga`** Gastos hormiga | Goteo vs consumos grandes, ranking de comercios, suscripciones detectadas con su costo anual y botón para marcarlas `fijo`. |
| **`/cashflow`** | Proyección a 6 meses. Siembra con promedios por categoría + recurrentes + cuotas + resúmenes + `cashflow_plans` manuales. Inflación oficial (`inflation_monthly`) aplicada **solo al sueldo**. Presupuestos editables por categoría (`cashflow_budgets`). Columna sticky (`.cf-sticky`) y modo Histórico. |
| **`/transacciones`** | Lista con filtros (texto, tipo, categoría, método), alta manual en modal, edición (`EditTxModal`). |
| **`/tarjetas`** | Solo tarjetas de **crédito** (la débito se oculta visualmente, no se borra). Caras con gradiente, uso del límite, resúmenes con "ver movimientos" desplegable, cuotas, proyección de resúmenes futuros con suscripciones, alta/edición de tarjeta (`CardModal`), editar fechas (`EditDatesModal`) y editar plan de cuotas (`EditPlanModal`). Al montar corre `ensureNextStatements`. |
| **`/deudas`** | Vista por personas o historial, filtros por dirección y tipo, alta de deuda y de persona, pago parcial, saldar total, borrar pago. Las tres clases (`cash` / `in_kind` / `split`) tienen su explicación en pantalla. |
| **`/divisas`** | Tablero de cotizaciones reales desde `fx_rates` (90 días de serie) + registro de cambios que **sí mueve los saldos** vía `register_exchange`. Ya no hay datos mock: `lib/mock.ts` fue borrado. |
| **`/reglas`** | Alta (desplegable), listado en lenguaje natural ("Si la descripción contiene «rappi» · entre 22h y 2h → categoría Delivery"), activar/desactivar, borrar. |
| **`/recurrentes`** | `ComingSoon`. Vacía — pero `recurring_templates` **sí se usa** desde el Cash Flow. |

### Patrón de carga (importante para entender el código)

Casi todas las páginas hacen lo mismo:

```ts
useEffect(() => {
  const s = readCache("clave");
  if (s) { pintar(s); setLoading(false); }   // instantáneo, del snapshot local
  reload().finally(() => setLoading(false)); // lo fresco llega por atrás
}, []);
```

Es stale-while-revalidate a mano sobre `localStorage`, prefijo `plata:v2:`. Aceptable porque la app es mono-usuario y los datos viven solo en ese navegador. `limpiarViejos()` borra snapshots de versiones anteriores una vez por sesión.

---

## 11. La capa de datos (`lib/db.ts`)

829 líneas, **todos** los accesos a Supabase y los tipos de la UI. Si vas a tocar datos, empezá por acá. Agrupado:

- **Catálogos:** `fetchCategories`, `fetchPaymentMethods`, `fetchCards`, `fetchCardsFull`, `fetchPersons`.
- **Transacciones:** `fetchTransactions`, `insertTransaction`, `updateTransaction`, `deleteTransaction`, `updateTxCategory`, `setTxNature`, `fetchExpenseDetail` (detalle con descripción, para /hormiga).
- **Tarjetas:** `insertCard`, `updateCard`, `archiveCard`, `last4EnUso`, `fetchStatements`, `updateStatementDates`, `ensureNextStatements`, `payStatement`, `fetchStatementConsumos`, `fetchStatementMovements`, `fetchInstallments`, `fetchPlansForProjection`, `updateInstallmentPlan`, `deleteInstallmentPlan`.
- **Deudas:** `fetchDebts`, `insertDebt`, `insertPerson`, `settleDebt`, `payDebt`, `deleteDebtPayment`.
- **Cotizaciones:** `fetchFxRates`, `FX_FALLBACK`, `fetchFxBoard` (tablero de /divisas), `FX_CASAS`.
- **Métricas:** `fetchMetrics` (RPC), `fetchNetWorthSeries` (RPC), `fetchMonthlyBreakdown` (agregado por mes/tipo/categoría/método/moneda, con `totalArs` congelado y `totalPend`).
- **Cash Flow:** `fetchCashflowBudgets`, `upsertCashflowBudget`, `deleteCashflowBudget`, `fetchCashflowPlans`, `insertCashflowPlan`, `deleteCashflowPlan`, `fetchInflation`, `updateInflation`, `fetchInflationData`, `fetchRecurring`, `updateRecurringAmount`.
- **Reglas:** `fetchRules`, `insertRule`, `deleteRule`, `toggleRule`.
- **Divisas:** `fetchExchanges`, `insertExchange` (llama a la RPC `register_exchange`).
- **Asistente:** `askAssistant` (invoca la Edge Function).
- **Utilidades:** `formatDate`, `formatShort`.

**Solo se usan tres RPCs desde el front:** `get_metrics`, `get_networth_series` y `register_exchange`. Todo lo demás son queries PostgREST.

---

## 12. Sistema de diseño

Estética **fintech oscuro "liquid glass"** (rediseño de julio 2026, 5 fases).

- **Tipografía:** Bricolage Grotesque (display), Hanken Grotesk (cuerpo), JetBrains Mono para **todos** los números vía clase `.tnum`.
- **Color de acento: naranja `#ff9e1b`.** ⚠️ `CLAUDE.md` y `CONTEXTO_DISENO.md` dicen "lima ácido `#c8ff4d`" — **está desactualizado**. El token se llama `--color-accent` y no `--color-orange` justamente porque ya cambió una vez: así el próximo cambio no obliga a tocar 129 clases en 22 archivos.
- Paleta: `--color-gold #ffbf47` (dólares), `--color-sky #5ec8ff` (USDT/cripto), `--color-emerald #35e08a` (positivo/ingresos), `--color-coral #ff433d` (negativo/egresos/pasivos), `--color-violet #a78bfa` (**reservado a la IA**, en migración).
- **Fondo de atmósfera**: seis `radial-gradient` apilados (glow naranja abajo-izquierda, verde al medio, azul a la derecha) con `background-attachment: fixed`. Es sobre lo que "flota" el vidrio — **si se saca, las cards quedan grises y planas**.
- Clases clave en `globals.css`: `.panel`, `.panel-inner`, `.panel-hover`, `.ai-glow`, `.chip`, `.cf-sticky`, `.tnum`, `.label-micro`, `.privacy`.
- **Mobile:** el alto del bottom nav vive en `--nav-h` / `--nav-safe` — **una sola fuente de verdad**; el `main` usa `.pb-nav`. El teclado se resuelve con `interactiveWidget: "resizes-content"` en el `viewport` de `layout.tsx`. Los modales usan `flex + overflow-y-auto` (no `grid place-items-center`) para poder scrollear con el teclado abierto.
- **Modo privacidad** (`PrivacyToggle`): difumina los montos para mostrar la pantalla sin exponer números.

---

## 13. Seguridad

**Lo que está bien:**
- Toda tabla de datos personales tiene RLS con `owner_all` (`user_id = auth.uid()`). La anon key en el browser no puede leer nada ajeno.
- `app_secrets` con RLS y **cero policies** → inalcanzable desde el cliente.
- Registro bloqueado por trigger a nivel base, no solo en la UI.
- El asistente **propone pero no escribe**: la escritura la hace el navegador con la sesión del usuario, así que pasa por RLS.
- La recuperación de contraseña tiene el destinatario hardcodeado: no se puede usar como relay de mails.
- `email-poller` y `fx-sync`, que corren con `verify_jwt=false`, exigen el secreto compartido `x-poller-secret`.
- El `.gitignore` excluye `.env*` y `PROMPT_NUEVO_CHAT.md` (que contenía el token de Railway).

**Lo que conviene tener en el radar:**
1. **`inflation-sync` es un endpoint abierto**: `verify_jwt=false` y sin chequeo de secreto. El daño posible es acotado (solo hace upsert de datos públicos de inflación), pero cualquiera que sepa la URL puede dispararla. Agregarle el mismo `x-poller-secret` es un cambio de tres líneas.
2. **El `POLLER_SECRET` está en texto plano dentro del `command` de los cron jobs**, visible para cualquiera que pueda leer `cron.job`. Es aceptable en un proyecto de un solo dueño, pero si alguna vez se comparte acceso a la base, hay que rotarlo.
3. **No hay entorno de staging.** El `npm run dev` local pega contra la base de producción.
4. **El token de Gmail caduca cada 7 días** — ver runbook en 14.3.

---

## 14. Operación: deploy y runbooks

### 14.1 Deploy del frontend (Railway)

```powershell
$env:RAILWAY_API_TOKEN = "<token>"
npm run build                      # verificar $LASTEXITCODE: el npm notice ensucia el output
railway up --service plata --ci
```

`.railwayignore` excluye `node_modules`, `.next`, `.git`, `.env*` y `db_backup_vieja`. Runtime Node 22 (Nixpacks/railpack). Las variables `NEXT_PUBLIC_SUPABASE_*` se configuran en el servicio de Railway.

### 14.2 Deploy de una Edge Function

**No sale con el repo.** Se sube con el MCP de Supabase (`deploy_edge_function`). Si tocás `supabase/functions/*/index.ts`, acordate de deployar — y si tocás `fx-sync` o `inflation-sync`, **su código solo existe deployado**: bajalo con `get_edge_function` antes de editar.

### 14.3 Runbook: el importador de mails dejó de andar

Causa casi segura: **el refresh token de Gmail caducó**. El proyecto de Google Cloud está en modo **"Testing"** y ahí los refresh tokens mueren cada 7 días.

1. Confirmar: `select * from net._http_response order by created desc limit 20;` → buscar `invalid_grant`.
2. Chequear también `select * from email_process_logs order by processed_at desc limit 20;`
3. Re-autorizar:
   ```bash
   node scripts/gmail-auth.mjs      # abre el navegador, autorizás
   # copiar el GOOGLE_REFRESH_TOKEN nuevo que imprime al final / queda en .env.local
   ```
   ```sql
   update public.app_secrets set value = '<token nuevo>' where key = 'GOOGLE_REFRESH_TOKEN';
   ```
4. Disparar el poller a mano y verificar que inserte.

**Fix definitivo pendiente:** publicar la app en Google Cloud (OAuth consent screen → "Publicar app" → Producción) para que el token deje de caducar.

### 14.4 Runbook: chequeo de salud

```sql
-- ¿el poller sigue trayendo mails?
select max(processed_at), count(*) filter (where status='ok') from email_process_logs;
-- ¿las cotizaciones están al día?
select max(day) from fx_rates;
-- ¿los crons están activos?
select jobid, jobname, schedule, active from cron.job;
-- ¿coincide el último punto de la serie con el patrimonio de /metricas?
select * from get_networth_series(12) order by month desc limit 1;
select get_metrics();
```

### 14.5 Mantenimiento típico (lo que se le pide al agente)

- "Agregá / corregí / borrá este movimiento" → SQL directo (y `papelera` te cubre si te pasás).
- "Cuadrá el resumen con este PDF del banco" → reconciliación contra `card_statements`.
- "Convertí esta compra a cuotas" → **usar la RPC `convertir_a_cuotas`**, que ya hace el borrar+crear de forma atómica.
- "Cambiá tal pantalla y deployá" → editar, `npm run build`, `railway up`.

---

## 15. Gotchas técnicos

1. **Bug UTC en fechas.** `new Date('YYYY-MM-DD')` parsea como UTC → off-by-one en ART. Parsear siempre local:
   ```ts
   const [y, m, d] = iso.slice(0,10).split('-').map(Number);
   new Date(y, m - 1, d);
   ```
   (Ver `formatShort` en `db.ts` y `parseYMD` en `/tarjetas`.)
2. **⚠️ El MCP de Supabase corre todos los statements de una llamada en UNA transacción.** Si el último falla, se revierte **todo**, incluidos los DELETE/UPDATE previos que "salieron bien". Pasó el 25/07/2026: un `delete` + `insert` donde el insert falló por `user_id` → el delete se deshizo en silencio y quedó doble conteo. **Al hacer borrar+crear, verificá el estado final con un `select` aparte.**
3. **El MCP devuelve solo el resultado del último statement.** Para ver varios, armá una sola query.
4. **`tsconfig.json` excluye `supabase/functions` y `scripts`** (son Deno / standalone y romperían el type-check de Next).
5. **El caché tiene versión.** Si cambiás la forma de un snapshot, bumpeá el prefijo en `lib/cache.ts` o la pantalla pinta NaN hasta que llegue el fetch.
6. **`npm run build` en PowerShell**: el `npm notice` ensucia el output → chequear `$LASTEXITCODE`, no el texto.
7. **Este NO es el Next.js de tu training data** (`AGENTS.md`). El middleware es `proxy.ts`. Leé `node_modules/next/dist/docs/` antes de escribir.
8. **El schema no está versionado en el repo.** No hay carpeta de migraciones: la base es la fuente de verdad. Antes de tocar algo, `list_tables` / `execute_sql`.

---

## 16. Estado actual y backlog

✅ **En producción y funcionando.** Diez módulos, todos operativos con datos reales. Último mail importado: 06/09/2026. Cotizaciones al día.

### Hecho recientemente (últimos commits)

Rediseño "liquid glass" en 5 fases · Divisas con datos reales (se borró el último mock) · alta de reglas como desplegable · registrar un cambio de divisas ahora mueve los saldos · `CountUp` en los números grandes · Gastos hormiga volvió al foco de microgastos · modales despegados del fondo · tarjetas con el diseño nuevo.

### Pendiente, en orden

1. **Fijo vs variable en la proyección.** El enum `tx_nature` existe y /hormiga ya permite marcar suscripciones como fijas. **Falta** que `app/cashflow/page.tsx` lea `nature` para excluir los `fijo` del promedio de gasto variable y sumarlos por su monto real sin inflar.
   ⚠️ El cálculo está **duplicado** en ese archivo (tabla principal y bloque espejo ARS de "Pesos líquidos"): hay que tocar los dos o la fila queda inconsistente. **Test de regresión: los totales de meses pasados no deben cambiar.**
2. **IA analista mensual** (informe + gráficos). Restricción explícita del usuario: **que no gaste tokens leyendo la base**. Alimentarla con datos pre-agregados (`get_metrics` + breakdown), no filas crudas. **El modelo nunca debe emitir cifras**: que devuelva referencias a claves y specs de gráfico (tipo + dataset) que la app resuelve con los componentes de `charts.tsx`.
3. **Repasar botones sin acción** en el resto de las pantallas.
4. **Tarjetas:** revisar los bloques de abajo contra lo que la app tiene hoy.

### Pendientes menores conocidos

- **Pago de resumen no aparece en Transacciones.** El botón funciona (fija el total, marca `is_paid`, baja el saldo) pero no genera un movimiento visible.
- **El asistente no sabe de deudas**: si le decís "X me pagó", lo registra como ingreso suelto en vez de imputarlo a la deuda.
- **`convertir_a_cuotas` no tiene botón.** La RPC existe y funciona; falta el front. Hoy hay que convertir a mano cada compra en cuotas, porque la alerta de Galicia no informa las cuotas.
- **OCR de tickets**: el botón de cámara es un placeholder.
- **Recurrentes**: pantalla `ComingSoon` vacía (aunque la tabla se usa desde Cash Flow).
- **`chat_messages` sin usar**: el historial del asistente no se persiste.
- **Conciliación bancaria**: al 27/07 había ~$87.805 de diferencia entre el saldo de Plata y el extracto de Galicia, por ~15 movimientos del banco nunca cargados (transferencias, débitos automáticos, acreditaciones — el importador solo ve alertas de tarjeta).
- **`USD_ARS = 1455` hardcodeado en el email-poller** para convertir monedas forzadas: debería leer `fx_rate_at`.
- **`inflation-sync` sin secreto** (ver sección 13).

### Discrepancias detectadas entre la documentación vieja y el código real (07/09/2026)

| Dice `CLAUDE.md` / `CONTEXTO_DISENO.md` | Realidad verificada |
|---|---|
| "`get_metrics`: `usd_ars` fijo 1455" | Usa `fx_rate_at('blue', hoy, 'compra')`; 1455/1462 son solo fallback |
| "Acento lima ácido `#c8ff4d`" | El acento es **naranja `#ff9e1b`** desde el rediseño |
| "El bottom nav muestra 4 módulos fijos" | Son **5** (`MOBILE_FIJOS` incluye `/tarjetas`) |
| "Divisas sigue con datos mock" | Ya usa datos reales de `fx_rates`; `lib/mock.ts` fue borrado |
| "`insertExchange` no mueve saldos" | Ya los mueve, vía la RPC `register_exchange` |
| "«Nueva regla» en `/reglas` no funciona" | Funciona, y es un desplegable como se pidió |
| "Gastos hormiga perdió el foco" | Ya se rebalanceó: goteo vs grandes, con exclusión de no-impulso |
| No mencionan `papelera`, `activity_log`, `cashflow_plans` | Existen y están en uso |

---

## 17. Lo que vive en la misma base pero NO es Plata

El proyecto Supabase `dsocdpxlvcufitvovydr` está **compartido con otra aplicación** — un asistente personal por voz (aparece en los comentarios de la base como el canal "PC" / Jarvis). Saberlo evita dos errores: creer que faltan tablas en el repo, y borrar algo pensando que es basura.

**Tablas que no son de Plata:**
- `targets` (6) — alias → destino para una tool "abrir" (app / url / discord), con aprobación manual.
- `tareas_codigo` (2) — tareas de código dictadas por voz, que una PC local reclama y ejecuta con Claude Code (`estado`: borrador → lista → ejecutando → hecha; con `session_id`, `ultimo_latido`, `costo_usd`).
- `pensar_sesiones` (1) y `costos_llamadas` (10) — sesiones y costos de ese asistente.

**Secretos que no son de Plata:** `GCAL_CLIENT_ID/SECRET/REFRESH_TOKEN`, `SPOTIFY_CLIENT_ID/SECRET`, `OPENROUTER_API_KEY`, `PC_CHANNEL_SECRET`.

**Funciones SQL compartidas:** `dividir_gasto`, `pagar_deuda`, `convertir_a_cuotas`, `flujo_de_caja`, `fmt_es_ar` — operan sobre las tablas de Plata pero las llama ese asistente, no este repo. Son código bueno y reutilizable (ver 7.2).

**Además**, la misma organización de Supabase tiene otros dos proyectos sin relación: `Momentum` (inactivo) y `Task Manager`.

---

## Apéndice — Chuleta para arrancar un chat nuevo

> App de finanzas personales **Plata**, mono-usuario, multi-moneda (ARS/USD/USDT), español argentino, en producción.
> **Repo:** `gigli-developer/plata-gigli` · **Live:** https://plata-production.up.railway.app
> **Stack:** Next.js 16 (App Router, middleware = `proxy.ts`) en Railway + Supabase (Postgres 17, Auth, RLS, Edge Functions Deno, pg_cron). Tailwind v4 con `@theme`. Charts SVG a mano.
> **Supabase project ref:** `dsocdpxlvcufitvovydr` (operar con el MCP de Supabase; el schema NO está versionado en el repo).
> **Capa de datos:** todo pasa por `lib/db.ts`. Cotizaciones por `lib/fx.ts` desde la tabla `fx_rates` — nunca hardcodear un dólar.
> **Regla conceptual madre:** flujos (gastos/ingresos ya ocurridos) se valúan con **cotización congelada** (`fx_rate_ars`, la pone un trigger); saldos y compromisos futuros con **cotización viva**.
> **Secretos** en la tabla `app_secrets`, solo legible por las Edge Functions. Nunca en el browser.
> Antes de tocar la base: `list_tables` + leer la sección 6 de `PLATA.md`. Antes de escribir código Next: leer `AGENTS.md`.
