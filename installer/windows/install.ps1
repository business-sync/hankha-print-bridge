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

  An upgrade KEEPS this setting: running install.ps1 again without -Lan leaves a bridge that was
  installed with -Lan serving the network (and re-adds its firewall rule). Pass -NoLan to turn it
  off. (Until M5 a plain reinstall silently switched it off.)

.PARAMETER NoLan
  Turn the legacy 9200 network option off, deleting bridge.env and its firewall rule.

.PARAMETER LanApi
  The signed LAN print API for tablets and phones (port 9201, see docs/printing). Three values:
    keep  (default) leave it exactly as it is: an enabled <DataDir>\lan.json stays enabled, and
          its firewall rule is re-asserted; a bridge that never had it stays without it.
    on    write lan.json {enabled, port 9201, host 0.0.0.0} and open TCP 9201 on the PRIVATE
          firewall profile only (never Public or Domain).
    off   delete lan.json and the rule. The bridge's LAN key (lan-key.json) is kept, so turning
          it back on does not invalidate tickets already issued.
  With no lan.json the bridge opens no new port at all.

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
  [switch]$NoLan,
  [ValidateSet('keep', 'on', 'off')][string]$LanApi = 'keep',
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

# Upgrades keep what the operator chose (hazard 17): the Setup.exe runs this script with no
# network flag on every upgrade, and the old code read "no -Lan" as "turn it off".
$envText = if (Test-Path $envFile) { Get-Content -Path $envFile -ErrorAction SilentlyContinue } else { @() }
$hadLan = [bool]($envText | Where-Object { $_ -match '^\s*PRINT_BRIDGE_HOST\s*=\s*0\.0\.0\.0\s*$' })
if ($hadLan -and -not $PSBoundParameters.ContainsKey('Port')) {
  $kept = $envText | Where-Object { $_ -match '^\s*PRINT_BRIDGE_PORT\s*=\s*(\d{2,5})\s*$' } | Select-Object -First 1
  if ($kept -and $kept -match '(\d{2,5})') { $Port = [int]$Matches[1] }
}

if ($Lan -or ($hadLan -and -not $NoLan)) {
  Write-Host 'Allowing other terminals on this network...'
  @('# Overrides read by print-bridge.cmd at startup.',
    'PRINT_BRIDGE_HOST=0.0.0.0',
    "PRINT_BRIDGE_PORT=$Port") | Set-Content -Path $envFile -Encoding ASCII
  netsh advfirewall firewall delete rule name="Hankha Print Bridge" 2>$null | Out-Null
  netsh advfirewall firewall add rule name="Hankha Print Bridge" dir=in action=allow `
    protocol=TCP localport=$Port profile=private | Out-Null
} else {
  # -NoLan, or a bridge that never had it: a previous -Lan install must not keep listening wide.
  Remove-Item $envFile -ErrorAction SilentlyContinue
  netsh advfirewall firewall delete rule name="Hankha Print Bridge" 2>$null | Out-Null
  if ($Port -ne 9200) {
    @('PRINT_BRIDGE_HOST=127.0.0.1', "PRINT_BRIDGE_PORT=$Port") |
      Set-Content -Path $envFile -Encoding ASCII
  }
}

# ---------------------------------------------------------------- LAN print API (port 9201)
#
# The bridge reads <DataDir>\lan.json at startup; without it no extra port is opened. This block
# only writes or removes that file and the firewall rule beside it - the bridge does the rest.
# Written as ASCII on purpose: Windows PowerShell's "UTF8" adds a byte-order mark, and the
# bridge's JSON parser refuses a file that starts with one (it would then stay OFF, silently).
# print-bridge.cmd never touches lan.json, so a reboot or a task restart keeps the choice.

$lanFile = Join-Path $DataDir 'lan.json'
$lanRule = 'Hankha Print Bridge LAN API'
$lanPort = 9201

function Get-LanApiState {
  # Returns the port when lan.json says {"enabled": true}, otherwise $null. Never throws.
  try {
    if (-not (Test-Path $lanFile)) { return $null }
    $c = Get-Content -Raw -Path $lanFile | ConvertFrom-Json
    if ($c.enabled -ne $true) { return $null }
    if ($c.port -is [int] -or $c.port -is [long]) { return [int]$c.port }
    return 9201
  } catch { return $null }
}

switch ($LanApi) {
  'on' {
    Write-Host 'Turning on the LAN print API (port 9201, private networks only)...'
    '{"enabled":true,"port":9201,"host":"0.0.0.0"}' | Set-Content -Path $lanFile -Encoding ASCII
    $lanPort = 9201
    $lanActive = $true
  }
  'off' {
    Write-Host 'Turning off the LAN print API...'
    Remove-Item $lanFile -ErrorAction SilentlyContinue
    $lanActive = $false
  }
  default {
    $kept = Get-LanApiState
    $lanActive = ($null -ne $kept)
    if ($lanActive) { $lanPort = $kept }
  }
}

netsh advfirewall firewall delete rule name="$lanRule" 2>$null | Out-Null
if ($lanActive) {
  # profile=private: the rule never applies on a Public or Domain network.
  netsh advfirewall firewall add rule name="$lanRule" dir=in action=allow `
    protocol=TCP localport=$lanPort profile=private | Out-Null
  Write-Host "LAN print API is ON (TCP $lanPort, private network profile)."
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

# Backstop: RestartOnFailure only fires when the task ENDS in an error. A process that exits
# cleanly, or is killed, leaves the task simply "not running" and nothing brings it back until
# reboot. A repeating trigger re-runs it every five minutes, which IgnoreNew turns into a no-op
# whenever it is already up — so this costs nothing and self-heals everything else.
#
# No -RepetitionDuration, on purpose: leaving it out is how the task XML says "indefinitely".
# The old idiom, ([TimeSpan]::MaxValue), is serialised as P99999999DT23H59M59S, which Task
# Scheduler on current Windows 10/11 builds rejects at registration (0x80041318, "The task XML
# contains a value which is incorrectly formatted or out of range") — and it rejected the WHOLE
# task, so nothing was registered and every install died right here.
$heartbeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$withHeartbeat = New-ScheduledTaskTrigger -AtStartup
$withHeartbeat.Repetition = $heartbeat.Repetition

$description = 'Lets the POS terminal print to network printers.'
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
    -Settings $settings -Trigger $withHeartbeat -Description $description -Force | Out-Null
} catch {
  # The heartbeat is the only part of the task that varies by Windows build. Boot + restart-
  # on-failure alone is still a working install, so never fail the whole setup over the extra.
  # If THIS registration fails too, the error is real and the script stops on it as before.
  Write-Warning "Could not register the 5-minute self-heal trigger ($($_.Exception.Message)). The bridge will still start at boot and restart after a crash."
  Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
    -Settings $settings -Trigger (New-ScheduledTaskTrigger -AtStartup) -Description $description -Force | Out-Null
}

