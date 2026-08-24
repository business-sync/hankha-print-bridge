<#
.SYNOPSIS
  Shows whether the Hankha Print Bridge is running. Opened from the Start Menu.

.DESCRIPTION
  The Windows counterpart to opening Hankha Print Bridge.app on a Mac. Without it the only
  thing the Start Menu could offer was a link to /health, which shows raw JSON to someone
  whose actual question is "is the printer thing working?".

  Deliberately read-only and un-elevated: anyone on the till can check, and nothing here can
  break the install. Removal stays in Settings > Apps, where Windows users already look.
#>
[CmdletBinding()]
param([int]$Port = 9200)

Add-Type -AssemblyName System.Windows.Forms

$TaskName = 'Hankha Print Bridge'
$DataDir = Join-Path $env:ProgramData 'Hankha\PrintBridge'
$LogFile = Join-Path $DataDir 'logs\bridge.log'

# An override written by `install.ps1 -Lan` (or a non-default port) is the truth about where
# the bridge listens; reading it stops this dialog reporting a port nothing is on.
$envFile = Join-Path $DataDir 'bridge.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*PRINT_BRIDGE_PORT\s*=\s*(\d+)\s*$') { $Port = [int]$Matches[1] }
  }
}

$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 } catch {}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($health -and $health.ok) {
  $uptime = [TimeSpan]::FromSeconds([int]$health.uptime_s)
  $since = if ($uptime.TotalMinutes -lt 2) { 'just started' }
           elseif ($uptime.TotalHours -lt 1) { "up $([int]$uptime.TotalMinutes) minutes" }
           elseif ($uptime.TotalDays -lt 2) { "up $([int]$uptime.TotalHours) hours" }
           else { "up $([int]$uptime.TotalDays) days" }

  $auto = if ($task) { 'It starts automatically when this computer boots.' }
          else { 'WARNING: it is running, but is NOT set to start automatically. Run the installer again.' }

  $text = @"
Hankha Print Bridge v$($health.version) is running.

Address:  http://127.0.0.1:$Port
Computer: $($health.hostname)
Status:   $since

$auto

In the POS terminal, open Settings > Printing to use it.
"@
  [System.Windows.Forms.MessageBox]::Show(
    $text, 'Hankha Print Bridge',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
  exit 0
}

# Not answering. Say which of the two very different causes it is, because they need different
# people: "not installed" is a rollout problem, "installed but dead" is a this-machine problem.
$why = if (-not $task) {
  "The Print Bridge is not installed on this computer.`n`nRun the Setup.exe to install it."
} else {
  "The Print Bridge is installed but not answering on port $Port.`n`nThe usual cause is another program using that port. The reason is in:`n$LogFile`n`nRestarting this computer normally fixes it."
}

[System.Windows.Forms.MessageBox]::Show(
  $why, 'Hankha Print Bridge',
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
exit 1
