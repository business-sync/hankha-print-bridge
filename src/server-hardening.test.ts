import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resetRegistryCache } from './registry.js';
import { createBridgeServer } from './server.js';

/*
 * The HTTP side of the hardening: what the network-facing routes refuse.
 *
 * Its own file (so its own process): the queue is a per-process singleton bound to the state
 * directory at first use, and one of these tests deliberately breaks the spool.
 */

let stateDir = '';
let bridge: Server;
let port = 0;

interface Answer {
  status: number;
  json: any;
}

/** `fetch` cannot set `Host`, and a rebinding page's whole trick is a wrong one. */
function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON: the page */
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'hankha-hardening-'));
  process.env.PRINT_BRIDGE_STATE_DIR = stateDir;
  process.env.PRINT_BRIDGE_SEND_TIMEOUT_MS = '1000';
  resetRegistryCache();
  bridge = createBridgeServer();
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const address = bridge.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  port = address.port;
});

after(() => {
  bridge.close();
  delete process.env.PRINT_BRIDGE_STATE_DIR;
  delete process.env.PRINT_BRIDGE_SEND_TIMEOUT_MS;
  rmSync(stateDir, { recursive: true, force: true });
});

describe('PUT /printers and the serial device', () => {
  const body = (device: string) => ({
    printers: [{ id: 'serial-1', name: 'Serial', transport: 'serial', device, type: 'receipt', language: 'escpos' }],
  });

  it('refuses a device that is not a serial port, and says which one', async () => {
    const res = await call('PUT', '/printers', { body: body('/etc/passwd') });
    assert.equal(res.status, 400);
    assert.ok(JSON.stringify(res.json).includes('/etc/passwd'), JSON.stringify(res.json));
  });

  it('refuses traversal out of /dev', async () => {
    const res = await call('PUT', '/printers', { body: body('/dev/../etc/passwd') });
    assert.equal(res.status, 400);
  });

  it('does not store the refused registry', async () => {
    const res = await call('GET', '/printers');
    assert.equal(res.status, 200);
    assert.deepEqual((res.json.printers ?? []).filter((p: any) => p.id === 'serial-1'), []);
  });

  it('accepts a real port', async () => {
    const res = await call('PUT', '/printers', { body: body('/dev/cu.RPP02N') });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    // Leave the registry empty again for the tests below.
    await call('PUT', '/printers', { body: { printers: [] } });
  });
});

describe('pairing routes and the web', () => {
  it('answers a plain request from the till itself', async () => {
    const res = await call('GET', '/pairing');
    assert.notEqual(res.status, 403, JSON.stringify(res.json));
  });

  it('answers the pairing page opened from the bridge\'s own address', async () => {
    const res = await call('GET', '/pairing', { headers: { Origin: `http://127.0.0.1:${port}` } });
    assert.notEqual(res.status, 403);
    const named = await call('GET', '/pairing', { headers: { Origin: 'http://localhost:9200', Host: 'localhost:9200' } });
    assert.notEqual(named.status, 403);
  });

  it('refuses another website reading the pairing code', async () => {
    const res = await call('GET', '/pairing', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'cross-origin');
  });

  it('refuses a sandboxed or opaque origin too', async () => {
    const res = await call('GET', '/pairing', { headers: { Origin: 'null' } });
    assert.equal(res.status, 403);
  });

  it('refuses a DNS-rebinding page, which sends the attacker\'s name as Host and no Origin at all', async () => {
    const res = await call('GET', '/pairing', { headers: { Host: 'attacker.example:9200' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'bad-host');
  });

  it('refuses another website claiming this computer', async () => {
    const res = await call('POST', '/enroll', {
      headers: { Origin: 'https://evil.example' },
      body: { code: 'ABCD-EFGH', force: true },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'cross-origin');
  });

  it('applies to the restart and handoff routes as well', async () => {
    for (const [method, path] of [['POST', '/pairing/restart'], ['GET', '/pairing/handoff']] as const) {
      const res = await call(method, path, { headers: { Origin: 'https://evil.example' } });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });

  it('does NOT require same-site: the POS reaches the handoff by navigating from its own site', async () => {
    // A top-level navigation carries Sec-Fetch-Site: cross-site and no Origin. It must still get
    // through, or pairing from the POS stops working.
    const res = await call('GET', '/pairing/handoff', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
    assert.notEqual(res.status, 403);
  });

  it('leaves the rest of the API reachable cross-origin, as the POS needs', async () => {
    const res = await call('GET', '/health', { headers: { Origin: 'https://pos.hankha.la' } });
    assert.equal(res.status, 200);
  });
});

describe('POST /jobs when the spool cannot be written', () => {
  it('answers 507 and keeps nothing, instead of promising a job a restart would lose', async () => {
    // A file where the spool directory belongs (it may already exist as a directory by now).
    rmSync(join(stateDir, 'spool'), { recursive: true, force: true });
    writeFileSync(join(stateDir, 'spool'), 'not a directory');
    const res = await call('POST', '/jobs', {
      body: { job_id: 'disk-full-1', target: { ip: '192.168.1.50', port: 9100 }, payload_base64: Buffer.from('x').toString('base64') },
    });
    assert.equal(res.status, 507, JSON.stringify(res.json));
    assert.equal(res.json.reason, 'spool-write-failed');
    assert.equal(res.json.printed_certainty, 'none');

    const status = await call('GET', '/jobs/disk-full-1');
    assert.equal(status.status, 404, 'a refused job must not be listed as accepted');
    assert.equal(readFileSync(join(stateDir, 'spool'), 'utf8'), 'not a directory');
  });
});
