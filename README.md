# hankha-print-bridge

The helper that lets a POS terminal print to a **network** ESC/POS printer. The terminal is a
browser PWA and cannot open a raw TCP socket; the cloud API cannot reach a venue's private LAN.
So the terminal POSTs its bytes here over HTTP, and this process dials the printer's `ip:port`.

```
POS terminal (browser)  --POST /print-->  print bridge  --TCP 9100-->  ESC/POS printer
```

It ships as a **self-contained binary** — a till never needs Node installed.

> Not to be confused with `apps/inkline-agent`, a separate Go daemon on port 9101 serving a
> different client (`ip-printer-web`) with an incompatible API. The POS terminal only ever talks
> to this one.

## Install it on every till — not on one shared PC

A POS served over `https` may only call `http://` on `localhost`. Every other address is
blocked as mixed content **before the request leaves the browser**, so a bridge on another
machine is unreachable no matter how the network is set up. The installers therefore bind the
bridge to `127.0.0.1` and it is installed per till.

(The `-Lan` / "serve other terminals" option exists for venues serving the POS over plain
`http`. It is off by default.)

### macOS

Two builds, for two situations. **Install one, not both** — they both want port 9200, and the
app will tell you so rather than fighting the package.

#### `.dmg` — drag to Applications (use this one)

1. Open `hankha-print-bridge-<version>-macos.dmg`.
2. Drag **Hankha Print Bridge** onto the **Applications** folder in the same window.
3. Open it from Applications. **Right-click → Open** the first time (see below).

A dialog confirms it is running. That is all — opening the app registers a LaunchAgent in your
own home folder and hands the running to launchd, so it comes back at every login. **No
administrator password.** Open the app again any time to check on it or to uninstall.

Open it from the disk image rather than from Applications and it refuses, because the shortcut
it records would break the moment the image is ejected — and it would break silently, weeks
later.

Log: `~/Library/Logs/hankha-print-bridge.log`

#### `.pkg` — for managed fleets

`hankha-print-bridge-<version>-macos-universal.pkg` installs to `/usr/local/hankha/print-bridge`
and registers a system LaunchDaemon: it starts at **boot** rather than at login, and serves
every user account. Costs one administrator password, and suits unattended/MDM rollout.

```bash
curl http://127.0.0.1:9200/health
sudo /usr/local/hankha/print-bridge/uninstall.sh
```

Log: `/var/log/hankha-print-bridge.log`

#### Gatekeeper

Both builds are **unsigned**, so the first open shows *"cannot be opened because it is from an
unidentified developer"*. Right-click the app or the package and choose **Open** — that
offers an "Open anyway" button the plain double-click does not. Or clear the flag first:

```bash
xattr -dr com.apple.quarantine "/Applications/Hankha Print Bridge.app"
```

### Windows

Run **`hankha-print-bridge-<version>-windows-x64-setup.exe`**. SmartScreen will say *"Windows
protected your PC"* because the build is unsigned — click **More info** then **Run anyway**.
The bridge starts immediately and on every boot. Uninstall from **Settings → Apps** like any
other program.

**Start Menu → Hankha → Print Bridge status** answers "is the printer thing working?" in a
sentence — version, port, which computer, how long it has been up.

For a scripted rollout, unzip `…-windows-x64.zip` and run from an elevated PowerShell:

```powershell
.\install.ps1          # add -Lan to also serve other terminals on this network
.\uninstall.ps1
```

`install.ps1` is the **only** implementation of "install" — Setup.exe calls it too, so the
wizard and a scripted rollout cannot drift apart or fail in different ways.

Both paths install to `%ProgramFiles%\Hankha\Print Bridge` and register a **scheduled task**
(`Hankha Print Bridge`, at startup, as SYSTEM). Not a Windows service: the bridge is a plain
console program and does not implement the service-control handshake, so `sc.exe create` would
register a service that dies with error 1053 on every start. A task avoids bundling a
third-party service wrapper.

