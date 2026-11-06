import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { setLogSink } from './log.js';
import { ResultOutbox } from './result-outbox.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-outbox-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  setLogSink(null);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const done = { ok: true, duration_ms: 3 };
const unknown = { ok: false, reason: 'write-timeout', printed_certainty: 'unknown' as const };

describe('ResultOutbox', () => {
  it('keeps an outcome until it is removed', () => {
    const outbox = new ResultOutbox(scratch());
    assert.equal(outbox.save('job-1', done), true);
    assert.deepEqual(
      outbox.list().map((e) => [e.job_id, e.result]),
      [['job-1', done]],
    );
    outbox.remove('job-1');
    assert.deepEqual(outbox.list(), []);
  });

  it('survives a new instance on the same directory — the restart case', () => {
    const dir = scratch();
    new ResultOutbox(dir).save('job-1', unknown);
    const entries = new ResultOutbox(dir).list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.result.printed_certainty, 'unknown');
  });

  it('lists oldest first, so reports reach the server in settle order', async () => {
    const outbox = new ResultOutbox(scratch());
    outbox.save('b-second', done);
    await new Promise((r) => setTimeout(r, 5));
    outbox.save('a-third', done);
    // Saved order, not name order.
    assert.deepEqual(outbox.list().map((e) => e.job_id), ['b-second', 'a-third']);
  });

  it('saving the same job again replaces it rather than adding a second entry', () => {
    const outbox = new ResultOutbox(scratch());
    outbox.save('job-1', unknown);
    outbox.save('job-1', done);
    assert.equal(outbox.count(), 1);
    assert.equal(outbox.list()[0]?.result.ok, true);
  });

  it('discards a torn or foreign file instead of failing the whole list', () => {
    const dir = scratch();
    const outbox = new ResultOutbox(dir);
    outbox.save('good', done);
    mkdirSync(join(dir, 'results'), { recursive: true });
    writeFileSync(join(dir, 'results', 'torn.json'), '{"job_id":"torn","res');
    writeFileSync(join(dir, 'results', 'empty.json'), '');
    writeFileSync(join(dir, 'results', 'wrong.json'), JSON.stringify({ hello: 'world' }));
    assert.deepEqual(outbox.list().map((e) => e.job_id), ['good']);
    assert.deepEqual(readdirSync(join(dir, 'results')), ['good.json']);
  });

  it('refuses an id that cannot be a filename', () => {
    setLogSink(() => {});
    const dir = scratch();
    const outbox = new ResultOutbox(dir);
    assert.equal(outbox.save('../../escape', done), false);
    assert.equal(outbox.save('a/b', done), false);
    assert.deepEqual(outbox.list(), []);
    // And removing one is a no-op, not a throw.
    assert.doesNotThrow(() => outbox.remove('../../escape'));
  });

  it('expires only entries older than the limit', () => {
    setLogSink(() => {});
    const outbox = new ResultOutbox(scratch());
    outbox.save('old', done);
    outbox.save('fresh', done);
    const later = Date.now() + 7 * 3_600_000;
    // Nothing is older than 8h yet.
    assert.equal(outbox.expire(8 * 3_600_000, later), 0);
    // Both are older than 6h at `later`.
    assert.equal(outbox.expire(6 * 3_600_000, later), 2);
    assert.deepEqual(outbox.list(), []);
  });

  it('reports no entries, not an error, before anything was ever saved', () => {
    const outbox = new ResultOutbox(scratch());
    assert.deepEqual(outbox.list(), []);
    assert.equal(outbox.count(), 0);
  });

  it('save reports failure instead of throwing when the directory cannot be created', () => {
    setLogSink(() => {});
    const dir = scratch();
    // A FILE where the results directory should be.
    writeFileSync(join(dir, 'results'), 'not a directory');
    assert.equal(new ResultOutbox(dir).save('job-1', done), false);
  });
});
