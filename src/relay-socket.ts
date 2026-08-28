/*
 * A WebSocket client in about two hundred lines, because the alternative is a dependency.
 *
 * This project's whole shipping story is "zero runtime dependencies" — that is what lets it
 * cross-compile to three targets from one machine and build as a slim container. Adding `ws` for
 * one optional transport would trade that for a few hundred lines we can read.
 *
 * RFC 6455, client side only, and only the parts a job feed needs: the upgrade handshake, text
 * frames, continuation frames, ping/pong, and close. Binary frames are accepted and ignored;
 * extensions and subprotocols are not negotiated.
 *
 * The masking is not optional. A client MUST mask every frame it sends (RFC 6455 s5.3) and a
 * conforming server closes the connection on an unmasked one — a detail that is easy to skip and
 * fails only against real servers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
// The upgrade event hands over a real net.Socket (a TLSSocket over https, which extends it),
// not a bare Duplex — which is what makes setNoDelay available, and it matters: without it Nagle
// delays a small job frame by up to 40 ms behind the previous write.
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Refuse a frame large enough to be an attack rather than a print job. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface WebSocketClient {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Resolves once the connection is fully closed, for whatever reason. Never rejects. */
  readonly closed: Promise<{ code: number; reason: string }>;
}

/**
 * A handshake that was answered with an ordinary HTTP response.
 *
 * `status` is the whole point: a 404 or 426 means this server does not speak WebSocket at this
 * path and never will, which is a permanent condition to be remembered — whereas a dropped TCP
 * connection is transient and should be retried.
 */
export class WebSocketHandshakeError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'WebSocketHandshakeError';
    this.status = status;
  }
}

export interface ConnectOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  onMessage: (text: string) => void;
}

function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  const header: number[] = [0x80 | opcode];

  if (length < 126) header.push(0x80 | length);
  else if (length < 65536) header.push(0x80 | 126, (length >> 8) & 0xff, length & 0xff);
  else {
    header.push(0x80 | 127);
    // 64-bit length, big endian. The high four bytes are always zero here: nothing this sends
    // approaches 4 GiB, and writing them explicitly is cheaper than a BigInt.
    header.push(0, 0, 0, 0);
    header.push((length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  }

  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** Bytes consumed from the front of the buffer. */
  size: number;
}

/**
 * Read one frame, or return null when the buffer does not hold a whole one yet.
 *
 * Exported for the tests: framing is the part of this file where an off-by-one produces a silent
 * desync rather than an error, so it is pinned directly rather than only through a live socket.
 */
export function parseFrame(buffer: Buffer): ParsedFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;

  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error(`frame of ${big} bytes exceeds the limit`);
    length = Number(big);
    offset += 8;
  }

  // A server must not mask, but handle it rather than desync if one does.
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
  }

  return { fin, opcode, payload, size: offset + length };
}

export function connectWebSocket(options: ConnectOptions): Promise<WebSocketClient> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    const key = randomBytes(16).toString('base64');
    const timeoutMs = options.timeoutMs ?? 15_000;

    const req = (secure ? httpsRequest : httpRequest)({
      protocol: secure ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        ...options.headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(err);
    };

    req.setTimeout(timeoutMs, () => fail(new WebSocketHandshakeError('the handshake timed out', null)));
    req.on('error', (err) => fail(new WebSocketHandshakeError(err.message, null)));

    // An ordinary response means the server declined to upgrade. 404 and 426 are the two that mean
    // "this endpoint does not exist", which the relay remembers rather than retrying.
    req.on('response', (res) => {
      res.resume();
      fail(new WebSocketHandshakeError(`server answered HTTP ${res.statusCode} instead of upgrading`, res.statusCode ?? null));
    });

    req.on('upgrade', (res, socket: Socket, head: Buffer) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        fail(new WebSocketHandshakeError('the server returned a bad Sec-WebSocket-Accept', null));
        socket.destroy();
        return;
      }

      settled = true;
      socket.setTimeout(0);
      socket.setNoDelay(true);

      let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
      let fragments: Buffer[] = [];
      let fragmentOpcode = 0;
      let closeCode = 1006;
      let closeReason = 'connection lost';
      let finished = false;

      let resolveClosed: (value: { code: number; reason: string }) => void = () => {};
      const closed = new Promise<{ code: number; reason: string }>((r) => {
        resolveClosed = r;
      });

      const finish = () => {
        if (finished) return;
        finished = true;
        socket.destroy();
        resolveClosed({ code: closeCode, reason: closeReason });
      };

      const write = (opcode: number, payload: Buffer) => {
        if (finished || socket.destroyed) return;
        socket.write(maskedFrame(opcode, payload));
      };

      socket.on('data', (chunk: Buffer) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_MESSAGE_BYTES) {
          closeCode = 1009;
          closeReason = 'message too large';
          finish();
          return;
        }

        for (;;) {
          let frame: ParsedFrame | null;
          try {
            frame = parseFrame(buffer);
          } catch (err) {
            closeCode = 1002;
            closeReason = err instanceof Error ? err.message : 'protocol error';
            finish();
            return;
          }
          if (!frame) return;
          buffer = buffer.subarray(frame.size);

          switch (frame.opcode) {
            case OP_PING:
              // Answer with the same application data, which is what keeps a proxy or a load
              // balancer from deciding the connection is idle and dropping it.
              write(OP_PONG, frame.payload);
              break;

            case OP_PONG:
              break;

            case OP_CLOSE: {
              closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
              closeReason = frame.payload.subarray(2).toString('utf8');
              write(OP_CLOSE, frame.payload.subarray(0, 2));
              finish();
              return;
            }

            case OP_CONTINUATION:
            case OP_TEXT:
            case OP_BINARY: {
              if (frame.opcode !== OP_CONTINUATION) {
                fragments = [];
                fragmentOpcode = frame.opcode;
              }
              fragments.push(frame.payload);
              if (!frame.fin) break;

              const message = Buffer.concat(fragments);
              fragments = [];
              // Binary frames are accepted and dropped: the job feed is JSON, and refusing them
              // outright would break on a server that pings with binary payloads.
              if (fragmentOpcode === OP_TEXT) {
                try {
                  options.onMessage(message.toString('utf8'));
                } catch {
                  /* a bad message must not take the connection down */
                }
              }
              break;
            }

            default:
              closeCode = 1002;
              closeReason = `unknown opcode ${frame.opcode}`;
              finish();
              return;
          }
        }
      });

      socket.on('error', () => finish());
      socket.on('close', () => finish());
      socket.on('end', () => finish());

      resolve({
        send: (text: string) => write(OP_TEXT, Buffer.from(text, 'utf8')),
        close: (code = 1000, reason = '') => {
          const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
          payload.writeUInt16BE(code, 0);
          payload.write(reason, 2);
          write(OP_CLOSE, payload);
          closeCode = code;
          closeReason = reason;
          // Do not wait for the server's close frame forever: a half-open connection is exactly
          // what a shutdown must not hang on.
          setTimeout(finish, 1000).unref();
        },
        closed,
      });
    });

    req.end();
  });
}
