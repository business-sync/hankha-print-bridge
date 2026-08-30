# hankha-print-bridge

The helper that prints POS receipts and labels on a venue's own hardware. A browser PWA cannot
open a raw TCP socket, a USB print queue or a serial port; the cloud API cannot reach a venue's
private LAN. So the terminal posts its job here, and this process talks to the printer.

```
POS terminal (browser) ─POST /print─┐
                                    ├─▶ print bridge ─┬─ TCP 9100 ────▶ network printer
cloud API ──────────────────────────┘                 ├─ lp -o raw ───▶ USB printer
        (outbound: no inbound port, works behind NAT) └─ /dev/cu.* ───▶ serial / Bluetooth
```

Three things it does that the old forwarder did not:

- **Three transports.** Network (RAW/9100), USB (through the OS print spooler in raw mode), and
  serial — which is also how a Bluetooth printer appears once the OS has paired it.
- **Renders.** Send a receipt or a label as JSON and it emits ESC/POS, ZPL, TSPL or EPL2,
  including barcodes and QR codes. Raw `payload_base64` still works and always will.
- **Queues.** Jobs are spooled to disk, printed one at a time per printer, retried when — and only
  when — nothing reached the paper, and dropped rather than printed late once they expire.

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

### The status page

Open <http://localhost:9200> in a browser. Once installed the bridge is a launchd daemon or a
scheduled task with no window, and this is the only place to see it without the POS: which machine
is answering, which printers are online and how far away, the queue, the recent jobs with the
reason each one failed, and the addresses another terminal could be pointed at. It is served
without a token even when one is configured — it is static markup, and every value on it is
fetched afterwards from the routes that are guarded, so a bridge that wants a token says so in a
sentence instead of a bare `401`.

It is not a configuration screen. `printers.json` stays the source of truth; the one thing the
page can do to a printer is send it the same test slip `--test-print` sends.

### The "This computer" card

At the bottom of that page: **restart the bridge**, **start automatically**, **remove from this
computer**, **restart the computer**, and **clear stored print data**. It exists because every
one of those needed a terminal before it — `launchctl kickstart`, an elevated PowerShell,
`sudo …/uninstall.sh` — and the person standing at the till is a café owner.

It says what it can do and what it cannot, and a refusal always carries the command that does it
by hand:

| | |
|---|---|
| **Restart** | Stops cleanly and lets launchd or Task Scheduler bring it back. **Refused outright when nothing would** — a restart button on an unsupervised bridge leaves the till with no bridge at all. |
| **Start automatically** | Only appears when it is not already registered. Writes the LaunchAgent (no password) or runs `install.ps1 -SkipCopy` — the same call the Setup.exe makes, so there is still one implementation of "install". It restarts once to hand the port over. |
| **Remove** | Three scopes: stop it starting, remove its files too, or remove everything including printers and pairing. **Logs always survive.** |
| **Restart the computer** | 60 seconds, with a Cancel; refuses while jobs are queued unless told twice. Both destructive actions ask for the machine's name to be typed. |
| **Clear stored print data** | A checklist, not a button — waiting jobs, recent records, duplicate protection, logs, each with its size. `printers.json` and `relay.json` are never touched. |

Clearing the **duplicate protection** ring is off by default and says why: it is what stops a job
the server redelivers from printing a second bill.

The card polls `GET /service`. From another machine that route answers **403**, so the card is
simply not there — which is the point.

#### Why this family has its own gate

Every other route here answers `Access-Control-Allow-Origin: *` and
`Access-Control-Allow-Private-Network: true`. That is a deliberate trade for printing: the
terminal's origin varies too much to pin. It cannot extend to rebooting a till, so `/service/*`
gets five layers instead — loopback, **no CORS headers at all** (a cross-origin preflight fails
and the request never arrives), an `Origin` / `Sec-Fetch-Site` check for the form POST that skips
a preflight, a `Host` pin against DNS rebinding, and a **single-use confirmation token** minted by
`GET /service`. One action at a time, and every attempt is logged at `warn`.

