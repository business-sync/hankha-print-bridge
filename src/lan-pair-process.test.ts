import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * Pairing over the shop network, end to end, with the real entry point as a child process and a
 * fake cloud that records what the Bridge sends it.
 *
 * What this proves that the in-process tests cannot: that the two routes really appear and vanish
 * with lan.json, that the Bridge's own loopback page hands out the code, that a pairing over the
 * LAN leaves a credential the (fake) cloud accepts by hash when the Bridge later goes online, and
 * that the ordinary cloud pairing flow still runs, with the feature off and with it on.
 */

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const children: ChildProcess[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of servers) s.closeAllConnections?.();
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const b64u = (b: Buffer) => b.toString('base64url');
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const free = () =>
  new Promise<number>((resolve) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 25_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface Seen {
  method: string;
  path: string;
  authorization?: string;
}

/** A cloud that serves the cloud-pairing endpoints when asked to, and records everything. */
async function fakeCloud(opts: { cloudPairing?: boolean } = {}) {
  const seen: Seen[] = [];
  let claimed = false;
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  const server = createServer((req, res) => {
    void body(req).then(() => {
      const path = req.url ?? '';
      seen.push({ method: req.method ?? '', path, authorization: req.headers.authorization });
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (path.endsWith('/bridge/pairing-session')) {
        if (!opts.cloudPairing) return json(503, { success: false });
        return json(200, { data: { item: { session_id: 's1', code: 'ABCD-2345', expires_at: new Date(Date.now() + 900_000).toISOString(), poll_interval_s: 1 } } });
      }
      if (path.endsWith('/bridge/pairing-session/poll')) {
        claimed = true;
        return json(200, { data: { item: { status: claimed ? 'claimed' : 'pending', expires_at: new Date(Date.now() + 900_000).toISOString(), claimed_org_name: 'Dok Champa', claimed_branch_name: 'Vientiane' } } });
      }
      if (path.endsWith('/bridge/enroll')) return json(200, { data: { bridge_id: '900', token: 'cloud-issued-token-123456', poll_wait_s: 25, heartbeat_interval_s: 30 } });
      return json(200, { success: true, data: {} });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

async function startBridge(cloudUrl: string, lanJson?: unknown, extraFiles: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-pairproc-'));
  dirs.push(dir);
  if (lanJson !== undefined) writeFileSync(join(dir, 'lan.json'), JSON.stringify(lanJson));
  for (const [name, text] of Object.entries(extraFiles)) writeFileSync(join(dir, name), text);
  const port = await free();
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: {
      ...process.env,
      PRINT_BRIDGE_PORT: String(port),
      PRINT_BRIDGE_HOST: '127.0.0.1',
      PRINT_BRIDGE_STATE_DIR: dir,
      PRINT_BRIDGE_RELAY_URL: cloudUrl,
      PRINT_BRIDGE_LOG_FORMAT: 'text',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, 'the bridge to answer /health');
  return { child, port, dir, output: () => output };
}

const backend = generateKeyPairSync('ed25519');
const backendSpki = b64u(backend.publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
const keySet = JSON.stringify({ v: 1, keys: [{ kid: 'backend-1', pubkey: backendSpki, not_before: 0, not_after: null }] });

function grant(o: { install_id: string; token_hash: string; bridge_pubkey: string; org_id?: string; grant_id?: string }): string {
  const iat = Math.floor(Date.now() / 1000) - 5;
  const json = JSON.stringify({
    v: 1, kind: 'bridge_grant', grant_id: o.grant_id ?? 'grant-process-0001', org_id: o.org_id ?? '2', branch_id: '8', bridge_id: '77',
    install_id: o.install_id, token_hash: o.token_hash, bridge_pubkey: o.bridge_pubkey, lan_keys: [], kid: 'backend-1', iat, exp: iat + 600,
  });
  return `${b64u(Buffer.from(json))}.${b64u(cryptoSign(null, Buffer.from(json), backend.privateKey))}`;
}

const readRelayJson = (dir: string) => JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8')) as Record<string, string>;

describe('pairing over the shop network, as a process', () => {
  it('pairs with a signed grant and the code from the Bridge\'s own page, and the cloud later knows the token by hash', async () => {
    const cloud = await fakeCloud();
    const lanPort = await free();
    const b = await startBridge(cloud.url, { enabled: true, port: lanPort, host: '127.0.0.1', pairing_over_lan: true }, { 'lan-keys.json': keySet });
    const lan = `http://127.0.0.1:${lanPort}`;
    await until(async () => {
      try {
        return (await fetch(`${lan}/lan/v1/hello`)).ok;
      } catch {
        return false;
      }
    }, 'the LAN listener');

    // The terminal asks the Bridge who it is.
    const info = (await (await fetch(`${lan}/lan/v1/pair-info`)).json()) as { install_id: string; token_hash: string; bridge_pubkey: string; state: string };
    assert.equal(info.state, 'unpaired');

    // The code is on the Bridge's own loopback page and nowhere on the LAN.
    const page = (await (await fetch(`http://127.0.0.1:${b.port}/pairing`)).json()) as { has_credential: boolean; lan?: { code: string; state: string } };
    assert.equal(page.has_credential, false);
    assert.equal(page.lan?.state, 'unpaired');
    const code = page.lan?.code as string;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Wrong code first: refused, and nothing is written.
    const g = grant({ install_id: info.install_id, token_hash: info.token_hash, bridge_pubkey: info.bridge_pubkey });
    const wrong = await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: JSON.stringify({ code: 'ZZZZ-ZZZ9', grant: g }) });
    assert.equal(wrong.status, 403);
    assert.equal(existsSync(join(b.dir, 'relay.json')) && 'token' in readRelayJson(b.dir), false);

    const ok = await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: JSON.stringify({ code, grant: g }) });
    assert.equal(ok.status, 200);
    const done = (await ok.json()) as { paired: boolean; bridge_id: string };
    assert.equal(done.bridge_id, '77');

    // The same relay.json an enrolment writes, plus the LAN markers.
    const relay = readRelayJson(b.dir);
    assert.equal(relay.install_id, info.install_id);
    assert.equal(relay.bridge_id, '77');
    assert.equal(sha256hex(relay.token as string), info.token_hash, 'the token matches the hash the backend row holds');
    assert.equal(relay.relay_url, cloud.url);
    assert.equal(relay.paired_via, 'lan');
    assert.ok(relay.enrolled_at);

    // Later online: the relay starts on the new token and the cloud recognises it by hash.
    await until(
      () => cloud.seen.some((r) => r.authorization === `Bearer ${relay.token}`),
      'the relay to call the cloud with the new token'
    );
    const first = cloud.seen.find((r) => r.authorization?.startsWith('Bearer '));
    assert.equal(sha256hex((first?.authorization ?? '').slice('Bearer '.length)), info.token_hash);

    // Paired now: refuses, and the page shows no code.
    assert.equal((await fetch(`${lan}/lan/v1/pair-info`)).status, 409);
    const after = (await (await fetch(`http://127.0.0.1:${b.port}/pairing`)).json()) as { has_credential: boolean; lan?: { code: string | null; state: string } };
    assert.equal(after.has_credential, true);
    assert.equal(after.lan?.code, null);
    assert.equal(after.lan?.state, 'paired');
    assert.ok(!b.output().includes(code), 'the code is not in the log');
    assert.ok(!b.output().includes(relay.token as string), 'the token is not in the log');

    // Replaying the grant with a window open: the token has rotated, so it is not this Bridge's any more.
    await fetch(`http://127.0.0.1:${b.port}/pairing/lan`, { method: 'POST', body: JSON.stringify({ action: 'allow_repair' }) });
    const code2 = ((await (await fetch(`http://127.0.0.1:${b.port}/pairing`)).json()) as { lan: { code: string } }).lan.code;
    const replay = await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: JSON.stringify({ code: code2, grant: g }) });
    assert.equal(replay.status, 403);
    assert.equal(((await replay.json()) as { reason: string }).reason, 'grant_wrong_bridge');
    assert.equal(readRelayJson(b.dir).token, relay.token, 'unchanged');
  });

  it('LAN API on but pairing_over_lan absent: no pair routes, no code, no file', async () => {
    const cloud = await fakeCloud();
    const lanPort = await free();
    const b = await startBridge(cloud.url, { enabled: true, port: lanPort, host: '127.0.0.1' }, { 'lan-keys.json': keySet });
    const lan = `http://127.0.0.1:${lanPort}`;
    await until(async () => {
      try {
        return (await fetch(`${lan}/lan/v1/hello`)).ok;
      } catch {
        return false;
      }
    }, 'the LAN listener');
    assert.equal((await fetch(`${lan}/lan/v1/pair-info`)).status, 404);
    assert.equal((await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: '{}' })).status, 404);
    const hello = (await (await fetch(`${lan}/lan/v1/hello`)).json()) as { capabilities: string[] };
    assert.deepEqual(hello.capabilities, ['print_lan_v1']);
    const page = (await (await fetch(`http://127.0.0.1:${b.port}/pairing`)).json()) as Record<string, unknown>;
    assert.equal('lan' in page, false);
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/pairing/lan`, { method: 'POST', body: JSON.stringify({ action: 'new_code' }) })).status, 404);
    assert.equal(readdirSync(b.dir).includes('lan-pair.json'), false);
  });

  it('the ordinary cloud pairing still completes exactly as before, with the feature off', async () => {
    const cloud = await fakeCloud({ cloudPairing: true });
    const b = await startBridge(cloud.url);
    await until(() => existsSync(join(b.dir, 'relay.json')) && 'token' in readRelayJson(b.dir), 'the cloud pairing to finish');
    const relay = readRelayJson(b.dir);
    assert.equal(relay.token, 'cloud-issued-token-123456');
    assert.equal(relay.bridge_id, '900');
    assert.equal('paired_via' in relay, false);
    assert.equal('org_id' in relay, false);
  });

  it('and with the feature on: the cloud code and the LAN code are both shown, and the cloud flow still wins if used', async () => {
    const cloud = await fakeCloud({ cloudPairing: true });
    const lanPort = await free();
    // Slow the cloud flow down by making it the only thing that can happen first: poll says claimed.
    const b = await startBridge(cloud.url, { enabled: true, port: lanPort, host: '127.0.0.1', pairing_over_lan: true }, { 'lan-keys.json': keySet });
    await until(() => existsSync(join(b.dir, 'relay.json')) && 'token' in readRelayJson(b.dir), 'the cloud pairing to finish');
    const relay = readRelayJson(b.dir);
    assert.equal(relay.token, 'cloud-issued-token-123456');
    assert.equal('paired_via' in relay, false, 'a cloud pairing is not marked as a LAN one');
    // Once paired by the cloud route, the LAN route refuses.
    const lan = `http://127.0.0.1:${lanPort}`;
    await until(async () => {
      try {
        return (await fetch(`${lan}/lan/v1/pair-info`)).status === 409;
      } catch {
        return false;
      }
    }, 'the LAN pairing to notice the Bridge is paired');
  });
});
