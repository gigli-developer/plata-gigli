# Plata — Contexto completo para diseño

> Documento de referencia para trabajar en el diseño de **Plata**, una app de finanzas personales. Pegá este archivo entero al inicio de la conversación con Claude Design (además de dar acceso al repo `gigli-developer/plata`) para que tenga contexto completo de qué existe, cómo funciona cada pantalla y qué reglas de negocio hay detrás de cada número. El repo por sí solo no alcanza porque Claude Design no navega automáticamente todos los archivos — este documento resume la app entera en un solo lugar.
>
> **Actualizado: 27/07/2026.** ⚠️ Si el repo de GitHub está más atrasado que esta fecha, este documento manda: describe lo que hay hoy en producción.

---

## 1. Qué es Plata

App de finanzas personales **mono-usuario** (un solo usuario, sin multi-tenant), **multi-moneda** (ARS / USD / USDT), en **español argentino**. En producción, uso diario real (no es un demo/mock).

Lleva el seguimiento completo de las finanzas de una persona: saldos en tiempo real, transacciones, tarjetas de crédito con resúmenes y cuotas, deudas entre personas, proyección de cash flow a 6 meses, métricas y ratios financieros, reglas de auto-categorización, y un asistente con IA que registra gastos por texto o voz.

**Live:** https://plata-production.up.railway.app

---

## 2. Stack técnico

- **Next.js 16** (App Router, Turbopack). Cliente ("use client") en casi todas las páginas — es una SPA con fetch a Supabase desde el navegador.
- **Supabase**: Postgres + Auth + Edge Functions (Deno) + RLS (Row Level Security) + pg_cron.
- **Tailwind v4** — design tokens vía `@theme` en `app/globals.css` (no hay `tailwind.config.js` tradicional).
- **Sin librerías de gráficos**: todos los charts son **SVG hechos a mano** (`app/components/charts.tsx`).
- Deploy en **Railway**. Base de datos y Edge Functions en **Supabase**.
- Sin librería de componentes UI (no shadcn, no MUI) — todo es HTML + Tailwind a medida.

---

## 3. Sistema de diseño visual

**Estética:** fintech oscuro, denso en información, con un acento de IA bien diferenciado del resto.

### Tipografía
- **Bricolage Grotesque** — display/títulos (clase `font-display`)
- **Hanken Grotesk** — texto de cuerpo (default)
- **JetBrains Mono** — TODOS los números financieros, vía clase `.tnum` (alinea dígitos, look "terminal")

### Colores (dark mode, valores reales usados en el código)
- Fondo/superficies: `--color-bg` (negro/casi negro), `--color-surface`, `--color-surface-2`, `--color-surface-3` (progresivamente más claras), `--color-line` (bordes sutiles)
- Texto: `--color-fg` (blanco), `--color-muted`, `--color-faint` (grises descendentes)
- **Lima ácido** `#c8ff4d` — acento principal de marca/CTA (botones primarios, activo en nav)
- **Violeta** `#a78bfa` — **reservado exclusivamente para el Asistente IA** (nunca se usa en otro contexto)
- **Esmeralda** `#34e1a0` — positivo/ingresos/dinero a favor
- **Cielo** `#5ec8ff` — informativo/secundario
- **Coral** — negativo/egresos/error/deuda
- **Ámbar** — advertencia/USD/pendiente

### Componentes CSS reutilizables (clases custom en globals.css)
- `.panel` — contenedor tipo card (base de casi toda la UI): fondo surface, borde `.line`, radio grande
- `.panel-hover` — eleva y resalta borde al hover
- `.chip` — pill button para sugerencias rápidas
- `.tnum` — tipografía monoespaciada para números
- `.ai-glow` — halo con borde degradé violeta/celeste, marca visualmente todo lo relacionado al asistente (barra de IA en Resumen y formulario de login). **Sin animación** (se sacó un giro constante que tenía antes por consumo de batería/CPU innecesario).
- `.rise` — entrada escalonada (fade + translateY) para secciones al cargar
- `.page-enter` — transición de opacidad al cambiar de pestaña (aplicada en el layout por `key={pathname}`). Solo opacidad, nunca transform — un transform en el wrapper rompe el `position:fixed` de los modales.
- `.grow-bar` — animación de "crecimiento" para barras de gráficos
- `.pulse-dot` — punto pulsante (indicadores "en vivo", notificaciones)
- Modo privacidad: `.privacy .tnum { filter: blur(8px) }` — difumina todos los números cuando está activo

