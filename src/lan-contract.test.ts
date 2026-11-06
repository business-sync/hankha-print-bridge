import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from './log.js';
import {
  jobBody, KITCHEN_PRINTER, LanHarness, mintTicket, RECEIPT_PRINTER, TestTerminal,
} from './test-support/lan-harness.js';

/*
 * The LAN print API against LAN_WIRE_CONTRACT.md §3-§5: every route, every status code, on a real
 * socket with real signatures. The terminal here signs with Node's P-256; the Bridge verifies with
 * its own code; the printer is a TCP server that counts what it is sent.
 */

let restoreLog: (() => void) | null = null;
before(() => {
  restoreLog = setLogSink(() => undefined);
});
after(() => restoreLog?.());

/** Hold every send until released: a printer part-way through a job. */
function holdSends() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
}

function ackString(key: string, jobId: string, acceptedAt: string, nonce: string): string {
  return `HANKHA-LAN1-ACK\n${key}\n${jobId}\n${acceptedAt}\n${nonce}`;
}

describe('GET /lan/v1/hello', () => {
  let h: LanHarness;
  before(async () => {
    h = await LanHarness.start();
  });
  after(() => h.stop());

  it('is unsigned and says what the contract promises, and nothing else', async () => {
    const res = await fetch(`${h.base}/lan/v1/hello`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), [
      'bridge_id', 'capabilities', 'install_id', 'max_body_bytes', 'nonce', 'protocol', 'relay',
    ]);
    assert.equal(body.protocol, 1);
    assert.equal(body.bridge_id, '77');
    assert.equal(body.install_id, 'install-test-0001');
    assert.deepEqual(body.capabilities, ['print_lan_v1']);
    assert.deepEqual(body.relay, { connected: false });
    assert.equal(body.max_body_bytes, 8 * 1024 * 1024);
    assert.match(String(body.nonce), /^[A-Za-z0-9_-]{22}$/, 'a base64url nonce with no dot in it');
    const text = JSON.stringify(body);
    assert.ok(!text.includes('192.168'), 'no printer address');
    assert.ok(!/hostname|org_id|printers/i.test(text), 'no hostname, org or printer detail');
  });

  it('gives each caller its own nonce', async () => {
    const a = (await (await fetch(`${h.base}/lan/v1/hello`)).json()) as { nonce: string };
    const b = (await (await fetch(`${h.base}/lan/v1/hello`)).json()) as { nonce: string };
    assert.notEqual(a.nonce, b.nonce);
  });

  it('answers a CORS preflight for the five routes, with the Private Network header', async () => {
    for (const path of [
      '/lan/v1/hello', '/lan/v1/jobs', '/lan/v1/jobs/status', '/lan/v1/jobs/sale-1042-r0/cancel', '/lan/v1/printers',
    ]) {
      const res = await fetch(`${h.base}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://pos.example',
          'access-control-request-method': 'POST',
          'access-control-request-private-network': 'true',
        },
      });
      assert.equal(res.status, 204, path);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
      assert.equal(
        res.headers.get('access-control-allow-headers'),
        'content-type, x-hankha-ticket, x-hankha-nonce, x-hankha-signature'
      );
    }
  });

  it('puts the CORS headers on errors too, so a browser can read why', async () => {
    const res = await fetch(`${h.base}/lan/v1/jobs`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  it('answers no preflight for a path that is not a route', async () => {
    const res = await fetch(`${h.base}/print`, { method: 'OPTIONS' });
    assert.equal(res.status, 404);
  });
});

describe('hello is rate limited per caller', () => {
  it('answers 429 past the limit, so a flood cannot evict real terminals\' nonces', async () => {
    const h = await LanHarness.start({ helloPerMinute: 3 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await fetch(`${h.base}/lan/v1/hello`)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      assert.equal((await fetch(`${h.base}/lan/v1/hello`)).headers.get('retry-after'), '60');
    } finally {
      await h.stop();
    }
  });
});

describe('the route allow-list', () => {
  let h: LanHarness;
  before(async () => {
    h = await LanHarness.start();
  });
  after(() => h.stop());

  const NOT_ROUTES: [string, string][] = [
    ['GET', '/'], ['GET', '/health'], ['GET', '/status'], ['GET', '/printers'], ['GET', '/jobs'],
    ['POST', '/print'], ['POST', '/jobs'], ['PUT', '/printers'], ['POST', '/enroll'], ['POST', '/scan'],
    ['POST', '/service/restart'], ['GET', '/pairing'],
    ['GET', '/lan'], ['GET', '/lan/v1'], ['GET', '/lan/v2/hello'], ['GET', '/lan/v1/jobs'],
    ['GET', '/lan/v1/jobs/status'], ['POST', '/lan/v1/hello'], ['POST', '/lan/v1/printers'],
    ['GET', '/lan/v1/jobs/sale-1042-r0/cancel'], ['POST', '/lan/v1/jobs/a/b/cancel'], ['POST', '/lan/v1/jobs//cancel'],
    ['GET', '/lan/v1/hello/'], ['GET', '//lan/v1/hello'], ['DELETE', '/lan/v1/jobs'], ['PUT', '/lan/v1/jobs'],
    ['HEAD', '/lan/v1/hello'],
  ];

  for (const [method, path] of NOT_ROUTES) {
    it(`${method} ${path} is a 404, with no authentication asked for`, async () => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: h.port, method, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 404);
    });
  }

  it('refuses a request target that is not a path', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: h.port, method: 'GET', path: 'http://evil.example/lan/v1/hello' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
  });
});

describe('authentication', () => {
  let h: LanHarness;
  let clock = Date.now();
  beforeEach(async () => {
    clock = Date.now();
    h = await LanHarness.start({ now: () => clock });
  });
  afterEach(() => h.stop());

  const body = () => jobBody('sale-0001-r0');
  const reason = (r: { json: any }) => r.json?.reason;

  it('a correctly signed request is accepted', async () => {
    const res = await h.terminal.call('POST', '/lan/v1/jobs', body());
    assert.equal(res.status, 202, res.text);
  });

  it('a request with no ticket, nonce or signature is 401, each with its own reason', async () => {
    const t = h.terminal;
    assert.equal(reason(await t.call('GET', '/lan/v1/printers', undefined, { ticket: null })), 'ticket_missing');
    assert.equal(reason(await t.call('GET', '/lan/v1/printers', undefined, { nonce: null })), 'nonce_missing');
    assert.equal(reason(await t.call('GET', '/lan/v1/printers', undefined, { signature: null })), 'signature_missing');
  });

  it('a changed body is refused, and the job is not queued', async () => {
    const sent = JSON.stringify(body());
    const res = await h.terminal.call('POST', '/lan/v1/jobs', undefined, {
      raw: sent.replace('sale-0001', 'sale-9999'),
      signedBody: sent,
    });
    assert.equal(res.status, 401);
    assert.equal(reason(res), 'bad_signature');
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.printer.connections, 0);
  });

  it('a changed path is refused', async () => {
    const res = await h.terminal.call('GET', '/lan/v1/printers', undefined, { signedPath: '/lan/v1/hello' });
    assert.equal(reason(res), 'bad_signature');
  });

  it('a changed query string is refused: the whole target is signed', async () => {
    const res = await h.terminal.call('POST', '/lan/v1/jobs/status?a=1', { keys: [] }, { signedPath: '/lan/v1/jobs/status?a=2' });
    assert.equal(reason(res), 'bad_signature');
  });

  it('a changed method is refused', async () => {
    const res = await h.terminal.call('GET', '/lan/v1/printers', undefined, { signedMethod: 'POST' });
    assert.equal(reason(res), 'bad_signature');
  });

  it('a signature in DER form is refused: the contract is IEEE P1363', async () => {
    const t = h.terminal;
    const raw = Buffer.from(t.signature('GET', '/lan/v1/printers', '', 'x'), 'base64url');
    assert.equal(raw.length, 64);
    // Re-sign the real thing as DER, which is what Java/Android and OpenSSL produce by default.
    await t.hello();
    const hello = await (await fetch(`${h.base}/lan/v1/hello`)).json() as { nonce: string };
    const header = `${hello.nonce}.1`;
    const text = `HANKHA-LAN1\nGET\n/lan/v1/printers\n${'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}\n${header}`;
    const der = cryptoSign('sha256', Buffer.from(text), { key: t.keyPair.privateKey, dsaEncoding: 'der' });
    const res = await fetch(`${h.base}/lan/v1/printers`, {
      headers: { 'x-hankha-ticket': t.ticket, 'x-hankha-nonce': header, 'x-hankha-signature': der.toString('base64url') },
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as any).reason, 'bad_signature');
  });

  it('a ticket for a different Bridge is refused', async () => {
    const t = new TestTerminal(() => h.base);
    t.ticket = h.ticketFor(t, { bridge_id: '78' });
    const res = await t.call('GET', '/lan/v1/printers');
    assert.equal(res.status, 401);
    assert.equal(reason(res), 'wrong_bridge');
  });

  it('a ticket that names a different acknowledgement key for this Bridge is refused', async () => {
    const t = new TestTerminal(() => h.base);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    t.ticket = h.ticketFor(t, { bridge_pubkey: other });
    assert.equal(reason(await t.call('GET', '/lan/v1/printers')), 'bridge_key_mismatch');
  });

  it('an expired ticket is refused, but not before the 24 h of clock tolerance is used up', async () => {
    const t = new TestTerminal(() => h.base);
    const nowS = Math.floor(clock / 1000);
    // Expired 23 hours ago by the Bridge's clock: inside the tolerance, so still honoured.
    t.ticket = h.ticketFor(t, { iat: nowS - 5 * 86_400, exp: nowS - 23 * 3_600 });
    assert.equal((await t.call('GET', '/lan/v1/printers')).status, 200);
    // Expired 25 hours ago: refused.
    const late = new TestTerminal(() => h.base);
    late.ticket = h.ticketFor(late, { iat: nowS - 5 * 86_400, exp: nowS - 25 * 3_600 });
    const res = await late.call('GET', '/lan/v1/printers');
    assert.equal(res.status, 401);
    assert.equal(reason(res), 'ticket_expired');
  });

  it('a ticket valid for more than 30 days is refused', async () => {
    const t = new TestTerminal(() => h.base);
    const nowS = Math.floor(clock / 1000);
    t.ticket = h.ticketFor(t, { iat: nowS - 60, exp: nowS - 60 + 31 * 86_400 });
    assert.equal(reason(await t.call('GET', '/lan/v1/printers')), 'ticket_invalid');
  });

  it('a ticket under an unknown kid is refused', async () => {
    const t = new TestTerminal(() => h.base);
    t.ticket = h.ticketFor(t, { kid: 'nobody-knows-me' });
    assert.equal(reason(await t.call('GET', '/lan/v1/printers')), 'unknown_kid');
  });

  it('a ticket signed by a key that merely claims a known kid is refused', async () => {
    const t = new TestTerminal(() => h.base);
    const forger = generateKeyPairSync('ed25519');
    t.ticket = mintTicket(forger.privateKey, {
      bridge_pubkey: h.keys.publicKey(), terminal_pubkey: t.spki, kid: 'test-backend-1',
    });
    assert.equal(reason(await t.call('GET', '/lan/v1/printers')), 'ticket_invalid');
  });

  it('a payload edited after signing is refused', async () => {
    const t = new TestTerminal(() => h.base);
    const [payload, sig] = h.ticketFor(t).split('.') as [string, string];
    const edited = Buffer.from(payload, 'base64url').toString().replace('"branch_id":8', '"branch_id":9');
    t.ticket = `${Buffer.from(edited).toString('base64url')}.${sig}`;
    assert.equal(reason(await t.call('GET', '/lan/v1/printers')), 'ticket_invalid');
  });

  it('a validly signed payload that is not in canonical form is refused', async () => {
    const t = new TestTerminal(() => h.base);
    const p = {
      v: 1, org_id: 2, branch_id: 8, terminal_id: 'x', bridge_id: '77', bridge_pubkey: h.keys.publicKey(),
      terminal_pubkey: t.spki, kid: 'test-backend-1', iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 3600,
    };
    // Same fields, reordered: a different byte string with a perfectly good signature.
    const json = JSON.stringify({ kid: p.kid, ...p });
    const sig = cryptoSign(null, Buffer.from(json), h.backend.privateKey);
    t.ticket = `${Buffer.from(json).toString('base64url')}.${sig.toString('base64url')}`;
    assert.equal(reason(await t.call('GET', '/lan/v1/printers')), 'ticket_invalid');
  });

  it('a ticket whose terminal key is not the one that signed the request is refused', async () => {
    const t = new TestTerminal(() => h.base);
    const other = new TestTerminal(() => h.base);
    t.ticket = h.ticketFor(other); // names the other terminal's key
    assert.equal(reason(await t.call('GET', '/lan/v1/printers')), 'bad_signature');
  });

  it('a Bridge that is not paired accepts no ticket', async () => {
    const unpaired = await LanHarness.start({ bridgeId: null });
    try {
      const res = await unpaired.terminal.call('GET', '/lan/v1/printers');
      assert.equal(res.status, 401);
      assert.equal(reason(res), 'wrong_bridge');
    } finally {
      await unpaired.stop();
    }
  });

  it('a replayed request is refused, though its signature is perfect', async () => {
    const first = await h.terminal.call('GET', '/lan/v1/printers');
    assert.equal(first.status, 200);
    const replay = await h.terminal.call('GET', '/lan/v1/printers', undefined, { counter: 1 });
    assert.equal(replay.status, 401);
    assert.equal(reason(replay), 'replayed_or_unknown_nonce');
  });

  it('a counter that does not rise is refused, though a higher one is still fine', async () => {
    const t = h.terminal;
    assert.equal((await t.call('GET', '/lan/v1/printers', undefined, { counter: 5 })).status, 200);
    assert.equal(reason(await t.call('GET', '/lan/v1/printers', undefined, { counter: 4 })), 'replayed_or_unknown_nonce');
    assert.equal(reason(await t.call('GET', '/lan/v1/printers', undefined, { counter: 5 })), 'replayed_or_unknown_nonce');
    assert.equal((await t.call('GET', '/lan/v1/printers', undefined, { counter: 9 })).status, 200);
  });

  it('a nonce the Bridge never issued is refused', async () => {
    // Perfectly signed — over a nonce this Bridge never handed out.
    const res = await h.terminal.call('GET', '/lan/v1/printers', undefined, { nonce: 'bm90LWlzc3VlZC1ieS1icmlkZ2U.1' });
    assert.equal(res.status, 401);
    assert.equal(reason(res), 'replayed_or_unknown_nonce');
  });

  it('a malformed nonce header is refused', async () => {
    for (const nonce of ['no-counter', 'abc.def', 'aaaaaaaa.0', 'aaaaaaaa.-1', 'aaaaaaaa.1.2', '.1']) {
      const res = await h.terminal.call('GET', '/lan/v1/printers', undefined, { nonce, signature: 'AAAA' });
      assert.equal(res.status, 401, nonce);
      assert.equal(reason(res), 'nonce_malformed', nonce);
    }
  });

  it('a nonce expires five minutes after hello', async () => {
    const t = h.terminal;
    await t.hello();
    assert.equal((await t.call('GET', '/lan/v1/printers')).status, 200);
    clock += 4 * 60_000;
    assert.equal((await t.call('GET', '/lan/v1/printers')).status, 200, 'still inside five minutes');
    clock += 61_000;
    const res = await t.call('GET', '/lan/v1/printers');
    assert.equal(res.status, 401);
    assert.equal(reason(res), 'replayed_or_unknown_nonce');
    // "A terminal that gets 401 for a nonce calls hello again."
    await t.hello();
    assert.equal((await t.call('GET', '/lan/v1/printers')).status, 200);
  });

  it('an unsigned or forged request cannot burn a real terminal\'s counter', async () => {
    const t = h.terminal;
    await t.hello();
    // An attacker knows the nonce (hello is unsigned) and sends a huge counter with a bad signature.
    const nonce = (t as any).nonce as string;
    const attack = await t.call('GET', '/lan/v1/printers', undefined, { counter: 1_000_000, signature: 'AAAA' });
    assert.equal(attack.status, 401);
    assert.equal(nonce, (t as any).nonce);
    assert.equal((await t.call('GET', '/lan/v1/printers', undefined, { counter: 1 })).status, 200);
  });

  it('a refused request leaves the nonce counter where it was', async () => {
    const t = h.terminal;
    const sent = JSON.stringify({ keys: [] });
    const bad = await t.call('POST', '/lan/v1/jobs/status', undefined, { raw: sent, signedBody: '{"keys":[1]}', counter: 1 });
    assert.equal(bad.status, 401);
    const good = await t.call('POST', '/lan/v1/jobs/status', { keys: [] }, { counter: 1 });
    assert.equal(good.status, 200, 'counter 1 was never consumed');
  });

  it('nonce store keeps at most 1,024 and evicts the oldest', async () => {
    const { NonceStore } = await import('./lan-auth.js');
    const store = new NonceStore(() => 0, 300_000, 4);
    const issued = [1, 2, 3, 4, 5, 6].map(() => store.issue());
    assert.equal(store.size, 4);
    assert.equal(store.consume(issued[0] as string, 1), false, 'the oldest was evicted');
    assert.equal(store.consume(issued[5] as string, 1), true);
  });
});

describe('POST /lan/v1/jobs', () => {
  let h: LanHarness;
  let hold: Promise<void> | undefined;
  beforeEach(async () => {
    hold = undefined;
    h = await LanHarness.start({ gate: () => hold });
  });
  afterEach(() => h.stop());

  const post = (body: unknown, o = {}) => h.terminal.call('POST', '/lan/v1/jobs', body, o);

  it('accepts a job: 202 with the job, deduplicated false, and a signed ack — and the printer prints it once', async () => {
    const res = await post(jobBody('sale-1042-r0', 'ONCE-MARKER'));
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.deduplicated, false);
    assert.equal(res.json.job.dedupe_key, 'sale-1042-r0');
    assert.match(res.json.job.job_id, /^[0-9a-f-]{36}$/);
    assert.ok(['queued', 'sending', 'bytes_written'].includes(res.json.job.state), res.json.job.state);

    // The ack verifies under the Bridge's public key — the one the terminal read from its ticket.
    const ack = res.json.ack;
    assert.equal(ack.dedupe_key, 'sale-1042-r0');
    assert.match(ack.accepted_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.match(ack.nonce, /^[A-Za-z0-9_-]+\.\d+$/);
    const bridgeKey = createPublicKey({ key: Buffer.from(h.keys.publicKey(), 'base64url'), format: 'der', type: 'spki' });
    assert.ok(
      cryptoVerify(null, Buffer.from(ackString('sale-1042-r0', res.json.job.job_id, ack.accepted_at, ack.nonce)), bridgeKey, Buffer.from(ack.sig, 'base64url')),
      'the ack signature verifies'
    );
    // And not under any other key: it is this Bridge's, not a squatter's.
    const squatter = generateKeyPairSync('ed25519').publicKey;
    assert.equal(
      cryptoVerify(null, Buffer.from(ackString('sale-1042-r0', res.json.job.job_id, ack.accepted_at, ack.nonce)), squatter, Buffer.from(ack.sig, 'base64url')),
      false
    );

    await h.idle();
    assert.equal(h.printer.count('ONCE-MARKER'), 1);
    assert.equal(h.printer.connections, 1);
  });

  it('the ack is bound to this request: its nonce is the header, so it cannot be lifted onto another', async () => {
    const res = await post(jobBody('sale-1043-r0'));
    const sentNonce = `${(h.terminal as any).nonce}.${(h.terminal as any).counter}`;
    assert.equal(res.json.ack.nonce, sentNonce);
  });

  it('answers 202 only after the spool file is on disk, whole', async () => {
    const release = holdSends();
    hold = release.held;
    const res = await post(jobBody('sale-2000-r0', 'DURABLE-MARKER'));
    assert.equal(res.status, 202);
    // The printer is held, so the job is still active: its spool file is the only record of it.
    const files = readdirSync(join(h.dir, 'spool')).filter((f) => f.endsWith('.json'));
    assert.deepEqual(files, [`${res.json.job.job_id}.json`]);
    const stored = JSON.parse(readFileSync(join(h.dir, 'spool', files[0] as string), 'utf8'));
    assert.equal(stored.dedupe_key, 'sale-2000-r0');
    assert.equal(stored.job_id, res.json.job.job_id);
    assert.ok(Buffer.from(stored.payload_base64, 'base64').toString('latin1').includes('DURABLE-MARKER'), 'the rendered slip is in the file');
    release.release();
    await h.idle();
  });

  it('507 when the spool cannot be written, and the job is neither queued nor printed', async () => {
    // The spool directory replaced by a file: nothing can be created under it.
    rmSync(join(h.dir, 'spool'), { recursive: true, force: true });
    writeFileSync(join(h.dir, 'spool'), 'not a directory');
    const res = await post(jobBody('sale-3000-r0', 'NEVER-PRINTED'));
    assert.equal(res.status, 507);
    assert.deepEqual(res.json, { reason: 'spool-write-failed', printed_certainty: 'none' });
    assert.equal(h.queue.pending(), 0, 'not queued');
    assert.equal(h.printer.connections, 0, 'not printed');
    assert.equal(h.queue.isKnown('sale-3000-r0'), false, 'and not remembered, so the terminal may resend');

    // The disk is fixed; the same key now goes through, as a first send, and prints once.
    rmSync(join(h.dir, 'spool'), { force: true });
    const again = await post(jobBody('sale-3000-r0', 'NEVER-PRINTED'));
    assert.equal(again.status, 202);
    assert.equal(again.json.deduplicated, false);
    await h.idle();
    assert.equal(h.printer.count('NEVER-PRINTED'), 1);
  });

  describe('a key the Bridge has seen', () => {
    it('is answered, not printed: deduplicated true, the same job, one print', async () => {
      const first = await post(jobBody('sale-4000-r0', 'DEDUPE-MARKER'));
      const second = await post(jobBody('sale-4000-r0', 'DEDUPE-MARKER'));
      assert.equal(second.status, 202);
      assert.equal(second.json.deduplicated, true);
      assert.equal(second.json.job.job_id, first.json.job.job_id);
      assert.notEqual(second.json.ack.nonce, first.json.ack.nonce, 'a fresh ack for this request');
      assert.equal(second.json.ack.accepted_at, first.json.ack.accepted_at, 'the original acceptance time');
      await h.idle();
      const third = await post(jobBody('sale-4000-r0', 'DEDUPE-MARKER'));
      assert.equal(third.json.deduplicated, true);
      assert.equal(third.json.job.state, 'bytes_written');
      assert.equal(h.printer.count('DEDUPE-MARKER'), 1);
      assert.equal(h.printer.connections, 1);
    });

    it('is answered even with a different body: the key is the job, whatever is resent under it', async () => {
      await post(jobBody('sale-4001-r0', 'FIRST-BODY'));
      await h.idle();
      const res = await post(jobBody('sale-4001-r0', 'SECOND-BODY'));
      assert.equal(res.json.deduplicated, true);
      assert.equal(h.printer.count('SECOND-BODY'), 0);
    });

    it('is answered after a restart of the Bridge, from the settled ring', async () => {
      await post(jobBody('sale-4002-r0', 'RESTART-MARKER'));
      await h.idle();
      await h.restart();
      const res = await post(jobBody('sale-4002-r0', 'RESTART-MARKER'));
      assert.equal(res.status, 202);
      assert.equal(res.json.deduplicated, true);
      assert.equal(res.json.job.state, 'bytes_written');
      assert.equal(h.printer.count('RESTART-MARKER'), 1);
    });

    it('is answered even if the printer has since been removed from the registry', async () => {
      await post(jobBody('sale-4003-r0'));
      await h.idle();
      h.writeRegistry([KITCHEN_PRINTER]);
      const res = await post(jobBody('sale-4003-r0'));
      assert.equal(res.status, 202);
      assert.equal(res.json.deduplicated, true);
    });

    it('while still queued, is the same queued job', async () => {
      const release = holdSends();
      hold = release.held;
      const first = await post(jobBody('sale-4004-r0', 'QUEUED-MARKER'));
      const second = await post(jobBody('sale-4004-r0', 'QUEUED-MARKER'));
      assert.equal(second.json.deduplicated, true);
      assert.equal(second.json.job.job_id, first.json.job.job_id);
      release.release();
      await h.idle();
      assert.equal(h.printer.count('QUEUED-MARKER'), 1);
    });

    it('does not print twice when the same key is sent at the same moment', async () => {
      const release = holdSends();
      hold = release.held;
      const terminals = [h.terminal, new TestTerminal(() => h.base), new TestTerminal(() => h.base)];
      for (const t of terminals.slice(1)) t.ticket = h.ticketFor(t);
      const replies = await Promise.all(terminals.map((t) => t.call('POST', '/lan/v1/jobs', jobBody('sale-4005-r0', 'RACE-MARKER'))));
      release.release();
      await h.idle();
      assert.deepEqual(replies.map((r) => r.status), [202, 202, 202]);
      assert.equal(replies.filter((r) => r.json.deduplicated === false).length, 1);
      assert.equal(h.printer.count('RACE-MARKER'), 1);
    });
  });

  describe('validation', () => {
    it('400 for a body that is not JSON', async () => {
      const res = await post(undefined, { raw: '{not json' });
      assert.equal(res.status, 400);
      assert.equal(res.json.reason, 'invalid_json');
    });

    for (const [name, mutate] of [
      ['a short dedupe_key', { dedupe_key: 'short' }],
      ['a dedupe_key with a slash', { dedupe_key: 'sale/1042/receipt' }],
      ['a dedupe_key with a space', { dedupe_key: 'sale 1042 receipt' }],
      ['a 129-character dedupe_key', { dedupe_key: 'k'.repeat(129) }],
      ['a missing printer_id', { printer_id: undefined }],
      ['an unknown job_type', { job_type: 'REFUND' }],
      ['a missing document', { document: undefined }],
      ['a document that is a string', { document: 'hello' }],
      ['a non-integer dots_per_line', { dots_per_line: 576.5 }],
      ['expires_in_s below 30', { expires_in_s: 29 }],
      ['expires_in_s above 3600', { expires_in_s: 3601 }],
      ['copies of 2', { copies: 2 }],
      ['a malformed reprint_of', { reprint_of: 'bad key!' }],
    ] as [string, Record<string, unknown>][]) {
      it(`400 for ${name}`, async () => {
        const res = await post({ ...jobBody('sale-5000-r0'), ...mutate });
        assert.equal(res.status, 400, res.text);
        assert.equal(res.json.reason, 'invalid_body');
        assert.ok(res.json.errors.length > 0);
        assert.equal(h.printer.connections, 0);
      });
    }

    it('accepts the bounds: a 128-character key, 30 s and 3600 s, copies of 1, a reprint_of', async () => {
      assert.equal((await post(jobBody('k'.repeat(128), 'A', { expires_in_s: 30 }))).status, 202);
      assert.equal((await post(jobBody('sale-5001-r0', 'B', { expires_in_s: 3600, copies: 1, reprint_of: 'sale-5000-r0' }))).status, 202);
      assert.equal((await post(jobBody('A.b_c:d-e1234'))).status, 202, 'every allowed punctuation');
    });

    it('400 for a document the renderer cannot read', async () => {
      const res = await post({ ...jobBody('sale-5002-r0'), document: { kind: 'receipt', elements: [] } });
      assert.equal(res.status, 400);
      assert.equal(res.json.reason, 'invalid_document');
    });

    it('422 render_failed for a document the printer cannot print', async () => {
      h.writeRegistry([{ ...RECEIPT_PRINTER, language: 'zpl' }]);
      const res = await post(jobBody('sale-5003-r0'));
      assert.equal(res.status, 422);
      assert.equal(res.json.reason, 'render_failed');
    });
  });

  describe('which printer', () => {
    for (const field of ['target', 'ip', 'address', 'port', 'payload_base64', 'receipt', 'label']) {
      it(`refuses ${field}: the LAN names a registry printer and sends a document, never an address or raw bytes`, async () => {
        const extra: Record<string, unknown> = {
          target: { ip: '10.0.0.5', port: 9100 }, ip: '10.0.0.5', address: '10.0.0.5', port: 9100,
          payload_base64: Buffer.from('RAW').toString('base64'), receipt: {}, label: {},
        };
        const res = await post({ ...jobBody('sale-6000-r0'), [field]: extra[field] });
        assert.equal(res.status, 400);
        assert.equal(res.json.reason, 'invalid_body');
        assert.ok(res.json.errors.join(' ').includes(field));
        assert.equal(h.printer.connections, 0);
        assert.equal(h.queue.pending(), 0);
      });
    }

    it('an ip target with no printer_id at all is refused too', async () => {
      const { printer_id: _omit, ...rest } = jobBody('sale-6001-r0');
      const res = await post({ ...rest, target: { ip: '192.168.1.99', port: 9100 } });
      assert.equal(res.status, 400);
      assert.equal(h.queue.pending(), 0);
    });

    it('422 printer_unknown for an id the registry does not have — never a fall back to some address', async () => {
      const res = await post({ ...jobBody('sale-6002-r0'), printer_id: 'bar-2' });
      assert.equal(res.status, 422);
      assert.equal(res.json.reason, 'printer_unknown');
      assert.equal(h.queue.pending(), 0);
    });

    it('422 printer_unknown for a stale id: the registry changed after the terminal cached its routes', async () => {
      h.writeRegistry([{ ...RECEIPT_PRINTER, id: 'receipt-2' }]);
      const res = await post(jobBody('sale-6003-r0'));
      assert.equal(res.status, 422);
      assert.equal(res.json.reason, 'printer_unknown');
    });

    it('422 printer_disabled for a printer the operator turned off', async () => {
      h.writeRegistry([{ ...RECEIPT_PRINTER, enabled: false }]);
      const res = await post(jobBody('sale-6004-r0'));
      assert.equal(res.status, 422);
      assert.equal(res.json.reason, 'printer_disabled');
    });

    it('prints on the printer it was addressed to', async () => {
      const res = await post({ ...jobBody('sale-6005-r0', 'KITCHEN-SLIP'), printer_id: 'kitchen', dots_per_line: 384 });
      assert.equal(res.status, 202, res.text);
      await h.idle();
      assert.equal(h.printer.count('KITCHEN-SLIP'), 1);
      assert.equal(h.queue.get('sale-6005-r0')?.printer.id, 'kitchen');
    });
  });

  describe('paper width', () => {
    it('422 width_mismatch with the width the printer has, for a slip laid out for another', async () => {
      const res = await post({ ...jobBody('sale-7000-r0'), dots_per_line: 384 });
      assert.equal(res.status, 422);
      assert.equal(res.json.reason, 'width_mismatch');
      assert.equal(res.json.expected, 576);
      assert.equal(h.printer.connections, 0);
      assert.equal(h.queue.isKnown('sale-7000-r0'), false, 'a rejection is not remembered; the terminal rebuilds and resends');
    });

    it('the other way round too: a 58 mm printer is not sent a slip built for 80 mm', async () => {
      const res = await post({ ...jobBody('sale-7001-r0'), printer_id: 'kitchen', dots_per_line: 576 });
      assert.equal(res.status, 422);
      assert.equal(res.json.reason, 'width_mismatch');
      assert.equal(res.json.expected, 384);
    });

    it('a document that pins itself wider than the paper is a width_mismatch as well', async () => {
      const res = await post({
        ...jobBody('sale-7002-r0'),
        printer_id: 'kitchen',
        dots_per_line: 384,
        document: { kind: 'receipt', dots_per_line: 576, elements: [{ type: 'text', value: 'wide' }] },
      });
      assert.equal(res.status, 422);
      assert.equal(res.json.reason, 'width_mismatch');
      assert.equal(res.json.expected, 384);
    });

    it('and the same key goes through once it is rebuilt for the right width', async () => {
      await post({ ...jobBody('sale-7003-r0'), dots_per_line: 384 });
      const ok = await post(jobBody('sale-7003-r0', 'REBUILT'));
      assert.equal(ok.status, 202);
      assert.equal(ok.json.deduplicated, false);
      await h.idle();
      assert.equal(h.printer.count('REBUILT'), 1);
    });
  });

  describe('size', () => {
    it('413 for a body over 8 MiB, declared up front, without waiting for it', async () => {
      const status = await new Promise<number>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1', port: h.port, method: 'POST', path: '/lan/v1/jobs',
            headers: { 'x-hankha-ticket': h.terminal.ticket, 'content-length': String(8 * 1024 * 1024 + 1) },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', () => resolve(0));
        // Ten bytes of a body that says it is 8 MiB: the answer must not wait for the rest.
        req.write('0123456789');
      });
      assert.equal(status, 413);
      assert.equal(h.queue.pending(), 0);
    });

    it('413 for a body that streams past 8 MiB', async () => {
      const status = await new Promise<number>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1', port: h.port, method: 'POST', path: '/lan/v1/jobs',
            headers: { 'x-hankha-ticket': h.terminal.ticket, 'transfer-encoding': 'chunked' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', () => resolve(0));
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 10) {
            sent += 1;
            if (!req.write(chunk)) return void req.once('drain', pump);
          }
          req.end();
        };
        pump();
      });
      // 413 if the response made it back before the socket was dropped; 0 if the drop won the race.
      assert.ok(status === 413 || status === 0, String(status));
      assert.equal(h.queue.pending(), 0);
    });

    it('a body just under the limit is read (and judged on its merits)', async () => {
      const big = { ...jobBody('sale-8000-r0'), document: { kind: 'receipt', elements: [{ type: 'text', value: 'x'.repeat(2_000_000) }] } };
      const res = await post(big);
      // Parsed and rendered, not rejected for size: the renderer's own limits decide.
      assert.notEqual(res.status, 413);
      assert.ok(res.status === 202 || res.status === 400 || res.status === 422, String(res.status));
    });
  });
});

