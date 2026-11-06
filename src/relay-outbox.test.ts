import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { setLogSink } from './log.js';
import { queue } from './queue.js';
import { resetRegistryCache } from './registry.js';
import { FALLBACK_JOB_TTL_S, handlePrint, jobTtlSeconds, pumpResultOutbox } from './relay.js';

/*
 * What a relay job's deadline is, and that its outcome is never lost on the way to the server.
 *
 * The queue half of "never lost" (an outcome is written down when a job settles, including one
 * recovered after a restart) is in queue-durability.test.ts. This is the relay half: the deadline
 * is always finite, the pump delivers what is owed, and a report that is refused is kept.
 */

const BASE = 'http://relay.test';
const TOKEN = 'outbox-secret';
const DONE = { ok: true, duration_ms: 2 };
const HOUR = 3_600_000;

describe('jobTtlSeconds', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const inSeconds = (s: number) => new Date(now + s * 1000).toISOString();

  it('is the claim less the reserve when the claim is usable', () => {
    assert.equal(jobTtlSeconds(inSeconds(60), now), 50);
    assert.equal(jobTtlSeconds(inSeconds(100), now), 90);
    assert.equal(jobTtlSeconds(inSeconds(12), now), 2);
  });

  it('falls back to a short deadline — never none — when there is no usable claim', () => {
    for (const claim of [undefined, null, '', 'tomorrow-ish', 'NaN', inSeconds(10), inSeconds(3), inSeconds(0), inSeconds(-5), inSeconds(-3600)]) {
      const ttl = jobTtlSeconds(claim, now);
      assert.equal(ttl, FALLBACK_JOB_TTL_S, `claim ${String(claim)}`);
    }
  });

  it('is always a positive whole number of seconds, so a job can never be left without a deadline', () => {
    for (let s = -120; s <= 400; s += 7) {
      const ttl = jobTtlSeconds(inSeconds(s), now);
      assert.ok(Number.isInteger(ttl) && ttl >= 1, `claim in ${s}s gave ${ttl}`);
    }
  });

  it('stays inside the server lease, so the bridge gives up before the sweeper does', () => {
    // The default lease is 60 s; the fallback must leave the reserve free.
    assert.ok(FALLBACK_JOB_TTL_S <= 60 - 10);
  });
});

