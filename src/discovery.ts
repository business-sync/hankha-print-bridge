/*
 * "What printers can this machine see?" — asked once, answered by every driver at once.
 *
 * Three enumerations with wildly different costs: the spooler and the serial listing are a few
 * milliseconds, while a subnet sweep is about two seconds. Running them in parallel means the
 * whole answer costs what the slowest one costs, and an operator pressing "Find printers" is
 * waiting on the network either way.
 *
 * `transports` is reported alongside the results because an empty list has two very different
 * meanings — "there are no USB printers" and "this machine cannot see USB printers at all", and a
 * settings screen that cannot tell them apart sends the operator hunting for a cable that is
 * already plugged in.
 */
import { DEFAULT_PRINTER_PORT, hostsForInterfaces, localInterfaces } from './lan.js';
import { TRANSPORT_KINDS, type TransportKind } from './registry.js';
import { driverFor, type DiscoveredPrinter } from './transports/index.js';

const SPOOLER_TIMEOUT_MS = 5000;
const SERIAL_TIMEOUT_MS = 3000;

export interface TransportAvailability {
  kind: TransportKind;
  available: boolean;
  reason?: string;
}

export interface DiscoveryResult {
  ok: true;
  duration_ms: number;
  /** The /24s the network sweep covered, so a UI can say where it looked. */
  subnets: string[];
  transports: TransportAvailability[];
  printers: DiscoveredPrinter[];
}

export function transportAvailability(): TransportAvailability[] {
  return TRANSPORT_KINDS.map((kind) => {
    const available = driverFor(kind).isAvailable();
    return {
      kind,
      available,
      reason: available
        ? undefined
        : kind === 'usb'
          ? 'no OS print spooler on this machine (expected inside a container)'
          : 'unavailable on this machine',
    };
  });
}

export async function discoverAll(options: { network?: boolean; port?: number } = {}): Promise<DiscoveryResult> {
  const started = performance.now();
  const includeNetwork = options.network !== false;
  const port = options.port ?? DEFAULT_PRINTER_PORT;

  const jobs: Promise<DiscoveredPrinter[]>[] = [
    driverFor('usb').discover?.(SPOOLER_TIMEOUT_MS) ?? Promise.resolve([]),
    driverFor('serial').discover?.(SERIAL_TIMEOUT_MS) ?? Promise.resolve([]),
  ];
  if (includeNetwork) {
    jobs.push(
      // The network driver's own discover() always sweeps port 9100; go through it directly when a
      // caller asked for a different one, rather than adding a parameter no other driver has.
      port === DEFAULT_PRINTER_PORT
        ? (driverFor('network').discover?.(0) ?? Promise.resolve([]))
        : scanPort(port)
    );
  }

  // One driver throwing must not lose the other two: a machine with an unreadable /dev should
  // still return its network printers.
  const settled = await Promise.allSettled(jobs);
  const printers = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));

  return {
    ok: true,
    duration_ms: Math.round(performance.now() - started),
    subnets: includeNetwork ? hostsForInterfaces(localInterfaces()).subnets : [],
    transports: transportAvailability(),
    printers,
  };
}

async function scanPort(port: number): Promise<DiscoveredPrinter[]> {
  const { runScan } = await import('./lan.js');
  const scan = await runScan(port);
  return scan.printers.map((found) => ({
    transport: 'network' as const,
    label: `${found.ip}:${found.port}`,
    address: found.ip,
    port: found.port,
    detail: found.latency_ms === null ? undefined : `${found.latency_ms} ms`,
  }));
}
