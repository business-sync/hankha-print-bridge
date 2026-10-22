# Print bridge logging and diagnostics

How the bridge logs, how to turn on more detail on a venue PC, and how to read a log when the
bridge disconnects, a printer stops, or a job goes missing. The inspection that led to this is in
[print-bridge-debug-logging-plan.md](print-bridge-debug-logging-plan.md).

## Architecture

All logging goes through one module, `src/log.ts`: `log.debug/info/warn/error(message, fields)`.
Every record has:

- a human sentence (`msg`), the prose a shop owner reads;
- a stable `event` id (`relay.ws.close`, `queue.failed`, …), which is what to search on, because
  wording changes and event ids don't;
- structured fields in snake_case (`job_id`, `printer_id`, `connection_id`, `duration_ms`, …).

### Formats

**Text** (`PRINT_BRIDGE_LOG_FORMAT=text`, the default and what every installed bridge writes):

```
2026-10-22 18:49:10 WARN relay: websocket closed (1006: connection lost: ECONNRESET) by network after 4 min {event=relay.ws.close connection_id=9f3a1c02 code=1006 reason="connection lost: ECONNRESET" closed_by=network error_code=ECONNRESET session_ms=241337 frames_in=12}
2026-10-22 18:49:11 queue: job 4c6b18f7 printed on bill in 2ms {event=queue.done job_id=4c6b18f7 printer_id=bill source=local duration_ms=2 attempts=1 total_ms=3}
```

- The local time comes first.
- Info lines have no level tag; other levels show `DEBUG`, `WARN` or `ERROR`.
- The fields are appended in `{…}`. Values with spaces or quotes are JSON-quoted.
- A record is always one line: line breaks, including those in stack traces, are escaped as `\n`.

**JSON** (`PRINT_BRIDGE_LOG_FORMAT=json`, what k8s prod uses) gives one object per line:

```json
{"ts":"2026-10-22T11:49:10.512Z","level":"warn","service":"hankha-print-bridge","version":"1.14.3","env":"k8s","pid":1,"msg":"relay: websocket closed …","event":"relay.ws.close","connection_id":"9f3a1c02","code":1006,"closed_by":"network","error_code":"ECONNRESET","session_ms":241337}
```

`ts`, `msg` and `level` keep their pre-1.14.3 names, so existing log queries keep working. A field
can never overwrite the envelope: a field named `level` comes out as `field_level`.

**Where logs go:**
- **warn and error** go to stderr; everything else goes to stdout.
- **Windows:** `print-bridge.cmd` appends both streams to
  `C:\ProgramData\Hankha\PrintBridge\logs\bridge.log`.
- **macOS:** launchd writes to `/var/log/hankha-print-bridge.log` (.pkg, system daemon) or
  `~/Library/Logs/hankha-print-bridge.log` (.dmg, per-user agent).
- **k8s:** stdout is collected by the cluster.

**Rotation:** the Windows launcher rotates only **at start**. If `bridge.log` is over 5 MB it
becomes `bridge.log.1`, and only one old file is kept. Nothing rotates while the bridge runs, so
don't leave debug on for days.

### Errors

Pass the error as `err`:

```ts
log.warn('relay: heartbeat failed', { event: 'relay.heartbeat.failed', err });
```

The record gets these fields:
- `error_name`, `error_message`, `error_code`;
- `cause_code` and `cause_message`, from `err.cause`. This is where a bare "fetch failed" keeps
  its real reason (ECONNRESET, ENOTFOUND, a TLS error);
- `stack`, for errors marked `expected: false` (bugs, crashes) and for every error at debug level.

Expected failures, such as a printer refusing a connection or a 401, carry no stack.

### Redaction

Applied centrally to every field before output:
- **Credential keys:** any key matching
  `token|authorization|password|passwd|secret|api_key|cookie|pair_code` becomes `[redacted]`, at
  any depth.
- **URLs:** any URL-shaped string loses its `user:pass@` part and the values of secret-looking
  query parameters.
- **Size limits:** strings are capped at 1000 characters; objects at 3 levels, 30 keys and 20
  array items.
- **Pairing codes:** shown masked (`PSPN-****`). The screen already shows the full code to the
  person who needs it.
- **Bearer token:** never logged. It only ever travels in the `Authorization` header, and the
  tests assert it appears in no record.

### Repeat suppression

A condition that repeats is logged once, then at most once per 10 minutes with a count
(`… (repeated 118 times over 59 min)`), and closed by a recovery line. This covers:
- heartbeat failures and rejections;
- poll retries;
- websocket handshake failures and bad frames;
- stale-link and reconnect-storm warnings;
- event-loop lag and stalled timers.

