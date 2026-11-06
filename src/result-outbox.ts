/*
 * Results the server has not heard yet.
 *
 * A relay job's outcome used to be reported from a closure created when the job arrived. Two
 * things made that closure the only copy of the answer: a report that failed all its retries
 * (about seven seconds) was simply lost, and a job recovered from the spool after a restart had
 * no closure at all — it printed, and the server was never told. In both cases the server's
 * sweeper later wrote UNKNOWN over a job this bridge knew the truth about, which is exactly the
 * state that makes an operator press reprint on a slip that already came out.
 *
 * So the outcome is written down, durably, the moment the job settles, and removed only once the
 * server has accepted it. A pump in the relay drains whatever is left over.
 *
 * One file per job (like the spool), so a torn write costs one outcome and never the lot.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileDurable } from './durable-fs.js';
import { isSafeJobId } from './job-id.js';
import type { JobResult } from './queue.js';
import { log } from './log.js';

export interface PendingResult {
  job_id: string;
  result: JobResult;
  saved_at: string;
}

const RESULTS_DIR = 'results';

export class ResultOutbox {
  constructor(private readonly dir: string) {}

  private resultsDir(): string {
    return join(this.dir, RESULTS_DIR);
  }

  private pathFor(jobId: string): string {
    if (!isSafeJobId(jobId)) throw new Error(`unsafe job id: ${jobId}`);
    return join(this.resultsDir(), `${jobId}.json`);
  }

  /** Returns false (and says why) rather than throwing: the print is done, there is nobody to throw to. */
  save(jobId: string, result: JobResult): boolean {
    try {
      mkdirSync(this.resultsDir(), { recursive: true });
      const entry: PendingResult = { job_id: jobId, result, saved_at: new Date().toISOString() };
      writeFileDurable(this.pathFor(jobId), JSON.stringify(entry));
      return true;
    } catch (err) {
      log.warn(`result-outbox: could not keep the outcome of job ${jobId} (${err instanceof Error ? err.message : String(err)})`, {
        event: 'relay.result.outbox_write_failed', job_id: jobId, err,
      });
      return false;
    }
  }

  remove(jobId: string): void {
    try {
      rmSync(this.pathFor(jobId), { force: true });
    } catch {
      /* an id that cannot be a filename was never saved */
    }
  }

  /** Oldest first, so outcomes reach the server in the order the jobs settled. */
  list(): PendingResult[] {
    const out: PendingResult[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.resultsDir());
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(this.resultsDir(), entry);
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PendingResult>;
        if (parsed.job_id && parsed.result && parsed.saved_at && isSafeJobId(parsed.job_id)) {
          out.push(parsed as PendingResult);
        } else {
          rmSync(path, { force: true });
        }
      } catch {
        // Written temp+rename, so a torn file is one that never became an entry.
        rmSync(path, { force: true });
      }
    }
    return out.sort((a, b) => a.saved_at.localeCompare(b.saved_at) || a.job_id.localeCompare(b.job_id));
  }

  /** Drop entries older than `maxAgeMs`; returns how many. The server has long since swept those jobs. */
  expire(maxAgeMs: number, now = Date.now()): number {
    let dropped = 0;
    for (const entry of this.list()) {
      if (now - Date.parse(entry.saved_at) > maxAgeMs) {
        this.remove(entry.job_id);
        dropped += 1;
        log.warn(`result-outbox: gave up reporting job ${entry.job_id} after ${Math.round(maxAgeMs / 3_600_000)}h`, {
          event: 'relay.result.expired', job_id: entry.job_id, saved_at: entry.saved_at,
        });
      }
    }
    return dropped;
  }

  count(): number {
    try {
      return readdirSync(this.resultsDir()).filter((e) => e.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}
