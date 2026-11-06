/*
 * Opt-in printer status readback (M12): after a send, ask the printer whether it is healthy.
 *
 * WHY IT IS OFF BY DEFAULT. RAW/9100 is write-only as far as the bridge has ever been concerned:
 * "bytes_written" means the socket took the bytes, which says nothing about paper, a cover or a
 * jam. ESC/POS has status commands, but a printer that does not know one may print it as text,
 * swallow the next bytes, or close the socket; models differ. So nothing here runs unless the
 * operator sets `status_readback: true` on that printer in the registry, and a printer that
 * misbehaves is cut off again by itself (see `StatusReadback`).
 *
 * WHAT IT CAN AND CANNOT SAY.
 *  - It asks on a SECOND connection after the print connection has closed, while the queue still
 *    holds the printer's lane, so a status query can never land inside a slip.
 *  - It never fails a job because the printer stayed silent, and it never holds the lane longer
 *    than `totalMs`.
 *  - A healthy answer to `GS r 1` (the only query answered in order, after the data) upgrades
 *    `bytes_written` to `confirmed`. That is evidence, not proof: a jam or a half-printed slip
 *    can still read healthy. A paper-out, cover-open or error bit is recorded as an UNKNOWN
 *    failure, never as "nothing printed": printers usually keep the data and print it when the
 *    paper is replaced, so a blind resend would print the slip twice.
 *
 * REAL PRINTERS ARE UNTESTED. Everything here is checked against a fake printer that speaks the
 * documented Epson byte formats. The byte layout comes from Epson's ESC/POS reference and the
 * Helper app's `escpos_status.dart` / `printer_prober.dart`; no physical printer has been asked.
 *
 * Byte formats (Epson ESC/POS):
 *   DLE EOT n   10 04 n   real-time status, n = 1 printer, 2 offline cause, 3 error cause, 4 paper
 *                         roll sensor. Reply is 1 byte whose bits 0, 1, 4 and 7 are fixed:
 *                         `(b & 0x93) == 0x12`.
 *   GS r 1      1d 72 01  paper sensor status, queued behind the print data. Reply is 1 byte whose
 *                         bits 0, 1, 4 and 7 are fixed off: `(b & 0x93) == 0x00`.
 */
import { Socket } from 'node:net';
import { DEFAULT_PRINTER_PORT } from './lan.js';
import { log } from './log.js';
import type { PrinterRecord } from './registry.js';

export const DLE_EOT = (n: 1 | 2 | 3 | 4): Buffer => Buffer.from([0x10, 0x04, n]);
export const GS_R_1: Buffer = Buffer.from([0x1d, 0x72, 0x01]);

/** Why a reading carries no verdict. */
export type ReadbackNote = 'no_response' | 'garbage' | 'socket_closed' | 'connect_failed';

export type ReadbackFault = 'paper_out' | 'cover_open' | 'error';

export interface StatusReading {
  /** At least one reply decoded as a status byte. */
  answered: boolean;
  dle_eot: boolean;
  gs_r: boolean;
  online: boolean;
  cover_open: boolean;
  paper_end: boolean;
  paper_near_end: boolean;
  error: boolean;
  note?: ReadbackNote;
  /** How long the whole read took, connect included. */
  took_ms: number;
}

/** What the queue keeps on a settled job. Small on purpose: it is written to the dedupe ring. */
export interface ReadbackSummary {
  answered: boolean;
  fault?: ReadbackFault;
  paper_near_end?: true;
  offline?: true;
  note?: ReadbackNote;
}

export interface StatusReadOptions {
  /** Wait for each `DLE EOT` reply (real-time: printers answer these at once, even mid-print). */
  dleReplyMs?: number;
  /** Wait for the `GS r 1` reply (in order, so it follows the data still being printed). */
  gsrReplyMs?: number;
  /** The most the whole read may take, connect included. The lane is held for this long, no more. */
  totalMs?: number;
  /** Where to dial. Defaults to the registry address; tests aim it at a fake printer. */
  target?: (printer: PrinterRecord) => { host: string; port: number } | null;
}

export const DEFAULT_DLE_REPLY_MS = 500;
export const DEFAULT_GSR_REPLY_MS = 2_000;
export const DEFAULT_TOTAL_MS = 3_000;
/** How long a connect may take inside `totalMs`: a printer that just took a slip accepts at once. */
const CONNECT_MS = 1_000;

const isRealtimeByte = (b: number): boolean => (b & 0x93) === 0x12;
const isGsrByte = (b: number): boolean => (b & 0x93) === 0x00;

/**
 * Whether a printer may be asked at all: an ESC/POS receipt printer reached over TCP, the only
 * place a second connection and a status byte mean what they do here.
 */
export function supportsReadback(printer: PrinterRecord): boolean {
  return printer.transport === 'network' && printer.type === 'receipt' && printer.language === 'escpos';
}

