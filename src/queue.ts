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
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backoffMs } from './backoff.js';
import { stateDir } from './identity.js';
import type { PrintOutcome, PrintedCertainty } from './lan.js';
import { log } from './log.js';
import type { PrinterRecord } from './registry.js';
import { driverFor } from './transports/index.js';

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
  /** False for the legacy synchronous `/print`, which owns its own retry policy. */
  retryable: boolean;
  /** False keeps the job out of the spool directory entirely. */
  persistent: boolean;
  result?: JobResult;
}

/** The wire view — the same record without a megabyte of base64. */
export type JobView = Omit<JobRecord, 'payload_base64' | 'printer'> & {
  printer_id: string;
  printer_name: string;
  transport: string;
};

export interface SubmitInput {
  job_id?: string;
  source: 'local' | 'relay';
  printer: PrinterRecord;
  payload: Buffer;
  copies?: number;
  ttl_s?: number;
  persistent?: boolean;
  retryable?: boolean;
}

export interface Submission {
  job: JobRecord;
  /** Resolves once the job reaches a terminal state. Never rejects. */
  settled: Promise<JobRecord>;
  /** True when an identical `job_id` had already been handled and nothing was printed again. */
  deduplicated: boolean;
}

export interface QueueOptions {
  /** Overridden in tests so a fake transport can drive the state machine without hardware. */
  send?: (printer: PrinterRecord, bytes: Buffer, timeoutMs: number) => Promise<PrintOutcome>;
  dir?: string;
  maxAttempts?: number;
  sendTimeoutMs?: number;
}

