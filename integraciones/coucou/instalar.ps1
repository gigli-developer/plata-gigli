<#
.SYNOPSIS
  Instala Coucou (la isla de escritorio de Claude Code) con las pills de Plata y Railway.

.DESCRIPTION
  1. Chequea que estén Git, Node 20+, Rust y las MSVC Build Tools.
  2. Clona Coucou en $Destino, fijado al commit contra el que se escribió el parche.
  3. Aplica plata.patch en la rama `plata` (una sola vez; si ya está, la reusa).
  4. `npm install` + `npm run pack` → deja el instalador en windows\release\ y lo abre.

  Correrlo de nuevo es seguro: si el clon y la rama ya existen, solo recompila.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File integraciones\coucou\instalar.ps1

.EXAMPLE
  # Modo desarrollo: abre la app con recarga en vivo en lugar de generar el instalador.
  powershell -ExecutionPolicy Bypass -File integraciones\coucou\instalar.ps1 -Dev
#>
param(
  [string]$Destino = (Join-Path $env:USERPROFILE "coucou"),
  [switch]$Dev
)

$ErrorActionPreference = "Stop"
# Commit de Louis-CFM/coucou sobre el que está hecho plata.patch.
$Commit = "5ae7bd946ab51493b5ddaebdc5f449f269ebb421"
$Parche = Join-Path $PSScriptRoot "plata.patch"

function Paso($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Falla($texto) { Write-Host "`n$texto" -ForegroundColor Red; exit 1 }

# Los comandos nativos no cortan el script solos: hay que mirar $LASTEXITCODE.
function Correr {
  # Splatting con una variable: `@(...)` inline pasa UN solo argumento (un array),
  # y si el comando es un .ps1 (npm.ps1 según cómo se instaló Node) lo recibe entero.
  $resto = @($args | Select-Object -Skip 1)
  & $args[0] @resto
  if ($LASTEXITCODE -ne 0) { Falla "Falló: $($args -join ' ')" }
}

function Requiere($cmd, $ayuda) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { Falla "Falta '$cmd'. $ayuda" }
}

Paso "Chequeando requisitos"
Requiere git   "Instalalo desde https://git-scm.com/download/win"
Requiere node  "Instalá Node 20 o más nuevo desde https://nodejs.org"
Requiere npm   "Viene con Node: reinstalá Node desde https://nodejs.org"
Requiere cargo "Instalá Rust desde https://rustup.rs y abrí una terminal nueva"

$nodeMayor = [int]((node -v).TrimStart("v").Split(".")[0])
if ($nodeMayor -lt 20) { Falla "Node $nodeMayor es viejo: hace falta 20 o más nuevo (https://nodejs.org)." }

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$msvc = $null
if (Test-Path $vswhere) {
  $msvc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $msvc) {
  Falla ("Faltan las MSVC Build Tools. Instalá 'Visual Studio Build Tools' con la carga " +
         "'Desarrollo para el escritorio con C++': https://visualstudio.microsoft.com/visual-cpp-build-tools/")
}
if (-not (Test-Path $Parche)) { Falla "No encuentro $Parche. Corré el script desde el repo de Plata." }

Paso "Preparando el código en $Destino"
if (Test-Path (Join-Path $Destino ".git")) {
  $origen = git -C $Destino remote get-url origin
  if ($origen -notmatch "Louis-CFM/coucou") { Falla "$Destino ya existe y no es un clon de Coucou ($origen)." }
} elseif (Test-Path $Destino) {
  Falla "$Destino ya existe y no es un repo de git. Borralo o pasá otro -Destino."
} else {
  Correr git clone https://github.com/Louis-CFM/coucou $Destino
}

Push-Location $Destino
try {
  # Un `git am` que quedó a medias (el parche chocó en una corrida anterior) deja la rama `plata`
  # incompleta: se descarta y se vuelve a aplicar entera.
  if (Test-Path (Join-Path $Destino ".git\rebase-apply")) {
    Write-Host "Había un parche a medio aplicar de una corrida anterior: lo descarto y empiezo de nuevo." -ForegroundColor Yellow
    git am --abort
    Correr git checkout -q -f $Commit
    git branch -D plata
  }

  $tieneRama = git branch --list plata
  if (-not $tieneRama) {
    Correr git checkout -q -b plata $Commit
    # `git am` necesita una identidad de committer; si Git no tiene una configurada, usamos una local.
    if (-not (git config user.email)) {
      $env:GIT_COMMITTER_NAME = "Plata"
      $env:GIT_COMMITTER_EMAIL = "plata@localhost"
    }
    Correr git am --3way $Parche
    Write-Host "Parche aplicado en la rama 'plata'." -ForegroundColor Green
  } else {
    Correr git checkout -q plata
    Write-Host "La rama 'plata' ya existía: se recompila tal cual está." -ForegroundColor Yellow
  }

  Set-Location windows
  Paso "Instalando dependencias (npm install)"
  Correr npm install --no-audit --no-fund

  if ($Dev) {
    Paso "Abriendo en modo desarrollo (Ctrl+C para cortar)"
    Correr npm run tauri dev
  } else {
    Paso "Compilando el instalador (la primera vez tarda varios minutos)"
    Correr npm run pack
    $instalador = Join-Path (Get-Location) "release\Coucou-Windows-setup.exe"
    if (Test-Path $instalador) {
      Write-Host "`nListo: $instalador" -ForegroundColor Green
      Write-Host "Se instala solo para tu usuario, sin pedir administrador."
      Start-Process $instalador
    } else {
      Write-Host "`nCompiló, pero no encuentro el instalador. Mirá windows\release\ o usá src-tauri\target\release\coucou.exe" -ForegroundColor Yellow
    }
  }
} finally {
  Pop-Location
}

Write-Host @"

Siguiente paso: configuralo desde el ícono de Mochi en la bandeja → Settings…
  · Claude Code → Install hooks…
  · Claude      → tu API key de Anthropic (opcional, para el chat)
  · Plata       → Secret = app_secrets.COUCOU_SECRET (ver integraciones\coucou\README.md)
  · Railway     → Account token de https://railway.com/account/tokens
"@
