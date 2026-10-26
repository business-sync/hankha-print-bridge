import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';
import { selfSignedCertificate } from './test-support/self-signed.js';

/*
 * The same interceptor, met on the websocket path. The shipped bridge tries the socket first,
 * so on a venue PC this is the line that appears first in the log — it must carry the code,
 * and the issuer line must follow it.
 *
 * Own file: the loop's state is module-global, and the transport is chosen once at start.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-tls-ws-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'ws';
process.env.PRINT_BRIDGE_HEARTBEAT_MS = '200';
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let server: Server;
let upgrades = 0;

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

describe('relay loop behind an HTTPS interceptor (websocket)', () => {
  const fixture = selfSignedCertificate();
  const skip = fixture ? false : 'openssl is not on PATH';

  it('logs the handshake failure with the code, then the issuer of the certificate', { skip }, async () => {
    if (!fixture) return;
    server = createServer({ key: fixture.key, cert: fixture.cert }, (_req, res) => res.writeHead(204).end());
    server.on('upgrade', (_req, socket) => {
      upgrades += 1;
      socket.destroy();
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `https://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '12', token: 'ws-tls-secret' });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => events('relay.tls.untrusted').length > 0);

    const failed = events('relay.ws.handshake_failed')[0];
    assert.ok(failed, 'the handshake failure is logged as before');
    assert.equal(failed?.level, 'warn');
    assert.equal(failed?.fields.status, undefined, 'no HTTP status: TLS failed before any answer');
    assert.equal(failed?.fields.error_code, 'DEPTH_ZERO_SELF_SIGNED_CERT');

    const line = events('relay.tls.untrusted')[0];
    assert.equal(line?.fields.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.equal(line?.fields.issuer, fixture.issuer);
    assert.equal(line?.fields.kind, 'intercepted');
    assert.equal(line?.fields.origin, 'websocket');
    assert.match(line?.msg ?? '', /Fake Interceptor Inc/);
    assert.match(line?.msg ?? '', /refused by the websocket/);
    assert.ok(records.indexOf(failed as LogRecord) < records.indexOf(line as LogRecord), 'the failure comes first, then who caused it');

    assert.match(relay.relayStatus().last_error ?? '', /DEPTH_ZERO_SELF_SIGNED_CERT/);
    assert.equal(relay.relayStatus().connected, false);
    assert.equal(relay.relayStatus().tls_trust?.kind, 'intercepted');
    assert.equal(upgrades, 0, 'no upgrade ever reached the server: verification was not relaxed');
  });

  it('never writes the bearer token into any record', () => {
    assert.equal(JSON.stringify(records).includes('ws-tls-secret'), false);
  });
});
