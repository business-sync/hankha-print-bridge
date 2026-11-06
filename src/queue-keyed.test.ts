import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { KeyedRing, KEYED_FILE, KEYED_HARD_CAP, KEYED_MIN_AGE_MS, KEYED_MIN_ENTRIES } from './keyed-ring.js';
import type { PrintOutcome } from './lan.js';
import { setLogSink } from './log.js';
import { laneKeyOf, PrintQueue, type JobRecord } from './queue.js';
import type { PrinterRecord } from './registry.js';

/*
 * The queue's identity rules for jobs that carry a dedupe key: one job per key across the LAN and
 * the relay, a ring that remembers only what should stop a resend, one lane per address, and a
 * registry printer looked up again at every attempt.
 */

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'hankha-keyed-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let restoreLog: (() => void) | null = null;
beforeEach(() => {
  restoreLog = setLogSink(() => undefined);
});
afterEach(() => restoreLog?.());

const printer = (id = 'receipt', address = '192.168.1.50', extra: Partial<PrinterRecord> = {}): PrinterRecord => ({
  id, name: id, transport: 'network', type: 'receipt', language: 'escpos', enabled: true,
  address, port: 9100, dots_per_line: 576, ...extra,
});

const ok = (): PrintOutcome => ({ ok: true, duration_ms: 1 });
const refused = (): PrintOutcome => ({ ok: false, reason: 'connect-refused', printed_certainty: 'none', detail: 'ECONNREFUSED', duration_ms: 1 });
const stalled = (): PrintOutcome => ({ ok: false, reason: 'write-timeout', printed_certainty: 'unknown', detail: 'stalled', duration_ms: 1 });
const payload = Buffer.from('SLIP');

