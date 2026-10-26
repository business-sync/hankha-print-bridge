import assert from 'node:assert/strict';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { after, describe, it } from 'node:test';
import { WebSocketHandshakeError } from './relay-socket.js';
import { selfSignedCertificate } from './test-support/self-signed.js';
import {
  distinguishedName,
  isTlsTrustCode,
  peekPeerCertificate,
  TLS_TRUST_CODES,
  tlsTrustCode,
} from './tls-trust.js';

/*
 * Telling "an antivirus is re-signing HTTPS on this PC" apart from "the wifi dropped", and
 * naming the program doing it. Both halves are pinned here: the classification, in every shape
 * the two runtimes throw it, and the peek that reads the issuer off a chain verification refuses.
 */

const servers: (HttpsServer | TcpServer)[] = [];
after(() => {
  for (const server of servers) server.close();
});

function listen(server: HttpsServer | TcpServer): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  );
}

describe('tlsTrustCode', () => {
  it('reads the code wherever the runtime put it', () => {
    // Bun throws the OpenSSL code on the error itself…
    const bunShaped = Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    assert.equal(tlsTrustCode(bunShaped), 'DEPTH_ZERO_SELF_SIGNED_CERT');
    // …Node's fetch buries it one level down in `cause`, behind a message that says nothing.
    const nodeShaped = new TypeError('fetch failed', {
      cause: Object.assign(new Error('unable to get local issuer certificate'), {
        code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      }),
    });
    assert.equal(tlsTrustCode(nodeShaped), 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    // The websocket handshake carries it on its own error type.
    const handshake = new WebSocketHandshakeError('self signed certificate in certificate chain', null, 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.equal(tlsTrustCode(handshake), 'SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('is null for every other failure, including the TLS ones a root certificate would not fix', () => {
    for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', undefined]) {
      assert.equal(tlsTrustCode(Object.assign(new Error('x'), { code })), null, `${code} must not count`);
    }
    assert.equal(tlsTrustCode(Object.assign(new Error('HTTP 503'), { status: 503 })), null);
    assert.equal(tlsTrustCode('unable to get local issuer certificate'), null, 'a bare string has no code');
    assert.equal(tlsTrustCode(null), null);
    assert.equal(tlsTrustCode(undefined), null);
  });

  it('agrees with the list the page is built from', () => {
    for (const code of TLS_TRUST_CODES) assert.ok(isTlsTrustCode(code), code);
    assert.equal(isTlsTrustCode('CERT_HAS_EXPIRED'), false);
    assert.equal(isTlsTrustCode(42), false);
  });
});

describe('distinguishedName', () => {
  it('renders the attributes in the order the certificate carries them', () => {
    assert.equal(
      distinguishedName({ C: 'US', O: 'Google Trust Services', CN: 'WE1' } as never),
      'C=US, O=Google Trust Services, CN=WE1'
    );
    assert.equal(distinguishedName({ OU: ['Security', 'Gateway'], CN: 'Proxy Root' } as never), 'OU=Security+Gateway, CN=Proxy Root');
    assert.equal(distinguishedName(undefined), '');
  });
});

describe('peekPeerCertificate', () => {
  const fixture = selfSignedCertificate();
  const skip = fixture ? false : 'openssl is not on PATH';

  it('names the issuer of a certificate verification would refuse, without sending a request', { skip }, async () => {
    if (!fixture) return;
    let requests = 0;
    const server = createHttpsServer({ key: fixture.key, cert: fixture.cert }, (_req, res) => {
      requests += 1;
      res.writeHead(204).end();
    });
    const port = await listen(server);

    const summary = await peekPeerCertificate(`https://127.0.0.1:${port}`);
    assert.ok(summary, 'the certificate was read');
    assert.equal(summary.issuer, fixture.issuer);
    assert.equal(summary.subject, fixture.issuer);
    assert.equal(summary.self_signed, true);
    assert.match(summary.fingerprint_sha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.ok(summary.valid_to.length > 0);
    // Only the handshake happened: nothing went over the unverified connection.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(requests, 0);
  });

  it('accepts a wss: URL and the default port', async () => {
    // Nothing listens on 127.0.0.1:443 here, so this proves the parse, not the handshake.
    assert.equal(await peekPeerCertificate('wss://127.0.0.1/api/v1/modules/print/bridge/socket', 500), null);
  });

  it('is null for a URL that is not https', async () => {
    assert.equal(await peekPeerCertificate('http://127.0.0.1:9200'), null);
    assert.equal(await peekPeerCertificate('not a url'), null);
  });

  it('is null when nothing is listening', async () => {
    const probe = createTcpServer();
    const port = await listen(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    assert.equal(await peekPeerCertificate(`https://127.0.0.1:${port}`), null);
  });

  it('gives up inside the timeout when the port never speaks TLS', async () => {
    const silent = createTcpServer((socket) => socket.on('error', () => undefined));
    const port = await listen(silent);
    const startedAt = Date.now();
    assert.equal(await peekPeerCertificate(`https://127.0.0.1:${port}`, 300), null);
    assert.ok(Date.now() - startedAt < 2_000, 'returned promptly');
    silent.close();
  });
});
