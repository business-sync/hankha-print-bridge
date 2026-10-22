import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';

/*
 * A websocket session's open and close must tie together in the log — one connection id, how
 * long it lived, who ended it and with what error — because "the bridge disconnected" is
 * otherwise all a venue's file can say.
 *
 * Own file: the relay loop's state is module-global.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-wslog-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'ws';
process.env.PRINT_BRIDGE_HEARTBEAT_MS = '200';
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let server: Server;
const sockets: Socket[] = [];
let upgrades = 0;
let refuse = false;

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const closeFrame = (code: number, reason: string) => {
  const payload = Buffer.alloc(2 + reason.length);
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
};

after(() => {
  for (const s of sockets) s.destroy();
  server?.closeAllConnections?.();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

describe('websocket session logging', () => {
  it('ties open and close together, and says who closed it and why', async () => {
    server = createServer((_req, res) => res.writeHead(200).end());
    server.on('upgrade', (req, socket: Socket) => {
      if (refuse) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      upgrades += 1;
      sockets.push(socket);
      socket.on('error', () => undefined);
      const key = req.headers['sec-websocket-key'] as string;
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      // First session: the server closes it. Second: the connection is reset under it.
      if (upgrades === 1) setTimeout(() => socket.write(closeFrame(1011, 'server restarting')), 150);
      else if (upgrades === 2) setTimeout(() => socket.resetAndDestroy(), 150);
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '7', token: 'ws-secret' });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => events('relay.ws.close').length >= 2);
    const [open1] = events('relay.ws.open');
    const [close1, close2] = events('relay.ws.close');

    assert.ok(open1?.fields.connection_id, 'a session has an id');
    assert.equal(close1?.fields.connection_id, open1?.fields.connection_id, 'open and close share it');
    assert.equal(close1?.fields.code, 1011);
    assert.equal(close1?.fields.reason, 'server restarting');
    assert.equal(close1?.fields.closed_by, 'remote');
    assert.equal(close1?.level, 'warn', 'an abnormal close is a warning');
    assert.ok(Number(close1?.fields.session_ms) >= 100);

    assert.equal(close2?.fields.closed_by, 'network');
    assert.equal(close2?.fields.error_code, 'ECONNRESET');
    assert.notEqual(close2?.fields.connection_id, close1?.fields.connection_id);

    // The third session stays up; the outage that the reset began is closed by a recovery line.
    await waitFor(() => events('relay.recovered').some((r) => r.fields.transport === 'websocket'));
  });

  it('logs a handshake the server refuses, with the status, instead of only setting last_error', async () => {
    refuse = true;
    for (const s of sockets) s.destroy();
    await waitFor(() => events('relay.ws.handshake_failed').length > 0);
    const failed = events('relay.ws.handshake_failed')[0];
    assert.equal(failed?.fields.status, 503);
    assert.equal(failed?.level, 'warn');
  });

  it('never writes the bearer token into any record', () => {
    assert.equal(JSON.stringify(records).includes('ws-secret'), false);
  });
});