async function until(ready: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function counting(outcome: () => PrintOutcome = ok) {
  const s = { sends: 0, to: [] as string[] };
  return { s, send: async (p: PrinterRecord) => ((s.sends += 1), s.to.push(`${p.address}`), outcome()) };
}

describe('identity is the dedupe key', () => {
  it('two jobs with one key are one job, whatever their job_ids', async () => {
    const c = counting();
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    const lan = q.submit({ dedupe_key: 'sale-1042-r0', source: 'local', printer: printer(), payload });
    const relay = q.submit({ job_id: 'server-job-77', dedupe_key: 'sale-1042-r0', source: 'relay', printer: printer(), payload });
    assert.equal(relay.deduplicated, true);
    assert.equal(relay.job, lan.job);
    await lan.settled;
    assert.equal(c.s.sends, 1);
  });

  it('LAN first then relay: the relay frame is answered with the first outcome and prints nothing', async () => {
    const c = counting();
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    await q.submit({ dedupe_key: 'sale-1043-r0', source: 'local', printer: printer(), payload }).settled;
    const relay = q.submit({ job_id: 'server-job-78', dedupe_key: 'sale-1043-r0', source: 'relay', printer: printer(), payload });
    assert.equal(relay.deduplicated, true);
    const settled = await relay.settled;
    assert.equal(settled.result?.ok, true, 'the relay reports the first outcome');
    assert.equal(c.s.sends, 1);
  });

  it('relay first then LAN: the LAN send is answered and prints nothing', async () => {
    const c = counting();
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    await q.submit({ job_id: 'server-job-79', dedupe_key: 'sale-1044-r0', source: 'relay', printer: printer(), payload }).settled;
    const lan = q.submit({ dedupe_key: 'sale-1044-r0', source: 'local', printer: printer(), payload });
    assert.equal(lan.deduplicated, true);
    assert.equal(lan.job.job_id, 'server-job-79');
    assert.equal(c.s.sends, 1);
  });

  it('a key and a job_id share one namespace: a bare job_id equal to an active key is the same job', async () => {
    const q = new PrintQueue({ dir: scratch(), send: counting().send });
    const keyed = q.submit({ dedupe_key: 'shared-name-1', source: 'local', printer: printer(), payload });
    const plain = q.submit({ job_id: 'shared-name-1', source: 'relay', printer: printer(), payload });
    assert.equal(plain.deduplicated, true);
    await keyed.settled;
  });

  it('refuses a dedupe key outside the contract charset', () => {
    const q = new PrintQueue({ dir: scratch(), send: counting().send });
    for (const bad of ['short', 'has space here', 'slash/slash/x', 'k'.repeat(129), '../../etc/passwd']) {
      assert.throws(() => q.submit({ dedupe_key: bad, source: 'local', printer: printer(), payload }), /dedupe_key/);
    }
  });

  it('keeps the spool file named by job_id, so a key with a colon never becomes a filename', async () => {
    const dir = scratch();
    const q = new PrintQueue({ dir, send: async () => new Promise<PrintOutcome>(() => undefined) });
    const sub = q.submit({ dedupe_key: 'pos:term-1:8:fire-0042', source: 'local', printer: printer(), payload });
    assert.deepEqual(readdirSync(join(dir, 'spool')), [`${sub.job.job_id}.json`]);
    await q.drain(10);
  });
});

describe('what a keyed job leaves in the ring', () => {
  async function settle(outcome: () => PrintOutcome, extra: Record<string, unknown> = {}) {
    const dir = scratch();
    const c = counting(outcome);
    const q = new PrintQueue({ dir, send: c.send });
    await q.submit({ dedupe_key: 'sale-2000-r0', source: 'local', printer: printer(), payload, retryable: false, ...extra }).settled;
    return { dir, c, q };
  }

  it('remembers ok', async () => {
    const { q, c } = await settle(ok);
    assert.equal(q.isKnown('sale-2000-r0'), true);
    assert.equal(q.submit({ dedupe_key: 'sale-2000-r0', source: 'local', printer: printer(), payload }).deduplicated, true);
    assert.equal(c.s.sends, 1);
  });

  it('remembers unknown: it may be on the paper, so it is never resent by itself', async () => {
    const { q, c } = await settle(stalled);
    assert.equal(q.isKnown('sale-2000-r0'), true);
    const again = q.submit({ dedupe_key: 'sale-2000-r0', source: 'local', printer: printer(), payload });
    assert.equal(again.deduplicated, true);
    assert.equal(again.job.result?.printed_certainty, 'unknown');
    assert.equal(c.s.sends, 1);
  });

  it('remembers cancelled', async () => {
    const q = new PrintQueue({ dir: scratch(), send: async () => new Promise<PrintOutcome>(() => undefined) });
    // Two jobs on one lane: the second waits behind the first, which never finishes.
    q.submit({ dedupe_key: 'head-of-lane-0', source: 'local', printer: printer(), payload });
    q.submit({ dedupe_key: 'sale-2001-r0', source: 'local', printer: printer(), payload });
    assert.equal(q.cancel('sale-2001-r0'), true);
    assert.equal(q.isKnown('sale-2001-r0'), true);
    const again = q.submit({ dedupe_key: 'sale-2001-r0', source: 'local', printer: printer(), payload });
    assert.equal(again.deduplicated, true);
    assert.equal(again.job.result?.reason, 'cancelled');
    await q.drain(10);
  });

  it('does NOT remember a failure that provably printed nothing: the next send must be allowed to try', async () => {
    const { q, c } = await settle(refused);
    assert.equal(q.isKnown('sale-2000-r0'), false);
    const again = q.submit({ dedupe_key: 'sale-2000-r0', source: 'local', printer: printer(), payload, retryable: false });
    assert.equal(again.deduplicated, false);
    await again.settled;
    assert.equal(c.s.sends, 2);
  });

  it('does NOT remember a job that expired before it printed', async () => {
    const dir = scratch();
    const old = new Date(Date.now() - 60_000).toISOString();
    const planted: JobRecord = {
      job_id: 'planted-expired', dedupe_key: 'sale-2002-r0', source: 'local', printer: printer(),
      payload_base64: payload.toString('base64'), bytes: 4, copies: 1, attempts: 0, status: 'queued',
      created_at: old, updated_at: old, expires_at: new Date(Date.now() - 1_000).toISOString(),
      retryable: true, persistent: true, keyed: true,
    };
    mkdirSync(join(dir, 'spool'), { recursive: true });
    writeFileSync(join(dir, 'spool', 'planted-expired.json'), JSON.stringify(planted));
    const c = counting();
    const q = new PrintQueue({ dir, send: c.send });
    q.load();
    await until(() => q.pending() === 0);
    assert.equal(c.s.sends, 0);
    assert.equal(q.get('sale-2002-r0')?.status, 'expired');
    assert.equal(q.isKnown('sale-2002-r0'), false, 'expired is not remembered');
    const again = q.submit({ dedupe_key: 'sale-2002-r0', source: 'local', printer: printer(), payload });
    assert.equal(again.deduplicated, false);
    await again.settled;
    assert.equal(c.s.sends, 1);
  });

  it('survives a restart', async () => {
    const { dir, c } = await settle(ok);
    const reborn = new PrintQueue({ dir, send: c.send });
    reborn.load();
    assert.equal(reborn.isKnown('sale-2000-r0'), true);
    assert.equal(reborn.submit({ dedupe_key: 'sale-2000-r0', source: 'local', printer: printer(), payload }).deduplicated, true);
    assert.equal(c.s.sends, 1);
  });

  it('is read by get() across a restart, which a job without a key never is', async () => {
    const { dir, c } = await settle(ok);
    const reborn = new PrintQueue({ dir, send: c.send });
    reborn.load();
    const found = reborn.get('sale-2000-r0');
    assert.equal(found?.status, 'done');
    assert.equal(found?.dedupe_key, 'sale-2000-r0');
    assert.equal(reborn.get('sale-2999-r0'), null);
  });
});

describe('recovering keyed jobs from the spool', () => {
  const planted = (id: string, key: string, status: 'queued' | 'printing', at: string): JobRecord => ({
    job_id: id, dedupe_key: key, source: 'local', printer: printer(),
    payload_base64: Buffer.from(`body:${key}`).toString('base64'), bytes: 10, copies: 1, attempts: status === 'printing' ? 1 : 0,
    status, created_at: at, updated_at: at, expires_at: null, retryable: true, persistent: true, keyed: true,
  });
  const plant = (dir: string, job: JobRecord) => {
    mkdirSync(join(dir, 'spool'), { recursive: true });
    writeFileSync(join(dir, 'spool', `${job.job_id}.json`), JSON.stringify(job));
  };

  it('resumes a queued job, in order, once', async () => {
    const dir = scratch();
    plant(dir, planted('u2', 'sale-3000-r1', 'queued', '2026-11-07T10:00:01.000Z'));
    plant(dir, planted('u1', 'sale-3000-r0', 'queued', '2026-11-07T10:00:00.000Z'));
    const printed: string[] = [];
    const q = new PrintQueue({ dir, send: async (_p, b) => (printed.push(b.toString()), ok()) });
    q.load();
    await until(() => q.pending() === 0);
    assert.deepEqual(printed, ['body:sale-3000-r0', 'body:sale-3000-r1']);
  });

  it('settles a job found mid-send as unknown, remembers it, and does not send it again', async () => {
    const dir = scratch();
    plant(dir, planted('u3', 'sale-3001-r0', 'printing', '2026-11-07T10:00:00.000Z'));
    const c = counting();
    const q = new PrintQueue({ dir, send: c.send });
    q.load();
    assert.equal(q.get('sale-3001-r0')?.result?.printed_certainty, 'unknown');
    assert.equal(q.submit({ dedupe_key: 'sale-3001-r0', source: 'local', printer: printer(), payload }).deduplicated, true);
    assert.equal(c.s.sends, 0);
  });

  it('discards a spool file whose key is already in the ring — a crash between "recorded" and "removed"', async () => {
    const dir = scratch();
    const first = new PrintQueue({ dir, send: counting().send });
    await first.submit({ dedupe_key: 'sale-3002-r0', source: 'local', printer: printer(), payload }).settled;
    plant(dir, planted('leftover', 'sale-3002-r0', 'queued', '2026-11-07T10:00:00.000Z'));
    const c = counting();
    const q = new PrintQueue({ dir, send: c.send });
    q.load();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(c.s.sends, 0);
    assert.ok(!existsSync(join(dir, 'spool', 'leftover.json')));
  });

  it('purge leaves a keyed job\'s spool file alone while the job is active, and clears the keyed ring only when asked', async () => {
    const dir = scratch();
    const q = new PrintQueue({ dir, send: async () => new Promise<PrintOutcome>(() => undefined) });
    q.submit({ dedupe_key: 'sale-3003-r0', source: 'local', printer: printer(), payload });
    await until(() => q.get('sale-3003-r0')?.status === 'printing');
    const before = readdirSync(join(dir, 'spool'));
    q.purge({ spool: true });
    assert.deepEqual(readdirSync(join(dir, 'spool')), before, 'the file of the job on the wire is the only record of it');
    await q.drain(10);

    const done = new PrintQueue({ dir: scratch(), send: counting().send });
    await done.submit({ dedupe_key: 'sale-3004-r0', source: 'local', printer: printer(), payload }).settled;
    assert.equal(done.cacheSizes().settled.count, 1);
    assert.equal(done.purge({ spool: true, history: true }).settled, 0, 'not implied');
    assert.equal(done.isKnown('sale-3004-r0'), true);
    assert.equal(done.purge({ settled: true }).settled, 1);
    assert.equal(done.isKnown('sale-3004-r0'), false);
  });
});

describe('one lane per address', () => {
  it('two registry ids at one address never write at the same time', async () => {
    let inFlight = 0;
    let peak = 0;
    const q = new PrintQueue({
      dir: scratch(),
      send: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return ok();
      },
    });
    const jobs = [
      q.submit({ dedupe_key: 'kitchen-job-1', source: 'local', printer: printer('kitchen', '192.168.1.60'), payload }),
      q.submit({ dedupe_key: 'bar-job-0001', source: 'local', printer: printer('bar', '192.168.1.60'), payload }),
      q.submit({ dedupe_key: 'kitchen-job-2', source: 'local', printer: printer('kitchen', '192.168.1.60'), payload }),
    ];
    await Promise.all(jobs.map((j) => j.settled));
    assert.equal(peak, 1, 'one shredded slip is what interleaving produces');
  });

  it('different addresses still run side by side', async () => {
    let inFlight = 0;
    let peak = 0;
    const q = new PrintQueue({
      dir: scratch(),
      send: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return ok();
      },
    });
    await Promise.all([
      q.submit({ dedupe_key: 'kitchen-job-3', source: 'local', printer: printer('kitchen', '192.168.1.61'), payload }).settled,
      q.submit({ dedupe_key: 'bar-job-0002', source: 'local', printer: printer('bar', '192.168.1.62'), payload }).settled,
    ]);
    assert.equal(peak, 2);
  });

  it('is by address and port; other transports keep one lane per id', () => {
    assert.equal(laneKeyOf(printer('a', '192.168.1.5')), laneKeyOf(printer('b', '192.168.1.5')));
    assert.notEqual(laneKeyOf(printer('a', '192.168.1.5')), laneKeyOf(printer('a', '192.168.1.5', { port: 9101 })));
    const usb = (id: string): PrinterRecord => ({ ...printer(id), transport: 'usb', address: undefined, queue: 'Q' });
    assert.notEqual(laneKeyOf(usb('u1')), laneKeyOf(usb('u2')));
  });

  it('stays FIFO within the shared lane', async () => {
    const order: string[] = [];
    const q = new PrintQueue({ dir: scratch(), send: async (_p, b) => (order.push(b.toString()), ok()) });
    const jobs = ['one', 'two', 'three'].map((tag, i) =>
      q.submit({ dedupe_key: `fifo-job-000${i}`, source: 'local', printer: printer(i % 2 ? 'bar' : 'kitchen', '192.168.1.63'), payload: Buffer.from(tag) })
    );
    await Promise.all(jobs.map((j) => j.settled));
    assert.deepEqual(order, ['one', 'two', 'three']);
  });
});

