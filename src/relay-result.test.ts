import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';
import { markRelayShutdown, reportResult } from './relay.js';

/*
 * Reporting a job's outcome used to be one POST, and a failed one was the end of it: the server's
 * sweeper then wrote UNKNOWN over a job this bridge knew the truth about, the POS showed the ticket
 * as unconfirmed, and an operator pressing reprint on a receipt that had in fact come out is the
 * duplicate this whole module exists to prevent. These pin what is retried, what is final, and
 * that a stopping process does not sit in a retry pause.
 *
 * Own file: `markRelayShutdown` is one-way for the process, so its test must run last.
 */
const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const since = (from: number, name: string) => records.slice(from).filter((r) => r.event === name);

const BASE = 'http://relay.test';
const TOKEN = 'result-secret';
const RESULT = { ok: true, duration_ms: 12 };
/** Retry pauses shortened to nothing: the schedule is pinned elsewhere, the sequence here. */
const NO_WAIT = () => 5;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Answer = number | Error;
/** A fake API that answers each POST with the next status, repeating the last one for ever. */
function fakeApi(...answers: Answer[]) {
  const calls: { url: string; body: string; auth: string }[] = [];
  const stub = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), body: String(init?.body), auth: headers.Authorization ?? '' });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(null, { status: next ?? 200 });
  });
  return { calls, restore: () => stub.mock.restore() };
}
const networkError = () =>
  Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }) });

describe('reporting a result', () => {
  it('retries a 5xx and delivers once: one result, one line', async () => {
    const api = fakeApi(503, 200);
    const from = records.length;
    try {
      assert.equal(await reportResult(BASE, TOKEN, 'job-1', RESULT, NO_WAIT), true);
      assert.equal(api.calls.length, 2);
      assert.equal(api.calls[0]?.url, `${BASE}/api/v1/modules/print/bridge/jobs/job-1/result`);
      assert.equal(api.calls[1]?.body, api.calls[0]?.body, 'the same report, sent again');
      assert.deepEqual(JSON.parse(api.calls[1]?.body ?? ''), RESULT);
      const retry = since(from, 'relay.result.retry');
      assert.equal(retry.length, 1);
      assert.equal(retry[0]?.level, 'warn');
      assert.equal(retry[0]?.fields.status, 503);
      assert.equal(retry[0]?.fields.attempt, 1);
      assert.equal(since(from, 'relay.result.failed').length, 0, 'a report that got through is not a failure');
      assert.equal(since(from, 'relay.result.reported').length, 1);
    } finally {
      api.restore();
    }
  });

  it('retries a network error', async () => {
    const api = fakeApi(networkError(), 200);
    const from = records.length;
    try {
      assert.equal(await reportResult(BASE, TOKEN, 'job-2', RESULT, NO_WAIT), true);
      assert.equal(api.calls.length, 2);
      const retry = since(from, 'relay.result.retry');
      assert.equal(retry.length, 1);
      assert.equal(retry[0]?.fields.error_message, 'fetch failed');
      assert.equal(since(from, 'relay.result.failed').length, 0);
    } finally {
      api.restore();
    }
  });

  it('gives up after four attempts, with the existing line', async () => {
    const api = fakeApi(500);
    const from = records.length;
    try {
      assert.equal(await reportResult(BASE, TOKEN, 'job-3', RESULT, NO_WAIT), false);
      assert.equal(api.calls.length, 4, 'one attempt and three retries');
      const failed = since(from, 'relay.result.failed');
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.level, 'warn');
      assert.match(failed[0]?.msg ?? '', /could not report job job-3 \(HTTP 500\) after 4 attempts/);
      assert.equal(failed[0]?.fields.attempts, 4);
      assert.equal(failed[0]?.fields.status, 500);
      assert.ok(since(from, 'relay.result.retry').length >= 1, 'the retries were narrated');
      assert.equal(since(from, 'relay.result.reported').length, 0);
    } finally {
      api.restore();
    }
  });

  it('takes a 409 on a retry as success: the server already has the outcome', async () => {
    const api = fakeApi(502, 409);
    const from = records.length;
    try {
      assert.equal(await reportResult(BASE, TOKEN, 'job-4', RESULT, NO_WAIT), true);
      assert.equal(api.calls.length, 2);
      assert.equal(since(from, 'relay.result.failed').length, 0);
    } finally {
      api.restore();
    }
  });

  it('does not retry a 4xx the server has decided on', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const api = fakeApi(status);
      const from = records.length;
      try {
        assert.equal(await reportResult(BASE, TOKEN, `job-${status}`, RESULT, NO_WAIT), false);
        assert.equal(api.calls.length, 1, `HTTP ${status} is final`);
        const failed = since(from, 'relay.result.failed');
        assert.equal(failed.length, 1);
        assert.equal(failed[0]?.fields.attempts, 1);
        assert.equal(failed[0]?.fields.status, status);
      } finally {
        api.restore();
      }
    }
  });

  it('retries 408 and 429, the two 4xx that mean "not now"', async () => {
    for (const status of [408, 429]) {
      const api = fakeApi(status, 200);
      try {
        assert.equal(await reportResult(BASE, TOKEN, `job-${status}`, RESULT, NO_WAIT), true);
        assert.equal(api.calls.length, 2, `HTTP ${status} is retried`);
      } finally {
        api.restore();
      }
    }
  });

  it('sends the token only in the Authorization header, and never logs it', async () => {
    const api = fakeApi(503, 200);
    try {
      await reportResult(BASE, TOKEN, 'job-5', RESULT, NO_WAIT);
      for (const call of api.calls) {
        assert.equal(call.auth, `Bearer ${TOKEN}`);
        assert.equal(call.url.includes(TOKEN), false);
      }
      assert.equal(JSON.stringify(records).includes(TOKEN), false);
    } finally {
      api.restore();
    }
  });

  // Last: shutdown is one-way for the process.
  it('gives up at once when the process is stopping, instead of sleeping on', async () => {
    const api = fakeApi(503);
    const from = records.length;
    try {
      const report = reportResult(BASE, TOKEN, 'job-stop', RESULT, () => 5_000);
      // Let the first attempt fail and the retry pause begin.
      await sleep(20);
      assert.equal(api.calls.length, 1);
      const stoppedAt = Date.now();
      markRelayShutdown();
      assert.equal(await report, false);
      assert.ok(Date.now() - stoppedAt < 500, `took ${Date.now() - stoppedAt}ms to give up`);
      assert.equal(api.calls.length, 1, 'no attempt after the stop');
      const failed = since(from, 'relay.result.failed');
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.fields.shutting_down, true);
      assert.match(failed[0]?.msg ?? '', /shutting down/);

      // A report that starts once the stop has begun does not pause at all.
      assert.equal(await reportResult(BASE, TOKEN, 'job-late', RESULT, () => 5_000), false);
      assert.equal(api.calls.length, 2);
    } finally {
      api.restore();
    }
  });
});
