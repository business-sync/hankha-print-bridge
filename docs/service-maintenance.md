# The "This computer" page — restart, install, uninstall, reboot, clear cache

Design for the maintenance surface on the bridge's own page at `http://localhost:9200`.

> **Shipped in 1.10.0**, all four phases. This document is kept as the reasoning behind it — why
> the family has its own gate, why restart is refused on an unsupervised bridge, why macOS
> uninstalls in-process while Windows needs a detached helper. The code is `src/service.ts`,
> `src/service-actions.ts`, `src/service-control.ts` and `src/page-service.ts`; the operator-facing
> version is in the README under *The "This computer" card*.
>
> Two things changed during the build, both noted in place below: the confirm token is a small
> set rather than a single slot (a single one raced the page's own poll), and "install" hands the
> port over by stopping itself after bootstrapping, because a second copy cannot bind 9200 while
> the first still holds it.
>
> The four open decisions in §11 were resolved as: local-only with a transport-agnostic action
> layer, reboot ships, "unpair" stays off the card, and the card is in all five languages.

## 1. Why

Once installed, the bridge is a launchd daemon or a scheduled task with **no window and no dock
icon**. Every act of maintenance today needs a terminal:

| what an operator needs | what they must do now |
|---|---|
| restart it | `launchctl kickstart -k …`, or reboot the whole PC |
| stop it starting at boot | elevated PowerShell → `.\uninstall.ps1` |
| remove it | `sudo /usr/local/hankha/print-bridge/uninstall.sh` |
| clear a jammed queue | delete files out of a state directory whose path they have to be told |
| reboot the till | this one they can do — `status.ps1` literally tells them to |

The audience is a Lao café owner. None of the first four are reachable for them, and the page
they already have (`GET /` — [`src/page.ts`](../src/page.ts)) is the one place they can be
reached: it is already the only way to see the bridge without the POS.

The page's own header states it is **not a configuration UI** — `printers.json` stays the source
of truth. That still holds. This adds control of the *service*, not of the printers.

## 2. What the five words mean on a till

| action | what it actually is | privilege |
|---|---|---|
| **Restart** | stop cleanly and let the supervisor bring us back | none |
| **Install** | *register autostart* — the bridge is already running, it served this page | macOS agent: none · Windows: elevation |
| **Uninstall** | unregister, and optionally delete payload / state. Logs always survive | whatever the install used |
| **Reboot** | restart the computer, after a cancellable delay | Windows SYSTEM: yes · macOS: session or root |
| **Clear cache** | four separable things, one of which can cause a double bill | none |

"Install" cannot mean "put the bridge on this machine" — a page served *by* the bridge only
exists once it is there. Downloading a first installer is already the POS connect wizard's job
(`GET /api/v1/modules/print/installer`, which 503s and hides the button when
`PRINT_BRIDGE_RELEASE_BASE` / `PRINT_BRIDGE_VERSION` are unset).

## 3. Security — the part that decides whether this ships

The bridge answers **`Access-Control-Allow-Origin: *`** and
**`Access-Control-Allow-Private-Network: true`** on every route
([`src/server.ts:108`](../src/server.ts)). That is a deliberate, documented trade for printing:
the terminal's origin varies and the surface is a LAN one.

It cannot extend to this feature. With those headers, **any web page an operator opens on the
till could reboot the till or remove the bridge**, and a DNS-rebinding page could do it from off
the network entirely. So `/service/*` gets its own gate — five layers, cheapest first:

1. **Loopback only.** The same unconditional check `/enroll` and `/pairing` already use
   (`server.ts:686`, `isLoopbackRequest` at `server.ts:171`), applied before anything else so no
   later edit can widen it by accident.
2. **No CORS headers at all on this family.** Skip `withCors`, answer `OPTIONS` with 403. A
   cross-origin `fetch` then fails its preflight and the POST never arrives. Our own page is
   same-origin and never preflights.
3. **`Origin` / `Sec-Fetch-Site`.** Require `Sec-Fetch-Site: same-origin` (or absent, for
   `curl`), and when `Origin` is present require it to equal our own scheme://host:port. This is
   what closes the no-preflight `<form>` POST path that layer 2 does not see.
4. **Host header pin.** `Host` must be `localhost`, `127.0.0.1` or `[::1]`. A DNS-rebinding page
   resolves `evil.com` to 127.0.0.1 and sends `Host: evil.com` — it passes 1 and 3, and fails
   here.
5. **One-time confirm token.** `GET /service` mints a 128-bit token: in memory, 120 s, single
   use, one live at a time. Every mutating call must echo it. Even if a future platform breaks
   1–4, blind CSRF cannot guess it — and it gives the page an honest "that confirmation expired,
   press again".

Plus, not layers but load-bearing:

- **One action at a time.** A second maintenance call while one is in flight gets `409`.
- **Everything is logged at `warn`** with `event: service.<action>`, the remote address and the
  outcome. This is the answer to "who rebooted the till at 19:40".
- `PRINT_BRIDGE_TOKEN`, when configured, still applies — `/service/*` is **not** added to
  `openToAnyone` (`server.ts:684`).
- `PRINT_BRIDGE_SERVICE_CONTROL=off` removes the whole family (routes 404, card hidden) for a
  managed fleet. Forced off when the manager is `container`: an orchestrated bridge owns none of
  these things.

## 4. `src/service.ts` — knowing what we are running under

Every action depends on one question, and getting it wrong is the difference between "restarted"
and "the till has no bridge until someone drives there".

```ts
export type ServiceManager =
  | 'launchd-daemon'   // .pkg — /Library/LaunchDaemons, root, starts at boot
  | 'launchd-agent'    // .dmg — ~/Library/LaunchAgents, the user, starts at login
  | 'scheduled-task'   // Windows — SYSTEM, at startup
  | 'systemd'
  | 'container'        // the runtime restarts us; we own nothing
  | 'none';            // started by hand: npm run dev, or the bare binary

export interface ServiceReport {
  manager: ServiceManager;
  label: string | null;
  supervised: boolean;      // something WILL start us again
  autostart: boolean;       // and will do so after a reboot
  privileged: boolean;      // uid 0 / SYSTEM
  install_dir: string | null;
  state_dir: string;        // identity.stateDir()
  log_path: string | null;
  can: Record<'restart' | 'autostart' | 'uninstall' | 'reboot' | 'clear_cache', Capability>;
}
// `hint` is the exact command to run by hand when `allowed` is false. Never a bare "no".
type Capability = { allowed: boolean; reason?: string; hint?: string };
```

**Detection order:**

1. **`PRINT_BRIDGE_MANAGED`, stamped by the thing that launched us.** Add it to
   `installer/windows/print-bridge.cmd`, to `installer/macos/la.hankha.print-bridge.plist`, to
   the plist `installer/macos/app/HankhaPrintBridge` writes, and to
   `deploy/hankha-print-bridge.service`. Authoritative, free, testable, no spawn.
2. **Fallback for bridges installed before that change:**
   - darwin — `launchctl print system/la.hankha.print-bridge` and `gui/$uid/…`, matching
     `pid = ` against `process.pid`. This is exactly the `job_pid` test the .app already does,
     and for the reason its comment gives: **once both installers have been used on one Mac, the
     plist-exists test reports the opposite of the truth.** Never infer from a file's existence.
   - win32 — `schtasks /Query /TN "Hankha Print Bridge"` exits 0 → registered.
   - linux — `INVOCATION_ID` in the environment → systemd. `/.dockerenv`, or the existing
     `containerSuspect()` → container.
3. Nothing matched → `none`.

Cached ~30 s: the fallback path costs a spawn, and `/health` is the hot poll route
(`server.ts:745`) — **it must never call this.**

## 5. Routes

```
GET  /service                → ServiceReport + a fresh confirm token
GET  /service/cache          → per-item counts and byte sizes (what a purge would remove)
POST /service/restart        { confirm }
POST /service/autostart      { confirm }                          ← "install"
POST /service/uninstall      { confirm, scope: 'autostart'|'files'|'everything' }
POST /service/reboot         { confirm, delay_s?, force? }
POST /service/reboot/cancel  { confirm }
POST /service/cache          { confirm, items: ['spool','history','settled','logs'] }
```

One `/service/` prefix so a single gate covers the family, the way `isPairingPath` covers two
paths today.

## 6. The actions

### Restart

> Put the bridge back the way it comes up after a reboot, without touching the machine.

**Refuse when `supervised === false`.** A restart button that kills the only bridge on a till is
the worst bug this feature can have. The card says so and names the command instead.

- **launchd (agent or daemon)** — reuse the existing SIGTERM path (`src/index.ts:301`): stop
  listening, drain up to 8 s, `exit(0)`. Both plists set `KeepAlive: true`, so launchd brings us
  back after `ThrottleInterval` 10 s. Gap: 10–18 s. No spawn, no privilege, nothing to fail.
  (`launchctl kickstart -k` is the "proper" verb and is worse here — it needs a child that
  outlives us, and if it fails we have already killed ourselves.)
- **Windows — a clean exit is not enough.** `-RestartInterval`/`-RestartCount` only fire when
  the task ends **in error** (`installer/windows/install.ps1`), so `exit(0)` leaves the task
  merely "not running" and only the 5-minute repeating trigger recovers it. Instead:
  write `%ProgramData%\Hankha\PrintBridge\restart.cmd` from a string constant in the binary,
  spawn it `{ detached: true, stdio: 'ignore', windowsHide: true }`, `.unref()`, then exit. The
  helper waits for our PID to disappear (up to 30 s — `MultipleInstances IgnoreNew` silently
  drops a `/Run` issued while we are still up), runs
  `schtasks /Run /TN "Hankha Print Bridge"`, polls `/health`, retries twice.
  *Written as a file and invoked as `cmd /c "<path>"`, never composed as one quoted string* —
  the same reason `spooler.ts` writes its PowerShell shim to a temp `.ps1` and runs it with
  `-File`, and the reason `install.ps1` uses `-Execute` rather than `schtasks /TR`.
  **Fallback**, if the helper cannot be written or spawned: exit **1** instead of 0, so the task
  ends in error and `-RestartInterval 1 minute` applies. Slower, never leaves the till bridgeless.
  The response says which happened, and the page's wording follows ("back in a few seconds" vs
  "back within a minute").
