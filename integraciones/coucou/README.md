# Coucou + Plata

[Coucou](https://github.com/Louis-CFM/coucou/tree/main/windows) es una isla chiquita que vive arriba al centro de la pantalla, con Mochi adentro. Con Claude Code te deja aprobar permisos, ver qué hace la sesión, soltar archivos y chatear. Esta carpeta le suma dos pills propias:

| Pill | Qué muestra | Cuándo te avisa |
|---|---|---|
| **Plata** (naranja) | Estado del importador de Gmail, último consumo importado, dólar blue y cripto del día | 🔴 Cuando algo se rompe: token de Gmail vencido, el cron no corre, cotizaciones viejas, errores del importador. 🟢 Cuando entra un consumo nuevo de la tarjeta, y cuando se arregla un problema |
| **Railway** (violeta) | Los últimos deploys del proyecto `plata` | 🟢/🔴 Cuando termina un deploy o se cae el servicio. Mientras deploya, Mochi trabaja |

La pill de **Claude Code** viene de fábrica. La de **GitHub** también, pero solo muestra la cantidad de repos y estrellas.

Además, el parche suma dos cosas a la isla:

- **Pestaña Plata** (la moneda, en el encabezado de la isla): un chat con el [agente de Plata](https://github.com/gigli-developer/agentes). Ver [Chat con Plata](#chat-con-plata).
- **La isla se mueve.** Agarrala de cualquier parte que no sea un botón y arrastrala. Ver [Mover la isla](#mover-la-isla).

## Instalar (Windows 10/11)

Requisitos, una sola vez:
- [Git](https://git-scm.com/download/win)
- [Node 20+](https://nodejs.org)
- [Rust](https://rustup.rs)
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), con la carga **"Desarrollo para el escritorio con C++"**

Después, desde la raíz de este repo:

```powershell
powershell -ExecutionPolicy Bypass -File integraciones\coucou\instalar.ps1
```

El script hace esto:
1. Clona Coucou en `%USERPROFILE%\coucou`, en el commit exacto contra el que se escribió el parche.
2. Aplica `plata.patch` en una rama `plata`.
3. Compila y abre el instalador. Se instala solo para tu usuario, sin pedir administrador.

Si lo corrés otra vez, solo recompila. **Ojo:** si ya tenías el clon de antes, la rama `plata` no recibe los commits nuevos del parche. Para actualizarla, desde `%USERPROFILE%\coucou`: `git checkout plata && git reset --hard 5ae7bd9 && git am --3way <repo-plata>\integraciones\coucou\plata.patch`, y después corré el instalador de nuevo. Con `-Dev` abre la app con recarga en vivo (`npm run tauri dev`), en lugar de generar el instalador.

> ¿Por qué compilarlo? El instalador oficial está bajado porque Defender lo marcaba como troyano. El autor dice que es un falso positivo, pero hasta que lo firme, compilarlo vos es lo más seguro: el código se puede leer entero.

## Configurar

Ícono de Mochi en la bandeja → **Settings…**

1. **Claude Code → Install hooks…**. Antes de escribir nada te muestra qué cambia en `%USERPROFILE%\.claude\settings.json` y hace un backup.
2. **Claude**: tu API key de Anthropic. Es opcional; solo hace falta para el chat de la isla.
3. **Plata → Secret**: el secreto compartido con la Edge Function. Para verlo, corré esto en el SQL editor de Supabase:
   ```sql
   select value from public.app_secrets where key = 'COUCOU_SECRET';
   ```
   El campo *Health URL* dejalo vacío: por defecto apunta a la función `coucou-health` de este proyecto.
4. **Railway → Account token**: sacalo de <https://railway.com/account/tokens>. Sirve el mismo que usás como `RAILWAY_API_TOKEN` para deployar. El *Project ID* es opcional: sin él se usa el proyecto que se llama `plata`. Si usás un token de *workspace* y no encuentra el proyecto, copiá el ID de la URL (`railway.com/project/<ID>`).
5. Prendé las pills que quieras. Son hasta 4, más la de Claude Code, que siempre está.

Todas las claves quedan en el **Administrador de credenciales de Windows**, no en disco.

## Mover la isla

Apretá sobre la isla (en cualquier lugar que no sea un botón, un campo de texto o la conversación) y arrastrá. Al soltar:

| Dónde la soltás | Dónde queda |
|---|---|
| Cerca del borde izquierdo o derecho | Pegada a ese costado, a la altura donde la dejaste. El lado del borde queda recto |
| Cerca de arriba | Arriba al centro, como siempre |
| En cualquier otro lugar | Flotando ahí |

Funciona en cualquier monitor: se ancla en la pantalla donde la soltás y la recuerda (`dockMonitor`). Si esa pantalla se desconecta, vuelve a la que elijas en los ajustes. La posición se guarda en `%APPDATA%\Coucou\settings.json` (`dock`, `dockX`, `dockY`, `dockMonitor`). Fuera de arriba la isla no se esconde del todo: queda como pastilla, porque la franja invisible que la vuelve a sacar solo existe en el borde de arriba. La pausa de la bandeja sí la esconde en cualquier posición.

Para volver a la posición original, arrastrala de nuevo arriba o borrá esas tres claves del `settings.json`.

## Chat con Plata

La pestaña de la moneda abre un chat con el agente de Plata del repo `agentes`: el mismo de `/agente`, con sus herramientas, sus propuestas y su registro de costos. La isla no tiene lógica de finanzas propia: le manda cada mensaje al servidor local del agente y dibuja lo que vuelve.

- **El agente se prende solo.** Al arrancar Coucou, si el agente no está escuchando, corre `npm run servir` en la carpeta `agentes` (sin ventana, con la salida en `%LOCALAPPDATA%\Coucou\plata-agent.log`). Sigue corriendo aunque cierres Coucou, y el próximo arranque lo encuentra prendido. Si se cae mientras lo usás, la isla lo vuelve a prender y reenvía tu mensaje; solo si eso falla aparece **Reintentar**. La carpeta se busca en `Desktop\Claude\agentes` (con o sin OneDrive) o en `%USERPROFILE%\agentes`, y necesita la sesión de `npm run login` hecha una vez.
- **Qué se ve:** el texto del agente, qué herramientas está usando, cada propuesta como tarjeta y, al final de cada turno, cuánto costó.
- **Tarjetas de datos:** cuando el agente consulta `saldos`, `resumen_mensual` o `serie_patrimonio`, la isla dibuja una tarjeta con lo que devolvió (líquido en ARS, USD y USDT; gastos del mes por categoría; patrimonio mes a mes). Llegan con el evento `resultado` del agente, que la isla pide con `resultados: true` (CONTRATOS §9 en `agentes`). Las tarjetas no suman ni convierten nada: muestran el dato tal cual.
- **Cambios en la app (botón de la terminal):** escribís el pedido ("agregá un filtro por tarjeta en Movimientos") y tocás el botón de la terminal en vez de enviar. No va al agente: se abre una terminal en el repo de Plata con Claude Code (el que trae la app de escritorio, `%APPDATA%\Claude\claude-code\<versión>\claude.exe`) trabajando en ese pedido, con la instrucción de hacerlo en una rama nueva y no pushear ni deployar sin preguntar. Sus pedidos de permiso aparecen en la isla por los hooks. El pedido queda guardado en `%LOCALAPPDATA%\Coucou\pedidos\`.
- **Comparar un resumen de la tarjeta:** con la pestaña Plata abierta, soltá el PDF del resumen (o una captura) sobre la isla, o pegá el resumen que te pasaron por WhatsApp (más de 600 caracteres se convierte en un adjunto "Resumen pegado"). Si no escribís nada, el mensaje por defecto pide comparar contra Plata. El agente identifica la tarjeta y el período, compara línea por línea con el detalle del resumen y lista las diferencias. **Solo puede proponer los consumos que faltan**; montos distintos, duplicados o cuotas mal te los informa con el id para que los corrijas. Hasta 3 archivos y 8 MB.
- **Voz (micrófono):** activa el dictado de Windows (Win+H) sobre el campo del chat. Dictás, y el texto queda escrito para enviarlo. Usa el idioma de dictado de Windows.
- **Propuestas:** la tarjeta trae **Aprobar** y **Rechazar**. La respuesta viaja como el mensaje siguiente ("Sí, aprobá la propuesta 42."), que es lo único que la base acepta: rechaza una confirmación hecha en el mismo turno que la propuso. La isla nunca escribe en Supabase.
- **⤢ Agrandar:** el botón naranja del encabezado de la isla (al lado del engranaje) abre el chat de Plata en grande desde cualquier vista; adentro del chat, el botón "Agrandar" lo lleva a casi toda la pantalla (hasta 1100×900, según el monitor) y lo vuelve a achicar. Se recuerda.
- **Conciliar con Claude Code:** soltar un PDF/captura o pegar un resumen en la pestaña Plata lo concilia Claude Code en segundo plano (con la suscripción, no la API), con la skill `conciliar-resumen` y `npm run conciliar:leer` del repo agentes. El progreso y el resultado (totales, diferencias, Abrir informe, Cargar faltantes con Plata) aparecen en el chat. Requiere iniciar sesión una vez en el Claude Code de la app de escritorio (la isla muestra el botón). El agente también puede sugerirlo con el evento `delegar`.
- **Fluidez:** mientras la isla está visible la ventana queda en su tamaño máximo y todos los cambios de tamaño son animaciones dentro de la página; al soltarla se desliza hasta el ancla.
- **Listo solo:** al abrir la isla y la pestaña Plata se revisan el agente, Claude Code (versión y sesión con el plan), la skill de conciliar y el lector; si falta algo aparece un botón que lo resuelve (Encender agente, Conectar Claude Code con login en el navegador, sin terminal). El extracto de la cuenta es una pieza opcional.
- **Extracto de la cuenta:** soltar o pegar el extracto del Galicia lo concilia Claude Code con la skill `conciliar-extracto` y `npm run conciliar:leer-cuenta`; misma tarjeta de diferencias.
- **Panel grande:** el botón Agrandar de cada chat (Plata y Claude, mismo lugar) abre un panel con la lista de chats a la izquierda (buscador, "+", avatar, última línea, hora, aviso de propuestas) y el chat activo a la derecha. El ⤢ del encabezado global se sacó.
- **Acciones sugeridas:** el agente termina algunas respuestas con un bloque ```acciones; la isla lo esconde y muestra hasta 3 botones que mandan el pedido.
- **Varias líneas y dictado:** Shift+Enter baja de renglón; el micrófono avisa si falta el reconocimiento de voz en línea de Windows.
- **Historial local:** cada mensaje y cada respuesta del agente quedan en `%LOCALAPPDATA%\Coucou\plata-chat.log` (solo en tu PC; se reinicia al pasar 5 MB), para poder revisar un turno que salió mal: el agente guarda las conversaciones solo en memoria.
- **Nueva** arranca otra conversación. Cada una vive en el agente hasta 30 minutos sin mensajes.
- Mientras el chat está abierto, la ventana de la isla crece de 720×320 a 720×480. Es transparente y deja pasar los clics fuera de la isla, pero toma el mouse mientras hay un botón apretado encima (para poder soltar archivos), así que vuelve a su tamaño apenas se cierra el chat.

## Cómo está armado

```
Coucou (tu PC)                               Supabase (Plata)
──────────────                               ────────────────
poll_plata  ── cada 3 min, POST ───────────▶ Edge Function coucou-health
            header x-coucou-secret            ├─ chequea en vivo el refresh token de Gmail
                                              └─ RPC coucou_health()  (SECURITY DEFINER,
                                                   solo service_role): último cron de cada job,
                                                   errores del importador en 24 h, último
                                                   consumo importado, blue/cripto del día
poll_railway ── cada 30 s ─────────────────▶ backboard.railway.com/graphql/v2
```

- **Solo lectura.** La función no escribe nada ni devuelve saldos ni patrimonio. Lo más sensible que expone es el último consumo importado. Sin el secreto devuelve 401.
- **El chequeo del token de Gmail es en vivo.** Es el único dato que la base no tiene: `pg_net` corta el llamado del cron a los 5 s, así que cuando el token vence el error del poller nunca queda registrado. Por eso la función pide un access token a Google cada vez que la consultan.
- Fuentes versionadas en este repo:
  - `supabase/functions/coucou-health/index.ts`: se deploya con el MCP de Supabase, `verify_jwt=false`.
  - `supabase/sql/coucou_health.sql`: se aplica con `execute_sql`.
- Del lado de Coucou, todo lo propio está en `plata.patch` (veintitrés commits):
  - `windows/src-tauri/src/integrations.rs`: `poll_plata` y `poll_railway`.
  - `windows/src/views/integrations.ts`: las tarjetas.
  - `state.ts`, `settings/main.ts`, `secrets.rs`, `settings.rs`, `island.ts`: el registro de las dos pills.
  - `windows/src-tauri/src/island.rs` (`drag_loop`, `apply_geometry`) y `layout.ts` (`islandX`, `islandRadius`): mover y anclar la isla.
  - `windows/src-tauri/src/plata_agent.rs` y `windows/src/views/plata.ts`: el chat con el agente, las tarjetas y el pase a Claude Code. `island.rs` (`start_dictation`): la voz.

## Actualizar Coucou

```powershell
cd $env:USERPROFILE\coucou
git fetch origin
git rebase origin/main        # re-aplica el commit de Plata sobre lo nuevo
cd windows; npm install; npm run pack
```

Si el rebase choca, es el momento de abrir Claude Code **local** en esa carpeta y pedirle que resuelva el conflicto. Después regenerá el parche para este repo:

```powershell
git format-patch origin/main --stdout > <repo-plata>\integraciones\coucou\plata.patch
```

Y actualizá `$Commit` en `instalar.ps1` con el resultado de `git rev-parse origin/main`.

## Problemas

- **Log de Coucou**: `%LOCALAPPDATA%\Coucou\coucou.log`. Ahí aparecen las líneas `plata HTTP …`, `plata problems: …` y `railway <servicio> <estado>`.
- **La pill de Plata dice "Wrong secret (401)"**: el secreto no coincide con `app_secrets.COUCOU_SECRET`.
- **"Token de Gmail vencido"**: el procedimiento de siempre (`node scripts/gmail-auth.mjs` y actualizar `GOOGLE_REFRESH_TOKEN`). Ver *Automatización de emails* en `CLAUDE.md`.
