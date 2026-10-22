import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { after, describe, it } from 'node:test';
import { createServer as createTcpServer } from 'node:net';
import { type LogRecord, setLogSink } from './log.js';
import {
  connectNativeWebSocket,
  connectWebSocket,
  type NativeWebSocketCtor,
  parseFrame,
  WebSocketHandshakeError,
} from './relay-socket.js';

/*
 * Framing is the part of a hand-written WebSocket that fails silently: an off-by-one in a length
 * prefix does not throw, it desyncs the stream and every later message becomes garbage. So the
 * codec is pinned directly, and then exercised once against a real socket end to end.
 */

const servers: Server[] = [];
/**
 * Every socket the fake servers accepted.
 *
 * An upgraded connection is deliberately outside the server's own lifecycle — that is what makes
 * it an upgrade — so `server.close()` does not touch it and the event loop stays alive. Tracking
 * them is what lets this file exit.
 */
const sockets: Socket[] = [];
after(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

function track(server: Server): Server {
  servers.push(server);
  // Only 'connection' — which also covers sockets that are later upgraded. Registering an
  // 'upgrade' listener here would change the SERVER's behaviour: node routes a request carrying an
  // Upgrade header to 'upgrade' instead of 'request' as soon as one exists, so the 404 server
  // below would stop answering and simply hang.
  server.on('connection', (socket: Socket) => sockets.push(socket));
  server.unref();
  return server;
}

/** A server-to-client frame: never masked, which is the opposite of the rule for a client. */
function serverFrame(opcode: number, payload: Buffer): Buffer {
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) header.push(payload.length);
  else if (payload.length < 65536) header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  else {
    header.push(127, 0, 0, 0, 0);
    header.push((payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff);
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

function upgradeServer(onSocket: (socket: Socket) => void): Promise<string> {
  return new Promise((resolve) => {
    const server = track(createServer((_req, res) => {
      res.writeHead(404).end();
    }));
    server.on('upgrade', (req, socket: Socket) => {
      const key = req.headers['sec-websocket-key'] as string;
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      onSocket(socket);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      resolve(`ws://127.0.0.1:${address.port}/socket`);
    });
  });
}

describe('frame codec', () => {
  it('reads a 7-bit length', () => {
    const frame = parseFrame(serverFrame(0x1, Buffer.from('hello')));
    assert.equal(frame?.payload.toString(), 'hello');
    assert.equal(frame?.fin, true);
    assert.equal(frame?.opcode, 0x1);
  });

  it('reads a 16-bit length', () => {
    const payload = Buffer.alloc(300, 0x61);
    const frame = parseFrame(serverFrame(0x1, payload));
    assert.equal(frame?.payload.length, 300);
    assert.equal(frame?.size, 4 + 300);
  });

  it('reads a 64-bit length', () => {
    // A rastered receipt easily passes 65535 bytes, so this path is used in production, not
    // theoretically.
    const payload = Buffer.alloc(70_000, 0x62);
    const frame = parseFrame(serverFrame(0x2, payload));
    assert.equal(frame?.payload.length, 70_000);
    assert.equal(frame?.size, 10 + 70_000);
  });

  it('returns null until a whole frame has arrived', () => {
    const full = serverFrame(0x1, Buffer.from('hello'));
    assert.equal(parseFrame(full.subarray(0, 1)), null);
    assert.equal(parseFrame(full.subarray(0, 4)), null);
    assert.ok(parseFrame(full));
  });

  it('unmasks a frame even though a server should not send one', () => {
    const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const text = Buffer.from('masked!');
    const masked = Buffer.allocUnsafe(text.length);
    for (let i = 0; i < text.length; i++) masked[i] = (text[i] ?? 0) ^ (mask[i % 4] ?? 0);
    const frame = parseFrame(Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, masked]));
    assert.equal(frame?.payload.toString(), 'masked!');
  });

  it('refuses a frame large enough to be an attack', () => {
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(1n << 40n, 2);
    assert.throws(() => parseFrame(header), /exceeds the limit/);
  });
});

describe('a live connection', () => {
  it('completes the handshake, receives, sends masked, and closes', async () => {
    const fromClient: string[] = [];
    const url = await upgradeServer((socket) => {
      socket.write(serverFrame(0x1, Buffer.from(JSON.stringify({ type: 'print' }))));
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const frame = parseFrame(buffer);
          if (!frame) return;
          buffer = buffer.subarray(frame.size);
          // RFC 6455 s5.3: a client MUST mask. A conforming server closes on an unmasked frame,
          // so this is the assertion that catches an implementation that "works" against a lenient
          // test double and fails against a real server.
          assert.equal((chunk[1] ?? 0) & 0x80, 0x80, 'client frames must be masked');
          if (frame.opcode === 0x1) fromClient.push(frame.payload.toString());
        }
      });
    });

    const received: string[] = [];
    const client = await connectWebSocket({ url, onMessage: (text) => received.push(text) });
    client.send('hello from the bridge');
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual(received, [JSON.stringify({ type: 'print' })]);
    assert.deepEqual(fromClient, ['hello from the bridge']);

    client.close(1000, 'done');
    const closed = await client.closed;
    assert.equal(closed.code, 1000);
  });

  it('reassembles a fragmented message', async () => {
    const url = await upgradeServer((socket) => {
      // Text with FIN=0 (0x01), then continuations (opcode 0x00), the last with FIN set (0x80).
      // A large job frame arrives this way through some proxies whether the server intended it or
      // not, so the reassembly has to be real rather than assumed.
      socket.write(Buffer.concat([Buffer.from([0x01, 4]), Buffer.from('{"ty')]));
      socket.write(Buffer.concat([Buffer.from([0x00, 1]), Buffer.from('p')]));
      socket.write(Buffer.concat([Buffer.from([0x80, 7]), Buffer.from('e":"x"}')]));
    });

    const received: string[] = [];
    const client = await connectWebSocket({ url, onMessage: (text) => received.push(text) });
    await new Promise((r) => setTimeout(r, 100));
    client.close();
    assert.deepEqual(received, ['{"type":"x"}']);
  });

  it('answers a ping, which is what keeps a proxy from dropping the connection', async () => {
    let pong: Buffer | null = null;
    const url = await upgradeServer((socket) => {
      socket.write(serverFrame(0x9, Buffer.from('ka')));
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const frame = parseFrame(buffer);
        if (frame?.opcode === 0xa) pong = frame.payload;
      });
    });

    const client = await connectWebSocket({ url, onMessage: () => {} });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((pong as Buffer | null)?.toString(), 'ka');
    client.close();
  });
});

