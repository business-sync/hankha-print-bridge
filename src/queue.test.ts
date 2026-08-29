import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { PrintOutcome } from './lan.js';
import { PrintQueue, type JobRecord } from './queue.js';
import type { PrinterRecord } from './registry.js';

/*
 * The queue is where a bug costs paper and money, so these tests pin the two directions that
 * matter: a job that provably did not print gets retried, and a job that MIGHT have printed never
 * does. Everything else here exists to stop those two from regressing by accident.
 */

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-queue-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function printer(id: string): PrinterRecord {
  return {
    id, name: id, transport: 'network', type: 'receipt', language: 'escpos',
    enabled: true, address: '192.168.1.50', port: 9100, dots_per_line: 576,
  };
}

const ok = (): PrintOutcome => ({ ok: true, duration_ms: 1 });
const refused = (): PrintOutcome => ({
  ok: false, reason: 'connect-refused', printed_certainty: 'none', detail: 'ECONNREFUSED', duration_ms: 1,
});
const stalled = (): PrintOutcome => ({
  ok: false, reason: 'write-timeout', printed_certainty: 'unknown', detail: 'stalled after connect', duration_ms: 1,
});

const payload = Buffer.from('\x1b@HELLO\n');

describe('ordering', () => {
  it('prints one printer strictly in order, never overlapping', async () => {
    const events: string[] = [];
    let inFlight = 0;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async (p, bytes) => {
        inFlight += 1;
        // The reason the lane is sequential at all: two writes to one device shred the output.
        assert.equal(inFlight, 1, 'two sends overlapped on one printer');
        events.push(bytes.toString());
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return ok();
      },
    });

    const jobs = ['a', 'b', 'c'].map((tag) =>
      queue.submit({ source: 'local', printer: printer('counter'), payload: Buffer.from(tag) }).settled
    );
    await Promise.all(jobs);
    assert.deepEqual(events, ['a', 'b', 'c']);
  });

  it('runs different printers at the same time', async () => {
    let peak = 0;
    let inFlight = 0;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return ok();
      },
    });

    await Promise.all([
      queue.submit({ source: 'local', printer: printer('counter'), payload }).settled,
      queue.submit({ source: 'local', printer: printer('kitchen'), payload }).settled,
    ]);
    // A dead printer must never be able to hold up a working one.
    assert.equal(peak, 2);
  });
});

describe('retry safety', () => {
  it('retries a job that provably did not print', async () => {
    let calls = 0;
    const queue = new PrintQueue({
      dir: scratch(), maxAttempts: 3,
      send: async () => (++calls < 3 ? refused() : ok()),
    });

    const { settled } = queue.submit({ source: 'local', printer: printer('counter'), payload });
    const job = await settled;
    assert.equal(job.status, 'done');
    assert.equal(calls, 3);
    assert.equal(job.attempts, 3);
  });

  it('NEVER retries a job that might have printed', async () => {
    let calls = 0;
    const queue = new PrintQueue({
      dir: scratch(), maxAttempts: 5,
      send: async () => {
        calls += 1;
        return stalled();
      },
    });

    const job = await queue.submit({ source: 'local', printer: printer('counter'), payload }).settled;
    assert.equal(job.status, 'failed');
    assert.equal(job.result?.printed_certainty, 'unknown');
    // The whole point: one attempt, because a second one hands the customer two receipts.
    assert.equal(calls, 1);
  });

  it('keeps retrying past maxAttempts while the job still has a deadline', async () => {
    let calls = 0;
    const queue = new PrintQueue({
      dir: scratch(), maxAttempts: 2,
      // Fails while the printer is "rebooting", then comes back. maxAttempts alone would have
      // given up after about three seconds of backoff — shorter than a printer takes to boot.
      send: async () => (++calls < 4 ? refused() : ok()),
    });

    const job = await queue.submit({ source: 'relay', printer: printer('counter'), payload, ttl_s: 60 }).settled;
    assert.equal(job.status, 'done');
    assert.equal(calls, 4);
  });

  it('gives up after maxAttempts even when every failure was safe', async () => {
    let calls = 0;
    const queue = new PrintQueue({
      dir: scratch(), maxAttempts: 2,
      send: async () => {
        calls += 1;
        return refused();
      },
    });

    const job = await queue.submit({ source: 'local', printer: printer('counter'), payload }).settled;
    assert.equal(job.status, 'failed');
    assert.equal(calls, 2);
    assert.equal(job.result?.printed_certainty, 'none');
  });

  it('treats a failure after an earlier copy printed as unknown, not safe', async () => {
    let calls = 0;
    const queue = new PrintQueue({
      dir: scratch(), maxAttempts: 5,
      // The first copy lands; the second is refused. The transport calls that 'none', but a
      // reprint would still duplicate copy one.
      send: async () => (++calls === 1 ? ok() : refused()),
    });

    const job = await queue.submit({ source: 'local', printer: printer('counter'), payload, copies: 2 }).settled;
    assert.equal(job.status, 'failed');
    assert.equal(job.result?.printed_certainty, 'unknown');
    assert.equal(calls, 2, 'must not retry once a copy has printed');
  });

  it('honours retryable: false, which is what the synchronous /print route submits', async () => {
    let calls = 0;
    const queue = new PrintQueue({
      dir: scratch(), maxAttempts: 5,
      send: async () => {
        calls += 1;
        return refused();
      },
    });

    const job = await queue.submit({
      source: 'local', printer: printer('counter'), payload, persistent: false, retryable: false,
    }).settled;
    assert.equal(job.status, 'failed');
    assert.equal(calls, 1);
  });
});

