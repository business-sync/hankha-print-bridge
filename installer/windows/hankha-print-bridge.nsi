; Hankha Print Bridge -- Windows installer
;
; Built with NSIS, cross-compiled from macOS (`brew install makensis`). `scripts/package.mjs`
; passes the version and the staging directory in with /D.
;
; Autostart is a SCHEDULED TASK, not a Windows service: the bridge is a plain console program
; and does not implement the service-control handshake, so `sc.exe create` would register a
; service that dies with error 1053 on every start. The usual workaround is bundling a service
; wrapper (WinSW/NSSM); a task avoids the extra binary entirely.
;
; Registering that task is DELEGATED to install.ps1 rather than duplicated here. Both paths
; used to call schtasks with their own quoting of a "Program Files" path, so the wizard and a
; scripted rollout could fail independently -- on the one thing that cannot be tested from the
; build machine. One implementation, one set of bugs.

Unicode true

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGE
  !define STAGE "..\..\dist-bin\windows-x64"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\..\dist-installers\hankha-print-bridge-setup.exe"
!endif

!define APPNAME     "Hankha Print Bridge"
!define TASKNAME    "Hankha Print Bridge"
!define PUBLISHER   "Hankha"
!define REGKEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\HankhaPrintBridge"
!define PORT        "9200"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Hankha\Print Bridge"
InstallDirRegKey HKLM "${REGKEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APPNAME}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "FileDescription" "Lets the POS terminal print to network printers"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "LegalCopyright"  "${PUBLISHER}"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${APPNAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This installs the small helper the POS terminal needs to print to a NETWORK receipt or kitchen printer. A browser cannot open a printer socket itself, so it asks this helper to do it.$\r$\n$\r$\nThe helper starts automatically whenever this computer boots, and the POS reaches it at http://127.0.0.1:${PORT}.$\r$\n$\r$\nInstall it on EVERY till that prints -- not on one shared computer. A POS page served over https is only allowed to talk to a helper on the same machine.$\r$\n$\r$\nAdministrator rights are required."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
; The finish page is where pairing starts, so it opens the PAIRING SCREEN by default.
;
; It used to link to /health -- raw JSON -- and nothing anywhere told an operator that a page
; existed at all: the address appeared only in a log line. Someone finishing this installer was
; expected to know to type http://127.0.0.1:9200 from memory. Now the browser opens on the code
; they are about to scan, and the run box is ticked by default so the common path is zero clicks.
!define MUI_FINISHPAGE_TITLE "The Print Bridge is running"
!define MUI_FINISHPAGE_TEXT "This computer will now show a code. Scan that code with the Hankha app on your tablet or phone to connect this computer to your shop."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenPairingPage
!define MUI_FINISHPAGE_RUN_TEXT "Show the pairing code now"
!define MUI_FINISHPAGE_LINK "Open the pairing page in a browser"
!define MUI_FINISHPAGE_LINK_LOCATION "http://127.0.0.1:${PORT}/"
!insertmacro MUI_PAGE_FINISH

; MUI_FINISHPAGE_RUN normally launches an executable; a function is used instead so the default
; browser opens the URL rather than the bridge binary being started a second time alongside the
; scheduled task that is already running it.
Function OpenPairingPage
  ExecShell "open" "http://127.0.0.1:${PORT}/"
