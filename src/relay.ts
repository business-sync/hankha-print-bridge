import { loadState, saveState, type RelayState } from './identity.js';
import { containerSuspect, DEFAULT_PRINTER_PORT, localInterfaces, runScan } from './lan.js';
import { adHocNetworkPrinter, targetFrom } from './jobs.js';
import { log } from './log.js';
import { queue, type JobResult } from './queue.js';
import { findPrinter, loadRegistry, resolveByAddress } from './registry.js';
import { connectWebSocket, WebSocketHandshakeError } from './relay-socket.js';
import { BRIDGE_VERSION } from './version.js';
import { arch, hostname, platform } from 'node:os';
import { backoffMs } from './backoff.js';

/**
 * The outbound half of the bridge.
 *
 * Everything else in this process waits for someone on the LAN to call it. This dials OUT to
 * the cloud API and long-polls for work, which is what lets a device that cannot reach the shop
 * network at all — a phone, a tablet, a till on mobile data — still print. No inbound port, no
 * TLS certificate on the shop PC, no NAT traversal, and identical behaviour on iOS and Android.
 */

const DEFAULT_RELAY_URL = 'https://api.hankha.la';
const POLL_WAIT_S = 25;
const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * How long to leave WebSocket alone after a server says it does not speak it.
 *
 * A 404 is a fact about the deployment, not a transient fault: the endpoint either exists or it
 * does not. Retrying every 30 seconds against a backend that will never answer is pure noise in
 * both logs, so it is asked again only twice an hour — often enough to pick up a deploy, rare
 * enough to be invisible.
 */
const WS_UNSUPPORTED_RETRY_MS = 30 * 60_000;

type Work =
  | {
      type: 'print';
      job: {
        job_id: string;
        client_job_id: string;
        /** Not sent today. Read when present, so the server can address a bridge's own printers. */
        printer_id?: string;
        kind: string;
        target_ip: string;
        target_port: number;
        payload_base64: string;
        payload_sha256: string;
        attempt: number;
        claim_expires_at: string;
      };
    }
  | { type: 'scan'; command_id: string; port: number };

function relayUrl(state: RelayState): string {
  const configured = process.env.PRINT_BRIDGE_RELAY_URL?.trim() || state.relay_url;
  return (configured || DEFAULT_RELAY_URL).replace(/\/+$/, '');
}

function describeSelf() {
  const interfaces = localInterfaces();
  return {
    version: BRIDGE_VERSION,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    interfaces,
    net_warning: containerSuspect(interfaces) ? ('container-suspect' as const) : null,
  };
}

/** Redeem a one-time enrollment code for a bearer token. Persists on success. */
export async function enroll(code: string): Promise<{ bridge_id: string }> {
  const state = loadState();
  const base = relayUrl(state);
  const self = describeSelf();
  const res = await fetch(`${base}/api/v1/modules/print/bridge/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enroll_code: code,
      install_id: state.install_id,
      version: self.version,
      hostname: self.hostname,
      platform: self.platform,
      arch: self.arch,
      interfaces: self.interfaces,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'That enrollment code is not valid, has already been used, or has expired.'
        : `Enrollment failed: HTTP ${res.status}`
    );
  }
  const body = (await res.json()) as { data: { bridge_id: string; token: string } };
  saveState({
    ...state,
    relay_url: base,
    bridge_id: body.data.bridge_id,
    token: body.data.token,
    enrolled_at: new Date().toISOString(),
  });
  return { bridge_id: body.data.bridge_id };
}

export interface RelayStatus {
  enrolled: boolean;
  bridge_id: string | null;
  connected: boolean;
  /** Which channel is carrying work right now. Null until the first successful exchange. */
  transport: 'websocket' | 'long-poll' | null;
  last_ok_at: string | null;
  last_error: string | null;
}

const status: RelayStatus = {
  enrolled: false,
  bridge_id: null,
  connected: false,
  transport: null,
  last_ok_at: null,
  last_error: null,
};

export function relayStatus(): RelayStatus {
  return { ...status };
}

async function postResult(base: string, token: string, jobId: string, result: JobResult): Promise<void> {
  const res = await fetch(`${base}/api/v1/modules/print/bridge/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(15_000),
  });
  // 409 means the server already settled this job (usually our own earlier report arriving
  // twice). Not an error worth retrying — the outcome is recorded either way.
  if (!res.ok && res.status !== 409) throw new Error(`result POST failed: HTTP ${res.status}`);
}

