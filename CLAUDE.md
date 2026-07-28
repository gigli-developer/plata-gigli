@AGENTS.md

# Plata — App de finanzas personales

App de finanzas personales **mono-usuario**, **multi-moneda (ARS / USD / USDT)**, en **español argentino**. Migrada desde una app vieja en Supabase. En producción en Railway.

- **Live:** https://plata-production.up.railway.app
- **Supabase project_ref:** `dsocdpxlvcufitvovydr`
- **Railway:** proyecto y servicio `plata`. Deploy: `railway up --service plata --ci` (token en `$env:RAILWAY_API_TOKEN`).
- **Usuario:** `giglilangonelucas@gmail.com` (único, Supabase Auth). **Registro bloqueado**: trigger `solo_mi_usuario` en `auth.users` rechaza cualquier alta que no sea esa casilla; el login no ofrece signup. Recuperación de contraseña: botón en /login que manda mail SOLO a esa casilla (hardcodeada) → aterriza en `/auth/reset`.

## Qué hace
Lleva el seguimiento completo de las finanzas de una persona:
- **Saldos en tiempo real** en ARS, USD y USDT + patrimonio neto.
- **Transacciones** (ingresos/egresos) con categorías y métodos de pago.
- **Tarjetas de crédito**: resúmenes (statements), cuotas (installments), consumos.
- **Deudas** por persona (prestar/deber), con pagos parciales e historial.
- **Cash Flow** proyectado a 6 meses.
- **Métricas**: patrimonio, ratios, gráficos por categoría/método, variación mes a mes.
- **Automatización**: importa consumos de tarjeta leyendo las alertas de Gmail.
- **Asistente IA**: cargás gastos en lenguaje natural (o por voz) y Claude los registra.

---

## Stack
- **Next.js 16** (App Router, Turbopack). ⚠️ Versión con breaking changes — ver `AGENTS.md`. El middleware se llama `proxy.ts`. Docs en `node_modules/next/dist/docs/`.
- **Supabase**: Postgres + Auth + Edge Functions (Deno) + RLS + pg_cron + pg_net.
- **Tailwind v4** (config CSS con `@theme` en `app/globals.css`).
- **Deploy**: Railway (Nixpacks/railpack, Node 22). `.railwayignore` excluye `node_modules`/`.next`.
- Sin librerías de charts: todos los gráficos son **SVG hechos a mano**.

## Estructura de archivos
```
finanzas-app/
├─ app/
│  ├─ page.tsx              Dashboard "Resumen" (+ función compute() con toda la lógica de la home)
│  ├─ metricas/page.tsx     KPIs + gráficos (categoría, método, variación, ingresos vs egresos)
│  ├─ cashflow/page.tsx     Proyección a 6 meses + panel de supuestos editable
│  ├─ tarjetas/page.tsx     Tarjetas, resúmenes, "ver movimientos", cuotas
│  ├─ deudas/page.tsx       Deudas por persona, pagos parciales, historial, alta de persona
│  ├─ transacciones/ divisas/ recurrentes/ login/
│  ├─ icons.tsx             Íconos SVG a mano
│  ├─ globals.css           Design tokens (@theme) + clases (.panel, .ai-glow, .rise, .tnum…)
│  └─ components/
│     ├─ Shell.tsx          Layout + nav + monta <Assistant/>
│     ├─ charts.tsx         Donut, BarList, GroupedColumns, VariationTable
│     ├─ assistantChat.tsx  Hook useAssistantChat (lógica del chat) + MessageList + ProposalCard
│     ├─ Assistant.tsx      Asistente flotante (modal) para páginas que no son Resumen
│     ├─ useDictation.ts    Dictado por voz (Web Speech API, corta a 3s de silencio y envía)
│     └─ Edit*Modal.tsx     Modales de edición (Tx, Plan de cuotas, Fechas de resumen)
├─ lib/
│  ├─ db.ts                 CAPA DE DATOS CENTRAL (todos los fetch/insert/update + tipos)
│  ├─ format.ts             ars(), usd(), compact()
│  └─ supabase/             clientes browser/server (@supabase/ssr)
├─ supabase/functions/
│  └─ assistant/index.ts    Edge Function del asistente IA (Claude tool-use)
│     (email-poller NO está en el repo: se deployó vía MCP)
├─ scripts/gmail-*.mjs      OAuth de Gmail + scripts del poller
└─ .env.local              NEXT_PUBLIC_SUPABASE_*, GOOGLE_* (Gmail). Secrets server-side en app_secrets.
```

