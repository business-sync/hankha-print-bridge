import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { activeLanKeys, applyRelayLanKeys, BOOTSTRAP_KEYS, fromB64u, LanKeyStore, parseKeyEntry, setActiveLanKeys } from './lan-keys.js';
import { lanReport, readLanConfig, startLan } from './lan-server.js';
import { setLogSink } from './log.js';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'hankha-lankeys-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
let restoreLog: (() => void) | null = null;
beforeEach(() => {
  restoreLog = setLogSink(() => undefined);
});
afterEach(() => {
  setActiveLanKeys(null);
  restoreLog?.();
});

const spkiOf = (k = generateKeyPairSync('ed25519')) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

describe('the Bridge key', () => {
  it('is not created until something asks for it', () => {
    const dir = scratch();
    new LanKeyStore(dir, []);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('is created once, at mode 0600, and is the same key next time', (t) => {
    const dir = scratch();
    const a = new LanKeyStore(dir, []);
    const pub = a.publicKey();
    assert.ok(existsSync(join(dir, 'lan-key.json')));
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'lan-key.json')).mode & 0o777, 0o600);
    else t.diagnostic('POSIX modes do not apply on Windows');
    assert.equal(new LanKeyStore(dir, []).publicKey(), pub);
    assert.equal(a.sign('x'), new LanKeyStore(dir, []).sign('x'), 'Ed25519 signatures are deterministic');
  });

  it('is replaced, loudly and without destroying the old file, when it cannot be read', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'lan-key.json'), '{ not json');
    const logs: string[] = [];
    restoreLog?.();
    restoreLog = setLogSink((r) => logs.push(r.event ?? ''));
    const pub = new LanKeyStore(dir, []).publicKey();
    assert.ok(pub.length > 20);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('lan-key.json.unreadable-')), 'the unreadable copy is kept');
    assert.ok(logs.includes('lan.key.unreadable'));
  });
});