describe('POST /lan/v1/jobs/status', () => {
  let h: LanHarness;
  let hold: Promise<void> | undefined;
  beforeEach(async () => {
    hold = undefined;
    h = await LanHarness.start({ gate: () => hold });
  });
  afterEach(() => h.stop());

  const status = async (...keys: string[]) => (await h.terminal.call('POST', '/lan/v1/jobs/status', { keys })).json.jobs;

  it('unseen for a key the Bridge has never heard of', async () => {
    assert.deepEqual(await status('sale-9000-r0'), [{ dedupe_key: 'sale-9000-r0', state: 'unseen', certainty: 'none' }]);
  });

  it('queued, then sending, then bytes_written', async () => {
    const release = holdSends();
    hold = release.held;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9001-r0'));
    await h.until(() => h.sends === 1);
    const [during] = await status('sale-9001-r0');
    assert.equal(during.state, 'sending');
    assert.equal(during.certainty, 'unknown', 'bytes may be on the wire');
    release.release();
    await h.idle();
    const [after] = await status('sale-9001-r0');
    assert.equal(after.state, 'bytes_written');
    assert.match(after.settled_at, /^\d{4}-\d\d-\d\dT/);
  });

  it('queued while the printer is down, with the reason it is waiting', async () => {
    await h.printer.down();
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9002-r0'));
    await h.until(() => h.sends >= 1);
    await new Promise((r) => setTimeout(r, 50));
    const [s] = await status('sale-9002-r0');
    assert.equal(s.state, 'queued');
    assert.equal(s.certainty, 'none');
    assert.ok(typeof s.error === 'string' && s.error.length > 0, 'says why it has not printed');
    await h.printer.up();
    await h.idle(8_000);
    assert.equal((await status('sale-9002-r0'))[0].state, 'bytes_written');
    assert.equal(h.printer.count('MARK-sale-9002-r0'), 1, 'printed once when the printer came back');
  });

  it('reports the settled ring after a restart: ok, unknown and cancelled are remembered', async () => {
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9003-r0'));
    await h.idle();
    // A second job interrupted mid-send, and a third cancelled.
    const release = holdSends();
    hold = release.held;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9004-r0'));
    await h.until(() => h.sends === 2);
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9005-r0'));
    assert.equal((await h.terminal.call('POST', '/lan/v1/jobs/sale-9005-r0/cancel')).status, 200);

    // The Bridge dies with 9004 on the wire. The new process finds it in `printing` in the spool.
    await h.restart();
    release.release();
    hold = undefined;
    const states = Object.fromEntries((await status('sale-9003-r0', 'sale-9004-r0', 'sale-9005-r0', 'sale-9006-r0')).map((j: any) => [j.dedupe_key, j]));
    assert.equal(states['sale-9003-r0'].state, 'bytes_written');
    assert.equal(states['sale-9004-r0'].state, 'unknown');
    assert.equal(states['sale-9004-r0'].certainty, 'unknown');
    assert.equal(states['sale-9005-r0'].state, 'cancelled');
    assert.equal(states['sale-9006-r0'].state, 'unseen');
  });

  it('a job that provably did not print (failed, none) is not remembered across a restart', async () => {
    // Queued while the printer is registered, then the printer is turned off before its turn.
    const release = holdSends();
    hold = release.held;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9007-r0'));
    await h.until(() => h.sends === 1);
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9008-r0', 'SECOND'));
    h.writeRegistry([{ ...RECEIPT_PRINTER, enabled: false }]);
    release.release();
    hold = undefined;
    await h.idle();
    const [failed] = await status('sale-9008-r0');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.certainty, 'none');
    assert.match(failed.error, /disabled/);
    await h.restart();
    assert.equal((await status('sale-9008-r0'))[0].state, 'unseen', 'a later send of this key must be allowed to try again');
  });

  it('answers many keys in order', async () => {
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-9010-r0'));
    await h.idle();
    const jobs = await status('sale-9099-r0', 'sale-9010-r0', 'sale-9098-r0');
    assert.deepEqual(jobs.map((j: any) => [j.dedupe_key, j.state]), [
      ['sale-9099-r0', 'unseen'], ['sale-9010-r0', 'bytes_written'], ['sale-9098-r0', 'unseen'],
    ]);
  });

  it('400 for more than 100 keys, a bad key, or no list', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `sale-${String(i).padStart(5, '0')}`);
    assert.equal((await h.terminal.call('POST', '/lan/v1/jobs/status', { keys: many })).status, 400);
    const hundred = many.slice(0, 100);
    assert.equal((await h.terminal.call('POST', '/lan/v1/jobs/status', { keys: hundred })).status, 200);
    assert.equal((await h.terminal.call('POST', '/lan/v1/jobs/status', { keys: ['bad key'] })).status, 400);
    assert.equal((await h.terminal.call('POST', '/lan/v1/jobs/status', { keys: 'sale-1' })).status, 400);
    assert.equal((await h.terminal.call('POST', '/lan/v1/jobs/status', {})).status, 400);
  });
});

