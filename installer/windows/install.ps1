<#
.SYNOPSIS
  Installs the Hankha Print Bridge and keeps it running.

.DESCRIPTION
  The single implementation of "install". The Setup.exe calls this too, so the wizard and a
  scripted rollout cannot drift apart or fail in different ways.

  Autostart is a scheduled task rather than a Windows service on purpose: the bridge is a plain
  console program and does not implement the service-control handshake, so `sc.exe create`
  would produce a service that dies with error 1053 on every start. A task avoids needing a
  third-party service wrapper.

  Registration goes through the ScheduledTasks cmdlets rather than schtasks.exe. `schtasks /TR`
  takes the whole command as ONE string, so a path under "Program Files" has to survive nested
  quoting through the shell, CreateProcess and schtasks' own parser — three chances to get it
  wrong, on the one thing that cannot be tested from a build machine. -Execute takes the path
  as a value, and there is nothing to quote.

.PARAMETER Lan
  Also accept connections from other computers on this network, and open TCP 9200 on the
  private firewall profile. Off by default: a POS served over https can only reach a bridge on
  localhost, so most tills never need it.

.PARAMETER SkipCopy
  Files are already in place (how Setup.exe calls this) — just register and start.

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Lan
#>
[CmdletBinding()]
param(
  [switch]$Lan,
  [switch]$SkipCopy,
  [int]$Port = 9200,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Hankha\Print Bridge')
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Hankha Print Bridge'
$DataDir = Join-Path $env:ProgramData 'Hankha\PrintBridge'
$LogFile = Join-Path $DataDir 'logs\bridge.log'
$Source = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (right-click PowerShell, "Run as administrator").'
}

# ---------------------------------------------------------------- files

if (-not $SkipCopy) {
  foreach ($file in @('hankha-print-bridge.exe', 'print-bridge.cmd')) {
    if (-not (Test-Path (Join-Path $Source $file))) {
      throw "$file is missing from $Source - unzip the whole archive before running this."
    }
  }
}

Write-Host 'Stopping any running copy...'
# Never an error when absent: this is also the upgrade path.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-Process -Name 'hankha-print-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 700

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir, (Split-Path $LogFile) | Out-Null

if (-not $SkipCopy -and ((Resolve-Path $Source).Path -ne (Resolve-Path $InstallDir).Path)) {
  Write-Host "Installing to $InstallDir..."
  foreach ($file in @('hankha-print-bridge.exe', 'print-bridge.cmd', 'uninstall.ps1', 'status.ps1')) {
    $from = Join-Path $Source $file
    if (Test-Path $from) { Copy-Item $from $InstallDir -Force }
  }
}

# ---------------------------------------------------------------- bind address

$envFile = Join-Path $DataDir 'bridge.env'
if ($Lan) {
  Write-Host 'Allowing other terminals on this network...'
  @('# Overrides read by print-bridge.cmd at startup.',
    'PRINT_BRIDGE_HOST=0.0.0.0',
    "PRINT_BRIDGE_PORT=$Port") | Set-Content -Path $envFile -Encoding ASCII
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

# ---------------------------------------------------------------- scheduled task

Write-Host 'Registering the startup task...'
$action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir 'print-bridge.cmd')
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# ExecutionTimeLimit zero means "no limit" — the default of 3 days would otherwise kill a till
# that stays up through a long trading week.
#
# RestartInterval/-Count are the closest thing Windows has to launchd's KeepAlive, which the
# macOS build relies on. Without them a crash at 11am means every print fails silently until
# the next reboot, and nothing on screen connects the two.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999

$trigger = New-ScheduledTaskTrigger -AtStartup

# Backstop: RestartOnFailure only fires when the task ENDS in an error. A process that exits
# cleanly, or is killed, leaves the task simply "not running" and nothing brings it back until
# reboot. A repeating trigger re-runs it every five minutes, which IgnoreNew turns into a no-op
# whenever it is already up — so this costs nothing and self-heals everything else.
try {
  $heartbeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
  $trigger.Repetition = $heartbeat.Repetition
} catch {
  Write-Warning "Could not add the 5-minute self-heal trigger ($($_.Exception.Message)). The bridge will still start at boot and restart after a crash."
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
  -Settings $settings -Trigger $trigger `
  -Description 'Lets the POS terminal print to network printers.' -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

# ---------------------------------------------------------------- verify

Write-Host 'Waiting for the bridge to answer...'
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
    if ($health.ok) {
      Write-Host ''
      Write-Host "Hankha Print Bridge v$($health.version) is running on http://127.0.0.1:$Port" -ForegroundColor Green
      Write-Host 'Open the POS terminal on this computer, then Settings > Printing.'
      exit 0
    }
  } catch { Start-Sleep -Milliseconds 750 }
}

# An installer that reports success while nothing is listening is the failure this replaces.
Write-Warning "Installed, but nothing answered on port $Port within 25 seconds."
Write-Warning "Most likely another program already holds that port. Check $LogFile"
if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
exit 1
