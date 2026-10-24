import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';

/*
 * A handshake 401 whose confirming heartbeat answers 5xx is neither a revocation nor an edge
 * refusing upgrades: the API itself is having a bad minute. It must take the ordinary transient
 * path — one long-poll, then the socket again soon — not block the socket for the whole window.
 *
 * Own file: the loop's state is module-global. The window is set long (60 s) so a retry inside
 * the test's few seconds can only come from the transient path.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-ws401-5xx-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'auto';
process.env.PRINT_BRIDGE_WS_RETRY_MS = '60000';
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let server: Server;
const upgrades: number[] = [];
let polls = 0;

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

const waitFor = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('a handshake 401 confirmed by a 5xx heartbeat', () => {
  it('is a transient fault: long-poll once, then the socket again — no refusal, no revocation', async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('/bridge/heartbeat')) {
        res.writeHead(503).end();
        return;
      }
      if (req.url?.includes('/bridge/work')) {
        polls += 1;
        setTimeout(() => res.writeHead(204).end(), 50);
        return;
      }
      res.writeHead(404).end();
    });
    server.on('upgrade', (_req, socket: Socket) => {
      upgrades.push(Date.now());
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '9', token: 'still-good' });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => upgrades.length >= 2);
    assert.ok(polls >= 1, 'the long-poll ran between the two handshakes');
    assert.equal(events('relay.ws.refused').length, 0, 'not reported as an edge refusing upgrades');
    assert.equal(events('relay.token_rejected').length, 0, 'not treated as a revoked token');
    assert.equal(relay.isRelayRejected(), false);
    assert.ok(events('relay.ws.auth_probe').every((r) => r.fields.status === 503));
  });
});