## Base de datos (schema `public`, todas con RLS `owner_all` = `user_id = auth.uid()`)
`transactions`, `categories`, `payment_methods`, `cards`, `card_statements`, `installment_plans`,
`debts`, `debt_payments`, `persons`, `currency_exchanges`, `recurring_templates`,
`cashflow_budgets`, `cashflow_config`, `app_secrets`, `profiles`, `chat_messages`, `email_process_logs`.
- **`legacy`** schema = backup de la app vieja (NO expuesto por la API; resuelve los warnings de RLS).
- **RPC `get_metrics()`** = calcula saldos líquidos, patrimonio, te_deben/debes, gastos/ingresos del mes.
- **Secrets** (Gmail token, ANTHROPIC_API_KEY, etc.) viven en la tabla `app_secrets`, leídos solo por las Edge Functions. Nunca en el browser.

---

## Decisiones de diseño (las importantes)

1. **Devengado vs caja.** "Gastos por categoría" = devengado (cuando consumís o cae la cuota). "Saldo líquido" = caja. Los consumos con **crédito NO restan del saldo** hasta que pagás el resumen (son deuda). Para no contar doble.

2. **Consumos vs cuotas.** Los consumos sueltos viven en `transactions` (linkeados a su resumen vía `statement_id`). Las **cuotas viven en `installment_plans`** (NO son transacciones — se borraron las cuota-transacciones para no duplicar). Ambos se suman en "gastos por categoría" y en "método de pago" (las cuotas → Tarjeta de Crédito).

3. **Préstamos en efectivo (deudas `cash`/`split`).** Crean una transacción categoría **"Préstamos"** (visible, mueve el saldo) pero **excluida de las métricas de gasto/ingreso** (igual que "Cambio Divisas"). Prestar = egreso; te pagan = ingreso. El **patrimonio neto no cambia** (cambiás efectivo por "te deben"). Las `in_kind` no mueven saldo al crearse, pero sí al cobrarse en plata.

4. **Pagos de deuda.** Tabla `debt_payments` aparte — **nunca se modifica el monto original**. Saldo pendiente = `amount − Σ pagos`. Hay pagos parciales (botón "Pago") y saldar total.

5. **Multi-moneda.** Cada registro guarda su moneda. Los **totales se valúan en ARS**. **Fuente única de cotizaciones: tabla `fx_rates`** (day, casa, compra, venta), sincronizada cada hora por la Edge Function **`fx-sync`** desde dolarapi.com (cron `fx-sync`, mismo header `x-poller-secret`). Histórico completo desde 2011 (28.500 filas, backfill de argentinadatos vía `?backfill=1`). **USD se valúa a `blue` COMPRA** (precio real al que convertís billetes) y **USDT a `cripto` COMPRA** (tiene ~4% de spread propio). En SQL se lee con `fx_rate_at(casa, fecha, lado)` — resuelve fines de semana y feriados tomando el último día ≤ fecha. En el front: `lib/fx.ts` (`fxSync()` síncrono + `loadFx()`); `get_metrics` devuelve `usd_ars`/`usdt_ars` ya resueltos. **Ningún archivo debe volver a hardcodear 1455/1462.**