### Responsive
- **Desktop (lg+)**: sidebar fija a la izquierda (256px) con logo, los 10 items de navegación, y footer con "Configuración" + tarjeta de usuario/logout.
- **Mobile**: barra superior compacta (logo + toggle privacidad + campana + avatar) + **bottom nav fijo con 4 módulos** (`MOBILE_FIJOS`: Resumen, Gastos hormiga, Transacciones, Tarjetas) **+ un botón "Más"** que abre `MoreSheet`, una hoja con el resto. Ya no hay pantallas inalcanzables desde mobile.
- El alto del bottom nav vive en las variables CSS `--nav-h` / `--nav-safe` (una sola fuente de verdad): el `main` usa `.pb-nav`. El teclado se resuelve con `interactiveWidget: "resizes-content"` en el viewport. Los modales usan `flex + overflow-y-auto` (no `grid place-items-center`) para poder scrollear con el teclado abierto.
- **No hay botón flotante de asistente.** Se eliminó (27/07/2026): la IA vive **solo** en la barra del Resumen.

---

## 4. Navegación (10 módulos)

Definidos en `app/components/Shell.tsx`, en este orden:

| # | Label | Ruta | Ícono | En bottom nav mobile |
|---|-------|------|-------|---|
| 1 | Resumen | `/` | Grid | ✅ |
| 2 | Métricas | `/metricas` | Chart | — |
| 3 | Gastos hormiga | `/hormiga` | Bug | ✅ |
| 4 | Cash Flow | `/cashflow` | Flow | — |
| 5 | Transacciones | `/transacciones` | Swap | ✅ |
| 6 | Tarjetas | `/tarjetas` | Card | ✅ |
| 7 | Deudas | `/deudas` | Handshake | — |
| 8 | Recurrentes | `/recurrentes` | Repeat | — |
| 9 | Divisas | `/divisas` | Coins | — |
| 10 | Reglas | `/reglas` | Tag | — |

Los que no están en el bottom nav se llegan por el botón **"Más"** (`MoreSheet`).

Además: `/login` (sin sidebar/nav) y `/auth/reset` (recuperación de contraseña, sin sidebar/nav).

---

## 5. Módulos en detalle

### 5.1 Resumen (`/`, home / dashboard)

Es la pantalla de entrada. Layout de 3 columnas en desktop (2/3 + 1/3), apilado en mobile.

**Header** (solo desktop): saludo + "Tu resumen" + toggle de privacidad + botón buscar + campana de notificaciones (con punto rojo pulsante, es decorativo hoy).

**Barra del Asistente (AI command bar)** — la pieza más particular de la UI:
- Un input tipo "command bar" con borde `.ai-glow`, ícono de sparkle violeta y label "Asistente".
- Placeholder invita a escribir o dictar un gasto: *"gasté 5.600 en café"*.
- 3 chips de ejemplo debajo (solo si el chat no está activo): *"Gasté 18.500 en delivery con la Galicia"*, *"¿Cuánto gasté en Compras este mes?"*, *"Cobré el alquiler de Chañar II"*.
- Botones: cámara (OCR de tickets — **placeholder, no funcional**), micrófono (dictado por voz, corta y envía solo a los 3s de silencio), enviar.
- Al mandar un mensaje, **el chat se despliega DENTRO de la misma barra** (no es un modal) — la lista de mensajes crece hacia abajo, aparece un botón "Cerrar", y **todo el resto del dashboard se desvanece** (opacity + max-height a 0) mientras el chat está activo. Es un efecto de transición marcado, a propósito.
- El asistente puede **proponer** transacciones o deudas (nunca las ejecuta solo); el usuario ve una tarjeta de propuesta y la confirma antes de que se guarde.

**Cuando el chat NO está activo, se ve el dashboard completo:**

