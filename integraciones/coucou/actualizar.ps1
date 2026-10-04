<#
.SYNOPSIS
  Mantiene Coucou (y el agente de Plata) al día en esta PC, sin abrir Claude Code.

.DESCRIPTION
  Lo lanza la propia isla (actualizar.rs en plata.patch), por actualizar.vbs para que no abra ninguna
  ventana: a los 5 minutos de arrancar y después cada 3 horas. En cada pasada:
  1. Trae la rama `main` del repo de Plata. Sin red, no hace nada.
  2. Si plata.patch cambió desde la última instalación, recompila Coucou en esta PC con el parche nuevo
     (lo mismo que instalar.ps1) y lo reinstala en silencio. La isla se cierra unos segundos y vuelve.
  3. Si el repo `agentes` tiene commits nuevos, los baja (solo si avanza limpio) y reinicia la isla,
     que al arrancar vuelve a levantar el agente.

  Compila acá en vez de bajar un instalador de GitHub a propósito: el instalador de Coucou compilado en
  la nube, sin firmar, Defender lo marcaba como troyano. Lo que se instala sale del código del repo.

  No pisa trabajo a medias: si en %USERPROFILE%\coucou hay cambios sin commitear, o commits que no
  vinieron de un parche, no recompila y lo anota en el log. Con -Forzar lo hace igual.

  Log: %LOCALAPPDATA%\Coucou\actualizar.log

  Por qué la isla y no una tarea programada: en algunas PCs el Programador de tareas deja las tareas
  del usuario "en cola" para siempre, sin correrlas ni dar error. La isla corre cada vez que hay algo
  que actualizar.

.EXAMPLE
  # Buscar actualizaciones ahora, a mano.
  powershell -ExecutionPolicy Bypass -File integraciones\coucou\actualizar.ps1
#>
param(
  # Lo usa instalar.ps1 al terminar: anota qué parche quedó instalado ("desconocido" si no se sabe).
  [string]$MarcarInstalado,
  # Recompila aunque el parche no haya cambiado o haya trabajo local en el clon de Coucou.
  [switch]$Forzar,
  [string]$Rama = "main",
  # Pruebas: usa la rama local tal cual, sin `git fetch`.
  [switch]$SinRed,
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Coucou = (Join-Path $env:USERPROFILE "coucou"),
  [string]$Agentes = (Join-Path $env:USERPROFILE "agentes"),
  # Interno: ya es la copia nueva del script, bajada de la rama.
  [switch]$Relanzado
)

$Datos = Join-Path $env:LOCALAPPDATA "Coucou"
$ArchivoEstado = Join-Path $Datos "actualizacion.json"
$Log = Join-Path $Datos "actualizar.log"
$Exe = Join-Path $Datos "coucou.exe"
$EsteScript = Join-Path $Repo "integraciones\coucou\actualizar.ps1"
$RutaParche = "integraciones/coucou/plata.patch"

New-Item -ItemType Directory -Force $Datos | Out-Null

function Anotar($texto) {
  $linea = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $texto
  Write-Host $linea
  try {
    if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Move-Item -Force $Log "$Log.1" }
    Add-Content -Path $Log -Value $linea -Encoding UTF8
  } catch {}
}

function LeerEstado {
  if (Test-Path $ArchivoEstado) {
    try { return Get-Content $ArchivoEstado -Raw | ConvertFrom-Json } catch {}
  }
  return $null
}

function GuardarEstado($parche, $head) {
  $o = [ordered]@{ parche = $parche; coucou_head = $head; cuando = (Get-Date).ToString("s") }
  ($o | ConvertTo-Json) | Set-Content -Path $ArchivoEstado -Encoding UTF8
}

# git sin que PowerShell 5 convierta su stderr en errores: se mira $LASTEXITCODE.
function G {
  $salida = & git @args 2>$null
  return $salida
}

if ($PSBoundParameters.ContainsKey("MarcarInstalado")) {
  GuardarEstado $MarcarInstalado ((G -C $Coucou rev-parse HEAD) -join "")
  exit 0
}

# ── Una pasada ───────────────────────────────────────────────────────────────