Start-ScheduledTask -TaskName $TaskName

# ---------------------------------------------------------------- verify

Write-Host 'Waiting for the bridge to answer...'
$deadline = (Get-Date).AddSeconds(25)
$sawProcess = $false
while ((Get-Date) -lt $deadline) {
  if (Get-Process -Name 'hankha-print-bridge' -ErrorAction SilentlyContinue) { $sawProcess = $true }
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
if (-not $sawProcess) {
  # hankha-print-bridge.exe is unsigned (see scripts/package.mjs), and a `bun build --compile`
  # binary is exactly the shape antivirus heuristics distrust — a single self-extracting exe
  # with an embedded runtime. It never showing up in the process list at all, with no Windows
  # error surfaced anywhere, is what that looks like: something removed or blocked it the
  # instant Task Scheduler tried to run it, before it could write even one log line.
  Write-Warning 'hankha-print-bridge.exe never appeared in the process list -- something stopped it from starting at all.'
  Write-Warning 'The most likely cause is antivirus or Windows Defender quarantining the new .exe (it is unsigned).'
  Write-Warning 'Open Windows Security > Virus & threat protection > Protection history and look for an action'
  Write-Warning "on $InstallDir\hankha-print-bridge.exe. If it's there, restore the file and add an exclusion for"
  Write-Warning "$InstallDir, then run this installer again."
} else {
  Write-Warning "hankha-print-bridge.exe started and then stopped, or is hung. Check $LogFile"
}
if (Test-Path $LogFile) { Get-Content $LogFile -Tail 40 }

# A crash this early (before the log file itself could be opened, or a missing dependency the
# process can't recover from) lands in the Application event log, not bridge.log -- that file is
# opened by print-bridge.cmd's own redirect, which needs the process to have started at all.
$crashEvents = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000 } -MaxEvents 30 -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -like '*hankha-print-bridge.exe*' } | Select-Object -First 3
if ($crashEvents) {
  Write-Warning 'Windows Event Viewer recorded a crash for hankha-print-bridge.exe:'
  foreach ($event in $crashEvents) {
    $firstLine = ($event.Message -split "`r?`n")[0]
    Write-Warning "  $($event.TimeCreated): $firstLine"
  }
}
exit 1
