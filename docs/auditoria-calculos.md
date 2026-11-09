# Auditoría de cálculos — Fase 1 (2026-11-08)

Objetivo: que cualquier número de Plata salga de **una sola fuente** (funciones de
Postgres) y que Claude, desde claude.ai con el conector de Supabase, obtenga lo mismo
que muestra la app. Este documento es el inventario. **No se cambió nada** (salvo el
CHECK de monedas, que es un arreglo aparte, ver §3.0).

Código auditado: rama `main` (d4e82e4), que es la que coincide con producción. Ojo con
§3.1: hay otra línea de código viva en la base.

---

## 1. Inventario de números

Convenciones que se repiten (las cito por letra en la tabla):

- **[N] Ningún saldo por cuenta.** Plata no tiene cuentas: hay UN pozo por moneda (ARS, USD, USDT). El "medio de pago" es solo una etiqueta del movimiento.
- **[C] Crédito no resta caja.** Un egreso con medio `Tarjeta de Crédito` es deuda hasta que se paga el resumen. Al pagarlo (`card_statements.is_paid`), el `total_ars` congelado resta del saldo ARS y, si `paid_usd`, el `total_usd` resta del USD.
- **[X] Exclusiones de flujo.** Las categorías `Cambio Divisas` y `Préstamos` mueven saldo pero no cuentan como gasto ni ingreso.
- **[F] Cotización congelada.** Los flujos usan `transactions.fx_rate_ars` (el trigger lo setea con blue compra para USD y cripto compra para USDT). Los saldos y los compromisos van a la cotización VIVA (`fx_rate_at(casa, hoy, 'compra')`).
- **[Q] Cuotas.** Viven en `installment_plans`, no en `transactions`. Cuota k del mes = meses entre `first_charge_date` y el mes, más 1. Se suman a gastos y se imputan a Tarjeta de Crédito.
- **[R] Resumen.** Si está PAGADO, total = `total_ars`/`total_usd` congelados. Si NO, total en vivo = consumos linkeados por `statement_id` (sin cuotas) + cuotas del período. Lo que no es ARS se suma como USD.