function defaultTarget(printer: PrinterRecord): { host: string; port: number } | null {
  return printer.address ? { host: printer.address, port: printer.port ?? DEFAULT_PRINTER_PORT } : null;
}

const blank = (took: number): StatusReading => ({
  answered: false, dle_eot: false, gs_r: false,
  online: true, cover_open: false, paper_end: false, paper_near_end: false, error: false,
  took_ms: took,
});

/**
 * Ask a printer for its status. Never throws, never outlasts `totalMs`.
 *
 * One connection, queries one at a time so each reply is attributable to its question. The first
 * `DLE EOT` going unanswered means the model has no real-time status, so `2` and `4` are skipped
 * (they would each cost a timeout) and only `GS r 1` is tried.
 */
export function readPrinterStatus(printer: PrinterRecord, options: StatusReadOptions = {}): Promise<StatusReading> {
  const dleMs = options.dleReplyMs ?? DEFAULT_DLE_REPLY_MS;
  const gsrMs = options.gsrReplyMs ?? DEFAULT_GSR_REPLY_MS;
  const totalMs = options.totalMs ?? DEFAULT_TOTAL_MS;
  const target = (options.target ?? defaultTarget)(printer);
  const started = Date.now();
  const reading = blank(0);

  return new Promise<StatusReading>((resolve) => {
    if (!target) {
      resolve({ ...reading, note: 'connect_failed', took_ms: 0 });
      return;
    }
    const socket = new Socket();
    let done = false;
    let closed = false;
    let sawGarbage = false;
    const queue: number[] = [];
    let wake: (() => void) | null = null;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      socket.destroy();
      reading.took_ms = Date.now() - started;
      if (!reading.answered && reading.note === undefined) {
        reading.note = sawGarbage ? 'garbage' : closed ? 'socket_closed' : 'no_response';
      } else if (reading.answered && sawGarbage) {
        // Some replies decoded, some did not: keep the verdict from the good ones, say so.
        reading.note = 'garbage';
      }
      resolve(reading);
    };
    // The one hard limit. Everything below can only make the read shorter.
    const hard = setTimeout(finish, totalMs);
    hard.unref();

    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      for (const b of chunk) queue.push(b);
      wake?.();
    });
    socket.on('error', () => {
      closed = true;
      wake?.();
    });
    socket.on('close', () => {
      closed = true;
      wake?.();
    });

    /** Write a query and wait for one byte, a close, or the timeout. null = no usable answer. */
    const ask = (command: Buffer, timeoutMs: number): Promise<number | null> =>
      new Promise((res) => {
        if (done || closed) return res(null);
        queue.length = 0;
        const timer = setTimeout(() => settle(null), timeoutMs);
        const settle = (value: number | null): void => {
          clearTimeout(timer);
          wake = null;
          res(value);
        };
        wake = () => {
          if (queue.length > 0) settle(queue.shift() as number);
          else if (closed) settle(null);
        };
        socket.write(command, (err) => {
          if (err) {
            closed = true;
            settle(null);
          }
        });
      });

    const run = async (): Promise<void> => {
      const absorb = (value: number | null, valid: (b: number) => boolean, apply: (b: number) => void): boolean => {
        if (value === null) return false;
        if (!valid(value)) {
          sawGarbage = true;
          return false;
        }
        reading.answered = true;
        apply(value);
        return true;
      };

      const s1 = await ask(DLE_EOT(1), dleMs);
      if (absorb(s1, isRealtimeByte, (b) => { reading.dle_eot = true; if (b & 0x08) reading.online = false; })) {
        absorb(await ask(DLE_EOT(2), dleMs), isRealtimeByte, (b) => {
          if (b & 0x04) reading.cover_open = true;
          if (b & 0x20) reading.paper_end = true;
          if (b & 0x40) reading.error = true;
        });
        absorb(await ask(DLE_EOT(4), dleMs), isRealtimeByte, (b) => {
          if (b & 0x0c) reading.paper_near_end = true;
          if (b & 0x60) reading.paper_end = true;
        });
      }
      if (!closed) {
        absorb(await ask(GS_R_1, gsrMs), isGsrByte, (b) => {
          reading.gs_r = true;
          if (b & 0x0c) reading.paper_near_end = true;
          if (b & 0x60) reading.paper_end = true;
        });
      }
      finish();
    };

    socket.setTimeout(CONNECT_MS, () => {
      // Only reached before the connection is up: the timeout is cleared on connect.
      reading.note = 'connect_failed';
      finish();
    });
    let connected = false;
    socket.once('connect', () => {
      connected = true;
      socket.setTimeout(0);
      void run().catch(() => finish());
    });
    socket.once('error', () => {
      if (connected) return;
      reading.note = 'connect_failed';
      finish();
    });
    socket.connect(target.port, target.host);
  });
}

// ---------------------------------------------------------------------- the verdict

