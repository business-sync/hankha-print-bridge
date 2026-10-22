import { log, LogGate } from './log.js';
import { queue } from './queue.js';
import { loadRegistry, type PrinterRecord } from './registry.js';
import { markTick } from './ticks.js';
import { networkTransport, type ProbeResult } from './transports/index.js';

/**
 * Keep the venue's network printers awake.
 *
 * A thermal printer left idle for a few minutes — on Wi-Fi, or with its own sleep setting — can
 * take several seconds to answer its first connection again. One venue lost kitchen and pizza
 * tickets to exactly that all evening, while the bill printer, used every few minutes, never
 * missed: the next ticket to the same printer 30 s later always printed in a millisecond.
 * Connecting to each printer every minute keeps it, and this machine's ARP entry for it, warm,
 * so a ticket never has to wake it.
 *
 * The probe is a bare connect and close (`tcpPing`): nothing is written, so it cannot print, and
 * a printer whose lane is busy is skipped, so a probe never competes with a real job for a
 * printer that takes one connection at a time. It doubles as the earliest warning a venue gets
 * that a printer has dropped off the network — before a ticket is lost to it.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
/** Long enough to see Windows' first SYN retransmit (3 s), which is when a sleeping printer answers. */
const PROBE_TIMEOUT_MS = 3_500;
/** An answer slower than this was a printer waking up rather than one that was awake. */
const SLOW_MS = 1_000;

/** `PRINT_BRIDGE_KEEPWARM_MS`: default 60000, `0` turns it off, anything else at least 5000. */
export function keepWarmMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRINT_BRIDGE_KEEPWARM_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_MS;
  return n === 0 ? 0 : Math.max(MIN_INTERVAL_MS, Math.round(n));
}

export interface KeepWarmResult {
  printer_id: string;
  /** Null when the probe was skipped because the printer's lane was busy. */
  reachable: boolean | null;
  latency_ms: number | null;
}

export interface KeepWarm {
  /** Probe every network printer once now (what the timer does). Returns what it saw, for tests. */
  pass(): Promise<KeepWarmResult[]>;
  stop(): void;
}

export interface KeepWarmOptions {
  intervalMs?: number;
  probe?: (printer: PrinterRecord, timeoutMs: number) => Promise<ProbeResult>;
  printers?: () => PrinterRecord[];
  isBusy?: (printerId: string) => boolean;
}

function isWarmable(printer: PrinterRecord): boolean {
  return printer.enabled && printer.transport === 'network' && Boolean(printer.address);
}

export function startKeepWarm(opts: KeepWarmOptions = {}): KeepWarm {
  const intervalMs = opts.intervalMs ?? keepWarmMs();
  const probe = opts.probe ?? ((printer, timeoutMs) => networkTransport.probe(printer, timeoutMs));
  const printers = opts.printers ?? (() => loadRegistry().printers);
  const isBusy = opts.isBusy ?? ((id: string) => queue().isBusy(id));
  const gate = new LogGate(10 * 60_000);
  /** Printers last seen unreachable, and since when — the transition is what gets logged. */
  const down = new Map<string, number>();
  let inFlight: Promise<KeepWarmResult[]> | null = null;

  const probeOne = async (printer: PrinterRecord): Promise<KeepWarmResult> => {
    if (isBusy(printer.id)) return { printer_id: printer.id, reachable: null, latency_ms: null };
    const result = await probe(printer, PROBE_TIMEOUT_MS);
    const where = `${printer.address}:${printer.port ?? ''}`;

    if (!result.reachable) {
      if (!down.has(printer.id)) {
        down.set(printer.id, Date.now());
        log.warn(`printer: ${printer.id} at ${where} is not answering (${result.detail ?? 'no answer'}) — tickets to it will fail until it is back`, {
          event: 'printer.unreachable', printer_id: printer.id, address: where, detail: result.detail,
        });
      }
    } else {
      const since = down.get(printer.id);
      if (since !== undefined) {
        down.delete(printer.id);
        log.info(`printer: ${printer.id} at ${where} is answering again after ${Math.round((Date.now() - since) / 1000)}s`, {
          event: 'printer.reachable', printer_id: printer.id, address: where, down_ms: Date.now() - since,
          latency_ms: result.latency_ms,
        });
      } else if ((result.latency_ms ?? 0) >= SLOW_MS) {
        const pass = gate.hit(`printer.slow:${printer.id}`);
        if (pass) {
          log.info(`printer: ${printer.id} at ${where} took ${result.latency_ms}ms to answer — it was probably asleep`, {
            event: 'printer.slow', printer_id: printer.id, address: where, latency_ms: result.latency_ms,
            repeated: pass.repeated || undefined,
          });
        }
      }
    }
    return { printer_id: printer.id, reachable: result.reachable, latency_ms: result.latency_ms };
  };

  const pass = (): Promise<KeepWarmResult[]> => {
    // A pass is at most one probe timeout long, but never stack two on a slow machine.
    if (inFlight) return inFlight;
    const targets = printers().filter(isWarmable);
    // Forget printers that were removed or disabled, so re-adding one starts clean.
    for (const id of down.keys()) if (!targets.some((p) => p.id === id)) down.delete(id);
    inFlight = Promise.all(targets.map(probeOne))
      .then((results) => {
        if (results.length > 0) {
          log.debug(`printer: keep-warm probed ${results.length} printer(s)`, {
            event: 'printer.keepwarm', printers: results.length,
            skipped: results.filter((r) => r.reachable === null).length || undefined,
            unreachable: results.filter((r) => r.reachable === false).length || undefined,
            max_latency_ms: Math.max(0, ...results.map((r) => r.latency_ms ?? 0)),
          });
        }
        return results;
      })
      .catch((err: unknown) => {
        log.warn('printer: keep-warm pass failed', { event: 'printer.keepwarm_failed', err });
        return [];
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  let timer: NodeJS.Timeout | undefined;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      markTick('printer.keepwarm', intervalMs);
      void pass();
    }, intervalMs);
    timer.unref();
  }

  return {
    pass,
    stop: () => clearInterval(timer),
  };
}
