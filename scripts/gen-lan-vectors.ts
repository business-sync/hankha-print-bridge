/*
 * Generates docs/printing/lan-vectors.json: the fixed keys, ticket, request and acknowledgement
 * every implementation of the LAN wire contract (Bridge, POS, Helper, backend) tests against.
 *
 *   node --import tsx scripts/gen-lan-vectors.ts [output.json]
 *
 * Deterministic where the algorithms allow it:
 *   - every key is derived from a fixed label (sha256), so the keys never change;
 *   - Ed25519 signatures (the ticket, the acknowledgement) are deterministic by construction;
 *   - ECDSA P-256 signatures are NOT (Node does not expose RFC 6979), so the request signatures are
 *     kept from the existing file when they still verify, and only made fresh when they do not.
 *     Running this twice therefore writes the same file.
 *
 * ⚠ The private keys are in the output on purpose — an implementation needs them to produce its
 * own signature and compare. They are TEST keys. The Bridge's pinned bootstrap key must never be
 * one of them (see BOOTSTRAP_KEYS in src/lan-keys.ts).
 *
 * This script builds every string by hand from the contract rather than calling the Bridge's own
 * helpers, so that a mistake in `lan-auth.ts` shows up as a failing vector instead of being
 * reproduced into the vectors.
 */
import {
  createECDH, createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();
const here = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ keys, derived from labels

const ED_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function ed25519(label: string) {
  const seed = sha256(`hankha-lan-vectors/v1/${label}`);
  const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ type: 'spki', format: 'der' });
  return {
    priv,
    seed_hex: seed.toString('hex'),
    pkcs8_b64u: b64u(priv.export({ type: 'pkcs8', format: 'der' })),
    spki_b64u: b64u(spki),
  };
}

function p256(label: string) {
  const d = sha256(`hankha-lan-vectors/v1/${label}`);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  const jwk = {
    kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)), d: b64u(d),
  };
  const priv = createPrivateKey({ key: jwk, format: 'jwk' });
  const pub = createPublicKey(priv);
  return {
    priv,
    pub,
    jwk,
    pkcs8_b64: priv.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    spki_b64u: b64u(pub.export({ type: 'spki', format: 'der' })),
  };
}

const backend = ed25519('backend');
const bridge = ed25519('bridge');
const terminal = p256('terminal');

// ------------------------------------------------------------------ the ticket

const NOW = 1_760_000_000; // 2025-10-09T08:53:20Z — the clock every vector is verified at
const payload = {
  v: 1,
  org_id: 2,
  branch_id: 8,
  terminal_id: 'term-vector-01',
  bridge_id: '77',
  bridge_pubkey: bridge.spki_b64u,
  terminal_pubkey: terminal.spki_b64u,
  kid: 'vec-backend-1',
  iat: NOW - 3_600,
  exp: NOW - 3_600 + 30 * 86_400,
};
const canonicalJson = JSON.stringify(payload); // key order is the contract's; no whitespace
const ticketSig = cryptoSign(null, Buffer.from(canonicalJson, 'utf8'), backend.priv);
const ticket = `${b64u(Buffer.from(canonicalJson, 'utf8'))}.${b64u(ticketSig)}`;

// ------------------------------------------------------------------ the pairing grant (M9)

const PENDING_TOKEN = 'vector-pending-token-0123456789abcdefghijklmnopqrstuvwxyz';
const PAIR_CODE = 'KXMW-4RT9';
const grantPayload = {
  v: 1,
  kind: 'bridge_grant',
  grant_id: 'grant-vector-0001',
  org_id: '2',
  branch_id: '8',
  bridge_id: '77',
  install_id: 'install-vector-0001',
  token_hash: sha256(PENDING_TOKEN).toString('hex'),
  bridge_pubkey: bridge.spki_b64u,
  lan_keys: [] as unknown[],
  kid: 'vec-backend-1',
  iat: NOW - 60,
  exp: NOW - 60 + 600,
};
const grantCanonical = JSON.stringify(grantPayload);
const grantSig = cryptoSign(null, Buffer.from(grantCanonical, 'utf8'), backend.priv);
const grant = `${b64u(Buffer.from(grantCanonical, 'utf8'))}.${b64u(grantSig)}`;
// The same fields in another order, validly signed: a verifier MUST refuse it (not canonical).
const reorderedJson = JSON.stringify({ kind: 'bridge_grant', v: 1, ...Object.fromEntries(Object.entries(grantPayload).slice(2)) });
const reordered = `${b64u(Buffer.from(reorderedJson, 'utf8'))}.${b64u(cryptoSign(null, Buffer.from(reorderedJson, 'utf8'), backend.priv))}`;

