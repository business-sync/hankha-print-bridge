<#
.SYNOPSIS
  Installs the Hankha Print Bridge and starts it automatically at boot.

.DESCRIPTION
  The scriptable equivalent of the Setup.exe, for IT rollout. Run from an elevated PowerShell
  in the folder this script was unzipped into.

  Autostart is a scheduled task rather than a Windows service on purpose: the bridge is a plain
  console program and does not implement the service-control handshake, so `sc.exe create`
  would produce a service that dies with error 1053 on every start. A task avoids needing a
  third-party service wrapper.

.PARAMETER Lan
  Also accept connections from other computers on this network, and open TCP 9200 on the
  private firewall profile. Off by default: a POS served over https can only reach a bridge on
  localhost, so most tills never need it.

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Lan
#>
[CmdletBinding()]
param(
  [switch]$Lan,
  [int]$Port = 9200
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Hankha Print Bridge'
$InstallDir = Join-Path $env:ProgramFiles 'Hankha\Print Bridge'
$DataDir = Join-Path $env:ProgramData 'Hankha\PrintBridge'
$Source = $PSScriptRoot

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (right-click PowerShell, "Run as administrator").'
  }
}

Assert-Admin

foreach ($file in @('hankha-print-bridge.exe', 'print-bridge.cmd')) {
  if (-not (Test-Path (Join-Path $Source $file))) {
    throw "$file is missing from $Source — unzip the whole archive before running this."
  }
}

Write-Host 'Stopping any running copy...'
# Not an error when absent: this is also the upgrade path.
schtasks /End /TN "$TaskName" 2>$null | Out-Null
schtasks /Delete /TN "$TaskName" /F 2>$null | Out-Null
Get-Process -Name 'hankha-print-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "Installing to $InstallDir..."
New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, (Join-Path $DataDir 'logs') | Out-Null
Copy-Item (Join-Path $Source 'hankha-print-bridge.exe') $InstallDir -Force
Copy-Item (Join-Path $Source 'print-bridge.cmd') $InstallDir -Force
if (Test-Path (Join-Path $Source 'uninstall.ps1')) {
  Copy-Item (Join-Path $Source 'uninstall.ps1') $InstallDir -Force
}

$envFile = Join-Path $DataDir 'bridge.env'
if ($Lan) {
  Write-Host 'Allowing other terminals on this network...'
  @(
    '# Overrides read by print-bridge.cmd at startup.',
    'PRINT_BRIDGE_HOST=0.0.0.0',
    "PRINT_BRIDGE_PORT=$Port"
  ) | Set-Content -Path $envFile -Encoding ASCII
  netsh advfirewall firewall delete rule name="Hankha Print Bridge" 2>$null | Out-Null
  netsh advfirewall firewall add rule name="Hankha Print Bridge" dir=in action=allow `
    protocol=TCP localport=$Port profile=private | Out-Null
} else {
  # A previous -Lan install would otherwise keep listening wide after a plain reinstall.
  Remove-Item $envFile -ErrorAction SilentlyContinue
  netsh advfirewall firewall delete rule name="Hankha Print Bridge" 2>$null | Out-Null
  if ($Port -ne 9200) {
    @('PRINT_BRIDGE_HOST=127.0.0.1', "PRINT_BRIDGE_PORT=$Port") |
      Set-Content -Path $envFile -Encoding ASCII
  }
}

Write-Host 'Registering the startup task...'
$runner = '"' + (Join-Path $InstallDir 'print-bridge.cmd') + '"'
schtasks /Create /TN "$TaskName" /TR $runner /SC ONSTART /RU SYSTEM /RL HIGHEST /F | Out-Null
schtasks /Run /TN "$TaskName" | Out-Null

Write-Host 'Waiting for the bridge to answer...'
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    if ($health.ok) {
      Write-Host ''
      Write-Host "Hankha Print Bridge v$($health.version) is running on http://127.0.0.1:$Port" -ForegroundColor Green
      Write-Host 'Open the POS terminal on this computer, then Settings -> Printing.'
      exit 0
    }
  } catch { Start-Sleep -Milliseconds 750 }
}

$log = Join-Path $DataDir 'logs\bridge.log'
Write-Warning "Installed, but nothing answered on port $Port within 20 seconds."
Write-Warning "Most likely another program already holds that port. Check $log"
if (Test-Path $log) { Get-Content $log -Tail 20 }
exit 1
