import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { b64u } from './lan-keys.js';
import {
  CODE_TTL_MS, FAILURES_BEFORE_LOCK, FIRST_LOCK_MS, GRANT_SKEW_S, MAX_LOCK_MS, PAIR_FILE, REPAIR_WINDOW_MS,
  activeLanPairing, setActiveLanPairing,
} from './lan-pair.js';
import { lanReport, readLanConfig, startLan } from './lan-server.js';
import { createServer as netServer } from 'node:net';
import { setLogSink } from './log.js';
import { resetRegistryCache } from './registry.js';
import { createBridgeServer } from './server.js';
import { getPairInfo, mintGrant, pairRig, postPair, sha256hex, signRaw, type PairRig } from './test-support/pair-harness.js';

/*
 * Pairing over the shop network, Bridge half. Signatures are real Ed25519, the sockets are real,
 * the clock is fake. The backend that issues grants does not exist yet: the test signs them with
 * a key it hands the Bridge, exactly as the contract says the backend will.
 */

let restoreLog: (() => void) | null = null;
beforeEach(() => {
  restoreLog = setLogSink(() => undefined);
});
afterEach(() => restoreLog?.());

const code = (rig: PairRig): string => rig.pairing.localSnapshot().code as string;

// ---------------------------------------------------------------------- off by default