5b. **Cotización congelada (flujos) vs viva (saldos).** `transactions.fx_rate_ars` guarda la cotización del día del movimiento (blue compra para USD, cripto compra para USDT). La setea el **trigger `trg_tx_freeze_fx`** (BEFORE INSERT OR UPDATE, función `public.tx_freeze_fx`), que cubre TODO camino de escritura — app, asistente, email-poller, SQL a mano — y recalcula si en un update cambia la moneda o el día. En ARS queda NULL.
   - **Flujos** (gastos/ingresos ya ocurridos) → **cotización congelada**: `arsDe(amount, currency, fxRate, fx)` para filas sueltas y `aggArs(agg, fx)` para los agregados de `fetchMonthlyBreakdown` (que trae `totalArs` = parte congelada y `totalPend` = lo que quedó sin rate). Aplica en `/`, `/metricas`, `/cashflow` y `/hormiga`. Objetivo: que abril quede valuado como abril y los meses cerrados no se muevan cuando cambia el dólar.
   - **Saldos y compromisos a futuro** → **cotización viva** (`toArs`): saldo USD/USDT y patrimonio (`get_metrics` devuelve los saldos SIN valuar, en su moneda), deudas pendientes (`/deudas`), consumos de un resumen sin pagar (`/tarjetas`) y el costo anual proyectado de una suscripción (`/hormiga`). Tener USD 1.000 vale el dólar de hoy, no el del día que entraron.
   - El input editable de cotización en `/metricas` y `/cashflow` ya **no** mueve los meses históricos (es lo buscado): sigue mandando en saldos y proyecciones.
   - `card_statements` y `debt_payments` tienen su propio rate congelado (al PAGAR, no al consumir): un resumen pagado saldó sus USD al dólar de ese día. Un resumen **sin pagar** sigue en vivo — todavía es deuda en dólares.
   - ⚠️ El caché de `lib/cache.ts` está en **v2** por este cambio de forma. Si volvés a cambiar la forma de un snapshot, bumpeá el prefijo o el snapshot viejo pinta NaN hasta que llegue el fetch.

5c. **Patrimonio neto en el tiempo** (RPC `get_networth_series(p_months)`, 2026-07-27). Reconstruye, para el cierre de cada mes, los mismos componentes que `get_metrics()` calcula para hoy: saldos por moneda, te deben / debés, cuotas pendientes y resúmenes pagados **a esa fecha**.
   - Las tenencias se valúan con la cotización **vigente a cada corte** (`fx_rate_at(casa, cutoff, 'compra')`), NO con la congelada del movimiento: son stocks. La congelada es solo para flujos (ver 5b). Este es el otro uso del histórico de `fx_rates`.
   - **Invariante de regresión: el último punto de la serie debe dar igual que el patrimonio de `/metricas`.** Al 27/07/2026 ambos dan $14.729.456. Si tocás `get_metrics` o la RPC, volvé a chequear que coincidan.
   - Tres cosas que costaron y no hay que volver a romper: (a) las cuotas usan `total - k` (la del mes en curso TODAVÍA se debe, el resumen se paga al mes siguiente) — con `total - k - 1` la serie quedaba $117.056 abajo; (b) una deuda `settled` **sin pagos registrados** (pasa: hay 2 así) tiene que mirar `settled_at`, si no queda pendiente para siempre; (c) la serie arranca en el mes de la primera transacción, porque antes los meses previos mostraban solo los planes de cuotas heredados y daban patrimonio negativo falso.
   - En `/metricas` se muestra con `NetWorthChart` (charts.tsx): columnas apiladas de activos hacia arriba, pasivos hacia abajo y la línea del neto encima. **El contenedor NO lleva `gap`** a propósito: así el centro de cada columna cae en `(i+0.5)/n` y la línea queda alineada. Los puntos son divs absolutos, no `<circle>`: el SVG usa `preserveAspectRatio="none"` y los círculos se verían como elipses.
   - Arriba del gráfico se descompone la variación del mes en **"tuyo" vs "por el dólar"**: el efecto cambiario se mide sobre las tenencias con las que arrancó el mes (`usd_prev * Δusd_ars + usdt_prev * Δusdt_ars`) y el resto es flujo.
   - **Toggle $ / US$** (default pesos). En dólares se divide cada punto por el blue **de su propio corte** (no por el de hoy): así cada mes queda medido con la vara de su momento. La descomposición se invierte y pasa a ser "lo que te costó tener PESOS": `ars_prev * (1/usd_ars_cur − 1/usd_ars_prev)`, que da negativo cuando el dólar sube. Julio 2026: +13% en pesos pero +10% en dólares, y US$ 85 perdidos por estar en pesos.

6. **`get_metrics`:** `ars_liquido = ingresos_ARS − egresos_ARS_no_credito − resúmenes_pagados`. `te_deben`/`debes` usan el saldo pendiente, valuados en ARS. `usd_ars` fijo 1455, `usdt_ars` = último cambio.