describe('the outbox pump and handlePrint', () => {
  let stateDir = '';
  const originalState = process.env.PRINT_BRIDGE_STATE_DIR;
  let restoreLog: (() => void) | null = null;
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let statusFor: (url: string) => number = () => 200;
  let fetchStub: { mock: { restore(): void } };

  before(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'hankha-relay-outbox-'));
    process.env.PRINT_BRIDGE_STATE_DIR = stateDir;
    resetRegistryCache();
    fetchStub = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(null, { status: statusFor(url) });
    });
  });

  beforeEach(() => {
    restoreLog = setLogSink(() => {});
    posts.length = 0;
    statusFor = () => 200;
    for (const entry of queue().outbox.list()) queue().outbox.remove(entry.job_id);
  });
  afterEach(() => restoreLog?.());

  after(() => {
    fetchStub.mock.restore();
    if (originalState === undefined) delete process.env.PRINT_BRIDGE_STATE_DIR;
    else process.env.PRINT_BRIDGE_STATE_DIR = originalState;
    resetRegistryCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const urlFor = (id: string) => `${BASE}/api/v1/modules/print/bridge/jobs/${id}/result`;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  async function until(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  }

  describe('pumpResultOutbox', () => {
    it('delivers what is owed, oldest first, and clears it', async () => {
      const box = queue().outbox;
      box.save('a1', DONE);
      box.save('b2', DONE);
      box.save('c3', { ok: false, reason: 'connect-refused', printed_certainty: 'none' });
      const delivered = await pumpResultOutbox(BASE, TOKEN, Date.now() + HOUR);
      assert.equal(delivered, 3);
      assert.deepEqual(posts.map((p) => p.url), [urlFor('a1'), urlFor('b2'), urlFor('c3')]);
      assert.deepEqual(posts[2]?.body, { ok: false, reason: 'connect-refused', printed_certainty: 'none' });
      assert.deepEqual(box.list(), []);
    });

    it('leaves a fresh entry alone: the live report is probably still in flight', async () => {
      queue().outbox.save('fresh', DONE);
      assert.equal(await pumpResultOutbox(BASE, TOKEN, Date.now()), 0);
      assert.deepEqual(posts, []);
      assert.equal(queue().outbox.count(), 1);
    });

    it('gives up on an outcome the server wrote off hours ago, without sending it', async () => {
      queue().outbox.save('ancient', DONE);
      assert.equal(await pumpResultOutbox(BASE, TOKEN, Date.now() + 7 * HOUR), 0);
      assert.deepEqual(posts, []);
      assert.equal(queue().outbox.count(), 0);
    });

    it('treats the server saying "already settled" as delivered', async () => {
      queue().outbox.save('dup', DONE);
      statusFor = () => 409;
      assert.equal(await pumpResultOutbox(BASE, TOKEN, Date.now() + HOUR), 1);
      assert.equal(queue().outbox.count(), 0);
    });

    it('keeps an outcome the server refused, and does not let it hold up the ones behind it', async () => {
      const box = queue().outbox;
      box.save('a-refused', DONE);
      box.save('b-fine', DONE);
      box.save('c-fine', DONE);
      statusFor = (url) => (url === urlFor('a-refused') ? 404 : 200);
      assert.equal(await pumpResultOutbox(BASE, TOKEN, Date.now() + HOUR), 2);
      assert.deepEqual(box.list().map((e) => e.job_id), ['a-refused']);
    });

    it('stops after three failures in a row instead of hammering a server that is refusing everything', async () => {
      for (const id of ['j1', 'j2', 'j3', 'j4', 'j5']) queue().outbox.save(id, DONE);
      statusFor = () => 404;
      assert.equal(await pumpResultOutbox(BASE, TOKEN, Date.now() + HOUR), 0);
      assert.equal(posts.length, 3);
      assert.equal(queue().outbox.count(), 5, 'nothing is thrown away just because the server said no');
    });

    it('does nothing, and says nothing, when nothing is owed', async () => {
      assert.equal(await pumpResultOutbox(BASE, TOKEN, Date.now() + HOUR), 0);
      assert.deepEqual(posts, []);
    });
  });

  describe('a job the bridge refuses', () => {
    type PrintWork = Parameters<typeof handlePrint>[2];
    let n = 0;
    const refusedJob = (): PrintWork => {
      n += 1;
      return {
        type: 'print',
        job: {
          job_id: `refused-${n}`,
          client_job_id: `client-${n}`,
          kind: 'RECEIPT',
          target_ip: null,
          target_port: 9100,
          printer_id: 'no-such-printer',
          payload_base64: Buffer.from('x').toString('base64'),
          payload_sha256: '0'.repeat(64),
          attempt: 1,
          claim_expires_at: '',
        },
      };
    };

    it('is reported, and nothing is left owed once the server has it', async () => {
      const work = refusedJob();
      await handlePrint(BASE, TOKEN, work);
      await until(() => posts.some((p) => p.url === urlFor(work.job.job_id)), 'the report');
      await until(() => queue().outbox.count() === 0, 'the outbox to clear');
      const sent = posts.find((p) => p.url === urlFor(work.job.job_id));
      assert.equal(sent?.body.reason, 'device-missing');
      assert.equal(sent?.body.printed_certainty, 'none');
    });

    it('is KEPT when the server will not take the report, so the answer is not lost with the closure', async () => {
      const work = refusedJob();
      statusFor = () => 404;
      await handlePrint(BASE, TOKEN, work);
      await until(() => posts.some((p) => p.url === urlFor(work.job.job_id)), 'the report');
      await sleep(30);
      const owed = queue().outbox.list();
      assert.deepEqual(owed.map((e) => e.job_id), [work.job.job_id]);
      assert.equal(owed[0]?.result.reason, 'device-missing');
      assert.equal(owed[0]?.result.printed_certainty, 'none');
    });
  });
});
