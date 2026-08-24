import { loadState, saveState, type RelayState } from './identity.js';
import {
  containerSuspect,
  DEFAULT_PRINTER_PORT,
  localInterfaces,
  runScan,
  sendToPrinter,
} from './lan.js';
import { BRIDGE_VERSION } from './version.js';
import { arch, hostname, platform } from 'node:os';

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
const PRINT_TIMEOUT_MS = 5000;
/** Remembered results, so a redelivered job is answered rather than reprinted. */
const RECENT_JOBS_MAX = 200;
const MAX_BACKOFF_MS = 30_000;

interface JobResult {
  ok: boolean;
  reason?: string;
  printed_certainty?: 'none' | 'unknown';
  detail?: string;
  duration_ms?: number;
}

type Work =
  | {
      type: 'print';
      job: {
        job_id: string;
        client_job_id: string;
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
  last_ok_at: string | null;
  last_error: string | null;
}

const status: RelayStatus = {
  enrolled: false,
  bridge_id: null,
  connected: false,
  last_ok_at: null,
  last_error: null,
};

export function relayStatus(): RelayStatus {
  return { ...status };
}

/**
 * Results of jobs already handled, keyed by job id.
 *
 * The last line of defence against a duplicate print: if the server ever hands out the same
 * job twice — a bug, a replay, a partition — this refuses to print it a second time and simply
 * re-reports what happened the first time. Bounded, because a bridge runs for months.
 */
const recentJobs = new Map<string, JobResult>();

function remember(jobId: string, result: JobResult): void {
  recentJobs.set(jobId, result);
  if (recentJobs.size > RECENT_JOBS_MAX) {
    const oldest = recentJobs.keys().next().value;
    if (oldest !== undefined) recentJobs.delete(oldest);
  }
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

  const seen = recentJobs.get(job.job_id);
  if (seen) {
    console.warn(`job ${job.job_id} was delivered twice — re-reporting, NOT reprinting`);
    await postResult(base, token, job.job_id, seen);
    return;
  }

  const payload = Buffer.from(job.payload_base64, 'base64');
  const outcome = await sendToPrinter(job.target_ip, job.target_port, payload, PRINT_TIMEOUT_MS);
  const result: JobResult = outcome.ok
    ? { ok: true, duration_ms: outcome.duration_ms }
    : {
        ok: false,
        reason: outcome.reason,
        printed_certainty: outcome.printed_certainty,
        detail: outcome.detail,
        duration_ms: outcome.duration_ms,
      };

  // Remembered BEFORE the report is posted: if the POST fails and the job is redelivered, the
  // second delivery must find this entry and re-report rather than print again.
  remember(job.job_id, result);
  await postResult(base, token, job.job_id, result);
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Jittered backoff.
 *
 * The jitter is not cosmetic. Production rolls out with `maxUnavailable: 25%`, which kills
 * every in-flight 25-second long-poll at the same instant; without jitter every bridge in the
 * fleet would reconnect in lock-step and stampede the new pod, and an unjittered exponential
 * backoff would leave every venue dark for the same 30 seconds.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/**
 * The relay loop. Runs forever; never throws.
 *
 * One channel carries both jobs and commands, so this is a single loop rather than two — two
 * would double the connection count for no benefit and make ordering ambiguous.
 */
export function startRelay(): void {
  const state = loadState();
  if (!state.token || !state.bridge_id) {
    console.log(
      'print bridge is not enrolled — run `hankha-print-bridge --enroll <code>` with a code from Settings > Printing'
    );
    return;
  }

  const base = relayUrl(state);
  const token = state.token;
  status.enrolled = true;
  status.bridge_id = state.bridge_id;
  console.log(`relay: enrolled as bridge ${state.bridge_id}, polling ${base}`);

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

  void (async () => {
    let failures = 0;
    for (;;) {
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
          console.error('relay: token rejected. Re-enroll with `hankha-print-bridge --enroll <code>`');
          clearInterval(beat);
          return;
        }

        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);

        status.connected = true;
        status.last_ok_at = new Date().toISOString();
        status.last_error = null;
        failures = 0;

        if (res.status === 204) {
          // The normal, quiet path — not an error. Re-poll immediately with only enough
          // jitter to keep a fleet from synchronising.
          await sleep(Math.random() * 250);
          continue;
        }

        const work = (await res.json()) as Work;
        if (work.type === 'print') await handlePrint(base, token, work);
        else await handleScan(base, token, work);
      } catch (err) {
        status.connected = false;
        status.last_error = err instanceof Error ? err.message : String(err);
        const wait = backoffMs(Math.min(failures, 5));
        failures += 1;
        // Logged at most every few seconds by the backoff itself, so a venue that loses its
        // uplink overnight does not fill the log file.
        console.error(`relay: ${status.last_error} — retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  })();
}
