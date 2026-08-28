/*
 * Spawning helpers shared by the USB (spooler) and serial drivers.
 *
 * Both of those transports work by asking the operating system to do the part Node cannot: hand
 * bytes to a print queue, or set the line discipline on a tty. That means spawning, and spawning
 * has three failure modes worth distinguishing — the binary is missing, it ran and refused, or it
 * hung — because they map onto completely different `printed_certainty` answers.
 */
import { spawn, spawnSync } from 'node:child_process';

/** How long to let stdout drain after the process itself has exited. See the note on 'exit' below. */
const STREAM_GRACE_MS = 250;

export interface CommandResult {
  /** Exited 0 without being killed. */
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** We killed it. Whatever it had already done is unknown, which is the whole point. */
  timedOut: boolean;
  /** The binary could not be started at all — almost always "not installed". */
  spawnError: NodeJS.ErrnoException | null;
  /** True once stdin was fully accepted by the child. */
  inputDelivered: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  /** Written to the child's stdin, which is then closed. */
  input?: Buffer;
}

/**
 * Run a command to completion, with a hard timeout.
 *
 * Resolves with an outcome instead of rejecting: every caller has to branch on *how* it failed,
 * and a thrown Error collapses "lp is not installed" into the same shape as "the printer is out
 * of paper". `inputDelivered` exists for the same reason — it is the difference between a job the
 * spooler never saw and one it may have taken.
 */
export function runCommand(file: string, args: string[], options: RunOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const result: CommandResult = {
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: null,
      inputDelivered: false,
    };
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      // A grandchild that outlived its parent still holds these pipe fds. Dropping them here stops
      // one hung command leaking a pair of descriptors for as long as that orphan lives.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };

    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGKILL');
      // Resolution comes from the 'exit' handler below, so stdout captured before the kill is
      // still reported.
    }, options.timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      // Bounded: a runaway command must not be able to exhaust memory through its own output.
      if (result.stdout.length < 1_000_000) result.stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (result.stderr.length < 100_000) result.stderr += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      result.spawnError = err;
      finish();
    });

    /*
     * Both 'exit' and 'close', and the difference matters.
     *
     * 'close' fires when every stdio stream has ended — which is what we want normally, because it
     * guarantees the output is complete. But a command that spawned its own child leaves that
     * grandchild holding the inherited pipes, so killing the parent does NOT close them: 'close'
     * then waits for the grandchild instead, and this function silently ignores its own timeout.
     * (A `sh` wrapper around anything long-running is exactly this shape.)
     *
     * So 'exit' — which fires as soon as the process itself is gone — starts a short grace period
     * for the streams to flush, and resolves regardless once it elapses.
     */
    child.on('exit', (code) => {
      result.code = code;
      result.ok = code === 0 && !result.timedOut;
      graceTimer = setTimeout(finish, STREAM_GRACE_MS);
      graceTimer.unref();
    });

    child.on('close', (code) => {
      if (result.code === null) result.code = code;
      result.ok = result.code === 0 && !result.timedOut;
      finish();
    });

    if (options.input) {
      // A child that dies early turns this write into EPIPE. That is information, not a crash —
      // swallow it and let `inputDelivered` stay false.
      child.stdin.on('error', () => {});
      child.stdin.end(options.input, () => {
        result.inputDelivered = true;
      });
    } else {
      child.stdin.on('error', () => {});
      child.stdin.end();
    }
  });
}

const existsCache = new Map<string, boolean>();

/**
 * Is this executable on PATH?
 *
 * Cached, because it is asked on every `/status` poll and the answer cannot change without the
 * process being restarted in any realistic install. Synchronous on purpose: it is called from
 * `isAvailable()`, which the transport interface keeps sync so a status page can be assembled
 * without awaiting one probe per driver.
 */
export function commandExists(file: string): boolean {
  const memo = existsCache.get(file);
  if (memo !== undefined) return memo;
  const finder = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which';
  const probe = spawnSync(finder, [file], { stdio: 'ignore', windowsHide: true });
  const found = probe.error === undefined && probe.status === 0;
  existsCache.set(file, found);
  return found;
}

/** Test-only: forget what is installed, so a test can put a fake `lp` on PATH. */
export function resetCommandCache(): void {
  existsCache.clear();
}
