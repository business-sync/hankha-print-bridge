/*
 * One interface, several drivers.
 *
 * Everything above this line — the queue, the HTTP routes, the cloud relay — deals in "send these
 * bytes to this printer" and must not know whether that means a TCP socket, a CUPS queue or a
 * character device. The POS terminal reached the same shape from the other side
 * (`features/printer/transports/transport.ts`); this is its server-side counterpart, with two
 * deliberate differences:
 *
 *  - `send` RESOLVES with a `PrintOutcome` rather than throwing. A thrown error cannot carry
 *    `printed_certainty`, and that single field is what decides whether a retry is allowed to
 *    happen. Collapsing "never reached the printer" into the same shape as "may have printed half
 *    a receipt" is how a customer ends up holding two bills.
 *  - There is no connect/disconnect pair. A browser holds a WebUSB handle across a session; here
 *    every driver is connectionless per job, so there is no state to leak when the process is
 *    killed mid-print by a service manager.
 */
import type { PrintFailureReason, PrintOutcome, PrintedCertainty } from '../lan.js';
import type { PrinterRecord, TransportKind } from '../registry.js';

export type { PrintOutcome, PrintedCertainty, PrintFailureReason };

export interface ProbeResult {
  reachable: boolean;
  latency_ms: number | null;
  /** Why not, in words an operator can act on. */
  detail?: string;
}

/** A printer this host can see but that is not (yet) in the registry. */
export interface DiscoveredPrinter {
  transport: TransportKind;
  /** What to show in a picker. */
  label: string;
  address?: string;
  port?: number;
  queue?: string;
  device?: string;
  detail?: string;
}

export interface Transport {
  readonly kind: TransportKind;

  /**
   * Can this driver work on this host at all? Synchronous, so `/status` can answer without
   * probing every printer. False in a container for anything that needs local hardware, which is
   * how the k8s deployment keeps reporting honestly instead of erroring.
   */
  isAvailable(): boolean;

  probe(printer: PrinterRecord, timeoutMs: number): Promise<ProbeResult>;

  send(printer: PrinterRecord, bytes: Buffer, timeoutMs: number): Promise<PrintOutcome>;

  /** Printers this host can see. Absent where enumeration is impossible. */
  discover?(timeoutMs: number): Promise<DiscoveredPrinter[]>;

  /**
   * Write a query and read the answer back.
   *
   * Optional, and absent on the spooler driver for a reason rather than as an omission: a print
   * queue is one-way by construction, so there is no channel to read a reply on. Implementing it
   * as a stub that always returns null would make "this printer did not answer" and "this
   * transport cannot ask" indistinguishable.
   */
  query?(printer: PrinterRecord, probe: Buffer, timeoutMs: number): Promise<Buffer | null>;
}

/** Build a failure outcome without repeating the bookkeeping in six places. */
export function failed(
  reason: PrintFailureReason,
  printed_certainty: PrintedCertainty,
  detail: string,
  startedAt: number
): PrintOutcome {
  return { ok: false, reason, printed_certainty, detail, duration_ms: Date.now() - startedAt };
}

export function succeeded(startedAt: number): PrintOutcome {
  return { ok: true, duration_ms: Date.now() - startedAt };
}
