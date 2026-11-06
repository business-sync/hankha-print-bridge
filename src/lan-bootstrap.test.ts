import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_KEYS, LanKeyStore, MAX_CONFIGURED_BOOTSTRAP, parseConfiguredBootstrap, PLACEHOLDER_PUBKEY, PUBLISHED_TEST_PUBKEYS, setActiveLanKeys,
} from './lan-keys.js';
import { lanReport, readLanConfig, startLan } from './lan-server.js';
import { setLogSink, type LogRecord } from './log.js';
import vectors from './test-support/lan-vectors.json' with { type: 'json' };

/*
 * Bootstrap key provisioning (task 1 of the LAN security hardening): a Bridge that has never been
 * online can only verify a pairing grant against a key pinned at build time or written into
 * lan.json. The build's pinned key is a placeholder, so lan.json is how a venue gets a real one,
 * and the published test-vector key must never be accepted there.
 */

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'hankha-boot-'));
  dirs.push(d);
  return d;
};
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const spkiOf = (k = generateKeyPairSync('ed25519')) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const entry = (kid: string, key = generateKeyPairSync('ed25519')) => ({ kid, pubkey: spkiOf(key), not_before: 0, not_after: null });
const VECTOR_SPKI = vectors.backend_key.spki_b64u;

let logs: LogRecord[] = [];
let restore: (() => void) | null = null;
let level: string | undefined;
beforeEach(() => {
  logs = [];
  // `node --test` quiets the logger to `error`; the warnings under test are below that.
  level = process.env.PRINT_BRIDGE_LOG_LEVEL;
  process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';
  restore = setLogSink((r) => logs.push(r));
});
afterEach(() => {
  setActiveLanKeys(null);
  restore?.();
  if (level === undefined) delete process.env.PRINT_BRIDGE_LOG_LEVEL;
  else process.env.PRINT_BRIDGE_LOG_LEVEL = level;
});

describe('configured bootstrap keys: validation', () => {
  it('the constants agree with the placeholder and with the published vectors', () => {
    assert.equal(PLACEHOLDER_PUBKEY, BOOTSTRAP_KEYS[0]?.pubkey);
    assert.ok(PUBLISHED_TEST_PUBKEYS.includes(vectors.backend_key.spki_b64u), 'the vector backend key is on the refuse list');
    assert.ok(PUBLISHED_TEST_PUBKEYS.includes(vectors.bridge_key.spki_b64u), 'the vector Bridge key is on the refuse list');
  });

  it('accepts well-formed entries, with not_before defaulting to 0 and not_after to null', () => {
    const a = spkiOf();
    const { keys, rejected } = parseConfiguredBootstrap([{ kid: 'prod-1', pubkey: a }, entry('prod-2')]);
    assert.deepEqual(rejected, []);
    assert.deepEqual(keys[0], { kid: 'prod-1', pubkey: a, not_before: 0, not_after: null });
    assert.equal(keys.length, 2);
  });

  it('ignores malformed entries one by one and keeps the good ones', () => {
    const good = entry('good-1');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const bad = ['nope', null, { kid: 'bad kid!', pubkey: spkiOf() }, { kid: 'x', pubkey: 'AAAA' }, { kid: 'rsa', pubkey: rsa }, { ...entry('neg'), not_before: -1 }];
    const r = parseConfiguredBootstrap([good, ...bad.slice(0, 3)]);
    assert.deepEqual(r.keys, [good]);
    assert.equal(r.rejected.length, 3);
    // Each kind of malformed entry is refused on its own.
    for (const one of [...bad, { ...entry('backwards'), not_before: 100, not_after: 50 }]) {
      const alone = parseConfiguredBootstrap([one]);
      assert.equal(alone.keys.length, 0, JSON.stringify(one));
      assert.equal(alone.rejected.length, 1);
    }
  });

  it('reads at most four keys', () => {
    const six = Array.from({ length: 6 }, (_, i) => entry(`k${i}`));
    const { keys, rejected } = parseConfiguredBootstrap(six);
    assert.equal(keys.length, MAX_CONFIGURED_BOOTSTRAP);
    assert.deepEqual(keys.map((k) => k.kid), ['k0', 'k1', 'k2', 'k3']);
    assert.ok(rejected.some((r) => /only the first 4/.test(r)));
  });

  it('refuses the published test-vector keys by public key, whatever kid they come under', () => {
    for (const pubkey of [vectors.backend_key.spki_b64u, vectors.bridge_key.spki_b64u]) {
      const r = parseConfiguredBootstrap([{ kid: 'totally-legit-prod', pubkey, not_before: 0, not_after: null }]);
      assert.equal(r.keys.length, 0);
      assert.equal(r.testKeyRefused, true);
    }
  });

  it('refuses the placeholder, a repeated kid, and a kid the build already pins', () => {
    const a = entry('same');
    const r = parseConfiguredBootstrap([
      { kid: 'on-placeholder', pubkey: PLACEHOLDER_PUBKEY, not_before: 0, not_after: null },
      a, { ...entry('same') }, entry(BOOTSTRAP_KEYS[0]?.kid as string),
    ]);
    assert.deepEqual(r.keys, [a]);
    assert.equal(r.rejected.length, 3);
  });

  it('a non-array is one rejection, not a crash', () => {
    assert.deepEqual(parseConfiguredBootstrap({ kid: 'x' }).keys, []);
    assert.equal(parseConfiguredBootstrap(undefined).rejected.length, 0);
  });
});

