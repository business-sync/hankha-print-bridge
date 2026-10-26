Hankha Print Bridge — Windows
=============================

This is the small helper the POS terminal needs to print to a NETWORK receipt or kitchen
printer. A browser cannot open a printer socket itself, so it asks this helper to do it.

Install it on EVERY till that prints — not on one shared computer. A POS page served over
https is only allowed to talk to a helper running on the same machine.


INSTALL
-------
Right-click Windows PowerShell and choose "Run as administrator", then:

    cd <the folder you unzipped this into>
    .\install.ps1

If PowerShell refuses to run the script:

    powershell -ExecutionPolicy Bypass -File .\install.ps1

The bridge starts immediately and again on every boot. It listens on
http://127.0.0.1:9200 and only this computer can reach it.


CHECK IT WORKS
--------------
Start Menu > Hankha > Print Bridge status  -- tells you in a sentence whether it is running,
which port, and for how long.

Then open the POS terminal on this computer and go to Settings > Printing. The Print Bridge
card should read "Print Bridge is running".

(The raw version, if you prefer: http://127.0.0.1:9200/health should start with {"ok":true.)


LET OTHER COMPUTERS USE THIS BRIDGE
-----------------------------------
Only useful when the POS is served over plain http. Adds a firewall rule for TCP 9200 on the
private network profile:

    .\install.ps1 -Lan


UNINSTALL
---------
    .\uninstall.ps1

or use Settings > Apps if you installed with the Setup.exe.


LOGS
----
    C:\ProgramData\Hankha\PrintBridge\logs\bridge.log

The most common failure is another program already holding port 9200; the log says so.

The bridge restarts by itself if it crashes, and again every time this computer boots. You do
not need to start it by hand.


HTTPS INSPECTION / CORPORATE PROXY
----------------------------------
Antivirus programs and corporate proxies that "scan HTTPS" re-sign every secure connection
with their own certificate. Browsers trust it; the bridge does not, so printing from phones
and tablets through this computer stops while printing from this computer keeps working.
The page at http://127.0.0.1:9200 says "Something on this computer is inspecting HTTPS", and
bridge.log names the program: look for relay.tls.untrusted and read the issuer= field.

Fix 1 (best): in that program's settings, exclude hankha-print-bridge.exe (or the address
api.hankha.la) from HTTPS/SSL scanning, then restart the bridge -- reboot, or run the last
three lines below.

Fix 2: give the bridge that program's root certificate. In an elevated PowerShell, with the
name from the log in place of Kaspersky and the thumbprint it prints in place of <THUMBPRINT>:

    Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like '*Kaspersky*' | Format-List Subject, Thumbprint
    $cert = Get-Item Cert:\LocalMachine\Root\<THUMBPRINT>
    $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----"
    Set-Content -Path 'C:\ProgramData\Hankha\PrintBridge\interceptor-root.pem' -Value $pem -Encoding ascii
    Add-Content -Path 'C:\ProgramData\Hankha\PrintBridge\bridge.env' -Value 'NODE_EXTRA_CA_CERTS=C:\ProgramData\Hankha\PrintBridge\interceptor-root.pem' -Encoding ascii
    Stop-ScheduledTask -TaskName 'Hankha Print Bridge'
    Get-Process hankha-print-bridge -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-ScheduledTask -TaskName 'Hankha Print Bridge'

Setup.exe and install.ps1 rewrite bridge.env, so add that one line again after every upgrade.
The .pem file beside it is left alone.
