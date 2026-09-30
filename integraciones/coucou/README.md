# Coucou + Plata

[Coucou](https://github.com/Louis-CFM/coucou/tree/main/windows) es una isla chiquita que vive arriba al centro de la pantalla, con Mochi adentro. Con Claude Code te deja aprobar permisos, ver qué hace la sesión, soltar archivos y chatear. Esta carpeta le suma dos pills propias:

| Pill | Qué muestra | Cuándo te avisa |
|---|---|---|
| **Plata** (naranja) | Estado del importador de Gmail, último consumo importado, dólar blue y cripto del día | 🔴 Cuando algo se rompe: token de Gmail vencido, el cron no corre, cotizaciones viejas, errores del importador. 🟢 Cuando entra un consumo nuevo de la tarjeta, y cuando se arregla un problema |
| **Railway** (violeta) | Los últimos deploys del proyecto `plata` | 🟢/🔴 Cuando termina un deploy o se cae el servicio. Mientras deploya, Mochi trabaja |

La pill de **Claude Code** viene de fábrica. La de **GitHub** también, pero solo muestra la cantidad de repos y estrellas.

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

Si lo corrés otra vez, solo recompila. Con `-Dev` abre la app con recarga en vivo (`npm run tauri dev`), en lugar de generar el instalador.

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
- Del lado de Coucou, todo lo propio está en `plata.patch`:
  - `windows/src-tauri/src/integrations.rs`: `poll_plata` y `poll_railway`.
  - `windows/src/views/integrations.ts`: las tarjetas.
  - `state.ts`, `settings/main.ts`, `secrets.rs`, `settings.rs`, `island.ts`: el registro de las dos pills.

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
