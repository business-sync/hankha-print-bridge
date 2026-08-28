/*
 * `/status`: is each configured printer actually reachable right now?
 *
 * Probing is not free — a dead network printer costs a full connect timeout — so results are
 * cached briefly and every printer is probed in parallel. Without the cache a settings screen
 * polling every two seconds would keep a permanent connect storm running against the venue's
 * network, which is exactly the traffic that makes an operator's Wi-Fi look broken.
 */
import { loadRegistry, type PrinterRecord } from './registry.js';
import { driverFor } from './transports/index.js';

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 5000;

export interface PrinterStatus {
  id: string;
  name: string;
  transport: string;
  type: string;
  language: string;
  enabled: boolean;
  online: boolean;
  latency_ms: number | null;
  detail?: string;
  checked_at: string;
}

interface CacheEntry {
  at: number;
  value: PrinterStatus;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PrinterStatus>>();

async function probeOne(printer: PrinterRecord): Promise<PrinterStatus> {
  const base = {
    id: printer.id, name: printer.name, transport: printer.transport,
    type: printer.type, language: printer.language, enabled: printer.enabled,
    checked_at: new Date().toISOString(),
  };

  if (!printer.enabled) {
    return { ...base, online: false, latency_ms: null, detail: 'disabled in printers.json' };
  }
  const driver = driverFor(printer.transport);
  if (!driver.isAvailable()) {
    return { ...base, online: false, latency_ms: null, detail: `the ${printer.transport} transport is not available on this machine` };
  }
  try {
    const result = await driver.probe(printer, PROBE_TIMEOUT_MS);
    return { ...base, online: result.reachable, latency_ms: result.latency_ms, detail: result.detail };
  } catch (err) {
    return { ...base, online: false, latency_ms: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Cached, and de-duplicated: two concurrent `/status` calls share one probe per printer. */
export async function printerStatuses(force = false): Promise<PrinterStatus[]> {
  const registry = loadRegistry();
  const now = Date.now();

  return Promise.all(
    registry.printers.map(async (printer) => {
      const cached = cache.get(printer.id);
      if (!force && cached && now - cached.at < CACHE_TTL_MS) return cached.value;

      const existing = inFlight.get(printer.id);
      if (existing) return existing;

      const probe = probeOne(printer)
        .then((value) => {
          cache.set(printer.id, { at: Date.now(), value });
          return value;
        })
        .finally(() => inFlight.delete(printer.id));

      inFlight.set(printer.id, probe);
      return probe;
    })
  );
}
