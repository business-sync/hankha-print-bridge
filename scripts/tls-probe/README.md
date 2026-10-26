# TLS probe

A stand-alone program that runs the four TLS clients the bridge uses — `fetch`, `node:https`,
`node:tls` and `WebSocket` — against `api.hankha.la` and four public hosts, tries `fetch` with
each relevant root passed explicitly, checks that the WebSocket client rejects
`untrusted-root.badssl.com` and `self-signed.badssl.com`, and writes one text file beside the
executable. Nothing is installed or changed on the machine.

It exists because of 1.14.4–1.14.6 on Windows: Bun 1.3.11's root-certificate setup races
between the HTTP thread (`fetch`) and the JavaScript thread (`WebSocket`), and the loser keeps a
half-filled trust store for the life of the process (oven-sh/bun #28612). `probe.exe race` starts
a WebSocket and two fetches in the same tick, first thing, which is the bridge's own start-up
order; `probe.exe` with no argument runs everything sequentially, which does not race.

## Build

Cross-compiled from any machine; the runtime compiled in is the Bun on PATH, so build one per
runtime worth comparing:

```bash
cd scripts/tls-probe
bun build --compile --target=bun-windows-x64 --define 'VARIANT="default-bun'"$(bun --version)"'"' probe.ts --outfile "probe-default-bun$(bun --version).exe"
PATH="$HOME/.bun-1.3.14/bin:$PATH" bun build --compile --target=bun-windows-x64 --define 'VARIANT="default-bun1.3.14"' probe.ts --outfile probe-default-bun1.3.14.exe
# To test a runtime flag, bake it in: --compile-exec-argv=--use-system-ca (the exe takes no bun flags at run time).
```

`--define VARIANT=…` names the output file. The two root PEMs beside `probe.ts` are public
roots (GTS Root R4 from Bun's bundle, GlobalSign Root CA R1 from the macOS system keychain)
embedded into the executable for the explicit-`tls.ca` checks.

## Run on a till

As **SYSTEM**, the account the scheduled task runs the bridge under — a console run as the
logged-in user has a different environment and, with `--use-system-ca`, a different certificate
store. One way, in an elevated PowerShell with the exe in `C:\Temp\probe`:

```powershell
$dir = 'C:\Temp\probe'; $exe = 'probe-default-bun1.3.11.exe'
foreach ($mode in '', 'race') {
  $action = New-ScheduledTaskAction -Execute "$dir\$exe" -Argument $mode -WorkingDirectory $dir
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName "hankha-probe-$mode" -Action $action -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName "hankha-probe-$mode"; Start-Sleep -Seconds 90
  Unregister-ScheduledTask -TaskName "hankha-probe-$mode" -Confirm:$false
}
Get-ChildItem $dir\probe-output-*.txt
```

Each run takes up to a minute (12-second timeout per check). Read `probe-output-*-race.txt`:
`fetch during dial=ERR UNABLE_TO_GET_ISSUER_CERT_LOCALLY` beside `websocket=ERR … Expected 101`
(TLS passed; the socket is merely unauthenticated) is the race reproduced on that runtime;
`fetch ca=[GTS Root R4]: OK` after a failed default fetch is the explicit-roots repair the
bridge's `relay-fetch.ts` relies on.