async function handlePrint(base: string, token: string, work: Extract<Work, { type: 'print' }>) {
  const { job } = work;

  const target = targetFrom(job.target_ip, job.target_port);
  const registry = loadRegistry();
  // `printer_id` is not on the wire today. Preferring it costs nothing and means the server can
  // start addressing a bridge's own printers — including USB ones, which have no IP at all —
  // without this file changing.
  const named = job.printer_id ? findPrinter(registry, job.printer_id) : null;
  const printer = named ?? (target ? resolveByAddress(registry, target.ip, target.port) ?? adHocNetworkPrinter(target.ip, target.port) : null);

  if (!printer) {
    await postResult(base, token, job.job_id, {
      ok: false,
      reason: 'device-missing',
      printed_certainty: 'none',
      detail: `no printer matches ${job.printer_id ?? `${job.target_ip}:${job.target_port}`}`,
    });
    return;
  }

  // The server's claim is the job's real deadline. A bridge that comes back after an outage must
  // drop the backlog rather than print an hour-old receipt onto a till that has moved on.
  const claimMs = job.claim_expires_at ? Date.parse(job.claim_expires_at) - Date.now() : Number.NaN;
  const ttl_s = Number.isFinite(claimMs) && claimMs > 0 ? Math.ceil(claimMs / 1000) : undefined;

  const submission = queue().submit({
    job_id: job.job_id,
    source: 'relay',
    printer,
    payload: Buffer.from(job.payload_base64, 'base64'),
    ttl_s,
  });

  // Deliberately NOT awaited. Printing used to happen inline here, which meant a printer taking
  // four seconds to answer stopped the bridge fetching ANY further work for those four seconds —
  // on a busy service, that is the whole reason tickets arrived late. The queue owns ordering and
  // retries now; this loop's only job is to keep the channel moving.
  //
  // Redelivery is safe: the queue answers a job id it has already settled from its on-disk ring
  // instead of printing a second copy, so a duplicate here becomes a duplicate REPORT, never a
  // duplicate receipt.
  void submission.settled
    .then((settled) =>
      postResult(base, token, job.job_id, settled.result ?? { ok: false, reason: 'unknown', printed_certainty: 'unknown' })
    )
    .catch((err: unknown) => {
      // The print already happened or already failed; only the report was lost. The server's own
      // sweeper moves an unreported job to UNKNOWN, and it never re-queues one, so nothing prints
      // twice as a result of this.
      log.warn(`relay: could not report job ${job.job_id} (${err instanceof Error ? err.message : String(err)})`, {
        event: 'relay.result.failed', job_id: job.job_id,
      });
    });
}

async function handleScan(base: string, token: string, work: Extract<Work, { type: 'scan' }>) {
  // Shares `runScan`'s in-flight map with the LAN /scan route, so a cloud-requested scan and a
  // button press on the same port join one sweep instead of doubling the SYN traffic.
  const scan = await runScan(work.port || DEFAULT_PRINTER_PORT);
  await fetch(`${base}/api/v1/modules/print/bridge/scan-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      command_id: work.command_id,
      subnets: scan.subnets,
      duration_ms: scan.duration_ms,
      printers: scan.printers,
    }),
    signal: AbortSignal.timeout(15_000),
  });
}

async function heartbeat(base: string, token: string): Promise<void> {
  await fetch(`${base}/api/v1/modules/print/bridge/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(describeSelf()),
    signal: AbortSignal.timeout(15_000),
  });
}

async function dispatch(base: string, token: string, work: Work): Promise<void> {
  if (work.type === 'print') await handlePrint(base, token, work);
  else if (work.type === 'scan') await handleScan(base, token, work);
}

type RelayMode = 'auto' | 'ws' | 'poll';

