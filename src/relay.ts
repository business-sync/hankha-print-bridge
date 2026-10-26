import { loadState, saveState, type RelayState } from './identity.js';
import { containerSuspect, DEFAULT_PRINTER_PORT, localInterfaces, runScan } from './lan.js';
import { renderJobDocument, resolveRelayPrinter } from './jobs.js';
import { errorCode, log, LogGate, redactUrl } from './log.js';
import { queue, type JobResult } from './queue.js';
import { loadRegistry } from './registry.js';
import { relayFetch } from './relay-fetch.js';
import { connectWebSocket, WebSocketHandshakeError } from './relay-socket.js';
import { BRIDGE_VERSION, RUNTIME } from './version.js';
import { arch, hostname, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { backoffMs } from './backoff.js';
import { markTick } from './ticks.js';
import { classifyTlsTrust, peekPeerCertificate, type TlsTrustVerdict, tlsTrustCode } from './tls-trust.js';

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
const HEARTBEAT_INTERVAL_MS = envMs('PRINT_BRIDGE_HEARTBEAT_MS', 30_000);
/**
 * How long a websocket may go without an application-level `ack` from the server before it is
 * declared dead and replaced. Only enforced once this process has seen the server ack at least
 * once, so an older backend that never acks is not reconnected in a loop.
 *
 * Transport pongs are NOT evidence: any proxy or the `ws` library answers them while the
 * server-side subscription is gone, which is how a feed can die silently while `connected` stays
 * true and the HTTP heartbeat keeps the POS showing the bridge as online.
 */
const ACK_TIMEOUT_MS = envMs('PRINT_BRIDGE_ACK_TIMEOUT_MS', HEARTBEAT_INTERVAL_MS * 3 + 5_000);
/** A "served" session shorter than this is a flap, not a healthy session. */
const FLAP_SESSION_MS = 10_000;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/**
 * How long to leave WebSocket alone after a server says it does not speak it.
 *
 * A 404 is a fact about the deployment, not a transient fault: the endpoint either exists or it
 * does not. Retrying every 30 seconds against a backend that will never answer is pure noise in
 * both logs, so it is asked again only twice an hour — often enough to pick up a deploy, rare
 * enough to be invisible.
 *
 * The same window covers an upgrade that something in FRONT of the API refuses — a 401 on the
 * handshake that the API itself contradicts over plain HTTP (see `probeToken`). Overridable only
 * so the tests can run the window in seconds rather than minutes.
 */
const WS_UNSUPPORTED_RETRY_MS = envMs('PRINT_BRIDGE_WS_RETRY_MS', 30 * 60_000);

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
/** Silence on the websocket for this long means the link is dead, whatever the socket says. */
const WS_IDLE_TIMEOUT_MS = 45_000;
/** Longest wait between attempts once the server has rejected the token. */
const REJECTED_RETRY_MAX_MS = 300_000;
const TOKEN_REJECTED = 'token rejected — re-enrollment required';

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
        /** Pre-rendered bytes. Absent when `document` carries the slip instead. */
        payload_base64?: string;
        /**
         * A structured slip for THIS bridge to render, at the real paper width of the printer
         * that will print it.
         *
         * The reason it exists: a tablet is paired to a station it cannot see and has no idea
         * whether the roll is 58 mm or 80 mm, so rendering on the POS means guessing. The
         * server only ever sends this to a bridge whose reported version can handle it.
         */
        document?: unknown;
        payload_sha256: string;
        attempt: number;
        claim_expires_at: string;
      };
    }
  | { type: 'scan'; command_id: string; port: number };