| # | Número (pantalla) | Dónde se calcula | Tablas | Reglas |
|---|---|---|---|---|
| 1 | **Saldo ARS** (Resumen hero, Divisas, Métricas, Cash Flow arranque) | SQL `get_metrics().ars_liquido` | transactions, payment_methods, card_statements | Σ ingresos ARS (cualquier medio) − Σ egresos ARS **no crédito** (medio NULL cuenta como caja) − Σ `total_ars` de resúmenes pagados. [C] Incluye Préstamos y Cambio Divisas (mueven caja). |
| 2 | **Saldo USD** | `get_metrics().usd_liquido` | ídem | Igual que ARS en USD; resta `total_usd` de los resúmenes con `paid_usd`. |
| 3 | **Saldo USDT** | `get_metrics().usdt_liquido` | transactions | Σ ingresos − Σ egresos USDT, **sin** excluir crédito (asimetría, ver §3.9). |
| 4 | "≈ $" de USD/USDT (Resumen, Divisas) | `page.tsx:234`, `divisas:260` | — | saldo × `get_metrics().usd_ars` / `usdt_ars` (viva). |
| 5 | **Patrimonio neto** (Resumen) | `page.tsx:236` (TS) | — | ars + usd·blue + usdt·cripto + te_deben − deuda_cuotas − deuda_vencida − debes, con las cotizaciones de get_metrics. |
| 6 | **Patrimonio neto + activos/pasivos** (Métricas) | `metricas/page.tsx:47-57` (TS) | — | Misma fórmula que #5, pero con la cotización **editable** de la pantalla. Con el input sin tocar da igual que #5. |
| 7 | Deuda en cuotas (pasivo) | `get_metrics().deuda_cuotas_ars` | installment_plans | Σ cuota × (total − k_hoy + 1). La del mes en curso todavía se debe. |
| 8 | Resúmenes vencidos impagos (pasivo) | `get_metrics().deuda_vencida_ars` | card_statements, transactions, installment_plans | Resúmenes con `not is_paid and due_date < hoy`: consumos linkeados (lo no ARS al **blue**) + cuotas de ese período con k_período < k_hoy. |
| 9 | Te deben / Debés (Resumen, Métricas) | `get_metrics().te_deben/debes` | debts, debt_payments | Deudas `status='pending'`: max(amount − Σ pagos, 0) × cotización viva. |
| 10 | Te deben / Debés (Resumen, tarjeta "Personas") | `page.tsx:207-211` (TS) | debts, debt_payments | Igual que #9, recalculado en TS. |
| 11 | Te deben / Debés por persona y totales (Deudas) | `deudas/page.tsx:50,222,257` (TS) | debts, debt_payments | Igual que #9, pero la cotización sale de `fxSync()` (snapshot local, o fallback 1525/1593). |
| 12 | Serie de patrimonio por mes (Métricas) | SQL `get_networth_series(12)` | todas | Reconstruye #1-#9 al cierre de cada mes con la cotización de ese corte. Invariante: el último punto = #6. |
| 13 | "Tuyo vs por el dólar" y toggle US$ | `metricas/page.tsx:100-123` (TS) | — | Sobre la serie #12. |
| 14 | **Flujo de caja 6 meses** (Resumen, gráfico de barras) | `page.tsx:165-173` (TS) | transactions (últimas **500**) | Por mes **calendario del navegador**: Σ ingresos y Σ egresos [F] **incluyendo crédito** (devengado), [X], **sin cuotas**. Mes de referencia = mes del último movimiento ≤ ahora. |
| 15 | Gastos por categoría del mes (Resumen, dona) | `page.tsx:175-189` (TS) | transactions, installment_plans | Egresos del mes de ref [F] [X] + cuotas activas, **solo si el mes de ref es el actual**. Top 6 + "Resto". |
| 16 | Tarjetas en la home ("Resumen en curso" / "Gasto del mes") | `page.tsx:192-205` (TS) | cards, card_statements, transactions, installment_plans | Débito: Σ egresos del mes con esa tarjeta, **en moneda original sin convertir**. Crédito: cuotas activas + consumos **ARS** del resumen abierto (sin USD). |
| 17 | Ingresos/egresos por mes (Métricas, columnas) | `metricas/page.tsx:150-156` + `fetchMonthlyBreakdown` | transactions | [F] [X], **mes UTC**, sin cuotas. |
| 18 | Gastos por categoría y por método (Métricas) | `metricas/page.tsx:158-172` | transactions, installment_plans | Egresos [F] [X] + cuotas [Q] (al método Tarjeta de Crédito), **mes UTC**, cuota en ARS sin mirar la moneda del plan. |
| 19 | Variación por categoría + estimado fin de mes (Métricas) | `metricas/page.tsx:174-199` | ídem | Mes B vs A; estimado = consumos × días_mes/días_transcurridos + cuotas. |
| 20 | Ratios: DTI, tasa de ahorro, flujo, ahorro (Métricas) | `metricas/page.tsx:59-90` | ídem | DTI = cuotas/ingresos; ahorro = ingresos − (egresos + cuotas). |
| 21 | **Cash Flow** (tabla por categoría, 6 meses, proyección o histórico, base caja o devengado) | `cashflow/page.tsx:79-201` | transactions (14 meses), installment_plans, recurring_templates, cashflow_budgets, cashflow_plans, cashflow_config, inflation_monthly, card_statements | Pasado: real [F] [X], **mes UTC**. Futuro: ingresos = recurrentes (× inflación si es Sueldo o si está tildado: preferencia en **localStorage**); egresos = promedio de los 3 meses cerrados por categoría, pisado por `cashflow_budgets`, × inflación compuesta. Base caja: sin crédito + "Pago de tarjeta" = resúmenes que vencen ese mes [R], o un estimado. Devengado: todo + cuotas. Más los planes manuales. |
| 22 | Saldo acumulado proyectado (Cash Flow) | `cashflow/page.tsx:187-191` | — | Arranca en #1 + #2·usd + #3·usdt (cotización editable) y acumula el neto. El mes 0 no se suma. |
| 23 | **Pesos líquidos** proyectados (Cash Flow) | `cashflow/page.tsx:193-247` | ídem | Copia de #21 solo con filas ARS (usa `total` sin convertir); arranca en #1. Los overrides de presupuesto se suman a los dos promedios. |
| 24 | Total de cada resumen (Tarjetas, historial y "a pagar") | `tarjetas/page.tsx:150` (TS) | card_statements, transactions, installment_plans | [R]. En ARS, más una columna USD aparte. Los resúmenes PROYECTADOS (id<0) suman las suscripciones detectadas. |
| 25 | Monto que se congela al "Pagar resumen" | `tarjetas/page.tsx:152-160` → `payStatement` | card_statements | Guarda el total que se ve en pantalla (#24) + USD. **No crea transacción.** |
| 26 | Gráfico "Totales por mes" y proyección de resúmenes (Tarjetas) | `tarjetas/page.tsx:222-260` + `lib/subs.ts` | ídem + transactions (8 meses) | Real: #24. Futuro: cuotas + suscripciones detectadas (`detectarSubs`, heurística en TS). |
| 27 | Movimientos de un resumen (desplegable) | `tarjetas/page.tsx:520-550` | transactions, installment_plans | Lista + total ARS y USD; ordena valuando USD al `fxSync()`. |
| 28 | Cuotas activas (Tarjetas, home) | `fetchInstallments` (TS) | installment_plans | k = meses desde el primer cobro + 1 (mes local); excluye las terminadas. |
| 29 | Gastos hormiga: umbral p70, goteo, grandes, por mes, comercios, suscripciones y costo anual | `lib/hormiga.ts` | transactions (12 meses, egresos) | Categorías Delivery/Comida/Ocio/Transporte/Compras, sin cuotas, sin suscripciones, sin trámites (regex). [F] Costo anual de una suscripción a cotización viva. **Mes UTC.** |
| 30 | Neto del día (Transacciones) | `transacciones/page.tsx:122` | transactions (últimas 500) | Σ ingresos − Σ egresos **en moneda original, mezclando ARS y USD**. |
| 31 | Cotizaciones (Divisas: tablero, series y promedios) | `fetchFxBoard`, `divisas/page.tsx:320` | fx_rates | Últimos 90 días por casa. |
| 32 | Cambios de moneda (historial) | `fetchExchanges` | currency_exchanges | Lista; el alta va por la RPC `register_exchange` (mueve los saldos con 2 tx "Cambio Divisas"). |
| 33 | Ingresos/egresos "del mes" | `get_metrics().ing_mes_*/egr_mes_*` | transactions, card_statements, installment_plans | **Ninguna pantalla de main lo muestra.** egr_mes = egresos de caja del mes + resumen del período. Mes de ref = mes del último **ingreso** (≠ #14). |

Funciones SQL que ya existen y **no usa la app de main**. Las agregó la rama `agente-en-plata` (ver §3.1):
`flujo_de_caja`, `resumen_mensual`, `total_resumen`, `detalle_resumen`, `cuotas_activas`, `compromisos`, `proyeccion_resumenes`, `suscripciones_tarjeta`, `gastos_hormiga`, `verificar_invariantes`, `salud_sistema`, `consulta_sql_lectura`, `pagar_deuda`, `dividir_gasto(_v2)`, `dividir_movimiento`, `convertir_a_cuotas`, `vincular_deuda`, `aplicar_propuesta`.

---

## 2. Por qué Claude da otro saldo ($10,64M vs $7,81M)

Para el saldo ARS no hay una fórmula intuitiva que dé lo mismo que la app. Hoy:

| Cálculo | Resultado |
|---|---|
| Σ ingresos ARS − Σ egresos ARS (todo) | $8.745.318 |
| ... sin restar los egresos con crédito | $11.012.795 |
| ... y restando los resúmenes pagados (= **app**) | **$7.061.991** |

La diferencia de $2,8M que viste es casi seguro esto. Claude restó los egresos de caja pero no los **resúmenes pagados** ($3,95M al día de hoy), o restó los consumos con crédito en vez de los resúmenes. El pago de un resumen **no es una transacción** (#25), así que leyendo `transactions` no se ve. Esta es la regla [C] y es la que más se pierde.

---

## 3. Inconsistencias encontradas (no corregidas)

**3.0. CLP como USD — CORREGIDO hoy, aparte.** 3 compras de falabella.cl en pesos chilenos se valuaron al dólar blue: −$334M en octubre y patrimonio −$319M. Se pasaron a USD (~950 CLP/USD, aproximado) y se agregó un `CHECK (currency in ('ARS','USD','USDT'))`. El importador acepta cualquier código de 3 letras: ahora esas compras van a fallar y quedan en `email_process_logs` con estado error.

**3.1. Dos versiones de Plata conviven.** La base tiene tablas y funciones de la rama `agente-en-plata` (20 commits, sin mergear a main): `activity_log`, `papelera`, `propuestas`, `rollback_funciones`, `flujo_de_caja`, `resumen_mensual`, etc. Railway se deploya con `railway up` desde una PC, no desde `main`, así que no hay garantía de qué código corre. Las funciones SQL existentes dicen espejar archivos que **no están en main** (`lib/fechas.ts`). Antes de la Fase 4 hay que decidir cuál es la app de referencia.

**3.2. `flujo_de_caja()` (SQL) ≠ Cash Flow de la app.** Usa recurrentes + promedio de 3 meses y no tiene presupuestos, inflación, pago de tarjeta (base caja), planes manuales ni suscripciones. Si Claude la usa, da otros números que la pantalla. No sirve como `q_flujo_caja` así como está.

**3.3. Tres criterios distintos para "el mes".**
- **Mes UTC:** `fetchMonthlyBreakdown` y `fetchExpenseDetail` (Métricas, Cash Flow, Hormiga).
- **Mes del navegador (ART):** el Resumen.
- **Mes ART:** `resumen_mensual` (SQL).

Hoy hay 6 movimientos que cambian de mes según el criterio, entre ellos #1191 Rappi $18.750 (oct en ART, nov en UTC) y #1095 Anthropic USD 5. Por eso Resumen y Métricas pueden dar distinto para el mismo mes.

**3.4. Dos "meses de referencia".** El Resumen toma el mes del último movimiento (hoy: noviembre). `get_metrics.ref_month` toma el del último **ingreso** (hoy: 2026-10), y es lo que muestra el subtítulo de Métricas.

**3.5. El Resumen solo ve los últimos 500 movimientos.** `fetchTransactions(500)`: hoy los últimos 6 meses tienen 483. En pocas semanas el gráfico #14 va a empezar a cortar el primer mes **sin avisar**.

**3.6. Resúmenes vencidos sin marcar como pagados.** 8 resúmenes impagos con vencimiento pasado suman $2,86M de "deuda vencida" en el patrimonio:
- Personal Visa 4091: agosto, septiembre y octubre.
- Personal Amex: agosto, septiembre y octubre (vacíos).
- Platinum Gal y Platinum Amex: octubre (vencieron el 6/11).

Si los pagaste en el banco y no los marcaste, el **saldo ARS está inflado** y el patrimonio desinflado en esa misma plata.

**3.7. Sin saldo inicial en ARS ni USD.** Solo hay "Capital Inicial" en USDT (570,75). El saldo ARS es la suma de flujos desde marzo, no el saldo del banco. Esa es la conciliación pendiente de CLAUDE.md, con unos $87.805 de diferencia al 27/07 por movimientos del banco nunca cargados.

**3.8. Ingreso cargado con tarjeta de crédito.** #568 "Chañar II" $1.171.951 (13/06) tiene medio `Tarjeta de Crédito`. Hoy suma bien a caja (los ingresos no filtran medio), pero cualquier regla que excluya crédito "en general" lo perdería.

**3.9. Asimetrías en `get_metrics`.**
- **USDT:** sus egresos no excluyen crédito, y los de ARS y USD sí. Hoy no hay USDT con crédito.
- **Medio de pago NULL:** cuenta como caja. Son 3 movimientos: #857 ingreso $1,1M, #934 $43.000 y #1002 $6.080.

**3.10. "No ARS = USD" en los resúmenes.** `fetchStatementConsumos`, `vencido` y `total_resumen` suman como USD todo lo que no es ARS. Un consumo en USDT en una tarjeta se valuaría al blue. Con el CHECK nuevo solo queda el caso USDT.

**3.11. Cotización distinta según la pantalla.**
- **Resumen y Métricas:** `get_metrics.usd_ars`.
- **Deudas y Tarjetas:** `fxSync()` (snapshot local o fallback **1525/1593** hardcodeado).
- **Métricas y Cash Flow:** además, la cotización editable.

Con la caché vacía o vieja, Deudas puede dar otro "te deben" que el Resumen.

**3.12. Cuotas sin mirar la moneda en el TS.** `p.monthly` se suma como ARS en Métricas, Cash Flow y Tarjetas, y el SQL multiplica por la cotización. Hoy los 25 planes son ARS: impacto cero.

**3.13. Tarjeta de débito en la home sin convertir.** #16 suma `t.amount` en moneda original. Un consumo de USD 20 con débito suma "20 pesos".

**3.14. Neto del día en Transacciones** (#30): mezcla ARS y USD sin convertir.

**3.15. Deudas `settled` sin pagos.** Hay 2. `get_networth_series` lo resuelve con `settled_at`. `get_metrics` las saca por status, así que da igual hoy, pero cualquier cálculo "amount − pagos" las ve pendientes.

**3.16. Pago de resumen invisible.** No genera transacción (pendiente conocido). **Verificado:** no hay ninguna transacción "pago de tarjeta" cargada a mano, así que **hoy no hay doble descuento**.

**3.17. Totales de resúmenes pagados vs consumos linkeados.** En los resúmenes pagados de Platinum Gal, el total congelado (p. ej. abril $698k) es mucho mayor que los consumos linkeados ($289k). Es esperable porque incluye las cuotas y los consumos anteriores al importador, pero el desglose de esos resúmenes no se puede reconstruir desde las tablas.

**3.18. El tilde de inflación por ingreso vive en localStorage** (`plata.inflIncome`). La proyección del Cash Flow depende del navegador: Claude no puede reproducirla.

**3.19. Las suscripciones detectadas viven solo en TS** (`lib/subs.ts`). Ya hay `suscripciones_tarjeta()` en SQL; habría que confirmar que da lo mismo.

**3.20. Hay reglas solo en el poller.** `rules` las aplica el email-poller (TS en Deno), y una carga manual o por el asistente no pasa por ellas. Para `registrar_movimiento` (Fase 3) habría que mover el motor de reglas a SQL y que el poller use esa misma función.

---

## 4. Plan propuesto (Fases 2-5)

**Principio:** las `q_` replican **exactamente** lo que muestra hoy cada pantalla de main, bugs incluidos (UTC, 500 filas...), para que la Fase 4 dé idéntico y no cambie nada visible. Las inconsistencias de §3 se arreglan después, una por una, con la función como único lugar a tocar.

### Fase 2 — `q_` de solo lectura (SECURITY INVOKER, RLS-safe, `COMMENT ON` con ejemplo)
| Función | Reemplaza | Notas |
|---|---|---|
| `q_saldos()` | #1-#4 | Envuelve `get_metrics` y agrega los "≈ $". |
| `q_patrimonio(p_usd numeric default null, p_usdt numeric default null)` | #5, #6 | Con override de cotización para Métricas. |
| `q_patrimonio_serie(p_meses)` | #12 | Envuelve `get_networth_series`. |
| `q_deudas_personas()` | #9-#11 | Por deuda y por persona; cotización viva de `fx_rates`. |
| `q_flujo_resumen(p_meses default 6)` | #14 | Mes ART, criterio del Resumen. |
| `q_gastos(p_desde, p_hasta, p_categoria default null, p_agrupar text default 'categoria')` | #15, #17-#20 | Con cuotas; agrupa por categoría, método, mes o moneda. |
| `q_resumenes(p_tarjeta default null)` y `q_resumen(p_id)` | #24, #27 | Reutiliza `total_resumen` (coincide con [R]). |
| `q_cuotas()` | #28, #7 | Reutiliza `cuotas_activas` si coincide. |
| `q_tarjetas_home()` | #16 | |
| `q_cashflow(p_modo, p_base, p_desde, p_inflacion, p_infl_por_categoria jsonb)` | #21-#23 | La más grande; hoy `flujo_de_caja` NO coincide (§3.2). |
| `q_hormiga(p_meses, p_umbral default null)` | #29 | Comparar con `gastos_hormiga`. |
| `q_suscripciones(p_meses)` | #26, #29 | Comparar con `suscripciones_tarjeta`. |
| `q_cambios()`, `q_cotizaciones(p_dias)` | #31, #32 | |
| `q_movimientos(p_desde, p_hasta, p_texto, p_limite)` | listas | Para que Claude no lea tablas crudas. |
| `q_catalogo()` | — | Lista las `q_` con su `COMMENT`. |

Cada migración guarda en `rollback_funciones` la definición previa de lo que reemplaza. Van como SQL versionado en `supabase/migrations/`.

### Fase 3 — Escritura
- `registrar_movimiento(tipo, monto, moneda, descripcion, categoria, medio, fecha, tarjeta, persona, ...)`: valida (moneda, monto > 0, categoría y medio existentes, tarjeta de crédito ⇒ resumen abierto), aplica `rules` portadas a SQL, asigna `statement_id`, escribe `activity_log` y devuelve la fila. Transferencias entre monedas = `register_exchange`.
- `registrar_ajuste(moneda, monto, motivo)`: movimiento en la categoría "Ajuste" (nueva), excluida de gastos/ingresos y visible en el saldo.

### Fase 4 — La app lee de las `q_`
Pantalla por pantalla, un commit cada una. Test: un script que corre el cálculo TS actual y la `q_` sobre los mismos datos y compara número por número (tabla de comparación).

### Fase 5 — `docs/claude-plata.md`

---

## 5. Decisiones que necesito antes de seguir
1. **App de referencia:** ¿producción = `main`? ¿Qué pasa con `agente-en-plata` (activity_log, Deshacer, papelera)? La Fase 3 pide `activity_log` "para que funcione Deshacer", pero Deshacer no existe en main.
2. **Mes UTC vs ART (§3.3):** para no cambiar nada visible, cada `q_` replicaría el criterio de su pantalla (dos criterios). Recomiendo unificar todo en ART aunque se muevan esos 6 movimientos de borde.
3. **"Saldo por medio de pago / efectivo":** la app no lo calcula (no hay cuentas, §1 [N]). Una `q_` así sería un número nuevo que no se puede comparar contra nada. ¿Lo agrego igual, marcado como informativo, o lo dejamos para cuando haya cuentas?
4. **Preferencias en localStorage (§3.18):** para que Claude reproduzca el Cash Flow habría que pasarlas a `cashflow_config`. Eso es un cambio chico de comportamiento: la preferencia deja de ser por navegador.
5. **Resúmenes vencidos (§3.6):** ¿están pagados? Si sí, hay que marcarlos (lo hacés vos desde Tarjetas o me pasás los montos).