describe('expiry', () => {
  it('drops a job whose deadline passes while it waits in the lane', async () => {
    const printed: string[] = [];
    let release: (() => void) | null = null;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async (_p, bytes) => {
        if (bytes.toString() === 'slow') await new Promise<void>((r) => { release = r; });
        printed.push(bytes.toString());
        return ok();
      },
    });

    // A receipt the server gave one second to live is wrong by the time the printer ahead of it
    // frees up: the till has moved on, and the paper it would produce is a lie.
    const slow = queue.submit({ source: 'relay', printer: printer('counter'), payload: Buffer.from('slow') });
    const doomed = queue.submit({ source: 'relay', printer: printer('counter'), payload: Buffer.from('doomed'), ttl_s: 1 });

    await new Promise((r) => setTimeout(r, 1100));
    release?.();

    const job = await doomed.settled;
    await slow.settled;

    assert.equal(job.status, 'expired');
    assert.equal(job.result?.printed_certainty, 'none');
    assert.deepEqual(printed, ['slow']);
  });

  it('drops a stale backlog recovered from disk rather than printing an hour late', async () => {
    const dir = scratch();
    const spool = join(dir, 'spool');
    mkdirSync(spool, { recursive: true });

    const stale: JobRecord = {
      job_id: 'stale', source: 'relay', printer: printer('counter'),
      payload_base64: payload.toString('base64'), bytes: payload.length, copies: 1, attempts: 0,
      status: 'queued', created_at: new Date(Date.now() - 3_600_000).toISOString(),
      updated_at: new Date(Date.now() - 3_600_000).toISOString(),
      expires_at: new Date(Date.now() - 3_500_000).toISOString(),
      retryable: true, persistent: true,
    };
    writeFileSync(join(spool, 'stale.json'), JSON.stringify(stale));

    let printed = 0;
    const queue = new PrintQueue({ dir, send: async () => { printed += 1; return ok(); } });
    queue.load();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(printed, 0);
    assert.equal(queue.get('stale')?.status, 'expired');
  });
});

describe('idempotency', () => {
  it('answers a duplicate job_id without printing again, in the same process', async () => {
    let calls = 0;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        calls += 1;
        return ok();
      },
    });

    await queue.submit({ job_id: 'job-1', source: 'relay', printer: printer('counter'), payload }).settled;
    const second = queue.submit({ job_id: 'job-1', source: 'relay', printer: printer('counter'), payload });
    const job = await second.settled;

    assert.equal(second.deduplicated, true);
    assert.equal(job.status, 'done');
    assert.equal(calls, 1);
  });

  it('remembers settled jobs across a restart', async () => {
    const dir = scratch();
    let calls = 0;
    const send = async () => {
      calls += 1;
      return ok();
    };

    const first = new PrintQueue({ dir, send });
    first.load();
    await first.submit({ job_id: 'job-2', source: 'relay', printer: printer('counter'), payload }).settled;

    // The server redelivers because our result POST never arrived. A fresh process must answer it
    // from the on-disk ring rather than print a second copy.
    const second = new PrintQueue({ dir, send });
    second.load();
    const replay = second.submit({ job_id: 'job-2', source: 'relay', printer: printer('counter'), payload });
    const job = await replay.settled;

    assert.equal(replay.deduplicated, true);
    assert.equal(job.status, 'done');
    assert.equal(calls, 1);
  });
});

