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


THE BRIDGE CANNOT VERIFY HANKHA'S CERTIFICATE
---------------------------------------------
When printing from phones and tablets through this computer stops while printing from this
computer keeps working, and bridge.log shows UNABLE_TO_GET_ISSUER_CERT_LOCALLY (or
SELF_SIGNED_CERT_IN_CHAIN, CERT_UNTRUSTED), the bridge refused the certificate the cloud
presented. There are two causes, and the bridge says which: the page at http://127.0.0.1:9200
and the relay.tls.untrusted line in bridge.log (its kind= field).

kind=runtime  -- "This bridge version cannot verify Hankha's certificate". The certificate is
the real one; this version of the bridge program failed to check it (versions 1.14.4 to 1.14.6
on Windows did this). Install the newest bridge and it reconnects by itself. Nothing on this
computer needs changing. Do NOT exclude the bridge from antivirus scanning and do NOT add
root certificates: it fixes nothing and widens trust.

kind=intercepted  -- "Something on this computer is inspecting HTTPS". An antivirus or proxy
on this computer re-signs every secure connection with its own certificate; the page and the
issuer= field in the log name it. Whoever manages this computer stops that program inspecting
the bridge's connection (hankha-print-bridge.exe, or the address api.hankha.la), then restarts
the bridge -- reboot, or:

    Stop-ScheduledTask -TaskName 'Hankha Print Bridge'
    Get-Process hankha-print-bridge -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-ScheduledTask -TaskName 'Hankha Print Bridge'

If that program must keep inspecting, an administrator can give the bridge its root
certificate instead: the "Trusting an interceptor's root" section of the README has the
PowerShell for it (NODE_EXTRA_CA_CERTS in bridge.env; setup.exe rewrites that file, so the
line goes back after every upgrade).

kind=unverified  -- the certificate could not be read back. Install the newest bridge; if it
still shows this, send bridge.log to Hankha support.
