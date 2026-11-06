/*
 * A fake network printer that speaks the documented ESC/POS status protocol, for the status
 * readback tests. It is a model of the Epson byte formats, NOT a real printer: whether any real
 * model answers like this is exactly what these tests cannot say.
 *
 * Print data and status queries are told apart by what a connection starts with: `10 04 n`
 * (DLE EOT) and `1d 72 01` (GS r 1) are queries, anything else is a slip.
 */
import { createServer, type Server, type Socket } from 'node:net';

export type StatusMode =
  | 'healthy'
  | 'near_end'
  | 'paper_out'
  | 'cover_open'
  | 'error'
  | 'offline'
  /** Takes the data, never answers a status byte. */
  | 'silent'
  /** Answers bytes that are not status bytes at all. */
  | 'garbage'
  /** Hangs up the moment it sees a status byte. */
  | 'close_on_status'
  /** Real-time status only; `GS r 1` is ignored. */
  | 'dle_only'
  /** `GS r 1` only; the `DLE EOT` queries are ignored. */
  | 'gsr_only';

export class EscposFakePrinter {
  mode: StatusMode = 'healthy';
  printConnections = 0;
  statusConnections = 0;
  /** Every status command seen, in order, as hex: `10 04 01`. */
  readonly queries: string[] = [];
  readonly printed: Buffer[] = [];
  /** Hold the `GS r 1` reply this long (the printer is still printing the slip). */
  gsrDelayMs = 0;
  port = 0;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    return this;
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    let kind: 'print' | 'status' | null = null;
    const data: Buffer[] = [];
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (kind === 'print' && data.length > 0) this.printed.push(Buffer.concat(data));
    });
    socket.on('data', (chunk: Buffer) => {
      if (kind === null) {
        kind = isQuery(chunk) ? 'status' : 'print';
        if (kind === 'print') this.printConnections += 1;
        else this.statusConnections += 1;
      }
      if (kind === 'print') {
        data.push(chunk);
        return;
      }
      for (let i = 0; i + 2 < chunk.length + 0 && i < chunk.length; ) {
        if (chunk[i] === 0x10 && chunk[i + 1] === 0x04) {
          this.query(socket, chunk.subarray(i, i + 3));
          i += 3;
        } else if (chunk[i] === 0x1d && chunk[i + 1] === 0x72) {
          this.query(socket, chunk.subarray(i, i + 3));
          i += 3;
        } else {
          i += 1;
        }
      }
    });
  }

  private query(socket: Socket, command: Buffer): void {
    this.queries.push([...command].map((b) => b.toString(16).padStart(2, '0')).join(' '));
    const mode = this.mode;
    if (mode === 'close_on_status') {
      socket.destroy();
      return;
    }
    if (mode === 'silent') return;
    if (mode === 'garbage') {
      socket.write(Buffer.from([0xff]));
      return;
    }
    const realtime = command[0] === 0x10;
    if (realtime && mode === 'gsr_only') return;
    if (!realtime && mode === 'dle_only') return;
    const reply = realtime ? this.dleReply(command[2] as number) : this.gsrReply();
    if (realtime || this.gsrDelayMs === 0) socket.write(Buffer.from([reply]));
    else setTimeout(() => socket.writable && socket.write(Buffer.from([reply])), this.gsrDelayMs);
  }

  /** `DLE EOT n`: bits 0, 1, 4 and 7 are fixed, so a quiet printer reads 0x12. */
  private dleReply(n: number): number {
    const base = 0x12;
    switch (n) {
      case 1:
        return this.mode === 'offline' ? base | 0x08 : base;
      case 2:
        return base | (this.mode === 'cover_open' ? 0x04 : 0) | (this.mode === 'paper_out' ? 0x20 : 0) | (this.mode === 'error' ? 0x40 : 0);
      case 4:
        return base | (this.mode === 'near_end' ? 0x0c : 0) | (this.mode === 'paper_out' ? 0x60 : 0);
      default:
        return base;
    }
  }

  /** `GS r 1`: bits 0, 1, 4 and 7 are fixed off. */
  private gsrReply(): number {
    return (this.mode === 'near_end' ? 0x0c : 0) | (this.mode === 'paper_out' ? 0x60 : 0);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Let the connections close so `printed` is complete. */
  async quiet(): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (this.sockets.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
  }

  count(marker: string): number {
    return Buffer.concat(this.printed).toString('latin1').split(marker).length - 1;
  }
}

function isQuery(chunk: Buffer): boolean {
  return chunk.length >= 3 && ((chunk[0] === 0x10 && chunk[1] === 0x04) || (chunk[0] === 0x1d && chunk[1] === 0x72 && chunk[2] === 0x01));
}