# Una sola a la vez: la que lanza la isla y una corrida a mano no compilan juntas.
$candado = New-Object System.Threading.Mutex($false, "Local\CoucouActualizar")
if (-not $candado.WaitOne(0)) { Anotar "Ya hay otra actualización corriendo."; exit 0 }

try {
  if (-not (Test-Path (Join-Path $Repo ".git"))) { Anotar "No encuentro el repo de Plata en $Repo."; exit 1 }

  if ($SinRed) {
    $Ref = $Rama
  } else {
    G -C $Repo fetch -q origin $Rama | Out-Null
    if ($LASTEXITCODE -ne 0) { Anotar "Sin red o sin acceso a GitHub: pruebo en la próxima."; exit 0 }
    $Ref = "origin/$Rama"
  }

  # El script se actualiza a sí mismo: si en la rama hay otra versión, corre esa.
  if (-not $Relanzado) {
    $nuevo = (G -C $Repo rev-parse --verify -q "${Ref}:integraciones/coucou/actualizar.ps1") -join ""
    $actual = (G -C $Repo hash-object $EsteScript) -join ""
    if ($nuevo -and $actual -and $nuevo -ne $actual) {
      $copia = Join-Path $env:TEMP "coucou-actualizar.ps1"
      & cmd /c "git -C `"$Repo`" cat-file blob $nuevo > `"$copia`" 2>nul"
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $copia) -or (Get-Item $copia).Length -lt 1000) {
        Anotar "No pude extraer la versión nueva de este script: sigo con esta."
        $nuevo = $null
      }
    }
    if ($nuevo -and $actual -and $nuevo -ne $actual) {
      Anotar "Hay una versión nueva de este script: corro esa."
      $candado.ReleaseMutex(); $candado = $null
      $extra = @("-Relanzado", "-Repo", $Repo, "-Rama", $Rama, "-Coucou", $Coucou, "-Agentes", $Agentes)
      if ($Forzar) { $extra += "-Forzar" }
      if ($SinRed) { $extra += "-SinRed" }
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $copia @extra
      exit $LASTEXITCODE
    }
  }

  $estado = LeerEstado
  $reiniciarIsla = $false
  $instalado = $false

  # ── Coucou ──
  $blob = (G -C $Repo rev-parse --verify -q "${Ref}:$RutaParche") -join ""
  if (-not $blob) {
    Anotar "$Ref todavía no tiene $RutaParche."
  } elseif ($estado -and $estado.parche -eq $blob -and -not $Forzar) {
    # Al día.
  } elseif (-not (Test-Path (Join-Path $Coucou ".git"))) {
    Anotar "No está el clon de Coucou en ${Coucou}: corré instalar.ps1 una vez."
  } else {
    $sucio = @(G -C $Coucou status --porcelain --untracked-files=no | Where-Object { $_ -notmatch "package-lock\.json$" })
    $head = (G -C $Coucou rev-parse HEAD) -join ""
    $tocado = $estado -and $estado.coucou_head -and $estado.coucou_head -ne $head
    if (($sucio.Count -gt 0 -or $tocado) -and -not $Forzar) {
      Anotar "Hay un parche nuevo, pero en $Coucou hay trabajo que no salió de un parche. No lo piso (usá -Forzar)."
    } else {
      $instalar = (G -C $Repo show "${Ref}:integraciones/coucou/instalar.ps1") -join "`n"
      if ($instalar -notmatch '\$Commit = "([0-9a-f]{40})"') { Anotar "No encuentro `$Commit en instalar.ps1."; exit 1 }
      $base = $Matches[1]
      Anotar "Parche nuevo ($($blob.Substring(0, 7))): recompilo Coucou sobre $($base.Substring(0, 7))."

      $parche = Join-Path $env:TEMP "coucou-plata.patch"
      & cmd /c "git -C `"$Repo`" cat-file blob $blob > `"$parche`""

      if (-not (G -C $Coucou cat-file -t $base)) { G -C $Coucou fetch -q origin | Out-Null }
      if (Test-Path (Join-Path $Coucou ".git\rebase-apply")) { G -C $Coucou am --abort | Out-Null }
      G -C $Coucou checkout -q -f -B plata $base | Out-Null
      if ($LASTEXITCODE -ne 0) { Anotar "No pude pasar el clon a $base."; exit 1 }
      if (-not (G -C $Coucou config user.email)) {
        $env:GIT_COMMITTER_NAME = "Plata"; $env:GIT_COMMITTER_EMAIL = "plata@localhost"
      }
      G -C $Coucou am -q --3way $parche | Out-Null
      if ($LASTEXITCODE -ne 0) {
        G -C $Coucou am --abort | Out-Null
        Anotar "El parche no aplica sobre $($base.Substring(0, 7)). Queda instalada la versión anterior."
        exit 1
      }

      # Compilar con prioridad baja: corre mientras trabajás y no se tiene que notar.
      $win = Join-Path $Coucou "windows"
      $salida = Join-Path $env:TEMP "coucou-build.log"
      $p = Start-Process cmd.exe -ArgumentList "/c npm install --no-audit --no-fund && npm run pack" `
        -WorkingDirectory $win -RedirectStandardOutput $salida -RedirectStandardError "$salida.err" `
        -NoNewWindow -PassThru
      $null = $p.Handle
      try { $p.PriorityClass = "BelowNormal" } catch {}
      $p.WaitForExit()
      if ($p.ExitCode -ne 0) {
        Anotar "Falló la compilación (ver $salida y $salida.err). Queda instalada la versión anterior."
        exit 1
      }

      $setup = Join-Path $win "release\Coucou-Windows-setup.exe"
      $corria = @(Get-Process -Name coucou -ErrorAction SilentlyContinue).Count -gt 0
      Get-Process -Name coucou -ErrorAction SilentlyContinue | Stop-Process -Force
      Start-Sleep -Seconds 2
      $inst = Start-Process $setup -ArgumentList "/S" -PassThru -Wait
      if ($inst.ExitCode -ne 0) { Anotar "El instalador terminó con código $($inst.ExitCode)." }
      if ($corria -and (Test-Path $Exe)) { Start-Process $Exe }
      $instalado = $true
      GuardarEstado $blob ((G -C $Coucou rev-parse HEAD) -join "")
      Anotar "Coucou actualizado e instalado."
    }
  }

  # ── Agente de Plata ──
  if (Test-Path (Join-Path $Agentes ".git")) {
    $ramaAg = (G -C $Agentes rev-parse --abbrev-ref HEAD) -join ""
    if (-not $SinRed) { G -C $Agentes fetch -q origin | Out-Null }
    $atras = [int]((G -C $Agentes rev-list --count "HEAD..origin/$ramaAg") -join "")
    if ($LASTEXITCODE -eq 0 -and $atras -gt 0) {
      $sucioAg = @(G -C $Agentes status --porcelain --untracked-files=no)
      if ($sucioAg.Count -gt 0) {
        Anotar "agentes tiene $atras commits nuevos, pero hay cambios locales: no lo toco."
      } else {
        $lockAntes = (G -C $Agentes rev-parse --verify -q "HEAD:package-lock.json") -join ""
        G -C $Agentes merge -q --ff-only "origin/$ramaAg" | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Anotar "agentes no avanza limpio (¿commits locales?): no lo toco."
        } else {
          $lockDespues = (G -C $Agentes rev-parse --verify -q "HEAD:package-lock.json") -join ""
          if ($lockAntes -ne $lockDespues) {
            Push-Location $Agentes
            & cmd /c "npm install --no-audit --no-fund > `"$env:TEMP\agentes-npm.log`" 2>&1"
            Pop-Location
          }
          Anotar "agentes: $atras commits nuevos bajados."
          $reiniciarIsla = $true
        }
      }
    }
  }

  # El agente viejo sigue escuchando en el 8787 hasta que alguien lo corte. La isla lo
  # vuelve a levantar al arrancar, así que se reinician los dos.
  if ($reiniciarIsla -and -not $instalado) {
    $corria = @(Get-Process -Name coucou -ErrorAction SilentlyContinue).Count -gt 0
    Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { & taskkill /T /F /PID $_.OwningProcess 2>$null | Out-Null }
    if ($corria) {
      Get-Process -Name coucou -ErrorAction SilentlyContinue | Stop-Process -Force
      Start-Sleep -Seconds 2
      if (Test-Path $Exe) { Start-Process $Exe }
    }
    Anotar "Isla y agente reiniciados."
  }
} finally {
  if ($candado) { $candado.ReleaseMutex() }
}