describe('lan.json bootstrap_keys', () => {
  const lanJson = (dir: string, extra: Record<string, unknown>) =>
    writeFileSync(join(dir, 'lan.json'), JSON.stringify({ enabled: true, port: 9391, host: '127.0.0.1', ...extra }));

  it('carries valid entries into the config and ignores the rest with a warning', () => {
    const dir = scratch();
    const good = entry('prod-1');
    lanJson(dir, { bootstrap_keys: [good, { kid: 'bad kid', pubkey: 'x' }] });
    const config = readLanConfig(dir);
    assert.deepEqual(config?.bootstrap_keys, [good]);
    assert.ok(logs.some((l) => l.event === 'lan.bootstrap.rejected' && l.level === 'warn'));
  });

  it('a config without the field has no bootstrap_keys property at all', () => {
    const dir = scratch();
    lanJson(dir, {});
    assert.equal('bootstrap_keys' in (readLanConfig(dir) ?? {}), false);
  });

  it('refuses the vector key LOUDLY (error level) and the LAN API still starts', () => {
    const dir = scratch();
    lanJson(dir, { bootstrap_keys: [{ kid: 'vec-backend-1', pubkey: VECTOR_SPKI, not_before: 0, not_after: null }] });
    const config = readLanConfig(dir);
    assert.ok(config, 'a bad key must not switch the feature off');
    assert.equal(config?.bootstrap_keys, undefined);
    const loud = logs.find((l) => l.event === 'lan.bootstrap.test_key_refused');
    assert.ok(loud, 'logged');
    assert.equal(loud?.level, 'error');
  });
});

describe('the key store with configured keys', () => {
  it('merges them with backend-delivered keys instead of replacing either', () => {
    const dir = scratch();
    const pinned = entry('prod-1');
    const store = new LanKeyStore(dir, [...BOOTSTRAP_KEYS, pinned]);
    assert.equal(store.bootstrapPinned(), true);
    const delivered = entry('backend-live');
    assert.equal(store.setKeys([delivered]).accepted, 1);
    assert.deepEqual(store.kids(), [BOOTSTRAP_KEYS[0]?.kid, 'prod-1', 'backend-live']);
    // A later delivered list replaces the delivered set only; the pinned one stays.
    store.setKeys([entry('backend-next')]);
    assert.deepEqual(store.kids(), [BOOTSTRAP_KEYS[0]?.kid, 'prod-1', 'backend-next']);
    assert.ok(store.verifierFor('prod-1', 5));
    // And across a restart the delivered set comes back next to the configured one.
    assert.deepEqual(new LanKeyStore(dir, [...BOOTSTRAP_KEYS, pinned]).kids(), [BOOTSTRAP_KEYS[0]?.kid, 'prod-1', 'backend-next']);
  });

  it('a delivered key cannot take over a configured kid', () => {
    const store = new LanKeyStore(scratch(), [...BOOTSTRAP_KEYS, entry('prod-1')]);
    const r = store.setKeys([entry('prod-1'), entry('other')]);
    assert.equal(r.accepted, 1);
    assert.ok(r.rejected.some((x) => /pinned in this build/.test(x)));
  });

  it('bootstrapPinned is false for the placeholder alone and for no keys at all', () => {
    assert.equal(new LanKeyStore(scratch()).bootstrapPinned(), false);
    assert.equal(new LanKeyStore(scratch(), []).bootstrapPinned(), false);
  });
});

