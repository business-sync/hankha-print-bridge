import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';

/*
 * The shape of the fault on the till that motivated 1.14.7: the websocket connects, and in the
 * same process every `fetch` is refused on trust grounds. 1.14.6 classified only the socket
 * handshake and the poll, and `markUp('websocket')` had cleared `last_error` — so a bridge in
 * exactly this state showed "connected" with nothing to say about the heartbeats it was losing.
 *
 * Runs the real loop over a plain-HTTP websocket (so the socket is fine) with `fetch` stubbed to
 * throw what Bun threw. Own file: the loop's state is module-global.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-tls-heartbeat-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'ws';
process.env.PRINT_BRIDGE_HEARTBEAT_MS = '150';
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let server: Server;
const sockets: Socket[] = [];
let heartbeats = 0;

const waitFor = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

after(() => {
  for (const s of sockets) s.destroy();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

describe('relay loop whose websocket connects while every fetch is refused on trust grounds', () => {
  it('keeps the code in last_error, records a verdict with origin=heartbeat, and stays connected', async () => {
    server = createServer((_req, res) => res.writeHead(404).end());
    server.on('upgrade', (req, socket: Socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on('error', () => undefined);
      sockets.push(socket);
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;

    // What Bun 1.3.11 threw on the till, in Bun's shape: the code on the error itself.
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      if (String(input).includes('/heartbeat')) {
        heartbeats += 1;
        throw Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
      }
      return new Response(null, { status: 204 });
    });

    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '13', token: 'hb-tls-secret' });
    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => events('relay.ws.open').length > 0);
    await waitFor(() => events('relay.tls.untrusted').length > 0);
    // The first heartbeat fails before the socket opens — the till's order too — and the open
    // socket rightly clears last_error. The next heartbeat puts the code back; wait for it.
    await waitFor(() => /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/.test(relay.relayStatus().last_error ?? ''));

    const status = relay.relayStatus();
    assert.equal(status.connected, true, 'the socket is up: nothing here pretends otherwise');
    assert.equal(status.transport, 'websocket');
    assert.match(status.last_error ?? '', /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/, 'the heartbeat’s refusal is not hidden by the open socket');
    assert.equal(status.tls_trust?.kind, 'unverified', 'a plain-http relay cannot be peeked, so no cause is claimed');
    assert.equal(status.tls_trust?.origin, 'heartbeat');
    assert.equal(status.tls_trust?.code, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    assert.match(status.tls_trust?.runtime ?? '', /^(node|bun) \d/);

    const line = events('relay.tls.untrusted')[0];
    assert.equal(line?.level, 'warn');
    assert.equal(line?.fields.kind, 'unverified');
    assert.equal(line?.fields.origin, 'heartbeat');
    assert.doesNotMatch(line?.msg ?? '', /antivirus or a proxy is re-signing|NODE_EXTRA_CA_CERTS|exclude/i, 'no interception is claimed and no shop is told to widen trust');
    assert.match(line?.msg ?? '', /Update the Print Bridge/);

    // Once per window, however many heartbeats fail.
    await waitFor(() => heartbeats >= 3);
    assert.equal(events('relay.tls.untrusted').length, 1);
    assert.ok(events('relay.heartbeat.failed').length >= 1, 'the ordinary heartbeat line is still there');
  });

  it('never writes the bearer token into any record', () => {
    assert.equal(JSON.stringify(records).includes('hb-tls-secret'), false);
  });
});
