import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';
import { selfSignedCertificate } from './test-support/self-signed.js';

/*
 * What a venue's bridge.log says when an antivirus or proxy is re-signing HTTPS on that PC.
 *
 * Runs the real loop (long-poll) against an API that presents a certificate no trust store has
 * heard of — which is exactly what an interceptor does. The loop must say WHICH certificate it
 * was shown, once, beside the retry line that already carried the code; and `last_error` must
 * carry the code, because that is what the status page keys its advice on.
 *
 * Own file: the loop's state is module-global. Nothing here can pass unless verification stays
 * on for the real request — a bridge that trusted this server would simply connect.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-tls-poll-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'poll';
process.env.PRINT_BRIDGE_HEARTBEAT_MS = '200';
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let server: Server;
let requests = 0;

const waitFor = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

describe('relay loop behind an HTTPS interceptor (long-poll)', () => {
  const fixture = selfSignedCertificate();
  const skip = fixture ? false : 'openssl is not on PATH';

  it('names the issuer of the certificate it was shown, once, and keeps the code in last_error', { skip }, async () => {
    if (!fixture) return;
    server = createServer({ key: fixture.key, cert: fixture.cert }, (_req, res) => {
      requests += 1;
      res.writeHead(204).end();
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `https://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '11', token: 'tls-secret' });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => events('relay.tls.untrusted').length > 0);
    const line = events('relay.tls.untrusted')[0];
    assert.equal(line?.level, 'warn');
    assert.equal(line?.fields.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.equal(line?.fields.host, `127.0.0.1:${port}`);
    assert.equal(line?.fields.issuer, fixture.issuer, 'the issuer is what identifies the interceptor');
    assert.equal(line?.fields.self_signed, true);
    assert.match(line?.msg ?? '', /Fake Interceptor Inc/);
    assert.match(line?.msg ?? '', /antivirus or proxy/);
    assert.match(line?.msg ?? '', /NODE_EXTRA_CA_CERTS/, 'the line carries the remedy');

    // The ordinary retry line still comes first and still carries the code…
    const retry = events('relay.retry')[0];
    assert.ok(retry, 'the retry line is logged as before');
    assert.match(String(retry?.fields.detail), /DEPTH_ZERO_SELF_SIGNED_CERT/);
    // …and so does last_error, which is what the status page matches against.
    assert.match(relay.relayStatus().last_error ?? '', /DEPTH_ZERO_SELF_SIGNED_CERT/);
    assert.equal(relay.relayStatus().connected, false);

    // Once per window, however many attempts the backoff makes.
    await waitFor(() => relay.relayDiagnostics().failures >= 2, 10_000);
    assert.equal(events('relay.tls.untrusted').length, 1);

    // Verification was never relaxed for a real request: the server saw none, and the peek
    // sends nothing.
    assert.equal(requests, 0);
  });

  it('never writes the bearer token into any record', () => {
    assert.equal(JSON.stringify(records).includes('tls-secret'), false);
  });
});
