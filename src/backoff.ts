/**
 * Jittered exponential backoff, shared by the relay loop and the print queue.
 *
 * The jitter is not cosmetic. Production rolls out with `maxUnavailable: 25%`, which kills every
 * in-flight 25-second long-poll at the same instant; without jitter every bridge in the fleet
 * would reconnect in lock-step and stampede the new pod, and an unjittered exponential backoff
 * would leave every venue dark for the same 30 seconds.
 *
 * The same argument applies to the queue: a venue whose switch reboots fails every queued job at
 * once, and retrying them all on the same schedule just reproduces the pile-up against a printer
 * that is still booting.
 */
export const MAX_BACKOFF_MS = 30_000;

/** `attempt` is 0-based. Returns between 50% and 100% of the un-jittered delay. */
export function backoffMs(attempt: number, maxMs = MAX_BACKOFF_MS): number {
  const base = Math.min(2 ** Math.max(0, attempt) * 1000, maxMs);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}