// ------------------------------------------------------------------ requests

const HELLO_NONCE = 'dmVjdG9yLW5vbmNlLTAx'; // "vector-nonce-01"; real nonces are random 16 bytes
const lao = 'ເຂົ້າປຸ້ນ'; // Lao text, so the body hash covers multi-byte UTF-8

const jobBody = JSON.stringify({
  dedupe_key: 'sale-1042-receipt-0',
  printer_id: 'receipt',
  job_type: 'RECEIPT',
  document: { kind: 'receipt', elements: [{ type: 'text', value: `Bill 1042 ${lao}` }] },
  dots_per_line: 576,
  expires_in_s: 3600,
});

interface RequestSpec {
  name: string;
  method: string;
  target: string;
  body: string | null;
  counter: number;
}

const specs: RequestSpec[] = [
  { name: 'post-job', method: 'POST', target: '/lan/v1/jobs', body: jobBody, counter: 1 },
  { name: 'get-printers-empty-body', method: 'GET', target: '/lan/v1/printers', body: null, counter: 2 },
  { name: 'post-status-with-query', method: 'POST', target: '/lan/v1/jobs/status?probe=1', body: '{"keys":["sale-1042-receipt-0"]}', counter: 3 },
];

const signingStringOf = (method: string, target: string, body: string | null, nonceHeader: string) =>
  `HANKHA-LAN1\n${method}\n${target}\n${sha256(body ?? '').toString('hex')}\n${nonceHeader}`;

const p1363Verifies = (text: string, sigB64u: string) =>
  cryptoVerify('sha256', Buffer.from(text, 'utf8'), { key: terminal.pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64u, 'base64url'));

// Reuse a signature from the previous run when it still verifies, so the file is stable.
function previousSignatures(path: string): Map<string, string> {
  const kept = new Map<string, string>();
  try {
    const old = JSON.parse(readFileSync(path, 'utf8')) as { requests?: { name: string; signature_b64u: string }[] };
    for (const r of old.requests ?? []) kept.set(r.name, r.signature_b64u);
  } catch {
    /* first run */
  }
  return kept;
}