Columna izquierda (2/3):
- **Saldos actuales** (`SaldosHero`): monto grande en pesos (font-display 4xl/5xl) + 3 stat-cards chicas: Dólares, USDT, Patrimonio neto (todo valuado en ARS con las cotizaciones de `get_metrics`).
- **Flujo de caja**: barras agrupadas ingresos (esmeralda) vs egresos (coral) de los **últimos 6 meses**, con leyenda. Excluye "Préstamos" y "Cambio Divisas" (no son gasto/ingreso real).
- **Movimientos recientes**: últimas 6 transacciones con emoji, descripción, fecha/método/tarjeta, tag de origen (OCR/Email/Chat/Manual) y monto. Link "Ver todo" → Transacciones.

Columna derecha (1/3):
- **Gastos por categoría**: donut chart (conic-gradient CSS puro) + lista top 5 categorías del mes, con las cuotas de tarjeta sumadas a su categoría real (ej. Kennedy → Educación) cuando el mes de referencia es el actual.
- **Tarjetas**: mini-cards de cada tarjeta con gasto del mes/resumen en curso y barra de uso del límite. Link a `/tarjetas`.
- **Sin categorizar**: transacciones egreso en categoría "Otros" — permite recategorizar **inline** con un select, sin salir de la pantalla. Si no hay ninguna, muestra "¡Todo categorizado! ✅".
- **Deudas**: resumen "Te deben" / "Debés" + hasta 3 personas con saldo pendiente.

Todo el dashboard usa **caché local (stale-while-revalidate)**: al entrar se pinta al instante el último snapshot guardado en `localStorage`, y por atrás se refresca con datos frescos de Supabase.

---

### 5.2 Transacciones (`/transacciones`)

Listado completo y carga manual de movimientos.

**4 stat-cards arriba**: Ingresos, Egresos, Balance, Cantidad de movimientos (todos recalculados según los filtros activos, no son totales globales fijos).

**Columna principal (2/3, en mobile aparece después del formulario):**
- Barra de búsqueda (busca en descripción y categoría) + selector segmentado Todos/Ingresos/Egresos.
- Filtros adicionales: categoría (select) y método de pago (select). Botón "Limpiar filtros" aparece solo si hay algo activo.
- **Lista agrupada por día** (ej. "Hoy", "Ayer", "12 jul"), cada grupo con su propio subtotal (+/− en verde/gris). Cada fila es clickeable → abre `EditTxModal` para editar (tipo, monto, moneda, categoría, método, descripción, fecha) o borrar.
- Cada fila muestra: emoji de categoría, descripción, categoría · método · tarjeta (si aplica) · hora, tag de origen (OCR/Email/Chat/Manual), monto (+moneda si no es ARS), ícono de lápiz al hover.

**Columna lateral (1/3, sticky, aparece PRIMERO en mobile):**
- Formulario **"Nuevo movimiento"**: toggle Egreso/Ingreso, monto + selector de moneda (ARS/USD/USDT), categoría, método de pago, descripción libre. Botón "Guardar movimiento" con confirmación visual momentánea.

---

### 5.3 Tarjetas (`/tarjetas`)

La pantalla más compleja del proyecto. Grid de 3 columnas en desktop.

**Selector de tarjeta**: cards visuales estilo tarjeta física (gradiente propio por tarjeta, últimos 4 dígitos, red — Visa/Amex), clickeables para cambiar cuál se está viendo. Se excluyen tarjetas de débito de esta vista (viven acá pero se filtran visualmente). Botón **"Agregar tarjeta"** en el header y **"Editar tarjeta"** en el panel: ambos abren `CardModal` (nombre, banco, red, últimos 4, límite, día de cierre y de vencimiento).

**Panel "Resumen a pagar" / "Próximo resumen · en curso":**
- Monto grande + "+ USD X en dólares" si aplica.
- Fechas de cierre/vencimiento (editables vía `EditDatesModal`, con opción de que el cambio actualice el día por defecto de la tarjeta para los próximos resúmenes).
- Barra de uso del límite.
- Botón **"Pagar resumen"** (o badge "Al día ✅" si no hay nada pendiente): al pagar, **congela** el total mostrado como reconciliado (no se vuelve a recalcular) y baja el saldo líquido.
- Botón "Ver movimientos" → despliega el detalle (ver abajo).

