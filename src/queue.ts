/*
 * The print queue.
 *
 * Before this, a job was printed inline by whoever received it: the HTTP handler awaited a socket
 * write, and the relay's long-poll loop awaited one too — which meant a printer taking four seconds
 * to answer stopped the bridge fetching ANY cloud work for those four seconds. Nothing survived a
 * restart, and nothing was ever retried.
 *
 * Four properties, in the order they matter:
 *
 *  1. SEQUENTIAL PER PRINTER, concurrent across printers. Not throughput — correctness. The normal
 *     configuration is several kitchen stations sharing one physical printer, and two interleaved
 *     writes to one device produce a single shredded ticket. Different printers still run in
 *     parallel, so a dead one cannot hold up a working one.
 *  2. RETRY ONLY WHAT PROVABLY DID NOT PRINT. `printed_certainty` is the whole rule. RAW/9100 has
 *     no application acknowledgement, and neither does a spooler, so any failure AFTER the channel
 *     opened is 'unknown' and terminal. Retrying those is how a customer gets handed two bills.
 *  3. EXPIRY IS A DROP, NOT A DELAY. The server gives a receipt 120 seconds to live. A bridge that
 *     comes back after an hour and prints the backlog is worse than one that prints nothing: the
 *     till has already moved on, and the paper it produces is wrong.
 *  4. DURABLE, AND DEDUPED ACROSS RESTARTS. Active jobs live in a spool directory; settled job ids
 *     live in a bounded ring on disk. That ring is the last line of defence: if the server ever
 *     redelivers a job — a bug, a replay, a partition, or our own result POST failing right after
 *     a successful print — the second delivery is ANSWERED, not reprinted.
 *
 * A job may also carry a `dedupe_key` (the LAN API, and the relay once the backend sends one). Its
 * IDENTITY is then the key, not the `job_id`: the same key arriving by the LAN and by the relay is
 * one job, whichever door it came in by. Those jobs are remembered in their own, longer ring
 * (`keyed-ring.ts`) and only when the outcome should stop a resend — see `rememberKeyed`. A job
 * without a key is handled exactly as it always was.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backoffMs } from './backoff.js';
import { appendFileDurable, writeFileDurable } from './durable-fs.js';
import { stateDir } from './identity.js';
import { SAFE_JOB_ID, isSafeJobId } from './job-id.js';
import { KeyedRing, type KeyedEntry } from './keyed-ring.js';
import { DEFAULT_PRINTER_PORT, type PrintOutcome, type PrintedCertainty } from './lan.js';
import { log } from './log.js';
import { findPrinter, loadRegistry, type PrinterRecord } from './registry.js';
import { ResultOutbox } from './result-outbox.js';
import { driverFor } from './transports/index.js';
import type { SendOptions } from './transports/transport.js';

export { isSafeJobId };

/**
 * A job that had to be durable could not be written down.
 *
 * Thrown by `submit` only when the caller asked for durability (`requireDurable`), so that a
 * `202 Accepted` always means "this will survive a crash". A full or read-only disk is reported
 * as such instead of being swallowed into a promise that cannot be kept.
 */