describe('a registry printer is looked up again at every attempt', () => {
  function world() {
    const registry = new Map<string, PrinterRecord>([['receipt', printer('receipt', '192.168.1.50')]]);
    const seen: string[] = [];
    let outcome: () => PrintOutcome = refused;
    const q = new PrintQueue({
      dir: scratch(),
      resolvePrinter: (id) => registry.get(id) ?? null,
      send: async (p) => (seen.push(`${p.address}`), outcome()),
    });
    return { registry, seen, q, setOutcome: (o: () => PrintOutcome) => (outcome = o) };
  }

  const submit = (w: ReturnType<typeof world>, key: string, extra: Record<string, unknown> = {}) =>
    w.q.submit({
      dedupe_key: key, source: 'local', printer: w.registry.get('receipt') as PrinterRecord, payload,
      registry_id: true, ttl_s: 30, ...extra,
    });

  it('re-pointing the IP while a job waits sends it to the new address', async () => {
    const w = world();
    const sub = submit(w, 'sale-4000-r0');
    await until(() => w.seen.length >= 1);
    assert.deepEqual(w.seen, ['192.168.1.50']);
    w.registry.set('receipt', printer('receipt', '192.168.1.99'));
    w.setOutcome(ok);
    await sub.settled;
    assert.equal(w.seen.at(-1), '192.168.1.99', 'the retry went to the new address');
    assert.equal(sub.job.printer.address, '192.168.1.99');
  });

  it('turning the printer off fails the job with nothing sent, and the key may be resent', async () => {
    const w = world();
    const sub = submit(w, 'sale-4001-r0');
    await until(() => w.seen.length >= 1);
    w.registry.set('receipt', printer('receipt', '192.168.1.50', { enabled: false }));
    const settled = await sub.settled;
    assert.equal(settled.status, 'failed');
    assert.equal(settled.result?.reason, 'device-missing');
    assert.equal(settled.result?.printed_certainty, 'none');
    assert.match(settled.result?.detail ?? '', /disabled/);
    assert.equal(w.seen.length, 1, 'nothing more was sent');
    assert.equal(w.q.isKnown('sale-4001-r0'), false);
  });

  it('removing the printer fails the job the same way', async () => {
    const w = world();
    const sub = submit(w, 'sale-4002-r0');
    await until(() => w.seen.length >= 1);
    w.registry.delete('receipt');
    const settled = await sub.settled;
    assert.equal(settled.result?.reason, 'device-missing');
    assert.match(settled.result?.detail ?? '', /no longer in this bridge's registry/);
  });

  it('a printer that now has a different width does not get a slip laid out for the old one', async () => {
    const w = world();
    const sub = submit(w, 'sale-4003-r0', { rendered_dots: 576 });
    await until(() => w.seen.length >= 1);
    w.registry.set('receipt', printer('receipt', '192.168.1.50', { dots_per_line: 384 }));
    const settled = await sub.settled;
    assert.equal(settled.result?.printed_certainty, 'none');
    assert.match(settled.result?.detail ?? '', /384.*576/);
    assert.equal(w.seen.length, 1);
  });

  it('the job moves to the new address\'s lane, so it cannot overlap a job already there', async () => {
    const w = world();
    w.registry.set('bar', printer('bar', '192.168.1.99'));
    const inFlightAt = new Map<string, number>();
    let peakAt99 = 0;
    const events: string[] = [];
    const q = new PrintQueue({
      dir: scratch(),
      resolvePrinter: (id) => w.registry.get(id) ?? null,
      send: async (p, b) => {
        const at = `${p.address}`;
        inFlightAt.set(at, (inFlightAt.get(at) ?? 0) + 1);
        if (at === '192.168.1.99') peakAt99 = Math.max(peakAt99, inFlightAt.get(at) ?? 0);
        events.push(`${at}:${b.toString()}`);
        // Bar's slip takes long enough that R's retry (after at least 500 ms of backoff) wakes while it is on the wire.
        await new Promise((r) => setTimeout(r, b.toString() === 'B' ? 1_500 : 40));
        inFlightAt.set(at, (inFlightAt.get(at) ?? 1) - 1);
        return at === '192.168.1.50' ? refused() : ok();
      },
    });
    // 'receipt' fails at .50 and retries; meanwhile it is re-pointed at .99, where 'bar' is printing.
    q.submit({ dedupe_key: 'receipt-job-01', source: 'local', printer: w.registry.get('receipt') as PrinterRecord, payload: Buffer.from('R'), registry_id: true, ttl_s: 30 });
    await until(() => events.length >= 1);
    w.registry.set('receipt', printer('receipt', '192.168.1.99'));
    const bar = q.submit({ dedupe_key: 'bar-job-00001', source: 'local', printer: w.registry.get('bar') as PrinterRecord, payload: Buffer.from('B'), registry_id: true, ttl_s: 30 });
    await bar.settled;
    await until(() => q.pending() === 0, 6000);
    assert.equal(peakAt99, 1, 'never two at once at .99');
    assert.deepEqual(events.filter((e) => e.startsWith('192.168.1.99')), ['192.168.1.99:B', '192.168.1.99:R'], 'R waited its turn behind B');
  });

  it('a job that is not a registry job keeps the snapshot it was addressed with', async () => {
    const w = world();
    const sub = w.q.submit({ dedupe_key: 'sale-4005-r0', source: 'relay', printer: w.registry.get('receipt') as PrinterRecord, payload, ttl_s: 30 });
    await until(() => w.seen.length >= 1);
    w.registry.set('receipt', printer('receipt', '192.168.1.99'));
    w.setOutcome(ok);
    await sub.settled;
    assert.equal(w.seen.at(-1), '192.168.1.50');
  });
});

describe('the printer probe is independent of a lane that is merely waiting', () => {
  it('is blocked while bytes are on the wire, and free while the lane sleeps between retries', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => (release = r));
    let phase: 'hold' | 'refuse' | 'ok' = 'hold';
    const q = new PrintQueue({
      dir: scratch(),
      send: async () => {
        if (phase === 'hold') {
          await hold;
          phase = 'refuse';
          return refused();
        }
        return phase === 'refuse' ? refused() : ok();
      },
    });
    q.submit({ dedupe_key: 'probe-job-0001', source: 'local', printer: printer(), payload, ttl_s: 30 });
    await until(() => q.get('probe-job-0001')?.status === 'printing');
    assert.equal(q.isProbeBlocked('receipt'), true, 'sending');
    release();
    await until(() => q.get('probe-job-0001')?.status === 'queued');
    await until(() => q.isProbeBlocked('receipt') === false, 2000);
    assert.equal(q.isBusy('receipt'), true, 'the lane still holds the job');
    assert.equal(q.isProbeBlocked('receipt'), false, 'but the printer is not being written to, so its state may be probed');
    phase = 'ok';
    await until(() => q.pending() === 0, 6000);
    assert.equal(q.isProbeBlocked('receipt'), false);
  });
});

