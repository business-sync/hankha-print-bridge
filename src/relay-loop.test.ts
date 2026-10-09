import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

/*
 * The bridge must only stop being connected when the user removes it. A 401 used to END the relay
 * loop, so one rejection — from a proxy, from replica lag right after enrolment — disconnected the
 * venue until someone re-paired by hand. This file runs the real loop against a fake API.
 *
 * Its own file because the loop's state (`relayRunning`, `status`) is module-global, and
 * `node --test` gives every file a fresh process.
 */

const dir = mkdtempSync(join(tmpdir(), 'hankha-bridge-loop-'));
process.env.PRINT_BRIDGE_STATE_DIR = dir;
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'poll';

let answer: 204 | 401 | 403 = 401;
let server: Server;
const waitFor = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

after(() => {
  // The loop never ends by design, so the process has to be told to.
  server?.closeAllConnections?.();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

describe('relay loop', () => {
  it('keeps running after a 401, and reconnects when the token is accepted again', async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('/bridge/work')) res.writeHead(answer).end();
      else res.writeHead(200).end();
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    // The developer's .env may pin a real relay URL, which beats the one in the state file.
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '9', token: 'old-token' });

    const relay = await import('./relay.js');
    relay.startRelay();

    await waitFor(() => relay.isRelayRejected());
    assert.equal(relay.isRelayRunning(), true, 'a rejected token must not end the loop');
    assert.equal(relay.relayStatus().connected, false);
    assert.match(relay.relayStatus().last_error ?? '', /token rejected/);

    // Re-paired from the local page: new token saved, loop woken, no restart.
    answer = 204;
    saveState({ ...loadState(), token: 'new-token' });
    relay.wakeRelay();
    await waitFor(() => relay.relayStatus().connected);
    assert.equal(relay.relayStatus().last_error, null);
    assert.equal(relay.isRelayRejected(), false);
  });

  it('treats a 403 as a transient fault, not a rejected credential', async () => {
    const relay = await import('./relay.js');
    answer = 403;
    await waitFor(() => !relay.relayStatus().connected);
    assert.equal(relay.isRelayRunning(), true);
    assert.equal(relay.isRelayRejected(), false);
    assert.match(relay.relayStatus().last_error ?? '', /HTTP 403/);
  });
});