`PRINT_BRIDGE_TOKEN` still applies on top of all of it. `PRINT_BRIDGE_SERVICE_CONTROL=off`
removes the whole family for a managed fleet.

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
| `APP_VERSION` | `1.4.0` | the release number, and the only place to bump it |
| `PRINT_BRIDGE_PORT` | `9200` | the POS terminal defaults to `http://localhost:9200` |
| `PRINT_BRIDGE_HOST` | `0.0.0.0` | `127.0.0.1` accepts only this machine |
| `PRINT_BRIDGE_STATE_DIR` | per-OS | holds `printers.json`, the job spool and `relay.json` |
| `PRINT_BRIDGE_TOKEN` | *(empty)* | require `Authorization: Bearer …` on every route but `/health` |
| `PRINT_BRIDGE_TLS_CERT` / `_KEY` | *(empty)* | bring your own certificate to serve https |
| `PRINT_BRIDGE_RELAY_URL` | `https://api.hankha.la` | the cloud API to take jobs from |
| `PRINT_BRIDGE_RELAY_TRANSPORT` | `auto` | `auto` \| `ws` \| `poll` — see [Cloud jobs](#cloud-jobs) |
| `PRINT_BRIDGE_MAX_ATTEMPTS` | `3` | retries for a job that provably did not print |
| `PRINT_BRIDGE_SEND_TIMEOUT_MS` | `15000` | how long one send may take |
| `PRINT_BRIDGE_SYNC_TIMEOUT_MS` | `8000` | how long `POST /print` blocks — matches the POS's own timeout |
| `PRINT_BRIDGE_LOG_FORMAT` | `text` | `json` gives one object per line, for a log aggregator |
| `PRINT_BRIDGE_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `PRINT_BRIDGE_SERVICE_CONTROL` | `on` | `off` removes `/service/*` and the "This computer" card |
| `PRINT_BRIDGE_MANAGED` | *(probed)* | what supervises this process, stamped by the installer |

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

## Cutting a release

```bash
bun run release              # preflight, test, build, tag, publish
bun run release --dry-run    # every check and the full build, but pushes nothing
```

Installers are distributed as **GitHub Releases** — no CI job builds them, so this runs from a
Mac with Docker running (see above for why `setup.exe` needs it).

1. Bump `APP_VERSION` in **both** `.env` and `.env.example`.
2. Write `release-notes/v<version>.md` — prose only. The script appends the "Verify your
   download" section from the checksums of the artifacts it just built, so the hashes in the
   notes can never describe the build before last.
3. Commit both, push, then `bun run release`.

The version is never passed as an argument; it comes from `APP_VERSION`, so the tag, the
filenames and the number the binary reports to the POS cannot disagree.

Before anything is pushed it refuses to continue if: `gh` is not authenticated, `package.json`
has drifted from `APP_VERSION`, the tree is dirty, HEAD is not `main` in step with `origin`, a
release already exists for the tag, the notes file is missing, or the typecheck or tests fail.
After building it verifies **all four** artifacts are present and that `SHA256SUMS.txt` matches
their actual bytes and lists nothing else — `package.mjs` exits 0 having shipped only the `.zip`
when NSIS is unusable, and that is exactly the kind of half-release nobody notices.

| Flag | |
|---|---|
| `--dry-run` | build and assemble, stop before `git push` / `gh release create` |
| `--draft` | publish as a draft |
| `--skip-tests` | skip typecheck + tests |
| `--skip-build` | reuse `dist-installers/` as-is — still fully verified, so a stale build is caught |
| `--generate-notes` | let GitHub list the commits instead of requiring a notes file |
| `--notes <path>` | use a specific notes file |

If publishing fails after the tag is pushed, fix the cause and re-run — it reuses the tag rather
than demanding a version bump.

Do **not** run `bun install` here. `bun.lock` is lockfileVersion 2; an older bun cannot parse it,
warns, ignores it, and regenerates a downgraded lockfile that then breaks the Docker build's
`--frozen-lockfile`.

## Development

```bash
npm install
npm run dev      # tsx watch, port 9200
npm test         # node:test, no test framework dependency
npm run typecheck
```

`npm run dev` reads `.env` (see [Configuration](#configuration)) and binds `0.0.0.0`, unchanged
from before packaging existed; the installers set `PRINT_BRIDGE_HOST=127.0.0.1`.

## Printers

Printers live in `printers.json` inside `PRINT_BRIDGE_STATE_DIR` — beside `relay.json`, in a
directory both installers already create. Read it with `GET /printers`, replace it with
`PUT /printers`, and see it alongside everything the machine can actually detect with:

```bash
hankha-print-bridge --list-printers
hankha-print-bridge --test-print counter
```

```json
{
  "version": 1,
  "printers": [
    { "id": "counter", "name": "Counter receipt", "transport": "network",
      "address": "192.168.18.103", "port": 9100,
      "type": "receipt", "language": "escpos", "dots_per_line": 576 },

    { "id": "till-usb", "name": "Till (USB)", "transport": "usb",
      "queue": "SPRT_SP_EP", "type": "receipt", "language": "escpos" },

    { "id": "labels", "name": "Label roll", "transport": "serial",
      "device": "/dev/cu.RPP02N-SPP", "baud": 9600,
      "type": "label", "language": "tspl", "width_mm": 50, "height_mm": 30, "dpi": 203 }
  ],
  "default_receipt_printer": "counter",
  "default_label_printer": "labels"
}
```

`language` must be one of `escpos`, `zpl`, `tspl`, `epl2` — or `auto`, which means `escpos`.
Nothing probes the printer to find out: an identification query in the wrong language prints a
page of garbage, so guessing is opt-in through `POST /printers/:id/identify` and never a side
effect of loading a config file. A **label** printer has no safe default at all (ZPL sent to a
TSPL head prints the commands as text, one label per line, until the roll runs out), so its
`language` is required.

### The three transports

| `transport` | needs | how it works |
|---|---|---|
| `network` | `address`, `port` | a raw TCP socket to RAW/JetDirect 9100 |
| `usb` | `queue` | the OS print spooler in **raw** mode — `lp -o raw` on macOS/Linux, `winspool`'s `WritePrinter` through a PowerShell shim on Windows |
| `serial` | `device`, `baud` | writes straight to the character device, with `stty` / `mode.com` setting the line |

**USB goes through the spooler rather than libusb** because this app cross-compiles to three
targets from one machine and also builds as a slim container; a native addon is a per-platform
artifact and would end both. The trade is real and worth stating: no endpoint-level control and no
reading status back — but you get the driver the vendor already installed, network queues for
free, and no elevated USB permissions on either platform.

**Bluetooth is the `serial` transport.** Pair the printer in the operating system's own Bluetooth
settings — that is where the PIN prompt belongs — and it appears as `/dev/cu.Something-SPP`,
`/dev/rfcomm0`, or a COM port. There is no BLE path: a GATT-only printer needs a native Bluetooth
stack, and the OS cannot expose one as a tty.

On macOS, always use the **call-out** device (`/dev/cu.*`), never `/dev/tty.*` — the latter blocks
until carrier detect, which a printer never asserts, so the open never returns. Paths are
rewritten automatically, but it is worth knowing which one to type.

**A non-network printer may declare an `address`.** That is what lets a cloud job reach a USB
printer: a relay job carries only `target_ip`/`target_port`, so giving a USB entry an address makes
it addressable by every client that already speaks the old contract, with no change on the server
or in the POS.

## Job documents

A job is one of three things: raw bytes (`payload_base64`), a **receipt**, or a **label**.

A **receipt** is a flow — elements print in order and the paper advances:

```json
{ "printer_id": "counter", "receipt": { "elements": [
  { "type": "text", "value": "DOK CHAMPA", "align": "center", "bold": true, "width": 2, "height": 2 },
  { "type": "rule" },
  { "type": "columns", "left": "2x Lao coffee", "right": "50,000" },
  { "type": "columns", "left": "TOTAL", "right": "LAK 75,000", "bold": true },
  { "type": "barcode", "symbology": "CODE128", "value": "HK-00421", "height": 60, "hri": "below" },
  { "type": "qr", "value": "https://hankha.la/r/421", "size": 5 },
  { "type": "drawer" },
  { "type": "cut" }
] } }
```

Elements: `text`, `columns`, `rule`, `feed`, `image`, `barcode`, `qr`, `cut`, `drawer`. A cut is
appended automatically unless the document ends with one or sets `"cut": false`.

A **label** is a canvas — every element carries `x`/`y` in dots, because ZPL, TSPL and EPL2 are all
positional:

```json
{ "printer_id": "labels", "label": { "copies": 2, "elements": [
  { "type": "box", "x": 4, "y": 4, "width": 392, "height": 232, "thickness": 2 },
  { "type": "text", "x": 20, "y": 20, "value": "Lao Coffee 250g", "height": 24, "bold": true },
  { "type": "barcode", "x": 20, "y": 90, "symbology": "EAN13", "value": "885600123456", "height": 60 },
  { "type": "qr", "x": 290, "y": 90, "value": "https://hankha.la/p/9", "size": 4 }
] } }
```

Elements: `text`, `barcode`, `qr`, `image`, `box`, `line`. Media geometry stays in **millimetres**
(that is how a roll is sold, and what TSPL's `SIZE` wants) while positions are in **dots** (what
`^FO` and `A` want); `dpi` converts between them.

Symbologies: `CODE128`, `CODE39`, `EAN13`, `EAN8`, `UPCA`, `UPCE`, `ITF`. Nothing is computed here
— every one of the four languages encodes barcodes and QR in firmware, which is also why the whole
renderer needs no dependency. Data that a symbology cannot carry is rejected before it is sent,
because a printer handed impossible data prints nothing and reports nothing.

| document \ printer | `escpos` | `zpl` / `tspl` / `epl2` |
|---|---|---|
| `receipt` | native | **refused** — see below |
| `label` | flattened top-to-bottom, x ignored | native |

A receipt on a label printer is refused rather than approximated: a receipt flows for as long as it
needs to, a label is a fixed rectangle, and silently clipping a bill at the bottom of a 30 mm label
produces a slip that looks right until the total is missing from it.

### Non-Latin text

**Lao cannot be printed as text on any of these printers.** It is in no ESC/POS code page (CP874 is
Thai), and a resident label font has no such glyphs. So the renderer accepts ASCII plus a table of
punctuation equivalents — including `₭` → `LAK` — and **refuses** anything else with a 422 naming
the characters.

That refusal is the feature. The predecessor of this code silently dropped what it could not
encode, so `2x ເຂົ້າຜັດໄກ່` printed as `2x ` — a blank line, no error anywhere. Send Lao as a
pre-rendered `image` element instead: 1-bit, MSB-first, rows padded to whole bytes, which is
exactly what the POS terminal's `raster-renderer.ts` already produces.

```json
{ "type": "image", "image": { "width": 576, "height": 32, "data_base64": "…" } }
```

## API

Everything below needs `Authorization: Bearer <PRINT_BRIDGE_TOKEN>` when a token is configured.
`/health` never does.

### Printing

- `POST /print` — body `{ ip, port, payload_base64 }`. **Blocks** until the job settles and answers
  `{ ok: true }` or `{ ok: false, reason, printed_certainty, detail }` with a 502. This is the
  original contract and it is frozen: the POS terminal treats a 200 with `ok: true` as proof a
  receipt printed. It now takes its turn in the printer's queue instead of opening a socket
  immediately, which serialises two tills printing to one printer.
- `POST /jobs` — body `{ job_id?, printer_id? | target?, copies?, ttl_s?, payload_base64 | receipt |
  label }` → `202 { ok, job, deduplicated }`. Returns as soon as the job is queued. `job_id` is an
  idempotency key: submit the same one twice and the second answers with the first outcome rather
  than printing again. Omit both `printer_id` and `target` to use the registry's default for the
  document's kind.
- `GET /jobs` → recent jobs and the queue depth. `GET /jobs/:id` → one job.
- `POST /jobs/:id/cancel` → 200 if it had not started, 409 once it is printing.

### Printers

- `GET /printers` / `PUT /printers` — read and replace the registry. A `PUT` that fails validation
  changes nothing and returns **every** problem at once, not just the first.
- `POST /printers/:id/test` — print the same test slip `--test-print` prints. Its ruler line shows
  whether `dots_per_line` matches the paper.
- `POST /printers/:id/identify` — send a status query and report the reply. Network only: a print
  spooler is one-way, so there is no channel to read an answer on, and this returns 501 for `usb`
  rather than pretending. Nothing calls it automatically.
- `POST /discover` — body `{ port?, network? }` → every printer this machine can see, from all
  three transports, plus which transports are usable at all. That last part matters: "no USB
  printers" and "this machine cannot see USB printers" are very different answers.

### Diagnostics

- `GET /` → the status page above, as HTML. `/index.html` and `HEAD` answer the same. The only
  route that is not JSON, and — with `/health` — the only one served without a token.
- `GET /health` → `{ ok, service, version, interfaces, hostname, platform, arch, pid, uptime_s,
  net_warning, auth_required, relay, printers, queue }`. `ok` is first and never changes shape —
  older terminals read only that. Deliberately does **not** probe printers: this is the endpoint the
  POS polls, so it stays a memory read.
- `GET /status` → everything in `/health` plus per-printer online/offline with latency, transport
  availability, and queue depth by state. Probes are cached for five seconds; `?probe=1` forces a
  fresh one.
- `POST /probe` — body `{ ip, port? }` → `{ ok, reachable, latency_ms, reason? }` with
  `reason: "timeout" | "refused" | "unreachable"`. Opens a TCP connection and drops it **without
  writing** — a printer that receives stray bytes prints garbage. `refused` means a device is alive
  there but that port is closed; `timeout` means nothing answered.
- `POST /scan` — body `{ port? }` → `{ ok, subnets, duration_ms, printers }`. Sweeps this machine's
  own subnets, clamped to the /24 around each interface (a /16 would mean 65k connect attempts), 64
  sockets in parallel, 500 ms per host. Concurrent callers share one run.

Every endpoint that dials an address refuses anything outside RFC1918 private space. CORS is `*`
(the terminal's origin varies too much to pin down), so that restriction is what stops a random page
from using the bridge to scan the public internet from inside the venue's network.

## The queue

Jobs are spooled to `PRINT_BRIDGE_STATE_DIR/spool` — one file each, written temp-then-rename, so a
power cut leaves a whole record or none. Four rules:

1. **Sequential per printer, concurrent across printers.** Not throughput; correctness. Several
   kitchen stations usually share one physical printer, and two interleaved writes produce one
   shredded ticket. A dead printer still cannot hold up a working one.
2. **Only retry what provably did not print.** RAW/9100 has no application acknowledgement, and
   neither does a spooler, so any failure *after* the channel opened is `printed_certainty:
   "unknown"` and terminal. Retrying those is how a customer ends up holding two bills.
3. **A deadline outranks the attempt count.** With `ttl_s` set, the job retries with backoff until
   that deadline — `PRINT_BRIDGE_MAX_ATTEMPTS` alone gives up in about three seconds, which is
   shorter than a printer takes to reboot. Once it expires it is **dropped, not printed late**: a
   receipt printed an hour after the till moved on is worse than no receipt.
4. **Deduplicated across restarts.** Settled job ids are kept in a bounded on-disk ring, so a
   redelivered job is *answered*, never reprinted.

A job found in `printing` after a crash is settled as `unknown` rather than retried — the bytes may
already be on the paper, and there is no way left to ask.

## Cloud jobs

The bridge dials **out** to the cloud API, so a phone or a till on mobile data can print through it
without reaching the shop LAN. No inbound port, no certificate on the shop PC, nothing to configure
on the router. Pair once with a code from **Settings → Printing**.

**On the machine itself, open <http://localhost:9200> and paste the code into the Cloud relay
card.** That is the path to hand an operator: it needs no terminal, and it cannot hit the two
failure modes the command line has. Neither installer puts `hankha-print-bridge` on PATH — on
Windows it lives under `%ProgramFiles%\Hankha\Print Bridge\` and the macOS .dmg keeps it inside
the app bundle — and on the macOS .pkg, where the daemon runs as root, a bare `--enroll` writes
the token into the operator's own `~/Library/Application Support/…`, reports success, and never
connects.

For scripted rollouts the command still works, with the full path and, on the .pkg, `sudo`:

```bash
sudo /usr/local/hankha/print-bridge/hankha-print-bridge --enroll ABCD-2345
```

`POST /enroll` answers **only on loopback** (`403 not-loopback` otherwise). The Windows installer
binds `0.0.0.0` and `PRINT_BRIDGE_TOKEN` is empty by default, so that gate is what stops anyone on
the venue wifi pairing the shop's bridge to their own organisation. A bridge that is already paired
answers `409 already-enrolled`; `{"code":…,"force":true}` re-pairs and reports `restart_required`,
because a running relay loop holds the previous token.

`PRINT_BRIDGE_RELAY_TRANSPORT` picks the channel. `auto` tries a WebSocket at
`/api/v1/modules/print/bridge/socket` and falls back to the long-poll on
`/api/v1/modules/print/bridge/work` — which is what the server offers today, so `auto` and `poll`
behave identically until that endpoint ships. A server that answers the upgrade with an ordinary
HTTP status is remembered as not supporting it and asked again only twice an hour. `ws` refuses to
fall back, for testing a server that does have it.

The WebSocket contract, for whoever builds the server half: accept the upgrade with the same bearer
token the other bridge routes take, then push the same `Work` JSON objects the long-poll returns.
The bridge sends `{"type":"hello"}` on open and `{"type":"heartbeat"}` every 30 seconds, answers
pings, and ignores frame types it does not know. **Results keep going back over HTTP** — reusing an
endpoint that already exists is worth more than the round trip it saves, and it means a half-built
server side cannot lose a print result.

Cloud jobs go through the same queue as everything else, and the poll loop no longer waits for them
to print: a printer taking four seconds to answer used to stop the bridge fetching *any* work for
those four seconds.

### Reaching a USB or Bluetooth printer from a tablet

A cloud job may address a printer two ways, and exactly one of them is set:

- `target_ip` / `target_port` — a socket the bridge dials. The original contract.
- `printer_id` — an entry in this bridge's own `printers.json`, resolved by `findPrinter`.

The second exists because a USB or serial printer wired to *this* machine has no address at all,
so a network sweep can never find it and a remote till had nothing to name it by. The workaround
until now was to invent a private-looking IP, put it in the USB entry's `address`, and type that
same fake address into the POS; `resolveByAddress` still honours it, so nothing breaks.

To make that choice possible from a device with no LAN access, every heartbeat (and the enrolment
POST) carries `registry_printers` — a summary of this bridge's configured printers, capped at 64:

```json
{ "id": "kitchen-usb", "name": "Kitchen", "transport": "usb",
  "type": "receipt", "enabled": true, "address": null, "port": null }
```

Additive on both sides. An older API strips the field; a bridge older than 1.5.0 does not send it,
and the server keeps whatever it last knew rather than treating "absent" as "no printers".

## Troubleshooting

Start at <http://localhost:9200> on the machine running the bridge. Most of what follows is
visible there, including which printers are refusing connections and why the last job failed.

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

**A job returns 422 `render-failed` mentioning characters** — the text is not ASCII and no printer
here has those glyphs. Send that line as an `image` element; see
[Non-Latin text](#non-latin-text). This is deliberate: the alternative is a blank line and a
success response.

**A USB job says it printed but nothing came out** — the spooler accepted it, which is all a
spooler can tell you. Check the queue is not paused (`lpstat -p <queue>`, or Printers & Scanners),
and that it is a **raw**/generic queue rather than one with a vendor driver: a driver turns ESC/POS
into pages of mojibake. `/status` reports a paused queue explicitly.

**A label comes out solid black with white text** — the printer's language is set wrong in
`printers.json`. TSPL and EPL2 treat a set bit as *white*; ESC/POS and ZPL treat it as *black*, so
naming the wrong one inverts every image.

**A label prints the commands as text** — same cause, other direction: ZPL sent to a TSPL head, or
vice versa. Run `--test-print <id>`; the test slip names the language it was rendered in.

**A Bluetooth printer does not appear in `--list-printers`** — pair it in the operating system's
Bluetooth settings first. Only then does it get a `/dev/cu.*` or COM port for the `serial`
transport to open. BLE-only printers are not supported.

**The serial port opens and then hangs** — on macOS that is `/dev/tty.*` waiting for carrier
detect, which a printer never asserts. Use the `/dev/cu.*` name.

## Scope

Printer command generation, transport, and queueing — nothing about the business meaning of what is
printed. There is no order model, no pricing, and no persistence beyond the job spool and the
printer registry.

The renderer covers ASCII plus a punctuation fallback table. It does **not** rasterise text: there
is no font engine here, so Lao and every other non-Latin script arrives as a caller-supplied `image`
element, which is what the POS terminal already produces.
