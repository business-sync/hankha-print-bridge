import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

/*
 * Re-pairing a bridge that is CONNECTED. The scan saves the new token first; the server then
 * revokes the old row, and the live loop hears a 401 a few seconds later. `wakeRelay` only wakes
 * a loop that is already waiting, so it does nothing here — and the loop used to sit out a
 * 30–60 s backoff with the dead token before re-reading the one on disk.
 *
 * Its own file because the loop's state is module-global and `node --test` gives every file a
 * fresh process.
 */

const dir = mkdtempSync(join(tmpdir(), 'hankha-bridge-repair-'));
process.env.PRINT_BRIDGE_STATE_DIR = dir;
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'poll';

let server: Server;
let accepted = 'old-token';
const seen: string[] = [];
const waitFor = async (cond: () => boolean, ms = 4000) => {
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

describe('relay loop after a re-pair', () => {
  it('switches to the newly saved token at the first 401, without a backoff', async () => {
    server = createServer((req, res) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (req.url?.includes('/bridge/work')) {
        seen.push(token);
        // A short pause stands in for the long poll, so the loop does not spin.
        setTimeout(() => res.writeHead(token === accepted ? 204 : 401).end(), 50);
      } else {
        res.writeHead(token === accepted ? 200 : 401).end();
      }
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '18', token: 'old-token' });

    const relay = await import('./relay.js');
    relay.startRelay();
    await waitFor(() => relay.relayStatus().connected);

    // The scan: new credential on disk, then the server revokes the old one. No wakeRelay —
    // the loop was not waiting, which is exactly the case it could not help with.
    saveState({ ...loadState(), bridge_id: '19', token: 'new-token' });
    accepted = 'new-token';

    // Well inside the 32 s minimum backoff for a rejected token.
    await waitFor(() => seen.at(-1) === 'new-token' && relay.relayStatus().connected, 3000);
    assert.equal(relay.relayStatus().bridge_id, '19');
    assert.equal(relay.isRelayRejected(), false);
    assert.equal(relay.relayStatus().last_error, null);
  });
});