- **systemd** — `exit(0)`; `Restart=always`, `RestartSec=5`.
- **container** — refuse. The restart policy is the orchestrator's.

**Answer before acting, always.** `202`, *then* arm a 2 s timer that begins the shutdown.
Responding after the server starts closing hands the browser a network error, which reads as
"I broke it".

**The page must verify by PID.** Capture `pid` from the last `/health`, poll every 1 s for 90 s,
and declare success only when a **different** pid answers. "Something answered" is not "we came
back" — that is the precise bug `installer/macos/scripts/postinstall` was rewritten to catch. On
timeout: name the log file and stop pretending.

### Install — "Start automatically on this computer"

- `autostart === true` → state the fact, offer nothing. Show manager, label, install dir, log path.
- `autostart === false`:
  - **macOS, not root, bundle not under `/Volumes`** → write `~/Library/LaunchAgents/…plist`,
    `launchctl enable` + `bootstrap gui/$uid`. Byte-for-byte what
    `installer/macos/app/HankhaPrintBridge` already does.
    *As built, this ends by stopping ourselves.* Bootstrapping an agent that points at our own
    binary starts a second copy while we still hold port 9200, and it dies on EADDRINUSE;
    KeepAlive plus a 10 s ThrottleInterval turns that into a retry loop, so we hand the port over
    and the next attempt binds. The page waits for a new pid exactly as it does for a restart.
  - **macOS as root, no daemon plist** → write `/Library/LaunchDaemons/…`, `chown root:wheel`,
    `chmod 644`, bootstrap system. The ownership is not hygiene: launchd's refusal of a
    wrongly-owned plist is **silent**, which is why `postinstall` re-stamps it.
  - **Windows** → needs elevation. As SYSTEM we have it: run
    `powershell … -File "<InstallDir>\install.ps1" -SkipCopy -InstallDir "<InstallDir>"`, the
    same call NSIS makes (`hankha-print-bridge.nsi:116`), so there is still exactly one
    implementation of "install". Not SYSTEM → refuse, print the command, copy button.
  - **Linux** → refuse; show the three lines from the top of the unit file.
