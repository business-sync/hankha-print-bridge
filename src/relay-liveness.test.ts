import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

/*
 * A websocket whose transport is alive but whose application is dead must not keep the bridge
 * "connected". Pongs and TCP keepalives are answered by anything on the path; only an `ack` from
 * the print socket handler proves the heartbeat reached it.
 *
 * Timers are shortened through env (heartbeat 200ms, ack timeout 600ms) so the equivalent of many
 * hours of idle heartbeats runs in a few seconds without fake-timer plumbing in a module that owns
 * real sockets. Own file: the relay loop's state is module-global.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-live-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'ws';
process.env.PRINT_BRIDGE_HEARTBEAT_MS = '200';
process.env.PRINT_BRIDGE_ACK_TIMEOUT_MS = '600';

let server: Server;
const sockets: Socket[] = [];
let upgrades = 0;
let ackMode: 'ack' | 'mute' = 'ack';

const textFrame = (s: string) => {
  const p = Buffer.from(s);
  return Buffer.concat([Buffer.from([0x81, p.length]), p]);
};

const waitFor = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

after(() => {
  for (const s of sockets) s.destroy();
  server?.closeAllConnections?.();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

describe('websocket application-level liveness', () => {
  it('stays on one session while acks flow, reconnects when they stop, and recovers', async () => {
    server = createServer((_req, res) => res.writeHead(200).end());
    server.on('upgrade', (req, socket: Socket) => {
      upgrades += 1;
      sockets.push(socket);
      const key = req.headers['sec-websocket-key'] as string;
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      socket.on('data', (buf: Buffer) => {
        if (ackMode === 'ack' && (buf[0]! & 0x0f) === 0x1) socket.write(textFrame('{"type":"ack","ready":true}'));
      });
      socket.on('error', () => undefined);
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '9', token: 'tok' });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => relay.relayStatus().connected);
    // ~15 heartbeats, 5x the ack timeout: a healthy feed must not be torn down or flap.
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(upgrades, 1, 'a healthy, acking session must not reconnect');
    assert.equal(relay.relayStatus().connected, true);

    // The server stops acking but the socket stays open (pongs/TCP fine): a silently dead feed.
    ackMode = 'mute';
    await waitFor(() => upgrades >= 2, 8000);
    assert.ok(upgrades >= 2, 'a feed that stops acking must be replaced');

    // And the replacement recovers once the server acks again.
    ackMode = 'ack';
    await waitFor(() => relay.relayStatus().connected, 8000);
    const settled = upgrades;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(upgrades, settled, 'recovered session stays up');
  });
});
