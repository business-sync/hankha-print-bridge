import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import type { PrintOutcome } from './lan.js';
import { setLogSink } from './log.js';
import { PrintQueue } from './queue.js';
import type { PrinterRecord } from './registry.js';

/*
 * Jobs WITHOUT a dedupe key behave exactly as they did before M5.
 *
 * This file uses only what the M1 queue already offered, on purpose: it is run unchanged against
 * the M1 commit (5218ed3) and against this branch, and has to pass on both. M5 changed the queue's
 * identity rules for keyed jobs; this is the proof it changed nothing for the rest.
 */

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'hankha-parity-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let restoreLog: (() => void) | null = null;
beforeEach(() => {
  restoreLog = setLogSink(() => undefined);
});
afterEach(() => restoreLog?.());

const printer = (id = 'counter'): PrinterRecord => ({
  id, name: id, transport: 'network', type: 'receipt', language: 'escpos', enabled: true,
  address: '192.168.1.50', port: 9100, dots_per_line: 576,
});

const ok = (): PrintOutcome => ({ ok: true, duration_ms: 1 });
const refused = (): PrintOutcome => ({
  ok: false, reason: 'connect-refused', printed_certainty: 'none', detail: 'ECONNREFUSED', duration_ms: 1,
});
const unknownOutcome = (): PrintOutcome => ({
  ok: false, reason: 'write-timeout', printed_certainty: 'unknown', detail: 'stalled', duration_ms: 1,
});
const payload = Buffer.from('X');

function counting(outcome: () => PrintOutcome = ok) {
  const state = { sends: 0 };
  return { state, send: async () => ((state.sends += 1), outcome()) };
}

describe('jobs without a dedupe key', () => {
  it('are identified by job_id: a second submit of an active id is the same job', async () => {
    const c = counting();
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    const first = q.submit({ job_id: 'job-1', source: 'relay', printer: printer(), payload });
    const second = q.submit({ job_id: 'job-1', source: 'relay', printer: printer(), payload });
    assert.equal(second.deduplicated, true);
    assert.equal(second.job, first.job);
    await first.settled;
    assert.equal(c.state.sends, 1);
  });

  it('a settled persistent job is remembered whatever happened to it, so a redelivery is answered', async () => {
    const c = counting(refused);
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    // `retryable: false` settles the first failure straight away, as `none` — the case the blanket
    // rule for persistent jobs covers.
    await q.submit({ job_id: 'local-none', source: 'local', printer: printer(), payload, retryable: false }).settled;
    const again = q.submit({ job_id: 'local-none', source: 'local', printer: printer(), payload, retryable: false });
    assert.equal(again.deduplicated, true);
    await again.settled;
    assert.equal(c.state.sends, 1);
  });

  it('a synchronous job that provably did not print stays retryable under its id', async () => {
    const c = counting(refused);
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    const opts = { job_id: 'sync-none', source: 'local' as const, printer: printer(), payload, persistent: false, retryable: false };
    await q.submit(opts).settled;
    const again = q.submit(opts);
    assert.equal(again.deduplicated, false);
    await again.settled;
    assert.equal(c.state.sends, 2);
  });

  it('a relay job that provably did not print is not remembered — the server re-queues it under the same id', async () => {
    const c = counting(refused);
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    const opts = { job_id: 'relay-none', source: 'relay' as const, printer: printer(), payload, retryable: false };
    await q.submit(opts).settled;
    const again = q.submit(opts);
    assert.equal(again.deduplicated, false);
    await again.settled;
    assert.equal(c.state.sends, 2);
  });

  it('a relay job that may have printed is remembered', async () => {
    const c = counting(unknownOutcome);
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    const opts = { job_id: 'relay-unknown', source: 'relay' as const, printer: printer(), payload };
    await q.submit(opts).settled;
    const again = q.submit(opts);
    assert.equal(again.deduplicated, true);
    assert.equal((await again.settled).result?.printed_certainty, 'unknown');
    assert.equal(c.state.sends, 1);
  });

  it('are remembered across a restart, in the old 500-entry ring', async () => {
    const dir = scratch();
    const c = counting();
    const q = new PrintQueue({ dir, send: c.send });
    await q.submit({ job_id: 'survives-restart', source: 'relay', printer: printer(), payload }).settled;
    const reborn = new PrintQueue({ dir, send: c.send });
    reborn.load();
    const again = reborn.submit({ job_id: 'survives-restart', source: 'relay', printer: printer(), payload });
    assert.equal(again.deduplicated, true);
    assert.equal(c.state.sends, 1);
  });

  it('the ring holds 500: older ids are forgotten, recent ones answered', async () => {
    const c = counting();
    const q = new PrintQueue({ dir: scratch(), send: c.send });
    for (let i = 0; i < 510; i += 1) {
      await q.submit({ job_id: `ring-${i}`, source: 'local', printer: printer(), payload, persistent: false }).settled;
    }
    assert.equal(q.submit({ job_id: 'ring-509', source: 'local', printer: printer(), payload, persistent: false }).deduplicated, true);
    assert.equal(q.submit({ job_id: 'ring-10', source: 'local', printer: printer(), payload, persistent: false }).deduplicated, true);
    assert.equal(q.submit({ job_id: 'ring-0', source: 'local', printer: printer(), payload, persistent: false }).deduplicated, false);
  });

  it('get() knows queued and recently settled jobs and nothing else — never the ring', async () => {
    const dir = scratch();
    const c = counting();
    const q = new PrintQueue({ dir, send: c.send });
    await q.submit({ job_id: 'recent', source: 'relay', printer: printer(), payload }).settled;
    assert.equal(q.get('recent')?.status, 'done');
    assert.equal(q.get('never-seen'), null);
    const reborn = new PrintQueue({ dir, send: c.send });
    reborn.load();
    assert.equal(reborn.get('recent'), null, 'in the ring but not in history: unchanged, still not found');
    assert.equal(reborn.cancel('recent'), false);
  });

  it('writes no dedupe-key ring file, and no new kind of file at all', async () => {
    const dir = scratch();
    const q = new PrintQueue({ dir, send: counting().send });
    await q.submit({ job_id: 'plain-1', source: 'relay', printer: printer(), payload }).settled;
    await q.submit({ source: 'local', printer: printer(), payload }).settled;
    assert.ok(!existsSync(join(dir, 'settled-keyed.jsonl')));
    assert.deepEqual(readdirSync(dir).sort().filter((f) => !f.startsWith('.')), ['results', 'settled.jsonl', 'spool']);
  });
});
