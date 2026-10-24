import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';

/*
 * `PRINT_BRIDGE_RELAY_TRANSPORT=ws` with an edge that refuses the upgrade 401 while the API
 * accepts the token over HTTP. Pinned to the socket or not, the 401 is checked before it is
 * believed, work keeps flowing over the long-poll while the socket is blocked, and the socket is
 * tried again once the window has passed — the same shape the 404 path has always had in this
 * mode. Own file: the loop's state is module-global.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-ws401-forced-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'ws';
const WS_WINDOW_MS = 3000;
process.env.PRINT_BRIDGE_WS_RETRY_MS = String(WS_WINDOW_MS);
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let server: Server;
const upgrades: number[] = [];
const workQueue: object[] = [
  {
    type: 'print',
    job: {
      job_id: 'j-forced-1', client_job_id: 'c-1', kind: 'RECEIPT', printer_id: 'ghost', target_ip: null,
      target_port: 9100, payload_base64: Buffer.from('x').toString('base64'), payload_sha256: '0'.repeat(64),
      attempt: 1, claim_expires_at: '',
    },
  },
];
const results: string[] = [];

const waitFor = async (cond: () => boolean, ms = 8000) => {
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

describe('forced websocket mode behind an edge that refuses the upgrade', () => {
  it('still probes, carries work over the long-poll, and tries the socket again after the window', async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('/bridge/heartbeat')) {
        res.writeHead(200).end();
        return;
      }
      if (req.url?.includes('/bridge/work')) {
        const next = workQueue.shift();
        if (next) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(next));
          return;
        }
        setTimeout(() => res.writeHead(204).end(), 50);
        return;
      }
      if (req.url?.includes('/result')) {
        results.push(req.url ?? '');
        req.resume();
        res.writeHead(200).end();
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
    saveState({ ...loadState(), bridge_id: '9', token: 'forced-secret' });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => results.length === 1);
    assert.equal(results[0], '/api/v1/modules/print/bridge/jobs/j-forced-1/result');
    assert.equal(relay.isRelayRejected(), false);
    assert.equal(events('relay.token_rejected').length, 0);
    assert.equal(relay.relayStatus().transport, 'long-poll');
    assert.equal(upgrades.length, 1);
    assert.equal(events('relay.ws.auth_probe')[0]?.fields.status, 200);
    assert.equal(events('relay.ws.refused').length, 1);

    await waitFor(() => upgrades.length >= 2, WS_WINDOW_MS * 3);
    const gap = (upgrades[1] ?? 0) - (upgrades[0] ?? 0);
    assert.ok(gap >= WS_WINDOW_MS - 100, `retried after ${gap}ms, window ${WS_WINDOW_MS}ms`);
    await waitFor(() => events('relay.ws.auth_probe').length >= 2);
    assert.equal(events('relay.ws.refused').length, 1, 'said once, not once per window');
    assert.equal(JSON.stringify(records).includes('forced-secret'), false);
  });
});
