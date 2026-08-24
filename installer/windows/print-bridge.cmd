@echo off
rem Launcher used by the "Hankha Print Bridge" scheduled task.
rem
rem It exists for two reasons: the task runs as SYSTEM with nowhere to show output, so the log
rem has to be a file; and the bind address has to be overridable after install without editing
rem the task definition.

setlocal enabledelayedexpansion

set "PRINT_BRIDGE_PORT=9200"
rem Loopback by default: a POS served over https can only reach a bridge on localhost, so a
rem till gains nothing from listening wider. The installer's "serve other terminals" option
rem writes bridge.env to override this.
set "PRINT_BRIDGE_HOST=127.0.0.1"

set "DATADIR=%ProgramData%\Hankha\PrintBridge"
set "ENVFILE=%DATADIR%\bridge.env"
set "LOGDIR=%DATADIR%\logs"
set "LOGFILE=%LOGDIR%\bridge.log"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" 2>nul

if exist "%ENVFILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENVFILE%") do (
    if not "%%~A"=="" set "%%~A=%%~B"
  )
)

rem Keep one previous log. Without this the file grows for the life of the till, and it is the
rem first thing anyone is asked to send when printing breaks.
if exist "%LOGFILE%" (
  for %%F in ("%LOGFILE%") do if %%~zF GTR 5242880 (
    move /y "%LOGFILE%" "%LOGDIR%\bridge.log.1" >nul 2>&1
  )
)

echo. >> "%LOGFILE%"
echo ==== started %DATE% %TIME% ==== >> "%LOGFILE%"
"%~dp0hankha-print-bridge.exe" >> "%LOGFILE%" 2>&1
