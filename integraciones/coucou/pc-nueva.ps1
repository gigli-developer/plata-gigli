<#
.SYNOPSIS
  Deja una PC nueva lista para seguir con Plata + el agente + la isla Coucou.

.DESCRIPTION
  Hace en orden, salteando lo que ya esté:
  1. Instala con winget lo que falte: Git, Node LTS, Rust y las Build Tools de C++ (pide admin una vez).
  2. Clona el repo `agentes` al lado de este repo (o lo actualiza si ya está).
  3. En `agentes`: npm install, arma el .env (te pide las dos claves) y corre `npm run login`.
  4. Copia las skills de Claude Code que no están en git (conciliar-resumen, conciliar-extracto,
     informe-mensual) desde el zip que sacaste de la PC vieja con exportar-skills.ps1.
  5. Corre instalar.ps1: compila Coucou con el parche de Plata y abre el instalador.

  Correrlo de nuevo es seguro: cada paso mira si ya está hecho.

  Las carpetas importan: la isla busca el repo de Plata en %USERPROFILE%\plata-gigli (o
  Escritorio\Claude\finanzas-app) y `agentes` en %USERPROFILE%\agentes (o Escritorio\Claude\agentes).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File integraciones\coucou\pc-nueva.ps1 -Skills $HOME\Downloads\skills-claude.zip
#>
param(
  # Zip generado por exportar-skills.ps1 en la PC vieja. Sin él, el resto se instala igual.
  [string]$Skills,
  # Todo menos compilar Coucou (por ejemplo, para probar solo el agente).
  [switch]$SinIsla
)

$ErrorActionPreference = "Stop"
$Plata = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$SkillsIsla = @("conciliar-resumen", "conciliar-extracto", "informe-mensual")

function Paso($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Ok($texto) { Write-Host "    $texto" -ForegroundColor Green }
function Aviso($texto) { Write-Host "    $texto" -ForegroundColor Yellow }
function Falla($texto) { Write-Host "`n$texto" -ForegroundColor Red; exit 1 }

# Los comandos nativos no cortan el script solos: hay que mirar $LASTEXITCODE.
function Correr {
  $resto = @($args | Select-Object -Skip 1)
  & $args[0] @resto
  if ($LASTEXITCODE -ne 0) { Falla "Falló: $($args -join ' ')" }
}

# winget instala, pero esta terminal no ve el PATH nuevo hasta que se abre otra.
function RefrescarPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User") + ";" +
              (Join-Path $env:USERPROFILE ".cargo\bin")
}