- Every path ends by re-running detection and reporting `autostart` back. **Never claim success
  without a verify** — that rule is already written into both installers.

### Uninstall

Three scopes, named for what survives, because the word means three different things to the
three people who press it:

| scope | removes | keeps |
|---|---|---|
| `autostart` | the launchd job / scheduled task | binary, `printers.json`, `relay.json`, logs |
| `files` | + the installed payload | state dir (pairing + printers), logs |
| `everything` | + the state dir | logs |

**Logs always survive.** Both existing uninstallers and the README already promise that: they
are the only record of why a till stopped printing.

- **macOS — do it all in-process**, in order: `rm` the plist → `pkgutil --forget` (daemon only)
  → `rm -rf` payload and/or state → answer `202` → `launchctl bootout` ourselves, which kills
  us. Unlinking a running binary is legal on macOS, so nothing needs a helper — and that avoids
  a real trap: `bootout` tears down the whole job, so a detached "finish up after we die" helper
  can be killed along with us.
  The .dmg's app bundle in `/Applications` is not ours to delete — say "drag the app to the
  Trash to finish", the same words its own dialog uses.
- **Windows — the opposite.** A running `.exe` cannot be deleted, so removal must outlive us.
  Prefer the registered `QuietUninstallString` (`hankha-print-bridge.nsi:129`) so the
  Add/Remove Programs entry goes too; fall back to `uninstall.ps1`. Same wait-for-PID helper as
  restart, spawned detached; answer `202`; exit.