describe('POST /lan/v1/jobs/:key/cancel', () => {
  let h: LanHarness;
  let hold: Promise<void> | undefined;
  beforeEach(async () => {
    hold = undefined;
    h = await LanHarness.start({ gate: () => hold });
  });
  afterEach(() => h.stop());

  const cancel = (key: string) => h.terminal.call('POST', `/lan/v1/jobs/${key}/cancel`);

  it('200 for a job still waiting, which then never prints — and a resend of it is answered, not printed', async () => {
    const release = holdSends();
    hold = release.held;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1100-r0', 'HEAD'));
    await h.until(() => h.sends === 1);
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1101-r0', 'CANCELLED-MARKER'));
    const res = await cancel('sale-1101-r0');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { state: 'cancelled' });
    release.release();
    hold = undefined;
    await h.idle();
    assert.equal(h.printer.count('CANCELLED-MARKER'), 0);
    const resend = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1101-r0', 'CANCELLED-MARKER'));
    assert.equal(resend.status, 202);
    assert.equal(resend.json.deduplicated, true);
    assert.equal(resend.json.job.state, 'cancelled');
    assert.equal(h.printer.count('CANCELLED-MARKER'), 0, 'the operator cancelled it; a late resend must not overturn that');
  });

  it('409 once sending has started, and the job still prints', async () => {
    const release = holdSends();
    hold = release.held;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1102-r0', 'SENDING-MARKER'));
    await h.until(() => h.sends === 1);
    const res = await cancel('sale-1102-r0');
    assert.equal(res.status, 409);
    assert.equal(res.json.state, 'sending');
    release.release();
    await h.idle();
    assert.equal(h.printer.count('SENDING-MARKER'), 1);
  });

  it('409 for a job that has already printed', async () => {
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1103-r0'));
    await h.idle();
    const res = await cancel('sale-1103-r0');
    assert.equal(res.status, 409);
    assert.equal(res.json.state, 'bytes_written');
  });

  it('404 for a key the Bridge has never seen', async () => {
    const res = await cancel('sale-1104-r0');
    assert.equal(res.status, 404);
  });

  it('200 again for a job that is already cancelled', async () => {
    const release = holdSends();
    hold = release.held;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1105-r0'));
    await h.until(() => h.sends === 1);
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1106-r0'));
    assert.equal((await cancel('sale-1106-r0')).status, 200);
    assert.equal((await cancel('sale-1106-r0')).status, 200);
    release.release();
    await h.idle();
  });

  it('400 for a key that is not a dedupe key', async () => {
    assert.equal((await cancel('short')).status, 400);
  });
});