export class SpoolWriteError extends Error {
  constructor(jobId: string, cause: unknown) {
    super(`could not write job ${jobId} to the spool: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SpoolWriteError';
  }
}

export type JobStatus = 'queued' | 'printing' | 'done' | 'failed' | 'expired';

export interface JobResult {
  ok: boolean;
  reason?: string;
  printed_certainty?: PrintedCertainty;
  detail?: string;
  duration_ms?: number;
}

export interface JobRecord {
  job_id: string;
  /** Where it came from. Diagnostics only — both sources are treated identically. */
  source: 'local' | 'relay';
  /** A snapshot, not a reference: a job goes where it was addressed even if the registry changes. */
  printer: PrinterRecord;
  payload_base64: string;
  /** Kept separately because `history` drops the payload but still reports the size. */
  bytes: number;
  copies: number;
  attempts: number;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  /** False for a job whose caller owns the retry policy. */
  retryable: boolean;
  /**
   * The last moment a retry may START, for a caller that is waiting on the answer.
   *
   * Unlike `expires_at` it never drops a job, it only stops scheduling retries: a retry whose
   * backoff would end past it is not attempted, and the job fails with the transport's own
   * reason. That way the last attempt finishes while the caller is still listening, rather than
   * being cut off mid-connect and reported as `unknown`.
   */
  retry_until?: string;
  /** Overrides the connect limit for this job's sends. See `SendOptions`. */
  connect_timeout_ms?: number;
  /**
   * The moment every connect for this job must have given up by — the caller's deadline less a
   * margin. Each attempt's connect limit is cut to what is left of it, so an attempt that started
   * late (behind another job in the lane, or as a retry) still ends while the caller is listening.
   */
  connect_until?: string;
  /** Staggered connects for this job's sends. See `SendOptions.connectStaggerMs`. */
  connect_stagger_ms?: number;
  /** False keeps the job out of the spool directory entirely. */
  persistent: boolean;
  /**
   * The caller chose this job's id, so it is an idempotency key and its outcome is worth
   * remembering.
   *
   * Distinct from `persistent`, which asks whether the PAYLOAD is spooled for retry after a
   * crash. A synchronous `/print` is deliberately not spooled — the client holds a socket and
   * owns its own retry policy — but if that client NAMED the job, a repeat of it must still
   * replay rather than print a second bill. Conversely a job whose id we minted ourselves can
   * never be resubmitted under it, so remembering one would fill the ring with entries that can
   * never match and evict the ones that can.
   */
  keyed: boolean;
  /**
   * The terminal's idempotency key. When present it is the job's identity (`jobIdentity`) and the
   * `job_id` is only the Bridge's own handle (and the spool filename).
   */
  dedupe_key?: string;
  /**
   * The printer was named by its registry id, so it is looked up again on every attempt: re-pointing
   * its IP, or turning it off, then affects jobs that are already queued. Absent for every job that
   * is not a keyed registry job, which keep the snapshot they were addressed with.
   */
  registry_id?: boolean;
  /** The line width the payload was rendered for. A registry job refuses a printer that has since changed. */
  rendered_dots?: number;
  result?: JobResult;
}

/** What identifies a job: the terminal's key when it sent one, otherwise the id it was given. */
export function jobIdentity(job: Pick<JobRecord, 'job_id' | 'dedupe_key'>): string {
  return job.dedupe_key ?? job.job_id;
}

/** The charset the LAN contract allows for a `dedupe_key`: 8-128 of `[A-Za-z0-9._:-]`. */
export const DEDUPE_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * One lane per physical destination.
 *
 * Two registry entries can point at one address (a kitchen and a bar station sharing a printer),
 * and two lanes writing to one device interleave into a shredded slip. Network printers are keyed
 * by address, so ids sharing it share a lane. Every other transport keeps one lane per id.
 */
export function laneKeyOf(printer: PrinterRecord): string {
  return printer.transport === 'network' && printer.address
    ? `net:${printer.address}:${printer.port ?? DEFAULT_PRINTER_PORT}`
    : printer.id;
}

/** The wire view — the same record without a megabyte of base64. */
export type JobView = Omit<JobRecord, 'payload_base64' | 'printer'> & {
  printer_id: string;
  printer_name: string;
  transport: string;
};

export interface SubmitInput {
  job_id?: string;
  /** See `JobRecord.dedupe_key`. Validated against `DEDUPE_KEY`. */
  dedupe_key?: string;
  /** See `JobRecord.registry_id`. */
  registry_id?: boolean;
  rendered_dots?: number;
  source: 'local' | 'relay';
  printer: PrinterRecord;
  payload: Buffer;
  copies?: number;
  ttl_s?: number;
  persistent?: boolean;
  /**
   * Refuse the job (throw `SpoolWriteError`) if it cannot be written to the spool, rather than
   * carrying on in memory. For callers that tell their own client "accepted" and mean "will
   * survive a crash". Callers whose upstream tracks the job anyway (the relay) leave it off:
   * printing now with no crash safety beats refusing to print at all.
   */
  requireDurable?: boolean;
  retryable?: boolean;
  /** Sets `retry_until` this many ms from now. */
  retry_window_ms?: number;
  connect_timeout_ms?: number;
  /** Sets `connect_until` this many ms from now. */
  connect_window_ms?: number;
  connect_stagger_ms?: number;
}

export interface Submission {
  job: JobRecord;
  /** Resolves once the job reaches a terminal state. Never rejects. */
  settled: Promise<JobRecord>;
  /** True when an identical `job_id` had already been handled and nothing was printed again. */
  deduplicated: boolean;
}

/** One line of the maintenance card's cache panel. */
export interface CacheItem {
  count: number;
  /** Zero where the item lives in memory and has no file to measure. */
  bytes: number;
}

export interface CacheReport {
  spool: CacheItem;
  history: CacheItem;
  settled: CacheItem;
}

export interface PurgeRequest {
  spool?: boolean;
  history?: boolean;
  settled?: boolean;
}

export interface PurgeReport {
  spool: number;
  history: number;
  settled: number;
  /** Jobs left alone because bytes were on the wire when the purge ran. */
  skipped_printing: number;
}

export interface QueueOptions {
  /** Overridden in tests so a fake transport can drive the state machine without hardware. */
  send?: (printer: PrinterRecord, bytes: Buffer, timeoutMs: number, options?: SendOptions) => Promise<PrintOutcome>;
  dir?: string;
  maxAttempts?: number;
  sendTimeoutMs?: number;
  /** How far past `sendTimeoutMs` a driver may run before the lane gives up on it. */
  watchdogGraceMs?: number;
  /** Looks a registry printer up again for a `registry_id` job. Overridden in tests. */
  resolvePrinter?: (id: string) => PrinterRecord | null;
  /** Retention knobs for the dedupe-key ring. Overridden in tests. */
  keyedRing?: ConstructorParameters<typeof KeyedRing>[1];
}

// Job ids become filenames; see `job-id.ts` for why they are constrained.

const SPOOL_DIR = 'spool';
const SETTLED_FILE = 'settled.jsonl';
/** How many settled job ids stay remembered across a restart. */
const SETTLED_RING = 500;
/** Rewrite the ring file once it is this much larger than the ring itself. */
const SETTLED_COMPACT_AT = SETTLED_RING * 3;
const HISTORY_LIMIT = 200;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
/** Covers the slowest honest driver: CUPS spends up to three 2 s queue checks before `lp` runs. */
const DEFAULT_WATCHDOG_GRACE_MS = 10_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

/** The shortest connect a job is ever given, even once its window has run out. */
const MIN_CONNECT_MS = 250;

function sendOptionsFor(job: JobRecord): SendOptions | undefined {
  let limit = job.connect_timeout_ms;
  if (job.connect_until) {
    const left = Date.parse(job.connect_until) - Date.now();
    limit = Math.max(MIN_CONNECT_MS, Math.min(limit ?? Number.POSITIVE_INFINITY, left));
  }
  if (limit === undefined && !job.connect_stagger_ms) return undefined;
  return {
    ...(limit !== undefined ? { connectTimeoutMs: limit } : {}),
    ...(job.connect_stagger_ms ? { connectStaggerMs: job.connect_stagger_ms } : {}),
  };
}

export class PrintQueue {
  private readonly dir: string;
  private readonly maxAttempts: number;
  private readonly sendTimeoutMs: number;
  private readonly watchdogGraceMs: number;
  private readonly sender: (
    printer: PrinterRecord,
    bytes: Buffer,
    timeoutMs: number,
    options?: SendOptions
  ) => Promise<PrintOutcome>;

  /** Everything not yet settled, by IDENTITY (`jobIdentity`): the dedupe key when there is one. */
  private readonly active = new Map<string, JobRecord>();
  /** FIFO per printer. The head is the job being worked on. */
  private readonly lanes = new Map<string, JobRecord[]>();
  private readonly running = new Set<string>();
  private readonly waiters = new Map<string, ((job: JobRecord) => void)[]>();
  /** Settled ids remembered across restarts, so a redelivery is answered rather than reprinted. */
  private readonly settledResults = new Map<string, JobResult>();
  private settledLines = 0;
  /** Outcomes of jobs that carry a `dedupe_key`; see `keyed-ring.ts`. */
  private readonly keyedRing: KeyedRing;
  private readonly resolveLive: (id: string) => PrinterRecord | null;
  /** Jobs whose bytes are on the wire right now. */
  private readonly sendingNow = new Set<JobRecord>();
  /** Lanes asleep between a failed attempt and the next one. */
  private readonly backingOff = new Set<string>();
  /** When each printer last took a job's bytes without error, by printer id. */
  private readonly lastOk = new Map<string, string>();
  private readonly history: JobRecord[] = [];
  private draining = false;
  private loaded = false;
  private readonly sleepers = new Set<() => void>();
  private lastActivity = 0;

  /**
   * Outcomes of relay jobs the server has not acknowledged yet. Written when a job settles, so a
   * restart or a long outage cannot lose the answer; drained by the relay.
   */
  readonly outbox: ResultOutbox;

  constructor(options: QueueOptions = {}) {
    this.dir = options.dir ?? stateDir();
    this.outbox = new ResultOutbox(this.dir);
    this.keyedRing = new KeyedRing(this.dir, options.keyedRing);
    this.resolveLive = options.resolvePrinter ?? ((id) => findPrinter(loadRegistry(), id));
    this.maxAttempts = options.maxAttempts ?? envInt('PRINT_BRIDGE_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 1, 10);
    this.sendTimeoutMs = options.sendTimeoutMs ?? envInt('PRINT_BRIDGE_SEND_TIMEOUT_MS', DEFAULT_SEND_TIMEOUT_MS, 1000, 120_000);
    this.watchdogGraceMs = options.watchdogGraceMs ?? DEFAULT_WATCHDOG_GRACE_MS;
    this.sender =
      options.send ??
      ((printer, bytes, timeoutMs, sendOptions) =>
        driverFor(printer.transport).send(printer, bytes, timeoutMs, sendOptions));
  }

  private spoolDir(): string {
    return join(this.dir, SPOOL_DIR);
  }

  private spoolPath(jobId: string): string {
    // Belt and braces. Callers are expected to have checked with `isSafeJobId` first, but this
    // is the one place a job id becomes a filesystem path, so it refuses rather than trusts.
    if (!isSafeJobId(jobId)) throw new Error(`unsafe job id: ${jobId}`);
    return join(this.spoolDir(), `${jobId}.json`);
  }

  /**
   * Read the spool back and resume.
   *
   * Anything found in `printing` was interrupted mid-send by whatever killed the process, so it is
   * settled as `unknown` rather than retried: the bytes may well have reached the paper, and there
   * is no way left to ask.
   */
  load(): void {
    /*
     * Idempotent, and that is not a nicety.
     *
     * A second load re-reads the spool directory while the first one's jobs are already in flight.
     * Anything it finds in `printing` gets settled as interrupted — reporting a job as failed when
     * it is at that moment printing successfully — and anything still `queued` is pushed into the
     * lane a SECOND time, which prints it twice. Both were observed before this guard existed.
     */
    if (this.loaded) return;
    this.loaded = true;

    this.loadSettledRing();

    let recovered = 0;
    let interrupted = 0;
    let alreadySettled = 0;
    try {
      mkdirSync(this.spoolDir(), { recursive: true });
      const found: JobRecord[] = [];
      for (const entry of readdirSync(this.spoolDir())) {
        if (!entry.endsWith('.json')) continue;
        const path = join(this.spoolDir(), entry);
        let job: JobRecord;
        try {
          job = JSON.parse(readFileSync(path, 'utf8')) as JobRecord;
        } catch (err) {
          // A torn file cannot be a job. Removing it is safe because a write is temp+rename, so a
          // torn file is by construction one that never became a real job.
          log.warn(`queue: discarded an unreadable spool file ${entry}`, { event: 'queue.spool.torn', file: entry, err });
          rmSync(path, { force: true });
          continue;
        }
        if (!job.job_id || !job.printer || !isSafeJobId(job.job_id)) {
          log.warn(`queue: discarded a spool file with no job in it ${entry}`, { event: 'queue.spool.invalid', file: entry });
          rmSync(path, { force: true });
          continue;
        }
        found.push(job);
      }

      /*
       * Oldest first.
       *
       * `readdir` order is the filesystem's, not the order jobs arrived in, and the lane is FIFO
       * on purpose — kitchen tickets and numbered receipts must come out in the order they were
       * sent. After a restart with several jobs waiting, directory order shuffled them.
       */
      found.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.job_id.localeCompare(b.job_id));

      for (const job of found) {
        // Settled before the crash but the spool file outlived it. `finish` records the outcome in
        // the ring BEFORE removing the file for exactly this reason: finding the id there means
        // the job already ran, and queueing it again would print it a second time.
        if (job.dedupe_key ? this.keyedRing.has(job.dedupe_key) : this.settledResults.has(job.job_id)) {
          alreadySettled += 1;
          log.warn(`queue: spool file for job ${job.job_id} was already settled — discarding it, not reprinting`, {
            event: 'queue.spool.already_settled', job_id: job.job_id,
          });
          this.removeSpool(job.job_id);
          continue;
        }

        if (job.status === 'printing') {
          interrupted += 1;
          job.status = 'failed';
          job.result = {
            ok: false,
            reason: 'write-timeout',
            printed_certainty: 'unknown',
            detail: 'the bridge stopped while this job was being sent',
          };
          this.finish(job);
          continue;
        }

        job.status = 'queued';
        this.active.set(jobIdentity(job), job);
        this.laneFor(job).push(job);
        recovered += 1;
      }
    } catch (err) {
      log.error(`queue: could not read the spool (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.load.failed',
      });
    }