describe('liveness', () => {
  it('closes a connection that goes silent, so a half-open link cannot hold the job feed', async () => {
    // Accepts the upgrade and then never sends or answers anything, like a peer behind a dead NAT.
    const url = await upgradeServer(() => {});
    const client = await connectWebSocket({ url, idleTimeoutMs: 150, onMessage: () => {} });
    const closed = await client.closed;
    assert.equal(closed.code, 1006);
    assert.equal(closed.reason, 'no traffic from server');
    // Ours, not the network's: the same 1006 a dropped link produces, told apart here.
    assert.equal(closed.closed_by, 'local');
  });

  it('stays open while the peer answers the client ping', async () => {
    const url = await upgradeServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const frame = parseFrame(buffer);
          if (!frame) return;
          buffer = buffer.subarray(frame.size);
          if (frame.opcode === 0x9) socket.write(serverFrame(0xa, frame.payload));
        }
      });
    });
    const client = await connectWebSocket({ url, idleTimeoutMs: 150, onMessage: () => {} });
    const outcome = await Promise.race([
      client.closed.then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('open'), 500)),
    ]);
    assert.equal(outcome, 'open');
    client.close();
  });
});

describe('handshake failures', () => {
  it('reports the HTTP status, so a missing endpoint can be told from a network fault', async () => {
    const server = track(createServer((_req, res) => res.writeHead(404).end()));
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    try {
      await connectWebSocket({ url: `ws://127.0.0.1:${port}/socket`, onMessage: () => {} });
      assert.fail('should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebSocketHandshakeError);
      // 404 is a fact about the deployment, not a transient fault. The relay remembers it and
      // falls back to long-polling instead of retrying every 30 seconds forever.
      assert.equal(err.status, 404);
    }
  });

  it('rejects a bad Sec-WebSocket-Accept rather than trusting the peer', async () => {
    const server = track(createServer());
    server.on('upgrade', (_req, socket: Socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    await assert.rejects(
      connectWebSocket({ url: `ws://127.0.0.1:${port}/socket`, onMessage: () => {} }),
      /Sec-WebSocket-Accept/
    );
  });

  it('gives up on a server that never answers', async () => {
    const server = track(createServer());
    server.on('upgrade', () => {
      /* accept the socket and say nothing at all */
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (typeof address === 'string' || address === null) throw new Error('no port');
        resolve(address.port);
      });
    });

    await assert.rejects(
      connectWebSocket({ url: `ws://127.0.0.1:${port}/socket`, onMessage: () => {}, timeoutMs: 300 }),
      /timed out/
    );
  });
});

/*
 * Who closed a connection is the first question about a dropped feed, and a close code alone
 * cannot answer it: 1006 is both "we gave up on a silent link" and "the network died under us".
 */
describe('who closed it', () => {
  it('marks a server close frame as remote, with its code and reason', async () => {
    const url = await upgradeServer((socket) => {
      const payload = Buffer.alloc(2 + 'going away'.length);
      payload.writeUInt16BE(1001, 0);
      payload.write('going away', 2);
      setTimeout(() => socket.write(serverFrame(0x8, payload)), 20);
    });
    const client = await connectWebSocket({ url, onMessage: () => {} });
    const closed = await client.closed;
    assert.deepEqual(
      { code: closed.code, reason: closed.reason, closed_by: closed.closed_by },
      { code: 1001, reason: 'going away', closed_by: 'remote' }
    );
  });

  it('marks our own close() as local', async () => {
    const url = await upgradeServer(() => {});
    const client = await connectWebSocket({ url, onMessage: () => {} });
    client.close(4000, 'no ack');
    const closed = await client.closed;
    assert.equal(closed.closed_by, 'local');
    assert.equal(closed.reason, 'no ack');
  });

  it('marks a TCP end with no close frame as network', async () => {
    const url = await upgradeServer((socket) => setTimeout(() => socket.end(), 20));
    const client = await connectWebSocket({ url, onMessage: () => {} });
    const closed = await client.closed;
    assert.equal(closed.code, 1006);
    assert.equal(closed.closed_by, 'network');
  });

  /*
   * The socket error used to be thrown away, so every reset, timeout and unreachable network read
   * the same `1006 connection lost`.
   */
  it('keeps the socket error code behind a reset', async () => {
    const url = await upgradeServer((socket) => setTimeout(() => socket.resetAndDestroy(), 20));
    const client = await connectWebSocket({ url, onMessage: () => {} });
    const closed = await client.closed;
    assert.equal(closed.closed_by, 'network');
    assert.equal(closed.error_code, 'ECONNRESET');
    assert.equal(closed.reason, 'connection lost: ECONNRESET');
  });

  it('carries the socket error code on a handshake that never got an answer', async () => {
    // A port that was free a moment ago: nothing listening, so the connect is refused.
    const probe = createTcpServer();
    const port = await new Promise<number>((resolve) => probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port)));
    await new Promise<void>((r) => probe.close(() => r()));
    try {
      await connectWebSocket({ url: `ws://127.0.0.1:${port}/socket`, onMessage: () => {} });
      assert.fail('should have rejected');
    } catch (err) {
      assert.ok(err instanceof WebSocketHandshakeError);
      assert.equal(err.status, null);
      assert.equal(err.code, 'ECONNREFUSED');
    }
  });

  it('logs a message handler that throws instead of swallowing it, and stays connected', async () => {
    const records: LogRecord[] = [];
    const restore = setLogSink((r) => records.push(r));
    try {
      const url = await upgradeServer((socket) => socket.write(serverFrame(0x1, Buffer.from('{}'))));
      const client = await connectWebSocket({
        url,
        onMessage: () => {
          throw new Error('handler bug');
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      const line = records.find((r) => r.event === 'relay.ws.handler_error');
      assert.ok(line, 'the throw was logged');
      assert.equal(line.fields.error_message, 'handler bug');
      assert.match(String(line.fields.stack), /handler bug/);
      client.close();
      assert.equal((await client.closed).closed_by, 'local');
    } finally {
      restore();
    }
  });
});

/*
 * The runtime's own WebSocket, which is what the compiled (Bun) binary uses: Bun's `node:http`
 * reports a 101 as an ordinary response, so the hand-written client above never connected there.
 * A fake stands in for Bun's class; what is pinned is the mapping onto `WebSocketClient`.
 */
describe('the native client', () => {
  class FakeSocket {
    static last: FakeSocket | null = null;
    readyState = 0;
    sent: string[] = [];
    pings = 0;
    closedWith: [number?, string?] | null = null;
    private listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
    constructor(readonly url: string, readonly init: { headers?: Record<string, string> }) {
      FakeSocket.last = this;
    }
    addEventListener(type: string, fn: (event: Record<string, unknown>) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    emit(type: string, event: Record<string, unknown> = {}) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
    send(text: string) {
      this.sent.push(text);
    }
    close(code?: number, reason?: string) {
      this.closedWith = [code, reason];
    }
    ping() {
      this.pings += 1;
    }
  }
  const Fake = FakeSocket as unknown as NativeWebSocketCtor;

  it('sends the token on the handshake, delivers text frames, and closes locally', async () => {
    const messages: string[] = [];
    const connecting = connectNativeWebSocket(
      { url: 'ws://127.0.0.1:1/socket', headers: { Authorization: 'Bearer t' }, onMessage: (t) => messages.push(t) },
      Fake
    );
    const ws = FakeSocket.last!;
    assert.deepEqual(ws.init.headers, { Authorization: 'Bearer t' });
    ws.emit('open');
    const client = await connecting;
    ws.emit('message', { data: '{"type":"ack"}' });
    ws.emit('message', { data: new ArrayBuffer(4) });
    client.send('hello');
    assert.deepEqual(messages, ['{"type":"ack"}']);
    assert.deepEqual(ws.sent, ['hello']);

    client.close(1000, 'bye');
    assert.deepEqual(ws.closedWith, [1000, 'bye']);
    ws.emit('close', { code: 1000, reason: 'bye' });
    assert.deepEqual(await client.closed, { code: 1000, reason: 'bye', closed_by: 'local' });
  });

  it('tells a server close from the network dropping out', async () => {
    const remote = connectNativeWebSocket({ url: 'ws://127.0.0.1:1/', onMessage: () => {} }, Fake);
    FakeSocket.last!.emit('open');
    const a = await remote;
    FakeSocket.last!.emit('close', { code: 1000, reason: 'superseded by a newer connection' });
    assert.equal((await a.closed).closed_by, 'remote');

    const dropped = connectNativeWebSocket({ url: 'ws://127.0.0.1:1/', onMessage: () => {} }, Fake);
    FakeSocket.last!.emit('open');
    const b = await dropped;
    FakeSocket.last!.emit('error', { message: 'ECONNRESET' });
    FakeSocket.last!.emit('close', { code: 1006, reason: '' });
    const info = await b.closed;
    assert.equal(info.closed_by, 'network');
    assert.match(info.reason, /ECONNRESET/);
  });

  it('pings, and closes a link that goes silent', async () => {
    const connecting = connectNativeWebSocket({ url: 'ws://127.0.0.1:1/', idleTimeoutMs: 90, onMessage: () => {} }, Fake);
    const ws = FakeSocket.last!;
    ws.emit('open');
    const client = await connecting;
    // A server ping keeps it alive past one idle period.
    await new Promise((resolve) => setTimeout(resolve, 60));
    ws.emit('ping');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(ws.closedWith, null);
    const info = await client.closed;
    assert.equal(info.closed_by, 'local');
    assert.equal(info.reason, 'no traffic from server');
    assert.ok(ws.pings >= 1, 'pinged the server');
  });

  it('reads the status of a refused handshake, which the native socket does not report', async () => {
    const server = track(createServer((_req, res) => {
      res.writeHead(401).end();
    }));
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    const connecting = connectNativeWebSocket({ url: `ws://127.0.0.1:${port}/socket`, onMessage: () => {} }, Fake);
    FakeSocket.last!.emit('error', { message: 'Expected 101 status code' });
    FakeSocket.last!.emit('close', { code: 1002, reason: 'Expected 101 status code' });
    await assert.rejects(connecting, (err: unknown) => err instanceof WebSocketHandshakeError && err.status === 401);
  });
});
