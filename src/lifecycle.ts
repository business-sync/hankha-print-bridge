/*
 * One implementation of "stop this bridge cleanly", shared by the signal handlers and by
 * `POST /service/restart`.
 *
 * The graceful stop lives in `index.ts` because that is what owns the HTTP server, and closing
 * the listener is half of it. But the restart route needs exactly the same sequence — stop
 * listening, let the write already on the wire finish, exit — and a second copy of it in
 * `server.ts` would be a second thing to keep in step with the drain timeout and with the rule
 * that queued jobs are deliberately NOT flushed on the way down.
 *
 * So `index.ts` registers its stopper here and both callers go through this module.
 *
 * `requestStop` returning FALSE is meaningful rather than an error case: nothing has registered
 * a stopper under `node --test`, and `server.test.ts` drives the router directly with no process
 * to end. A restart route that called `process.exit()` itself would take the test runner down
 * with it.
 */

/** Called with the exit code the process should end on. Must not throw. */
export type Stopper = (exitCode: number) => void;

let stopper: Stopper | null = null;

export function registerStopper(fn: Stopper): void {
  stopper = fn;
}

/** Test-only: put the module back to its unregistered state. */
export function clearStopper(): void {
  stopper = null;
}

export function canStop(): boolean {
  return stopper !== null;
}

/**
 * Begin a graceful shutdown, if this process has one to begin.
 *
 * The exit code is not decoration on Windows: a scheduled task that ends CLEANLY is not
 * restarted by `-RestartInterval` (that only fires when the task ends in error), so exiting 1
 * is the fallback that gets a bridge back within the minute when the respawn helper could not
 * be written. See `restartService` in service-actions.ts.
 */
export function requestStop(exitCode = 0): boolean {
  if (!stopper) return false;
  stopper(exitCode);
  return true;
}
