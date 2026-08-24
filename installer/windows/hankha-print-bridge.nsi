; Hankha Print Bridge -- Windows installer
;
; Built with NSIS, cross-compiled from macOS (`brew install makensis`). `scripts/package.mjs`
; passes the version and the staging directory in with /D.
;
; Autostart is a SCHEDULED TASK, not a Windows service: the bridge is a plain console program
; and does not implement the service-control handshake, so `sc.exe create` would register a
; service that dies with error 1053 on every start. The usual workaround is bundling a service
; wrapper (WinSW/NSSM); a task avoids the extra binary entirely.

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
!define MUI_FINISHPAGE_TITLE "The Print Bridge is running"
!define MUI_FINISHPAGE_TEXT "Open the POS terminal on this computer and go to Settings > Printing. The Print Bridge card should read $\"Print Bridge is running$\" -- then press Search to find your printers."
!define MUI_FINISHPAGE_LINK "Check the bridge in a browser"
!define MUI_FINISHPAGE_LINK_LOCATION "http://127.0.0.1:${PORT}/health"
!insertmacro MUI_PAGE_FINISH

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
  File "${STAGE}\uninstall.ps1"

  CreateDirectory "$APPDATA\Hankha\PrintBridge\logs"

  DetailPrint "Registering the startup task..."
  nsExec::ExecToLog 'schtasks /Create /TN "${TASKNAME}" /TR "\"$INSTDIR\print-bridge.cmd\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F'
  Pop $0
  ${If} $0 != 0
    Abort "Could not register the startup task (schtasks exit $0). The bridge will not start on its own."
  ${EndIf}
  nsExec::ExecToLog 'schtasks /Run /TN "${TASKNAME}"'
  Pop $0

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

  CreateDirectory "$SMPROGRAMS\Hankha"
  WriteINIStr "$SMPROGRAMS\Hankha\Print Bridge status.url" "InternetShortcut" "URL" "http://127.0.0.1:${PORT}/health"
SectionEnd

Section /o "Serve other terminals on this network" SecLan
  SetShellVarContext all
  ; Off by default. A POS served over https can only reach a bridge on localhost -- every other
  ; address is blocked as mixed content -- so opening the port usually buys nothing and only
  ; widens what is reachable inside the venue.
  DetailPrint "Allowing other terminals on this network..."
  FileOpen $0 "$APPDATA\Hankha\PrintBridge\bridge.env" w
  FileWrite $0 "# Overrides read by print-bridge.cmd at startup.$\r$\n"
  FileWrite $0 "PRINT_BRIDGE_HOST=0.0.0.0$\r$\n"
  FileWrite $0 "PRINT_BRIDGE_PORT=${PORT}$\r$\n"
  FileClose $0

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${APPNAME}" dir=in action=allow protocol=TCP localport=${PORT} profile=private'
  Pop $0

  ; The task started before this section ran, so restart it to pick up the new bind address.
  nsExec::ExecToLog 'schtasks /End /TN "${TASKNAME}"'
  Pop $0
  Sleep 500
  nsExec::ExecToLog 'schtasks /Run /TN "${TASKNAME}"'
  Pop $0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "The print helper itself, started automatically at boot."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecLan} "Let other computers on this network use this bridge, and open port ${PORT} on the private firewall profile. Not needed when the POS runs on this computer."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetShellVarContext all

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
  Delete "$INSTDIR\uninstall.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  RMDir "$PROGRAMFILES64\Hankha"

  Delete "$APPDATA\Hankha\PrintBridge\bridge.env"
  ; Logs stay: they are the only record of why a till stopped printing.

  Delete "$SMPROGRAMS\Hankha\Print Bridge status.url"
  RMDir "$SMPROGRAMS\Hankha"

  DeleteRegKey HKLM "${REGKEY}"
SectionEnd
