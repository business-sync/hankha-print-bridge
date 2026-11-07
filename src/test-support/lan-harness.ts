/*
 * A real LAN listener on a real socket, a real queue and spool on disk, real crypto — and a fake
 * 9100 printer that counts the connections and bytes it receives.
 *
 * Nothing about the cryptography is mocked: the terminal here signs with Node's P-256, the "backend"
 * signs tickets with Ed25519, and the Bridge verifies them with its own code. The signing strings
 * are built by hand below rather than with the Bridge's helpers, so a drift in `lan-auth.ts` fails a
 * test instead of being mirrored by it.
 *
 * The one redirection: a registry printer must have an RFC1918 address, which a fake on this
 * machine's loopback does not, so the queue's sender dials the fake at 127.0.0.1 whatever the
 * registry says. Everything up to and including the socket write is the production path.
 */
import {
  createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject,
} from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer, type Server as NetServer, type Socket } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendToPrinter } from '../lan.js';
import { LanAuth } from '../lan-auth.js';
import { LanKeyStore } from '../lan-keys.js';
import { createLanServer } from '../lan-server.js';
import type { PrintOutcome } from '../lan.js';
import { mock } from 'node:test';
import { PrintQueue, queue as globalQueue, type QueueOptions } from '../queue.js';
import { networkTransport } from '../transports/index.js';
import { resetRegistryCache, type PrinterRecord } from '../registry.js';
import { httpsFetcher } from './https-fetch.js';

const b64u = (b: Buffer | Uint8Array | string) => Buffer.from(b).toString('base64url');

// ---------------------------------------------------------------------- fake printer