    if (recovered > 0 || interrupted > 0 || alreadySettled > 0) {
      log.info(`queue: recovered ${recovered} job(s) from the spool, ${interrupted} were interrupted mid-print`, {
        event: 'queue.load', recovered, interrupted, already_settled: alreadySettled,
      });
    }
    for (const key of this.lanes.keys()) this.kick(key);
  }

  private loadSettledRing(): void {
    this.keyedRing.load();
    const path = join(this.dir, SETTLED_FILE);
    if (!existsSync(path)) return;
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      this.settledLines = lines.length;
      for (const line of lines.slice(-SETTLED_RING)) {
        try {
          const parsed = JSON.parse(line) as { job_id?: string; result?: JobResult };
          if (parsed.job_id && parsed.result) this.settledResults.set(parsed.job_id, parsed.result);
        } catch {
          /* one bad line must not cost the whole ring */
          log.debug('queue: skipped an unreadable line in the settled-job ring', { event: 'queue.settled.bad_line' });
        }
      }
    } catch (err) {
      /* unreadable ring: the in-memory guard still covers this process's own lifetime */
      log.warn('queue: could not read the settled-job ring — duplicates are only caught within this run', {
        event: 'queue.settled.read_failed', err,
      });
    }
  }

  private rememberSettled(job: JobRecord): void {
    if (!job.result) return;
    if (job.dedupe_key) {
      this.rememberKeyed(job, job.dedupe_key);
      return;
    }
    // A job nobody named cannot be resubmitted under its id, so recording it would fill the
    // ring with entries that can never match and evict the ones that can.
    if (!job.persistent && !job.keyed) return;
    /*
     * A synchronous job that PROVABLY did not print stays retryable.
     *
     * The ring exists to stop a resubmit becoming a second slip, and that reasoning only holds
     * when paper might have come out. For `printed_certainty: 'none'` it provably did not —
     * the socket never opened, or the spooler refused it outright. Remembering such an outcome
     * would make the operator's Retry replay the old failure forever, so a printer switched
     * back on ten seconds later could never be reached again under the same id. That is both a
     * worse failure than the one the ring prevents and a far more common one.
     *
     * Persistent jobs keep the old blanket rule. The relay's own state machine owns their
     * retries, and a redelivery must never reprint one behind its back.
     */
    if (!job.persistent && !job.result.ok && job.result.printed_certainty === 'none') return;
    /*
     * The same holds for a relay job that the PRINTER provably never got, and there it is not
     * optional. The server answers `none` by re-queueing the job under the same id
     * (`reportResult`, while `attempts < max_attempts`) — remembering the failure made every one
     * of those redeliveries a replay, so the server's retries were spent in milliseconds and the
     * job could never print through this bridge again.
     *
     * Only transport failures. `cancelled` and `expired` are decisions somebody made, and a
     * redelivery must not quietly overturn them.
     */
    if (
      job.source === 'relay' &&
      !job.result.ok &&
      job.result.printed_certainty === 'none' &&
      job.result.reason !== 'cancelled' &&
      job.result.reason !== 'expired'
    ) {
      return;
    }
    this.settledResults.set(job.job_id, job.result);
    while (this.settledResults.size > SETTLED_RING) {
      const oldest = this.settledResults.keys().next().value;
      if (oldest === undefined) break;
      this.settledResults.delete(oldest);
    }

    const path = join(this.dir, SETTLED_FILE);
    try {
      mkdirSync(this.dir, { recursive: true });
      if (this.settledLines >= SETTLED_COMPACT_AT) {
        // Rewrite rather than grow forever. Append-only is what makes each settle one cheap write;
        // compaction is what stops a bridge running for a year from carrying a 50 MB file.
        const compacted = [...this.settledResults.entries()]
          .map(([job_id, result]) => JSON.stringify({ job_id, result }))
          .join('\n');
        writeFileDurable(path, compacted ? `${compacted}\n` : '', `${path}.${process.pid}.tmp`);
        this.settledLines = this.settledResults.size;
        return;
      }
      appendFileDurable(path, `${JSON.stringify({ job_id: job.job_id, result: job.result })}\n`);
      this.settledLines += 1;
    } catch (err) {
      log.warn(`queue: could not record job ${job.job_id} as settled (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.settled.write_failed', job_id: job.job_id,
      });
    }
  }

  /**
   * Remember the outcome of a job that carries a `dedupe_key`, when it should stop a resend.
   *
   * Only three outcomes qualify:
   *  - `ok`: it printed, and a resend would print it twice;
   *  - `unknown`: bytes may have reached the paper, and nobody can find out — a resend would be a
   *    guess that costs a second slip, so the operator decides, and reprints under a NEW key;
   *  - `cancelled`: somebody decided, and a late resend must not quietly overturn it.
   *
   * Everything else provably did not print (`none`, `expired`). A later send of the same key has to
   * be allowed to try again, which is the whole point of an outbox that keeps a job until it prints.
   */
  private rememberKeyed(job: JobRecord, key: string): void {
    const result = job.result;
    if (!result) return;
    const remember = result.ok || result.printed_certainty !== 'none' || result.reason === 'cancelled';
    if (!remember) return;
    this.keyedRing.add({
      key,
      job_id: job.job_id,
      result,
      accepted_at: job.created_at,
      settled_at: new Date().toISOString(),
      printer_id: job.printer.id,
    });
  }

  /**
   * Remove a job's spool file. Never throws.
   *
   * `rmSync(..., { force })` only forgives a missing file. With the spool directory itself gone,
   * unreadable, or replaced by a file, it throws — and `finish` runs this AFTER the job has
   * printed, before it wakes whoever is waiting on the result. A throw there left a printed job
   * that never settled, so its caller waited out its own deadline and reported a failure for a
   * slip that was sitting in the printer's tray.
   */
  private removeSpool(jobId: string): void {
    try {
      rmSync(this.spoolPath(jobId), { force: true });
    } catch (err) {
      log.warn(`queue: could not remove the spool file for job ${jobId} (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.spool.remove_failed', job_id: jobId, err,
      });
    }
  }

  /** Returns whether the job is now safely on disk. A job that is not persistent trivially is. */
  private persist(job: JobRecord): { ok: true } | { ok: false; error: unknown } {
    if (!job.persistent) return { ok: true };
    try {
      mkdirSync(this.spoolDir(), { recursive: true });
      // Temp, flush, rename, flush the directory: a power cut leaves the previous complete file
      // or the new complete one, never a half-written or empty record that `load()` would then
      // have to guess about.
      writeFileDurable(this.spoolPath(job.job_id), JSON.stringify(job));
      return { ok: true };
    } catch (err) {
      log.warn(`queue: could not spool job ${job.job_id} (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.spool.write_failed', job_id: job.job_id, err,
      });
      return { ok: false, error: err };
    }
  }

  private laneFor(job: JobRecord): JobRecord[] {
    const key = laneKeyOf(job.printer);
    const lane = this.lanes.get(key);
    if (lane) return lane;
    const created: JobRecord[] = [];
    this.lanes.set(key, created);
    return created;
  }

  submit(input: SubmitInput): Submission {
    const supplied = input.job_id?.trim();
    // Rejected rather than quietly replaced with a fresh UUID: the id is what makes a resubmit
    // idempotent, so silently substituting one would turn a retry into a second receipt.
    if (supplied && !isSafeJobId(supplied)) {
      throw new Error(`job_id must match ${SAFE_JOB_ID}`);
    }
    const dedupeKey = input.dedupe_key;
    if (dedupeKey !== undefined && !DEDUPE_KEY.test(dedupeKey)) {
      throw new Error(`dedupe_key must match ${DEDUPE_KEY}`);
    }
    const jobId = supplied || randomUUID();
    const identity = dedupeKey ?? jobId;

    const existing = this.active.get(identity);
    if (existing) return { job: existing, settled: this.waitFor(existing), deduplicated: true };

    if (dedupeKey) {
      const entry = this.keyedRing.get(dedupeKey);
      if (entry) {
        log.warn(`job ${dedupeKey} was submitted again — re-reporting the first outcome, NOT reprinting`, {
          event: 'queue.duplicate', job_id: entry.job_id, dedupe_key: dedupeKey,
        });
        const replay = this.recordFromRing(entry, input.printer);
        return { job: replay, settled: Promise.resolve(replay), deduplicated: true };
      }
    }

    const remembered = dedupeKey ? undefined : this.settledResults.get(jobId);
    if (remembered) {
      // The single most important branch in this file. Something asked us to print a job we have
      // already handled; report what happened the first time and print nothing.
      log.warn(`job ${jobId} was submitted twice — re-reporting the first outcome, NOT reprinting`, {
        event: 'queue.duplicate', job_id: jobId,
      });
      const replay: JobRecord = {
        job_id: jobId,
        source: input.source,
        printer: input.printer,
        payload_base64: '',
        bytes: 0,
        copies: input.copies ?? 1,
        attempts: 0,
        status: remembered.ok ? 'done' : 'failed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: null,
        retryable: false,
        persistent: false,
        keyed: true,
        result: remembered,
      };
      return { job: replay, settled: Promise.resolve(replay), deduplicated: true };
    }

    const now = Date.now();
    const persistent = input.persistent ?? true;
    const job: JobRecord = {
      job_id: jobId,
      source: input.source,
      printer: input.printer,
      payload_base64: input.payload.toString('base64'),
      bytes: input.payload.length,
      copies: Math.min(20, Math.max(1, input.copies ?? 1)),
      attempts: 0,
      status: 'queued',
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      expires_at: input.ttl_s && input.ttl_s > 0 ? new Date(now + input.ttl_s * 1000).toISOString() : null,
      retryable: input.retryable ?? persistent,
      persistent,
      keyed: Boolean(supplied) || Boolean(dedupeKey),
      ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
      ...(input.registry_id ? { registry_id: true } : {}),
      ...(input.rendered_dots !== undefined ? { rendered_dots: input.rendered_dots } : {}),
      ...(input.retry_window_ms && input.retry_window_ms > 0
        ? { retry_until: new Date(now + input.retry_window_ms).toISOString() }
        : {}),
      ...(input.connect_timeout_ms ? { connect_timeout_ms: input.connect_timeout_ms } : {}),
      ...(input.connect_window_ms && input.connect_window_ms > 0
        ? { connect_until: new Date(now + input.connect_window_ms).toISOString() }
        : {}),
      ...(input.connect_stagger_ms ? { connect_stagger_ms: input.connect_stagger_ms } : {}),
    };

    const spooled = this.persist(job);
    if (!spooled.ok && input.requireDurable) {
      // Not queued at all: the caller is about to say "accepted", and this would make that a lie.
      throw new SpoolWriteError(jobId, spooled.error);
    }
    this.active.set(identity, job);
    this.lastActivity = Date.now();
    this.laneFor(job).push(job);
    log.info(`queue: job ${jobId} queued for ${job.printer.id} (${job.printer.transport})`, {
      event: 'queue.submit', job_id: jobId, printer_id: job.printer.id, source: job.source,
      dedupe_key: dedupeKey,
      transport: job.printer.transport, bytes: input.payload.length, copies: job.copies,
      address: job.printer.address ? `${job.printer.address}:${job.printer.port ?? ''}` : undefined,
      lane_depth: this.laneFor(job).length,
    });
    this.kick(laneKeyOf(job.printer));

    return { job, settled: this.waitFor(job), deduplicated: false };
  }

  /** A job as the dedupe-key ring remembers it: enough to answer a status question or a resend. */
  private recordFromRing(entry: KeyedEntry, printer?: PrinterRecord): JobRecord {
    return {
      job_id: entry.job_id,
      dedupe_key: entry.key,
      source: 'local',
      printer: printer ?? {
        id: entry.printer_id, name: entry.printer_id, transport: 'network', type: 'receipt',
        language: 'escpos', enabled: true,
      },
      payload_base64: '',
      bytes: 0,
      copies: 1,
      attempts: 0,
      status: entry.result.ok ? 'done' : 'failed',
      created_at: entry.accepted_at,
      updated_at: entry.settled_at,
      expires_at: null,
      retryable: false,
      persistent: false,
      keyed: true,
      result: entry.result,
    };
  }

  /** Whether a send of this dedupe key would be answered rather than printed: it is queued or remembered. */
  isKnown(key: string): boolean {
    return this.active.has(key) || this.keyedRing.has(key);
  }

  private waitFor(job: JobRecord): Promise<JobRecord> {
    if (job.status === 'done' || job.status === 'failed' || job.status === 'expired') {
      return Promise.resolve(job);
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(job.job_id) ?? [];
      list.push(resolve);
      this.waiters.set(job.job_id, list);
    });
  }

  /** Interruptible sleep, so a shutdown does not have to wait out a backoff. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        // Removed here rather than in `drain`, so a backoff that simply elapsed does not leave an
        // entry behind — a bridge retries for months and the set would never shrink.
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      timer.unref();
      this.sleepers.add(wake);
      // Covers the race where a shutdown began between the check in `attempt` and this call.
      if (this.draining) wake();
    });
  }

  private kick(key: string): void {
    if (this.running.has(key)) return;
    void this.runLane(key);
  }

  private async runLane(key: string): Promise<void> {
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const lane = this.lanes.get(key);
      while (lane && lane.length > 0 && !this.draining) {
        const job = lane[0];
        if (!job) {
          lane.shift();
          continue;
        }
        if (!this.active.has(jobIdentity(job))) {
          // Cancelled while it waited.
          lane.shift();
          continue;
        }
        const done = await this.attempt(job);
        if (done) lane.shift();
      }
    } finally {
      this.running.delete(key);
    }
    // A job submitted while the loop was winding down would otherwise sit until the next submit.
    const lane = this.lanes.get(key);
    if (lane && lane.length > 0 && !this.draining) this.kick(key);
  }

  /**
   * One send, which is guaranteed to settle.
   *
   * Every driver is meant to honour `timeoutMs` on its own, and a lane is sequential, so the one
   * that does not stops that printer for good: the head job never settles, the jobs behind it
   * never reach `attempt` and so never expire either, and nothing short of a restart moves it.
   * The grace covers the honest overruns (CUPS checks its queue before `lp` runs); past it the
   * bytes may or may not have reached the paper, so the answer is `unknown`, never a retry.
   */
  private async sendWithWatchdog(job: JobRecord, payload: Buffer): Promise<PrintOutcome> {
    const limitMs = this.sendTimeoutMs + this.watchdogGraceMs;
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<PrintOutcome>((resolve) => {
      timer = setTimeout(() => {
        log.error(
          `queue: job ${job.job_id} still sending on ${job.printer.id} after ${limitMs}ms — giving up on it so the jobs behind it can print`,
          {
            event: 'queue.stalled', job_id: job.job_id, printer_id: job.printer.id,
            transport: job.printer.transport, bytes: job.bytes, attempt: job.attempts,
          }
        );
        resolve({
          ok: false,
          reason: 'write-timeout',
          printed_certainty: 'unknown',
          detail: `the ${job.printer.transport} driver did not finish within ${limitMs}ms`,
          duration_ms: Date.now() - startedAt,
        });
      }, limitMs);
    });
    this.sendingNow.add(job);
    try {
      return await Promise.race([this.sender(job.printer, payload, this.sendTimeoutMs, sendOptionsFor(job)), stalled]);
    } finally {
      clearTimeout(timer);
      this.sendingNow.delete(job);
    }
  }

  /** Returns true when the job is finished with (settled), false when it should be retried. */
  private async attempt(job: JobRecord): Promise<boolean> {
    if (job.expires_at && Date.now() > Date.parse(job.expires_at)) {
      job.status = 'expired';
      job.result = {
        ok: false,
        reason: 'expired',
        printed_certainty: 'none',
        detail: `the job's ${job.expires_at} deadline passed before it could be printed`,
      };
      log.warn(`queue: job ${job.job_id} expired before printing`, { event: 'queue.expired', job_id: job.job_id });
      this.finish(job);
      return true;
    }

    if (job.registry_id) {
      const outcome = this.reresolve(job);
      if (outcome === 'settled') return true;
      if (outcome === 'moved') return false;
    }

    job.status = 'printing';
    job.attempts += 1;
    job.updated_at = new Date().toISOString();
    this.persist(job);
    log.debug(`queue: job ${job.job_id} sending to ${job.printer.id} (attempt ${job.attempts})`, {
      event: 'queue.attempt', job_id: job.job_id, printer_id: job.printer.id, attempt: job.attempts,
      wait_ms: Date.now() - Date.parse(job.created_at),
    });

    const payload = Buffer.from(job.payload_base64, 'base64');
    let outcome: PrintOutcome = { ok: true, duration_ms: 0 };
    let anyCopyPrinted = false;

    for (let copy = 0; copy < job.copies; copy++) {
      outcome = await this.sendWithWatchdog(job, payload);
      if (!outcome.ok) break;
      anyCopyPrinted = true;
    }

    if (outcome.ok) {
      job.status = 'done';
      job.result = { ok: true, duration_ms: outcome.duration_ms };
      this.lastOk.set(job.printer.id, new Date().toISOString());
      // The extra connections are the evidence of a printer that was slow to wake.
      const woke = outcome.connect_attempts
        ? ` (accepted connection ${outcome.connect_attempts} after ${outcome.connected_after_ms}ms)`
        : '';
      log.info(`queue: job ${job.job_id} printed on ${job.printer.id} in ${outcome.duration_ms}ms${woke}`, {
        event: 'queue.done', job_id: job.job_id, printer_id: job.printer.id, source: job.source,
        duration_ms: outcome.duration_ms, attempts: job.attempts, total_ms: Date.now() - Date.parse(job.created_at),
        connect_attempts: outcome.connect_attempts, connected_after_ms: outcome.connected_after_ms,
      });
      this.finish(job);
      return true;
    }

    // A later copy failing after an earlier one printed means SOMETHING came out, whatever the
    // transport says about this particular attempt. Reprinting the job would duplicate the copies
    // that already succeeded.
    const certainty: PrintedCertainty = anyCopyPrinted ? 'unknown' : outcome.printed_certainty;
    const result: JobResult = {
      ok: false,
      reason: outcome.reason,
      printed_certainty: certainty,
      detail: outcome.detail,
      duration_ms: outcome.duration_ms,
    };

    const expired = job.expires_at !== null && Date.now() > Date.parse(job.expires_at);
    /*
     * A DEADLINE outranks the attempt count.
     *
     * `maxAttempts` alone gives up after about three seconds of backoff, which is shorter than a
     * printer takes to finish rebooting — so a receipt would be abandoned while the thing it was
     * meant for was still coming back up. When the caller set a TTL it has already said how long
     * the job stays worth printing, and the top of this method drops it the moment that passes.
     * So the count is the safety valve for jobs with NO deadline, and the deadline governs the
     * rest.
     */
    const withinDeadline = job.expires_at !== null && !expired;
    const wait = backoffMs(job.attempts - 1, 10_000);
    // A caller-held window replaces the attempt count: it already says how long retrying is
    // worth it, and the window is short enough that the count would never bind first.
    const retryUntil = job.retry_until ? Date.parse(job.retry_until) : null;
    const mayRetry =
      job.retryable &&
      certainty === 'none' &&
      !expired &&
      !this.draining &&
      (retryUntil !== null
        ? Date.now() + wait <= retryUntil
        : job.attempts < this.maxAttempts || withinDeadline);

    if (!mayRetry) {
      job.status = 'failed';
      job.result = result;
      log.error(
        `queue: job ${job.job_id} failed on ${job.printer.id} — ${outcome.reason} (${certainty}) ${outcome.detail}`,
        {
          event: 'queue.failed', job_id: job.job_id, printer_id: job.printer.id, source: job.source,
          reason: outcome.reason, printed_certainty: certainty, detail: outcome.detail, attempts: job.attempts,
          connect_attempts: outcome.connect_attempts, total_ms: Date.now() - Date.parse(job.created_at),
        }
      );
      this.finish(job);
      return true;
    }

    job.status = 'queued';
    job.result = result;
    job.updated_at = new Date().toISOString();
    this.persist(job);
    log.warn(
      `queue: job ${job.job_id} failed (${outcome.reason}) but nothing printed — retrying in ${Math.round(wait / 1000)}s ` +
        (retryUntil !== null
          ? `(attempt ${job.attempts}, until ${job.retry_until})`
          : withinDeadline
            ? `(attempt ${job.attempts}, until ${job.expires_at})`
            : `(attempt ${job.attempts} of ${this.maxAttempts})`),
      { event: 'queue.retry', job_id: job.job_id, printer_id: job.printer.id, reason: outcome.reason, attempt: job.attempts, wait_ms: wait }
    );
    const laneKey = laneKeyOf(job.printer);
    this.backingOff.add(laneKey);
    try {
      await this.sleep(wait);
    } finally {
      this.backingOff.delete(laneKey);
    }
    // Deliberately kept at the HEAD of the lane. A per-printer queue is sequential because order
    // matters — kitchen tickets, numbered receipts — and letting a later job overtake a retrying
    // one would silently reorder them.
    return false;
  }

  /**
   * Look a registry-addressed job's printer up again, just before it is sent.
   *
   * A job is queued for a printer by id; by the time it is its turn the operator may have pointed
   * that id at a new IP, turned it off, removed it, or swapped the roll width. Sending to the old
   * snapshot would print on the wrong device, or on one the operator had taken out of service.
   *
   *  - gone or disabled: the job fails with certainty `none` (nothing was sent), so the terminal
   *    may resend it once the printer is back;
   *  - a different line width than the payload was rendered for: same, because the slip would wrap;
   *  - a different address: the job takes the new address, and moves to that address's lane so two
   *    ids at one address still cannot write at once.
   */
  private reresolve(job: JobRecord): 'ok' | 'settled' | 'moved' {
    const live = this.resolveLive(job.printer.id);
    const refuse = (detail: string): 'settled' => {
      job.status = 'failed';
      job.result = { ok: false, reason: 'device-missing', printed_certainty: 'none', detail };
      log.warn(`queue: job ${job.job_id} not sent — ${detail}`, {
        event: 'queue.reresolve.refused', job_id: job.job_id, printer_id: job.printer.id, dedupe_key: job.dedupe_key,
      });
      this.finish(job);
      return 'settled';
    };
    if (!live) return refuse(`printer '${job.printer.id}' is no longer in this bridge's registry`);
    if (!live.enabled) return refuse(`printer '${job.printer.id}' is disabled on this bridge`);
    if (job.rendered_dots !== undefined && live.dots_per_line !== undefined && live.dots_per_line !== job.rendered_dots) {
      return refuse(
        `printer '${job.printer.id}' now prints ${live.dots_per_line} dots per line, but this slip was laid out for ${job.rendered_dots} — send it again`
      );
    }

    const before = laneKeyOf(job.printer);
    const after = laneKeyOf(live);
    job.printer = live;
    if (before === after) return 'ok';

    log.info(`queue: job ${job.job_id} follows printer '${live.id}' to its new address`, {
      event: 'queue.reresolve.moved', job_id: job.job_id, printer_id: live.id, from: before, to: after,
    });
    const from = this.lanes.get(before);
    const at = from ? from.indexOf(job) : -1;
    if (from && at !== -1) from.splice(at, 1);
    const target = this.lanes.get(after) ?? [];
    this.lanes.set(after, target);
    // Oldest first, as `load()` orders a lane — but never ahead of a job already on the wire.
    let index = this.running.has(after) ? 1 : 0;
    while (index < target.length && (target[index]?.created_at ?? '') <= job.created_at) index += 1;
    target.splice(Math.min(index, target.length), 0, job);
    this.persist(job);
    this.kick(after);
    return 'moved';
  }

  private finish(job: JobRecord): void {
    this.active.delete(jobIdentity(job));
    job.updated_at = new Date().toISOString();
    this.lastActivity = Date.now();
    /*
     * Order matters, and it is the reverse of what this used to do.
     *
     * The spool file is the only thing saying "this job has not run". Removing it first and
     * recording the outcome second leaves a window in which a crash loses both facts: the job is
     * neither waiting nor remembered, so a redelivery from the server prints it again. Record
     * first, remove second, and the worst a crash can leave is a file `load()` recognises as
     * already settled and discards.
     */
    this.rememberSettled(job);
    // The server has not been told yet. Written before anything can go wrong with the report, and
    // before the spool file goes, so a job whose answer is lost is still reported after a restart.
    if (job.source === 'relay' && job.result) this.outbox.save(job.job_id, job.result);
    if (job.persistent) this.removeSpool(job.job_id);

    // A COPY without the payload. Retaining the base64 would make the history ring hold up to
    // 200 x 1 MiB of bytes nobody will ever send again.
    this.history.unshift({ ...job, payload_base64: '' });
    while (this.history.length > HISTORY_LIMIT) this.history.pop();

    const waiting = this.waiters.get(job.job_id);
    this.waiters.delete(job.job_id);
    for (const resolve of waiting ?? []) resolve(job);
  }

  /**
   * Remove a job that has not started yet.
   *
   * Returns false once it is printing, and that answer is load-bearing: the synchronous `/print`
   * route uses it to decide whether a timeout can honestly claim nothing was printed.
   */
  cancel(jobId: string): boolean {
    const job = this.findActive(jobId);
    if (!job || job.status === 'printing') return false;
    job.status = 'failed';
    job.result = { ok: false, reason: 'cancelled', printed_certainty: 'none', detail: 'cancelled before printing' };
    // Said out loud: a job that vanished from the log without a line was indistinguishable from
    // one still waiting, and a later "submitted twice" was the only trace it had ever settled.
    log.info(`queue: job ${jobId} cancelled before printing`, {
      event: 'queue.cancelled', job_id: jobId, printer_id: job.printer.id,
    });
    const lane = this.lanes.get(laneKeyOf(job.printer));
    if (lane) {
      const at = lane.indexOf(job);
      if (at !== -1) lane.splice(at, 1);
    }
    this.finish(job);
    return true;
  }

  /** A queued job by identity (its dedupe key) or by the `job_id` it was given. */
  private findActive(idOrKey: string): JobRecord | undefined {
    const direct = this.active.get(idOrKey);
    if (direct) return direct;
    for (const job of this.active.values()) if (job.job_id === idOrKey) return job;
    return undefined;
  }

  /**
   * A job by id or dedupe key: queued, recently settled, or — for a dedupe key — remembered in the
   * ring across restarts. Jobs without a key are never read from the ring here: `GET /jobs/:id` has
   * always answered 404 for a settled job that has aged out of `history`, and keeps doing so.
   */
  get(idOrKey: string): JobRecord | null {
    return (
      this.findActive(idOrKey) ??
      this.history.find((job) => job.job_id === idOrKey || job.dedupe_key === idOrKey) ??
      this.fromKeyedRing(idOrKey)
    );
  }

  private fromKeyedRing(key: string): JobRecord | null {
    const entry = this.keyedRing.get(key);
    return entry ? this.recordFromRing(entry) : null;
  }

  list(): JobRecord[] {
    return [...this.active.values(), ...this.history];
  }

  depth(): Record<JobStatus, number> {
    const counts: Record<JobStatus, number> = { queued: 0, printing: 0, done: 0, failed: 0, expired: 0 };
    for (const job of this.list()) counts[job.status] += 1;
    return counts;
  }

  /** Jobs waiting or in flight, which is what "queue depth" means to an operator. */
  pending(): number {
    return this.active.size;
  }

  /**
   * Whether anything has been printing or arriving lately: jobs in the queue, or one that was
   * submitted or settled within `withinMs`. The watchdog uses it to avoid restarting the process
   * in the middle of service.
   */
  isInUse(withinMs: number, now = Date.now()): boolean {
    return this.active.size > 0 || (this.lastActivity > 0 && now - this.lastActivity <= withinMs);
  }

  /** True while this printer's lane is sending or has jobs waiting. The keep-warm probe stays off it. */
  isBusy(printerId: string): boolean {
    for (const lane of this.lanes.values()) if (lane.some((job) => job.printer.id === printerId)) return true;
    return false;
  }

  /** When this printer last accepted a job's bytes, in this run. Null if it has not. */
  lastPrintOk(printerId: string): string | null {
    return this.lastOk.get(printerId) ?? null;
  }

  /**
   * Whether a bare connect to this printer could collide with a real job.
   *
   * Narrower than `isBusy`, and that is the point. A printer that is switched off keeps its lane
   * "busy" for as long as a job waits for it — retrying, asleep in backoff — and the keep-warm probe
   * stayed off it for exactly the time its answer was worth most. A probe only competes with a job
   * that is sending, or about to: a lane asleep in backoff is neither.
   */
  isProbeBlocked(printerId: string): boolean {
    for (const job of this.sendingNow) if (job.printer.id === printerId) return true;
    for (const [key, lane] of this.lanes) {
      if (lane.length === 0 || !lane.some((job) => job.printer.id === printerId)) continue;
      if (!this.backingOff.has(key)) return true;
    }
    return false;
  }

  /**
   * Stop taking work and let the current sends finish.
   *
   * Queued jobs are deliberately NOT drained: they are already on disk, and printing a backlog
   * during a shutdown is how a service restart turns into a paper jam. They resume on next start,
   * subject to their own expiry.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    for (const wake of this.sleepers) wake();
    this.sleepers.clear();

    const deadline = Date.now() + timeoutMs;
    // Not unref'd: the point of draining is to hold the process open until the in-flight write
    // finishes, so an unref'd timer here would let node exit out from under it.
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * What a purge would remove, so the maintenance card can show it before anyone presses
   * anything.
   *
   * Sizes come off the filesystem rather than from a running total: the spool is also written by
   * `load()` recovery and trimmed by `finish()`, and a counter kept alongside those would drift
   * on exactly the bridge worth asking about.
   */
  cacheSizes(): CacheReport {
    let spoolCount = 0;
    let spoolBytes = 0;
    try {
      for (const entry of readdirSync(this.spoolDir())) {
        if (!entry.endsWith('.json')) continue;
        spoolCount += 1;
        try {
          spoolBytes += statSync(join(this.spoolDir(), entry)).size;
        } catch {
          // Raced with a job settling. One file's size is not worth failing the whole report.
        }
      }
    } catch {
      // No spool directory yet: a bridge that has never printed.
    }

    let settledBytes = 0;
    try {
      settledBytes = statSync(join(this.dir, SETTLED_FILE)).size;
    } catch {
      // The ring file only exists once something has settled.
    }

    return {
      spool: { count: spoolCount, bytes: spoolBytes },
      history: { count: this.history.length, bytes: 0 },
      settled: { count: this.settledResults.size + this.keyedRing.size, bytes: settledBytes + this.keyedRing.fileBytes() },
    };
  }

  /**
   * Throw away what an operator means by "clear the cache" — and nothing else.
   *
   * Three properties worth stating, because each replaces something that looks simpler:
   *
   *  - The spool is CANCELLED, not unlinked. `cancel()` settles each job as `cancelled` with
   *    `printed_certainty: 'none'`, which resolves everything awaiting `settled` and removes the
   *    file through the ordinary path. Sweeping the directory underneath a running queue would
   *    leave the lanes holding jobs whose payloads are gone and every waiter hanging forever.
   *  - A job that is PRINTING is left alone. Its bytes are on the wire; there is nothing safe to
   *    do with it, and the count is reported rather than hidden.
   *  - `settled` is separate and never implied. That ring is what stops a redelivered job
   *    printing a second bill, so clearing it is a decision, not a side effect of tidying up.
   *
   * `printers.json` and `relay.json` are in the same directory and are never touched here: one
   * is the configuration, the other is this computer's identity and its pairing credential.
   */
  purge(what: PurgeRequest): PurgeReport {
    const report: PurgeReport = { spool: 0, history: 0, settled: 0, skipped_printing: 0 };
    // Counted before the spool pass, which settles jobs INTO the history it is about to clear.
    const historyBefore = this.history.length;

    if (what.spool) {
      for (const job of [...this.active.values()]) {
        if (job.status === 'printing') {
          report.skipped_printing += 1;
          continue;
        }
        if (this.cancel(job.job_id)) report.spool += 1;
      }
      /*
       * Then the orphans: files belonging to no live job — a leftover from a crash, or one
       * `load()` could not parse.
       *
       * A job still ACTIVE is skipped even though its file is right there. The only one left by
       * now is the job currently on the wire, and its spool file is the sole record that it was
       * being sent: delete it and a crash mid-print loses the job entirely, where `load()` would
       * otherwise recover it and settle it honestly as 'unknown'.
       */
      // Spool files are named by job_id, which is not the map key for a job with a dedupe key.
      const activeIds = new Set([...this.active.values()].map((job) => job.job_id));
      try {
        for (const entry of readdirSync(this.spoolDir())) {
          if (!entry.endsWith('.json')) continue;
          if (activeIds.has(entry.slice(0, -'.json'.length))) continue;
          rmSync(join(this.spoolDir(), entry), { force: true });
          report.spool += 1;
        }
      } catch {
        // No spool directory: nothing to sweep.
      }
    }

    if (what.history) {
      report.history = historyBefore;
      this.history.length = 0;
    }

    if (what.settled) {
      report.settled = this.settledResults.size + this.keyedRing.clear();
      this.settledResults.clear();
      this.settledLines = 0;
      rmSync(join(this.dir, SETTLED_FILE), { force: true });
    }

    return report;
  }
}

let instance: PrintQueue | null = null;

/** The process-wide queue. Created on first use so tests can build isolated ones instead. */
export function queue(): PrintQueue {
  if (!instance) {
    instance = new PrintQueue();
    instance.load();
  }
  return instance;
}

export function describeJob(job: JobRecord): JobView {
  const { payload_base64: _payload, printer, ...rest } = job;
  return { ...rest, printer_id: printer.id, printer_name: printer.name, transport: printer.transport };
}