7. **Resúmenes de tarjeta.** Total **PAGADO = fijo** (se congela al pagar, reconciliable contra el PDF del banco); **NO pagado = en vivo** (consumos linkeados + cuotas del período) — nunca usar el guardado de un resumen sin pagar (queda stale, a veces $0). El importador de mails es en tiempo real → la app puede ir **adelantada** al banco. Cierre/vencimiento editables; los nuevos heredan el día por defecto de la tarjeta. Galicia Visa 2811: cierre 25, vence 6. **Auto-generación del próximo resumen**: `ensureNextStatements` (db.ts, corre al cargar/recargar Tarjetas) y el `email-poller` (si no hay resumen abierto al importar) crean la fila siguiente; índice único `(card_id, period_label)` evita duplicados.

7b. **Proyección de resúmenes futuros = cuotas + suscripciones** (`lib/subs.ts`, 2026-07-27). Antes un mes futuro mostraba solo las cuotas y quedaba en ~$0 aunque todos los meses caen Spotify, HBO, Apple y compañía.
   - `fetchCardCharges` trae los consumos con tarjeta (8 meses, sin cuotas) y `detectarSubs` agrupa por (tarjeta, comercio normalizado, moneda) **por mes**. Entra un comercio si lo marcaste `fijo` en /hormiga, o si cumple las tres: (1) 3 meses con monto dentro de ±25% de la mediana — 2 si el nombre delata suscripción; (2) ≤1,5 cobros por mes; (3) último cobro dentro de los últimos 2 meses.
   - El criterio (2) es el que salva todo: AUSA (peajes) aparece 8,75 veces por mes y Rappi 5,25 — sin él entrarían como "abono". El (1) usa mediana con tolerancia porque las suscripciones en USD varían (Spotify 2,27 → 2,42) y porque Apple mezcla el abono con compras sueltas de US$ 0,39.
   - ⚠️ **Solo se suman a resúmenes PROYECTADOS (`id < 0`)**. En un resumen real (en curso o cerrado) los consumos entran por el importador de mails; sumarles la proyección los contaría dos veces.
   - Limitación conocida: si el comercio cambia de nombre entre meses (ANTHROPIC* CLAUDE SUB / CLAUDE.AI SUBSCRIPTION / ANTHROPIC, o GOOGLE *GOOGLE ONE / GOOGLE *GOOGLE O) cada variante cuenta por separado y ninguna llega al mínimo. Solución para el usuario: marcarla `fijo` en /hormiga.

8. **Asistente IA.** ⚠️ El **botón flotante fue eliminado** (2026-07-27, pedido del usuario) junto con `components/Assistant.tsx`: el asistente vive SOLO en la barra del Resumen. Edge Function `assistant` (modelo `claude-sonnet-4-6`, key en `app_secrets`). Usa **tool use**: interpreta el mensaje y **propone** movimientos (no ejecuta solo). El cliente muestra la propuesta → el usuario **confirma** → se escribe con su sesión (RLS-safe). Pregunta con **opciones** cuando falta un dato. Asume **ARS** salvo que se aclare. Muestra el **costo** de cada consulta. En el Resumen el chat vive **dentro de la barra** (la home se desvanece); en otras páginas es un botón flotante.

9b. **Mobile.** El alto del bottom nav vive en `--nav-h` / `--nav-safe` (globals.css) — **una sola fuente de verdad**: el `main` usa `.pb-nav` y el FAB del asistente `bottom-[calc(var(--nav-safe)+1rem)]`. Si cambia el nav, no hay números mágicos que sincronizar. El bottom nav muestra 4 módulos fijos (`MOBILE_FIJOS` en Shell.tsx) + botón "Más" que abre `MoreSheet` con el resto. El teclado se resuelve con `interactiveWidget: "resizes-content"` en el `viewport` de layout.tsx. Los modales usan `flex + overflow-y-auto` (no `grid place-items-center`) para poder scrollear con el teclado abierto.

9. **Estética.** Fintech oscuro. Bricolage Grotesque (display), Hanken Grotesk (texto), JetBrains Mono (números, clase `.tnum`). Acento lima ácido; **violeta reservado para la IA**.