function Tiene($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# No puede llamarse "Winget": PowerShell no distingue mayúsculas y la función se llamaría a sí misma.
function Instalar($id, $extra) {
  Write-Host "    winget install $id"
  $argumentos = @("install", "--id", $id, "-e", "--accept-source-agreements", "--accept-package-agreements") + $extra
  & winget.exe @argumentos
  # -1978335189 / -1978335135 = "ya está instalado" / "no hay versión nueva": no son errores.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189 -and $LASTEXITCODE -ne -1978335135) { Falla "winget no pudo instalar $id (código $LASTEXITCODE)." }
  RefrescarPath
}

function TieneMsvc {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { return $false }
  [bool](& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
}

# Pone CLAVE=valor en el .env, reemplazando la línea si ya existe.
function EscribirEnv($archivo, $clave, $valor) {
  $lineas = @(Get-Content $archivo -Encoding UTF8)
  $hay = $false
  $lineas = $lineas | ForEach-Object {
    if ($_ -match "^$clave=") { $hay = $true; "$clave=$valor" } else { $_ }
  }
  if (-not $hay) { $lineas += "$clave=$valor" }
  # Sin BOM: dotenv lee la primera clave con el BOM pegado.
  [IO.File]::WriteAllLines($archivo, [string[]]$lineas, (New-Object Text.UTF8Encoding $false))
}

function ValorEnv($archivo, $clave) {
  $linea = Get-Content $archivo -Encoding UTF8 | Where-Object { $_ -match "^$clave=" } | Select-Object -First 1
  if ($linea) { return $linea.Substring($clave.Length + 1).Trim() }
  return ""
}

# ── 1. Requisitos ────────────────────────────────────────────────────────────
Paso "Requisitos (Git, Node, Rust, Build Tools de C++)"
RefrescarPath
if (-not (Tiene winget.exe)) {
  Falla "No encuentro winget. Instalá 'App Installer' desde Microsoft Store y volvé a correr el script."
}

if (Tiene git) { Ok "Git ya está." } else { Instalar "Git.Git" @() }

$nodeOk = $false
if (Tiene node) { $nodeOk = [int]((node -v).TrimStart("v").Split(".")[0]) -ge 20 }
if ($nodeOk) { Ok "Node $(node -v) ya está." } else { Instalar "OpenJS.NodeJS.LTS" @() }

if (Tiene cargo) { Ok "Rust ya está." } else {
  Instalar "Rustlang.Rustup" @()
  if (-not (Tiene cargo) -and (Tiene rustup)) { Correr rustup default stable-msvc }
}

if (TieneMsvc) { Ok "Build Tools de C++ ya están." } else {
  Aviso "Las Build Tools pesan unos 3 GB y tardan. Windows va a pedir permiso de administrador."
  Instalar "Microsoft.VisualStudio.2022.BuildTools" @("--override",
    "--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended")
  if (-not (TieneMsvc)) { Falla "Las Build Tools no quedaron instaladas. Reiniciá la PC y volvé a correr el script." }
}

foreach ($cmd in "git", "node", "npm", "cargo") {
  if (-not (Tiene $cmd)) { Falla "Se instaló todo pero esta terminal no ve '$cmd'. Abrí una terminal nueva y volvé a correr el script." }
}

# ── 2. Repo agentes ──────────────────────────────────────────────────────────
Paso "Repo agentes"
$candidatos = @(
  (Join-Path $env:USERPROFILE "OneDrive\Desktop\Claude\agentes"),
  (Join-Path $env:USERPROFILE "Desktop\Claude\agentes"),
  (Join-Path $env:USERPROFILE "agentes")
)
$Agentes = $candidatos | Where-Object { Test-Path (Join-Path $_ "plata\servir.ts") } | Select-Object -First 1
if ($Agentes) {
  Ok "Ya está en $Agentes. Traigo lo último."
  git -C $Agentes pull --ff-only
  if ($LASTEXITCODE -ne 0) { Aviso "No pude actualizarlo solo (¿cambios locales?). Sigo con lo que hay." }
} else {
  $Agentes = Join-Path $env:USERPROFILE "agentes"
  if (Test-Path $Agentes) { Falla "$Agentes ya existe y no es el repo agentes. Movelo y volvé a correr el script." }
  Correr git clone https://github.com/gigli-developer/agentes $Agentes
}

# ── 3. Agente: dependencias, .env y login ────────────────────────────────────
Paso "Agente de Plata"
Push-Location $Agentes
try {
  Correr npm install --no-audit --no-fund

  $envFile = Join-Path $Agentes ".env"
  if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $Agentes ".env.example") $envFile }

  # Valida la forma: el dashboard de Supabase muestra la key tapada con puntitos (eyJhbGci••••) hasta
  # que tocás "Reveal", y copiar eso deja basura en el .env que recién explota en el login.
  $formaAnon = '^(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_publishable_[A-Za-z0-9_-]+)$'
  $formaAnthropic = '^sk-ant-[A-Za-z0-9_-]+$'

  if ((ValorEnv $envFile "SUPABASE_ANON_KEY") -notmatch $formaAnon) {
    Write-Host "    Falta SUPABASE_ANON_KEY: Supabase → proyecto dsocdpxlvcufitvovydr → Settings → API → anon public"
    Write-Host "    (tocá Reveal/Copy: si se ve con puntitos, está tapada). Empieza con eyJ y es una sola línea larga."
    while ($true) {
      $anon = (Read-Host "    Pegala acá").Trim()
      if (-not $anon) { Aviso "Quedó vacía: el agente no va a arrancar hasta que la completes en $envFile."; break }
      if ($anon -match $formaAnon) { EscribirEnv $envFile "SUPABASE_ANON_KEY" $anon; Ok "Guardada."; break }
      Aviso "Eso no parece la key (tiene espacios, puntitos u otros caracteres raros). Probá de nuevo, o Enter para saltear."
    }
  } else { Ok "SUPABASE_ANON_KEY ya está." }

  if ((ValorEnv $envFile "ANTHROPIC_API_KEY") -notmatch $formaAnthropic -and -not (ValorEnv $envFile "OPENROUTER_API_KEY")) {
    Write-Host "    Falta ANTHROPIC_API_KEY (la del agente, NO la de app_secrets). Copiala del .env de agentes de la PC vieja"
    Write-Host "    o creá una en https://console.anthropic.com/settings/keys"
    while ($true) {
      $seguro = Read-Host "    Pegala acá (no se ve al escribir)" -AsSecureString
      $clave = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)).Trim()
      if (-not $clave) { Aviso "Quedó vacía: completala en $envFile."; break }
      if ($clave -match $formaAnthropic) { EscribirEnv $envFile "ANTHROPIC_API_KEY" $clave; Ok "Guardada ($($clave.Length) caracteres, empieza con sk-ant-)."; break }
      Aviso "Recibí $($clave.Length) caracteres que no empiezan con sk-ant-. Probá de nuevo, o Enter para saltear."
    }
  } else { Ok "La key del modelo ya está." }

  $sesion = Join-Path $Agentes ".sesion\supabase.json"
  if (Test-Path $sesion) {
    Ok "La sesión de Plata ya está guardada."
  } else {
    Write-Host "    Ahora el login de Plata (una sola vez): te pide la contraseña de la app."
    Correr npm run login
  }
} finally {
  Pop-Location
}

