import { backoffMs } from './backoff.js';
import { loadState } from './identity.js';
import { log } from './log.js';
import { enroll, isRelayRunning, relayUrl, startRelay } from './relay.js';
import { BRIDGE_VERSION } from './version.js';
import { arch, hostname, platform } from 'node:os';

/**
 * The reversed pairing direction, from this machine's side.
 *
 * The original flow had an operator read a code off a tablet and retype it here. This one runs
 * the other way: the computer announces itself to the API, is handed a code, shows that code on
 * its own screen, and waits for a logged-in tablet to claim it. Nobody types an address and
 * nobody carries a code across the room.
 *
 * ⚠ The tablet never talks to this process. It scans a code off the screen and calls the CLOUD;
 * this loop learns about the claim by polling the cloud too. That is deliberate and load-bearing
 * — a browser on `https://pos.hankha.la` can never reach `http://localhost:9200` (mixed content
 * / Private Network Access), so any design where the tablet calls the bridge works on a dev
 * machine and nowhere else. It also leaves `POST /enroll`'s loopback gate intact.
 *
 * The exchange ends where enrolment already began: the claim writes this session's own code
 * hash onto the new bridge row, so `redeem` below is the ordinary `enroll()` call with the code
 * that has been on screen the whole time.
 */

export type PairingPhase =
  /** Not pairing — this bridge already has a working credential. */
  | 'idle'
  /** Asking the API for a code. */
  | 'requesting'
  /** A code is on screen; waiting for somebody to scan it. */
  | 'waiting'
  /** Someone claimed it; redeeming the code for a token. */
  | 'redeeming'
  /** Paired. Terminal — the relay loop takes over from here. */
  | 'paired'
  /** Cannot reach the API. Retrying; the code on screen may still be good. */
  | 'offline';

export interface PairingSnapshot {
  phase: PairingPhase;
  /** Shown on screen. Null in every phase where there is nothing to show. */
  code: string | null;
  expires_at: string | null;
  /** Who claimed it — the line that makes an operator believe the pairing worked. */
  org_name: string | null;
  branch_name: string | null;
  last_error: string | null;
}

const snapshot: PairingSnapshot = {
  phase: 'idle',
  code: null,
  expires_at: null,
  org_name: null,
  branch_name: null,
  last_error: null,
};

export function pairingSnapshot(): PairingSnapshot {
  return { ...snapshot };
}

/**
 * Guards the loop the same way `relayRunning` guards the relay, and for the same reason: this
 * starts an unbounded loop, and two of them would show two different codes on one screen while
 * racing to redeem whichever is claimed first.
 */
let pairingRunning = false;
let stopRequested = false;

export function isPairingRunning(): boolean {
  return pairingRunning;
}

interface SessionCreated {
  session_id: string;
  code: string;
  expires_at: string;
  poll_interval_s: number;
}

interface SessionState {
  status: 'pending' | 'claimed' | 'expired';
  expires_at: string;
  claimed_org_name: string | null;
  claimed_branch_name: string | null;
}

function selfDescription() {
  return {
    install_id: loadState().install_id,
    version: BRIDGE_VERSION,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const base = relayUrl(loadState());
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw Object.assign(
      new Error(typeof detail?.detail === 'string' ? detail.detail : `HTTP ${res.status}`),
      { status: res.status }
    );
  }
  return (await res.json()) as T;
}

async function announce(): Promise<SessionCreated> {
  const body = await postJson<{ data: { item: SessionCreated } }>(
    '/api/v1/modules/print/bridge/pairing-session',
    selfDescription()
  );
  return body.data.item;
}