- **Terminal page state.** After an uninstall the bridge is going away, so the page stops
  polling and switches to a final "removed" screen listing what was kept and where. A page that
  keeps retrying and settles on a red "cannot reach the bridge" reads as a *failed* uninstall.

### Reboot

The riskiest button here, and the one with the clearest support value — `status.ps1` already
tells operators "restarting this computer normally fixes it".

Guards, all of them:

1. **Queue must be empty.** Non-empty → refuse unless `force: true`, and say exactly what
   happens: queued jobs survive in the spool and print on the way back up; the one currently
   printing is settled `unknown`, which `queue().load()` already does.
2. **Delay, cancellable.** Default 60 s. Hold the timer **in the bridge** and only issue the OS
   command when it fires — one mechanism on both platforms, cancellable, and the page can show a
   countdown. (`shutdown /r /t 60` + `shutdown /a` would work on Windows only; macOS's
   `shutdown -r +1` has a one-minute floor and cancelling means killing its pid.)
3. **Typed confirmation** — the machine's hostname, not an OK button.

Privilege: Windows SYSTEM → `shutdown /r /t 0`. macOS root → `/sbin/shutdown -r now`. macOS as
the user (.dmg agent) → `osascript -e 'tell application "System Events" to restart'`, so open
apps get their chance to save; no GUI session → refuse with the exact `sudo` line. Linux root →
`systemctl reboot`. Container → always refuse; the host is not ours.

Reply `202 { rebooting_at, cancel_until }`. The page counts down with a large Cancel, then goes
deliberately quiet — no "cannot reach the bridge" banner while a reboot is in flight.

### Clear cache

"Cache" is four things here and one of them can cause a **double bill**, so this is a checklist,
not a button. `GET /service/cache` returns a count and a size per item:

| item | what it is | default | risk |
|---|---|---|---|
| `spool` | jobs on disk not yet printed (`<state>/spool/*.json`) | on | they will never print — **settle them as cancelled** so anything awaiting `settled` resolves; do not just unlink |
| `history` | last 200 finished jobs, in memory (`queue.ts:140`) | on | none, it is a display buffer |
| `settled` | the 500-id dedup ring (`settled.jsonl`, `queue.ts:135`) | **off** | this is what stops a redelivered job printing a second bill. The checkbox says so in those words |
| `logs` | `bridge.log` / `hankha-print-bridge.log` | off | the only record of why a till stopped printing |