describe('durability', () => {
  it('is safe to load twice', async () => {
    const dir = scratch();
    const spool = join(dir, 'spool');
    mkdirSync(spool, { recursive: true });

    const pending: JobRecord = {
      job_id: 'once-only', source: 'relay', printer: printer('counter'),
      payload_base64: payload.toString('base64'), bytes: payload.length, copies: 1, attempts: 0,
      status: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      expires_at: null, retryable: true, persistent: true,
    };
    writeFileSync(join(spool, 'once-only.json'), JSON.stringify(pending));

    let printed = 0;
    const queue = new PrintQueue({ dir, send: async () => { printed += 1; return ok(); } });
    // A second load re-reads the spool while the first one's jobs are in flight: it pushes a
    // queued job into the lane twice (printing it twice) and settles an in-flight one as failed.
    queue.load();
    queue.load();
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(printed, 1);
    assert.equal(queue.get('once-only')?.status, 'done');
  });

  it('resumes a queued job left on disk by a crash', async () => {
    const dir = scratch();
    const spool = join(dir, 'spool');
    mkdirSync(spool, { recursive: true });

    const stranded: JobRecord = {
      job_id: 'stranded', source: 'relay', printer: printer('counter'),
      payload_base64: payload.toString('base64'), bytes: payload.length, copies: 1, attempts: 0,
      status: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      expires_at: null, retryable: true, persistent: true,
    };
    writeFileSync(join(spool, 'stranded.json'), JSON.stringify(stranded));

    let printed = 0;
    const queue = new PrintQueue({
      dir,
      send: async () => {
        printed += 1;
        return ok();
      },
    });
    queue.load();

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(printed, 1);
    assert.equal(queue.get('stranded')?.status, 'done');
    // The spool file is removed once the job settles, or the next restart prints it again.
    assert.equal(readdirSync(spool).filter((f) => f.endsWith('.json')).length, 0);
  });

  it('settles a job interrupted mid-print as unknown rather than reprinting it', async () => {
    const dir = scratch();
    const spool = join(dir, 'spool');
    mkdirSync(spool, { recursive: true });

    const interrupted: JobRecord = {
      job_id: 'interrupted', source: 'relay', printer: printer('counter'),
      payload_base64: payload.toString('base64'), bytes: payload.length, copies: 1, attempts: 1,
      // The process was killed while these bytes were on the wire. They may be on the paper.
      status: 'printing', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      expires_at: null, retryable: true, persistent: true,
    };
    writeFileSync(join(spool, 'interrupted.json'), JSON.stringify(interrupted));

    let printed = 0;
    const queue = new PrintQueue({
      dir,
      send: async () => {
        printed += 1;
        return ok();
      },
    });
    queue.load();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(printed, 0);
    const job = queue.get('interrupted');
    assert.equal(job?.status, 'failed');
    assert.equal(job?.result?.printed_certainty, 'unknown');
  });

  it('discards a torn spool file without taking the queue down', async () => {
    const dir = scratch();
    const spool = join(dir, 'spool');
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(spool, 'torn.json'), '{"job_id":"torn","payl');

    const queue = new PrintQueue({ dir, send: async () => ok() });
    queue.load();
    assert.equal(queue.pending(), 0);
    assert.equal(readdirSync(spool).length, 0);
  });

  it('keeps no payload in the history ring', async () => {
    const queue = new PrintQueue({ dir: scratch(), send: async () => ok() });
    const big = Buffer.alloc(64 * 1024, 0x41);
    const job = await queue.submit({ source: 'local', printer: printer('counter'), payload: big }).settled;
    assert.equal(job.bytes, big.length);
    // Settled jobs are kept for /status; keeping their bytes would be 200 x 1 MiB of dead base64.
    assert.equal(queue.get(job.job_id)?.payload_base64, '');
  });
});

