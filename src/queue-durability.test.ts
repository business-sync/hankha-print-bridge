import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { PrintOutcome } from './lan.js';
import { type LogRecord, setLogSink } from './log.js';
import { PrintQueue, SpoolWriteError, type JobRecord } from './queue.js';
import type { PrinterRecord } from './registry.js';

/*
 * What the spool promises across a crash, a full disk and a restart.
 *
 * `queue.test.ts` pins the retry rules. These pin the durability: what is on disk when the
 * process dies, what comes back, in what order, and — above all — that nothing comes back and
 * prints a second time.
 */

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-durable-q-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let restoreLog: (() => void) | null = null;
let records: LogRecord[] = [];
beforeEach(() => {
  records = [];
  restoreLog = setLogSink((r) => records.push(r));
});
afterEach(() => restoreLog?.());

function printer(id = 'kitchen'): PrinterRecord {
  return {
    id, name: id, transport: 'network', type: 'receipt', language: 'escpos',
    enabled: true, address: '192.168.1.50', port: 9100, dots_per_line: 576,
  };
}

const ok = (): PrintOutcome => ({ ok: true, duration_ms: 1 });

/** A job exactly as the spool stores it, so a test can plant one without running the queue. */
function planted(id: string, createdAt: string, extra: Partial<JobRecord> = {}): JobRecord {
  return {
    job_id: id,
    source: 'local',
    printer: printer(),
    payload_base64: Buffer.from(`body:${id}`).toString('base64'),
    bytes: 8,
    copies: 1,
    attempts: 0,
    status: 'queued',
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: null,
    retryable: true,
    persistent: true,
    keyed: true,
    ...extra,
  };
}

function plant(dir: string, job: JobRecord): void {
  mkdirSync(join(dir, 'spool'), { recursive: true });
  writeFileSync(join(dir, 'spool', `${job.job_id}.json`), JSON.stringify(job));
}

async function until(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('recovery order', () => {
  it('replays waiting jobs oldest first, whatever order the directory lists them in', async () => {
    const dir = scratch();
    // Names chosen so that alphabetical order is the REVERSE of arrival order.
    plant(dir, planted('c-first', '2026-11-07T10:00:00.000Z'));
    plant(dir, planted('b-second', '2026-11-07T10:00:01.000Z'));
    plant(dir, planted('a-third', '2026-11-07T10:00:02.000Z'));

    const printed: string[] = [];
    const queue = new PrintQueue({
      dir,
      send: async (_p, bytes) => {
        printed.push(bytes.toString());
        return ok();
      },
    });
    queue.load();
    await until(() => queue.pending() === 0);

    assert.deepEqual(printed, ['body:c-first', 'body:b-second', 'body:a-third']);
  });

  it('breaks a tie on creation time by id, so the order is the same on every run', async () => {
    const dir = scratch();
    const same = '2026-11-07T10:00:00.000Z';
    plant(dir, planted('job-b', same));
    plant(dir, planted('job-a', same));
    const printed: string[] = [];
    const queue = new PrintQueue({ dir, send: async (_p, b) => (printed.push(b.toString()), ok()) });
    queue.load();
    await until(() => queue.pending() === 0);
    assert.deepEqual(printed, ['body:job-a', 'body:job-b']);
  });
});

describe('a job that already ran', () => {
  it('is not printed again when its spool file outlived a crash', async () => {
    const dir = scratch();
    plant(dir, planted('ran-already', '2026-11-07T10:00:00.000Z'));
    // The state a crash between "record the outcome" and "remove the file" leaves behind.
    writeFileSync(
      join(dir, 'settled.jsonl'),
      `${JSON.stringify({ job_id: 'ran-already', result: { ok: true, duration_ms: 4 } })}\n`,
    );

    let sends = 0;
    const queue = new PrintQueue({ dir, send: async () => (sends += 1, ok()) });
    queue.load();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sends, 0, 'a settled job was printed a second time');
    assert.equal(queue.pending(), 0);
    assert.equal(existsSync(join(dir, 'spool', 'ran-already.json')), false);
    assert.ok(records.some((r) => r.event === 'queue.spool.already_settled'));
  });

  it('records the outcome in the ring BEFORE the spool file goes', async () => {
    const dir = scratch();
    const ring = join(dir, 'settled.jsonl');
    const inRing = (id: string) => existsSync(ring) && readFileSync(ring, 'utf8').includes(id);
    const atSend: Array<{ ring: boolean; spool: boolean }> = [];
    const atRemoval: boolean[] = [];
    const queue = new PrintQueue({
      dir,
      send: async () => {
        // At send time the job is spooled and not yet in the ring.
        atSend.push({ ring: inRing('order-1'), spool: existsSync(join(dir, 'spool', 'order-1.json')) });
        return ok();
      },
    });
    // Watch the moment the spool file is removed: the ring must already hold the outcome, or a
    // crash right there loses both facts and the server's redelivery prints the job again.
    const internals = queue as unknown as { removeSpool(id: string): void };
    const realRemove = internals.removeSpool.bind(queue);
    internals.removeSpool = (id: string) => {
      atRemoval.push(inRing(id));
      realRemove(id);
    };

    await queue.submit({ job_id: 'order-1', source: 'local', printer: printer(), payload: Buffer.from('x') }).settled;

    assert.deepEqual(atSend, [{ ring: false, spool: true }]);
    assert.deepEqual(atRemoval, [true], 'the spool file was removed before the outcome was recorded');
    // Afterwards: remembered, and no longer waiting.
    assert.ok(inRing('order-1'));
    assert.equal(existsSync(join(dir, 'spool', 'order-1.json')), false);
  });

  it('answers a redelivery from the ring after a restart instead of printing it', async () => {
    const dir = scratch();
    const first = new PrintQueue({ dir, send: async () => ok() });
    await first.submit({ job_id: 'receipt-9', source: 'local', printer: printer(), payload: Buffer.from('x') }).settled;

    let sends = 0;
    const second = new PrintQueue({ dir, send: async () => (sends += 1, ok()) });
    second.load();
    const again = second.submit({ job_id: 'receipt-9', source: 'local', printer: printer(), payload: Buffer.from('x') });
    assert.equal(again.deduplicated, true);
    await again.settled;
    assert.equal(sends, 0);
  });
});

