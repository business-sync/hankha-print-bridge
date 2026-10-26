import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';
import { createRelayFetch, type RelayRequestInit } from './relay-fetch.js';

/*
 * The second line of defence against a runtime whose `fetch` trust store is wrong for the life
 * of the process (oven-sh/bun #28612): one retry with the bundled roots passed explicitly, a
 * latch once that works, and the ORIGINAL error — never the retry's — when it does not.
 */

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const explicitRootsLines = () => records.filter((r) => r.event === 'relay.tls.explicit_roots');

const ROOTS = ['-----BEGIN CERTIFICATE-----\nroot-one\n-----END CERTIFICATE-----', '-----BEGIN CERTIFICATE-----\nroot-two\n-----END CERTIFICATE-----'];
const trustError = (code = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') =>
  Object.assign(new Error('unable to get local issuer certificate'), { code });

interface Call {
  url: string;
  init: RelayRequestInit | undefined;
}

/** A fetch that refuses every request made without `tls.ca`, and answers 200 to every one with it. */
function brokenStoreFetch(calls: Call[], retryError?: Error) {
  return async (url: string, init?: RelayRequestInit) => {
    calls.push({ url, init });
    if (!init?.tls?.ca) throw trustError();
    if (retryError) throw retryError;
    return new Response('ok', { status: 200 });
  };
}

describe('relayFetch', () => {
  it('passes a request through untouched while the runtime verifies', async () => {
    const calls: Call[] = [];
    const relayFetch = createRelayFetch({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
      isBun: true, roots: () => ROOTS, runtime: 'bun 9.9.9',
    });
    const res = await relayFetch('https://relay.test/api/v1/modules/print/bridge/heartbeat', { method: 'POST' });
    assert.equal(res.status, 204);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.tls, undefined, 'no roots are passed while none are needed');
    assert.equal(relayFetch.state().tried, false);
  });

  it('retries once with the bundled roots on a trust failure, then carries them on every request', async () => {
    records.length = 0;
    const calls: Call[] = [];
    const relayFetch = createRelayFetch({ fetchImpl: brokenStoreFetch(calls), isBun: true, roots: () => ROOTS, runtime: 'bun 1.3.11' });

    const res = await relayFetch('https://api.hankha.la/api/v1/modules/print/bridge/heartbeat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 200, 'the caller sees the retry, not the failure');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.init?.tls, undefined, 'the first attempt is the plain request');
    assert.deepEqual(calls[1]?.init?.tls?.ca, ROOTS, 'the retry carries exactly the runtime’s own roots');
    assert.equal(calls[1]?.init?.method, 'POST', 'everything else about the request is kept');
    assert.equal(calls[1]?.init?.body, '{}');

    const state = relayFetch.state();
    assert.equal(state.tried, true);
    assert.equal(state.latched, true);
    assert.equal(state.failed_code, null);
    assert.match(state.latched_at ?? '', /^\d{4}-\d{2}-\d{2}T/);

    // Latched: the next request does not try the broken store first.
    await relayFetch('https://api.hankha.la/api/v1/modules/print/bridge/work?wait=25', { headers: { Authorization: 'Bearer x' } });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2]?.init?.tls?.ca, ROOTS);
    assert.equal(calls[2]?.init?.headers && (calls[2].init.headers as Record<string, string>).Authorization, 'Bearer x');

    // Said once, with what support needs: the runtime, the code, the host.
    const lines = explicitRootsLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, 'warn');
    assert.equal(lines[0]?.fields.runtime, 'bun 1.3.11');
    assert.equal(lines[0]?.fields.code, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    assert.equal(lines[0]?.fields.host, 'api.hankha.la');
    assert.equal(lines[0]?.fields.roots, ROOTS.length);
    assert.match(lines[0]?.msg ?? '', /did not apply its default trust store/);
    assert.match(lines[0]?.msg ?? '', /Update the Print Bridge/);
    assert.doesNotMatch(lines[0]?.msg ?? '', /antivirus|NODE_EXTRA_CA_CERTS/, 'this is a runtime fault and is named as one');
  });

  it('throws the original error when the roots do not help, and remembers why', async () => {
    records.length = 0;
    const calls: Call[] = [];
    const relayFetch = createRelayFetch({
      fetchImpl: brokenStoreFetch(calls, trustError('SELF_SIGNED_CERT_IN_CHAIN')),
      isBun: true, roots: () => ROOTS, runtime: 'bun 1.3.11',
    });
    await assert.rejects(
      relayFetch('https://api.hankha.la/api/v1/modules/print/bridge/heartbeat'),
      (err: unknown) => (err as { code?: string }).code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'the caller and the classifier see the plain request’s error',
    );
    assert.equal(calls.length, 2);
    const state = relayFetch.state();
    assert.equal(state.tried, true);
    assert.equal(state.latched, false);
    assert.equal(state.failed_code, 'SELF_SIGNED_CERT_IN_CHAIN', 'what the retry met is kept for the verdict');
    assert.equal(explicitRootsLines().length, 0);

    // Not latched: the next request is a plain one again, and is retried again.
    await assert.rejects(relayFetch('https://api.hankha.la/api/v1/modules/print/bridge/heartbeat'));
    assert.equal(calls.length, 4);
    assert.equal(calls[2]?.init?.tls, undefined);
  });

  it('does not retry under Node, on an error that is not about trust, or with no roots to pass', async () => {
    for (const [why, deps, err] of [
      ['Node', { isBun: false, roots: () => ROOTS }, trustError()],
      ['a network error', { isBun: true, roots: () => ROOTS }, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
      ['no roots', { isBun: true, roots: () => [] }, trustError()],
    ] as const) {
      const calls: Call[] = [];
      const relayFetch = createRelayFetch({
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          throw err;
        },
        runtime: 'x', ...deps,
      });
      await assert.rejects(relayFetch('https://api.hankha.la/x'), (e: unknown) => e === err, why);
      assert.equal(calls.length, 1, `${why}: one attempt only`);
      assert.equal(relayFetch.state().tried, false, why);
    }
  });

  it('keeps the caller’s own tls options beside the roots', async () => {
    const calls: Call[] = [];
    const relayFetch = createRelayFetch({ fetchImpl: brokenStoreFetch(calls), isBun: true, roots: () => ROOTS, runtime: 'x' });
    await relayFetch('https://api.hankha.la/x', { tls: { rejectUnauthorized: true } });
    assert.deepEqual(calls[1]?.init?.tls, { rejectUnauthorized: true, ca: ROOTS });
  });

  it('forgets the latch on reset and on reconfiguration', async () => {
    const calls: Call[] = [];
    const relayFetch = createRelayFetch({ fetchImpl: brokenStoreFetch(calls), isBun: true, roots: () => ROOTS, runtime: 'x' });
    await relayFetch('https://api.hankha.la/x');
    assert.equal(relayFetch.state().latched, true);
    relayFetch.reset();
    assert.equal(relayFetch.state().latched, false);
    relayFetch.configure({ isBun: false });
    await assert.rejects(relayFetch('https://api.hankha.la/x'));
    assert.equal(relayFetch.state().tried, false);
  });
});
