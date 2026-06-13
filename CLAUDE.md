@AGENTS.md

# Plata — App de finanzas personales

App de finanzas personales **mono-usuario**, **multi-moneda (ARS / USD / USDT)**, en **español argentino**. Migrada desde una app vieja en Supabase. En producción en Railway.

- **Live:** https://plata-production.up.railway.app
- **Supabase project_ref:** `dsocdpxlvcufitvovydr`
- **Railway:** proyecto y servicio `plata`. Deploy: `railway up --service plata --ci` (token en `$env:RAILWAY_API_TOKEN`).
- **Usuario:** `giglilangonelucas@gmail.com` (único, Supabase Auth).

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

5. **Multi-moneda.** Cada registro guarda su moneda. Los **totales se valúan en ARS** (USD ×1455, USDT ×1462; cotización editable en Métricas, hoy hardcodeada en varios lados como constante).

6. **`get_metrics`:** `ars_liquido = ingresos_ARS − egresos_ARS_no_credito − resúmenes_pagados`. `te_deben`/`debes` usan el saldo pendiente, valuados en ARS. `usd_ars` fijo 1455, `usdt_ars` = último cambio.

7. **Resúmenes de tarjeta.** El total de cada resumen es **fijo** (reconciliado contra el PDF del banco), no se recalcula. El importador de mails es en tiempo real → la app puede ir **adelantada** al banco. Cierre/vencimiento editables; los nuevos heredan el día por defecto de la tarjeta. Galicia Visa 2811: cierre 25, vence 6.

8. **Asistente IA.** Edge Function `assistant` (modelo `claude-sonnet-4-6`, key en `app_secrets`). Usa **tool use**: interpreta el mensaje y **propone** movimientos (no ejecuta solo). El cliente muestra la propuesta → el usuario **confirma** → se escribe con su sesión (RLS-safe). Pregunta con **opciones** cuando falta un dato. Asume **ARS** salvo que se aclare. Muestra el **costo** de cada consulta. En el Resumen el chat vive **dentro de la barra** (la home se desvanece); en otras páginas es un botón flotante.

9. **Estética.** Fintech oscuro. Bricolage Grotesque (display), Hanken Grotesk (texto), JetBrains Mono (números, clase `.tnum`). Acento lima ácido; **violeta reservado para la IA**.

---

## Estado actual
✅ **En producción y funcionando.** Todas las pantallas principales operativas con datos reales.

### Automatización de emails (importante)
- Edge Function `email-poller` (verify_jwt=false) + **cron pg_cron cada 15 min** (`net.http_post` a la función).
- ⚠️ **El token de Gmail caduca cada 7 días** porque el proyecto de Google Cloud está en modo **"Testing"**. Si el importador deja de andar, revisar `net._http_response` (busca `invalid_grant`). **Re-autorizar:** `node scripts/gmail-auth.mjs` → autorizar en el navegador → copiar el nuevo `GOOGLE_REFRESH_TOKEN` del final de `.env.local` → `update public.app_secrets set value=... where key='GOOGLE_REFRESH_TOKEN'` → disparar el poller.
- **Fix definitivo pendiente:** publicar la app en Google Cloud (OAuth consent → "Publicar app" → Producción) para que el token deje de caducar.

### Pendientes / no construido
- **Generación automática del próximo resumen** (cuando uno cierra, abrir el siguiente). Hoy hay que crearlo a mano o los consumos nuevos quedan sin `statement_id`.
- **Pago de resumen como transacción visible** (hoy solo baja el saldo vía flag `is_paid`; el movimiento no aparece en Transacciones). Diseñado, no construido.
- **El asistente no sabe de deudas**: si le decís "X me pagó", lo registra como ingreso suelto, no como pago de deuda.
- **OCR de tickets** (botón cámara es placeholder), **cotización en vivo** en Divisas (mock), **Recurrentes** (semi-maquetada).
- Mejora del parser: que reconozca comercios nuevos (ej. `ASOCCIVILCEMA`→Educación) automáticamente.

## Gotchas técnicos
- **Bug UTC:** `new Date('YYYY-MM-DD')` parsea como UTC → off-by-one en ART. Parsear local: `const [y,m,d] = iso.slice(0,10).split('-').map(Number); new Date(y, m-1, d)`. (Ver `formatShort` en `db.ts`.)
- **`tsconfig.json`** excluye `supabase/functions` y `scripts` (son Deno/standalone, romperían el type-check de Next).
- **Build:** `npm run build`. En PowerShell el `npm notice` ensucia el output → chequear `$LASTEXITCODE`.
- **Edge Functions** se deployan con el MCP de Supabase (`deploy_edge_function`), no con el repo. Cambios de DB / `get_metrics`: vía `execute_sql` del MCP.
- El MCP devuelve solo el resultado del **último** statement; para ver varios, una sola query.