const SPOOL_DIR = 'spool';
const SETTLED_FILE = 'settled.jsonl';
/** How many settled job ids stay remembered across a restart. */
const SETTLED_RING = 500;
/** Rewrite the ring file once it is this much larger than the ring itself. */
const SETTLED_COMPACT_AT = SETTLED_RING * 3;
const HISTORY_LIMIT = 200;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export class PrintQueue {
  private readonly dir: string;
  private readonly maxAttempts: number;
  private readonly sendTimeoutMs: number;
  private readonly sender: (printer: PrinterRecord, bytes: Buffer, timeoutMs: number) => Promise<PrintOutcome>;

  /** Everything not yet settled, by id. */
  private readonly active = new Map<string, JobRecord>();
  /** FIFO per printer. The head is the job being worked on. */
  private readonly lanes = new Map<string, JobRecord[]>();
  private readonly running = new Set<string>();
  private readonly waiters = new Map<string, ((job: JobRecord) => void)[]>();
  /** Settled ids remembered across restarts, so a redelivery is answered rather than reprinted. */
  private readonly settledResults = new Map<string, JobResult>();
  private settledLines = 0;
  private readonly history: JobRecord[] = [];
  private draining = false;
  private readonly sleepers = new Set<() => void>();

  constructor(options: QueueOptions = {}) {
    this.dir = options.dir ?? stateDir();
    this.maxAttempts = options.maxAttempts ?? envInt('PRINT_BRIDGE_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 1, 10);
    this.sendTimeoutMs = options.sendTimeoutMs ?? envInt('PRINT_BRIDGE_SEND_TIMEOUT_MS', DEFAULT_SEND_TIMEOUT_MS, 1000, 120_000);
    this.sender =
      options.send ?? ((printer, bytes, timeoutMs) => driverFor(printer.transport).send(printer, bytes, timeoutMs));
  }

  private spoolDir(): string {
    return join(this.dir, SPOOL_DIR);
  }

  private spoolPath(jobId: string): string {
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
    this.loadSettledRing();

    let recovered = 0;
    let interrupted = 0;
    try {
      mkdirSync(this.spoolDir(), { recursive: true });
      for (const entry of readdirSync(this.spoolDir())) {
        if (!entry.endsWith('.json')) continue;
        const path = join(this.spoolDir(), entry);
        let job: JobRecord;
        try {
          job = JSON.parse(readFileSync(path, 'utf8')) as JobRecord;
        } catch {
          // A torn file cannot be a job. Removing it is safe because a write is temp+rename, so a
          // torn file is by construction one that never became a real job.
          rmSync(path, { force: true });
          continue;
        }
        if (!job.job_id || !job.printer) {
          rmSync(path, { force: true });
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
        this.active.set(job.job_id, job);
        this.laneFor(job).push(job);
        recovered += 1;
      }
    } catch (err) {
      log.error(`queue: could not read the spool (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.load.failed',
      });
    }

    if (recovered > 0 || interrupted > 0) {
      log.info(`queue: recovered ${recovered} job(s) from the spool, ${interrupted} were interrupted mid-print`, {
        event: 'queue.load', recovered, interrupted,
      });
    }
    for (const key of this.lanes.keys()) this.kick(key);
  }

  private loadSettledRing(): void {
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
        }
      }
    } catch {
      /* unreadable ring: the in-memory guard still covers this process's own lifetime */
    }
  }

  private rememberSettled(job: JobRecord): void {
    if (!job.persistent || !job.result) return;
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
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, compacted ? `${compacted}\n` : '');
        renameSync(temp, path);
        this.settledLines = this.settledResults.size;
        return;
      }
      appendFileSync(path, `${JSON.stringify({ job_id: job.job_id, result: job.result })}\n`);
      this.settledLines += 1;
    } catch (err) {
      log.warn(`queue: could not record job ${job.job_id} as settled (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.settled.write_failed', job_id: job.job_id,
      });
    }
  }

  private persist(job: JobRecord): void {
    if (!job.persistent) return;
    try {
      mkdirSync(this.spoolDir(), { recursive: true });
      const path = this.spoolPath(job.job_id);
      const temp = `${path}.tmp`;
      // Temp plus rename: a power cut leaves the previous complete file or the new complete one,
      // never a half-written record that `load()` would then have to guess about.
      writeFileSync(temp, JSON.stringify(job));
      renameSync(temp, path);
    } catch (err) {
      log.warn(`queue: could not spool job ${job.job_id} (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.spool.write_failed', job_id: job.job_id,
      });
    }
  }

  private laneFor(job: JobRecord): JobRecord[] {
    const key = job.printer.id;
    const lane = this.lanes.get(key);
    if (lane) return lane;
    const created: JobRecord[] = [];
    this.lanes.set(key, created);
    return created;
  }

  submit(input: SubmitInput): Submission {
    const jobId = input.job_id?.trim() || randomUUID();

    const existing = this.active.get(jobId);
    if (existing) return { job: existing, settled: this.waitFor(existing), deduplicated: true };

    const remembered = this.settledResults.get(jobId);
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
    };

    this.active.set(jobId, job);
    this.persist(job);
    this.laneFor(job).push(job);
    log.info(`queue: job ${jobId} queued for ${job.printer.id} (${job.printer.transport})`, {
      event: 'queue.submit', job_id: jobId, printer_id: job.printer.id,
      transport: job.printer.transport, bytes: input.payload.length, copies: job.copies,
    });
    this.kick(job.printer.id);

    return { job, settled: this.waitFor(job), deduplicated: false };
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
        if (!this.active.has(job.job_id)) {
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

    job.status = 'printing';
    job.attempts += 1;
    job.updated_at = new Date().toISOString();
    this.persist(job);

    const payload = Buffer.from(job.payload_base64, 'base64');
    let outcome: PrintOutcome = { ok: true, duration_ms: 0 };
    let anyCopyPrinted = false;

    for (let copy = 0; copy < job.copies; copy++) {
      outcome = await this.sender(job.printer, payload, this.sendTimeoutMs);
      if (!outcome.ok) break;
      anyCopyPrinted = true;
    }

    if (outcome.ok) {
      job.status = 'done';
      job.result = { ok: true, duration_ms: outcome.duration_ms };
      log.info(`queue: job ${job.job_id} printed on ${job.printer.id} in ${outcome.duration_ms}ms`, {
        event: 'queue.done', job_id: job.job_id, printer_id: job.printer.id, duration_ms: outcome.duration_ms,
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

    const expiresSoon = job.expires_at !== null && Date.now() > Date.parse(job.expires_at);
    const mayRetry =
      job.retryable && certainty === 'none' && job.attempts < this.maxAttempts && !expiresSoon && !this.draining;

    if (!mayRetry) {
      job.status = 'failed';
      job.result = result;
      log.error(
        `queue: job ${job.job_id} failed on ${job.printer.id} — ${outcome.reason} (${certainty}) ${outcome.detail}`,
        {
          event: 'queue.failed', job_id: job.job_id, printer_id: job.printer.id,
          reason: outcome.reason, printed_certainty: certainty, detail: outcome.detail, attempts: job.attempts,
        }
      );
      this.finish(job);
      return true;
    }

    const wait = backoffMs(job.attempts - 1, 10_000);
    job.status = 'queued';
    job.result = result;
    job.updated_at = new Date().toISOString();
    this.persist(job);
    log.warn(
      `queue: job ${job.job_id} failed (${outcome.reason}) but nothing printed — retrying in ${Math.round(wait / 1000)}s ` +
        `(attempt ${job.attempts} of ${this.maxAttempts})`,
      { event: 'queue.retry', job_id: job.job_id, printer_id: job.printer.id, reason: outcome.reason, attempt: job.attempts, wait_ms: wait }
    );
    await this.sleep(wait);
    // Deliberately kept at the HEAD of the lane. A per-printer queue is sequential because order
    // matters — kitchen tickets, numbered receipts — and letting a later job overtake a retrying
    // one would silently reorder them.
    return false;
  }

  private finish(job: JobRecord): void {
    this.active.delete(job.job_id);
    job.updated_at = new Date().toISOString();
    if (job.persistent) rmSync(this.spoolPath(job.job_id), { force: true });
    this.rememberSettled(job);

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
    const job = this.active.get(jobId);
    if (!job || job.status === 'printing') return false;
    job.status = 'failed';
    job.result = { ok: false, reason: 'cancelled', printed_certainty: 'none', detail: 'cancelled before printing' };
    const lane = this.lanes.get(job.printer.id);
    if (lane) {
      const at = lane.indexOf(job);
      if (at !== -1) lane.splice(at, 1);
    }
    this.finish(job);
    return true;
  }

  get(jobId: string): JobRecord | null {
    return this.active.get(jobId) ?? this.history.find((job) => job.job_id === jobId) ?? null;
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
