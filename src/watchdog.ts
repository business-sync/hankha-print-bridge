import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileDurable } from './durable-fs.js';
import { log } from './log.js';
import { markTick } from './ticks.js';

/**
 * Last-resort self-restart.
 *
 * The bridge swallows uncaught errors on purpose (see `index.ts`), and launchd / Task Scheduler /
 * systemd only restart a process that has EXITED. So a bridge that is up but has been unable to
 * reach the cloud for a long time — a wedged socket stack, a stale DNS cache, an HTTP agent stuck
 * after a network change — is never restarted by anything. This is the one thing that turns that
 * state into an exit, which the supervisor then repairs.
 *
 * It only counts CONTINUOUS time disconnected while enrolled and not waiting for a human (a
 * rejected token needs re-pairing, a restart cannot help), so a healthy session of any length —
 * including a venue with no print traffic for days — never trips it.
 *
 * What it must NOT do is take local printing down for nothing. "The cloud is unreachable" is
 * also what an ordinary internet outage looks like, and the bridge's local `/print` keeps working
 * through one. A restart costs at least 10 seconds on macOS and up to a minute on Windows, so
 * three things limit it:
 *
 *  - it WAITS while jobs are queued or were handled moments ago (`inUse`), up to `maxDeferMs`,
 *    so it does not restart in the middle of service;
 *  - it BACKS OFF: each restart that does not bring the relay back doubles the wait, up to six
 *    hours, and the step survives the restart (`backoff`) — otherwise an outage would restart the
 *    bridge every 15 minutes for as long as it lasted;
 *  - it only forgets that history once the relay has stayed connected for a while (`stableMs`).
 */
export interface WatchdogProbe {
  enrolled: boolean;
  connected: boolean;
  rejected: boolean;
  running: boolean;
}

export interface Watchdog {
  tick(): void;
  stop(): void;
}

/** Where the backoff step lives between restarts. */
export interface BackoffStore {
  read(): number;
  write(step: number): void;
}

const MAX_BACKOFF_MS = 6 * 3_600_000;
const MAX_STEP = 10;
const DEFAULT_MAX_DEFER_MS = 60 * 60_000;
const DEFAULT_STABLE_MS = 10 * 60_000;

export function createWatchdog(opts: {
  probe: () => WatchdogProbe;
  /** Continuous disconnected time before exiting. 0 disables. */
  limitMs: number;
  now?: () => number;
  exit: (reason: string) => void;
  intervalMs?: number;
  /** True while the bridge is busy printing. Defers the exit (but only for `maxDeferMs`). */
  inUse?: () => boolean;
  /** How long a restart may be put off because the bridge is in use. */
  maxDeferMs?: number;
  /** Persists how many restarts in a row failed to bring the relay back. */
  backoff?: BackoffStore;
  /** How long the relay must stay connected before the backoff is forgotten. */
  stableMs?: number;
}): Watchdog {
  const now = opts.now ?? Date.now;
  const maxDeferMs = opts.maxDeferMs ?? DEFAULT_MAX_DEFER_MS;
  const stableMs = opts.stableMs ?? DEFAULT_STABLE_MS;
  let downSince: number | null = null;
  let deferredSince: number | null = null;
  let connectedSince: number | null = null;
  let step = Math.max(0, Math.min(MAX_STEP, Math.floor(opts.backoff?.read() ?? 0)));

  /** Doubles per failed restart, capped — but never below the configured limit itself. */
  const effectiveLimitMs = () => Math.min(opts.limitMs * 2 ** step, Math.max(opts.limitMs, MAX_BACKOFF_MS));

  const intervalMs = opts.intervalMs ?? 30_000;
  const tick = () => {
    if (opts.limitMs <= 0) return;
    markTick('watchdog', intervalMs);
    const p = opts.probe();

    // Connected long enough to trust: the restarts that came before it worked, or were not needed.
    if (p.enrolled && p.running && p.connected) {
      connectedSince ??= now();
      if (step > 0 && now() - connectedSince >= stableMs) {
        log.info(`watchdog: relay has been connected for ${Math.round(stableMs / 60_000)} min — restart backoff cleared`, {
          event: 'relay.watchdog.backoff_cleared', previous_step: step,
        });
        step = 0;
        opts.backoff?.write(0);
      }
    } else {
      connectedSince = null;
    }

    if (!p.enrolled || !p.running || p.connected || p.rejected) {
      if (downSince !== null) {
        const because = p.connected ? 'connected' : p.rejected ? 'rejected' : !p.running ? 'not-running' : 'not-enrolled';
        log.info(`watchdog: restart cancelled after ${Math.round((now() - downSince) / 1000)}s (${because})`, {
          event: 'relay.watchdog.cleared', down_ms: now() - downSince, because,
        });
      }
      downSince = null;
      deferredSince = null;
      return;
    }
    if (downSince === null) {
      downSince = now();
      // Said when the clock STARTS, not only when it fires: a restart 15 minutes later is
      // otherwise a surprise with no visible cause.
      log.info(`watchdog: relay is down — the bridge restarts itself if it stays down for ${Math.round(effectiveLimitMs() / 60_000)} min`, {
        event: 'relay.watchdog.armed', limit_ms: effectiveLimitMs(), backoff_step: step,
      });
    }
    const down = now() - downSince;
    if (down < effectiveLimitMs()) return;

    // Past the limit. If the bridge is mid-service, wait for a quiet moment — local printing does
    // not need the cloud, and a restart now would drop the tickets the kitchen is waiting for.
    if (opts.inUse?.()) {
      const firstDeferral = deferredSince === null;
      deferredSince ??= now();
      if (now() - deferredSince < maxDeferMs) {
        if (firstDeferral) {
          log.info('watchdog: relay is overdue for a restart, but the bridge is printing — waiting for a quiet moment', {
            event: 'relay.watchdog.deferred', down_ms: down, max_defer_ms: maxDeferMs,
          });
        }
        return;
      }
    }

    step = Math.min(MAX_STEP, step + 1);
    // Written BEFORE exiting: the next process reads it, and a step that was lost with the
    // process would make every restart look like the first.
    opts.backoff?.write(step);
    const reason = `relay disconnected for ${Math.round(down / 1000)}s`;
    log.error(`watchdog: ${reason} — exiting so the service manager restarts the bridge`, {
      event: 'relay.watchdog.restart', down_ms: down, backoff_step: step, next_limit_ms: effectiveLimitMs(),
      deferred_ms: deferredSince === null ? 0 : now() - deferredSince,
    });
    opts.exit(reason);
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

/** A one-number file next to the other state. Never throws: a watchdog that cannot remember still works. */
export function fileBackoffStore(path: string): BackoffStore {
  return {
    read() {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { step?: unknown };
        return typeof parsed.step === 'number' && Number.isFinite(parsed.step) ? parsed.step : 0;
      } catch {
        return 0;
      }
    },
    write(step) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileDurable(path, `${JSON.stringify({ step, at: new Date().toISOString() })}\n`);
      } catch (err) {
        log.warn(`watchdog: could not save the restart backoff (${err instanceof Error ? err.message : String(err)})`, {
          event: 'relay.watchdog.backoff_save_failed', err,
        });
      }
    },
  };
}

/** Minutes from the environment; default 15, `0` disables. */
export function watchdogLimitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRINT_BRIDGE_WATCHDOG_MINUTES?.trim();
  if (raw === undefined || raw === '') return 15 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : 15 * 60_000;
}