export function relayUrl(state: RelayState): string {
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
      // What the server resolves a role-addressed job against. Null when nobody has tagged the
      // printer — the server has its own fallback for that and must be able to tell the two
      // apart, so this is reported explicitly rather than omitted.
      role: p.role ?? null,
      /*
       * The printable width, so a device that has never seen this printer can lay a slip out
       * for it — or be told not to try.
       *
       * A tablet paired to a station in another room had no way to learn whether the roll was
       * 58 mm or 80 mm, so it guessed from the venue's admin setting and the bridge rendered
       * whatever it was sent: an 80 mm slip on a 58 mm head, every row wrapped, no error
       * anywhere. Reporting it is what lets the server refuse that job before it is queued.
       *
       * Null on a label printer, which has no line width at all.
       */
      dots_per_line: p.dots_per_line ?? null,
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
  const res = await relayFetch(`${base}/api/v1/modules/print/bridge/enroll`, {
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

/**
 * The last TLS-trust verdict, for the status page's advice. Set once the certificate behind a
 * refused chain has been read back; cleared by the next relay request that verifies. It outlives
 * `last_error`: a websocket that connects clears that, and on the till that motivated this the
 * websocket DID connect while every `fetch` kept failing, so the verdict has to survive it.
 */
export interface TlsTrustStatus extends TlsTrustVerdict {
  runtime: string;
  /** Which relay call met the failure. */
  origin: 'websocket' | 'poll' | 'heartbeat' | 'result' | 'scan';
  at: string;
}

export interface RelayStatus {
  enrolled: boolean;
  bridge_id: string | null;
  connected: boolean;
  /** Which channel is carrying work right now. Null until the first successful exchange. */
  transport: 'websocket' | 'long-poll' | null;
  last_ok_at: string | null;
  last_error: string | null;
  tls_trust: TlsTrustStatus | null;
  /** Relay requests carry the bundled roots explicitly (see relay-fetch.ts) since this time. */
  explicit_roots_since: string | null;
}

const status: RelayStatus = {
  enrolled: false,
  bridge_id: null,
  connected: false,
  transport: null,
  last_ok_at: null,
  last_error: null,
  tls_trust: null,
  explicit_roots_since: null,
};

export function relayStatus(): RelayStatus {
  return { ...status, explicit_roots_since: relayFetch.state().latched_at };
}

/**
 * What the log needs to explain a disconnect, kept beside `status` rather than in it: none of
 * this belongs on the wire to the POS, but all of it belongs in a diagnostics snapshot.
 */
const diag = {
  connection_id: null as string | null,
  session_started_at: null as number | null,
  last_frame_at: null as number | null,
  frames_in: 0,
  last_poll_ok_at: null as number | null,
  last_heartbeat_ok_at: null as number | null,
  heartbeat_failures: 0,
  failures: 0,
  rejections: 0,
  /** When the current outage began; null while connected. */
  down_since: null as number | null,
  /** Websocket session starts in the last hour, for spotting a reconnect loop. */
  session_starts: [] as number[],
};

/** One gate for every repeating relay complaint, keyed per complaint. */
const gate = new LogGate(10 * 60_000);
/** Reconnects per hour above which the pattern itself is worth a warning. */
const RECONNECT_STORM_PER_HOUR = 20;

export interface RelayDiagnostics {
  connected: boolean;
  transport: RelayStatus['transport'];
  connection_id: string | null;
  session_ms: number | null;
  since_last_frame_ms: number | null;
  since_poll_ok_ms: number | null;
  since_heartbeat_ok_ms: number | null;
  heartbeat_failures: number;
  failures: number;
  rejections: number;
  down_ms: number | null;
  reconnects_last_hour: number;
}

export function relayDiagnostics(now = Date.now()): RelayDiagnostics {
  const ago = (at: number | null) => (at === null ? null : now - at);
  return {
    connected: status.connected,
    transport: status.transport,
    connection_id: diag.connection_id,
    session_ms: ago(diag.session_started_at),
    since_last_frame_ms: ago(diag.last_frame_at),
    since_poll_ok_ms: ago(diag.last_poll_ok_at),
    since_heartbeat_ok_ms: ago(diag.last_heartbeat_ok_at),
    heartbeat_failures: diag.heartbeat_failures,
    failures: diag.failures,
    rejections: diag.rejections,
    down_ms: ago(diag.down_since),
    reconnects_last_hour: diag.session_starts.filter((at) => now - at < 3_600_000).length,
  };
}

/** `fetch failed` says nothing; `fetch failed (ECONNRESET)` says what to check. */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

function seconds(ms: number): string {
  return ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/** `https://api.hankha.la` → `api.hankha.la`, for a log line that names who presented what. */
function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return redactUrl(base);
  }
}

/** The one line of advice per verdict. Mirrors the status page; nothing here widens trust. */
function tlsTrustAdvice(verdict: TlsTrustVerdict, host: string): string {
  switch (verdict.kind) {
    case 'intercepted':
      return (
        `a program on this computer (an antivirus or a proxy) is re-signing its HTTPS connections. Have whoever ` +
        `manages this computer stop that program inspecting the bridge's connection to ${host}, then restart the ` +
        'bridge; a new pairing code will not help'
      );
    case 'runtime':
      return (
        `the certificate is the real one and the fault is in this bridge build's runtime (${RUNTIME}), not in this ` +
        'computer or its network. Update the Print Bridge; do not change antivirus settings or add root ' +
        'certificates for this, and a new pairing code will not help'
      );
    default:
      return (
        'neither an interceptor nor a runtime fault can be named from here. Update the Print Bridge, and if the ' +
        'newest build still shows this send bridge.log to Hankha support; a new pairing code will not help'
      );
  }
}

/**
 * Say WHY the chain was refused, once per gate window, when a relay attempt failed because the
 * certificate it was shown is signed by a root this process did not accept.
 *
 * `relay.retry`, `relay.ws.handshake_failed` and `relay.heartbeat.failed` already say WHAT
 * failed (`fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)`). The cause is not in that code:
 * an antivirus re-signing HTTPS and a runtime that failed to apply its own root store throw the
 * same one, and 1.14.6 — which assumed the first — sent a till with the second looking for an
 * antivirus that was not there. This opens one more connection — see `peekPeerCertificate` — to
 * read who issued the certificate actually presented and whether `node:tls` here accepts it,
 * folds in what the explicit-roots retry found (relay-fetch.ts), and writes the verdict beside
 * the advice that fits it. The real request is never relaxed; a line in the log and a field in
 * the status are the only things that change.
 *
 * Gated on its own key rather than riding `relay.retry`'s: in `auto` mode a single outage
 * reaches this from the websocket, the poll and the heartbeat within the same second, and the
 * verdict is worth saying once, not three times.
 */
function noteTlsTrustFailure(err: unknown, base: string, origin: TlsTrustStatus['origin']): void {
  const code = tlsTrustCode(err);
  if (!code) return;
  const pass = gate.hit('relay.tls.untrusted');
  if (!pass) return;
  const host = hostOf(base);
  void peekPeerCertificate(base).then((cert) => {
    const retry = relayFetch.state();
    const verdict = classifyTlsTrust({
      code, cert, explicit_roots: retry.latched ? 'verified' : retry.failed_code ? 'failed' : null,
    });
    status.tls_trust = { ...verdict, runtime: RUNTIME, origin, at: new Date().toISOString() };
    const repeated = pass.repeated > 0 ? ` (repeated ${pass.repeated} times over ${seconds(pass.over_ms)})` : '';
    const what = cert
      ? `the certificate ${host} presented (issued by "${cert.issuer}") was refused by ${origin === 'websocket' ? 'the websocket' : 'fetch'} (${code})`
      : `${host} presented a certificate that was refused (${code}), and it could not be read back to name its issuer`;
    log.warn(`relay: ${what} — ${verdict.evidence}: ${tlsTrustAdvice(verdict, host)}${repeated}`, {
      event: 'relay.tls.untrusted', kind: verdict.kind, code, host, origin, runtime: RUNTIME,
      explicit_roots: retry.latched ? 'verified' : retry.failed_code ? `failed (${retry.failed_code})` : undefined,
      ...(cert ?? {}), repeated: pass.repeated || undefined,
    });
  });
}

/**
 * A relay request over HTTP verified and was answered: whatever a trust verdict said is over.
 * Not folded into `markUp`, because a websocket connecting says nothing about `fetch` — the
 * till that motivated this had the socket up and every `fetch` refused for two days.
 */
function noteRelayHttpOk(): void {
  if (status.tls_trust === null) return;
  status.tls_trust = null;
  gate.clear('relay.tls.untrusted');
}

/** The link stopped carrying work. Idempotent: an outage starts once. */
function markDown(): void {
  status.connected = false;
  if (diag.down_since === null) diag.down_since = Date.now();
}

/** The link is carrying work again — log the recovery if there was an outage to recover from. */
function markUp(transport: 'websocket' | 'long-poll'): void {
  if (status.transport !== null && status.transport !== transport) {
    log.info(`relay: now using ${transport}`, { event: 'relay.transport', from: status.transport, to: transport });
  }
  status.connected = true;
  status.transport = transport;
  status.last_ok_at = new Date().toISOString();
  status.last_error = null;
  if (transport === 'long-poll') noteRelayHttpOk();
  if (diag.down_since !== null) {
    const down = Date.now() - diag.down_since;
    const retries = gate.clear('relay.retry');
    gate.clear('relay.ws.handshake_failed');
    log.info(`relay: connection restored over ${transport} after ${seconds(down)}`, {
      event: 'relay.recovered', transport, down_ms: down, failures: diag.failures,
      suppressed_retries: retries?.repeated || undefined,
    });
    diag.down_since = null;
  }
  diag.failures = 0;
}

/** One POST of a result. Resolves with the status; throws only when no answer came back at all. */
async function postResult(base: string, token: string, jobId: string, result: JobResult): Promise<number> {
  const res = await relayFetch(`${base}/api/v1/modules/print/bridge/jobs/${jobId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(15_000),
  });
  // Release the pooled connection.
  await res.body?.cancel().catch(() => undefined);
  return res.status;
}

/** Retries of a result report after the first attempt, each preceded by `resultRetryDelayMs`. */
const RESULT_RETRIES = 3;
/** About 1 s, 2 s and 4 s before the three retries — `backoffMs` with its usual 50–100 % jitter. */
function resultRetryDelayMs(retry: number): number {
  return backoffMs(retry);
}

/** Set once the process is stopping: a report in a retry pause gives up instead of sleeping on. */
let shuttingDown = false;
const retryWakers = new Set<() => void>();

/** A sleep that `markRelayShutdown` cuts short. */
function retrySleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      retryWakers.delete(done);
      resolve();
    }
    retryWakers.add(done);
  });
}

/**
 * The process is stopping. Called from the graceful stop in index.ts so a result report that is
 * waiting to retry gives up now, with a line saying so, rather than holding a timer that the
 * exit then kills silently.
 */
export function markRelayShutdown(): void {
  shuttingDown = true;
  for (const wake of [...retryWakers]) wake();
}

/**
 * Report a job's outcome, riding out the faults one POST cannot.
 *
 * This used to be a single attempt, and a failed one was the end of it: the server's sweeper
 * then wrote UNKNOWN over a job this bridge knew the truth about, the POS showed the ticket as
 * unconfirmed, and an operator pressing reprint on a receipt that had in fact come out is exactly
 * the duplicate this module exists to prevent. A result report is worth a few seconds of retries.
 *
 * 2xx and 409 are final successes — 409 means the server already settled this job, usually our
 * own earlier report arriving twice, and the outcome is recorded either way. A network error, a
 * 5xx, a 408 or a 429 is retried up to RESULT_RETRIES more times. Any other 4xx is final: the
 * server has decided, and sending the same body again cannot change its mind.
 *
 * Never rejects: the print has already happened or already failed, so there is nobody left to
 * throw to. The server's sweeper moves an unreported job to UNKNOWN and never re-queues one, so
 * nothing prints twice because of a lost report. Exported for the tests; `handlePrint` is the
 * real caller.
 */
export async function reportResult(
  base: string,
  token: string,
  jobId: string,
  result: JobResult,
  delayMs: (retry: number) => number = resultRetryDelayMs,
): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    let status: number | undefined;
    let err: unknown;
    try {
      status = await postResult(base, token, jobId, result);
    } catch (e) {
      err = e;
    }
    if (status !== undefined && ((status >= 200 && status < 300) || status === 409)) {
      noteRelayHttpOk();
      if (attempt > 1) {
        gate.clear('relay.result.retry');
        log.info(`relay: job ${jobId} reported on attempt ${attempt}`, {
          event: 'relay.result.reported', job_id: jobId, attempts: attempt, status,
        });
      }
      return true;
    }
    const detail = status === undefined ? describeError(err) : `HTTP ${status}`;
    if (status === undefined) noteTlsTrustFailure(err, base, 'result');
    const transient = status === undefined || status >= 500 || status === 408 || status === 429;
    if (transient && attempt <= RESULT_RETRIES && !shuttingDown) {
      const wait = delayMs(attempt - 1);
      // Gated: a server having a bad minute is one condition, however many jobs it catches.
      const pass = gate.hit('relay.result.retry');
      if (pass) {
        const repeated = pass.repeated > 0 ? ` (repeated ${pass.repeated} times over ${seconds(pass.over_ms)})` : '';
        log.warn(`relay: could not report job ${jobId} (${detail}) — retrying in ${seconds(wait)} (attempt ${attempt} of ${RESULT_RETRIES + 1})${repeated}`, {
          event: 'relay.result.retry', job_id: jobId, attempt, status, err, wait_ms: wait,
          repeated: pass.repeated || undefined,
        });
      }
      await retrySleep(wait);
      if (!shuttingDown) continue;
    }
    log.warn(`relay: could not report job ${jobId} (${detail}${shuttingDown ? '; shutting down' : ''}) after ${attempt} attempt${attempt === 1 ? '' : 's'}`, {
      event: 'relay.result.failed', job_id: jobId, attempts: attempt, status, err,
      shutting_down: shuttingDown || undefined,
    });
    return false;
  }
}

// Exported for tests only; `dispatch` is the real caller.
export async function handlePrint(base: string, token: string, work: Extract<Work, { type: 'print' }>) {
  const { job } = work;

  // `printer_id` wins over the address. It is how the server names a printer this machine owns
  // — including USB and serial ones, which have no IP at all and therefore cannot be addressed
  // any other way. A printer the operator turned off is refused however the job reaches it.
  const printer = resolveRelayPrinter(loadRegistry(), job);

  if ('error' in printer) {
    // `device-missing` covers "unknown" and "turned off" alike, and the detail says which. It is
    // the nearest reason the server's `JOB_FAILURE_REASONS` accepts: an unfamiliar one is 422'd,
    // the result is lost, and the sweeper later writes UNKNOWN over a job that provably never
    // printed. `none` is exact — nothing was sent to any printer — so the POS may offer a retry.
    //
    // Not awaited, here or below: a report that has to retry must not hold up the next poll.
    // `reportResult` never rejects and logs a report it had to give up on.
    void reportResult(base, token, job.job_id, {
      ok: false,
      reason: 'device-missing',
      printed_certainty: 'none',
      detail: printer.error,
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

  // Bytes or a document — one of the two, resolved against the printer we just picked so a
  // document is rendered for the head that will actually print it.
  let payload: Buffer;
  if (job.document !== undefined && job.document !== null) {
    const rendered = renderJobDocument(job.document, printer);
    if (!rendered.ok) {
      // `printed_certainty: 'none'` is the whole point of reporting this properly: nothing was
      // ever sent to the printer, so the POS may safely offer to print again once the document
      // is fixed. Reporting it as a device fault would send someone to check a cable.
      void reportResult(base, token, job.job_id, {
        ok: false,
        reason: 'payload-rejected',
        printed_certainty: 'none',
        detail: rendered.errors.slice(0, 3).join('; '),
      });
      return;
    }
    payload = rendered.payload;
  } else if (typeof job.payload_base64 === 'string') {
    payload = Buffer.from(job.payload_base64, 'base64');
  } else {
    void reportResult(base, token, job.job_id, {
      ok: false,
      reason: 'payload-rejected',
      printed_certainty: 'none',
      detail: 'the job carried neither payload_base64 nor document',
    });
    return;
  }

  const submission = queue().submit({
    job_id: job.job_id,
    source: 'relay',
    printer,
    payload,
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
  //
  // `reportResult` retries what can be retried and never rejects; a report lost for good is
  // logged there. The server's own sweeper moves an unreported job to UNKNOWN, and it never
  // re-queues one, so nothing prints twice as a result of a lost report.
  void submission.settled.then((settled) =>
    reportResult(base, token, job.job_id, settled.result ?? { ok: false, reason: 'unknown', printed_certainty: 'unknown' })
  );
}

async function handleScan(base: string, token: string, work: Extract<Work, { type: 'scan' }>) {
  // Shares `runScan`'s in-flight map with the LAN /scan route, so a cloud-requested scan and a
  // button press on the same port join one sweep instead of doubling the SYN traffic.
  const scan = await runScan(work.port || DEFAULT_PRINTER_PORT);
  const res = await relayFetch(`${base}/api/v1/modules/print/bridge/scan-result`, {
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
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) {
    log.warn(`relay: scan result was refused (HTTP ${res.status})`, {
      event: 'relay.scan.result_failed', command_id: work.command_id, status: res.status,
    });
  }
}

/** One HTTP heartbeat. Resolves with the status; throws only when no answer came back at all. */
async function heartbeat(base: string, token: string): Promise<number> {
  const res = await relayFetch(`${base}/api/v1/modules/print/bridge/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(describeSelf()),
    signal: AbortSignal.timeout(15_000),
  });
  // Release the pooled connection.
  await res.body?.cancel().catch(() => undefined);
  return res.status;
}

/**
 * Say when heartbeats start failing, once per window while they keep failing, and when they
 * recover.
 *
 * A heartbeat that fails silently leaves the POS showing this bridge offline with nothing in the
 * log — that was true of network errors here until now, which were swallowed outright. A
 * rejected one used to be logged on EVERY beat instead, and a venue with a revoked token sent in
 * a file of hundreds of identical lines.
 */
function noteHeartbeat(outcome: { status?: number; err?: unknown; duration_ms: number }, base: string): void {
  const ok = outcome.status !== undefined && outcome.status >= 200 && outcome.status < 300;
  log.debug(`relay: heartbeat ${outcome.status ?? describeError(outcome.err)} in ${outcome.duration_ms}ms`, {
    event: 'relay.heartbeat', status: outcome.status, duration_ms: outcome.duration_ms,
  });
  if (ok) {
    if (diag.heartbeat_failures > 0) {
      const run = gate.clear('relay.heartbeat');
      log.info(`relay: heartbeat accepted again after ${diag.heartbeat_failures} failure(s)`, {
        event: 'relay.heartbeat.recovered', failures: diag.heartbeat_failures, outage_ms: run?.over_ms,
      });
    }
    diag.heartbeat_failures = 0;
    diag.last_heartbeat_ok_at = Date.now();
    noteRelayHttpOk();
    return;
  }
  diag.heartbeat_failures += 1;
  // A heartbeat refused on trust grounds is not a blip, and `markUp('websocket')` has cleared
  // `last_error` by now: the socket can be up while every fetch is refused. Keep the code where
  // the status page reads it, and get the verdict.
  if (outcome.status === undefined && tlsTrustCode(outcome.err)) {
    status.last_error = describeError(outcome.err);
    noteTlsTrustFailure(outcome.err, base, 'heartbeat');
  }
  const pass = gate.hit('relay.heartbeat');
  if (!pass) return;
  const repeated = pass.repeated > 0 ? ` (repeated ${pass.repeated} times over ${seconds(pass.over_ms)})` : '';
  if (outcome.status !== undefined) {
    log.warn(`relay: heartbeat rejected (HTTP ${outcome.status})${repeated}`, {
      event: 'relay.heartbeat.rejected', status: outcome.status, failures: diag.heartbeat_failures,
      repeated: pass.repeated || undefined,
    });
  } else {
    log.warn(`relay: heartbeat failed (${describeError(outcome.err)})${repeated}`, {
      event: 'relay.heartbeat.failed', err: outcome.err, failures: diag.heartbeat_failures,
      repeated: pass.repeated || undefined,
    });
  }
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

/** Whether the server has ever acked a heartbeat to this process (feature-detected, never assumed). */
let serverAcks = false;
/** Duration of the last websocket session, read by the loop to tell a flap from a clean session. */
let lastSessionMs = Number.POSITIVE_INFINITY;

/**
 * `refused`: the handshake was answered 401 but the API accepts the token over plain HTTP, so it
 * was something in front of the API that refused the upgrade. Handled like `unsupported` — the
 * long-poll carries the work and the socket is tried again after the window — but logged for
 * what it is, because the fix is on a network, not in a deploy.
 */
type SessionOutcome = 'served' | 'unsupported' | 'refused' | 'revoked' | 'error';
/** The heartbeat status behind the last `refused` outcome, for the line the loop writes about it. */
let lastRefusalProbe: number | null = null;

/**
 * Ask the API itself whether this token is still good, over plain HTTP.
 *
 * A 401 on the websocket handshake used to mean "revoked" on its own, and that was wrong in the
 * one way that matters: an edge, a proxy or a WAF that refuses upgrades but passes ordinary
 * requests answers the handshake 401 too, and the loop then sat out the rejection backoff with
 * the long-poll — which was working the whole time — never tried. A venue stopped printing over
 * a proxy setting. So the handshake's 401 is believed only when the API says the same thing to a
 * heartbeat: the cheapest authenticated call there is, behind the same guard as every bridge
 * route, with no side effect beyond `last_seen_at`. (`/work?wait=0` would do as well, but a 200
 * from it is a claimed job that would then have to be handled.)
 *
 * Resolves with the heartbeat's status, or null when no answer came back at all.
 */
async function probeToken(base: string, token: string): Promise<number | null> {
  const startedAt = Date.now();
  try {
    const code = await heartbeat(base, token);
    log.debug(`relay: websocket handshake answered 401 — the API answers a heartbeat with ${code}`, {
      event: 'relay.ws.auth_probe', status: code, duration_ms: Date.now() - startedAt,
    });
    return code;
  } catch (err) {
    log.debug(`relay: websocket handshake answered 401 — the heartbeat that would confirm it failed (${describeError(err)})`, {
      event: 'relay.ws.auth_probe', err, duration_ms: Date.now() - startedAt,
    });
    return null;
  }
}

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
  // Reset so a session that never opens cannot leave the previous one's duration to be read as a flap.
  lastSessionMs = Number.POSITIVE_INFINITY;
  let client: Awaited<ReturnType<typeof connectWebSocket>>;
  let lastAckAt = Date.now();
  // Ties a session's open, its frames and its close together in the log.
  const connectionId = randomBytes(4).toString('hex');
  const dialledAt = Date.now();
  let framesIn = 0;
  let lastFrameAt: number | null = null;
  log.debug(`relay: opening websocket ${connectionId}`, {
    event: 'relay.ws.connecting', connection_id: connectionId, url: redactUrl(socketUrl(base)),
  });
  try {
    client = await connectWebSocket({
      url: socketUrl(base),
      headers: { Authorization: `Bearer ${token}` },
      idleTimeoutMs: WS_IDLE_TIMEOUT_MS,
      onMessage: (text) => {
        framesIn += 1;
        lastFrameAt = Date.now();
        diag.frames_in = framesIn;
        diag.last_frame_at = lastFrameAt;
        let work: Work;
        try {
          work = JSON.parse(text) as Work;
        } catch (err) {
          const pass = gate.hit('relay.ws.bad_frame');
          if (pass) {
            log.warn('relay: ignored a websocket frame that is not JSON', {
              event: 'relay.ws.bad_frame', connection_id: connectionId, bytes: text.length, err,
              repeated: pass.repeated || undefined,
            });
          }
          return;
        }
        if ((work as { type?: string }).type === 'ack') {
          serverAcks = true;
          lastAckAt = Date.now();
          status.last_ok_at = new Date().toISOString();
          return;
        }
        // Unknown types are ignored rather than treated as errors, so the server can add a frame
        // kind without every deployed bridge dropping its connection over it.
        if (work.type !== 'print' && work.type !== 'scan') {
          log.debug(`relay: ignored a websocket frame of type ${String((work as { type?: unknown }).type)}`, {
            event: 'relay.ws.unknown_frame', connection_id: connectionId,
          });
          return;
        }
        void dispatch(base, token, work).catch((err: unknown) => {
          log.error(`relay: failed to handle ${work.type} (${describeError(err)})`, {
            event: 'relay.dispatch.failed', kind: work.type, connection_id: connectionId, err,
          });
          noteTlsTrustFailure(err, base, 'scan');
        });
      },
    });
  } catch (err) {
    if (err instanceof WebSocketHandshakeError) {
      // Only 401 is the API saying "this token is not valid" — and even that is checked, because
      // an edge that refuses upgrades answers 401 too (see `probeToken`). A 403 comes from
      // something in front of the API (proxy, WAF, captive portal) and says nothing about the
      // credential.
      if (err.status === 401) {
        const probe = await probeToken(base, token);
        if (probe === 401) return 'revoked';
        // A 5xx (or 408/429) heartbeat says nothing about the edge: the API itself is having a bad
        // minute. Treat it like any transient fault below — one long-poll, then the socket again —
        // rather than blocking the socket for the whole window.
        if (probe !== null && (probe >= 500 || probe === 408 || probe === 429)) return 'error';
        if (probe !== null) {
          lastRefusalProbe = probe;
          return 'refused';
        }
        // No answer at all from the probe: a network fault, retried like one below.
      }
      // Any ordinary HTTP answer that is not an auth failure means this path does not speak
      // WebSocket. A 5xx is the exception: that is a server having a bad minute, not a missing
      // route, and it should be retried like any other transient fault.
      // Only "no such route / cannot upgrade here" justifies a 30-minute lockout. 400/403/408/429
      // are a proxy, a WAF or a rate limiter having a bad moment: back off and try again.
      if (err.status === 404 || err.status === 405 || err.status === 426) return 'unsupported';
    }
    status.last_error = describeError(err);
    noteTlsTrustFailure(err, base, 'websocket');
    // Used to set `last_error` and nothing else: a bridge whose socket could never connect left no
    // line saying so, or why.
    const pass = gate.hit('relay.ws.handshake_failed');
    if (pass) {
      log.warn(`relay: websocket could not connect (${status.last_error})`, {
        event: 'relay.ws.handshake_failed', connection_id: connectionId,
        status: err instanceof WebSocketHandshakeError ? err.status ?? undefined : undefined,
        duration_ms: Date.now() - dialledAt, err, repeated: pass.repeated || undefined,
      });
    }
    return 'error';
  }

  markUp('websocket');
  const sessionStart = Date.now();
  diag.connection_id = connectionId;
  diag.session_started_at = sessionStart;
  diag.frames_in = 0;
  diag.last_frame_at = null;
  diag.session_starts = [...diag.session_starts.filter((at) => sessionStart - at < 3_600_000), sessionStart];
  log.info('relay: connected over websocket', {
    event: 'relay.ws.open', connection_id: connectionId, handshake_ms: sessionStart - dialledAt,
  });
  if (diag.session_starts.length > RECONNECT_STORM_PER_HOUR) {
    const pass = gate.hit('relay.reconnect_storm');
    if (pass) {
      log.warn(`relay: ${diag.session_starts.length} websocket connections in the last hour — the link keeps dropping`, {
        event: 'relay.reconnect_storm', reconnects_last_hour: diag.session_starts.length,
        repeated: pass.repeated || undefined,
      });
    }
  }

  client.send(JSON.stringify({ type: 'hello', ...describeSelf() }));
  const beat = setInterval(() => client.send(JSON.stringify({ type: 'heartbeat', ...describeSelf() })), HEARTBEAT_INTERVAL_MS);
  beat.unref();
  // Application-level liveness: see ACK_TIMEOUT_MS. Checked on the heartbeat cadence.
  let ackTimedOut = false;
  const ackWatch = setInterval(() => {
    if (ackTimedOut || !serverAcks || Date.now() - lastAckAt <= ACK_TIMEOUT_MS) return;
    ackTimedOut = true;
    log.warn(`relay: no ack from server for ${Math.round((Date.now() - lastAckAt) / 1000)}s — reconnecting`, {
      event: 'relay.ws.ack_timeout', since_ack_ms: Date.now() - lastAckAt,
    });
    client.close(4000, 'no ack');
  }, Math.max(250, Math.min(HEARTBEAT_INTERVAL_MS, ACK_TIMEOUT_MS / 3)));
  ackWatch.unref();

  const { code, reason, closed_by, error_code } = await client.closed;
  clearInterval(beat);
  clearInterval(ackWatch);
  lastSessionMs = Date.now() - sessionStart;
  const clean = code === 1000 || code === 1001;
  if (clean) status.connected = false;
  else markDown();
  status.last_error = code === 1000 ? null : `websocket closed (${code}${reason ? `: ${reason}` : ''})`;
  diag.connection_id = null;
  diag.session_started_at = null;
  const closeLine = `relay: websocket closed (${code}${reason ? `: ${reason}` : ''}) by ${closed_by} after ${seconds(lastSessionMs)}`;
  (clean ? log.info : log.warn)(closeLine, {
    event: 'relay.ws.close', connection_id: connectionId, code, reason, closed_by, error_code,
    session_ms: lastSessionMs, frames_in: framesIn,
    last_frame_ago_ms: lastFrameAt === null ? undefined : Date.now() - lastFrameAt,
    since_ack_ms: serverAcks ? Date.now() - lastAckAt : undefined,
  });
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

/** A sleep that `wakeRelay` can cut short — used only while waiting out a rejected token. */
let wakeWait: (() => void) | null = null;
function interruptibleSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wakeWait = null;
      resolve();
    }
    wakeWait = done;
  });
}

