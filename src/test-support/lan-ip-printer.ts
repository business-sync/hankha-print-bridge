/*
 * A fake raw-9100 printer for process-level tests: listens on a chosen address (the machine's
 * private LAN address, because the Bridge dials RFC 1918 space only), records what it receives,
 * and can be switched off, made to stall (accept and read nothing), and released.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';

export function privateLanIp(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return undefined;
}

export class LanIpPrinter {
  port = 0;
  connections = 0;
  open = 0;
  maxOpen = 0;
  /** Every print connection's bytes, in the order the connections closed. */
  readonly received: Buffer[] = [];
  /** Accept connections but read nothing until `release()`. */
  stall = false;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly paused = new Set<Socket>();

  constructor(private readonly host: string) {}

  async start(port = this.port): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        this.connections += 1;
        this.open += 1;
        this.maxOpen = Math.max(this.maxOpen, this.open);
        this.sockets.add(socket);
        const chunks: Buffer[] = [];
        if (this.stall) {
          socket.pause();
          this.paused.add(socket);
        }
        socket.on('data', (c: Buffer) => chunks.push(c));
        socket.on('error', () => undefined);
        socket.on('close', () => {
          this.open -= 1;
          this.sockets.delete(socket);
          this.paused.delete(socket);
          if (chunks.length > 0) this.received.push(Buffer.concat(chunks));
        });
      });
      server.once('error', reject);
      server.listen(port, this.host, () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    return this;
  }

  /** Switch off: connections are refused. */
  async down(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  get isUp(): boolean {
    return this.server !== null;
  }

  release(): void {
    this.stall = false;
    for (const s of this.paused) s.resume();
    this.paused.clear();
  }

  /** Occurrences of `marker` across everything received (call after the connections have closed). */
  count(marker: string): number {
    return Buffer.concat(this.received).toString('latin1').split(marker).length - 1;
  }

  /** Positions of markers in arrival order, for FIFO checks. */
  order(markers: string[]): string[] {
    const text = this.received.map((b) => b.toString('latin1'));
    return markers
      .map((m) => ({ m, at: text.findIndex((t) => t.includes(m)) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((x) => x.m);
  }

  async quiet(ms = 400): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (this.sockets.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, ms));
  }
}
