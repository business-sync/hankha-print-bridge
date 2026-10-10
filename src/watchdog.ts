import { log } from './log.js';

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

  const tick = () => {
    if (opts.limitMs <= 0) return;
    const p = opts.probe();
    if (!p.enrolled || !p.running || p.connected || p.rejected) {
      downSince = null;
      return;
    }
    downSince ??= now();
    const down = now() - downSince;
    if (down >= opts.limitMs) {
      const reason = `relay disconnected for ${Math.round(down / 1000)}s`;
      log.error(`watchdog: ${reason} — exiting so the service manager restarts the bridge`, {
        event: 'relay.watchdog.restart', down_ms: down,
      });
      opts.exit(reason);
    }
  };

  const timer = setInterval(tick, opts.intervalMs ?? 30_000);
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