/** Retry now rather than at the end of the backoff. `POST /enroll` calls it after saving a new token. */
export function wakeRelay(): void {
  wakeWait?.();
}

/** The loop is alive but the server has said the token is not valid, so it is waiting to be re-paired. */
export function isRelayRejected(): boolean {
  return relayRunning && !status.connected && status.last_error === TOKEN_REJECTED;
}



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
 * could never start the loop it just made possible. It is released again in the loop's
 * `finally`, so a bridge whose token was rejected can be re-paired in place: the flag describes
 * a LIVE loop, and a loop that has returned is not one.
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
    // Describes the CURRENT flow, not the one that was replaced. This line used to send an
    // operator to type a code they had to fetch from a tablet; the code now appears on this
    // machine's own screen and the tablet scans it.
    log.info(
      'print bridge is not paired yet — open http://localhost:9200 on this computer and scan the code with your Hankha tablet',
      { event: 'relay.not_enrolled' }
    );
    return;
  }

  relayRunning = true;

  let base = relayUrl(state);
  let token = state.token;
  status.enrolled = true;
  status.bridge_id = state.bridge_id;
  log.info(`relay: enrolled as bridge ${state.bridge_id}, connecting to ${redactUrl(base)}`, {
    event: 'relay.start', bridge_id: state.bridge_id, relay_url: base, transport_mode: relayMode(),
    heartbeat_ms: HEARTBEAT_INTERVAL_MS, ack_timeout_ms: ACK_TIMEOUT_MS,
  });

  const beatOnce = async () => {
    markTick('relay.heartbeat', HEARTBEAT_INTERVAL_MS);
    checkStale();
    const startedAt = Date.now();
    try {
      const code = await heartbeat(base, token);
      noteHeartbeat({ status: code, duration_ms: Date.now() - startedAt }, base);
    } catch (err) {
      noteHeartbeat({ err, duration_ms: Date.now() - startedAt }, base);
    }
  };

  /*
   * `connected` that has stopped meaning anything. The watchdog only acts on `connected ===
   * false`, so a websocket the server stopped acking, or a long-poll stuck inside a dispatch,
   * would hold the bridge "online" and unwatched. This does not act on it — it says so, so a
   * venue's log can show whether that is what happened.
   */
  const checkStale = () => {
    if (!status.connected) return;
    const now = Date.now();
    const last =
      status.transport === 'long-poll'
        ? diag.last_poll_ok_at
        : serverAcks
          ? Math.max(diag.last_frame_at ?? 0, diag.session_started_at ?? 0)
          : null;
    if (last === null || now - last <= HEARTBEAT_INTERVAL_MS * 3) {
      gate.clear('relay.stale');
      return;
    }
    const pass = gate.hit('relay.stale');
    if (pass) {
      log.warn(`relay: marked connected, but nothing has come over ${status.transport} for ${seconds(now - last)}`, {
        event: 'relay.stale', transport: status.transport, silent_ms: now - last,
        connection_id: diag.connection_id ?? undefined, repeated: pass.repeated || undefined,
      });
    }
  };

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
  let wsRefusedLogged = false;

  let rejections = 0;
  /*
   * The server said the token is not valid. This used to END the loop, which meant a single
   * 401 — from a proxy, from replica lag right after enrolment, from anything — disconnected the
   * bridge until someone re-paired it by hand. The bridge now only stops being connected when
   * the user removes it: it keeps asking, slowly, and re-reads its credential each time so a new
   * code entered on the local page takes effect without a restart. A token that really was
   * revoked just keeps getting 401, which costs one cheap request every few minutes.
   */
  const adoptSavedCredential = (): boolean => {
    const fresh = loadState();
    if (!fresh.token || !fresh.bridge_id) return false;
    const changed = fresh.token !== token;
    token = fresh.token;
    base = relayUrl(fresh);
    status.bridge_id = fresh.bridge_id;
    return changed;
  };

  const waitOutRejection = async () => {
    markDown();
    /*
     * Re-pairing (Replace) is what revokes the old row, and the new token is saved before the
     * server cuts the live session — so by the time this loop hears the 401, the answer is
     * usually already on disk. `wakeRelay` cannot help there: it only wakes a loop that is
     * already waiting. Without this check a freshly paired bridge sat out a 30–60 s backoff
     * with the dead token, its heartbeat rejected and the POS showing it offline.
     */
    if (adoptSavedCredential()) {
      rejections = 0;
      diag.rejections = 0;
      log.info(`relay: switched to the new pairing (bridge ${status.bridge_id})`, {
        event: 'relay.token_switched', bridge_id: status.bridge_id,
      });
      return;
    }
    status.last_error = TOKEN_REJECTED;
    const wait = backoffMs(6 + Math.min(rejections, 3), REJECTED_RETRY_MAX_MS);
    rejections += 1;
    diag.rejections = rejections;
    log.error(
      `relay: token rejected — retrying in ${Math.round(wait / 1000)}s. If it stays rejected, open http://localhost:9200 on this computer and press Get a new code`,
      { event: 'relay.token_rejected', wait_ms: wait, rejections, bridge_id: status.bridge_id }
    );
    await interruptibleSleep(wait);
    adoptSavedCredential();
  };

  void (async () => {
    let failures = 0;
    try {
      for (;;) {
        if (Date.now() >= wsBlockedUntil) {
          let outcome: SessionOutcome;
          try {
            outcome = await runSocketSession(base, token);
          } catch (err) {
            // Never let a throw end the loop: the only way out of it is the process stopping.
            markDown();
            status.last_error = describeError(err);
            log.error(`relay: websocket session failed unexpectedly (${status.last_error})`, {
              event: 'relay.ws.session_error', err, expected: false,
            });
            outcome = 'error';
          }
          if (outcome === 'revoked') {
            await waitOutRejection();
            continue;
          }
          if (outcome === 'served') {
            // A clean session ended: reconnect rather than falling back, because the endpoint
            // demonstrably exists. Floored all the same — a category that reconnects without
            // delay is one server-side bug away from being a spin, which is how it got here.
            rejections = 0;
            diag.rejections = 0;
            if (lastSessionMs < FLAP_SESSION_MS) {
              // Accepted then closed within seconds, repeatedly: two processes sharing a token, or
              // a proxy cycling the upstream. Back off instead of reconnecting at the floor.
              const wait = Math.max(RECONNECT_FLOOR_MS, backoffMs(Math.min(failures, 5)));
              failures += 1;
              diag.failures = failures;
              log.warn(`relay: websocket flapping — reconnecting in ${Math.round(wait / 1000)}s`, {
                event: 'relay.ws.flap', session_ms: lastSessionMs, wait_ms: wait,
              });
              await sleep(wait);
            } else {
              failures = 0;
              await sleep(RECONNECT_FLOOR_MS);
            }
            continue;
          }
          if (outcome === 'unsupported' || outcome === 'refused') {
            wsBlockedUntil = Date.now() + WS_UNSUPPORTED_RETRY_MS;
            log.debug(`relay: websocket not available — long-polling, asking again in ${seconds(WS_UNSUPPORTED_RETRY_MS)}`, {
              event: 'relay.ws.blocked', because: outcome, retry_in_ms: WS_UNSUPPORTED_RETRY_MS,
            });
            if (outcome === 'unsupported' && !wsUnsupportedLogged) {
              wsUnsupportedLogged = true;
              log.info('relay: this server does not offer a websocket endpoint — using long-polling', {
                event: 'relay.ws.unsupported',
              });
            }
            if (outcome === 'refused' && !wsRefusedLogged) {
              // Once, not per window: the cause is a network setting, and it is the same one every
              // half hour. The debug line above says each time it is still there.
              wsRefusedLogged = true;
              log.warn(
                `relay: the websocket upgrade was refused with 401, but the API accepts this token over plain HTTP (heartbeat ${lastRefusalProbe}) — something between this bridge and the API is blocking websockets. Long-polling instead; trying the websocket again in ${seconds(WS_UNSUPPORTED_RETRY_MS)}`,
                { event: 'relay.ws.refused', probe_status: lastRefusalProbe, retry_in_ms: WS_UNSUPPORTED_RETRY_MS },
              );
            }
          }
          if (mode === 'ws') {
            // Explicitly pinned to websocket: never silently start polling instead.
            const wait = backoffMs(Math.min(failures, 5));
            failures += 1;
            diag.failures = failures;
            markDown();
            log.debug(`relay: websocket retry in ${Math.round(wait / 1000)}s`, {
              event: 'relay.ws.retry', wait_ms: wait, failures,
            });
            await sleep(wait);
            continue;
          }
        }

        try {
          const pollStartedAt = Date.now();
          const res = await relayFetch(
            `${base}/api/v1/modules/print/bridge/work?wait=${POLL_WAIT_S}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              // Comfortably longer than the server's wait, so a healthy long-poll is never cut
              // short by the client and mistaken for a network fault.
              signal: AbortSignal.timeout((POLL_WAIT_S + 15) * 1000),
            }
          );

          log.debug(`relay: poll answered ${res.status} in ${Date.now() - pollStartedAt}ms`, {
            event: 'relay.poll', status: res.status, duration_ms: Date.now() - pollStartedAt,
          });

          if (res.status === 401) {
            await waitOutRejection();
            continue;
          }

          if (!res.ok && res.status !== 204) {
            await res.body?.cancel().catch(() => undefined);
            throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
          }

          diag.last_poll_ok_at = Date.now();
          markUp('long-poll');
          failures = 0;
          rejections = 0;
          diag.rejections = 0;

          if (res.status === 204) {
            // The normal, quiet path — not an error. Re-poll immediately with only enough
            // jitter to keep a fleet from synchronising.
            await sleep(Math.random() * 250);
            continue;
          }

          await dispatch(base, token, (await res.json()) as Work);
        } catch (err) {
          markDown();
          status.last_error = describeError(err);
          noteTlsTrustFailure(err, base, 'poll');
          const wait = backoffMs(Math.min(failures, 5));
          failures += 1;
          diag.failures = failures;
          // The first failure of an outage is always logged, then once per window with a count,
          // so a venue that loses its uplink overnight does not fill the log file. The recovery
          // line closes the run. Warn, not error: this is the bridge riding out a fault.
          const pass = gate.hit('relay.retry');
          if (pass) {
            const repeated = pass.repeated > 0 ? ` (repeated ${pass.repeated} times over ${seconds(pass.over_ms)})` : '';
            log.warn(`relay: ${status.last_error} — retrying in ${Math.round(wait / 1000)}s${repeated}`, {
              event: 'relay.retry', detail: status.last_error, wait_ms: wait, failures, err,
              status: (err as { status?: number }).status, repeated: pass.repeated || undefined,
            });
          }
          await sleep(wait);
        }
      }
    } catch (err) {
      // Unreachable by design — every path inside the loop catches. If it ever happens, the
      // bridge has stopped talking to the cloud for good, and this line is the only evidence.
      log.error('relay: the relay loop failed and stopped', { event: 'relay.loop.failed', err, expected: false });
    } finally {
      // Every way out of the loop lands here: a rejected token, a revoked bridge, or an
      // unexpected throw from `runSocketSession`, which is awaited outside the inner try/catch.
      //
      // Releasing the guard is the whole point. It used to be set once at start and never
      // cleared, so a bridge whose token had been rejected reported `isRelayRunning() === true`
      // forever. `POST /enroll` then took its "a loop is already live" branch, saved the new
      // credential, answered `restart_required` and reconnected nothing — so re-pairing a
      // rejected bridge was impossible without restarting the service, which is exactly the
      // state an operator cannot diagnose from the POS.
      clearInterval(beat);
      relayRunning = false;
      markDown();
      log.error('relay: the relay loop has exited — the bridge is offline until it is restarted', {
        event: 'relay.loop.exited',
      });
    }
  })();
}
