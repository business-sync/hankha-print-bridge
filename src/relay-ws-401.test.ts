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
 * A 401 on the websocket HANDSHAKE is not, on its own, a revoked token.
 *
 * An edge, a proxy or a WAF that refuses upgrades but passes ordinary requests answers the
 * handshake 401 as well, and the loop used to take that as "revoked": it sat out the rejection
 * backoff re-reading the token, and never fell back to the long-poll that was working the whole
 * time — a venue's printing down over a proxy setting. The handshake's 401 is now believed only
 * when a heartbeat with the same token is refused too. A close frame 1008/4401 from a session
 * that DID open is still a revocation: the API accepted the upgrade, so nothing is in the way.
 *
 * Runs the real loop against a fake API. Own file: the loop's state is module-global, and the
 * 30-minute websocket window is shortened through env to a few seconds.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-ws401-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'auto';
const WS_WINDOW_MS = 3000;
process.env.PRINT_BRIDGE_WS_RETRY_MS = String(WS_WINDOW_MS);
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const TOKEN = 'edge-secret';
const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let server: Server;
const sockets: Socket[] = [];
/** When each upgrade request arrived. */
const upgrades: number[] = [];
let heartbeatAnswer: 200 | 401 = 401;
let upgradeAnswer: '401' | 'accept-then-1008' = '401';
let polls = 0;
const workQueue: object[] = [];
const results: { url: string; body: Record<string, unknown> }[] = [];

const waitFor = async (cond: () => boolean, ms = 6000) => {
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

const job = {
  type: 'print',
  job: {
    job_id: 'j-edge-1',
    client_job_id: 'c-1',
    kind: 'RECEIPT',
    // Not in this bridge's (empty) registry, so the job is refused with `device-missing` and the
    // refusal is reported — which proves the work arrived and was handled, with no printer.
    printer_id: 'ghost',
    target_ip: null,
    target_port: 9100,
    payload_base64: Buffer.from('x').toString('base64'),
    payload_sha256: '0'.repeat(64),
    attempt: 1,
    claim_expires_at: '',
  },
};

describe('a 401 on the websocket handshake', () => {
  it('is a revoked token only when a heartbeat with the same token is refused too', async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('/bridge/heartbeat')) {
        res.writeHead(heartbeatAnswer).end();
        return;
      }
      if (req.url?.includes('/bridge/work')) {
        polls += 1;
        const next = workQueue.shift();
        if (next) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(next));
          return;
        }
        // A short pause stands in for the long poll, so the loop does not spin.
        setTimeout(() => res.writeHead(204).end(), 50);
        return;
      }
      if (req.url?.includes('/result')) {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk;
        });
        req.on('end', () => {
          results.push({ url: req.url ?? '', body: JSON.parse(body) as Record<string, unknown> });
          res.writeHead(200).end();
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.on('upgrade', (req, socket: Socket) => {
      upgrades.push(Date.now());
      socket.on('error', () => undefined);
      if (upgradeAnswer === '401') {
        // What an edge that does not pass upgrades says — indistinguishable, on the handshake
        // alone, from the API refusing the token.
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      sockets.push(socket);
      const key = req.headers['sec-websocket-key'] as string;
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      // The API accepted the upgrade and then revoked the session: nothing was in the way.
      setTimeout(() => socket.write(closeFrame(1008, 'revoked')), 150);
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '9', token: TOKEN });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => relay.isRelayRejected());
    assert.equal(upgrades.length, 1);
    const probes = events('relay.ws.auth_probe');
    assert.equal(probes.length, 1, 'exactly one heartbeat probe per refused handshake');
    assert.equal(probes[0]?.fields.status, 401);
    assert.equal(events('relay.token_rejected').length, 1);
    assert.equal(events('relay.ws.refused').length, 0);
    assert.equal(polls, 0, 'a confirmed revocation does not fall back to the long-poll');
  });

  it('is the edge refusing the upgrade when the heartbeat is accepted: work flows over the long-poll', async () => {
    const relay = await import('./relay.js');
    heartbeatAnswer = 200;
    workQueue.push(job);
    // The loop is sitting out the rejection backoff; wake it, as a re-pair would.
    relay.wakeRelay();

    await waitFor(() => results.length === 1);
    assert.equal(results[0]?.url, '/api/v1/modules/print/bridge/jobs/j-edge-1/result');
    assert.equal(results[0]?.body.reason, 'device-missing');
    assert.equal(relay.relayStatus().connected, true);
    assert.equal(relay.relayStatus().transport, 'long-poll');
    assert.equal(relay.isRelayRejected(), false);
    assert.equal(events('relay.token_rejected').length, 1, 'no new rejection');

    assert.equal(upgrades.length, 2);
    assert.equal(events('relay.ws.auth_probe')[1]?.fields.status, 200);
    const refused = events('relay.ws.refused');
    assert.equal(refused.length, 1, 'said once, clearly');
    assert.equal(refused[0]?.level, 'warn');
    assert.equal(refused[0]?.fields.probe_status, 200);
    assert.equal(refused[0]?.fields.retry_in_ms, WS_WINDOW_MS);
    assert.match(refused[0]?.msg ?? '', /refused with 401, but the API accepts this token/);
  });

  it('leaves the websocket alone until the window has passed, then tries it again', async () => {
    const relay = await import('./relay.js');
    // Well inside the window: still polling, no new handshake.
    await new Promise((r) => setTimeout(r, WS_WINDOW_MS / 2));
    assert.equal(upgrades.length, 2, 'the websocket is left alone inside the window');
    assert.equal(relay.relayStatus().transport, 'long-poll');
    assert.equal(relay.relayStatus().connected, true);

    upgradeAnswer = 'accept-then-1008';
    await waitFor(() => upgrades.length >= 3, WS_WINDOW_MS * 3);
    const gap = (upgrades[2] ?? 0) - (upgrades[1] ?? 0);
    assert.ok(gap >= WS_WINDOW_MS - 100, `retried after ${gap}ms, window ${WS_WINDOW_MS}ms`);
  });

  it('still takes a close 1008 from a session that opened as a revocation', async () => {
    const relay = await import('./relay.js');
    await waitFor(() => events('relay.token_rejected').length === 2);
    assert.equal(relay.isRelayRejected(), true);
    const close = events('relay.ws.close').at(-1);
    assert.equal(close?.fields.code, 1008);
    assert.equal(close?.fields.closed_by, 'remote');
    assert.equal(events('relay.ws.auth_probe').length, 2, 'a close frame is not second-guessed with a probe');
  });

  it('never writes the bearer token into any record', () => {
    assert.equal(JSON.stringify(records).includes(TOKEN), false);
  });
});