function relayMode(): RelayMode {
  const raw = process.env.PRINT_BRIDGE_RELAY_TRANSPORT?.trim().toLowerCase();
  return raw === 'ws' || raw === 'poll' ? raw : 'auto';
}

function socketUrl(base: string): string {
  return `${base.replace(/^http/, 'ws')}/api/v1/modules/print/bridge/socket`;
}

type SessionOutcome = 'served' | 'unsupported' | 'revoked' | 'error';

/**
 * One WebSocket session, from handshake to close.
 *
 * The server does not implement this endpoint yet, and that is the case this is written around:
 * an ordinary HTTP answer to the upgrade means "not here", which is remembered rather than
 * retried, and the long-poll below carries the traffic exactly as it does today. The moment the
 * endpoint appears, every bridge in the fleet picks it up within half an hour with no new release.
 *
 * The expected server side is small: accept the upgrade with the same bearer token the other
 * bridge routes take, then push the SAME `Work` JSON objects the long-poll returns. Results keep
 * going back over HTTP — reusing an endpoint that already exists is worth more than the round trip
 * it saves, and it means a half-built server side cannot lose a print result.
 */
async function runSocketSession(base: string, token: string): Promise<SessionOutcome> {
  let client: Awaited<ReturnType<typeof connectWebSocket>>;
  try {
    client = await connectWebSocket({
      url: socketUrl(base),
      headers: { Authorization: `Bearer ${token}` },
      onMessage: (text) => {
        let work: Work;
        try {
          work = JSON.parse(text) as Work;
        } catch {
          return;
        }
        // Unknown types are ignored rather than treated as errors, so the server can add a frame
        // kind without every deployed bridge dropping its connection over it.
        if (work.type !== 'print' && work.type !== 'scan') return;
        void dispatch(base, token, work).catch((err: unknown) => {
          log.error(`relay: failed to handle ${work.type} (${err instanceof Error ? err.message : String(err)})`, {
            event: 'relay.dispatch.failed', kind: work.type,
          });
        });
      },
    });
  } catch (err) {
    if (err instanceof WebSocketHandshakeError) {
      if (err.status === 401 || err.status === 403) return 'revoked';
      // Any ordinary HTTP answer that is not an auth failure means this path does not speak
      // WebSocket. A 5xx is the exception: that is a server having a bad minute, not a missing
      // route, and it should be retried like any other transient fault.
      if (err.status !== null && err.status < 500) return 'unsupported';
    }
    status.last_error = err instanceof Error ? err.message : String(err);
    return 'error';
  }

  status.connected = true;
  status.transport = 'websocket';
  status.last_ok_at = new Date().toISOString();
  status.last_error = null;
  log.info('relay: connected over websocket', { event: 'relay.ws.open' });

  client.send(JSON.stringify({ type: 'hello', ...describeSelf() }));
  const beat = setInterval(() => client.send(JSON.stringify({ type: 'heartbeat', ...describeSelf() })), HEARTBEAT_INTERVAL_MS);
  beat.unref();

  const { code, reason } = await client.closed;
  clearInterval(beat);
  status.connected = false;
  status.last_error = code === 1000 ? null : `websocket closed (${code}${reason ? `: ${reason}` : ''})`;
  log.info(`relay: websocket closed (${code})`, { event: 'relay.ws.close', code, reason });
  return code === 1008 || code === 4401 ? 'revoked' : 'served';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));



/**
 * The relay loop. Runs forever; never throws.
 *
 * One channel carries both jobs and commands, so this is a single loop rather than two — two
 * would double the connection count for no benefit and make ordering ambiguous.
 */
