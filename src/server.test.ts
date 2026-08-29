import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { localInterfaces } from './lan.js';
import { loadState, type RelayState, saveState } from './identity.js';
import { resetRegistryCache } from './registry.js';
import { INDEX_HTML } from './page.js';
import { BRIDGE_SERVICE, createBridgeServer } from './server.js';

let stateDir = '';

let bridge: Server;
let baseUrl: string;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      resolve(address.port);
    });
  });
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function put(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  // The spool, the settled ring and printers.json all live under stateDir(). Point it at a
  // scratch directory so a test run never writes into the developer's real install.
  stateDir = mkdtempSync(join(tmpdir(), 'hankha-server-'));
  process.env.PRINT_BRIDGE_STATE_DIR = stateDir;
  // Short, so a test that deliberately targets an unreachable address is not a 15-second wait.
  process.env.PRINT_BRIDGE_SEND_TIMEOUT_MS = '1000';
  resetRegistryCache();
  bridge = createBridgeServer();
  baseUrl = `http://127.0.0.1:${await listen(bridge)}`;
});

after(() => {
  bridge.close();
  delete process.env.PRINT_BRIDGE_STATE_DIR;
  delete process.env.PRINT_BRIDGE_SEND_TIMEOUT_MS;
  rmSync(stateDir, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('identifies itself so the terminal can tell it from another app on the port', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, BRIDGE_SERVICE);
    assert.ok(typeof body.version === 'string');
    assert.ok(Array.isArray(body.interfaces));
    for (const iface of body.interfaces) {
      assert.ok(typeof iface.address === 'string');
      assert.ok(typeof iface.cidr === 'string' && iface.cidr.includes('/'));
    }
  });

  it('answers CORS preflight', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
  });
});

describe('GET /health diagnostics', () => {
  it('reports which machine is answering', async () => {
    // Once this runs as a launchd daemon or a scheduled task it is invisible, and the POS
    // settings screen is the only place an operator can tell "the bridge is up" apart from
    // "the bridge is up, but it's the one on the office PC".
    const body = await (await fetch(`${baseUrl}/health`)).json();
    assert.ok(typeof body.hostname === 'string' && body.hostname.length > 0);
    assert.ok(typeof body.platform === 'string' && body.platform.length > 0);
    assert.ok(typeof body.arch === 'string' && body.arch.length > 0);
    assert.equal(body.pid, process.pid);
    assert.ok(Number.isInteger(body.uptime_s) && body.uptime_s >= 0);
  });

  it('keeps ok first so a terminal that only reads that keeps working', async () => {
    const raw = await (await fetch(`${baseUrl}/health`)).text();
    assert.ok(raw.startsWith('{"ok":true'));
  });
});