/** r||s (IEEE P1363) to the ASN.1 DER form that Java/Android and OpenSSL produce by default. */
function p1363ToDer(sig: Buffer): Buffer {
  const half = sig.length / 2;
  const int = (raw: Buffer) => {
    let v = raw;
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if ((v[0] as number) & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([int(sig.subarray(0, half)), int(sig.subarray(half))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function build(outPath: string) {
  const previous = previousSignatures(outPath);
  const requests = specs.map((spec) => {
    const nonceHeader = `${HELLO_NONCE}.${spec.counter}`;
    const signingString = signingStringOf(spec.method, spec.target, spec.body, nonceHeader);
    let signature = previous.get(spec.name);
    if (!signature || !p1363Verifies(signingString, signature)) {
      signature = b64u(cryptoSign('sha256', Buffer.from(signingString, 'utf8'), { key: terminal.priv, dsaEncoding: 'ieee-p1363' }));
    }
    if (!p1363Verifies(signingString, signature)) throw new Error(`vector ${spec.name} does not verify`);
    return {
      name: spec.name,
      method: spec.method,
      target: spec.target,
      body: spec.body,
      body_sha256_hex: sha256(spec.body ?? '').toString('hex'),
      counter: spec.counter,
      nonce_header: nonceHeader,
      signing_string: signingString,
      signature_b64u: signature,
      signature_der_b64u: b64u(p1363ToDer(Buffer.from(signature, 'base64url'))),
    };
  });

  const ack = {
    dedupe_key: 'sale-1042-receipt-0',
    job_id: 'a3b1c2d4-0000-4000-8000-000000000001',
    accepted_at: '2025-10-09T08:53:21.000Z',
    nonce_header: `${HELLO_NONCE}.1`,
  };
  const ackString = `HANKHA-LAN1-ACK\n${ack.dedupe_key}\n${ack.job_id}\n${ack.accepted_at}\n${ack.nonce_header}`;
  const ackSig = b64u(cryptoSign(null, Buffer.from(ackString, 'utf8'), bridge.priv));

  return {
    version: 1,
    contract: 'docs/printing/LAN_WIRE_CONTRACT.md',
    warning:
      'TEST KEYS. The private halves are published here so an implementation can reproduce the signatures. ' +
      'Never trust these keys outside a test: a Bridge must not pin them, a backend must not sign with them.',
    encodings: {
      b64u: 'base64url without padding',
      p256_signature: 'IEEE P1363, r||s, 64 bytes (NOT DER). signature_der_b64u is the same signature in DER and MUST be refused.',
      ed25519_signature: '64 bytes, deterministic',
      canonical_json: 'JSON.stringify of the ticket payload with keys in the contract order, no whitespace',
    },
    now: NOW,
    now_note: 'Verify tickets as if the clock read this unix time.',
    bridge_id: payload.bridge_id,
    backend_key: {
      kid: payload.kid,
      algorithm: 'Ed25519',
      seed_hex: backend.seed_hex,
      pkcs8_b64u: backend.pkcs8_b64u,
      spki_b64u: backend.spki_b64u,
    },
    bridge_key: {
      algorithm: 'Ed25519',
      seed_hex: bridge.seed_hex,
      pkcs8_b64u: bridge.pkcs8_b64u,
      spki_b64u: bridge.spki_b64u,
    },
    terminal_key: {
      algorithm: 'ECDSA P-256',
      jwk: terminal.jwk,
      pkcs8_b64: terminal.pkcs8_b64,
      spki_b64u: terminal.spki_b64u,
    },
    ticket: {
      payload,
      canonical_json: canonicalJson,
      signature_b64u: b64u(ticketSig),
      ticket,
    },
    hello: { nonce: HELLO_NONCE },
    requests,
    ack: {
      ...ack,
      signing_string: ackString,
      sig: ackSig,
    },
    grant: {
      note: 'Pairing over the shop network (M9). A terminal posts {code, grant} to POST /lan/v1/pair.',
      pending_token: PENDING_TOKEN,
      pending_token_note: 'The Bridge keeps this secret; only token_hash (sha256 hex of this exact string) is published and signed.',
      code: PAIR_CODE,
      install_id: grantPayload.install_id,
      payload: grantPayload,
      canonical_json: grantCanonical,
      signature_b64u: b64u(grantSig),
      grant,
      not_canonical: reordered,
      negative: [
        { name: 'grant-not-canonical', grant: 'not_canonical', expect: 'grant_invalid' },
        { name: 'grant-expired', clock: grantPayload.exp + 600 + 1, expect: 'grant_expired' },
        { name: 'grant-ok-inside-skew', clock: grantPayload.exp + 600 - 1, expect: 'accepted' },
        { name: 'grant-wrong-code', code: 'ZZZZ-ZZZ9', expect: 'wrong_code' },
        { name: 'grant-wrong-install', install_id: 'someone-elses-install', expect: 'grant_wrong_bridge' },
      ],
    },
    /* Each of these MUST be refused by a verifier. `from` names the request vector it mutates. */
    negative: [
      { name: 'body-tampered', from: 'post-job', mutate: { body_replace: ['sale-1042', 'sale-9999'] }, expect: 'bad_signature' },
      { name: 'path-tampered', from: 'post-job', mutate: { target: '/lan/v1/jobs/status' }, expect: 'bad_signature' },
      { name: 'method-tampered', from: 'get-printers-empty-body', mutate: { method: 'POST' }, expect: 'bad_signature' },
      { name: 'query-tampered', from: 'post-status-with-query', mutate: { target: '/lan/v1/jobs/status?probe=2' }, expect: 'bad_signature' },
      { name: 'nonce-tampered', from: 'post-job', mutate: { nonce_header: `${HELLO_NONCE}.9` }, expect: 'bad_signature' },
      { name: 'der-signature', from: 'post-job', mutate: { use: 'signature_der_b64u' }, expect: 'bad_signature' },
      { name: 'wrong-bridge', from: 'post-job', mutate: { verifier_bridge_id: '78' }, expect: 'wrong_bridge' },
      { name: 'ticket-expired', from: 'post-job', mutate: { clock: payload.exp + 86_400 + 1 }, expect: 'ticket_expired' },
      { name: 'ticket-ok-inside-skew', from: 'post-job', mutate: { clock: payload.exp + 86_400 - 1 }, expect: 'accepted' },
      { name: 'unknown-kid', from: 'post-job', mutate: { verifier_keys: [] }, expect: 'unknown_kid' },
    ],
  };
}

const outArg = process.argv[2];
function findDocs(): string {
  let dir = resolve(here, '..');
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'docs', 'printing'))) return join(dir, 'docs', 'printing', 'lan-vectors.json');
    dir = dirname(dir);
  }
  throw new Error('docs/printing not found above this script; pass an output path');
}

const docsPath = outArg ?? findDocs();
const repoCopy = resolve(here, '..', 'src', 'test-support', 'lan-vectors.json');
const vectors = build(existsSync(docsPath) ? docsPath : repoCopy);
const text = `${JSON.stringify(vectors, null, 2)}\n`;
for (const path of new Set([docsPath, repoCopy])) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`wrote ${path}`);
}