export function startRelay(): void {
  const state = loadState();
  if (!state.token || !state.bridge_id) {
    log.info(
      'print bridge is not enrolled — run `hankha-print-bridge --enroll <code>` with a code from Settings > Printing',
      { event: 'relay.not_enrolled' }
    );
    return;
  }

  const base = relayUrl(state);
  const token = state.token;
  status.enrolled = true;
  status.bridge_id = state.bridge_id;
  log.info(`relay: enrolled as bridge ${state.bridge_id}, connecting to ${base}`, {
    event: 'relay.start', bridge_id: state.bridge_id, relay_url: base,
  });

  const beatOnce = () =>
    heartbeat(base, token).catch(() => {
      /* the poll loop is the real liveness signal; a missed beat is not worth logging */
    });

  // Beat IMMEDIATELY, not at the first interval. `online` upstream is derived from
  // `last_seen_at`, so waiting a full interval leaves a freshly-restarted bridge showing as
  // offline in the POS for 30 seconds — during which an operator is told they cannot print
  // through a bridge that is in fact running.
  void beatOnce();
  const beat = setInterval(beatOnce, HEARTBEAT_INTERVAL_MS);
  beat.unref();

  const mode = relayMode();
  // `poll` pins the old behaviour; `ws` refuses to fall back, for testing a server that does
  // implement the socket. `auto` — the default — prefers the socket and quietly degrades.
  let wsBlockedUntil = mode === 'poll' ? Number.POSITIVE_INFINITY : 0;
  let wsUnsupportedLogged = false;

  void (async () => {
    let failures = 0;
    for (;;) {
      if (Date.now() >= wsBlockedUntil) {
        const outcome = await runSocketSession(base, token);
        if (outcome === 'revoked') {
          status.connected = false;
          status.last_error = 'token rejected — re-enrollment required';
          log.error('relay: token rejected. Re-enroll with `hankha-print-bridge --enroll <code>`', {
            event: 'relay.token_rejected',
          });
          clearInterval(beat);
          return;
        }
        if (outcome === 'served') {
          // A clean session ended: reconnect straight away rather than falling back, because the
          // endpoint demonstrably exists.
          failures = 0;
          continue;
        }
        if (outcome === 'unsupported') {
          wsBlockedUntil = Date.now() + WS_UNSUPPORTED_RETRY_MS;
          if (!wsUnsupportedLogged) {
            wsUnsupportedLogged = true;
            log.info('relay: this server does not offer a websocket endpoint — using long-polling', {
              event: 'relay.ws.unsupported',
            });
          }
        }
        if (mode === 'ws') {
          // Explicitly pinned to websocket: never silently start polling instead.
          const wait = backoffMs(Math.min(failures, 5));
          failures += 1;
          await sleep(wait);
          continue;
        }
      }

      try {
        const res = await fetch(
          `${base}/api/v1/modules/print/bridge/work?wait=${POLL_WAIT_S}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            // Comfortably longer than the server's wait, so a healthy long-poll is never cut
            // short by the client and mistaken for a network fault.
            signal: AbortSignal.timeout((POLL_WAIT_S + 15) * 1000),
          }
        );

        if (res.status === 401) {
          // The token was revoked or the bridge was deleted. Stop rather than hammer: only a
          // human with a fresh enrollment code can fix this.
          status.connected = false;
          status.last_error = 'token rejected — re-enrollment required';
          log.error('relay: token rejected. Re-enroll with `hankha-print-bridge --enroll <code>`', {
            event: 'relay.token_rejected',
          });
          clearInterval(beat);
          return;
        }

        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);

        status.connected = true;
        status.transport = 'long-poll';
        status.last_ok_at = new Date().toISOString();
        status.last_error = null;
        failures = 0;

        if (res.status === 204) {
          // The normal, quiet path — not an error. Re-poll immediately with only enough
          // jitter to keep a fleet from synchronising.
          await sleep(Math.random() * 250);
          continue;
        }

        await dispatch(base, token, (await res.json()) as Work);
      } catch (err) {
        status.connected = false;
        status.last_error = err instanceof Error ? err.message : String(err);
        const wait = backoffMs(Math.min(failures, 5));
        failures += 1;
        // Logged at most every few seconds by the backoff itself, so a venue that loses its
        // uplink overnight does not fill the log file.
        log.error(`relay: ${status.last_error} — retrying in ${Math.round(wait / 1000)}s`, {
          event: 'relay.retry', detail: status.last_error, wait_ms: wait,
        });
        await sleep(wait);
      }
    }
  })();
}