describe('the dedupe-key ring keeps what an outage needs', () => {
  const result = { ok: true, duration_ms: 1 };
  const entry = (n: number, at: number) => ({
    key: `ring-key-${String(n).padStart(6, '0')}`, job_id: `j${n}`, result, accepted_at: new Date(at).toISOString(),
    settled_at: new Date(at).toISOString(), printer_id: 'receipt',
  });

  it('is sized for 72 hours and 5,000 entries', () => {
    assert.equal(KEYED_MIN_ENTRIES, 5_000);
    assert.equal(KEYED_MIN_AGE_MS, 72 * 3_600_000);
    assert.ok(KEYED_HARD_CAP >= KEYED_MIN_ENTRIES * 2);
  });

  it('never drops an entry younger than the minimum age, however many there are', () => {
    let now = 1_000_000;
    const ring = new KeyedRing(scratch(), { minEntries: 3, minAgeMs: 1_000, hardCap: 50, now: () => now });
    for (let i = 0; i < 20; i += 1) ring.add(entry(i, now));
    assert.equal(ring.size, 20, 'twenty young entries, none evicted although the minimum count is 3');
  });

  it('never drops below the minimum count, however old they are', () => {
    let now = 1_000_000;
    const ring = new KeyedRing(scratch(), { minEntries: 3, minAgeMs: 1_000, hardCap: 50, now: () => now });
    for (let i = 0; i < 3; i += 1) ring.add(entry(i, now));
    now += 10_000_000;
    ring.add(entry(99, now));
    assert.equal(ring.size, 3, 'the oldest went to make room, but never below three');
    assert.equal(ring.has('ring-key-000000'), false);
    assert.equal(ring.has('ring-key-000099'), true);
  });

  it('drops the oldest only when both limits are passed, oldest first', () => {
    let now = 1_000_000;
    const ring = new KeyedRing(scratch(), { minEntries: 3, minAgeMs: 1_000, hardCap: 50, now: () => now });
    for (let i = 0; i < 6; i += 1) {
      ring.add(entry(i, now));
      now += 400; // entries 0,1 will be older than 1s by the time 5 lands
    }
    // Entry 0 is 2000ms old, 1 is 1600, 2 is 1200, 3 is 800: the first three are over-age and over-count.
    assert.deepEqual(['0', '1', '2', '3', '4', '5'].map((i) => ring.has(`ring-key-00000${i}`)), [false, false, false, true, true, true]);
  });

  it('the hard cap holds regardless of age', () => {
    const ring = new KeyedRing(scratch(), { minEntries: 3, minAgeMs: 10_000_000, hardCap: 10, now: () => 1_000_000 });
    for (let i = 0; i < 25; i += 1) ring.add(entry(i, 1_000_000));
    assert.equal(ring.size, 10);
    assert.equal(ring.has('ring-key-000024'), true);
  });

  it('reads back after a restart, applying the same limits', () => {
    const dir = scratch();
    let now = 1_000_000;
    const a = new KeyedRing(dir, { minEntries: 2, minAgeMs: 1_000, hardCap: 50, now: () => now });
    for (let i = 0; i < 5; i += 1) a.add(entry(i, now));
    now += 5_000;
    const b = new KeyedRing(dir, { minEntries: 2, minAgeMs: 1_000, hardCap: 50, now: () => now });
    b.load();
    assert.equal(b.size, 2, 'trimmed to the minimum on load, since all five are old');
    const young = new KeyedRing(dir, { minEntries: 2, minAgeMs: 1_000, hardCap: 50, now: () => 1_000_500 });
    young.load();
    assert.equal(young.size, 5, 'but all kept while they are young');
  });

  it('skips a bad line without losing the rest, and rewrites the file instead of growing it forever', () => {
    const dir = scratch();
    const ring = new KeyedRing(dir, { minEntries: 2, minAgeMs: 0, hardCap: 4, now: () => 5_000_000 });
    for (let i = 0; i < 3_000; i += 1) ring.add(entry(i, 1_000));
    const lines = readFileSync(join(dir, KEYED_FILE), 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length < 2_100, `compacted, got ${lines.length} lines`);
    writeFileSync(join(dir, KEYED_FILE), `${readFileSync(join(dir, KEYED_FILE), 'utf8')}{torn line\n`);
    const again = new KeyedRing(dir, { minEntries: 2, minAgeMs: 0, hardCap: 4, now: () => 5_000_000 });
    again.load();
    assert.equal(again.size, 2);
  });
});
