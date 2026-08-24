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