# ── 4. Skills de Claude Code (fuera de git) ──────────────────────────────────
Paso "Skills de Claude Code"
$dirSkills = Join-Path $env:USERPROFILE ".claude\skills"
if ($Skills) {
  if (-not (Test-Path $Skills)) { Falla "No encuentro $Skills." }
  New-Item -ItemType Directory -Force $dirSkills | Out-Null
  Expand-Archive -Path $Skills -DestinationPath $dirSkills -Force
  Ok "Copiadas en $dirSkills."
}
$faltan = $SkillsIsla | Where-Object { -not (Test-Path (Join-Path $dirSkills "$_\SKILL.md")) }
if ($faltan) {
  Aviso "Faltan: $($faltan -join ', '). Sin ellas no anda conciliar resúmenes/extractos ni el informe mensual."
  Aviso "En la PC vieja: powershell -ExecutionPolicy Bypass -File integraciones\coucou\exportar-skills.ps1"
  Aviso "y después corré este script con -Skills <ruta al zip>."
} else { Ok "Están las tres: $($SkillsIsla -join ', ')." }

# ── 5. Coucou ────────────────────────────────────────────────────────────────
if ($SinIsla) {
  Paso "Coucou: salteado (-SinIsla)"
} else {
  Paso "Coucou (la isla)"
  & (Join-Path $PSScriptRoot "instalar.ps1")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# La isla solo encuentra el repo de Plata en estas carpetas (plata_repo_dir en plata.patch).
$plataOk = @(
  (Join-Path $env:USERPROFILE "OneDrive\Desktop\Claude\finanzas-app"),
  (Join-Path $env:USERPROFILE "Desktop\Claude\finanzas-app"),
  (Join-Path $env:USERPROFILE "plata-gigli")
) | Where-Object { $_ -eq $Plata }
if (-not $plataOk) {
  Aviso "`nEste repo está en ${Plata}: la isla no lo va a encontrar para el botón de cambios en la app."
  Aviso "Clonalo (o movelo) a $(Join-Path $env:USERPROFILE 'plata-gigli')."
}

Write-Host @"

Listo. Lo que queda es a mano, una sola vez:
  · Abrí la app de escritorio de Claude e iniciá sesión en Claude Code (la isla te muestra el botón si falta).
  · Ícono de Mochi en la bandeja → Settings… → Claude Code → Install hooks…
  · Plata → Secret = app_secrets.COUCOU_SECRET  ·  Railway → Account token (ver integraciones\coucou\README.md)
"@