export class FakePrinter {
  connections = 0;
  readonly received: Buffer[] = [];
  private server: NetServer | null = null;
  private sockets = new Set<Socket>();
  port = 0;
  /** Set to hold every connection open without reading: a printer that accepted and went quiet. */
  stall = false;

  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const server = netServer((socket) => {
        this.connections += 1;
        this.sockets.add(socket);
        const chunks: Buffer[] = [];
        if (this.stall) socket.pause();
        socket.on('data', (c: Buffer) => chunks.push(c));
        socket.on('error', () => undefined);
        socket.on('close', () => {
          this.sockets.delete(socket);
          if (chunks.length > 0) this.received.push(Buffer.concat(chunks));
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    return this;
  }

  /** The printer is switched off: connections are refused. */
  async down(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** And on again, on the same port. */
  async up(): Promise<void> {
    if (!this.server) await this.start(this.port);
  }

  /** Wait until every connection has closed, so `received` is complete. */
  async quiet(timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.sockets.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 25));
  }

  /** Occurrences of `marker` across everything the printer received. */
  count(marker: string): number {
    return Buffer.concat(this.received).toString('latin1').split(marker).length - 1;
  }

  async close(): Promise<void> {
    await this.down();
  }
}

// ---------------------------------------------------------------------- tickets and terminals

export interface TicketOptions {
  org_id?: string | number;
  branch_id?: string | number;
  terminal_id?: string | number;
  bridge_id?: string | number;
  bridge_pubkey: string;
  terminal_pubkey: string;
  kid?: string;
  iat?: number;
  exp?: number;
}

export function mintTicket(backendKey: KeyObject, o: TicketOptions): string {
  const nowS = Math.floor(Date.now() / 1000);
  const iat = o.iat ?? nowS - 60;
  // Spelled out in the contract's order, independent of the Bridge's own canonicaliser.
  const json = JSON.stringify({
    v: 1,
    org_id: o.org_id ?? 2,
    branch_id: o.branch_id ?? 8,
    terminal_id: o.terminal_id ?? 'term-1',
    bridge_id: o.bridge_id ?? '77',
    bridge_pubkey: o.bridge_pubkey,
    terminal_pubkey: o.terminal_pubkey,
    kid: o.kid ?? 'test-backend-1',
    iat,
    exp: o.exp ?? iat + 7 * 86_400,
  });
  return `${b64u(json)}.${b64u(cryptoSign(null, Buffer.from(json), backendKey))}`;
}

export interface CallOverrides {
  ticket?: string | null;
  nonce?: string | null;
  signature?: string | null;
  /** Sign this body instead of the one sent. */
  signedBody?: string;
  signedPath?: string;
  signedMethod?: string;
  /** Use this counter instead of the next one. */
  counter?: number;
  /** Send this raw body (string) instead of JSON-encoding `body`. */
  raw?: string;
  headers?: Record<string, string>;
}

export interface Reply {
  status: number;
  json: any;
  headers: Headers;
  text: string;
}

export class TestTerminal {
  readonly keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  readonly spki = b64u(this.keyPair.publicKey.export({ type: 'spki', format: 'der' }));
  ticket = '';
  private nonce: string | null = null;
  private counter = 0;

  /**
   * `fetcher` lets a test reach an https listener with its own trust: the global `fetch` only
   * trusts the system store.
   */
  constructor(private readonly base: () => string, private readonly fetcher: typeof fetch = fetch) {}

  async hello(): Promise<any> {
    const res = await this.fetcher(`${this.base()}/lan/v1/hello`);
    const json = (await res.json()) as any;
    this.nonce = json.nonce;
    this.counter = 0;
    return json;
  }

  signature(method: string, path: string, body: string, nonceHeader: string): string {
    const text = `HANKHA-LAN1\n${method}\n${path}\n${createHash('sha256').update(body, 'utf8').digest('hex')}\n${nonceHeader}`;
    return b64u(cryptoSign('sha256', Buffer.from(text, 'utf8'), { key: this.keyPair.privateKey, dsaEncoding: 'ieee-p1363' }));
  }

  /** A signed call. Fetches a nonce first if it has none, and counts upward after that. */
  async call(method: string, path: string, body?: unknown, o: CallOverrides = {}): Promise<Reply> {
    if (this.nonce === null) await this.hello();
    this.counter += 1;
    const counter = o.counter ?? this.counter;
    const nonceHeader = o.nonce === undefined ? `${this.nonce}.${counter}` : o.nonce;
    const sent = o.raw ?? (body === undefined ? '' : JSON.stringify(body));
    const signed = o.signedBody ?? sent;
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (sent !== '') headers['content-type'] = 'application/json';
    if (o.ticket !== null) headers['x-hankha-ticket'] = o.ticket ?? this.ticket;
    if (nonceHeader !== null) headers['x-hankha-nonce'] = nonceHeader;
    if (o.signature !== null) {
      headers['x-hankha-signature'] =
        o.signature ?? this.signature(o.signedMethod ?? method, o.signedPath ?? path, signed, nonceHeader ?? '');
    }
    const res = await this.fetcher(`${this.base()}${path}`, { method, headers, ...(sent !== '' ? { body: sent } : {}) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, headers: res.headers, text };
  }
}

// ---------------------------------------------------------------------- the harness

export const RECEIPT_PRINTER: PrinterRecord = {
  id: 'receipt', name: 'Receipt', transport: 'network', type: 'receipt', language: 'escpos', enabled: true,
  role: 'receipt', address: '192.168.1.50', port: 9100, dots_per_line: 576,
};
export const KITCHEN_PRINTER: PrinterRecord = {
  id: 'kitchen', name: 'Kitchen', transport: 'network', type: 'receipt', language: 'escpos', enabled: true,
  role: 'kitchen', address: '192.168.1.51', port: 9100, dots_per_line: 384,
};

export function receiptDoc(marker: string): unknown {
  return { kind: 'receipt', elements: [{ type: 'text', value: marker }] };
}

export function jobBody(key: string, marker = `MARK-${key}`, extra: Record<string, unknown> = {}) {
  return {
    dedupe_key: key,
    printer_id: 'receipt',
    job_type: 'RECEIPT',
    document: receiptDoc(marker),
    dots_per_line: 576,
    expires_in_s: 300,
    ...extra,
  };
}

export interface HarnessOptions {
  /**
   * Use the process-wide `queue()` — the one the relay's `handlePrint` submits to — and aim the
   * network transport at the fake printer, instead of a private queue with an injected sender.
   */
  globalQueue?: boolean;
  printers?: PrinterRecord[];
  queue?: QueueOptions;
  /** Hold the sender until this resolves (a printer mid-send). */
  gate?: () => Promise<void> | undefined;
  now?: () => number;
  helloPerMinute?: number;
  /** Failed authentications per remote per minute before a 429 (default: the server's own, 30). */
  failuresPerMinute?: number;
  /** The clock the failure limiter reads. */
  limiterNow?: () => number;
  /** Listen here instead of 127.0.0.1 (a test that needs a second remote address). */
  host?: string;
  /** Serve https with this certificate and key. The harness's `terminal` then trusts `ca`. */
  tls?: { cert: Buffer; key: Buffer; ca: Buffer };
  bridgeId?: string | null;
  dir?: string;
}

export class LanHarness {
  dir!: string;
  printer!: FakePrinter;
  queue!: PrintQueue;
  keys!: LanKeyStore;
  auth!: LanAuth;
  server!: Server;
  port = 0;
  terminal!: TestTerminal;
  readonly backend = generateKeyPairSync('ed25519');
  private bridgeId: string | null = '77';
  private previousStateDir: string | undefined;
  sends = 0;
  private gate: HarnessOptions['gate'];
  private transportMock: { mock: { restore(): void } } | null = null;
  private queueOptions: QueueOptions = {};

  /** Set when the listener serves https: what a client must trust to reach it. */
  ca: Buffer | null = null;

  get base(): string {
    return `${this.ca ? 'https' : 'http'}://127.0.0.1:${this.port}`;
  }

  static async start(opts: HarnessOptions = {}): Promise<LanHarness> {
    const h = new LanHarness();
    await h.init(opts);
    return h;
  }

  /** Write `printers.json` and drop the registry cache so the next lookup reads it. */
  writeRegistry(printers: PrinterRecord[]): void {
    writeFileSync(join(this.dir, 'printers.json'), JSON.stringify({ version: 1, printers }));
    resetRegistryCache();
  }

  /** The queue's sender: the real socket write, aimed at the fake printer. */
  private sender = async (_printer: PrinterRecord, bytes: Buffer, timeoutMs: number): Promise<PrintOutcome> => {
    this.sends += 1;
    await this.gate?.();
    return sendToPrinter('127.0.0.1', this.printer.port, bytes, timeoutMs, 1_000);
  };

  async init(opts: HarnessOptions): Promise<void> {
    this.dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'hankha-lan-'));
    mkdirSync(this.dir, { recursive: true });
    this.previousStateDir = process.env.PRINT_BRIDGE_STATE_DIR;
    process.env.PRINT_BRIDGE_STATE_DIR = this.dir;
    this.gate = opts.gate;
    this.bridgeId = opts.bridgeId === undefined ? '77' : opts.bridgeId;
    this.printer = await new FakePrinter().start();
    this.writeRegistry(opts.printers ?? [RECEIPT_PRINTER, KITCHEN_PRINTER]);

    this.queueOptions = opts.queue ?? {};
    if (opts.globalQueue) {
      this.transportMock = mock.method(networkTransport, 'send', (printer: PrinterRecord, bytes: Buffer, timeoutMs: number) =>
        this.sender(printer, bytes, timeoutMs)
      );
      this.queue = globalQueue();
    } else {
      this.queue = new PrintQueue({ dir: this.dir, send: this.sender, ...this.queueOptions });
      this.queue.load();
    }
    this.keys = new LanKeyStore(this.dir, []);
    this.keys.setKeys([{
      kid: 'test-backend-1',
      pubkey: b64u(this.backend.publicKey.export({ type: 'spki', format: 'der' })),
      not_before: 0,
      not_after: null,
    }]);
    this.auth = new LanAuth({ keys: this.keys, bridgeId: () => this.bridgeId, now: opts.now });
    this.server = createLanServer({
      auth: this.auth,
      queue: () => this.queue,
      installId: () => 'install-test-0001',
      bridgeId: () => this.bridgeId,
      relayConnected: () => false,
      reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
      helloPerMinute: opts.helloPerMinute,
      ...(opts.failuresPerMinute !== undefined ? { failuresPerMinute: opts.failuresPerMinute } : {}),
      ...(opts.limiterNow ? { now: opts.limiterNow } : {}),
      ...(opts.tls ? { tls: { cert: opts.tls.cert, key: opts.tls.key } } : {}),
    });
    this.ca = opts.tls?.ca ?? null;
    await new Promise<void>((resolve) => this.server.listen(0, opts.host ?? '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;

    this.terminal = new TestTerminal(() => this.base, this.ca ? httpsFetcher(this.ca) : fetch);
    this.terminal.ticket = this.ticketFor(this.terminal);
  }

  ticketFor(terminal: TestTerminal, o: Partial<TicketOptions> = {}): string {
    return mintTicket(this.backend.privateKey, {
      bridge_pubkey: this.keys.publicKey(),
      terminal_pubkey: terminal.spki,
      ...o,
    });
  }

  /** Wait until the queue has nothing waiting or in flight. */
  async idle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.pending() > 0) {
      if (Date.now() > deadline) throw new Error(`queue still has ${this.queue.pending()} job(s)`);
      await new Promise((r) => setTimeout(r, 10));
    }
    // The queue has settled; the fake printer sees the connection close a moment later.
    await this.printer.quiet();
  }

  async until(ready: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * The Bridge process restarts: the queue is stopped and a new one reads the same state directory.
   * What survives is exactly what was on disk.
   */
  async restart(extra: QueueOptions = {}): Promise<void> {
    await this.queue.drain(200);
    this.queue = new PrintQueue({ dir: this.dir, send: this.sender, ...this.queueOptions, ...extra });
    this.queue.load();
  }

  async stop(): Promise<void> {
    this.transportMock?.mock.restore();
    await this.queue.drain(200);
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.printer.close();
    if (this.previousStateDir === undefined) delete process.env.PRINT_BRIDGE_STATE_DIR;
    else process.env.PRINT_BRIDGE_STATE_DIR = this.previousStateDir;
    resetRegistryCache();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
