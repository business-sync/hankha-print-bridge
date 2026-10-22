/**
 * Proof of life for the background timers.
 *
 * The bridge's long-running work hangs off a handful of intervals — the relay heartbeat, the
 * watchdog, the diagnostics sampler. An interval that stops firing (its callback threw before
 * re-arming something, a loop it awaits never returns) leaves no trace: the absence of a log line
 * is not a log line. Each one records a tick here, and the periodic snapshot reports any that
 * has gone quiet for three of its own intervals.
 *
 * Its own module so that `relay.ts` and `diagnostics.ts` can both use it without importing
 * each other.
 */

interface Tick {
  at: number;
  interval_ms: number;
}

const ticks = new Map<string, Tick>();

export function markTick(name: string, intervalMs: number, at = Date.now()): void {
  ticks.set(name, { at, interval_ms: intervalMs });
}

export interface TickReport {
  name: string;
  since_ms: number;
  interval_ms: number;
  stalled: boolean;
}

export function tickReport(now = Date.now()): TickReport[] {
  return [...ticks.entries()].map(([name, tick]) => {
    const since = now - tick.at;
    return { name, since_ms: since, interval_ms: tick.interval_ms, stalled: since > tick.interval_ms * 3 };
  });
}

/** Tests only. */
export function resetTicks(): void {
  ticks.clear();
}