**Sección "Resúmenes futuros"** (badge violeta "Proyección"): muestra los próximos períodos **aunque el resumen todavía no exista en la base**, calculados a partir de **las cuotas activas + las suscripciones recurrentes detectadas**. Mismo desplegable de movimientos que los reales, donde las suscripciones aparecen con un chip celeste 🔁.

⚠️ **Distinción importante para no contar doble**: las suscripciones se suman **solo a los períodos que todavía no existen como resumen** (badge "próximo"). Al resumen **en curso** (badge celeste "en curso") no se le suman: ahí los consumos entran solos por el importador de mails.

**Sección "Resúmenes anteriores"**: lista de resúmenes cerrados, cada uno con badge Pagado/Pagar, y el mismo desplegable de detalle.

**Desplegable de movimientos** (`MovementsPanel`, se abre por resumen): dos vistas con pager — "Gastos" (lista cronológica con emoji/categoría/monto) y "Por categoría" (donut chart). Si el resumen ya cerró y hay diferencia contra el total reconciliado, agrega una fila sintética "Consumos no detallados".

**Columna lateral:**
- **Cuotas activas**: lista de planes en curso con emoji, "Cuota X de Y", barra de progreso; clickeable → `EditPlanModal` (editar descripción, monto, cantidad de cuotas, fecha de inicio). Si la tarjeta seleccionada no tiene cuotas, sugiere las tarjetas que sí tienen.
- **Suscripciones** (badge celeste "🔁 mensual"): los abonos recurrentes detectados para esa tarjeta, con el motivo ("3 meses seguidos" / "marcada como fija") y el total mensual al pie. Es la fuente de la proyección de los resúmenes futuros. Si no hay ninguna, explica cómo se detectan y linkea a Gastos hormiga para marcar una a mano.
- **Totales por mes** (`CardBars`): gráfico de barras agrupadas por tarjeta (colores propios) con **todos los meses reales + proyección punteada hacia adelante** (según cuotas confirmadas). Controles: rango 3M/6M/Todos, moneda $/US$. Nota al pie explicando qué es "estimado" vs "proyectado".
- Tip decorativo sobre fechas de cierre.

**Regla de negocio clave**: el total de un resumen **pagado** es fijo (el reconciliado). El de un resumen **no pagado** (abierto o cerrado sin pagar) se calcula **en vivo** = consumos linkeados + cuotas del período. Nunca usar el campo guardado de un resumen sin pagar — queda desactualizado.

---

### 5.4 Deudas (`/deudas`)

Dos vistas con tabs: **"Por persona"** e **"Historial"**.

**Por persona** (lista → detalle):
- Lista de personas con avatar, saldo neto (verde si te deben, coral si debés), cantidad de movimientos.
- Al entrar a una persona: header con saldo neto grande, dos stat-cards (Te debe / Le debés), e historial cronológico de deudas.
- Cada deuda muestra: tipo (Dinero💸/En especie📦/Compartido🧾, cada uno con su color e hint explicativo), descripción, monto (tachado y "saldada" si se cerró, o el pendiente si tiene pagos parciales).
- **Botones de acción por deuda pendiente**: "Pago" (parcial, pide monto) y "Saldar" (todo lo que resta).
- **Historial de pagos parciales** por deuda, cada uno con botón **✕ para borrarlo** (pide confirmación; borra también el movimiento asociado en Transacciones y reabre la deuda si estaba saldada).
- Guardia anti doble-click en todas las acciones de pago/saldado/borrado.

**Historial** (vista global): todos los eventos (préstamos + pagos) de todas las personas, ordenados cronológicamente, con verbos en lenguaje natural ("Prestaste a X" / "X te prestó" / "X te pagó" / "Le pagaste a X").

**Alta de deuda nueva**: formulario con persona (existente o alta rápida inline), tipo (cash/in_kind/split), dirección (me deben / debo), monto, moneda, descripción. El tipo "Compartido" (split) calcula automáticamente "tu parte" según cantidad de participantes.

**Regla de negocio**: los préstamos en efectivo generan una transacción visible en Transacciones (categoría "Préstamos"), pero están **excluidos de las métricas de gasto/ingreso** para no distorsionar el análisis real.

---

