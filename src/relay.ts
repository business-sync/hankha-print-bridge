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

/**
 * A floor under every websocket reconnect, including the ones we consider clean.
 *
 * Cheap insurance rather than a tuning knob: the reconnect path had no delay at all, so any
 * close that reached it spun the loop as fast as the network would allow — a log line, a
 * synchronous registry read and a TCP handshake per iteration. Narrowing which close codes get
 * here is the real fix; this makes the category incapable of spinning again.
 */
const RECONNECT_FLOOR_MS = 1_000;
/**
 * How much of the server's claim window to leave unused, so a terminal result can be reported
 * and accepted before the claim lapses and the sweeper writes UNKNOWN over it.
 */
const RESULT_RESERVE_MS = 10_000;

type Work =
  | {
      type: 'print';
      job: {
        job_id: string;
        client_job_id: string;
        /**
         * An entry in this bridge's own registry. Set when the server is addressing a printer
         * this machine owns — the only way to reach a USB or serial one, which has no address
         * for a remote till to send. Preferred over `target_ip` when both somehow arrive.
         */
        printer_id?: string;
        kind: string;
        /** Null when `printer_id` addresses the job instead. */
        target_ip: string | null;
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

/**
 * How many registry entries are reported upstream.
 *
 * A venue has a handful of printers; the cap exists so a corrupted `printers.json` cannot turn
 * every 30-second heartbeat into a large POST.
 */
const MAX_REPORTED_PRINTERS = 64;

/**
 * This bridge's own configured printers, for the cloud to offer as print targets.
 *
 * Without this a remote till can only choose from `/scan` hits, which are by definition network
 * printers — so a USB or Bluetooth printer attached to THIS machine was unreachable from a
 * tablet unless an operator invented a fake private IP for it and typed the same fake address
 * into the POS. Reporting the registry is what lets the server address a printer by its id.
 *
 * Deliberately a summary, not the whole record: baud rates, codepages and label dimensions are
 * this machine's business and change nothing about which printer a remote operator wants.
 */
export function describeRegistry() {
  // `loadRegistry` is documented never to throw — a broken file yields an empty registry — so a
  // heartbeat is never lost to a malformed `printers.json`.
  return loadRegistry()
    .printers.slice(0, MAX_REPORTED_PRINTERS)
    .map((p) => ({
      id: p.id,
      name: p.name,
      transport: p.transport,
      type: p.type,
      enabled: p.enabled,
      // Present for network printers, and for the address-alias workaround this replaces.
      address: p.address ?? null,
      port: p.port ?? null,
    }));
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
    // Additive: a server that does not know this field strips it, so an older API keeps
    // working unchanged against a newer bridge.
    registry_printers: describeRegistry(),
  };
}

/**
 * Turn a failed enrolment response into the sentence the operator sees.
 *
 * This used to be `Enrollment failed: HTTP ${res.status}` with the body thrown away, and that
 * cost a day: a 500 caused by one recoverable, named condition — this computer already holds a
 * bridge row in the venue — was indistinguishable from the API being down, on both the CLI and
 * the pairing page, because neither ever read what the API said.
 *
 * The API hides its own message on 5xx, so the request id is the only thread back to the log
 * line that has the real cause. Print it whenever there is one.
 */
async function enrollFailure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    detail?: unknown;
    code?: unknown;
  } | null;
  const detail = typeof body?.detail === 'string' ? body.detail : '';
  const code = typeof body?.code === 'string' ? body.code : '';
  const requestId = res.headers.get('x-request-id');

  // The API answers every bad, spent or expired code identically so it cannot be used to probe
  // for live ones. Say the same thing in the three forms an operator can act on.
  const message =
    res.status === 404
      ? 'That enrollment code is not valid, has already been used, or has expired.'
      : detail ||
        (res.status >= 500
          ? `Enrollment failed: the server returned an error (HTTP ${res.status}).`
          : `Enrollment failed: HTTP ${res.status}`);

  const trailer = [
    code && code !== 'internal_error' ? code : '',
    requestId ? `ref ${requestId}` : '',
  ].filter(Boolean);

  return Object.assign(
    new Error(trailer.length ? `${message} (${trailer.join(', ')})` : message),
    { status: res.status, code },
  );
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
      registry_printers: self.registry_printers,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await enrollFailure(res);
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
  // `printer_id` wins over the address. It is how the server names a printer this machine owns
  // — including USB and serial ones, which have no IP at all and therefore cannot be addressed
  // any other way.
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
  //
  // Stop RESERVE_MS short of it, though. Retrying right up to the claim meant the bridge gave up
  // at the exact moment the server's sweeper did, so the sweeper always won and every job the
  // bridge could not print was recorded as UNKNOWN — "paper may already have come out". For the
  // commonest failure of all, a printer that is switched off, that is simply untrue: the bridge
  // knows within milliseconds that nothing printed, and UNKNOWN is precisely the state that
  // withholds the retry button. Giving up early leaves room for the truthful result to land
  // first, and costs one retry of a printer that was not answering anyway.
  const claimMs = job.claim_expires_at ? Date.parse(job.claim_expires_at) - Date.now() : Number.NaN;
  const ttl_s =
    Number.isFinite(claimMs) && claimMs > RESULT_RESERVE_MS
      ? Math.max(1, Math.floor((claimMs - RESULT_RESERVE_MS) / 1000))
      : undefined;

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
  if (code === 1008 || code === 4401) return 'revoked';
  /*
   * Only a DELIBERATE close counts as served.
   *
   * `closeCode` defaults to 1006, the code for an abnormal close — a TCP reset, a load balancer
   * dropping the connection, the server process dying. Every one of those used to return
   * 'served', which resets the failure count and reconnects with no delay: a balancer that
   * accepts the upgrade and immediately drops it produced an unbounded reconnect storm against
   * the API, with a registry read per turn. Anything unexpected is an error and goes through the
   * backoff and fallback the loop already has.
   */
  return code === 1000 || code === 1001 ? 'served' : 'error';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));



/**
 * The relay loop. Runs forever; never throws.
 *
 * One channel carries both jobs and commands, so this is a single loop rather than two — two
 * would double the connection count for no benefit and make ordering ambiguous.
 *
 * Callable a second time, which is how `POST /enroll` brings a freshly-paired bridge online
 * without a service restart. The guard below is what makes that safe: this function starts an
 * unbounded loop AND a heartbeat interval, so a second concurrent call would put two loops on
 * `/work` — both claiming jobs, in an order neither controls.
 *
 * Note the guard is only armed once the enrolment check has PASSED. A bridge that boots
 * unenrolled — every bridge, on its first run — must leave the flag clear, or the enrol route
 * could never start the loop it just made possible.
 */
let relayRunning = false;

/** Whether a relay loop is live in this process. Read by `POST /enroll` to decide on a restart. */
export function isRelayRunning(): boolean {
  return relayRunning;
}

export function startRelay(): void {
  if (relayRunning) {
    log.info('relay: already running, ignoring duplicate start', { event: 'relay.already_running' });
    return;
  }

  const state = loadState();
  if (!state.token || !state.bridge_id) {
    log.info(
      'print bridge is not enrolled — open http://localhost:9200 and paste a pairing code from Settings > Printing',
      { event: 'relay.not_enrolled' }
    );
    return;
  }

  relayRunning = true;

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
          // A clean session ended: reconnect rather than falling back, because the endpoint
          // demonstrably exists. Floored all the same — a category that reconnects without
          // delay is one server-side bug away from being a spin, which is how it got here.
          failures = 0;
          await sleep(RECONNECT_FLOOR_MS);
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