**Never touched, and the panel says so in one line:** `printers.json` (configuration) and
`relay.json` (this computer's identity + pairing credential). Deleting `relay.json` mints a new
`install_id` and leaves a duplicate dead bridge row in the org — that is **"Unpair this
computer"**, a separate action belonging next to the pairing card, and out of this scope.

Implementation: `queue().purge({ spool, history, settled })` **on the queue itself** — it owns
both the files and the in-memory lanes, and it must cancel them rather than have its directory
swept from underneath it. Log paths come from a `logPath()` in `service.ts`; the three
per-platform paths are already documented in `log.ts`'s header.

## 7. The page

- **One new card, "This computer", last in the grid.** The page is ordered by how often something
  is needed (its header says so) and this is the least often.
- Four rows: label, one line of fact, one button. Facts come from `GET /service` on the existing
  10 s poll — free, because detection is cached server-side.
- **Confirmation is an inline strip inside the card**, not `window.confirm` (which blocks the
  poll loop, and the page has no modal today). Restart and Clear cache: one click → "Restart now
  / Cancel". Uninstall and Reboot: a text input asking for the machine name, matched
  case-insensitively.
- **Three states replace the card body** so a screen left on a till never shows a half state:
  `restarting` (polling for a new pid), `rebooting` (countdown + Cancel), `removed` (final,
  polling stopped).
- **Where the source lives.** `page.ts` is 2,204 lines; this adds CSS, markup and ~250 lines of
  script. Split the fragments into `src/page-service.ts` exporting `SERVICE_CSS`,
  `SERVICE_HTML`, `SERVICE_SCRIPT`, composed into the three literals in `page.ts`.
  ⚠ Two constraints on that file, both already load-bearing:
  **no backtick anywhere inside the literals** — it ends the string and the whole bridge fails to
  start; it has happened four times, and `page-source.test.ts` guards it and **must be extended
  to read the new file** — and **never write the `process.env.APP_VERSION` expression**, which
  `bun build --define` rewrites wherever it appears, strings included.
- **Language.** The pairing screen is already 5 languages via `PS_T`/`psText` (`page.ts:1707`);
  the report below it is English-only. A shop owner is exactly who presses Restart, so the ~14
  strings on this card (4 labels, 4 confirmations, 3 progress lines, 3 outcomes) should go
  through the same table. Everything else on the card is a fact — paths, versions, counts — and
  needs no translation.

## 8. Files

**New**

| file | |
|---|---|
| `src/service.ts` | detection + capability report, no side effects |
| `src/service-actions.ts` | restart / autostart / uninstall / reboot, per platform |
| `src/service-control.ts` | the gate: loopback, origin, host pin, confirm token, one-at-a-time |
| `src/service-helpers-windows.ts` | the `restart.cmd` / `finish-uninstall.cmd` constants + writer |
| `src/page-service.ts` | CSS / HTML / SCRIPT fragments |
| `src/service*.test.ts` | see below |

**Changed**

`src/server.ts` (the family, the `withCors` opt-out, the gate ahead of the token check) ·
`src/page.ts` (compose fragments, one card) · `src/queue.ts` (`purge()`, spool/settled sizes) ·
`src/page-source.test.ts` (scan the new file too) · `installer/windows/print-bridge.cmd` ·
`installer/macos/la.hankha.print-bridge.plist` · `installer/macos/app/HankhaPrintBridge` ·
`deploy/hankha-print-bridge.service` (all four: stamp `PRINT_BRIDGE_MANAGED`) · `README.md` ·
`.env` + `.env.example` (`APP_VERSION`, `PRINT_BRIDGE_SERVICE_CONTROL`) ·
`release-notes/v1.10.0.md`

**Version: MINOR.** `/health` and `/status` gain nothing, but `/service` is new and the POS may
come to gate on it — the README's rule is to bump MINOR whenever an endpoint gains something a
terminal may rely on. Bump `APP_VERSION` in **both** `.env` and `.env.example`, then
`npm run version:sync`.

## 9. Tests

`node:test`, no framework. `server.test.ts` already drives the router directly, so the gate tests
are cheap — and they are the ones that keep the escalation closed:

- **gate** — non-loopback → 403 · `Host: evil.com` → 403 · `Origin: https://evil.example` → 403 ·
  missing / stale / reused confirm token → 403 · a second action while one runs → 409 ·
  `OPTIONS /service/restart` carries no `Access-Control-Allow-Origin`.
- **detection** — the env stamp wins; the fallback shells out through an injected fake
  `runCommand`, the way `QueueOptions.send` is injected for the queue today.
- **restart** — refuses when unsupervised · on win32 writes the helper and spawns detached ·
  the response is sent *before* shutdown begins.
- **purge** — clearing the spool settles waiters rather than orphaning them · `settled` is
  untouched unless asked · **`printers.json` and `relay.json` still exist afterwards** (the
  regression that would cost a venue its pairing).
- **page-source** — the backtick guard, extended to `page-service.ts`.

## 10. Phasing

1. **Gate + `GET /service` + the card, read-only.** Ships "what is this computer running, and
   where are its files" — half the support value, with zero destructive surface.
2. **Restart + Clear cache.** The two safe actions; restart is what support asks for most.
3. **Autostart ("install") + Uninstall.**
4. **Reboot.** Last: it is the only one that can interrupt a sale.

Each phase ships on its own.

## 11. Decisions

1. **Local-only, or eventually remote?** Should the POS / vendor portal be able to restart a
   paired bridge *through the relay* later? That changes nothing now but shapes the split: a
   relay-delivered command has no loopback and no browser origin, so it needs its own signed
   path. Recommendation: build local-only, keep `service-actions.ts` transport-agnostic so a
   relay verb is purely additive.
2. **Reboot — in or out?** It is the only action that can interrupt a sale, and operators are
   already told to do it by hand.
3. **"Unpair this computer" on the same card**, or kept off the page entirely?
4. **Five languages for the card, or English for v1?**

## 12. Non-goals

- Editing `printers.json` from the page. It stays the source of truth, edited via `PUT /printers`.
- **Self-update** — downloading and swapping a running binary, with signature checks and
  rollback, is its own project. `GET /service` can *report* that a newer version exists and the
  card can link to the API's installer redirect (a plain `<a href>` is not blocked by the page's
  `default-src 'none'` CSP; `connect-src 'self'` means the *bridge*, not the page, does the
  version check).
- Log viewing/streaming in the browser. The card names the path; support already asks for the file.
- Anything that runs while the bridge is not running. This page needs the bridge up to serve it —
  a dead bridge is still `status.ps1` / the .app's territory.