### 5.5 Cash Flow (`/cashflow`)

La pantalla más densa en lógica financiera. Header con selector de cotización USD/USDT editable inline.

**Toggles principales:**
- **Proyección / Histórico**: proyección = mes actual real + 5 meses proyectados hacia adelante. Histórico = 6 meses reales hacia atrás.
- **Caja / Devengado**: dos criterios contables distintos para cómo contar la tarjeta de crédito.
  - **Caja** (default): la tarjeta cuenta el mes en que **pagás** el resumen.
  - **Devengado**: la tarjeta cuenta el mes en que **consumiste** (fecha de compra).

**Panel "Supuestos de la proyección"** (colapsable):
- Inflación mensual proyectada (editable, con sugerencia "oficial X%" de una fuente externa sincronizada).
- **Ingresos recurrentes**: cada uno editable (monto), con toggle 📈 (se ajusta por inflación) / fijo. Por defecto solo "Sueldo" se infla; alquiler y otros quedan fijos salvo que el usuario lo cambie.
- **Presupuesto mensual por categoría** (gasto variable): cada categoría muestra el promedio automático (histórico), editable manualmente — si el usuario pisa un valor, ese número reemplaza al promedio **en ambas bases contables** (caja y devengado). Botón ↺ para volver al automático.
- **Planificar** (movimientos futuros manuales): agregar ingresos/egresos puntuales o en cuotas (concepto, monto **por mes**, mes de inicio, cantidad de meses). Cada uno listado con botón ✕ para borrar.

**Tabla principal** (`Flujo de Caja`): filas = categorías de ingreso y egreso (con emoji), columnas = 6 meses. El mes actual está marcado "en curso", los futuros "proyectado". Filas destacadas: Total Ingresos, Total Egresos, **Neto del mes** (flujo), **Pesos líquidos** (acumulado, solo ARS), **Patrimonio neto acumulado** (acumulado, todo valuado). "Pago de tarjeta" aparece como una fila propia en base Caja.

**Regla de negocio clave**: en un mes pasado/actual los números son reales (de `transactions` + `breakdown`); en un mes futuro son estimados por fórmula (presupuesto × inflación acumulada). El "Pesos líquidos" arranca del saldo real de hoy (`ars_liquido`) y no se duplica en el primer mes de la proyección.

---

### 5.6 Métricas (`/metricas`)

Foto de estado + análisis histórico. Header con cotización editable.

**Banda superior** (patrimonio + saldos + ratios, todo en un panel):
- **Patrimonio neto** grande (+ equivalente en USD), con badges "Activos $X" / "Pasivos $X".
- Columnas: Pesos, Dólares, Cripto (cada uno con su valor + equivalente en ARS).
- **4 ratios financieros**, filtrables por mes (chips de Análisis abajo) o "todos los meses":
  - **Deuda/Ingresos**: cuotas del período ÷ ingresos del período. Ideal < 36%.
  - **Tasa de ahorro**: (ingresos − egresos) ÷ ingresos. Ideal > 20%.
  - **Flujo de caja**: ingresos ÷ egresos, como múltiplo. Ideal > 1.
  - **Ahorro mensual**: monto absoluto ahorrado (promedio si es "todos los meses").
  - Cada ratio tiene semáforo de color (verde/ámbar/coral) según qué tan lejos está del ideal.

**Patrimonio neto en el tiempo** (panel propio, entre la banda superior y Análisis):
- Columnas apiladas por mes: activos hacia arriba (Pesos lima / Dólares ámbar / Cripto cielo / Te deben esmeralda) y **pasivos hacia abajo** (coral), con la **línea blanca del neto** encima. Hover para ver el detalle de cualquier mes.
- **Toggle $ / US$** arriba a la derecha (default pesos). En dólares cada mes se divide por el blue **de su propio cierre**, no por el de hoy.
- Arriba del toggle, la variación del último mes descompuesta en **"tuyo" vs "por el dólar"**: cuánto subiste por ahorro real y cuánto solo porque se movió el tipo de cambio. En modo US$ la descomposición se invierte y muestra lo que costó tener pesos.
- La serie arranca en el mes de la primera transacción y el último punto **coincide exactamente** con el patrimonio de la banda superior.

