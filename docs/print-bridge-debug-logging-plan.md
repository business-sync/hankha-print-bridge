# Print bridge debug logging: inspection and plan (1.14.3)

Written before the code changes. The reference for what was built is
[print-bridge-debug-logging.md](print-bridge-debug-logging.md).

## Why

Venues report that the bridge "disconnects", sometimes only after it has run for hours. A
venue's `bridge.log` is usually the only evidence, and today it cannot answer the basic
questions:
- Which link dropped?
- Who closed it?
- With what error?
- How long was it down?
- Did it recover on its own?

## How the bridge is put together (relevant parts)

| Area | File | What it does |
|---|---|---|
| Entry and lifecycle | `src/index.ts`, `src/lifecycle.ts` | CLI flags, HTTP server, crash handlers, `stop()` (drain 8 s, backstop 12 s) |
| Logger | `src/log.ts` | `log.debug/info/warn/error(msg, fields)`; text (default) or JSON; level from `PRINT_BRIDGE_LOG_LEVEL` |
| Cloud relay | `src/relay.ts` | One loop: websocket session (`runSocketSession`), long-poll fallback (`/bridge/work?wait=25`), HTTP heartbeat every 30 s, token rejection backoff |
| Websocket client | `src/relay-socket.ts` | RFC 6455 client; 45 s idle timeout with pings at a third of it |
| Watchdog | `src/watchdog.ts` | Restarts the process after 15 min enrolled, running and not connected |
| Pairing | `src/pairing.ts` | QR code flow; starts or wakes the relay |
| Printing | `src/queue.ts`, `src/server.ts`, `src/lan.ts`, `src/transports/*` | Per-printer lanes, retries, `/print` sync route, drivers |
| Installed log | `installer/windows/print-bridge.cmd` | Appends stdout and stderr to `%ProgramData%\Hankha\PrintBridge\logs\bridge.log`; rotates to `.1` past 5 MB, at start only |

## Findings

### Logging gaps
1. **Every field is lost on venue PCs.** The text format, which every installed bridge uses,
   prints only the message (`log.ts`). The `event` and all fields are dropped. Only k8s, which
   runs JSON, keeps them.
2. **Errors lose their stack.** An Error field is reduced to `.message`, and `fetch failed` hides
   the real cause (`err.cause`: ECONNRESET, ENOTFOUND, a TLS error).
3. **Relay failures go unlogged:**
   - Heartbeat network errors are swallowed (`beatOnce().catch(() => {})`).
   - Websocket handshake failures only set `status.last_error`.
   - The socket's error code is discarded, so every reset, timeout or unreachable network reads
     `1006 connection lost`.
   - Frames that are not JSON, and message handlers that throw, are dropped silently.
4. **No timeline:**
   - Sessions have no id and no duration.
   - Nothing says who closed a connection: this process (idle timeout, ack timeout) or the
     server.
   - Recovery is never logged.
   - Nothing records when the last frame or the last successful heartbeat happened.
   - The watchdog's down timer is invisible until it restarts the process.
5. **Repeated noise buries the signal.** A revoked token logs `heartbeat rejected (HTTP 401)` every
   30 s forever; one venue log had hundreds of identical lines.
6. **HTTP is silent.** No access log, and `/print` results and 4xx rejections leave no line.
7. **No long-run diagnostics:** no uptime, memory, event-loop lag or timer liveness.
8. **Process edges are thin:**
   - Listen failures go to `console.error` with no timestamp.
   - Drain duration and outcome are not logged, and a drain error is swallowed.
   - The exit code is not logged.
9. **Swallowed printer-side errors:** a torn spool file, bad settled-ring lines, and registry
   warnings written to raw stderr.

### Connection behaviour (verified, not changed)
- **One loop at a time:** two relay loops cannot run at once. `relayRunning` is checked and set in
  the same synchronous block, and every caller goes through it.
- **Websocket timers are cleaned up:** the heartbeat and ack-watch intervals are cleared on every
  session exit (`closed` always resolves). The HTTP heartbeat interval lives for the process.
- **Auth is told apart from network faults:** only a 401 on the long-poll, a close 1008/4401, or a
  401 on the websocket handshake that a heartbeat with the same token confirms counts as a rejected
  token. 403/5xx/timeouts are transient and retried with backoff.
- **Reconnect delay:** a reconnect after a clean close is floored at 1 s, flaps back off, and
  404/405/426 blocks the websocket for 30 min and falls back to long-polling.

### Hypotheses that need production evidence (logged, not fixed)
- **H1: the watchdog has a blind spot.** It only acts on `connected === false`. A websocket the
  server stopped acking (before the first ack) or a long-poll stuck inside `dispatch` keeps
  `connected === true`, so it is never restarted. New: `relay.stale`.
- **H2: an ungraceful shutdown looks like a drop.** Shutdown does not close the relay, so the
  server sees an abnormal close. New: shutdown and exit lines, so the two can be told apart.
- **H3: Wi-Fi printers ignore the first connection after idle.** Fixed for POS tickets in 1.14.2;
  the cause on the printer side is unconfirmed.

### Secrets
- The bearer token only ever travels in the `Authorization` header and never appears in a URL.
- `relay_url` was logged raw, so userinfo would leak.
- The pairing code was written into the log.
- No redaction existed.

## Plan

1. **`log.ts`:**
   - Text lines keep their prose and gain `{event=… key=value}`, with a level tag on non-info
     lines.
   - JSON keeps `ts`/`msg`/`level` and snake_case, and gains `service`, `version`, `env`, `pid`.
   - `serializeError` gives name, message, code, cause and stack (stack for unexpected errors or
     at debug).
   - Central redaction of credential keys and URLs, and every value held to one line.
   - A `LogGate` for repeat suppression.
   - A test sink.
2. **Relay:**
   - `connection_id`, session open and close with `closed_by` (local, remote or network) and the
     socket error code.
   - Handshake failures, heartbeat failure and recovery, poll debug lines, `relay.recovered` with
     down time, transport switches.
   - Reconnect-storm and stale-link warnings, a loop-exit line, and `relayDiagnostics()`.
   - No protocol or backoff changes.
3. **Watchdog and pairing:** armed and cleared lines; mask the pairing code.
4. **Process:** `app.starting`, `app.config`, `app.ready`, `server.listen_failed`, drain and
   timeout lines, `process.exit`, and serialized crash errors.
5. **`src/diagnostics.ts`:**
   - A periodic `diag.snapshot` with memory, event-loop lag, relay and queue state.
   - Lag and timer-stall warnings.
   - Configurable, with 0 disabling it. Also on `/status`.
6. **Printer and HTTP:** `http.request` (debug), `print.sync.result`, `print.rejected`, queue
   `source`/`total_ms`/`queue.attempt`, and the swallowed errors logged.
7. **Docs, `.env.example`, tests and version 1.14.3.**

Log level, format and diagnostics stay controlled by environment variables (on a venue PC,
`bridge.env`), so debug can be switched on in production without a code change.