async function pollOnce(code: string): Promise<SessionState> {
  const body = await postJson<{ data: { item: SessionState } }>(
    '/api/v1/modules/print/bridge/pairing-session/poll',
    { code }
  );
  return body.data.item;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Announce, show, wait, redeem — and mint a fresh code whenever one lapses.
 *
 * Auto-renewal is why there is no "expired" phase and no button to press on this screen. A code
 * left on an unattended computer stops working after fifteen minutes by design, and the
 * alternative to renewing it here is an operator walking up to a dead screen and having to
 * understand why. One live row per unenrolled bridge at any instant, all of them swept server
 * side at expiry.
 */
async function runPairingLoop(): Promise<void> {
  let failures = 0;

  while (!stopRequested) {
    try {
      snapshot.phase = snapshot.code ? snapshot.phase : 'requesting';
      const session = await announce();
      failures = 0;

      snapshot.code = session.code;
      snapshot.expires_at = session.expires_at;
      snapshot.phase = 'waiting';
      snapshot.last_error = null;
      log.info(`pairing: showing code ${session.code}`, {
        event: 'pairing.code_shown',
        expires_at: session.expires_at,
      });

      const pollMs = Math.max(1, session.poll_interval_s) * 1000;
      let live = true;

      while (live && !stopRequested) {
        await sleep(pollMs);
        if (stopRequested) return;

        let state: SessionState;
        try {
          state = await pollOnce(session.code);
          failures = 0;
          // A poll that answers restores the screen from `offline` without waiting for a claim.
          if (snapshot.phase === 'offline') snapshot.phase = 'waiting';
          snapshot.last_error = null;
        } catch (err) {
          // A poll failure is a network fault, not a dead code — the code on screen is very
          // probably still good, so it stays up and the phase says why nothing is happening.
          failures++;
          snapshot.phase = 'offline';
          snapshot.last_error = err instanceof Error ? err.message : String(err);
          await sleep(backoffMs(Math.min(failures, 5)));
          continue;
        }

        if (state.status === 'expired') {
          // Fall out to the outer loop, which mints a replacement immediately.
          live = false;
          break;
        }

        if (state.status === 'claimed') {
          snapshot.phase = 'redeeming';
          snapshot.org_name = state.claimed_org_name;
          snapshot.branch_name = state.claimed_branch_name;

          try {
            const { bridge_id } = await enroll(session.code);
            snapshot.phase = 'paired';
            snapshot.code = null;
            log.info(`pairing: paired as bridge ${bridge_id}`, {
              event: 'pairing.paired',
              bridge_id,
              org: state.claimed_org_name,
            });
            // The relay loop is the point of all this. It is only started here when one is not
            // already live — a re-pair performed while a rejected loop is still unwinding must
            // not put a second loop on `/work`.
            if (!isRelayRunning()) startRelay();
            return;
          } catch (err) {
            // The claim happened but redemption failed. Almost always transient (the API blipped
            // between the two calls), so go back and mint a new code rather than stranding the
            // screen on a code the server has now consumed.
            snapshot.last_error = err instanceof Error ? err.message : String(err);
            log.warn('pairing: redeeming the claimed code failed', {
              event: 'pairing.redeem_failed',
              error: snapshot.last_error,
            });
            live = false;
          }
        }
      }
    } catch (err) {
      failures++;
      snapshot.phase = 'offline';
      snapshot.last_error = err instanceof Error ? err.message : String(err);
      log.warn('pairing: could not reach the server', {
        event: 'pairing.announce_failed',
        error: snapshot.last_error,
      });
      await sleep(backoffMs(Math.min(failures, 5)));
    }
  }
}

/**
 * Begin pairing. Safe to call on every boot: it returns immediately for a bridge that already
 * holds a credential, so `index.ts` does not have to decide which of the two loops to start.
 */
export function startPairing(): void {
  if (pairingRunning) return;
  if (loadState().token) return;

  pairingRunning = true;
  stopRequested = false;
  snapshot.phase = 'requesting';
  snapshot.last_error = null;

  void runPairingLoop().finally(() => {
    pairingRunning = false;
    if (snapshot.phase !== 'paired') snapshot.phase = 'idle';
  });
}

export function stopPairing(): void {
  stopRequested = true;
}

/**
 * Start pairing again for a bridge that still holds a credential the server has rejected.
 *
 * The old token is deliberately NOT cleared. A rejected bridge is often one somebody removed by
 * accident, and throwing the credential away before a replacement exists turns a recoverable
 * mistake into a reinstall. `enroll()` overwrites it only once a new token actually arrives.
 */
export function restartPairing(): void {
  if (pairingRunning) return;
  pairingRunning = true;
  stopRequested = false;
  snapshot.phase = 'requesting';
  snapshot.code = null;
  snapshot.org_name = null;
  snapshot.branch_name = null;
  snapshot.last_error = null;

  void runPairingLoop().finally(() => {
    pairingRunning = false;
    if (snapshot.phase !== 'paired') snapshot.phase = 'idle';
  });
}