FunctionEnd

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Print Bridge (required)" SecCore
  SectionIn RO

  ; Machine-wide install: $APPDATA becomes C:\ProgramData and $SMPROGRAMS the All Users menu.
  SetShellVarContext all

  DetailPrint "Stopping any running copy..."
  ; Also the upgrade path, so none of this is an error when nothing is installed yet.
  nsExec::ExecToLog 'schtasks /End /TN "${TASKNAME}"'
  Pop $0
  nsExec::ExecToLog 'schtasks /Delete /TN "${TASKNAME}" /F'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM hankha-print-bridge.exe'
  Pop $0
  Sleep 700

  SetOutPath "$INSTDIR"
  File "${STAGE}\hankha-print-bridge.exe"
  File "${STAGE}\print-bridge.cmd"
  File "${STAGE}\install.ps1"
  File "${STAGE}\uninstall.ps1"
  File "${STAGE}\status.ps1"

  CreateDirectory "$APPDATA\Hankha\PrintBridge\logs"

  DetailPrint "Registering the startup task..."
  ; -SkipCopy because the files are already where they belong; install.ps1 registers the task,
  ; starts it, and waits for /health to answer before returning 0.
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -SkipCopy -InstallDir "$INSTDIR" -Port ${PORT}'
  Pop $0
  ${If} $0 != 0
    Abort "The Print Bridge was copied, but could not be started (exit $0). See the details above, and $APPDATA\Hankha\PrintBridge\logs\bridge.log"
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr   HKLM "${REGKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   HKLM "${REGKEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKLM "${REGKEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKLM "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKLM "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKLM "${REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${REGKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${REGKEY}" "EstimatedSize" "$0"

  ; A link straight to /health would show raw JSON to someone whose question is "is the
  ; printer thing working?". status.ps1 answers that in a sentence.
  CreateDirectory "$SMPROGRAMS\Hankha"
  ; The pairing screen, first in the folder: it is what an operator needs when printing stops or
  ; when the computer has to be connected to a different shop. The status shortcut below is for
  ; whoever is diagnosing, which is a rarer and more technical errand.
  CreateShortcut "$SMPROGRAMS\Hankha\Print Bridge.lnk" \
    "$SYSDIR\rundll32.exe" "url.dll,FileProtocolHandler http://127.0.0.1:${PORT}/" \
    "$INSTDIR\hankha-print-bridge.exe" 0
  CreateShortcut "$SMPROGRAMS\Hankha\Print Bridge status.lnk" \
    "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" \
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\status.ps1"' \
    "$INSTDIR\hankha-print-bridge.exe" 0
SectionEnd

Section /o "Serve other terminals on this network" SecLan
  SetShellVarContext all
  ; Off by default. A POS served over https can only reach a bridge on localhost -- every other
  ; address is blocked as mixed content -- so opening the port usually buys nothing and only
  ; widens what is reachable inside the venue.
  ; Same script again with -Lan: it writes bridge.env, adds the firewall rule, and re-registers
  ; the task so the new bind address takes effect. Nothing about it is duplicated here.
  DetailPrint "Allowing other terminals on this network..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -SkipCopy -InstallDir "$INSTDIR" -Port ${PORT} -Lan'
  Pop $0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "The print helper itself, started automatically at boot."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecLan} "Let other computers on this network use this bridge, and open port ${PORT} on the private firewall profile. Not needed when the POS runs on this computer."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetShellVarContext all

  ; schtasks, not the cmdlets, on purpose: deleting BY NAME has none of the nested-quoting
  ; risk that made registration (which passes a "Program Files" path) worth moving to
  ; PowerShell. NSIS single-quoted strings have no backslash escapes, so a PowerShell command
  ; with its own quotes is the more fragile option here, not the safer one.
  nsExec::ExecToLog 'schtasks /End /TN "${TASKNAME}"'
  Pop $0
  nsExec::ExecToLog 'schtasks /Delete /TN "${TASKNAME}" /F'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM hankha-print-bridge.exe'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  Pop $0
  Sleep 500

  Delete "$INSTDIR\hankha-print-bridge.exe"
  Delete "$INSTDIR\print-bridge.cmd"
  Delete "$INSTDIR\install.ps1"
  Delete "$INSTDIR\uninstall.ps1"
  Delete "$INSTDIR\status.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  RMDir "$PROGRAMFILES64\Hankha"

  Delete "$APPDATA\Hankha\PrintBridge\bridge.env"
  ; Logs stay: they are the only record of why a till stopped printing.

  Delete "$SMPROGRAMS\Hankha\Print Bridge status.lnk"
  RMDir "$SMPROGRAMS\Hankha"

  DeleteRegKey HKLM "${REGKEY}"
SectionEnd