Before 1.14.3 a revoked token wrote the same 401 line every 30 seconds.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PRINT_BRIDGE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Debug adds: every poll and heartbeat with status and duration, every HTTP request (`http.request`), every send attempt (`queue.attempt`), websocket connect attempts and pairing poll errors |
| `PRINT_BRIDGE_LOG_FORMAT` | `text` | `text` or `json` |
| `PRINT_BRIDGE_DIAG_INTERVAL_MIN` | `15` | Minutes between `diag.snapshot` lines; fractions allowed; `0` turns them off. The lag sampler keeps running for `/status` |
| `PRINT_BRIDGE_DIAG_LAG_WARN_MS` | `1000` | Event-loop stall that logs `diag.event_loop_lag` |
| `PRINT_BRIDGE_ENV` | `k8s` in a pod, else `venue` | The `env` field in JSON logs |

The relay, watchdog and queue settings (`PRINT_BRIDGE_HEARTBEAT_MS`, `_ACK_TIMEOUT_MS`,
`_WATCHDOG_MINUTES`, `_SEND_TIMEOUT_MS`, `_CONNECT_TIMEOUT_MS`, `_SYNC_TIMEOUT_MS`, …) are
documented in `.env.example`. The values a process actually resolved are logged at every start
as `app.config`.

### Turning on debug in production

No code change is needed: set the variable where the service reads its environment, then restart
the bridge.

**Windows (setup.exe install).** As administrator, in PowerShell:

```powershell
Add-Content C:\ProgramData\Hankha\PrintBridge\bridge.env "PRINT_BRIDGE_LOG_LEVEL=debug"
schtasks /End /TN "Hankha Print Bridge"; schtasks /Run /TN "Hankha Print Bridge"
```

The **Restart** button on `http://localhost:9200` works too.
- **To undo:** remove the line and restart again.
- **Watch out:** re-running the installer with "Serve other terminals on this network" ticked
  rewrites `bridge.env`.

**macOS (.pkg, system daemon):**

```bash
sudo /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PRINT_BRIDGE_LOG_LEVEL string debug" /Library/LaunchDaemons/la.hankha.print-bridge.plist
sudo launchctl bootout system/la.hankha.print-bridge; sudo launchctl bootstrap system /Library/LaunchDaemons/la.hankha.print-bridge.plist
```

For the **.dmg** (per-user agent), the plist is
`~/Library/LaunchAgents/la.hankha.print-bridge.plist`, and the domain is `gui/$(id -u)` instead
of `system`. To undo, run PlistBuddy with `Delete :EnvironmentVariables:PRINT_BRIDGE_LOG_LEVEL`.

**k8s:** set `PRINT_BRIDGE_LOG_LEVEL: "debug"` in `k8s/prod/config.yaml` (the ConfigMap) and
roll the deployment.

### Reading and filtering

**Windows (PowerShell):**

```powershell
Get-Content C:\ProgramData\Hankha\PrintBridge\logs\bridge.log -Wait -Tail 200
Select-String -Path C:\ProgramData\Hankha\PrintBridge\logs\bridge.log -Pattern "event=relay\.(ws\.close|retry|recovered|stale|token_rejected)"
Select-String -Path C:\ProgramData\Hankha\PrintBridge\logs\bridge.log -Pattern "job_id=accept-1557"
```

**macOS:**

```bash
tail -f /var/log/hankha-print-bridge.log
grep -E 'event=(relay\.|diag\.)' /var/log/hankha-print-bridge.log
```

**k8s (JSON):**

```bash
kubectl logs deploy/hankha-print-bridge --since=6h | jq -c 'select(.event|test("^relay\\."))'
kubectl logs deploy/hankha-print-bridge --since=24h | jq -c 'select(.event=="diag.snapshot") | {ts, rss_mb, heap_used_mb, lag_max_ms, relay_connected}'
```

**Live numbers without the log:** `GET http://localhost:9200/status` includes a `diagnostics`
block (memory, loop lag, relay timings, stalled timers).

## Event catalog

The events most useful for a disconnect or a missing ticket. Levels are the defaults.

### Process
| Event | Level | Key fields |
|---|---|---|
| `app.starting` | info | version, pid, platform, arch, runtime |
| `app.config` | info | host, port, log_level, log_format, relay_transport, watchdog_ms, diag_interval_ms, auth_required, … |
| `server.listening` | info | host, port, scheme |
| `app.ready` | info | startup_ms |
| `server.listen_failed` | error | host, port, error_code (EADDRINUSE…) |
| `server.shutdown` | info | signal (SIGTERM, `service-request`, `watchdog: …`), exitCode, uptime_s, relay_connected, connection_id |
| `server.drain` / `server.drain_failed` | info / error | duration_ms, pending_left |
| `server.shutdown_timeout` | warn | timeout_ms, pending_left |
| `process.exit` | info | code, uptime_s |
| `process.uncaught_exception` / `process.unhandled_rejection` | error | error_*, stack, expected=false |