describe('a spool that cannot be written', () => {
  /** A FILE where the spool directory should be, which fails on every platform and for root. */
  function brokenSpool(): string {
    const dir = scratch();
    writeFileSync(join(dir, 'spool'), 'not a directory');
    return dir;
  }

  it('refuses a job that must be durable, and queues nothing', () => {
    const dir = brokenSpool();
    let sends = 0;
    const queue = new PrintQueue({ dir, send: async () => (sends += 1, ok()) });
    assert.throws(
      () =>
        queue.submit({
          job_id: 'must-persist', source: 'local', printer: printer(), payload: Buffer.from('x'), requireDurable: true,
        }),
      (err: unknown) => err instanceof SpoolWriteError && /must-persist/.test(err.message),
    );
    assert.equal(queue.pending(), 0);
    assert.equal(queue.get('must-persist'), null);
    assert.equal(sends, 0);
  });

  it('refusing leaves the id free, so the caller can submit it again once the disk is fixed', async () => {
    const dir = brokenSpool();
    const queue = new PrintQueue({ dir, send: async () => ok() });
    assert.throws(() =>
      queue.submit({ job_id: 'retry-me', source: 'local', printer: printer(), payload: Buffer.from('x'), requireDurable: true }),
    );
    // The disk is fixed.
    rmSync(join(dir, 'spool'));
    mkdirSync(join(dir, 'spool'));
    const result = await queue.submit({
      job_id: 'retry-me', source: 'local', printer: printer(), payload: Buffer.from('x'), requireDurable: true,
    }).settled;
    assert.equal(result.status, 'done');
  });

  it('still prints, in memory, when the caller did not ask for durability', async () => {
    const dir = brokenSpool();
    const printed: string[] = [];
    const queue = new PrintQueue({ dir, send: async (_p, b) => (printed.push(b.toString()), ok()) });
    const job = await queue.submit({ job_id: 'relay-1', source: 'relay', printer: printer(), payload: Buffer.from('x') }).settled;
    assert.equal(job.status, 'done');
    assert.deepEqual(printed, ['x']);
    assert.ok(records.some((r) => r.event === 'queue.spool.write_failed'));
  });
});

