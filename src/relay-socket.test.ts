import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { after, describe, it } from 'node:test';
import { connectWebSocket, parseFrame, WebSocketHandshakeError } from './relay-socket.js';

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
  server.on('upgrade', (_req, socket: Socket) => sockets.push(socket));
  server.on('connection', (socket: Socket) => sockets.push(socket));
  // Never hold the process open on our account.
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
      // FIN=0 text, then FIN=1 continuation. A large job frame arrives this way through some
      // proxies whether the server intended it or not.
      socket.write(Buffer.concat([Buffer.from([0x01, 5]), Buffer.from('{"ty')]));
      socket.write(Buffer.concat([Buffer.from([0x01, 1]), Buffer.from('p')]));
      socket.write(Buffer.concat([Buffer.from([0x80, 8]), Buffer.from('e":"x"}')]));
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