10. **Reglas de consumos** (`/reglas`, tabla `rules`, las aplica solo el `email-poller` a consumos nuevos). Condiciones combinables: texto (contiene/empieza/igual), horario (soporta rango nocturno 22→2), días, rango de monto. Acciones combinables: recategorizar (`category_id`, nullable), renombrar (`rename_to`), forzar moneda (`set_currency`: **convierte el monto** con USD_ARS=1455 — la alerta de Galicia SIEMPRE reporta el equivalente en pesos, ej. TACTIQ $6.000 → USD 4,11; re-etiquetar sin convertir sería un desastre). **Semántica de merge por campo**: se evalúan todas (prioridad desc, id asc) contra la descripción ORIGINAL; cada acción la define la primera regla que la tenga (pueden ser reglas distintas). El dup-check del poller NO filtra por moneda (una moneda forzada colaría duplicados).

---

## Estado actual
✅ **En producción y funcionando.** Todas las pantallas principales operativas con datos reales.

**Módulos (10):** Resumen `/` · Métricas `/metricas` · **Gastos hormiga `/hormiga`** · Cash Flow `/cashflow` · Transacciones · Tarjetas · Deudas · Recurrentes (vacía) · Divisas (mock) · Reglas. Login `/login` y recuperación `/auth/reset` van sin shell.

**Gastos hormiga** (`/hormiga`, `lib/hormiga.ts`): mide el gasto **evitable**, no el chico. Entra todo Delivery/Comida/Ocio/Transporte/Compras **sin filtrar por monto** (una cena de $30.000 es más recortable que un café de $4.000). El umbral (percentil 70 auto-calibrado) NO excluye: solo separa "goteo" de "consumos grandes". Quedan afuera cuotas y suscripciones. Las suscripciones se detectan por comercio+monto repetido en 3 meses (o 2 si el nombre lo delata) y desde ahí se marcan como `nature='fijo'`.

### Automatización de emails (importante)
- Edge Function `email-poller` (verify_jwt=false) + **cron pg_cron cada 15 min** (`net.http_post` a la función). **Auth**: la función exige el header `x-poller-secret` == `app_secrets.POLLER_SECRET`; el cron (job 1) lo manda. Sin ese header devuelve 401. Si redeployás el poller, mantené el chequeo.
- ⚠️ **El token de Gmail caduca cada 7 días** porque el proyecto de Google Cloud está en modo **"Testing"**. Si el importador deja de andar, revisar `net._http_response` (busca `invalid_grant`). **Re-autorizar:** `node scripts/gmail-auth.mjs` → autorizar en el navegador → copiar el nuevo `GOOGLE_REFRESH_TOKEN` del final de `.env.local` → `update public.app_secrets set value=... where key='GOOGLE_REFRESH_TOKEN'` → disparar el poller.
- **Fix definitivo pendiente:** publicar la app en Google Cloud (OAuth consent → "Publicar app" → Producción) para que el token deje de caducar.

### Backlog vigente (orden acordado con el usuario, 2026-07-26)
Los 4 primeros items del backlog original YA ESTÁN HECHOS: alta/edición de tarjetas, mobile (bottom nav + teclado), cotizaciones reales y la pantalla de Gastos hormiga.

**Lo que sigue, en orden:**
1. ✅ **Congelar el histórico de cotizaciones — HECHO (2026-07-26), completo.** Tres tablas, tres triggers (ver decisión 5b):
   - `transactions.fx_rate_ars` + `trg_tx_freeze_fx` + backfill de las 36 filas no-ARS. Abril bajó $850.500 en ingresos y $18.727 en egresos; julio casi no se movió.
   - `card_statements.fx_rate_ars` + `paid_at` + `trg_stmt_freeze_fx`: congela el blue al marcar pagado y **limpia ambos campos si se revierte el pago** (el total vuelve a calcularse en vivo). Backfill de los 8 pagados usando `due_date` como fecha de pago — **no había registro del pago real**, es una aproximación. Afecta la fila "Pago de tarjeta" del cashflow en base Caja: −22.136 (abr), −20.167 (may), −18.225 (jun), −2.536 (jul).
   - `debt_payments.fx_rate_ars` + `trg_debt_payment_freeze_fx` (lee la moneda de `debts`). **Impacto numérico cero hoy**: los 2 pagos existentes son en ARS. Es preventivo.
