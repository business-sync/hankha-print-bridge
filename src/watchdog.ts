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

export function createWatchdog(opts: {
  probe: () => WatchdogProbe;
  /** Continuous disconnected time before exiting. 0 disables. */
  limitMs: number;
  now?: () => number;
  exit: (reason: string) => void;
  intervalMs?: number;
}): Watchdog {
  const now = opts.now ?? Date.now;
  let downSince: number | null = null;

  const intervalMs = opts.intervalMs ?? 30_000;
  const tick = () => {
    if (opts.limitMs <= 0) return;
    markTick('watchdog', intervalMs);
    const p = opts.probe();
    if (!p.enrolled || !p.running || p.connected || p.rejected) {
      if (downSince !== null) {
        const because = p.connected ? 'connected' : p.rejected ? 'rejected' : !p.running ? 'not-running' : 'not-enrolled';
        log.info(`watchdog: restart cancelled after ${Math.round((now() - downSince) / 1000)}s (${because})`, {
          event: 'relay.watchdog.cleared', down_ms: now() - downSince, because,
        });
      }
      downSince = null;
      return;
    }
    if (downSince === null) {
      downSince = now();
      // Said when the clock STARTS, not only when it fires: a restart 15 minutes later is
      // otherwise a surprise with no visible cause.
      log.info(`watchdog: relay is down — the bridge restarts itself if it stays down for ${Math.round(opts.limitMs / 60_000)} min`, {
        event: 'relay.watchdog.armed', limit_ms: opts.limitMs,
      });
    }
    const down = now() - downSince;
    if (down >= opts.limitMs) {
      const reason = `relay disconnected for ${Math.round(down / 1000)}s`;
      log.error(`watchdog: ${reason} — exiting so the service manager restarts the bridge`, {
        event: 'relay.watchdog.restart', down_ms: down,
      });
      opts.exit(reason);
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

/** Minutes from the environment; default 15, `0` disables. */
export function watchdogLimitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRINT_BRIDGE_WATCHDOG_MINUTES?.trim();
  if (raw === undefined || raw === '') return 15 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : 15 * 60_000;
}