**Reading the end of a run:**
- `server.shutdown` then `process.exit` is a clean stop.
- A `==== started ====` banner with neither before it is a crash or a forced kill.
- exit 1 after `relay.watchdog.restart` is a watchdog restart.

### Relay (the cloud connection)
| Event | Level | Key fields |
|---|---|---|
| `relay.start` | info | bridge_id, relay_url (redacted), transport_mode, heartbeat_ms, ack_timeout_ms |
| `relay.ws.connecting` | debug | connection_id |
| `relay.ws.open` | info | connection_id, handshake_ms |
| `relay.ws.close` | info (1000/1001) or warn | connection_id, code, reason, **closed_by** (`local` / `remote` / `network`), error_code, session_ms, frames_in, last_frame_ago_ms, since_ack_ms |
| `relay.ws.handshake_failed` | warn, gated | status or error_code / cause_code, duration_ms |
| `relay.ws.ack_timeout` | warn | since_ack_ms (followed by a `local` close, code 4000) |
| `relay.ws.flap` | warn | session_ms, wait_ms |
| `relay.ws.bad_frame` / `relay.ws.handler_error` | warn / error | bytes, error_* |
| `relay.ws.unsupported` / `relay.ws.blocked` | info / debug | the server has no websocket; long-polling for 30 min |
| `relay.poll` | debug | status, duration_ms |
| `relay.retry` | warn, gated | detail, status, error_code, cause_code, failures, wait_ms, repeated |
| `relay.recovered` | info | transport, down_ms, failures, suppressed_retries |
| `relay.transport` | info | from, to |
| `relay.heartbeat` | debug | status, duration_ms |
| `relay.heartbeat.failed` / `relay.heartbeat.rejected` | warn, gated | error_* or status, failures, repeated |
| `relay.heartbeat.recovered` | info | failures, outage_ms |
| `relay.token_rejected` | error | wait_ms, rejections, bridge_id |
| `relay.token_switched` | info | bridge_id |
| `relay.stale` | warn, gated | transport, silent_ms. Marked connected, but nothing has arrived for more than 3 heartbeats |
| `relay.reconnect_storm` | warn, gated | reconnects_last_hour (more than 20) |
| `relay.watchdog.armed` / `relay.watchdog.cleared` / `relay.watchdog.restart` | info / info / error | limit_ms; down_ms, because; down_ms |
| `relay.loop.exited` | error | should never appear: the bridge is offline until restarted |
| `relay.dispatch.failed` / `relay.result.failed` | error / warn | kind or job_id, error_* |

### Printing
| Event | Level | Key fields |
|---|---|---|
| `queue.submit` | info | job_id, printer_id, source (`local` / `relay`), transport, address, bytes, copies, lane_depth |
| `queue.attempt` | debug | job_id, attempt, wait_ms |
| `queue.retry` | warn | job_id, reason, attempt, wait_ms |
| `queue.done` | info | job_id, printer_id, source, duration_ms, attempts, total_ms |
| `queue.failed` | error | job_id, reason, printed_certainty, detail, attempts, total_ms |
| `queue.stalled` / `queue.expired` / `queue.cancelled` / `queue.duplicate` | error / warn / info / warn | job_id |
| `print.sync.result` | debug (ok) or warn (failed) | route, status, job_id, printer_id, attempts, reason, printed_certainty, duration_ms |
| `print.rejected` | info | route, status, reason, errors |
| `print.test.result` | debug or warn | as above, for the page's test print |
| `http.request` | debug | method, path, status, duration_ms, remote. Excludes polling of `/health` and `/status` |
| `registry.*`, `queue.spool.*`, `spooler.*`, `serial.*` | various | file and printer problems that used to be silent |

### Diagnostics
| Event | Level | Key fields |
|---|---|---|
| `diag.snapshot` | info | uptime_s, rss_mb, heap_used_mb, heap_total_mb, external_mb, rss_delta_mb, lag_max_ms, lag_p99_ms, relay_connected, relay_transport, relay_session_ms, relay_since_frame_ms, relay_since_poll_ok_ms, relay_since_heartbeat_ok_ms, relay_down_ms, relay_failures, relay_reconnects_last_hour, queue_pending, queue_printing, printers, stalled_timers |
| `diag.event_loop_lag` | warn, gated | lag_ms, warn_ms |
| `diag.timer_stalled` | warn, gated | timer (`relay.heartbeat`, `watchdog`, `diag.sampler`), since_ms, interval_ms |

