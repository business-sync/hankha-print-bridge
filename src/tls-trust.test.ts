import assert from 'node:assert/strict';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { after, describe, it } from 'node:test';
import { WebSocketHandshakeError } from './relay-socket.js';
import { selfSignedCertificate } from './test-support/self-signed.js';
import {
  classifyTlsTrust,
  distinguishedName,
  isTlsTrustCode,
  peekPeerCertificate,
  type PeerCertificateSummary,
  publicCaIssuer,
  TLS_TRUST_CODES,
  tlsTrustCode,
} from './tls-trust.js';

/*
 * Telling a trust failure apart from "the wifi dropped", then telling its two causes apart —
 * an antivirus re-signing HTTPS on this PC, or this bridge's own runtime refusing a valid public
 * certificate — because they need opposite advice and 1.14.6 gave the first for both. Pinned
 * here: the code, in every shape the two runtimes throw it; the verdict, from every kind of
 * evidence; and the peek that reads the issuer and node:tls's own opinion off a chain
 * verification refuses.
 */

function cert(over: Partial<PeerCertificateSummary> = {}): PeerCertificateSummary {
  return {
    issuer: 'C=US, O=Google Trust Services, CN=WE1',
    subject: 'CN=hankha.la',
    fingerprint_sha256: '06:16:98:43:8F:80:CF:A6:7F:CE:A6:D2:8C:A8:5E:87:BA:67:31:7A:FA:9A:26:B3:63:65:C1:11:FC:98:98:5E',
    valid_from: 'Oct  1 00:00:00 2026 GMT',
    valid_to: 'Dec 30 00:00:00 2026 GMT',
    self_signed: false,
    authorized: false,
    authorization_error: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ...over,
  };
}

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

describe('publicCaIssuer', () => {
  it('knows the authorities a browser trusts, by the names they sign with', () => {
    for (const issuer of [
      'C=US, O=Google Trust Services, CN=WE1',
      'C=US, O=Google Trust Services LLC, CN=GTS CA 1P5',
      "C=US, O=Let's Encrypt, CN=R11",
      'C=US, O=Internet Security Research Group, CN=ISRG Root X1',
      'C=US, O=DigiCert Inc, CN=DigiCert Global G2 TLS RSA SHA256 2020 CA1',
      'C=GB, ST=Greater Manchester, L=Salford, O=Sectigo Limited, CN=Sectigo RSA Domain Validation Secure Server CA',
      'C=US, O=Amazon, CN=Amazon RSA 2048 M02',
      'C=US, O=Cloudflare, Inc., CN=Cloudflare Inc ECC CA-3',
      'C=US, ST=Texas, L=Houston, O=SSL Corp, CN=SSL.com TLS ECC SubCA 2024',
      'C=BE, O=GlobalSign nv-sa, CN=GlobalSign Atlas R3 DV TLS CA 2024 Q1',
      'C=AT, O=ZeroSSL, CN=ZeroSSL RSA Domain Secure Site CA',
      'C=US, O=GoDaddy.com, Inc., CN=Go Daddy Secure Certificate Authority - G2',
    ]) {
      assert.equal(publicCaIssuer(issuer), true, issuer);
    }
  });

  it('does not mistake an interceptor, a test fixture or nothing at all for one', () => {
    for (const issuer of [
      'O=Kaspersky, CN=Kaspersky Anti-Virus Personal Root Certificate',
      'CN=ESET SSL Filter CA',
      'O=Avast Software, CN=Avast Web/Mail Shield Root',
      'O=Bitdefender, CN=Bitdefender Personal CA.Net-Defender',
      'C=US, O=Zscaler Inc., OU=Zscaler Inc., CN=Zscaler Root CA',
      'CN=FortiGate CA',
      'O=Sophos Ltd, CN=Sophos SSL CA',
      'O=Fake Interceptor Inc, CN=localhost',
      'CN=DO_NOT_TRUST_FiddlerRoot',
      'CN=mitmproxy',
      'CN=localhost',
      '',
    ]) {
      assert.equal(publicCaIssuer(issuer), false, issuer);
    }
  });
});

describe('classifyTlsTrust', () => {
  const code = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';

  it('is a runtime fault when node:tls in the same process accepts the chain fetch refused', () => {
    // The till that motivated this: the real Google Trust Services certificate, refused by fetch,
    // accepted by every other TLS client in the process.
    const verdict = classifyTlsTrust({ code, cert: cert({ authorized: true, authorization_error: null }) });
    assert.equal(verdict.kind, 'runtime');
    assert.equal(verdict.issuer, 'C=US, O=Google Trust Services, CN=WE1');
    assert.match(verdict.evidence, /node:tls in this same process/);
  });

  it('is a runtime fault when the request verified once handed the bundled roots, whatever else is known', () => {
    const verdict = classifyTlsTrust({ code, cert: null, explicit_roots: 'verified' });
    assert.equal(verdict.kind, 'runtime');
    assert.equal(verdict.issuer, null);
    assert.match(verdict.evidence, /bundled in this binary/);
    assert.equal(classifyTlsTrust({ code, cert: cert({ self_signed: true, issuer: 'CN=x', subject: 'CN=x' }), explicit_roots: 'verified' }).kind, 'runtime');
  });

  it('is a runtime fault, not an interceptor, when the issuer is a public authority even if nothing here verifies it', () => {
    const verdict = classifyTlsTrust({ code, cert: cert() });
    assert.equal(verdict.kind, 'runtime');
    assert.match(verdict.evidence, /public certificate authority \(C=US, O=Google Trust Services, CN=WE1\)/);
    const stubborn = classifyTlsTrust({ code, cert: cert(), explicit_roots: 'failed' });
    assert.equal(stubborn.kind, 'runtime');
    assert.match(stubborn.evidence, /did not verify it either/, 'the failed retry is recorded, not hidden');
  });

  it('is an interceptor when the certificate is self-signed or signed by something no browser trusts', () => {
    const selfSigned = classifyTlsTrust({
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      cert: cert({ issuer: 'O=Fake Interceptor Inc, CN=localhost', subject: 'O=Fake Interceptor Inc, CN=localhost', self_signed: true, authorization_error: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    });
    assert.equal(selfSigned.kind, 'intercepted');
    assert.match(selfSigned.evidence, /self-signed/);
    const kaspersky = classifyTlsTrust({
      code, cert: cert({ issuer: 'O=Kaspersky, CN=Kaspersky Anti-Virus Personal Root Certificate' }),
    });
    assert.equal(kaspersky.kind, 'intercepted');
    assert.equal(kaspersky.issuer, 'O=Kaspersky, CN=Kaspersky Anti-Virus Personal Root Certificate');
    assert.match(kaspersky.evidence, /Kaspersky Anti-Virus Personal Root Certificate/);
    assert.match(kaspersky.evidence, /not a public certificate authority/);
  });

  it('claims nothing when the certificate could not be read back', () => {
    const verdict = classifyTlsTrust({ code, cert: null });
    assert.equal(verdict.kind, 'unverified');
    assert.equal(verdict.issuer, null);
    assert.equal(verdict.code, code);
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
    assert.equal(summary.authorized, false, 'the socket still verified, it just did not hang up');
    assert.equal(summary.authorization_error, 'DEPTH_ZERO_SELF_SIGNED_CERT');
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
