import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as netServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { setLogSink } from './log.js';

/*
 * What the LAN API adds to the relay: the heartbeat reports it, the key set arrives on enrolment,
 * the HTTP heartbeat and the websocket ack, and the frame's `pin_bridge_id` is honoured.
 *
 * Own file: the relay loop's state is module-global. A fake cloud speaks just enough HTTP and
 * websocket to carry the frames.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'hankha-relay-lan-'));
process.env.PRINT_BRIDGE_STATE_DIR = stateDir;
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'ws';
process.env.PRINT_BRIDGE_HEARTBEAT_MS = '150';
setLogSink(() => undefined);

const spki = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

/** Client websocket frames are masked; read the text ones. */
function readFrames(buffer: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let at = 0;
  for (;;) {
    if (buffer.length - at < 2) break;
    const b0 = buffer[at] as number;
    const b1 = buffer[at + 1] as number;
    let len = b1 & 0x7f;
    let offset = at + 2;
    if (len === 126) {
      if (buffer.length - offset < 2) break;
      len = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buffer.length - offset < 8) break;
      len = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = (b1 & 0x80) !== 0;
    const maskAt = offset;
    if (masked) offset += 4;
    if (buffer.length - offset < len) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + len));
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] = (payload[i] as number) ^ (buffer[maskAt + (i % 4)] as number);
    if ((b0 & 0x0f) === 1) texts.push(payload.toString('utf8'));
    at = offset + len;
  }
  return { texts, rest: buffer.subarray(at) };
}

const serverFrame = (text: string) => {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([head, body]);
};

const clientFrames: Record<string, any>[] = [];
const resultPosts: { id: string; body: Record<string, any> }[] = [];
const enrollBodies: Record<string, any>[] = [];
let enrollAnswer: Record<string, unknown> = { data: { bridge_id: '77', token: 'bridge-token' } };
let heartbeatAnswer: Record<string, unknown> = {};
let wsSocket: Socket | null = null;
let cloud: Server;
let cloudPort = 0;
const sockets: Socket[] = [];

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

