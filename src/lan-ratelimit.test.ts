import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FailureLimiter, normalizeRemote, TRACKED_REMOTES_CAP } from './lan-ratelimit.js';
import { jobBody, LanHarness, TestTerminal } from './test-support/lan-harness.js';
import { getPairInfo, mintGrant, pairRig, postPair, type PairRig } from './test-support/pair-harness.js';

/*
 * Failed-authentication rate limiting on the LAN print API (task 2 of the LAN security hardening).
 * Real sockets throughout; the clock is injected so a minute costs nothing.
 */

class Clock {
  constructor(public ms = Date.parse('2026-11-07T10:00:00Z')) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

describe('FailureLimiter', () => {
  it('trips on the limit-th failure and blocks for a minute, then forgets', () => {
    const c = new Clock();
    const l = new FailureLimiter({ limit: 5, now: c.now });
    for (let i = 0; i < 4; i += 1) assert.equal(l.failure('a'), false);
    assert.equal(l.retryAfter('a'), 0, 'four failures: still served');
    assert.equal(l.failure('a'), true, 'the fifth trips it');
    assert.equal(l.retryAfter('a'), 60);
    c.advance(30_000);
    assert.equal(l.retryAfter('a'), 30);
    c.advance(30_001);
    assert.equal(l.retryAfter('a'), 0);
  });

  it('failures older than the window do not add up', () => {
    const c = new Clock();
    const l = new FailureLimiter({ limit: 5, now: c.now });
    for (let i = 0; i < 4; i += 1) l.failure('a');
    c.advance(60_000);
    for (let i = 0; i < 4; i += 1) l.failure('a');
    assert.equal(l.retryAfter('a'), 0);
  });

  it('successes do not count, however many', () => {
    const c = new Clock();
    const l = new FailureLimiter({ limit: 5, now: c.now });
    for (let i = 0; i < 1_000; i += 1) l.success('a');
    for (let i = 0; i < 4; i += 1) l.failure('a');
    assert.equal(l.retryAfter('a'), 0);
  });

  it('an address that authenticated recently is never refused, one that did not is', () => {
    const c = new Clock();
    const l = new FailureLimiter({ limit: 5, now: c.now });
    l.success('till');
    for (let i = 0; i < 20; i += 1) {
      l.failure('till');
      l.failure('stranger');
    }
    assert.equal(l.retryAfter('till'), 0, 'the succeeding remote is not locked out');
    assert.ok(l.retryAfter('stranger') > 0);
    // The exemption is a grace, not a permanent pass.
    c.advance(5 * 60_000 + 1);
    for (let i = 0; i < 5; i += 1) l.failure('till');
    assert.ok(l.retryAfter('till') > 0);
  });

  it('is bounded: more addresses than the cap evict the least recently seen', () => {
    const l = new FailureLimiter({ limit: 2, cap: 8, now: new Clock().now });
    l.failure('first');
    l.failure('first');
    assert.ok(l.retryAfter('first') > 0);
    for (let i = 0; i < 100; i += 1) l.failure(`10.0.0.${i}`);
    assert.ok(l.size <= 8, `tracked ${l.size}`);
    assert.equal(l.retryAfter('first'), 0, 'the oldest was forgotten');
    // And one that keeps being seen survives the churn.
    const m = new FailureLimiter({ limit: 2, cap: 8, now: new Clock().now });
    m.failure('busy');
    m.failure('busy');
    for (let i = 0; i < 100; i += 1) {
      m.failure(`10.0.0.${i}`);
      m.retryAfter('busy');
      m.failure('busy');
    }
    assert.ok(m.retryAfter('busy') > 0);
    assert.ok(TRACKED_REMOTES_CAP >= 1_024 && TRACKED_REMOTES_CAP <= 65_536);
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 device', () => {
    assert.equal(normalizeRemote('::ffff:192.168.1.5'), '192.168.1.5');
    assert.equal(normalizeRemote('192.168.1.5'), '192.168.1.5');
    assert.equal(normalizeRemote('FE80::1'), 'fe80::1');
    assert.equal(normalizeRemote(undefined), 'unknown');
  });
});

describe('over real sockets', () => {
  let h: LanHarness | null = null;
  afterEach(async () => {
    await h?.stop();
    h = null;
  });

  const LIMIT = 5;
  const clock = new Clock();
  const start = async (extra: Parameters<typeof LanHarness.start>[0] = {}) => {
    clock.ms = Date.parse('2026-11-07T10:00:00Z');
    h = await LanHarness.start({ failuresPerMinute: LIMIT, limiterNow: clock.now, ...extra });
    return h;
  };
  const zeroSig = Buffer.alloc(64).toString('base64url');

  /** One failed signed request of each kind the limiter must count, on a different route each. */
  const failures = (harness: LanHarness) => [
    { kind: 'bad_signature', run: () => harness.terminal.call('POST', '/lan/v1/jobs', jobBody('rl-bad-sig-1'), { signature: zeroSig }) },
    {
      kind: 'unknown_kid',
      run: () => harness.terminal.call('GET', '/lan/v1/printers', undefined, {
        ticket: harness.ticketFor(harness.terminal, { kid: 'not-a-known-kid' }),
      }),
    },
    {
      kind: 'ticket_expired',
      run: () => {
        const nowS = Math.floor(Date.now() / 1000);
        return harness.terminal.call('POST', '/lan/v1/jobs/status', { keys: [] }, {
          ticket: harness.ticketFor(harness.terminal, { iat: nowS - 40 * 86_400, exp: nowS - 35 * 86_400 }),
        });
      },
    },
    { kind: 'replayed_or_unknown_nonce', run: () => harness.terminal.call('POST', '/lan/v1/jobs/rl-cancel-key-1/cancel', undefined, { counter: 1 }) },
    { kind: 'ticket_missing', run: () => harness.terminal.call('GET', '/lan/v1/printers', undefined, { ticket: null }) },
  ];

  const good = (harness: LanHarness) => harness.terminal.call('POST', '/lan/v1/jobs/status', { keys: [] });

  it('counts every kind of failed signed request, on every signed route, then answers 429 with Retry-After', async () => {
    const harness = await start();
    assert.equal((await good(harness)).status, 200); // consumes counter 1, so `counter: 1` is a replay
    // This success earns the grace, which would hide the block; use a second terminal-less address instead:
    // here we want to see the block itself, so forget the success by moving past the grace window.
    clock.advance(6 * 60_000);
    const seen: string[] = [];
    for (const f of failures(harness)) {
      const r = await f.run();
      assert.equal(r.status, 401, `${f.kind}: ${r.text}`);
      seen.push(r.json.reason);
    }
    assert.deepEqual(seen, ['bad_signature', 'unknown_kid', 'ticket_expired', 'replayed_or_unknown_nonce', 'ticket_missing']);
    // That was LIMIT failures: the very next request, even a perfectly valid one, is refused.
    const valid = await harness.terminal.call('POST', '/lan/v1/jobs', jobBody('rl-valid-key-1'));
    assert.equal(valid.status, 429);
    assert.equal(valid.json.reason, 'rate_limited');
    const wait = Number(valid.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= 60, `Retry-After ${wait}`);
    assert.equal(harness.queue.pending(), 0);
    assert.equal(harness.printer.connections, 0, 'nothing reached the printer');
    // The block is a minute long, then verification resumes and the valid request is served.
    clock.advance(59_000);
    assert.equal((await good(harness)).status, 429);
    clock.advance(2_000);
    const later = await harness.terminal.call('POST', '/lan/v1/jobs', jobBody('rl-valid-key-1'));
    assert.equal(later.status, 202, later.text);
  });

  it('a blocked address gets 429 even for garbage, without any signature being checked', async () => {
    const harness = await start();
    for (let i = 0; i < LIMIT; i += 1) await harness.terminal.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig });
    const r = await fetch(`${harness.base}/lan/v1/printers`, { headers: { 'x-hankha-ticket': 'not-even-a-ticket' } });
    assert.equal(r.status, 429, 'not 401: the ticket was never looked at');
    assert.equal(r.headers.get('connection'), 'close');
  });