describe('the ticket key set', () => {
  const entry = (kid: string, key = generateKeyPairSync('ed25519')) => ({ kid, pubkey: spkiOf(key), not_before: 0, not_after: null });

  it('pins the bootstrap key and nothing else by default', () => {
    const store = new LanKeyStore(scratch());
    assert.deepEqual(store.kids(), BOOTSTRAP_KEYS.map((k) => k.kid));
  });

  it('the pinned placeholder verifies nothing: no one holds its private half', () => {
    // A ticket signed by any key we can make is refused by it, and it is not any published test key.
    const store = new LanKeyStore(scratch());
    const key = store.verifierFor(BOOTSTRAP_KEYS[0]?.kid as string, 1);
    assert.ok(key, 'it is a valid Ed25519 key, so a real one can replace it in place');
  });

  it('keeps what the backend sends, across a restart', () => {
    const dir = scratch();
    const store = new LanKeyStore(dir, []);
    const result = store.setKeys([entry('backend-1'), entry('backend-2')]);
    assert.equal(result.accepted, 2);
    assert.equal(result.changed, true);
    assert.deepEqual(new LanKeyStore(dir, []).kids(), ['backend-1', 'backend-2']);
    assert.equal(store.setKeys([entry('backend-1'), entry('backend-2')]).changed, true, 'new key material, so changed');
  });

  it('does not rewrite the file when the same set arrives again', () => {
    const dir = scratch();
    const store = new LanKeyStore(dir, []);
    const set = [entry('backend-1')];
    store.setKeys(set);
    const before = statSync(join(dir, 'lan-keys.json')).mtimeMs;
    const again = store.setKeys(set);
    assert.equal(again.changed, false);
    assert.equal(statSync(join(dir, 'lan-keys.json')).mtimeMs, before);
  });

  it('an empty or wholly invalid answer changes nothing: a backend mistake cannot lock every terminal out', () => {
    const dir = scratch();
    const store = new LanKeyStore(dir, []);
    store.setKeys([entry('backend-1')]);
    assert.equal(store.setKeys([]).changed, false);
    assert.equal(store.setKeys([{ kid: 'x', pubkey: 'not a key' }]).changed, false);
    assert.equal(store.setKeys('nonsense' as unknown).changed, false);
    assert.deepEqual(store.kids(), ['backend-1']);
  });

  it('refuses a key that claims a pinned kid, a repeated kid, and keys that are not Ed25519', () => {
    const store = new LanKeyStore(scratch());
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const result = store.setKeys([
      entry(BOOTSTRAP_KEYS[0]?.kid as string),
      entry('dup'), entry('dup'),
      { kid: 'wrong-curve', pubkey: p256, not_before: 0, not_after: null },
      entry('fine'),
    ]);
    assert.equal(result.accepted, 2);
    assert.equal(result.rejected.length, 3);
    assert.deepEqual(store.kids(), [...BOOTSTRAP_KEYS.map((k) => k.kid), 'dup', 'fine']);
  });

  it('judges a key\'s validity by the ticket\'s issue time, so a rotated-out key still verifies what it issued', () => {
    const store = new LanKeyStore(scratch(), []);
    const key = generateKeyPairSync('ed25519');
    store.setKeys([{ kid: 'old', pubkey: spkiOf(key), not_before: 1_000, not_after: 2_000 }]);
    assert.ok(store.verifierFor('old', 1_500));
    assert.equal(store.verifierFor('old', 999), null, 'before it was valid');
    assert.equal(store.verifierFor('old', 2_001), null, 'issued after it was retired');
    assert.equal(store.verifierFor('nobody', 1_500), null);
  });

  it('parses entries strictly', () => {
    const k = spkiOf();
    assert.equal(typeof parseKeyEntry({ kid: 'ok', pubkey: k, not_before: 0, not_after: null }), 'object');
    assert.equal(typeof parseKeyEntry({ kid: 'ok', pubkey: k }), 'object', 'not_before defaults to 0, not_after to open-ended');
    assert.equal(typeof parseKeyEntry({ kid: 'has space', pubkey: k }), 'string');
    assert.equal(typeof parseKeyEntry({ kid: 'ok', pubkey: k, not_before: -1 }), 'string');
    assert.equal(typeof parseKeyEntry({ kid: 'ok', pubkey: k, not_before: 10, not_after: 5 }), 'string');
    assert.equal(typeof parseKeyEntry(null), 'string');
  });

  it('decodes base64url strictly', () => {
    assert.ok(fromB64u('AAAA'));
    assert.equal(fromB64u('AAAA='), null, 'padding is not base64url');
    assert.equal(fromB64u('AA+A'), null, 'nor is the standard alphabet');
    assert.equal(fromB64u('AAAAA'), null, 'a length no byte string encodes to');
    assert.equal(fromB64u(''), null);
    assert.equal(fromB64u(5), null);
  });

  it('applyRelayLanKeys writes nothing while the LAN API is off', () => {
    const dir = scratch();
    assert.equal(activeLanKeys(), null);
    applyRelayLanKeys([entry('backend-1')]);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('applyRelayLanKeys updates the active set while it is on', () => {
    const store = new LanKeyStore(scratch(), []);
    setActiveLanKeys(store);
    applyRelayLanKeys([entry('from-heartbeat')]);
    assert.deepEqual(store.kids(), ['from-heartbeat']);
    applyRelayLanKeys(undefined);
    applyRelayLanKeys(null);
    assert.deepEqual(store.kids(), ['from-heartbeat']);
  });
});

describe('lan.json', () => {
  const write = (dir: string, v: unknown) => writeFileSync(join(dir, 'lan.json'), typeof v === 'string' ? v : JSON.stringify(v));

  it('is OFF with no file, and the Bridge writes none', () => {
    const dir = scratch();
    assert.equal(readLanConfig(dir), null);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('is on only for exactly enabled:true, with the documented defaults', () => {
    const dir = scratch();
    write(dir, { enabled: true });
    assert.deepEqual(readLanConfig(dir), { port: 9201, host: '0.0.0.0' });
    write(dir, { enabled: true, port: 9300, host: '192.168.1.5' });
    assert.deepEqual(readLanConfig(dir), { port: 9300, host: '192.168.1.5' });
    for (const off of [{}, { enabled: false }, { enabled: 'true' }, { enabled: 1 }, { port: 9201 }, [], 'x', null]) {
      write(dir, off as unknown);
      assert.equal(readLanConfig(dir), null, JSON.stringify(off));
    }
  });

  it('fails closed on a broken file, a bad port or host, or the main port', () => {
    const dir = scratch();
    write(dir, '{ nope');
    assert.equal(readLanConfig(dir), null);
    for (const bad of [{ port: 0 }, { port: 70000 }, { port: 9201.5 }, { port: '9201' }, { host: '' }, { host: 5 }]) {
      write(dir, { enabled: true, ...bad });
      assert.equal(readLanConfig(dir), null, JSON.stringify(bad));
    }
    write(dir, { enabled: true, port: 9200 });
    assert.equal(readLanConfig(dir, 9200), null, 'the same port as the main listener');
  });
});

describe('starting and stopping the listener', () => {
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
  } as unknown as Parameters<typeof startLan>[0];

  it('with no lan.json: opens nothing, creates nothing, reports nothing', () => {
    const dir = scratch();
    const handle = startLan({ ...deps, dir });
    assert.equal(handle, null);
    assert.equal(lanReport(), null);
    assert.equal(activeLanKeys(), null);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('with lan.json: listens, reports its key and port, and closes when stopped', async () => {
    const dir = scratch();
    const port = await free();
    const handle = startLan({ ...deps, dir, config: { port, host: '127.0.0.1' } });
    assert.ok(handle);
    await new Promise((r) => handle.server.once('listening', r).listening && r(null));
    const hello = await fetch(`http://127.0.0.1:${port}/lan/v1/hello`);
    assert.equal(hello.status, 200);
    const report = lanReport();
    assert.equal(report?.listening, true);
    assert.equal(report?.port, port);
    assert.equal(report?.pubkey, handle.keys.publicKey());
    assert.ok(report?.key_ids.length);
    assert.ok(activeLanKeys());
    await handle.stop();
    assert.equal(lanReport(), null);
    assert.equal(activeLanKeys(), null);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/lan/v1/hello`));
  });

  it('survives a port that is taken, says so, and takes it when it frees up', async () => {
    const dir = scratch();
    const port = await free();
    const squatter = netServer();
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', r));
    const handle = startLan({ ...deps, dir, config: { port, host: '127.0.0.1' }, retryMs: 50 });
    assert.ok(handle);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(lanReport()?.listening, false);
    assert.equal(lanReport()?.listen_error, 'EADDRINUSE');
    await new Promise<void>((r) => squatter.close(() => r()));
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => (lanReport()?.listening ? resolve() : Date.now() > deadline ? reject(new Error('never listened')) : setTimeout(poll, 25));
      poll();
    });
    assert.equal(lanReport()?.listen_error, undefined);
    await handle.stop();
  });
});

