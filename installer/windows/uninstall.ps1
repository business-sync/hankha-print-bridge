<#
.SYNOPSIS
  Removes the Hankha Print Bridge. Run from an elevated PowerShell.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$TaskName = 'Hankha Print Bridge'
$InstallDir = Join-Path $env:ProgramFiles 'Hankha\Print Bridge'
$DataDir = Join-Path $env:ProgramData 'Hankha\PrintBridge'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (right-click PowerShell, "Run as administrator").'
}

# Match install.ps1: the ScheduledTasks cmdlets, not schtasks.exe.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-Process -Name 'hankha-print-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

netsh advfirewall firewall delete rule name="Hankha Print Bridge" 2>$null | Out-Null
Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $DataDir 'bridge.env') -ErrorAction SilentlyContinue

# Logs stay: they are the only record of why a till stopped printing.
Write-Host "Hankha Print Bridge removed. Logs kept in $DataDir\logs"