The task is registered through PowerShell's `ScheduledTasks` cmdlets rather than `schtasks.exe`.
`schtasks /TR` takes the whole command as one string, so a path under "Program Files" has to
survive nested quoting through the shell, `CreateProcess` and schtasks' own parser — three
chances to get it wrong, on something that cannot be tested from a macOS build machine.
`-Execute` takes the path as a value and there is nothing to quote. (Removal still uses
`schtasks`: deleting **by name** carries none of that risk.)

It also carries what macOS gets from launchd's `KeepAlive`: **restart on failure** every minute,
plus a five-minute repeating trigger as a backstop (`MultipleInstances IgnoreNew` makes that a
no-op whenever it is already up). Without them a crash at 11am meant every print failed
silently until the next reboot.

Log: `C:\ProgramData\Hankha\PrintBridge\logs\bridge.log`

### Connecting the terminal

Open the POS on the same computer → **Settings → Printing**. The Print Bridge card should read
*"Print Bridge is running"* and name this machine. Then press **Search** to find printers.

## Configuration

Everything is read from the environment. `.env` supplies it during development and packaging:

```bash
cp .env.example .env
```

`.env` is gitignored; `.env.example` is tracked and acts as the **fallback**, not only a
template, so a fresh clone with no `.env` still builds a correctly-numbered release. A real
environment variable beats both files, which is how CI overrides one without editing anything.

| Variable | Default | |
|---|---|---|
| `APP_VERSION` | `1.2.0` | the release number, and the only place to bump it |
| `PRINT_BRIDGE_PORT` | `9200` | the POS terminal defaults to `http://localhost:9200` |
| `PRINT_BRIDGE_HOST` | `0.0.0.0` | `127.0.0.1` accepts only this machine |

An **installed** bridge reads none of this. Its configuration comes from the service definition
instead: `EnvironmentVariables` in the launchd plist on macOS, and
`%ProgramData%\Hankha\PrintBridge\bridge.env` (read by `print-bridge.cmd`) on Windows, which
overrides port and host without touching the scheduled task.

### Bumping the version

Edit `APP_VERSION` in **both** `.env` and `.env.example`, then:

```bash
npm run version:sync     # rewrites package.json / package-lock.json to match
```

`bun run package` runs that sync itself, then names the artifacts, stamps the macOS bundle and
the Windows installer, and inlines the number into the binary with `bun build --define` — a
shipped binary has neither `.env` nor `package.json` beside it. It then makes the compiled
binary report its version back, because a `--define` that failed to apply would leave every
artifact *labelled* 1.2.0 wrapped around a bridge that tells the POS `0.0.0-dev`.

`npm test` fails if `package.json` or `.env.example` has drifted.

Keep it to three numeric parts: the POS terminal compares it against its own
`MIN_BRIDGE_VERSION` and silently ignores anything it cannot parse.

## Building the installers

```bash
bun run package             # everything this machine can produce
bun run package:macos
bun run package:windows
```

Artifacts land in `dist-installers/` with a `SHA256SUMS.txt`.

Requirements: **Bun** for the binaries (cross-compiles all targets from any host); **macOS**
for the `.dmg` and `.pkg` (`hdiutil`/`pkgbuild`/`productbuild` exist nowhere else); **NSIS**
for `setup.exe`. The
script prefers a local `makensis` but verifies it actually compiles first — Homebrew's
makensis 3.12 aborts with `std::bad_alloc` on macOS 26 for *any* script — and otherwise falls
back to a container built from `installer/windows/Dockerfile.nsis`. With neither, it warns and
ships only the `.zip`.

### Signing

Unsigned by default. Every hook below is a no-op when its variable is unset — put real values
in `.env`, which is gitignored, and never in `.env.example`:

| Variable | Effect |
|---|---|
| `HANKHA_MACOS_SIGN_IDENTITY` | Developer ID Application — signs the binary with a hardened runtime |
| `HANKHA_MACOS_INSTALLER_IDENTITY` | Developer ID Installer — signs the `.pkg` |
| `HANKHA_NOTARY_PROFILE` | `notarytool` keychain profile — notarizes and staples |
| `HANKHA_WINDOWS_PFX` / `HANKHA_WINDOWS_PFX_PASSWORD` | signs the `.exe` and the setup via `osslsigncode` |

The macOS binary is always **ad-hoc** signed regardless: Apple silicon refuses to launch an
unsigned binary at all, and the failure — `Killed: 9` at exec — never reaches the installer log.

## Development

```bash
npm install
npm run dev      # tsx watch, port 9200
npm test         # node:test, no test framework dependency
npm run typecheck
```

`npm run dev` reads `.env` (see [Configuration](#configuration)) and binds `0.0.0.0`, unchanged
from before packaging existed; the installers set `PRINT_BRIDGE_HOST=127.0.0.1`.

## API

- `GET /health` → `{ ok, service, version, interfaces: [{ address, cidr }], hostname, platform,
  arch, pid, uptime_s }`. `ok` is first and never changes shape — older terminals read only
  that. `service` lets the terminal tell a real bridge from some other app on the port;
  `interfaces` lets it warn when a configured printer sits on a different network; the
  host/platform block is how an operator sees *which* machine answered, which matters once the
  bridge is an invisible background service.
- `POST /probe` — body `{ ip, port? }` (port defaults to 9100) →
  `{ ok, reachable, latency_ms, reason? }` with `reason: "timeout" | "refused" | "unreachable"`.
  Opens a TCP connection and drops it **without writing** — a printer that receives stray bytes
  prints garbage. `refused` means a device is alive there but that port is closed (right host,
  wrong port); `timeout` means nothing answered at all.
- `POST /scan` — body `{ port? }` → `{ ok, subnets, duration_ms, printers: [{ ip, port, latency_ms }] }`.
  Sweeps every address on this machine's own subnets, so an operator can pick a printer from a
  list instead of typing an IP. Each interface is clamped to the /24 around its own address
  (a /16 would mean 65k connect attempts), 64 sockets in parallel, 500 ms per host — about
  2 seconds for a typical venue. Concurrent callers share one run.
- `POST /print` — body `{ ip, port, payload_base64 }`. Opens a TCP socket to `ip:port`, writes the
  decoded bytes, closes it. Responds `{ ok: true }` or
  `{ ok: false, reason: "connect-refused" | "timeout" | "invalid-body" | "invalid-payload" }`.

Every endpoint that dials an address refuses anything outside RFC1918 private space. CORS is `*`
(the terminal's origin varies too much to pin down), so that restriction is what stops a random
page from using the bridge to scan the public internet from inside the venue's network.

## Troubleshooting

**"Print Bridge is not answering"** — almost always another program on port 9200. The log says
so explicitly. Change it with `PRINT_BRIDGE_PORT` and set the matching address in the POS.

**On macOS, both the .dmg and the .pkg were installed** — they both want port 9200, so the
second one to start dies on `EADDRINUSE` in a restart loop. Opening the app says which one
currently owns the port and how to remove the other. Keep one.

**"That is not the Print Bridge"** — something else answered on that port. The classic cause is
a URL pointing at `:3100` (the admin portal) or `:3101` (the POS itself) instead of `:9200`.

**"Your browser is blocking the Print Bridge"** — the POS is on `https` and the bridge address
is not `localhost`. Install the bridge on the till itself; see the top of this file.

**Printing works, discovery doesn't** — the bridge is older than v1.1 (no `/scan`). The POS
shows an "update the Print Bridge" warning below v1.2.

## Scope

This process only forwards bytes: no printer-specific logic (the ESC/POS payload is built in the
POS terminal, including the Lao raster path) and no persistence.
