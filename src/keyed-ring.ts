/*
 * The settled ring for jobs that carry a `dedupe_key`.
 *
 * A job with a `dedupe_key` can arrive by two doors — the LAN API and the cloud relay — and the
 * terminal that sent it may resend it after a lost acknowledgement, a reload, or a power cut that
 * took hours. Whatever the Bridge decided the first time must still be known when the resend comes,
 * so this ring is sized for an outage rather than for a busy minute:
 *
 *  - an entry is never dropped while it is younger than 72 hours, and
 *  - never while the ring holds fewer than 5,000 entries,
 *
 * and only then does the oldest go. A hard cap bounds the file on a venue that prints a great deal.
 *
 * What goes IN is decided by the queue, not here: only `ok`, `unknown` and `cancelled`. A job that
 * provably did not print (`none`, or `expired`) is deliberately absent, because a later send of
 * the same key must be allowed to try again.
 *
 * Separate from the 500-entry ring that guards `job_id`s. That one's behaviour is unchanged on
 * purpose: jobs without a `dedupe_key` must behave exactly as before.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendFileDurable, writeFileDurable } from './durable-fs.js';
import { log } from './log.js';
import type { JobResult } from './queue.js';

export const KEYED_FILE = 'settled-keyed.jsonl';
export const KEYED_MIN_ENTRIES = 5_000;
export const KEYED_MIN_AGE_MS = 72 * 3_600_000;
export const KEYED_HARD_CAP = 50_000;

export interface KeyedEntry {
  /** The dedupe key. */
  key: string;
  /** The Bridge's own id for the job (a UUID for a LAN job, the server's id for a relay job). */
  job_id: string;
  result: JobResult;
  accepted_at: string;
  settled_at: string;
  printer_id: string;
}

export interface KeyedRingOptions {
  minEntries?: number;
  minAgeMs?: number;
  hardCap?: number;
  now?: () => number;
}

interface Line {
  k: string;
  j: string;
  r: JobResult;
  a: string;
  s: string;
  p: string;
}

export class KeyedRing {
  private readonly entries = new Map<string, KeyedEntry>();
  private lines = 0;
  private readonly minEntries: number;
  private readonly minAgeMs: number;
  private readonly hardCap: number;
  private readonly now: () => number;

  constructor(
    private readonly dir: string,
    options: KeyedRingOptions = {}
  ) {
    this.minEntries = options.minEntries ?? KEYED_MIN_ENTRIES;
    this.minAgeMs = options.minAgeMs ?? KEYED_MIN_AGE_MS;
    this.hardCap = options.hardCap ?? KEYED_HARD_CAP;
    this.now = options.now ?? Date.now;
  }

  private path(): string {
    return join(this.dir, KEYED_FILE);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): KeyedEntry | undefined {
    return this.entries.get(key);
  }

  /** Read the file back. A bad line costs that line, never the ring. */
  load(): void {
    const path = this.path();
    if (!existsSync(path)) return;
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      this.lines = lines.length;
      for (const raw of lines) {
        try {
          const l = JSON.parse(raw) as Partial<Line>;
          if (typeof l.k !== 'string' || typeof l.j !== 'string' || !l.r || typeof l.s !== 'string') continue;
          // Re-inserted so the map stays in settle order even if a key appears twice.
          this.entries.delete(l.k);
          this.entries.set(l.k, {
            key: l.k,
            job_id: l.j,
            result: l.r,
            accepted_at: typeof l.a === 'string' ? l.a : l.s,
            settled_at: l.s,
            printer_id: typeof l.p === 'string' ? l.p : '',
          });
        } catch {
          log.debug('queue: skipped an unreadable line in the dedupe-key ring', { event: 'queue.keyed.bad_line' });
        }
      }
      this.evict();
    } catch (err) {
      log.warn('queue: could not read the dedupe-key ring — resends are only caught within this run', {
        event: 'queue.keyed.read_failed', err,
      });
    }
  }

  add(entry: KeyedEntry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.evict();
    try {
      mkdirSync(this.dir, { recursive: true });
      if (this.lines >= Math.max(2_000, this.entries.size * 2 + 1_000)) {
        // Rewrite rather than grow forever; appending keeps each settle one cheap write.
        const body = [...this.entries.values()].map((e) => JSON.stringify(toLine(e))).join('\n');
        writeFileDurable(this.path(), body ? `${body}\n` : '', `${this.path()}.${process.pid}.tmp`);
        this.lines = this.entries.size;
        return;
      }
      appendFileDurable(this.path(), `${JSON.stringify(toLine(entry))}\n`);
      this.lines += 1;
    } catch (err) {
      log.warn(`queue: could not record dedupe key ${entry.key} as settled (${err instanceof Error ? err.message : String(err)})`, {
        event: 'queue.keyed.write_failed', dedupe_key: entry.key,
      });
    }
  }

  clear(): number {
    const n = this.entries.size;
    this.entries.clear();
    this.lines = 0;
    rmSync(this.path(), { force: true });
    return n;
  }

  fileBytes(): number {
    try {
      return statSync(this.path()).size;
    } catch {
      return 0;
    }
  }

  private evict(): void {
    while (this.entries.size > this.hardCap) this.dropOldest();
    while (this.entries.size > this.minEntries) {
      const oldest = this.entries.values().next().value;
      if (!oldest || this.now() - Date.parse(oldest.settled_at) <= this.minAgeMs) break;
      this.dropOldest();
    }
  }

  private dropOldest(): void {
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}

function toLine(e: KeyedEntry): Line {
  return { k: e.key, j: e.job_id, r: e.result, a: e.accepted_at, s: e.settled_at, p: e.printer_id };
}