  it('hello and unknown routes are not affected by the block', async () => {
    const harness = await start();
    for (let i = 0; i < LIMIT; i += 1) await harness.terminal.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig });
    assert.equal((await fetch(`${harness.base}/lan/v1/hello`)).status, 200);
    assert.equal((await fetch(`${harness.base}/lan/v1/nope`)).status, 404);
  });

  it('successes never count, however many there are', async () => {
    const harness = await start();
    for (let i = 0; i < LIMIT * 8; i += 1) assert.equal((await good(harness)).status, 200);
    for (let i = 0; i < LIMIT - 1; i += 1) assert.equal((await harness.terminal.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig })).status, 401);
    assert.equal((await good(harness)).status, 200, 'LIMIT-1 failures after 40 successes: not blocked');
  });

  it('a remote that is succeeding is never locked out, even while its neighbour fails far past the limit', async () => {
    const harness = await start();
    assert.equal((await good(harness)).status, 200);
    for (let i = 0; i < LIMIT * 4; i += 1) {
      const r = await harness.terminal.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig });
      assert.equal(r.status, 401, `failure ${i + 1} is still verified and answered 401, not 429`);
    }
    const r = await harness.terminal.call('POST', '/lan/v1/jobs', jobBody('rl-till-key-1'));
    assert.equal(r.status, 202, r.text);
  });

  it('failures spread over more than a minute never add up to a block', async () => {
    const harness = await start();
    for (let round = 0; round < 4; round += 1) {
      for (let i = 0; i < LIMIT - 1; i += 1) assert.equal((await harness.terminal.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig })).status, 401);
      clock.advance(61_000);
    }
    assert.equal((await harness.terminal.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig })).status, 401);
  });

  const lanIp = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address;

  it('one address being blocked does not touch another', { skip: lanIp ? false : 'no private IPv4 address on this machine' }, async () => {
    const harness = await start({ host: '0.0.0.0' });
    const fromLoopback = harness.terminal;
    for (let i = 0; i < LIMIT; i += 1) await fromLoopback.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig });
    assert.equal((await good(harness)).status, 429, 'loopback is blocked');
    // Reaching the same listener through the machine's LAN address makes this connection's source the LAN address.
    const other = new TestTerminal(() => `http://${lanIp}:${harness.port}`);
    other.ticket = harness.ticketFor(other);
    const r = await other.call('POST', '/lan/v1/jobs/status', { keys: [] });
    assert.equal(r.status, 200, r.text);
  });

  it('terminals that sign correctly are untouched by a stranger failing from another terminal object on the same address', async () => {
    const harness = await start();
    const second = new TestTerminal(() => harness.base);
    second.ticket = harness.ticketFor(second);
    assert.equal((await second.call('GET', '/lan/v1/printers')).status, 200);
    for (let i = 0; i < LIMIT * 3; i += 1) await harness.terminal.call('GET', '/lan/v1/printers', undefined, { signature: zeroSig });
    assert.equal((await second.call('GET', '/lan/v1/printers')).status, 200);
  });
});

