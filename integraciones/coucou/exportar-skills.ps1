<#
.SYNOPSIS
  En la PC VIEJA: empaqueta las skills de Claude Code que no están en git, para llevarlas a otra PC.

.DESCRIPTION
  Comprime %USERPROFILE%\.claude\skills entero (conciliar-resumen, conciliar-extracto,
  informe-mensual y cualquier otra que tengas) en un zip en el Escritorio. Después, en la PC nueva:

    powershell -ExecutionPolicy Bypass -File integraciones\coucou\pc-nueva.ps1 -Skills <ruta al zip>

  No lleva claves: el .env de agentes y las credenciales de Coucou se cargan de nuevo en la PC nueva.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File integraciones\coucou\exportar-skills.ps1
#>
param(
  [string]$Salida = (Join-Path ([Environment]::GetFolderPath("Desktop")) "skills-claude.zip")
)

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".claude\skills"

if (-not (Test-Path $dir)) { Write-Host "No hay skills en $dir." -ForegroundColor Red; exit 1 }

$skills = Get-ChildItem $dir -Directory
if (-not $skills) { Write-Host "$dir está vacía." -ForegroundColor Red; exit 1 }

foreach ($s in "conciliar-resumen", "conciliar-extracto", "informe-mensual") {
  if (-not (Test-Path (Join-Path $dir "$s\SKILL.md"))) { Write-Host "Ojo: falta $s en esta PC." -ForegroundColor Yellow }
}

Compress-Archive -Path (Join-Path $dir "*") -DestinationPath $Salida -Force
Write-Host "`nListo: $Salida" -ForegroundColor Green
Write-Host "Skills: $(($skills | ForEach-Object Name) -join ', ')"
Write-Host "Llevalo a la PC nueva (Drive, mail, pendrive) y pasalo con -Skills a pc-nueva.ps1."