2. **Fijo vs variable en la proyección.** El enum `tx_nature` YA existe (`fijo|variable`) y la pantalla /hormiga ya permite marcar suscripciones como fijas. **Falta**: que `app/cashflow/page.tsx` lea `nature` → excluir los `fijo` del promedio de gasto variable (`seed`/`seedCash`, ~L85-91) y sumarlos por su monto real sin inflar. ⚠️ El cálculo está DUPLICADO en ese archivo (tabla principal ~L127-201 y bloque espejo ARS de "Pesos líquidos" ~L204-248): hay que tocar los dos o la fila queda inconsistente. Test de regresión: los totales de meses PASADOS no deben cambiar.
3. **IA analista mensual** (informe + gráficos). Restricción del usuario: **que no gaste tokens leyendo la base**; alimentarla con datos pre-agregados (get_metrics + breakdown), no filas crudas. El modelo NUNCA debe emitir cifras: que devuelva referencias a claves y specs de gráfico (tipo+dataset) que la app resuelve con los componentes de `charts.tsx`. Diseño detallado en el informe de agentes (ver más abajo).

**Planteado por el usuario el 2026-07-27 (sin resolver):**
- **Gastos hormiga perdió el foco.** Le entra nafta y consumos grandes porque el criterio es "evitable, sin filtrar por monto". Al usuario le servía más cuando analizaba **microgastos**. Hay que repensar la pantalla — probablemente volver a poner el ticket chico en el centro, con los consumos grandes como contexto y no como parte del total.
- **Completar acciones que faltan**: "Nueva regla" en `/reglas` no funciona (y el usuario prefiere un **desplegable** antes que el formulario al costado). Repasar botones sin acción en el resto de las pantallas.
- Tarjetas: revisar el resto de la pantalla (bloques de abajo) contra lo que la app tiene hoy.

**Otros pendientes menores:**
- **Pago de resumen como transacción visible**: el botón "Pagar resumen" funciona (fija el total + `is_paid`, baja el saldo), pero el movimiento no aparece en Transacciones.
- **`insertExchange` no mueve saldos**: registrar un cambio en /divisas solo escribe `currency_exchanges`, no genera las transacciones "Cambio Divisas". Por eso una compra de dólares no impacta el balance.
- **Divisas sigue con datos mock** (`lib/mock.ts`: liveQuotes, fxHoldings, fxTrend) aunque `fx_rates` ya tiene todo lo necesario para reemplazarlos.
- **El asistente no sabe de deudas**: si le decís "X me pagó", lo registra como ingreso suelto.
- **OCR de tickets** (botón cámara es placeholder), **Recurrentes** (pantalla `ComingSoon` vacía).
- El importador **no puede detectar cuotas**: la alerta de Galicia no trae ese dato (verificado). Toda compra en cuotas entra como pago único y hay que convertirla a mano (borrar la transaction + crear el `installment_plan`). Mejora posible: un botón "convertir a cuotas" en la UI.
- **Conciliación bancaria pendiente**: al 27/07 había ~$87.805 de diferencia entre el saldo de Plata y el extracto de Galicia, por ~15 movimientos del banco nunca cargados (transferencias, débitos automáticos, acreditaciones — el importador solo ve alertas de tarjeta).

## Gotchas técnicos
- **Bug UTC:** `new Date('YYYY-MM-DD')` parsea como UTC → off-by-one en ART. Parsear local: `const [y,m,d] = iso.slice(0,10).split('-').map(Number); new Date(y, m-1, d)`. (Ver `formatShort` en `db.ts`.)
- **`tsconfig.json`** excluye `supabase/functions` y `scripts` (son Deno/standalone, romperían el type-check de Next).
- **Build:** `npm run build`. En PowerShell el `npm notice` ensucia el output → chequear `$LASTEXITCODE`.
- **Edge Functions** se deployan con el MCP de Supabase (`deploy_edge_function`), no con el repo. Cambios de DB / `get_metrics`: vía `execute_sql` del MCP.
- El MCP devuelve solo el resultado del **último** statement; para ver varios, una sola query.
- ⚠️ **El MCP corre todos los statements de una llamada en UNA transacción**: si el último falla, se revierte TODO (incluidos los DELETE/UPDATE previos que "salieron bien"). Pasó el 2026-07-25: un `delete` + `insert` donde el insert falló por `user_id` → el delete se deshizo en silencio y quedó doble conteo. Al convertir un consumo en plan de cuotas (o cualquier borrar+crear), verificar el estado final con un `select` aparte.