describe('failed pairing attempts', () => {
  let rig: PairRig | null = null;
  afterEach(async () => {
    await rig?.stop();
    rig = null;
  });

  it('are refused by the limiter once the pairing lock-out has been exhausted,', async () => {
    rig = await pairRig({ http: true, failuresPerMinute: 8 });
    const r = rig;
    const code = r.pairing.localSnapshot().code as string;
    const bad = mintGrant(r, {}, (await import('node:crypto')).generateKeyPairSync('ed25519').privateKey);
    const statuses: Array<[number, string]> = [];
    for (let i = 0; i < 10; i += 1) {
      const a = await postPair(r, code, bad);
      statuses.push([a.status, a.json?.reason]);
    }
    // Five counted failures lock the pairing (and replace the code); the rest are 429 `locked`
    // until the limiter, which counts every failed attempt, takes over at the ninth.
    assert.deepEqual(statuses.slice(0, 5).map((s) => s[0]), [403, 403, 403, 403, 403]);
    assert.equal(statuses[5]?.[1], 'locked');
    assert.equal(statuses[7]?.[1], 'locked');
    assert.deepEqual(statuses[8], [429, 'rate_limited']);
    assert.deepEqual(statuses[9], [429, 'rate_limited']);
    // Pairing's own state is exactly what five failures left it: the limiter did not add counts.
    const info = await getPairInfo(r);
    assert.ok(info.json.locked_for_s > 0);
    // A minute later both the limiter and (60 s) the first lock-out have run out.
    r.clock.advance(61_000);
    const after = await postPair(r, 'ZZZZ-ZZZ9', bad);
    assert.equal(after.json?.reason, 'grant_invalid', 'served again, and verified');
  });

  it('a valid pairing still works with the limiter on', async () => {
    rig = await pairRig({ http: true, failuresPerMinute: 2 });
    const r = rig;
    const code = r.pairing.localSnapshot().code as string;
    const res = await postPair(r, code, mintGrant(r));
    assert.equal(res.status, 200, JSON.stringify(res.json));
  });
});

// ---------------------------------------------------------------------- the real Bridge process, default limit

describe('the default limit in a real Bridge process', () => {
  const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  after(() => {
    for (const c of children) c.kill('SIGKILL');
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const free = () =>
    new Promise<number>((resolve) => {
      const s = netServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });

  it('allows 30 failed requests a minute from one address and answers the 31st with 429', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-rlproc-'));
    dirs.push(dir);
    const lanPort = await free();
    const port = await free();
    writeFileSync(join(dir, 'lan.json'), JSON.stringify({ enabled: true, port: lanPort, host: '127.0.0.1' }));
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: {
        ...process.env, PRINT_BRIDGE_PORT: String(port), PRINT_BRIDGE_HOST: '127.0.0.1', PRINT_BRIDGE_STATE_DIR: dir,
        PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9', PRINT_BRIDGE_LOG_FORMAT: 'text',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    children.push(child);
    const lan = `http://127.0.0.1:${lanPort}`;
    const deadline = Date.now() + 25_000;
    for (;;) {
      try {
        if ((await fetch(`${lan}/lan/v1/hello`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('the LAN listener never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
    const statuses: number[] = [];
    let retryAfter = '';
    for (let i = 0; i < 33; i += 1) {
      const r = await fetch(`${lan}/lan/v1/printers`);
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get('retry-after') ?? '';
    }
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(401));
    assert.deepEqual(statuses.slice(30), [429, 429, 429]);
    assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60, `Retry-After ${retryAfter}`);
    // hello still answers (it has its own, separate limit).
    assert.equal((await fetch(`${lan}/lan/v1/hello`)).status, 200);
  });
});