describe('outcomes owed to the server', () => {
  it('a relay job leaves its outcome in the outbox when it settles', async () => {
    const dir = scratch();
    const queue = new PrintQueue({ dir, send: async () => ok() });
    await queue.submit({ job_id: '4711', source: 'relay', printer: printer(), payload: Buffer.from('x') }).settled;
    const owed = queue.outbox.list();
    assert.deepEqual(owed.map((e) => e.job_id), ['4711']);
    assert.equal(owed[0]?.result.ok, true);
  });

  it('a local job does not: nobody upstream is waiting for it', async () => {
    const queue = new PrintQueue({ dir: scratch(), send: async () => ok() });
    await queue.submit({ job_id: 'local-1', source: 'local', printer: printer(), payload: Buffer.from('x') }).settled;
    assert.deepEqual(queue.outbox.list(), []);
  });

  it('a relay job interrupted mid-print is reported as unknown after the restart', () => {
    const dir = scratch();
    plant(dir, planted('4712', '2026-11-07T10:00:00.000Z', { source: 'relay', status: 'printing', attempts: 1 }));
    const queue = new PrintQueue({ dir, send: async () => ok() });
    queue.load();
    const owed = queue.outbox.list();
    assert.deepEqual(owed.map((e) => e.job_id), ['4712']);
    assert.equal(owed[0]?.result.ok, false);
    assert.equal(owed[0]?.result.printed_certainty, 'unknown');
  });

  it('a relay job recovered from the spool and printed after the restart is reported too', async () => {
    const dir = scratch();
    plant(dir, planted('4713', '2026-11-07T10:00:00.000Z', { source: 'relay' }));
    const queue = new PrintQueue({ dir, send: async () => ok() });
    queue.load();
    await until(() => queue.pending() === 0);
    assert.deepEqual(queue.outbox.list().map((e) => e.job_id), ['4713']);
    assert.equal(queue.outbox.list()[0]?.result.ok, true);
  });

  it('survives the next process: a restarted queue still sees what is owed', async () => {
    const dir = scratch();
    await new PrintQueue({ dir, send: async () => ok() })
      .submit({ job_id: '4714', source: 'relay', printer: printer(), payload: Buffer.from('x') }).settled;
    assert.deepEqual(new PrintQueue({ dir }).outbox.list().map((e) => e.job_id), ['4714']);
  });
});

describe('spool contents', () => {
  it('leaves no temp files behind after a normal run', async () => {
    const dir = scratch();
    const queue = new PrintQueue({ dir, send: async () => ok() });
    await queue.submit({ job_id: 'clean-1', source: 'local', printer: printer(), payload: Buffer.from('x') }).settled;
    assert.deepEqual(readdirSync(join(dir, 'spool')), []);
  });

  it('discards a spool file whose id is not a safe filename', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'spool'), { recursive: true });
    writeFileSync(join(dir, 'spool', 'evil.json'), JSON.stringify({ ...planted('x', '2026-11-07T10:00:00.000Z'), job_id: '../../etc/x' }));
    const queue = new PrintQueue({ dir, send: async () => ok() });
    queue.load();
    assert.equal(queue.pending(), 0);
    assert.equal(existsSync(join(dir, 'spool', 'evil.json')), false);
  });
});

describe('isInUse', () => {
  it('is true while a job waits or prints, and for a while after', async () => {
    const queue = new PrintQueue({ dir: scratch(), send: async () => ok() });
    assert.equal(queue.isInUse(60_000), false, 'a fresh queue has never been used');
    const { settled } = queue.submit({ job_id: 'use-1', source: 'local', printer: printer(), payload: Buffer.from('x') });
    assert.equal(queue.isInUse(1), true, 'a queued job counts however short the window');
    await settled;
    assert.equal(queue.isInUse(60_000), true, 'just finished');
    assert.equal(queue.isInUse(60_000, Date.now() + 61_000), false, 'quiet for longer than the window');
  });
});