## Troubleshooting

### The bridge disconnected after several hours
1. **Find the drop.** Search for `event=relay.ws.close`, `event=relay.retry` or `event=relay.stale`
   near the reported time.
2. **Read `closed_by`:**
   - `network` with an `error_code` (ECONNRESET, ETIMEDOUT): the venue's link or a proxy cut the
     connection.
   - `remote` with a code: the server ended it, for example during a deploy.
   - `local` with reason `no traffic from server` or `no ack`: the bridge gave up on a link that
     had gone silent.
3. **Confirm recovery.** Look for `relay.recovered` with its `down_ms`. If there is none, the
   outage was still going when the log ends.
4. **Check the run-up.** Look at the `diag.snapshot` lines before the drop:
   - `rss_mb` climbing every snapshot points to a leak;
   - `lag_max_ms` in the seconds means the event loop was starved;
   - `stalled_timers` means a background task died.
5. **If it is marked connected but nothing prints,** look for `relay.stale`. The watchdog doesn't
   act on this state, so check whether `relay_since_poll_ok_ms` keeps growing in the snapshots.
6. **If the process restarted:** `relay.watchdog.armed` and then `relay.watchdog.restart` mean
   15 minutes down while paired. A banner with no `server.shutdown` before it means a crash; look
   for `process.uncaught_exception`.

### The websocket closed unexpectedly
Search for `event=relay.ws.close` and take its `connection_id`. The matching `relay.ws.open` gives
the session length.
- `code=1006` with `closed_by=local reason="no traffic from server"`: 45 s of silence, so the
  path stopped carrying even pings.
- `code=4000 reason="no ack"` (`local`): the server stopped acking for 95 s.
- `code=1008` or `4401`: the credential was revoked; see the next section.

### Authentication or token failure
- **`relay.token_rejected`:** the server has no live bridge row for this token. Only two things
  revoke one: Remove in the POS, or re-pairing with Replace. Look for a `pairing.paired` line
  shortly before it.
- **`relay.token_switched`:** the bridge picked up a newer pairing by itself.
- **`relay.heartbeat.rejected` with status 401** and no token rejection yet: the loop has not
  noticed. It will on its next poll.

Fix: open `http://localhost:9200` on that PC and pair it again.

### A printer is unavailable
Search for `event=queue.failed` and `event=queue.retry` for that `printer_id`:
- `reason=connect-timeout` or `connect-refused` with `printed_certainty=none`: the printer never
  took the connection. Check its power, IP address and Wi-Fi power saving. The bridge retries
  these safely.
- `reason=write-timeout` with `printed_certainty=unknown`: it connected and then stopped taking
  data (paper out, cover open). It is not reprinted automatically.
- `address=` on `queue.submit` shows which IP and port the job went to.

### A print job is stuck or failed
Search by `job_id` (POS tickets look like `accept-<order>-…` or a UUID; relay jobs are numbers):
1. `queue.submit` shows `lane_depth`, the number of jobs ahead of it.
2. `queue.attempt` (debug) shows `wait_ms`, the time spent queued.
3. `queue.done` or `queue.failed` gives the outcome and `total_ms`.
4. For POS tickets, `print.sync.result` shows exactly what the POS was told.

**Stalls and repeats:**
- `queue.stalled`: a driver overran the send deadline. The job is settled as `unknown` and the
  lane moves on.
- `queue.duplicate` ("submitted twice"): a retry of an id that already settled was answered from
  memory, not reprinted.

### A reconnection loop
- **`relay.reconnect_storm`:** more than 20 websocket sessions in an hour.
- **`relay.ws.flap`:** sessions are ending within 10 s. Usually two bridges share one token, or a
  proxy keeps cycling.
- **Two `==== started ====` banners a few seconds apart:** the second binds `0.0.0.0`. That is the
  installer's "Serve other terminals" option restarting the bridge, not two copies running.

### High memory or stalled background tasks
Graph `rss_mb`, `heap_used_mb` and `lag_max_ms` from `diag.snapshot`:
- **Heap growing steadily** across hours of the same traffic suggests a leak. Note the uptime and
  report it with the log.
- **`diag.event_loop_lag`** names when the loop was blocked; correlate it with the jobs and scans
  around that time.
- **`diag.timer_stalled timer=relay.heartbeat`** means the heartbeat interval stopped running.
  The POS will show the bridge offline. Restart the bridge and send the log.