describe('cancellation', () => {
  it('cancels a waiting job, and refuses once it is printing', async () => {
    let release: (() => void) | null = null;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return ok();
      },
    });

    const first = queue.submit({ source: 'local', printer: printer('counter'), payload });
    const second = queue.submit({ source: 'local', printer: printer('counter'), payload });
    await new Promise((r) => setTimeout(r, 20));

    // The head of the lane is on the wire — the answer has to be "no", because /print relies on it
    // to decide whether a timeout may honestly claim nothing printed.
    assert.equal(queue.cancel(first.job.job_id), false);
    assert.equal(queue.cancel(second.job.job_id), true);

    const cancelled = await second.settled;
    assert.equal(cancelled.result?.reason, 'cancelled');
    assert.equal(cancelled.result?.printed_certainty, 'none');

    release?.();
    await first.settled;
  });
});


describe('idempotency for the synchronous /print path', () => {
  /*
   * A synchronous job is not spooled — the client holds a socket open and owns its own retry
   * policy — but if that client NAMED the job, a repeat of it must still replay rather than
   * print a second bill. Before `keyed`, the settled ring skipped every non-persistent job, so
   * `/print` could not dedupe at all no matter what id it was given.
   */
  const sync = (job_id?: string) => ({
    source: 'local' as const,
    printer: printer('counter'),
    payload,
    persistent: false,
    retryable: false,
    ...(job_id ? { job_id } : {}),
  });

  it('replays a keyed job that succeeded, without printing it again', async () => {
    let sends = 0;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        sends += 1;
        return ok();
      },
    });

    await queue.submit(sync('slip-1')).settled;
    assert.equal(sends, 1);

    const again = queue.submit(sync('slip-1'));
    assert.equal(again.deduplicated, true);
    await again.settled;
    assert.equal(sends, 1, 'a replayed keyed job must not reach the printer twice');
  });

  /*
   * The counterpart, and the more consequential of the two. `printed_certainty: 'none'` means
   * the socket never opened, so nothing printed and the operator's Retry has to be able to
   * actually try. Remembering this outcome would replay the failure forever — a printer
   * switched back on ten seconds later could never be reached again under that id.
   */
  it('lets a keyed job that provably did not print be retried for real', async () => {
    let sends = 0;
    let failing = true;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        sends += 1;
        return failing ? refused() : ok();
      },
    });

    await queue.submit(sync('slip-2')).settled;
    const afterFailure = sends;

    failing = false;
    const retry = queue.submit(sync('slip-2'));
    assert.equal(retry.deduplicated, false, 'a provably-failed sync job must stay retryable');
    await retry.settled;
    assert.ok(sends > afterFailure, 'the retry must actually reach the printer');
  });

  /*
   * `unknown` is the case that costs money: we were connected when it went wrong, so paper may
   * already have come out. This one must never be silently tried again.
   */
  it('remembers a keyed job whose outcome was ambiguous', async () => {
    let sends = 0;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        sends += 1;
        return stalled();
      },
    });

    await queue.submit(sync('slip-3')).settled;
    const after = sends;

    const retry = queue.submit(sync('slip-3'));
    assert.equal(retry.deduplicated, true, 'paper may have come out — replay, never reprint');
    await retry.settled;
    assert.equal(sends, after);
  });

  it('does not fill the ring with ids it minted itself', async () => {
    const queue = new PrintQueue({ dir: scratch(), send: async () => ok() });
    const first = queue.submit(sync());
    await first.settled;
    const second = queue.submit(sync());
    assert.equal(second.deduplicated, false);
    assert.notEqual(first.job.job_id, second.job.job_id);
  });

  /*
   * The relay's jobs are persistent, and their retries belong to the server's state machine.
   * A redelivery must never reprint one behind its back, so the blanket rule still applies
   * there even for a provably-failed job.
   */
  it('still remembers every settled PERSISTENT job, failures included', async () => {
    let sends = 0;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        sends += 1;
        return refused();
      },
    });

    await queue.submit({ source: 'relay', printer: printer('counter'), payload, job_id: 'relay-1' }).settled;
    const after = sends;

    const again = queue.submit({ source: 'relay', printer: printer('counter'), payload, job_id: 'relay-1' });
    assert.equal(again.deduplicated, true);
    await again.settled;
    assert.equal(sends, after);
  });
});
