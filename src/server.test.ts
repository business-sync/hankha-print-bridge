import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { localInterfaces } from './lan.js';
import { BRIDGE_SERVICE, createBridgeServer } from './server.js';

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

before(async () => {
  bridge = createBridgeServer();
  baseUrl = `http://127.0.0.1:${await listen(bridge)}`;
});

after(() => {
  bridge.close();
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