after(() => {
  for (const s of sockets) s.destroy();
  cloud?.closeAllConnections?.();
  cloud?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

const free = () =>
  new Promise<number>((resolve) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe('the relay and the LAN print API', () => {
  it('starts a fake cloud', async () => {
    cloud = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? (JSON.parse(text) as Record<string, any>) : {};
        const url = req.url ?? '';
        if (url.endsWith('/bridge/enroll')) {
          enrollBodies.push(body);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(enrollAnswer));
        } else if (url.includes('/jobs/') && url.endsWith('/result')) {
          resultPosts.push({ id: url.split('/jobs/')[1]?.split('/')[0] ?? '', body });
          res.writeHead(200).end();
        } else if (url.endsWith('/bridge/heartbeat')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(heartbeatAnswer));
        } else {
          res.writeHead(200).end();
        }
      });
    });
    cloud.on('upgrade', (req, socket: Socket) => {
      wsSocket = socket;
      sockets.push(socket);
      socket.on('error', () => undefined);
      const key = req.headers['sec-websocket-key'] as string;
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let pending: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const { texts, rest } = readFrames(pending);
        pending = Buffer.from(rest);
        for (const t of texts) clientFrames.push(JSON.parse(t) as Record<string, any>);
      });
    });
    cloudPort = await new Promise<number>((resolve) => cloud.listen(0, '127.0.0.1', () => resolve((cloud.address() as { port: number }).port)));
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${cloudPort}`;
  });

  it('enrolment with the LAN API OFF: no lan field is sent, and a lan_keys answer is ignored and writes nothing', async () => {
    enrollAnswer = { data: { bridge_id: '77', token: 'bridge-token', lan_keys: [{ kid: 'ignored', pubkey: spki() }] } };
    const { enroll } = await import('./relay.js');
    await enroll('ABCD-2345');
    assert.equal('lan' in (enrollBodies[0] as object), false);
    assert.deepEqual(readdirSync(stateDir).filter((f) => f.startsWith('lan')), []);
  });

  it('turns the LAN API on', async () => {
    const { startLan } = await import('./lan-server.js');
    const port = await free();
    const handle = startLan({
      dir: stateDir,
      config: { port, host: '127.0.0.1' },
      queue: () => { throw new Error('unused'); },
      installId: () => 'i',
      bridgeId: () => '77',
      relayConnected: () => false,
      reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
    } as Parameters<typeof startLan>[0]);
    assert.ok(handle);
    await waitFor(() => handle.server.listening);
    (globalThis as any).__lanHandle = handle;
  });

  it('enrolment with it ON: reports the LAN state and keeps the key set the answer carries', async () => {
    const kid = 'from-enroll';
    enrollAnswer = { data: { bridge_id: '77', token: 'bridge-token', lan_keys: [{ kid, pubkey: spki(), not_before: 0, not_after: null }] } };
    const { enroll } = await import('./relay.js');
    await enroll('ABCD-2345');
    const body = enrollBodies[1] as Record<string, any>;
    assert.equal(body.lan.protocol, 1);
    assert.equal(body.lan.listening, true);
    assert.equal(body.lan.enabled, true);
    assert.deepEqual(body.lan.capabilities, ['print_lan_v1']);
    assert.equal(typeof body.lan.pubkey, 'string');
    assert.ok(Array.isArray(body.interfaces), 'interfaces are reported as always');
    const { activeLanKeys } = await import('./lan-keys.js');
    assert.ok(activeLanKeys()?.kids().includes(kid));
  });

  it('the HTTP heartbeat answer\'s lan_keys are applied while ON', async () => {
    heartbeatAnswer = { data: { lan_keys: [{ kid: 'from-heartbeat', pubkey: spki() }] } };
    const { heartbeat } = await import('./relay.js');
    assert.equal(await heartbeat(`http://127.0.0.1:${cloudPort}`, 'bridge-token'), 200);
    const { activeLanKeys } = await import('./lan-keys.js');
    assert.ok(activeLanKeys()?.kids().includes('from-heartbeat'));
    assert.equal(activeLanKeys()?.kids().includes('from-enroll'), false, 'the backend\'s list replaces the previous one');
    // The relay's own periodic heartbeat reads this answer too; from here on it carries no keys.
    heartbeatAnswer = {};
  });

  it('connects over the websocket, and its hello and heartbeat frames carry the LAN state', async () => {
    const { startRelay } = await import('./relay.js');
    startRelay();
    await waitFor(() => clientFrames.some((f) => f.type === 'hello'));
    const hello = clientFrames.find((f) => f.type === 'hello') as Record<string, any>;
    assert.equal(hello.lan.listening, true);
    assert.equal(hello.lan.protocol, 1);
    assert.ok(hello.lan.key_ids.includes('from-heartbeat'));
    assert.match(hello.lan.pubkey, /^[A-Za-z0-9_-]{20,}$/);
    await waitFor(() => clientFrames.some((f) => f.type === 'heartbeat' && f.lan));
  });

  it('a websocket ack carrying lan_keys updates the key set', async () => {
    (wsSocket as Socket).write(serverFrame(JSON.stringify({ type: 'ack', lan_keys: [{ kid: 'from-ack', pubkey: spki() }] })));
    const { activeLanKeys } = await import('./lan-keys.js');
    await waitFor(() => activeLanKeys()?.kids().includes('from-ack') === true);
  });

  it('an ack with no lan_keys, or with an empty list, leaves the set alone', async () => {
    const { activeLanKeys } = await import('./lan-keys.js');
    const before = activeLanKeys()?.kids().join(',');
    (wsSocket as Socket).write(serverFrame(JSON.stringify({ type: 'ack' })));
    (wsSocket as Socket).write(serverFrame(JSON.stringify({ type: 'ack', lan_keys: [] })));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(activeLanKeys()?.kids().join(','), before);
  });

  it('a print frame pinned to another Bridge is refused over the websocket too, and nothing is sent to a printer', async () => {
    (wsSocket as Socket).write(serverFrame(JSON.stringify({
      type: 'print',
      job: {
        job_id: 'pinned-elsewhere-1', client_job_id: 'c1', printer_id: 'receipt', kind: 'RECEIPT', target_ip: null, target_port: 9100,
        document: { kind: 'receipt', elements: [{ type: 'text', value: 'x' }] }, payload_sha256: '0'.repeat(64), attempt: 1,
        claim_expires_at: new Date(Date.now() + 60_000).toISOString(), dedupe_key: 'sale-7000-r0', pin_bridge_id: '99',
      },
    })));
    await waitFor(() => resultPosts.some((p) => p.id === 'pinned-elsewhere-1'));
    const result = resultPosts.find((p) => p.id === 'pinned-elsewhere-1')?.body as Record<string, any>;
    assert.equal(result.reason, 'device-missing');
    assert.equal(result.printed_certainty, 'none');
  });

  it('turning the LAN API off again drops the field from the next heartbeat', async () => {
    await (globalThis as any).__lanHandle.stop();
    const mark = clientFrames.length;
    await waitFor(() => clientFrames.slice(mark).some((f) => f.type === 'heartbeat'));
    assert.equal(clientFrames.slice(mark).some((f) => f.type === 'heartbeat' && 'lan' in f), false);
  });

  it('with it OFF the HTTP heartbeat answer is not even read', async () => {
    let jsonCalls = 0;
    const fake = mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => {
        jsonCalls += 1;
        return { data: { lan_keys: [{ kid: 'nope', pubkey: spki() }] } };
      },
      body: { cancel: async () => undefined },
    }) as unknown as Response);
    try {
      const { heartbeat } = await import('./relay.js');
      assert.equal(await heartbeat('http://relay.invalid', 't'), 200);
      assert.equal(jsonCalls, 0);
    } finally {
      fake.mock.restore();
    }
  });
});