describe('pairing over the LAN is off unless lan.json says so', () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const config = (lan: unknown) => {
    const d = mkdtempSync(join(tmpdir(), 'hankha-pairflag-'));
    dirs.push(d);
    writeFileSync(join(d, 'lan.json'), JSON.stringify(lan));
    return readLanConfig(d);
  };

  it('the flag must be exactly true', () => {
    assert.equal(config({ enabled: true })?.pairing_over_lan, undefined);
    assert.equal(config({ enabled: true, pairing_over_lan: false })?.pairing_over_lan, undefined);
    assert.equal(config({ enabled: true, pairing_over_lan: 'true' })?.pairing_over_lan, undefined);
    assert.equal(config({ enabled: true, pairing_over_lan: 1 })?.pairing_over_lan, undefined);
    assert.equal(config({ enabled: true, pairing_over_lan: true })?.pairing_over_lan, true);
  });

  it('the pairing flag alone does not turn the LAN API on', () => {
    assert.equal(config({ pairing_over_lan: true }), null);
    assert.equal(config({ enabled: false, pairing_over_lan: true }), null);
  });

  it('without a pairing handler the two routes do not exist and preflight is refused', async () => {
    const rig = await pairRig({ http: true });
    try {
      const saved = rig.pairing;
      // The same server, with the switch off.
      const { createLanServer } = await import('./lan-server.js');
      const { LanAuth } = await import('./lan-auth.js');
      const { PrintQueue } = await import('./queue.js');
      const off: Server = createLanServer({
        auth: new LanAuth({ keys: rig.keys, bridgeId: () => null }),
        queue: () => new PrintQueue({ dir: rig.dir }),
        installId: () => 'x',
        bridgeId: () => null,
        relayConnected: () => false,
        reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
      });
      await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(off.address() as { port: number }).port}`;
      try {
        assert.equal((await fetch(`${base}/lan/v1/pair-info`)).status, 404);
        assert.equal((await fetch(`${base}/lan/v1/pair`, { method: 'POST', body: '{}' })).status, 404);
        assert.equal((await fetch(`${base}/lan/v1/pair`, { method: 'OPTIONS' })).status, 404);
        const hello = (await (await fetch(`${base}/lan/v1/hello`)).json()) as { capabilities: string[] };
        assert.deepEqual(hello.capabilities, ['print_lan_v1']);
      } finally {
        off.closeAllConnections?.();
        await new Promise<void>((r) => off.close(() => r()));
      }
      assert.ok(saved, 'the rig with pairing on is a different server');
      assert.equal((await getPairInfo(rig)).status, 200);
      const on = (await (await fetch(`${rig.base}/lan/v1/hello`)).json()) as { capabilities: string[] };
      assert.deepEqual(on.capabilities, ['print_lan_v1', 'pair_lan_v1']);
    } finally {
      await rig.stop();
    }
  });
});

// ---------------------------------------------------------------------- pair-info

describe('GET /lan/v1/pair-info', () => {
  let rig: PairRig;
  before(async () => {
    rig = await pairRig({ http: true });
  });
  after(() => rig.stop());

  it('an unpaired Bridge describes itself, with a hash of its token and no code', async () => {
    const r = await getPairInfo(rig);
    assert.equal(r.status, 200);
    assert.equal(r.json.protocol, 1);
    assert.equal(r.json.state, 'unpaired');
    assert.equal(r.json.install_id, 'install-pair-0001');
    assert.match(r.json.token_hash, /^[0-9a-f]{64}$/);
    assert.match(r.json.bridge_pubkey, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(r.json.hostname, 'till-1');
    assert.equal(r.json.now, rig.clock.seconds);
    const text = JSON.stringify(r.json);
    assert.ok(!text.includes(code(rig)), 'the code is never in the response');
    assert.ok(!text.includes(rig.tokens[0] as string), 'the token is never in the response');
    assert.equal(r.json.token_hash, sha256hex(rig.tokens[0] as string));
  });

  it('is stable: asking twice gives the same hash until a pairing happens', async () => {
    const a = await getPairInfo(rig);
    const b = await getPairInfo(rig);
    assert.equal(a.json.token_hash, b.json.token_hash);
  });

  it('the pending token survives a restart', async () => {
    const before = (await getPairInfo(rig)).json.token_hash;
    rig.restart();
    assert.equal((await getPairInfo(rig)).json.token_hash, before);
  });

  it('the pending token file is private', () => {
    const path = join(rig.dir, PAIR_FILE);
    assert.ok(existsSync(path));
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0, 'owner only');
  });

  it('a paired Bridge answers already_paired and shows nothing about itself', async () => {
    const paired = await pairRig({ http: true, state: { token: 'existing', bridge_id: '5' } });
    try {
      const r = await getPairInfo(paired);
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { reason: 'already_paired' });
    } finally {
      await paired.stop();
    }
  });
});

// ---------------------------------------------------------------------- the install id

describe('the install id a terminal is told', () => {
  it('stays the same for a Bridge that has never been paired (identity.loadState mints a new one per call until it is saved)', async () => {
    const { LanPairing } = await import('./lan-pair.js');
    const { LanKeyStore } = await import('./lan-keys.js');
    const { randomUUID } = await import('node:crypto');
    const dir = mkdtempSync(join(tmpdir(), 'hankha-pairid-'));
    try {
      let saved: { install_id: string } | null = null;
      const p = new LanPairing({
        dir,
        keys: new LanKeyStore(dir, []),
        // Exactly identity.loadState(): a fresh random id every call until something is saved.
        loadState: () => saved ?? { install_id: randomUUID() },
        saveState: (st) => {
          saved = st;
        },
        relayBase: () => 'https://api.example.test',
      });
      const ids = new Set([p.info().body.install_id, p.info().body.install_id, p.info().body.install_id]);
      assert.equal(ids.size, 1);
      assert.ok(saved, 'the id was pinned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------- the happy path

describe('POST /lan/v1/pair', () => {
  let rig: PairRig;
  beforeEach(async () => {
    rig = await pairRig({ http: true });
  });
  afterEach(() => rig.stop());

  it('a valid grant and the code on the screen pair the Bridge, leaving the state a redemption leaves', async () => {
    const grant = mintGrant(rig, { org_id: '2', branch_id: '8', bridge_id: '77' });
    const r = await postPair(rig, code(rig), grant);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.paired, true);
    assert.equal(r.json.bridge_id, '77');
    assert.equal(r.json.org_id, '2');
    assert.equal(r.json.branch_id, '8');
    assert.ok(!JSON.stringify(r.json).includes(rig.tokens[0] as string), 'the token is not returned');

    // The fields `enroll()` writes: install_id kept, relay_url, bridge_id, token, enrolled_at.
    const saved = rig.saves.at(-1);
    assert.ok(saved);
    assert.equal(saved.install_id, 'install-pair-0001');
    assert.equal(saved.relay_url, 'https://api.example.test');
    assert.equal(saved.bridge_id, '77');
    assert.equal(saved.token, rig.tokens[0]);
    assert.match(saved.enrolled_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(saved.org_id, '2');
    assert.equal(saved.branch_id, '8');
    assert.equal(saved.paired_via, 'lan');
    // The backend row holds sha256(token): the Bridge's token matches the hash it published.
    assert.equal(sha256hex(saved.token as string), (grant && JSON.parse(Buffer.from(grant.split('.')[0] as string, 'base64url').toString()).token_hash));
    assert.deepEqual(rig.paired, ['77'], 'the relay is started');
  });

  it('applies the key set the grant carries', async () => {
    const extra = generateKeyPairSync('ed25519');
    const lan_keys = [{ kid: 'backend-2', pubkey: b64u(extra.publicKey.export({ type: 'spki', format: 'der' })), not_before: 0, not_after: null }];
    const r = await postPair(rig, code(rig), mintGrant(rig, { lan_keys }));
    assert.equal(r.status, 200);
    assert.ok(rig.keys.kids().includes('backend-2'));
  });

  it('the code is accepted in any of the ways a person types it', async () => {
    const c = code(rig);
    const lower = c.toLowerCase().replace('-', ' ');
    const r = await postPair(rig, ` ${lower} `, mintGrant(rig));
    assert.equal(r.status, 200);
  });

  it('afterwards the Bridge refuses to be paired again, and shows no code', async () => {
    const c = code(rig);
    assert.equal((await postPair(rig, c, mintGrant(rig))).status, 200);
    const again = await postPair(rig, c, mintGrant(rig));
    assert.equal(again.status, 409);
    assert.equal(again.json.reason, 'already_paired');
    assert.equal((await getPairInfo(rig)).status, 409);
    assert.equal(rig.pairing.localSnapshot().code, null);
    assert.equal(rig.saves.length, 1);
  });

  it('the token that became the credential is never offered again', async () => {
    const first = rig.tokens.length;
    await getPairInfo(rig);
    await postPair(rig, code(rig), mintGrant(rig));
    const file = JSON.parse(readFileSync(join(rig.dir, PAIR_FILE), 'utf8')) as { token: string; used: unknown[] };
    assert.notEqual(file.token, rig.state.token);
    assert.equal(file.used.length, 1);
    assert.ok(rig.tokens.length > first);
  });

  it('a wrong code is refused and changes nothing', async () => {
    const r = await postPair(rig, 'ZZZZ-ZZZ9', mintGrant(rig));
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, 'wrong_code');
    assert.equal(rig.saves.length, 0);
    assert.deepEqual(rig.paired, []);
    assert.equal(rig.state.token, undefined);
  });

  it('a grant for another Bridge (install id, or token hash) is refused', async () => {
    const c = code(rig);
    const a = await postPair(rig, c, mintGrant(rig, { install_id: 'someone-elses-install' }));
    assert.equal(a.json.reason, 'grant_wrong_bridge');
    const b = await postPair(rig, c, mintGrant(rig, { token_hash: sha256hex('not-my-token') }));
    assert.equal(b.json.reason, 'grant_wrong_bridge');
    const other = generateKeyPairSync('ed25519');
    const wrongKey = b64u(other.publicKey.export({ type: 'spki', format: 'der' }));
    const k = await postPair(rig, c, mintGrant(rig, { bridge_pubkey: wrongKey }));
    assert.equal(k.json.reason, 'grant_wrong_bridge', 'a grant naming another ack key is not for this Bridge');
    assert.equal(rig.saves.length, 0);
  });

  it('a body that is not JSON, or lacks fields, is a 400 and does not count against the code', async () => {
    const raw = async (body: string) =>
      (await fetch(`${rig.base}/lan/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status;
    for (let i = 0; i < FAILURES_BEFORE_LOCK + 2; i += 1) {
      assert.equal(await raw('{not json'), 400);
      assert.equal(await raw('{"code":"AAAA-AAA2"}'), 400);
      assert.equal(await raw('[]'), 400);
    }
    // Still unlocked: the right answer works.
    assert.equal((await postPair(rig, code(rig), mintGrant(rig))).status, 200);
  });

  it('an oversized body is refused before it is read', async () => {
    const res = await fetch(`${rig.base}/lan/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(20_000) });
    assert.equal(res.status, 413);
  });

  it('two requests with the same grant at once pair once', async () => {
    const c = code(rig);
    const grant = mintGrant(rig);
    const [a, b] = await Promise.all([postPair(rig, c, grant), postPair(rig, c, grant)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(rig.saves.length, 1);
  });
});

// ---------------------------------------------------------------------- the grant

describe('the grant is verified like a ticket, and more strictly', () => {
  let rig: PairRig;
  beforeEach(async () => {
    rig = await pairRig({ http: true });
  });
  afterEach(() => rig.stop());

  const refused = async (grant: string, expected: string, status = 403) => {
    const r = await postPair(rig, code(rig), grant);
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.equal(r.json.reason, expected);
    assert.equal(rig.saves.length, 0, 'nothing was saved');
    assert.deepEqual(rig.paired, []);
  };

  it('an unsigned grant', async () => {
    const good = mintGrant(rig);
    await refused((good.split('.')[0] as string) + '.', 'grant_invalid');
    await refused(good.split('.')[0] as string, 'grant_invalid');
    await refused('', 'grant_invalid');
  });

  it('a grant whose payload was changed after signing', async () => {
    const good = mintGrant(rig, { org_id: '2' });
    const [p, s] = good.split('.') as [string, string];
    const tampered = Buffer.from(p, 'base64url').toString().replace('"org_id":"2"', '"org_id":"3"');
    await refused(`${b64u(Buffer.from(tampered))}.${s}`, 'grant_invalid');
  });

  it('signed by a key the Bridge does not trust, under a trusted kid', async () => {
    const stranger = generateKeyPairSync('ed25519');
    await refused(mintGrant(rig, {}, stranger.privateKey), 'grant_invalid');
  });

  it('an unknown kid', async () => {
    await refused(mintGrant(rig, { kid: 'no-such-key' }), 'grant_unknown_kid');
  });

  it('a key used outside its validity (judged at the grant\'s iat)', async () => {
    const pair = generateKeyPairSync('ed25519');
    const r2 = await pairRig({
      http: true,
      keyEntries: [{ kid: 'old', pubkey: b64u(pair.publicKey.export({ type: 'spki', format: 'der' })), not_before: 0, not_after: rig.clock.seconds - 3_600 }],
    });
    try {
      const grant = mintGrant(r2, { kid: 'old' }, pair.privateKey);
      const r = await postPair(r2, code(r2), grant);
      assert.equal(r.json.reason, 'grant_unknown_kid');
    } finally {
      await r2.stop();
    }
  });

  it('an expired grant, and one not yet valid, with the skew a no-internet clock needs', async () => {
    const now = rig.clock.seconds;
    await refused(mintGrant(rig, { iat: now - 3_000, exp: now - 2_400 }), 'grant_expired');
    await refused(mintGrant(rig, { iat: now + 3_000, exp: now + 3_600 }), 'grant_not_yet_valid');
    // Just inside the skew either way is accepted: a Bridge's clock is not NTP-true.
    const ok = await postPair(rig, code(rig), mintGrant(rig, { iat: now - 600 - GRANT_SKEW_S + 30, exp: now - GRANT_SKEW_S + 30 }));
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });

  it('a grant that claims to live longer than 15 minutes', async () => {
    const now = rig.clock.seconds;
    await refused(mintGrant(rig, { iat: now - 5, exp: now - 5 + 901 }), 'grant_invalid');
    await refused(mintGrant(rig, { iat: now - 5, exp: now - 5 }), 'grant_invalid');
  });

  it('a payload that is valid JSON but not in canonical form is two documents under one signature', async () => {
    const info = rig.pairing.info().body;
    const reordered = JSON.stringify({
      kind: 'bridge_grant', v: 1, grant_id: 'grant-reordered1', org_id: '2', branch_id: '8', bridge_id: '77',
      install_id: rig.state.install_id, token_hash: info.token_hash, bridge_pubkey: rig.keys.publicKey(), lan_keys: [], kid: 'backend-1',
      iat: rig.clock.seconds - 5, exp: rig.clock.seconds + 500,
    });
    await refused(signRaw(reordered, rig.backend.privateKey), 'grant_invalid');
    const spaced = JSON.stringify(JSON.parse(reordered), null, 1);
    await refused(signRaw(spaced, rig.backend.privateKey), 'grant_invalid');
  });

  it('is not a ticket: a genuine ticket payload signed by the backend does not pair', async () => {
    const ticketJson = JSON.stringify({
      v: 1, org_id: '2', branch_id: '8', terminal_id: 'term-1', bridge_id: '77', bridge_pubkey: rig.keys.publicKey(),
      terminal_pubkey: 'AAAA', kid: 'backend-1', iat: rig.clock.seconds - 5, exp: rig.clock.seconds + 500,
    });
    await refused(signRaw(ticketJson, rig.backend.privateKey), 'grant_invalid');
  });

  it('wrong kind or version', async () => {
    await refused(mintGrant(rig, { kind: 'terminal_ticket' }), 'grant_invalid');
    await refused(mintGrant(rig, { v: 2 }), 'grant_invalid');
  });

  it('a malformed field (token hash, grant id, ids)', async () => {
    await refused(mintGrant(rig, { token_hash: 'abc' }), 'grant_invalid');
    await refused(mintGrant(rig, { grant_id: 'short' }), 'grant_invalid');
    await refused(mintGrant(rig, { bridge_id: '' }), 'grant_invalid');
    await refused(mintGrant(rig, { lan_keys: [{ kid: 'x', pubkey: 'not-a-key', not_before: 0, not_after: null }] }), 'grant_invalid');
  });

  it('a grant is checked before the code: someone without one never learns whether a code was right', async () => {
    const r = await postPair(rig, code(rig), 'garbage');
    assert.equal(r.json.reason, 'grant_invalid');
    const r2 = await postPair(rig, 'WRONG-CODE', 'garbage');
    assert.equal(r2.json.reason, 'grant_invalid', 'same answer whatever the code was');
  });
});

// ---------------------------------------------------------------------- replay

describe('a grant is single use', () => {
  it('a replay after success is refused as replayed, even if the token still matched', async () => {
    // A fixed token makes the rotated token equal the old one, so the ONLY thing that can stop the
    // replay is the used-grant list - the strictest test of it.
    const rig = await pairRig({ http: true, fixedToken: 'fixed-token-' + 'y'.repeat(40) });
    try {
      const c = code(rig);
      const grant = mintGrant(rig, { grant_id: 'grant-once-0001' });
      assert.equal((await postPair(rig, c, grant)).status, 200);
      rig.pairing.allowRepair();
      const replay = await postPair(rig, code(rig), grant);
      assert.equal(replay.status, 409);
      assert.equal(replay.json.reason, 'grant_replayed');
      assert.equal(rig.saves.length, 1);
    } finally {
      await rig.stop();
    }
  });

  it('survives a restart: the used ids are on disk', async () => {
    const rig = await pairRig({ http: true, fixedToken: 'fixed-token-' + 'z'.repeat(40) });
    try {
      const grant = mintGrant(rig, { grant_id: 'grant-once-0002' });
      assert.equal((await postPair(rig, code(rig), grant)).status, 200);
      rig.restart();
      rig.pairing.allowRepair();
      assert.equal((await postPair(rig, code(rig), grant)).json.reason, 'grant_replayed');
    } finally {
      await rig.stop();
    }
  });

  it('with the normal token rotation a replay fails the token binding instead', async () => {
    const rig = await pairRig({ http: true });
    try {
      const grant = mintGrant(rig);
      assert.equal((await postPair(rig, code(rig), grant)).status, 200);
      rig.pairing.allowRepair();
      assert.equal((await postPair(rig, code(rig), grant)).json.reason, 'grant_wrong_bridge');
    } finally {
      await rig.stop();
    }
  });
});

// ---------------------------------------------------------------------- already paired, re-pair, org

describe('an already-paired Bridge', () => {
  let rig: PairRig;
  beforeEach(async () => {
    rig = await pairRig({ http: true, state: { token: 'the-old-token', bridge_id: '5', org_id: '2', branch_id: '8', relay_url: 'https://api.example.test' } });
  });
  afterEach(() => rig.stop());

  it('refuses, and the loopback snapshot shows no code', async () => {
    assert.equal(rig.pairing.localSnapshot().state, 'paired');
    assert.equal(rig.pairing.localSnapshot().code, null);
    const r = await postPair(rig, 'AAAA-AAA2', 'x.y');
    assert.equal(r.status, 409);
    assert.equal(r.json.reason, 'already_paired');
    assert.equal(rig.state.token, 'the-old-token');
  });

  it('"allow LAN re-pair" opens a window; the same org may re-pair, another may not', async () => {
    rig.pairing.allowRepair();
    assert.equal(rig.pairing.localSnapshot().state, 'repair_allowed');
    assert.equal((await getPairInfo(rig)).json.state, 'repair_allowed');

    const other = await postPair(rig, code(rig), mintGrant(rig, { org_id: '3' }));
    assert.equal(other.status, 403);
    assert.equal(other.json.reason, 'wrong_org');
    assert.equal(rig.state.token, 'the-old-token', 'a wrong org changed nothing');

    const same = await postPair(rig, code(rig), mintGrant(rig, { org_id: '2', bridge_id: '78' }));
    assert.equal(same.status, 200, JSON.stringify(same.json));
    assert.equal(rig.state.bridge_id, '78');
    assert.notEqual(rig.state.token, 'the-old-token');
    // The window closes with the success.
    assert.equal(rig.pairing.localSnapshot().state, 'paired');
    assert.equal((await postPair(rig, 'AAAA-AAA2', 'x.y')).status, 409);
  });

  it('the window expires by itself', async () => {
    rig.pairing.allowRepair();
    rig.clock.advance(REPAIR_WINDOW_MS + 1_000);
    assert.equal(rig.pairing.localSnapshot().state, 'paired');
    assert.equal((await getPairInfo(rig)).status, 409);
  });

  it('can be closed by hand', async () => {
    rig.pairing.allowRepair();
    rig.pairing.closeRepair();
    assert.equal((await getPairInfo(rig)).status, 409);
  });
});

// ---------------------------------------------------------------------- guessing

describe('guessing the code', () => {
  let rig: PairRig;
  beforeEach(async () => {
    rig = await pairRig({ http: true });
  });
  afterEach(() => rig.stop());

  const wrong = (n: number) => postPair(rig, `BBBB-BBB${(n % 8) + 2}`, mintGrant(rig));

  it(`locks after ${FAILURES_BEFORE_LOCK} failures, answering 429 even to the right answer, then backs off`, async () => {
    const original = code(rig);
    for (let i = 0; i < FAILURES_BEFORE_LOCK; i += 1) assert.equal((await wrong(i)).status, 403);

    const locked = await postPair(rig, original, mintGrant(rig));
    assert.equal(locked.status, 429);
    assert.equal(locked.json.reason, 'locked');
    assert.equal(locked.json.retry_after_s, FIRST_LOCK_MS / 1000);
    assert.equal(rig.saves.length, 0, 'even the original code and a good grant do nothing while locked');
    assert.equal((await getPairInfo(rig)).json.locked_for_s, FIRST_LOCK_MS / 1000);

    // The code was replaced with the lock: the five guesses are worth nothing against the next.
    assert.notEqual(code(rig), original);
    assert.equal((await postPair(rig, original, mintGrant(rig))).status, 429);

    rig.clock.advance(FIRST_LOCK_MS + 1_000);
    const stillOldCode = await postPair(rig, original, mintGrant(rig));
    assert.equal(stillOldCode.json.reason, 'wrong_code', 'the replaced code is dead');

    // Second lock is twice as long.
    for (let i = 0; i < FAILURES_BEFORE_LOCK - 1; i += 1) await wrong(i);
    const second = await postPair(rig, 'CCCC-CCC2', mintGrant(rig));
    assert.equal(second.status, 429);
    assert.equal(second.json.retry_after_s, (FIRST_LOCK_MS * 2) / 1000);
  });

  it('the back-off is capped', async () => {
    for (let round = 0; round < 8; round += 1) {
      for (let i = 0; i < FAILURES_BEFORE_LOCK; i += 1) await wrong(i);
      const locked = await postPair(rig, 'DDDD-DDD2', mintGrant(rig));
      assert.equal(locked.status, 429);
      assert.ok((locked.json.retry_after_s as number) * 1000 <= MAX_LOCK_MS);
      rig.clock.advance(MAX_LOCK_MS + 1_000);
    }
  });

  it('bad grants count against the same budget', async () => {
    for (let i = 0; i < FAILURES_BEFORE_LOCK; i += 1) assert.equal((await postPair(rig, code(rig), 'not.agrant')).status, 403);
    assert.equal((await postPair(rig, code(rig), mintGrant(rig))).status, 429);
  });

  it('someone at the machine can clear a lock by asking for a new code', async () => {
    for (let i = 0; i < FAILURES_BEFORE_LOCK; i += 1) await wrong(i);
    assert.equal((await postPair(rig, code(rig), mintGrant(rig))).status, 429);
    rig.pairing.newCode();
    assert.equal((await postPair(rig, code(rig), mintGrant(rig))).status, 200);
  });

  it('a success clears the count', async () => {
    for (let i = 0; i < FAILURES_BEFORE_LOCK - 1; i += 1) await wrong(i);
    assert.equal((await postPair(rig, code(rig), mintGrant(rig))).status, 200);
  });

  it('a code that nobody used lapses after 15 minutes and is replaced', async () => {
    const first = code(rig);
    rig.clock.advance(CODE_TTL_MS + 1_000);
    const second = code(rig);
    assert.notEqual(first, second);
    assert.equal((await postPair(rig, first, mintGrant(rig))).json.reason, 'wrong_code');
  });
});

// ---------------------------------------------------------------------- the code stays on the Bridge

describe('the code is shown on the Bridge and nowhere else', () => {
  it('it is in no LAN response, success or failure', async () => {
    const rig = await pairRig({ http: true });
    try {
      const c = code(rig);
      const seen: string[] = [];
      seen.push(JSON.stringify((await getPairInfo(rig)).json));
      seen.push(JSON.stringify((await postPair(rig, 'WRNG-CODE', mintGrant(rig))).json));
      seen.push(JSON.stringify((await postPair(rig, c, 'x.y')).json));
      seen.push(await (await fetch(`${rig.base}/lan/v1/hello`)).text());
      seen.push(JSON.stringify((await postPair(rig, c, mintGrant(rig))).json));
      for (const text of seen) assert.ok(!text.includes(c), text);
    } finally {
      await rig.stop();
    }
  });
});

// ---------------------------------------------------------------------- the loopback side

describe('the loopback routes on the main port', () => {
  let server: Server;
  let base = '';
  let rig: PairRig;
  let dir = '';
  const previous = process.env.PRINT_BRIDGE_STATE_DIR;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hankha-pairloop-'));
    process.env.PRINT_BRIDGE_STATE_DIR = dir;
    resetRegistryCache();
    rig = await pairRig({ state: { token: 'existing', bridge_id: '5' } });
    server = createBridgeServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    setActiveLanPairing(null);
    server.close();
    await rig.stop();
    if (previous === undefined) delete process.env.PRINT_BRIDGE_STATE_DIR;
    else process.env.PRINT_BRIDGE_STATE_DIR = previous;
    resetRegistryCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    fetch(`${base}/pairing/lan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('feature off: /pairing has no lan field and the control is a 404', async () => {
    assert.equal(activeLanPairing(), null);
    const before = (await (await fetch(`${base}/pairing`)).json()) as Record<string, unknown>;
    assert.equal('lan' in before, false);
    assert.deepEqual(
      Object.keys(before).sort(),
      ['code', 'expires_at', 'branch_name', 'has_credential', 'last_error', 'ok', 'org_name', 'phase', 'pos_pair_url', 'qr_svg', 'relay'].sort(),
      'the existing /pairing answer is exactly what it was'
    );
    assert.equal((await post({ action: 'allow_repair' })).status, 404);
  });

  it('feature on: /pairing carries the lan block, and the three actions work', async () => {
    setActiveLanPairing(rig.pairing);
    const snap = (await (await fetch(`${base}/pairing`)).json()) as { lan: { state: string; code: string | null } };
    assert.equal(snap.lan.state, 'paired');
    assert.equal(snap.lan.code, null, 'a paired Bridge shows no code');

    const allowed = (await (await post({ action: 'allow_repair' })).json()) as { lan: { state: string; code: string; repair_until: string } };
    assert.equal(allowed.lan.state, 'repair_allowed');
    assert.match(allowed.lan.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(allowed.lan.repair_until);

    const fresh = (await (await post({ action: 'new_code' })).json()) as { lan: { code: string } };
    assert.notEqual(fresh.lan.code, allowed.lan.code);

    const closed = (await (await post({ action: 'close_repair' })).json()) as { lan: { state: string } };
    assert.equal(closed.lan.state, 'paired');

    const bad = await post({ action: 'format_disk' });
    assert.equal(bad.status, 400);
  });
});

// ---------------------------------------------------------------------- what the heartbeat reports

describe('the heartbeat report', () => {
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const free = () =>
    new Promise<number>((resolve) => {
      const s = netServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
  const listening = (h: { server: Server }) =>
    new Promise<void>((resolve) => (h.server.listening ? resolve() : h.server.once('listening', () => resolve())));
  const deps = {
    queue: () => { throw new Error('not used'); },
    installId: () => 'install-report-01',
    bridgeId: () => null,
    relayConnected: () => false,
    reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
  } as unknown as Parameters<typeof startLan>[0];

  it('says pairing is on, and advertises pair_lan_v1, only while it really is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-pairreport-'));
    dirs.push(dir);
    const port = await free();
    const handle = startLan({
      ...deps, dir, config: { port, host: '127.0.0.1', pairing_over_lan: true },
      pairingDeps: { relayBase: () => 'https://api.example.test' },
    });
    assert.ok(handle);
    await listening(handle);
    try {
      const on = lanReport();
      assert.equal(on?.pairing_over_lan, true);
      assert.deepEqual(on?.capabilities, ['print_lan_v1', 'pair_lan_v1']);
    } finally {
      await handle.stop();
    }
    assert.equal(activeLanPairing(), null, 'stopping the LAN API takes the pairing with it');
  });

  it('a flag set in lan.json but not wired by the build stays off, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-pairreport-'));
    dirs.push(dir);
    const port = await free();
    const handle = startLan({ ...deps, dir, config: { port, host: '127.0.0.1', pairing_over_lan: true } });
    assert.ok(handle);
    await listening(handle);
    try {
      assert.equal(lanReport()?.pairing_over_lan, undefined);
      assert.deepEqual(lanReport()?.capabilities, ['print_lan_v1']);
      assert.equal(activeLanPairing(), null);
    } finally {
      await handle.stop();
    }
  });

  it('with pairing off the report has no pairing field at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-pairreport-'));
    dirs.push(dir);
    const port = await free();
    const handle = startLan({ ...deps, dir, config: { port, host: '127.0.0.1' }, pairingDeps: { relayBase: () => 'x' } });
    assert.ok(handle);
    await listening(handle);
    try {
      assert.equal('pairing_over_lan' in (lanReport() ?? {}), false);
    } finally {
      await handle.stop();
    }
  });
});
