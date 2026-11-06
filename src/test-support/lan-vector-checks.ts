/*
 * Checks every consumer of `lan-vectors.json` can run: once with plain Node crypto (so the file is
 * proven right independently of the Bridge), once through the Bridge's own `LanAuth` (so the Bridge
 * is proven right against the file).
 *
 * Shared by `lan-vectors.test.ts` (node:test) and `scripts/verify-lan-vectors.ts` (any runtime — it
 * is how the Bun the installer builds with is checked for the P1363 trap).
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanAuth } from '../lan-auth.js';
import { LanKeyStore } from '../lan-keys.js';
import { LanPairing } from '../lan-pair.js';

export interface VectorRequest {
  name: string;
  method: string;
  target: string;
  body: string | null;
  counter: number;
  nonce_header: string;
  signing_string: string;
  signature_b64u: string;
  signature_der_b64u: string;
  body_sha256_hex: string;
}

export interface Vectors {
  version: number;
  now: number;
  bridge_id: string;
  backend_key: { kid: string; spki_b64u: string; pkcs8_b64u: string };
  bridge_key: { spki_b64u: string; pkcs8_b64u: string };
  terminal_key: { spki_b64u: string };
  ticket: { payload: Record<string, unknown>; canonical_json: string; signature_b64u: string; ticket: string };
  hello: { nonce: string };
  requests: VectorRequest[];
  ack: { dedupe_key: string; job_id: string; accepted_at: string; nonce_header: string; signing_string: string; sig: string };
  negative: { name: string; from: string; mutate: Record<string, unknown>; expect: string }[];
  grant?: {
    pending_token: string;
    code: string;
    install_id: string;
    payload: Record<string, unknown>;
    canonical_json: string;
    signature_b64u: string;
    grant: string;
    not_canonical: string;
    negative: { name: string; grant?: string; clock?: number; code?: string; install_id?: string; expect: string }[];
  };
}

export const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'lan-vectors.json');

export function loadVectors(): Vectors {
  return JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors;
}

const spki = (b64u: string) => createPublicKey({ key: Buffer.from(b64u, 'base64url'), format: 'der', type: 'spki' });
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The Bridge side of the vectors: their bridge key on disk, their backend key as the only ticket key. */
function bridgeFor(v: Vectors, clock: number, bridgeId: string, keys: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-vectors-'));
  writeFileSync(
    join(dir, 'lan-key.json'),
    JSON.stringify({ v: 1, private_key: v.bridge_key.pkcs8_b64u, public_key: v.bridge_key.spki_b64u }),
    { mode: 0o600 }
  );
  const store = new LanKeyStore(dir, []);
  if (keys) store.setKeys([{ kid: v.backend_key.kid, pubkey: v.backend_key.spki_b64u, not_before: 0, not_after: null }]);
  const auth = new LanAuth({
    keys: store,
    bridgeId: () => bridgeId,
    now: () => clock * 1000,
    mintNonce: () => v.hello.nonce,
  });
  auth.issueNonce();
  return { auth, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const inputOf = (v: Vectors, r: VectorRequest, o: Partial<{
  method: string; target: string; body: string | null; nonce: string; signature: string;
}> = {}) => ({
  method: o.method ?? r.method,
  target: o.target ?? r.target,
  body: Buffer.from(o.body === undefined ? (r.body ?? '') : (o.body ?? ''), 'utf8'),
  ticket: v.ticket.ticket,
  nonce: o.nonce ?? r.nonce_header,
  signature: o.signature ?? r.signature_b64u,
});

/** Run every check; returns the names that passed, throws on the first that does not. */
export function runVectorChecks(v: Vectors): string[] {
  const passed: string[] = [];
  const ok = (name: string) => passed.push(name);

  // ---- the file against plain crypto, no Bridge code involved
  assert.equal(v.version, 1);
  assert.equal(JSON.stringify(v.ticket.payload), v.ticket.canonical_json, 'canonical_json is JSON.stringify in contract key order');
  assert.deepEqual(Object.keys(v.ticket.payload), [
    'v', 'org_id', 'branch_id', 'terminal_id', 'bridge_id', 'bridge_pubkey', 'terminal_pubkey', 'kid', 'iat', 'exp',
  ]);
  const [payloadPart, sigPart] = v.ticket.ticket.split('.');
  assert.equal(Buffer.from(payloadPart as string, 'base64url').toString('utf8'), v.ticket.canonical_json);
  assert.equal(sigPart, v.ticket.signature_b64u);
  assert.ok(
    cryptoVerify(null, Buffer.from(v.ticket.canonical_json), spki(v.backend_key.spki_b64u), Buffer.from(v.ticket.signature_b64u, 'base64url')),
    'ticket signature verifies under the backend key'
  );
  ok('ticket: canonical form and Ed25519 signature');

  for (const r of v.requests) {
    const expected = `HANKHA-LAN1\n${r.method}\n${r.target}\n${sha256hex(r.body ?? '')}\n${r.nonce_header}`;
    assert.equal(r.signing_string, expected, `${r.name}: signing_string`);
    assert.equal(r.body_sha256_hex, sha256hex(r.body ?? ''), `${r.name}: body hash`);
    const sig = Buffer.from(r.signature_b64u, 'base64url');
    assert.equal(sig.length, 64, `${r.name}: P-256 signature is 64 bytes`);
    assert.ok(
      cryptoVerify('sha256', Buffer.from(r.signing_string), { key: spki(v.terminal_key.spki_b64u), dsaEncoding: 'ieee-p1363' }, sig),
      `${r.name}: verifies with dsaEncoding ieee-p1363`
    );
    // The same signature in DER is a different byte string; read as P1363 it must NOT verify.
    const der = Buffer.from(r.signature_der_b64u, 'base64url');
    assert.notEqual(der.length, 64);
    assert.equal(
      (() => {
        try {
          return cryptoVerify('sha256', Buffer.from(r.signing_string), { key: spki(v.terminal_key.spki_b64u), dsaEncoding: 'ieee-p1363' }, der);
        } catch {
          return false;
        }
      })(),
      false,
      `${r.name}: DER does not verify as P1363`
    );
    assert.ok(
      cryptoVerify('sha256', Buffer.from(r.signing_string), { key: spki(v.terminal_key.spki_b64u), dsaEncoding: 'der' }, der),
      `${r.name}: the DER form is the same signature`
    );
  }
  ok('requests: signing strings, body hashes, P1363 signatures, DER form');

  assert.equal(
    v.ack.signing_string,
    `HANKHA-LAN1-ACK\n${v.ack.dedupe_key}\n${v.ack.job_id}\n${v.ack.accepted_at}\n${v.ack.nonce_header}`
  );
  assert.ok(cryptoVerify(null, Buffer.from(v.ack.signing_string), spki(v.bridge_key.spki_b64u), Buffer.from(v.ack.sig, 'base64url')));
  ok('ack: Ed25519 signature under the bridge key');

  // ---- the Bridge against the file
  {
    const b = bridgeFor(v, v.now, v.bridge_id, true);
    try {
      for (const r of v.requests) {
        const result = b.auth.verify(inputOf(v, r));
        assert.equal(result.ok, true, `${r.name}: ${JSON.stringify(result)}`);
      }
      ok('bridge: accepts every request vector, counters rising');

      const replay = b.auth.verify(inputOf(v, v.requests[0] as VectorRequest));
      assert.deepEqual(replay.ok ? null : replay.reason, 'replayed_or_unknown_nonce');
      ok('bridge: a replayed request is refused');

      const ack = b.auth.ack(v.ack.dedupe_key, v.ack.job_id, v.ack.accepted_at, v.ack.nonce_header);
      assert.equal(ack.sig, v.ack.sig, 'the Bridge signs the acknowledgement exactly as the vector does');
      assert.equal(ack.nonce, v.ack.nonce_header);
      ok('bridge: acknowledgement signature equals the vector');
    } finally {
      b.cleanup();
    }
  }

  if (v.grant) passed.push(...grantChecks(v, v.grant));

  for (const n of v.negative) {
    const base = v.requests.find((r) => r.name === n.from) as VectorRequest;
    const m = n.mutate as Record<string, unknown>;
    const clock = typeof m.clock === 'number' ? m.clock : v.now;
    const bridgeId = typeof m.verifier_bridge_id === 'string' ? m.verifier_bridge_id : v.bridge_id;
    const b = bridgeFor(v, clock, bridgeId, !Array.isArray(m.verifier_keys) || m.verifier_keys.length > 0);
    try {
      const body = Array.isArray(m.body_replace) && base.body !== null
        ? base.body.replace(m.body_replace[0] as string, m.body_replace[1] as string)
        : undefined;
      const result = b.auth.verify(
        inputOf(v, base, {
          ...(typeof m.method === 'string' ? { method: m.method } : {}),
          ...(typeof m.target === 'string' ? { target: m.target } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(typeof m.nonce_header === 'string' ? { nonce: m.nonce_header } : {}),
          ...(m.use === 'signature_der_b64u' ? { signature: base.signature_der_b64u } : {}),
        })
      );
      const got = result.ok ? 'accepted' : result.reason;
      assert.equal(got, n.expect, `negative vector ${n.name}`);
      ok(`negative: ${n.name} -> ${n.expect}`);
    } finally {
      b.cleanup();
    }
  }
  return passed;
}


function writeBridgeKey(dir: string, v: Vectors): void {
  writeFileSync(
    join(dir, 'lan-key.json'),
    JSON.stringify({ v: 1, private_key: v.bridge_key.pkcs8_b64u, public_key: v.bridge_key.spki_b64u }),
    { mode: 0o600 }
  );
}

/** The M9 grant vectors, run through the Bridge's own pairing code with the vector's token and code. */
function grantChecks(v: Vectors, g: NonNullable<Vectors['grant']>): string[] {
  const passed: string[] = [];
  const [payloadPart, sigPart] = g.grant.split('.');
  assert.equal(Buffer.from(payloadPart as string, 'base64url').toString('utf8'), g.canonical_json);
  assert.equal(JSON.stringify(g.payload), g.canonical_json, 'canonical_json is JSON.stringify in contract key order');
  assert.deepEqual(Object.keys(g.payload), [
    'v', 'kind', 'grant_id', 'org_id', 'branch_id', 'bridge_id', 'install_id', 'token_hash', 'bridge_pubkey', 'lan_keys', 'kid', 'iat', 'exp',
  ]);
  assert.equal(sigPart, g.signature_b64u);
  assert.ok(cryptoVerify(null, Buffer.from(g.canonical_json), spki(v.backend_key.spki_b64u), Buffer.from(g.signature_b64u, 'base64url')));
  assert.equal(g.payload.token_hash, createHash('sha256').update(g.pending_token, 'utf8').digest('hex'));
  passed.push('grant: canonical form, Ed25519 signature, token hash');

  const run = (o: { grant?: string; clock?: number; code?: string; install_id?: string }) => {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-grant-vectors-'));
    try {
      writeBridgeKey(dir, v);
      const keys = new LanKeyStore(dir, []);
      keys.setKeys([{ kid: v.backend_key.kid, pubkey: v.backend_key.spki_b64u, not_before: 0, not_after: null }]);
      let state: { install_id: string; token?: string } = { install_id: g.install_id };
      const p = new LanPairing({
        dir,
        keys,
        loadState: () => ({ ...state }),
        saveState: (s) => {
          state = s;
        },
        relayBase: () => 'https://api.example.test',
        now: () => (o.clock ?? v.now) * 1000,
        mintToken: () => g.pending_token,
        mintCode: () => g.code,
      });
      const text = o.grant === 'not_canonical' ? g.not_canonical : g.grant;
      const reply = p.pair(Buffer.from(JSON.stringify({ code: o.code ?? g.code, grant: text })));
      // A fresh Bridge reads its install id from `info()` first, exactly as a terminal would.
      return { reply, state, installId: p.info().status };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const happy = run({});
  assert.equal(happy.reply.status, 200, JSON.stringify(happy.reply.body));
  assert.equal(happy.state.token, g.pending_token);
  passed.push('bridge: accepts the grant vector with the vector code');

  for (const n of g.negative) {
    const state = run({ ...(n.grant ? { grant: n.grant } : {}), ...(n.clock !== undefined ? { clock: n.clock } : {}), ...(n.code ? { code: n.code } : {}) });
    const got = state.reply.status === 200 ? 'accepted' : (state.reply.body.reason as string);
    if (n.install_id) {
      // The Bridge whose install id differs from the one in the grant.
      const dir = mkdtempSync(join(tmpdir(), 'hankha-grant-vectors-'));
      try {
        writeBridgeKey(dir, v);
        const keys = new LanKeyStore(dir, []);
        keys.setKeys([{ kid: v.backend_key.kid, pubkey: v.backend_key.spki_b64u, not_before: 0, not_after: null }]);
        const p = new LanPairing({
          dir, keys, loadState: () => ({ install_id: n.install_id as string }), saveState: () => undefined,
          relayBase: () => 'x', now: () => v.now * 1000, mintToken: () => g.pending_token, mintCode: () => g.code,
        });
        const r = p.pair(Buffer.from(JSON.stringify({ code: g.code, grant: g.grant })));
        assert.equal(r.body.reason, n.expect, n.name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      assert.equal(got, n.expect, `grant vector ${n.name}`);
    }
    passed.push(`grant negative: ${n.name} -> ${n.expect}`);
  }
  return passed;
}