describe('GET /lan/v1/printers', () => {
  let h: LanHarness;
  beforeEach(async () => {
    h = await LanHarness.start();
  });
  afterEach(() => h.stop());

  it('lists the registry with width and state, and no addresses', async () => {
    const res = await h.terminal.call('GET', '/lan/v1/printers');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.printers.map((p: any) => p.id).sort(), ['kitchen', 'receipt']);
    const receipt = res.json.printers.find((p: any) => p.id === 'receipt');
    assert.deepEqual(Object.keys(receipt).sort(), [
      'dots_per_line', 'enabled', 'id', 'last_ok_at', 'name', 'reachable', 'role', 'type',
    ]);
    assert.equal(receipt.dots_per_line, 576);
    assert.equal(receipt.enabled, true);
    assert.equal(receipt.reachable, null, 'no probe has run, which is not the same as down');
    assert.equal(receipt.last_ok_at, null);
    assert.ok(!res.text.includes('192.168'), 'no address');
  });

  it('shows a disabled printer as disabled', async () => {
    h.writeRegistry([{ ...RECEIPT_PRINTER, enabled: false }, KITCHEN_PRINTER]);
    const res = await h.terminal.call('GET', '/lan/v1/printers');
    assert.equal(res.json.printers.find((p: any) => p.id === 'receipt').enabled, false);
  });

  it('knows when a printer last took a job', async () => {
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1200-r0'));
    await h.idle();
    const res = await h.terminal.call('GET', '/lan/v1/printers');
    const receipt = res.json.printers.find((p: any) => p.id === 'receipt');
    assert.match(receipt.last_ok_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(res.json.printers.find((p: any) => p.id === 'kitchen').last_ok_at, null);
  });
});

describe('the files it leaves', () => {
  it('keeps the Bridge key at mode 0600 and out of every response', async (t) => {
    const h = await LanHarness.start();
    try {
      const path = join(h.dir, 'lan-key.json');
      assert.ok(existsSync(path));
      if (process.platform !== 'win32') {
        const { statSync } = await import('node:fs');
        assert.equal(statSync(path).mode & 0o777, 0o600);
      } else {
        t.diagnostic('POSIX modes do not apply on Windows');
      }
      const priv = JSON.parse(readFileSync(path, 'utf8')).private_key as string;
      const res = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-1300-r0'));
      const everything = res.text + JSON.stringify(await (await fetch(`${h.base}/lan/v1/hello`)).json());
      assert.ok(!everything.includes(priv));
    } finally {
      await h.stop();
    }
  });

  it('survives a restart: the same key, so tickets already issued stay valid', async () => {
    const h = await LanHarness.start();
    try {
      const before = h.keys.publicKey();
      const { LanKeyStore } = await import('./lan-keys.js');
      assert.equal(new LanKeyStore(h.dir, []).publicKey(), before);
    } finally {
      await h.stop();
    }
  });
});