**Sección Análisis** (chips de mes + "Todos" arriba):
- **Gastos por categoría** (donut) y **Gastos por método de pago** (barras) — ambos incluyen cuotas de tarjeta sumadas a su categoría/método real.
- **Variación por categoría**: tabla comparando dos meses elegibles (selectores independientes A vs B), con flechas de suba/baja.
- **Ingresos vs Egresos**: barras agrupadas mes a mes (histórico completo disponible, no solo 6 meses).

---

### 5.6b Gastos hormiga (`/hormiga`)

Mide el gasto **evitable**, no el chico. Entra todo Delivery / Comida / Ocio / Transporte / Compras **sin filtrar por monto** (una cena de $30.000 es más recortable que un café de $4.000). El umbral (percentil 70, auto-calibrado) NO excluye nada: solo parte el total en dos para leerlo mejor — **goteo** (tickets chicos y repetidos) y **grandes** (los pocos consumos gordos). Quedan afuera las cuotas y las suscripciones.

Contenido: total del mes con comparación contra el anterior, ticket promedio, qué porcentaje es goteo, proyección anual, ranking de comercios, y una lista de **suscripciones detectadas** (mismo comercio + monto repetido en 3 meses, o 2 si el nombre lo delata) con un botón para marcarlas como **gasto fijo** (`transactions.nature = 'fijo'`), lo que las saca del análisis y las suma a la proyección de tarjetas.

⚠️ **Pantalla en revisión**: al usuario le convencía más cuando el foco eran los **microgastos**. Hoy entran cosas como la nafta, que no son "hormiga" en el sentido clásico. Está pendiente repensarla.

---

### 5.7 Reglas (`/reglas`)

Motor de auto-categorización/enriquecimiento para los consumos que entran por el importador de Gmail. **Solo aplica a consumos nuevos** — no retroactivo a lo ya cargado.

**Condiciones combinables** (todas opcionales, pero se exige al menos una):
- Texto en la descripción: contiene / empieza con / es igual a
- Horario (soporta rango que cruza medianoche, ej. 22 a 2)
- Días de la semana (chips Lun–Dom)
- Rango de monto (mínimo y/o máximo)

**Acciones combinables** (se exige al menos una):
- Recategorizar (asignar categoría)
- Renombrar la descripción
- Forzar la moneda (convierte el monto — útil para suscripciones en USD que la alerta del banco reporta en pesos, ej. Spotify)

**Lista de reglas**: cada una muestra su condición en lenguaje natural ("Si la descripción contiene «X» · entre 11h y 15h") y sus acciones con color propio por tipo (categoría=lima, renombre=celeste, moneda=ámbar). Toggle Activa/Off y borrar.

**Semántica importante**: si varias reglas matchean, **cada acción la define la primera regla que la tenga** (por prioridad y antigüedad) — pueden ser reglas distintas aportando categoría, renombre y moneda cada una por separado.

---

### 5.8 Divisas (`/divisas`)

**Cotizaciones en vivo** (hoy con datos mock, `lib/mock.ts`): grid de 4 tarjetas con compra/venta y variación %.

**Conversor y registro**: dos campos (Entregás/Recibís) con selector de moneda cada uno y botón de invertir. Tipo de cambio Auto (calculado) o Manual (editable). Botón "Registrar cambio" guarda la operación en el historial real.

**Historial de cambios**: lista de conversiones registradas, con fecha, tipo de cambio usado y montos.

**Columna lateral**: Tenencias (holdings valuados en pesos, con mock data) y gráfico de tendencia USDT/ARS (sparkline SVG).

⚠️ **Estado**: la cotización en vivo y las tenencias son **mock**, no datos reales — es la parte menos terminada de la app junto con Recurrentes.

---

### 5.9 Recurrentes (`/recurrentes`)

**Placeholder puro** (`ComingSoon`): ícono 🚧, título, mensaje "Esta sección la maquetamos en el próximo paso". No tiene ninguna funcionalidad todavía — es la única pantalla completamente sin construir (más allá de que sus datos ya existen y se leen en Cash Flow como "ingresos recurrentes").

---

### 5.10 Login (`/login`) y recuperación (`/auth/reset`)