describe('GET /', () => {
  it('answers a browser with a page instead of a JSON 404', async () => {
    // Typing the address the installer printed is the likeliest thing anyone ever does with this
    // process, and `{"ok":false,"reason":"not-found"}` reads as "the thing I just installed is
    // broken".
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    const html = await res.text();
    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.includes('Hankha Print Bridge'));
  });

  it('serves the same page for /index.html', async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
  });

  it('stays open when a token is set, so the page can explain that one is needed', async () => {
    process.env.PRINT_BRIDGE_TOKEN = 'shhh';
    try {
      // A 401 here would show an operator raw JSON in a browser. The page carries no venue data
      // of its own; every value on it comes from /status, which stays guarded.
      assert.equal((await fetch(`${baseUrl}/`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/status`)).status, 401);
    } finally {
      delete process.env.PRINT_BRIDGE_TOKEN;
    }
  });

  it('is self-contained, because the bridge is the only host it can reach', async () => {
    // A till with no internet must render this page identically. Nothing may be fetched from a
    // CDN, and the CSP says so as well as the markup.
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    assert.equal(html.includes('//fonts.'), false);
    assert.equal(/(src|href)="https?:/.test(html), false);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("connect-src 'self'"));
    // Without this the browser's default form submission would put the venue's printer token in
    // a URL query string if the token box's handler ever failed to run.
    assert.ok(csp.includes("form-action 'none'"));
  });

  it('survives a doubled slash rather than dying on it', async () => {
    // `new URL('//', base)` throws, and a throw inside a request listener is an
    // uncaughtException: before this was pinned to the path, one unauthenticated `GET //` from
    // anywhere on the venue LAN stopped the bridge. `//health` is the milder half of the same
    // bug — it parsed as the HOST `health` with the path `/`, so every doubled slash silently
    // routed somewhere else. The POS terminal really does produce these: its `normalizeBase`
    // exists because a stored `http://host:9200/` was building `…9200//print`.
    const doubled = await fetch(`${baseUrl}//`);
    assert.equal(doubled.status, 200);
    assert.match(doubled.headers.get('content-type') ?? '', /^text\/html/);

    const health = await fetch(`${baseUrl}//health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, BRIDGE_SERVICE);

    // Still answering, which is the part that was not true before.
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  });

  it('never spells the version expression that --define rewrites', () => {
    // `scripts/package.mjs` compiles with `--define process.env.APP_VERSION=...`, a source
    // rewrite that does not care whether the expression sits inside a string. Written here it
    // would be substituted into the served HTML, freezing the page at the build's version while
    // /health went on reporting the truth.
    assert.equal(INDEX_HTML.includes('process.env.APP_VERSION'), false);
  });
});

describe('POST /probe', () => {
  it('rejects a public address so the bridge cannot be used to scan the internet', async () => {
    const { status, json } = await post('/probe', { ip: '8.8.8.8', port: 80 });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.reason, 'invalid-body');
  });

  it('rejects a malformed port', async () => {
    const { status } = await post('/probe', { ip: '192.168.1.5', port: 99999 });
    assert.equal(status, 400);
  });

  it('rejects invalid JSON', async () => {
    const { status, json } = await post('/probe', '{oops');
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-json');
  });

  it('reports a live printer on this LAN as reachable', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const fake = createTcpServer();
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '0.0.0.0', () => {
        const address = fake.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    try {
      const { status, json } = await post('/probe', { ip: lan.address, port });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.reachable, true);
      assert.ok(typeof json.latency_ms === 'number');
    } finally {
      fake.close();
    }
  });

  it('reports a closed port as refused, not as a timeout', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const temp: TcpServer = createTcpServer();
    const closedPort = await new Promise<number>((resolve) => {
      temp.listen(0, '0.0.0.0', () => {
        const address = temp.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve) => temp.close(() => resolve()));

    const { json } = await post('/probe', { ip: lan.address, port: closedPort });
    assert.equal(json.reachable, false);
    assert.equal(json.reason, 'refused');
  });
});

describe('POST /print', () => {
  it('forwards the decoded bytes to the printer socket', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const received: Buffer[] = [];
    const fake = createTcpServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk));
    });
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '0.0.0.0', () => {
        const address = fake.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    try {
      const payload = Buffer.from('\x1b@HELLO\n');
      const { status, json } = await post('/print', {
        ip: lan.address,
        port,
        payload_base64: payload.toString('base64'),
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);

      // The socket write resolves before the peer necessarily flushed; give it a tick.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(Buffer.concat(received).toString(), '\x1b@HELLO\n');
    } finally {
      fake.close();
    }
  });

  it('rejects a job aimed at a public address', async () => {
    const { status } = await post('/print', {
      ip: '8.8.8.8',
      port: 9100,
      payload_base64: 'AA==',
    });
    assert.equal(status, 400);
  });

  /*
   * Idempotency on the LOCAL path.
   *
   * The cloud path has always had it — the server dedupes on `client_job_id` — but every
   * desktop till prints through this route, where a double-tapped button or a retried `fetch`
   * simply produced a second bill. The queue has kept a ring of settled job ids since it was
   * written; this route just never gave it one to remember.
   */
  it('replays a repeated job_id instead of printing a second copy', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    let connections = 0;
    const fake = createTcpServer((socket) => {
      connections += 1;
      socket.on('data', () => {});
    });
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '0.0.0.0', () => {
        const address = fake.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    try {
      const body = {
        ip: lan.address,
        port,
        job_id: 'till-slip-0001',
        payload_base64: Buffer.from('\x1b@BILL\n').toString('base64'),
      };

      const first = await post('/print', body);
      assert.equal(first.status, 200);
      assert.equal(first.json.deduplicated, undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(connections, 1);

      const second = await post('/print', body);
      assert.equal(second.status, 200);
      // Answered from the settled ring, and it says so — the caller can tell "printed" from
      // "printed a moment ago and I did not do it again".
      assert.equal(second.json.deduplicated, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(connections, 1, 'a replayed job_id must not open a second socket');
    } finally {
      fake.close();
    }
  });

  it('rejects a job_id that is not filesystem-safe, as a 400 rather than a 500', async () => {
    const { status, json } = await post('/print', {
      ip: '192.168.18.103',
      port: 9100,
      job_id: '../../../../tmp/escape',
      payload_base64: 'AA==',
    });
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-job-id');
  });

  it('still accepts the frozen contract with no job_id at all', async () => {
    // The shape every terminal in the field speaks. `job_id` is additive and optional forever.
    const { status } = await post('/print', {
      ip: '8.8.8.8',
      port: 9100,
      payload_base64: 'AA==',
    });
    assert.equal(status, 400, 'still validated the same way — no job_id required to be parsed');
  });
});

describe('POST /scan', () => {
  it('returns the subnets it swept', async () => {
    // Uses an unlikely port so the sweep finds nothing but still exercises the whole path.
    const { status, json } = await post('/scan', { port: 9 });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.subnets));
    assert.ok(Array.isArray(json.printers));
    assert.ok(typeof json.duration_ms === 'number');
    for (const subnet of json.subnets) assert.match(subnet, /^\d+\.\d+\.\d+\.0\/24$/);
  });

  it('shares one run between concurrent callers', async () => {
    const [a, b] = await Promise.all([post('/scan', { port: 9 }), post('/scan', { port: 9 })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // Same in-flight promise ⇒ byte-identical payloads, including the timing field.
    assert.deepEqual(a.json, b.json);
  });
});

describe('unknown routes', () => {
  it('404s', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});

/*
 * The POS terminal's contract, pinned.
 *
 * `features/printer/transports/network-transport.ts` sends exactly `{ip, port, payload_base64}`
 * and treats an HTTP 200 whose body says `ok: true` as PROOF a receipt printed. Its
 * `probeBridge()` calls `/health` with NO Authorization header. `bridge-client.ts` rejects the
 * bridge unless `service` is exactly 'hankha-print-bridge', and its `compareVersions` returns null
 * — silently disabling every version gate — for anything that is not three dotted numbers.
 *
 * All four of those are load-bearing on a till that will never be updated in step with this
 * process, so they are tests rather than comments.
 */
describe('POS terminal compatibility', () => {
  it('answers a successful /print with exactly { ok: true }', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const fake = createTcpServer((socket) => socket.resume());
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '0.0.0.0', () => {
        const address = fake.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    try {
      const { status, json } = await post('/print', {
        ip: lan.address, port, payload_base64: Buffer.from('x').toString('base64'),
      });
      assert.equal(status, 200);
      // Not `assert.equal(json.ok, true)`: an extra key here would be a new field the terminal
      // does not read, and the point is that the success body has never grown one.
      assert.deepEqual(json, { ok: true });
    } finally {
      fake.close();
    }
  });

  it('reports a failed /print with the reason the terminal shows the operator', async () => {
    const dead = createTcpServer();
    const port = await new Promise<number>((resolve) => {
      dead.listen(0, '127.0.0.1', () => {
        const address = dead.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });
    await new Promise<void>((r) => dead.close(() => r()));

    const { status, json } = await post('/print', {
      ip: '192.168.255.254', port, payload_base64: Buffer.from('x').toString('base64'),
    });
    assert.equal(status, 502);
    assert.equal(json.ok, false);
    assert.equal(typeof json.reason, 'string');
    // Additive fields the terminal ignores today but which the relay and the queue both use.
    assert.ok(json.printed_certainty === 'none' || json.printed_certainty === 'unknown');
  });

  it('rejects an empty payload as invalid rather than printing nothing', async () => {
    const { status, json } = await post('/print', { ip: '192.168.1.2', port: 9100, payload_base64: '' });
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-payload');
  });

  it('keeps /health open when a token is set, and guards everything else', async () => {
    process.env.PRINT_BRIDGE_TOKEN = 'shhh';
    try {
      // NetworkTransport.probeBridge() sends no Authorization header. If /health started
      // returning 401 the terminal would report the bridge as down, not as misconfigured.
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      const body = await health.json();
      assert.equal(body.ok, true);
      assert.equal(body.auth_required, true);

      assert.equal((await fetch(`${baseUrl}/printers`)).status, 401);
      const authorized = await fetch(`${baseUrl}/printers`, { headers: { Authorization: 'Bearer shhh' } });
      assert.equal(authorized.status, 200);
      // A near-miss must not pass: the comparison is constant-time over equal lengths.
      assert.equal((await fetch(`${baseUrl}/printers`, { headers: { Authorization: 'Bearer shhi' } })).status, 401);
    } finally {
      delete process.env.PRINT_BRIDGE_TOKEN;
    }
  });

  it('reports a version the terminal can actually parse', async () => {
    const body = await (await fetch(`${baseUrl}/health`)).json();
    // compareVersions() returns null for anything else, which silently disables every gate that
    // depends on it rather than failing visibly.
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.equal(body.service, 'hankha-print-bridge');
  });

  it('ignores a trailing slash, because half the clients build URLs by concatenation', async () => {
    assert.equal((await fetch(`${baseUrl}/health/`)).status, 200);
  });
});

describe('the printer registry over HTTP', () => {
  it('round-trips a registry and reports every validation error at once', async () => {
    const bad = await put('/printers', { printers: [{ id: 'x', transport: 'network' }, { id: 'y', transport: 'usb' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.reason, 'invalid-registry');
    assert.equal(bad.json.errors.length, 2);

    const good = await put('/printers', {
      printers: [
        // Deliberately an address nothing answers on. A test registry pointed at a plausible
        // venue subnet WILL find a real printer on a developer's LAN and print garbage on it.
        { id: 'counter', name: 'Counter', transport: 'network', address: '192.168.255.253', port: 9100 },
        { id: 'labels', name: 'Labels', transport: 'network', address: '192.168.255.252', type: 'label',
          language: 'tspl', width_mm: 50, height_mm: 30 },
      ],
      default_receipt_printer: 'counter',
    });
    assert.equal(good.status, 200);
    assert.equal(good.json.printers.length, 2);

    const read = await (await fetch(`${baseUrl}/printers`)).json();
    assert.equal(read.default_receipt_printer, 'counter');
    assert.equal(read.printers[0].dots_per_line, 576, 'defaults are filled in on the way through');
  });
});

describe('POST /jobs', () => {
  it('renders a receipt document and accepts it for printing', async () => {
    const { status, json } = await post('/jobs', {
      printer_id: 'counter',
      receipt: { elements: [{ type: 'text', value: 'HELLO' }, { type: 'columns', left: 'Latte', right: '25,000' }] },
    });
    assert.equal(status, 202);
    assert.equal(json.ok, true);
    assert.equal(json.job.printer_id, 'counter');
    assert.ok(json.job.bytes > 0, 'the document was rendered, not stored raw');
    assert.equal(json.job.payload_base64, undefined, 'a megabyte of base64 has no place in a status body');

    const fetched = await (await fetch(`${baseUrl}/jobs/${json.job.job_id}`)).json();
    assert.equal(fetched.ok, true);
    assert.equal(fetched.job.job_id, json.job.job_id);
  });

  it('refuses a receipt containing text no printer could render, naming the way out', async () => {
    const { status, json } = await post('/jobs', {
      printer_id: 'counter',
      receipt: { elements: [{ type: 'text', value: '2x ເຂົ້າຜັດໄກ່' }] },
    });
    // The original bug printed this as a blank line and reported success. A 422 naming the
    // characters is the whole improvement.
    assert.equal(status, 422);
    assert.equal(json.reason, 'render-failed');
    assert.match(json.errors[0], /'image' element/);
  });

  it('refuses a receipt document aimed at a label printer', async () => {
    const { status, json } = await post('/jobs', {
      printer_id: 'labels',
      receipt: { elements: [{ type: 'text', value: 'TOTAL' }] },
    });
    assert.equal(status, 422);
    assert.match(json.errors[0], /TSPL/);
  });

  it('reports document validation errors rather than printing something wrong', async () => {
    const { status, json } = await post('/jobs', {
      printer_id: 'labels',
      label: { elements: [{ type: 'barcode', x: 0, y: 0, symbology: 'NOPE', value: 'x' }] },
    });
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-document');
    assert.ok(json.errors.length > 0);
  });

  it('needs exactly one of payload_base64, receipt or label', async () => {
    assert.equal((await post('/jobs', { printer_id: 'counter' })).status, 400);
    assert.equal(
      (await post('/jobs', { printer_id: 'counter', payload_base64: 'AA==', receipt: { elements: [] } })).status,
      400
    );
  });

  it('404s an unknown job id', async () => {
    assert.equal((await fetch(`${baseUrl}/jobs/nope`)).status, 404);
  });
});

describe('GET /status', () => {
  it('reports transports, printers and queue depth', async () => {
    const { status, json } = await post('/jobs', { printer_id: 'counter', payload_base64: 'AAAA' });
    assert.equal(status, 202);
    assert.ok(json.job);

    const body = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.service, BRIDGE_SERVICE);
    // An empty printer list has two very different meanings; the availability flags are what tell
    // "no USB printers" apart from "this machine cannot see USB printers at all".
    assert.deepEqual(body.transports.map((t: { kind: string }) => t.kind), ['network', 'usb', 'serial']);
    assert.equal(body.printers.length, 2);
    assert.equal(typeof body.queue.pending, 'number');
    assert.equal(typeof body.queue.queued, 'number');
  });
});

describe('POST /discover', () => {
  it('answers with every transport, and says which ones this machine cannot use', async () => {
    // Port 9 so the sweep finds nothing but still exercises the whole path.
    const { status, json } = await post('/discover', { port: 9 });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.printers));
    assert.equal(json.transports.length, 3);
  });
});

describe('request limits', () => {
  it('refuses a body big enough to be a denial of service', async () => {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printer_id: 'counter', payload_base64: 'A'.repeat(9 * 1024 * 1024) }),
    }).catch(() => null);
    // The connection is destroyed as soon as the cap is passed, so either a 413 or a dropped
    // request is a pass — what must not happen is the body being buffered in full.
    assert.ok(res === null || res.status === 413, `expected 413 or a dropped request, got ${res?.status}`);
  });
});

/*
 * Pairing from the local page.
 *
 * These run against a stub API rather than the real one: `enroll()` posts to
 * `PRINT_BRIDGE_RELAY_URL`, which defaults to production. A test that reached api.hankha.la
 * would be both flaky and rude.
 *
 * The successful path is deliberately absent. A 200 here calls `startRelay()`, which is an
 * unbounded loop this suite has no way to stop — every case below stops one step short of that,
 * at the boundary the handler itself owns.
 */
describe('POST /enroll', () => {
  let api: Server;
  let apiCalls = 0;
  let previousRelayUrl: string | undefined;

  /**
   * What the fake API answers next. Mutable because the interesting cases are the ones the
   * bridge used to throw away: a 500 and a named 409 are the same `HTTP <status>` sentence
   * until something reads the body.
   */
  let apiReply = {
    status: 404,
    body: { detail: 'That enrollment code is not valid', code: 'not_found' } as unknown,
    headers: {} as Record<string, string>,
  };

  before(async () => {
    previousRelayUrl = process.env.PRINT_BRIDGE_RELAY_URL;
    api = createHttpServer((_req, res) => {
      apiCalls += 1;
      res.writeHead(apiReply.status, { 'Content-Type': 'application/json', ...apiReply.headers });
      res.end(JSON.stringify(apiReply.body));
    });
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${await listen(api)}`;
  });

  beforeEach(() => {
    apiReply = {
      status: 404,
      body: { detail: 'That enrollment code is not valid', code: 'not_found' },
      headers: {},
    };
  });

  after(() => {
    api.close();
    if (previousRelayUrl === undefined) delete process.env.PRINT_BRIDGE_RELAY_URL;
    else process.env.PRINT_BRIDGE_RELAY_URL = previousRelayUrl;
  });

  it('rejects a code that is not the shape the API mints, without a round trip', async () => {
    const before = apiCalls;
    const { status, json } = await post('/enroll', { code: 'NOPE' });
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-code-format');
    // The point of validating locally: an obvious typo is answered instantly, and the API's
    // per-IP enrolment limiter is not spent on it.
    assert.equal(apiCalls, before, 'a malformed code must not reach the API');
  });

  it('rejects the letters the alphabet deliberately omits', async () => {
    // O/0/I/1 are excluded upstream because the code is read aloud and retyped, so a code
    // containing them is always a misread of something else.
    const { status, json } = await post('/enroll', { code: 'O0I1-ABCD' });
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-code-format');
  });

  it('accepts what an operator actually types — lowercase, spaced, hyphen missing', async () => {
    const before = apiCalls;
    const { status } = await post('/enroll', { code: '  6xzr ttwf ' });
    // Reaching the API at all is the assertion: the code normalised to 6XZR-TTWF and passed
    // the format gate. The stub answers 404, so the handler reports the failure.
    assert.equal(apiCalls, before + 1, 'a normalisable code must reach the API');
    assert.equal(status, 502);
  });

  it('passes the API’s own wording through instead of inventing a reason', async () => {
    const { status, json } = await post('/enroll', { code: '6XZR-TTWF' });
    assert.equal(status, 502);
    assert.equal(json.reason, 'enroll-failed');
    assert.match(json.message, /not valid, has already been used, or has expired/);
  });

  it('refuses a code from anywhere but this machine', async () => {
    // The gate that matters. The Windows installer binds 0.0.0.0 and the shipped default sets
    // no token, so without this anyone on the venue wifi could pair the shop's bridge to their
    // own organisation and collect its bills.
    const lan = localInterfaces().find((i) => i.address && !i.address.startsWith('127.'));
    if (!lan) return; // CI containers sometimes have loopback only.

    const open = createHttpServer(bridge.listeners('request')[0] as never);
    const port = await new Promise<number>((resolve) => {
      open.listen(0, '0.0.0.0', () => {
        const address = open.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    try {
      const res = await fetch(`http://${lan.address}:${port}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '6XZR-TTWF' }),
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).reason, 'not-loopback');
    } finally {
      open.close();
    }
  });

  /*
   * What the API said, not just that it said no.
   *
   * `Enrollment failed: HTTP 500` with the body dropped is what shipped, and it cost a day of
   * debugging: the 500 had ONE recoverable cause — this computer already holds a bridge row in
   * the venue — and neither the CLI nor this page ever read the sentence that said so.
   */
  it('surfaces a named conflict instead of a bare status', async () => {
    apiReply = {
      status: 409,
      body: {
        detail: 'This computer is already paired with this venue as “Counter”.',
        code: 'print_bridge_already_paired',
      },
      headers: {},
    };

    const { status, json } = await post('/enroll', { code: '6XZR-TTWF' });
    assert.equal(status, 502);
    assert.match(json.message, /already paired/);
    assert.match(json.message, /Counter/);
    assert.match(json.message, /print_bridge_already_paired/);
  });

  it('prints the request id, the only thread back to the cause of a 5xx', async () => {
    // The API hides its own message on 5xx on purpose, so `detail` is the generic string and
    // the id is the only way to find the log line that has the real error.
    apiReply = {
      status: 500,
      body: { detail: 'Internal server error', code: 'internal_error' },
      headers: { 'X-Request-Id': 'req-abc123' },
    };

    const { json } = await post('/enroll', { code: '6XZR-TTWF' });
    assert.match(json.message, /ref req-abc123/);
    // 'internal_error' adds nothing an operator can act on — the id does.
    assert.doesNotMatch(json.message, /internal_error/);
  });

  it('still says something useful when the body is not JSON at all', async () => {
    // A gateway or CDN answering instead of the API sends HTML. Reading the body must not turn
    // a failed enrolment into a crash.
    apiReply = { status: 502, body: '<html>gateway</html>', headers: {} };

    const { status, json } = await post('/enroll', { code: '6XZR-TTWF' });
    assert.equal(status, 502);
    assert.match(json.message, /HTTP 502/);
  });

  /*
   * Re-pairing a bridge that is already paired.
   *
   * The gate reads the token from DISK rather than from `relayStatus()`, which describes the
   * loop and is false on a paired bridge whose relay never came up. Both cases below stop at
   * that gate, so neither reaches `startRelay()`.
   */
  describe('when this bridge already holds a token', () => {
    let previous: RelayState;

    beforeEach(() => {
      previous = loadState();
      saveState({ ...previous, bridge_id: '20', token: 'already-paired-token' });
    });

    after(() => {
      saveState(previous);
    });

    it('refuses a second enrolment, without spending the code', async () => {
      // Enrolling twice moves this machine's printers to whichever venue supplied the code, so
      // it must never be the incidental outcome of a pasted string. Not reaching the API also
      // means the one-time code survives to be typed somewhere it was actually meant to go.
      const before = apiCalls;
      const { status, json } = await post('/enroll', { code: '6XZR-TTWF' });
      assert.equal(status, 409);
      assert.equal(json.reason, 'already-enrolled');
      assert.equal(apiCalls, before, 'a refused re-pair must not reach the API');
    });

    it('lets `force` through, so a rejected credential can be replaced in place', async () => {
      // The state this exists for: the server has stopped accepting this bridge's token, the
      // relay loop has exited, and the local page is showing its Re-pair box. Without `force`
      // the only route back was deleting relay.json from a terminal.
      const before = apiCalls;
      const { status, json } = await post('/enroll', { code: '6XZR-TTWF', force: true });
      assert.equal(apiCalls, before + 1, 'a forced re-pair must reach the API');
      // The stub answers 404, so this stops short of `startRelay()` — passing the gate is the
      // assertion, and the failure it reports is the stub's, not the gate's.
      assert.equal(status, 502);
      assert.equal(json.reason, 'enroll-failed');
    });
  });
});

/*
 * Reaching a USB or serial printer from the synchronous route.
 *
 * `/print` used to require `ip` + `port`, which a printer wired to this machine simply does not
 * have — so the POS could list such a printer from the registry and had no way to send it a
 * bill. `prepare()` has resolved `printer_id` since the queue landed; these cover the route
 * finally offering the field, and the address form staying exactly as every deployed terminal
 * speaks it.
 *
 * Last in the file on purpose: it rewrites the registry, and `GET /status` above counts it.
 */
describe('POST /print by printer id', () => {
  it('resolves the id and forwards the bytes, with no address on the wire', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const received: Buffer[] = [];
    const fake = createTcpServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk));
    });
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '0.0.0.0', () => {
        const address = fake.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    try {
      const registered = await put('/printers', {
        printers: [
          { id: 'till', name: 'Till', transport: 'network', address: lan.address, port },
          { id: 'retired', name: 'Retired', transport: 'network', address: '192.168.255.251', enabled: false },
        ],
      });
      assert.equal(registered.status, 200);

      const { status, json } = await post('/print', {
        printer_id: 'till',
        payload_base64: Buffer.from('\x1b@BILL\n').toString('base64'),
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(Buffer.concat(received).toString(), '\x1b@BILL\n');
    } finally {
      fake.close();
    }
  });

  it('names the printer it could not find', async () => {
    const { status, json } = await post('/print', { printer_id: 'ghost', payload_base64: 'AA==' });
    assert.equal(status, 400);
    assert.equal(json.reason, 'unknown-printer');
    // `unknown-printer` alone cannot be acted on; which id failed is the whole message.
    assert.match(json.errors[0], /ghost/);
  });

  /* Disabled means deliberately out of service, not missing. Printing to it anyway would make
     the toggle in the console a lie. */
  it('refuses a printer the operator has turned off', async () => {
    const { status, json } = await post('/print', { printer_id: 'retired', payload_base64: 'AA==' });
    assert.equal(status, 400);
    assert.equal(json.reason, 'unknown-printer');
    assert.match(json.errors[0], /disabled/);
  });

  it('still refuses a request that names neither a printer nor an address', async () => {
    const { status, json } = await post('/print', { payload_base64: 'AA==' });
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-body');
  });

  /* The contract every deployed terminal speaks. An id must not have become mandatory. */
  it('leaves the address form exactly as it was', async () => {
    const { status } = await post('/print', { ip: '8.8.8.8', port: 9100, payload_base64: 'AA==' });
    assert.equal(status, 400);
  });
})


describe('job ids are filesystem-safe', () => {
  /*
   * `job_id` becomes a spool filename, and `join()` resolves `..` — so an id like this used to
   * write a caller-influenced JSON file outside the state directory and delete that path when
   * the job settled. Printer ids have been validated from the start; job ids were not, and the
   * prod deployment answers with no token at all.
   */
  it('refuses a job id that would escape the spool directory', async () => {
    const { status, json } = await post('/jobs', {
      job_id: '../../../../tmp/hankha-pwn',
      target: { ip: '192.168.1.50', port: 9100 },
      payload_base64: 'QQ==',
    });
    assert.equal(status, 400);
    assert.equal(json.reason, 'invalid-body');
    assert.match(json.errors.join('; '), /job_id/);
  });

  it('refuses an id with a path separator, which merely breaks spooling', async () => {
    const { status } = await post('/jobs', {
      job_id: 'a/b',
      target: { ip: '192.168.1.50', port: 9100 },
      payload_base64: 'QQ==',
    });
    assert.equal(status, 400);
  });

  it('still accepts an ordinary server-side id', async () => {
    const { status } = await post('/jobs', {
      job_id: 'job_01HZX.4-abc',
      target: { ip: '192.168.1.50', port: 9100 },
      payload_base64: 'QQ==',
    });
    assert.equal(status, 202);
  });
});

describe('monitoring surface', () => {
  // `curl -I` and every uptime monitor use HEAD, and /health — not / — is the URL they are
  // pointed at. It answered 404, having fallen through to the catch-all.
  it('answers HEAD /health', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  it('tells /status where printers.json is, and does not tell /health', async () => {
    const status = await (await fetch(`${baseUrl}/status`)).json();
    assert.equal(typeof status.registry_path, 'string');
    assert.ok(status.registry_path.endsWith('printers.json'));

    // /health is unauthenticated and LAN-reachable, and this path carries an account name.
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.registry_path, undefined);
  });
});

describe('cancelling a job', () => {
  /*
   * `cancel()` returns false for "unknown", "settled" and "printing" alike, so an id that never
   * existed came back as `already-printing-or-finished` — an answer that tells a caller a job it
   * never created is on the paper, which is exactly the answer that suppresses a retry.
   */
  it('answers 404 for a job id that never existed', async () => {
    const { status, json } = await post('/jobs/no-such-job/cancel', {});
    assert.equal(status, 404);
    assert.equal(json.reason, 'not-found');
  });
})
