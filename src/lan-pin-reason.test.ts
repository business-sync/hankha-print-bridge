import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setLogSink } from './log.js';

/*
 * Which reason a pin refusal carries.
 *
 * The server's result schema is a closed enum; a reason it does not know is a 422 and the job never
 * settles. `pin-mismatch` exists only on the M9 backend, and there is no version handshake, so the
 * Bridge sends it only when the last enrolment/heartbeat/ack answer carried a key set in the M9
 * shape (non-empty, every `not_before` a number). Everything else keeps `device-missing`.
 */

const dir = mkdtempSync(join(tmpdir(), 'hankha-pinreason-'));
process.env.PRINT_BRIDGE_STATE_DIR = dir;
writeFileSync(join(dir, 'relay.json'), JSON.stringify({ install_id: 'install-pin-0001', bridge_id: '77', token: 'bridge-token' }));
setLogSink(() => undefined);

const spki = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const numeric = () => [{ kid: 'k-1', pubkey: spki(), not_before: 0, not_after: null }];

let cloud: Server;
let base = '';
let heartbeatAnswer: unknown = {};
const posts: { id: string; body: any }[] = [];

before(async () => {
  cloud = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.includes('/jobs/') && url.endsWith('/result')) {
        posts.push({ id: url.split('/jobs/')[1]?.split('/')[0] ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200).end();
      } else if (url.endsWith('/bridge/heartbeat')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(heartbeatAnswer));
      } else {
        res.writeHead(200).end();
      }
    });
  });
  await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(cloud.address() as { port: number }).port}`;
  process.env.PRINT_BRIDGE_RELAY_URL = base;
});
after(() => {
  cloud.closeAllConnections?.();
  cloud.close();
  rmSync(dir, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 100).unref();
});

let n = 0;
async function refusal(): Promise<Record<string, any>> {
  const { handlePrint } = await import('./relay.js');
  n += 1;
  const id = `pin-job-${n}`;
  await handlePrint(base, 'bridge-token', {
    type: 'print',
    job: { job_id: id, client_job_id: `c-${n}`, kind: 'RECEIPT', target_ip: null, target_port: 9100, attempt: 1, pin_bridge_id: '78' },
  } as never);
  const deadline = Date.now() + 5_000;
  for (;;) {
    const hit = posts.find((p) => p.id === id);
    if (hit) return hit.body;
    if (Date.now() > deadline) throw new Error('no result was reported');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the reason a pin refusal carries', async () => {
  const keys = await import('./lan-keys.js');
  const fresh = () => keys.setActiveLanKeys(new keys.LanKeyStore(dir, []));

  it('by default, and with no proof about the backend: device-missing, certainty none', async () => {
    fresh();
    const r = await refusal();
    assert.equal(r.reason, 'device-missing');
    assert.equal(r.printed_certainty, 'none');
    assert.match(r.detail, /pinned to bridge 78/);
  });

  it('after a key set in the M9 shape (numeric not_before): pin-mismatch', async () => {
    fresh();
    keys.applyRelayLanKeys(numeric());
    assert.equal(keys.backendAcceptsPinMismatch(), true);
    const r = await refusal();
    assert.equal(r.reason, 'pin-mismatch');
    assert.equal(r.printed_certainty, 'none');
  });

  it('a pre-M9 key set (not_before null) is not proof, and is not trusted as keys either', async () => {
    fresh();
    keys.applyRelayLanKeys([{ kid: 'old', pubkey: spki(), not_before: null, not_after: null }]);
    assert.equal(keys.backendAcceptsPinMismatch(), false);
    assert.equal((await refusal()).reason, 'device-missing');
    assert.equal(keys.activeLanKeys()?.kids().includes('old'), false);
  });

  it('a mixed list is not proof either', () => {
    fresh();
    keys.applyRelayLanKeys([...numeric(), { kid: 'old', pubkey: spki(), not_before: null, not_after: null }]);
    assert.equal(keys.backendAcceptsPinMismatch(), false);
  });

  it('an empty key set, or none at all, proves nothing, and the next answer re-decides', () => {
    fresh();
    keys.applyRelayLanKeys(numeric());
    assert.equal(keys.backendAcceptsPinMismatch(), true);
    keys.applyRelayLanKeys([]);
    assert.equal(keys.backendAcceptsPinMismatch(), false);
    keys.applyRelayLanKeys(numeric());
    keys.applyRelayLanKeys(undefined);
    assert.equal(keys.backendAcceptsPinMismatch(), false, 'a backend that stopped sending the key set is no longer trusted with it');
  });

  it('with the LAN API off nothing is read, so the answer stays device-missing', async () => {
    keys.setActiveLanKeys(null);
    keys.applyRelayLanKeys(numeric());
    assert.equal(keys.backendAcceptsPinMismatch(), false);
    assert.equal((await refusal()).reason, 'device-missing');
  });

  it('stopping the LAN API forgets the proof', () => {
    fresh();
    keys.applyRelayLanKeys(numeric());
    keys.setActiveLanKeys(null);
    assert.equal(keys.backendAcceptsPinMismatch(), false);
  });

  it('end to end through the heartbeat answer: numeric keys then pin-mismatch, then an answer without keys and device-missing', async () => {
    fresh();
    const { heartbeat } = await import('./relay.js');
    heartbeatAnswer = { data: { lan_keys: numeric() } };
    assert.equal(await heartbeat(base, 'bridge-token'), 200);
    assert.equal((await refusal()).reason, 'pin-mismatch');
    heartbeatAnswer = { data: {} };
    assert.equal(await heartbeat(base, 'bridge-token'), 200);
    assert.equal((await refusal()).reason, 'device-missing');
  });

  it('the key parser takes a numeric not_before (0 for the active key) and refuses null', () => {
    fresh();
    const store = keys.activeLanKeys() as InstanceType<typeof keys.LanKeyStore>;
    assert.equal(store.setKeys([{ kid: 'active', pubkey: spki(), not_before: 0, not_after: null }]).accepted, 1);
    assert.equal(store.setKeys([{ kid: 'retired', pubkey: spki(), not_before: 1_700_000_000, not_after: 1_800_000_000 }]).accepted, 1);
    const nul = store.setKeys([{ kid: 'bad', pubkey: spki(), not_before: null, not_after: null }]);
    assert.equal(nul.accepted, 0);
    assert.match(nul.rejected.join(' '), /not_before/);
  });
});