**Login**: pantalla centrada, logo + nombre de marca, formulario con `.ai-glow`. Solo email + contraseña + botón "Entrar". **No hay registro** (self-signup deshabilitado tanto en la UI como con un trigger en la base — es intencional, la app es de un único usuario). Link "¿Olvidaste tu contraseña?" dispara el mail de recuperación **siempre a la casilla del dueño** (hardcodeada, no hay campo de destino).

**Auth reset**: aterrizaje del link del mail. Valida la sesión temporal (soporta varios formatos de link/dispositivo), pide contraseña nueva dos veces, y redirige al home al guardar.

Ninguna de las dos lleva sidebar ni nav — son pantallas "fuera" del shell de la app.

---

### 5.11 Asistente IA (solo en el Resumen)

Edge Function con Claude, tool-use: interpreta lenguaje natural y **propone** transacciones o deudas — nunca ejecuta directo. El usuario ve la propuesta en una card dentro del chat y la confirma antes de que se escriba en la base. Si falta un dato, pregunta con opciones clickeables. Asume ARS salvo aclaración. Muestra el costo de cada consulta.

**Un solo punto de acceso**: la barra del Resumen (ver 5.1), que expande el chat dentro de la misma barra. El **botón flotante que existía en el resto de las pantallas se eliminó** (27/07/2026) junto con su componente.

Soporta dictado por voz (Web Speech API): graba, transcribe, y **envía automáticamente a los 3 segundos de silencio**.

---

## 6. Estado actual — qué está terminado vs. qué es placeholder

**Completo y en uso real:** Resumen, Transacciones, Tarjetas, Deudas, Cash Flow, Métricas, Gastos hormiga, Reglas, Login/Auth.

**Parcial / mock:**
- **Divisas**: las **cotizaciones en vivo y las tenencias siguen siendo mock** (`lib/mock.ts`) aunque la tabla `fx_rates` ya tiene todo lo necesario para reemplazarlas. El conversor y el registro de historial sí son reales. ⚠️ Registrar un cambio **no mueve los saldos** todavía.
- **OCR de tickets**: el botón cámara existe en la UI pero no hace nada — placeholder.
- **Reglas**: el botón **"Nueva regla" no funciona**. Además el usuario prefiere que el alta sea un **desplegable** y no el formulario al costado.

**No construido:**
- **Recurrentes**: pantalla vacía (`ComingSoon`).

**Pendientes de diseño planteados por el usuario:**
- Repensar **Gastos hormiga** para que vuelva a girar alrededor de los microgastos (ver 5.6b).
- Repasar la pantalla de **Tarjetas** de la mitad para abajo.
- Barrer los botones de acción que quedaron sin conectar en el resto de las pantallas.

---

## 7. Cómo se valúan los números (afecta a todos los gráficos)

Tres reglas que conviene tener presentes al diseñar cualquier vista con plata:

1. **Flujos** (gastos e ingresos ya ocurridos) → se valúan con la **cotización congelada del día** en que pasaron (`transactions.fx_rate_ars`). Un gasto de abril vale lo que valió en abril: los meses cerrados **no se mueven** cuando cambia el dólar.
2. **Saldos y compromisos a futuro** → cotización **de hoy**. Tener US$ 1.000 vale el dólar de hoy, no el del día que entraron. Aplica a saldos, patrimonio, deudas pendientes y resúmenes de tarjeta sin pagar.
3. **Patrimonio histórico** → cotización **vigente a cada fecha de corte**. Lo que valían tus dólares el 30/04 es el blue del 30/04.

Los inputs de cotización editables que hay en los headers de Métricas y Cash Flow ya **no mueven los meses históricos** (es intencional): siguen mandando en saldos y proyecciones.

---

## 8. Cómo usar este documento

Si estás por rediseñar o mejorar algo: fijate primero en qué sección de este documento describe el módulo en cuestión — ahí tenés qué componentes existen, qué datos muestran y qué reglas de negocio no se pueden romper (por ejemplo: los ratios de Métricas, la lógica caja/devengado de Cash Flow, o que un resumen de tarjeta pagado nunca se recalcula). El repo tiene el código fuente exacto de cada componente mencionado acá con el mismo nombre de archivo.