describe('startLan: report field and startup warning', () => {
  const started: Array<{ stop(): Promise<void> }> = [];
  // A failing assertion must not leave a listener behind to hang the whole run.
  afterEach(async () => {
    for (const h of started.splice(0)) await h.stop();
  });
  const start = (o: Parameters<typeof startLan>[0]) => {
    const h = startLan(o);
    if (h) started.push(h);
    return h;
  };
  const free = () =>
    new Promise<number>((resolve) => {
      const s = netServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
  const deps = {
    queue: () => { throw new Error('not used'); },
    installId: () => 'i',
    bridgeId: () => null,
    relayConnected: () => false,
    reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
    pairingDeps: { relayBase: () => 'http://127.0.0.1:9' },
  } as unknown as Parameters<typeof startLan>[0];

  it('a stop() that arrives before the port is bound does not leave a listener behind', async () => {
    const port = await free();
    const h = start({ ...deps, dir: scratch(), config: { port, host: '127.0.0.1' } });
    assert.ok(h);
    await h.stop();
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/lan/v1/hello`), 'nothing is listening any more');
  });

  it('reports bootstrap_pinned:false with only the placeholder, and warns when pairing is on', async () => {
    const dir = scratch();
    assert.ok(start({ ...deps, dir, config: { port: await free(), host: '127.0.0.1', pairing_over_lan: true } }));
    assert.equal(lanReport()?.bootstrap_pinned, false);
    const warn = logs.find((l) => l.event === 'lan.pair.no_bootstrap_key');
    assert.ok(warn);
    assert.equal(warn?.level, 'warn');
    assert.match(warn?.msg ?? '', /LAN pairing cannot verify any grant until a bootstrap key is configured/);
  });

  it('does not warn when pairing is off, even with nothing pinned', async () => {
    start({ ...deps, dir: scratch(), config: { port: await free(), host: '127.0.0.1' } });
    assert.equal(lanReport()?.bootstrap_pinned, false);
    assert.equal(logs.some((l) => l.event === 'lan.pair.no_bootstrap_key'), false);
  });

  it('reports bootstrap_pinned:true and stays quiet once a real key is configured', async () => {
    start({
      ...deps, dir: scratch(), config: { port: await free(), host: '127.0.0.1', pairing_over_lan: true, bootstrap_keys: [entry('prod-1')] },
    });
    assert.equal(lanReport()?.bootstrap_pinned, true);
    assert.ok(lanReport()?.key_ids.includes('prod-1'));
    assert.equal(logs.some((l) => l.event === 'lan.pair.no_bootstrap_key'), false);
  });
});

describe('scripts/gen-lan-signing-key.mjs', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/gen-lan-signing-key.mjs', import.meta.url));
  const run = (args: string[], cwd: string) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  const field = (out: string, name: string) => new RegExp(`${name}[=:]\\s*(\\S+)`).exec(out)?.[1] as string;

  it('prints a usable pair, with the secret warning on stderr, and writes NOTHING to disk by default', () => {
    const cwd = scratch();
    const r = run([], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(cwd), [], 'no file is created without --out');
    assert.match(r.stderr, /SECRET WARNING/);
    assert.match(r.stderr, /nothing was written to disk/);

    const pkcs8 = field(r.stdout, 'PRINT_LAN_SIGNING_KEY');
    const kid = field(r.stdout, 'PRINT_LAN_SIGNING_KID');
    const spki = field(r.stdout, 'SPKI base64url');
    assert.match(kid, /^[A-Za-z0-9._-]{1,32}$/, 'a kid the backend accepts');
    // The backend loads it exactly like this (print.lan.keys.ts loadSigner): standard base64 PKCS8.
    const priv = createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    assert.equal(priv.asymmetricKeyType, 'ed25519');
    assert.equal(createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64url'), spki);
    // And the public half, as printed, is acceptable to the Bridge's own parser and verifies.
    const parsed = parseConfiguredBootstrap([{ kid, pubkey: spki, not_before: 0, not_after: null }]);
    assert.equal(parsed.keys.length, 1);
    const sig = cryptoSign(null, Buffer.from('x'), priv);
    assert.ok(cryptoVerify(null, Buffer.from('x'), createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' }), sig));
    // The suggested lan.json snippet carries the public key and no secret.
    assert.ok(r.stdout.includes('"bootstrap_keys"'));
    assert.equal(r.stdout.split(pkcs8).length - 1, 1, 'the secret appears exactly once');
  });

  it('two runs make two different keys', () => {
    const cwd = scratch();
    assert.notEqual(field(run([], cwd).stdout, 'SPKI base64url'), field(run([], cwd).stdout, 'SPKI base64url'));
  });

  it('--out writes a new file at mode 0600 and refuses to overwrite it', (t) => {
    const cwd = scratch();
    const r = run(['--out', 'key.json', '--kid', 'lan-test-1'], cwd);
    assert.equal(r.status, 0, r.stderr);
    if (process.platform !== 'win32') assert.equal(statSync(join(cwd, 'key.json')).mode & 0o777, 0o600);
    else t.diagnostic('POSIX modes do not apply on Windows');
    const saved = JSON.parse(readFileSync(join(cwd, 'key.json'), 'utf8')) as { kid: string; pkcs8_base64: string; spki_b64u: string };
    assert.equal(saved.kid, 'lan-test-1');
    assert.equal(saved.spki_b64u, field(r.stdout, 'SPKI base64url'));
    const before = readFileSync(join(cwd, 'key.json'), 'utf8');
    const again = run(['--out', 'key.json'], cwd);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists/);
    assert.equal(readFileSync(join(cwd, 'key.json'), 'utf8'), before, 'the existing key file is untouched');
  });

  it('--public-only never prints a secret; a bad --kid and --out with --public-only are refused', () => {
    const cwd = scratch();
    const r = run(['--public-only'], cwd);
    assert.equal(r.status, 0);
    assert.ok(!/PRINT_LAN_SIGNING_KEY|pkcs8/i.test(r.stdout));
    assert.equal(run(['--kid', 'has space'], cwd).status, 2);
    assert.equal(run(['--kid', 'x'.repeat(33)], cwd).status, 2);
    assert.equal(run(['--out', 'k.json', '--public-only'], cwd).status, 2);
    assert.deepEqual(readdirSync(cwd), []);
  });
});

// ---------------------------------------------------------------------- a real Bridge process

describe('pairing grant against configured bootstrap keys, in a real Bridge process', () => {
  const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
  const b64u = (b: Buffer) => b.toString('base64url');
  const free = () =>
    new Promise<number>((resolve) => {
      const s = netServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
  const until = async (ready: () => boolean | Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  async function startBridge(lanJson: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-bootproc-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'lan.json'), JSON.stringify(lanJson));
    const port = await free();
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: {
        ...process.env, PRINT_BRIDGE_PORT: String(port), PRINT_BRIDGE_HOST: '127.0.0.1', PRINT_BRIDGE_STATE_DIR: dir,
        PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9', PRINT_BRIDGE_LOG_FORMAT: 'text', PRINT_BRIDGE_LOG_LEVEL: 'info',
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

  function grant(o: { kid: string; key: ReturnType<typeof createPrivateKey>; install_id: string; token_hash: string; bridge_pubkey: string; grant_id: string }): string {
    const iat = Math.floor(Date.now() / 1000) - 5;
    const json = JSON.stringify({
      v: 1, kind: 'bridge_grant', grant_id: o.grant_id, org_id: '2', branch_id: '8', bridge_id: '77', install_id: o.install_id,
      token_hash: o.token_hash, bridge_pubkey: o.bridge_pubkey, lan_keys: [], kid: o.kid, iat, exp: iat + 600,
    });
    return `${b64u(Buffer.from(json))}.${b64u(cryptoSign(null, Buffer.from(json), o.key))}`;
  }

  it('accepts a grant signed by the configured key and refuses one signed by the published vector key, even when lan.json lists it', async () => {
    const real = generateKeyPairSync('ed25519');
    const vectorPriv = createPrivateKey({ key: Buffer.from(vectors.backend_key.pkcs8_b64u, 'base64url'), format: 'der', type: 'pkcs8' });
    const lanPort = await free();
    const b = await startBridge({
      enabled: true, port: lanPort, host: '127.0.0.1', pairing_over_lan: true,
      bootstrap_keys: [
        // The operator (or an attacker with write access to lan.json, or a copy-paste from the docs) lists the vector key first.
        { kid: vectors.backend_key.kid, pubkey: VECTOR_SPKI, not_before: 0, not_after: null },
        { kid: 'venue-prod-1', pubkey: spkiOf(real), not_before: 0, not_after: null },
      ],
    });
    const lan = `http://127.0.0.1:${lanPort}`;
    await until(async () => {
      try {
        return (await fetch(`${lan}/lan/v1/hello`)).ok;
      } catch {
        return false;
      }
    }, 'the LAN listener');
    assert.match(b.output(), /bootstrap_keys names the published TEST key/, 'logged loudly at startup');
    assert.ok(!/cannot verify any grant until a bootstrap key/.test(b.output()), 'a real key is pinned, so no warning');

    const info = (await (await fetch(`${lan}/lan/v1/pair-info`)).json()) as { install_id: string; token_hash: string; bridge_pubkey: string };
    const code = ((await (await fetch(`http://127.0.0.1:${b.port}/pairing`)).json()) as { lan: { code: string } }).lan.code;
    const base = { install_id: info.install_id, token_hash: info.token_hash, bridge_pubkey: info.bridge_pubkey };

    // 1. A grant signed by the vector key, under the vector kid: the key is not trusted.
    const forged = grant({ ...base, kid: vectors.backend_key.kid, key: vectorPriv, grant_id: 'grant-forged-0001' });
    const refused = await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: JSON.stringify({ code, grant: forged }) });
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { reason: string }).reason, 'grant_unknown_kid');
    // 2. The same forgery under the kid of the real key: the signature is not that key's.
    const impostor = grant({ ...base, kid: 'venue-prod-1', key: vectorPriv, grant_id: 'grant-forged-0002' });
    const refused2 = await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: JSON.stringify({ code, grant: impostor }) });
    assert.equal(refused2.status, 403);
    assert.equal(((await refused2.json()) as { reason: string }).reason, 'grant_invalid');
    assert.equal(existsSync(join(b.dir, 'relay.json')) && 'token' in JSON.parse(readFileSync(join(b.dir, 'relay.json'), 'utf8')), false, 'nothing was paired');

    // 3. The real one.
    const good = grant({ ...base, kid: 'venue-prod-1', key: real.privateKey, grant_id: 'grant-real-00001' });
    const ok = await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: JSON.stringify({ code, grant: good }) });
    assert.equal(ok.status, 200, await ok.clone().text());
    const relay = JSON.parse(readFileSync(join(b.dir, 'relay.json'), 'utf8')) as Record<string, string>;
    assert.equal(relay.paired_via, 'lan');
    assert.equal(createHash('sha256').update(relay.token as string, 'utf8').digest('hex'), info.token_hash);
    assert.ok(!b.output().includes(relay.token as string), 'the token is not in the log');
  });

  it('with pairing on and nothing pinned, says so at startup and refuses every grant', async () => {
    const lanPort = await free();
    const b = await startBridge({ enabled: true, port: lanPort, host: '127.0.0.1', pairing_over_lan: true });
    const lan = `http://127.0.0.1:${lanPort}`;
    await until(async () => {
      try {
        return (await fetch(`${lan}/lan/v1/hello`)).ok;
      } catch {
        return false;
      }
    }, 'the LAN listener');
    assert.match(b.output(), /LAN pairing cannot verify any grant until a bootstrap key is configured/);
    const info = (await (await fetch(`${lan}/lan/v1/pair-info`)).json()) as { install_id: string; token_hash: string; bridge_pubkey: string };
    const code = ((await (await fetch(`http://127.0.0.1:${b.port}/pairing`)).json()) as { lan: { code: string } }).lan.code;
    const key = generateKeyPairSync('ed25519');
    const g = grant({ ...info, kid: 'venue-prod-1', key: key.privateKey, grant_id: 'grant-nokey-0001' });
    const r = await fetch(`${lan}/lan/v1/pair`, { method: 'POST', body: JSON.stringify({ code, grant: g }) });
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as { reason: string }).reason, 'grant_unknown_kid');
  });
});