export interface ReadbackVerdict {
  /** A fault that means paper may be missing or the data may be waiting: record it, never resend. */
  fault?: ReadbackFault;
  /** A healthy answer to `GS r 1` with nothing wrong anywhere: `bytes_written` becomes `confirmed`. */
  confirmed: boolean;
  summary: ReadbackSummary;
}

/**
 * Turn a reading into what the queue does with it.
 *
 * `offline` alone is only noted: printers report offline for harmless reasons while they print, so
 * treating it as a failure would turn healthy slips into "unknown". Cover, paper-end and error
 * bits are the faults.
 */
export function judge(reading: StatusReading): ReadbackVerdict {
  const fault: ReadbackFault | undefined = reading.paper_end
    ? 'paper_out'
    : reading.cover_open
      ? 'cover_open'
      : reading.error
        ? 'error'
        : undefined;
  const summary: ReadbackSummary = {
    answered: reading.answered,
    ...(fault ? { fault } : {}),
    ...(reading.paper_near_end ? { paper_near_end: true as const } : {}),
    ...(reading.answered && !reading.online ? { offline: true as const } : {}),
    ...(reading.note ? { note: reading.note } : {}),
  };
  const confirmed = !fault && reading.gs_r && reading.online && reading.note !== 'garbage';
  return { ...(fault ? { fault } : {}), confirmed, summary };
}

export const FAULT_TEXT: Record<ReadbackFault, string> = {
  paper_out: 'the printer reports paper out',
  cover_open: 'the printer reports its cover is open',
  error: 'the printer reports an error condition',
};

// ---------------------------------------------------------------------- the per-printer breaker

/** Consecutive useless reads (silent, garbage, closed on the status byte) before a printer is cut off. */
export const SUSPEND_AFTER = 3;

export type ReadbackState = 'off' | 'on' | 'suspended';

/**
 * Decides whether a printer is asked, and cuts a misbehaving one off.
 *
 * Three layers of "off", from the operator's to the automatic:
 *   1. the registry flag (`status_readback`), read live at every job, so unticking it takes effect
 *      for jobs already waiting in the lane;
 *   2. `PRINT_BRIDGE_STATUS_READBACK=off` in the environment, for the whole bridge;
 *   3. this breaker: after `SUSPEND_AFTER` reads in a row that gave nothing usable the printer is
 *      suspended until the registry is saved again or the bridge restarts. A silent printer costs
 *      the lane a timeout per slip, and one that closes the socket or answers garbage is exactly
 *      the model the opt-in warns about.
 */
export class StatusReadback {
  private readonly useless = new Map<string, number>();
  private readonly suspended = new Set<string>();

  constructor(
    private readonly read: (printer: PrinterRecord) => Promise<StatusReading>,
    private readonly live: (id: string) => PrinterRecord | null,
    private readonly envOff: () => boolean = () => process.env.PRINT_BRIDGE_STATUS_READBACK?.trim().toLowerCase() === 'off'
  ) {}

  /** The registry flag, as it is now (not as it was when the job was queued). */
  private enabledFor(printer: PrinterRecord): boolean {
    if (this.envOff()) return false;
    const live = this.live(printer.id) ?? printer;
    return live.status_readback === true && live.enabled && supportsReadback(live);
  }

  stateOf(printer: PrinterRecord): ReadbackState {
    if (!this.enabledFor(printer)) return 'off';
    return this.suspended.has(printer.id) ? 'suspended' : 'on';
  }

  /** Forget every suspension: the operator saved the registry, which is how they say "try again". */
  clear(): void {
    this.useless.clear();
    this.suspended.clear();
  }

  /** Null when this printer is not asked (off, or suspended). Never throws. */
  async check(printer: PrinterRecord): Promise<ReadbackVerdict | null> {
    if (this.stateOf(printer) !== 'on') return null;
    let reading: StatusReading;
    try {
      reading = await this.read(printer);
    } catch (err) {
      log.warn(`status readback on ${printer.id} threw — ignored`, { event: 'status.readback.error', printer_id: printer.id, err });
      return null;
    }
    // A connect failure right after a good send says nothing about the model; do not count it.
    if (reading.note === 'connect_failed') return { confirmed: false, summary: { answered: false, note: 'connect_failed' } };

    const usable = reading.answered && reading.note !== 'garbage';
    if (usable) {
      this.useless.delete(printer.id);
    } else {
      const strikes = (this.useless.get(printer.id) ?? 0) + 1;
      this.useless.set(printer.id, strikes);
      if (strikes >= SUSPEND_AFTER) {
        this.suspended.add(printer.id);
        log.warn(
          `status readback on ${printer.id} suspended after ${strikes} unusable reads (${reading.note ?? 'no answer'}) — ` +
            'turn status_readback off for this printer, or save the printer list to try again',
          { event: 'status.readback.suspended', printer_id: printer.id, note: reading.note, strikes }
        );
      }
    }
    return judge(reading);
  }
}
