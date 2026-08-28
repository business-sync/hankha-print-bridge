/*
 * RAW/JetDirect over TCP — the transport the bridge was originally built for, now behind the
 * common interface.
 *
 * All of the socket work stays in `lan.ts`. This file is a thin adapter on purpose: `sendToPrinter`
 * is the most-tested code in the project (`relay.test.ts` pins its `printed_certainty`
 * classification case by case), and reimplementing it here to fit a new shape would have quietly
 * forked the one function whose failure modes actually cost money.
 */
import { DEFAULT_PRINTER_PORT, sendToPrinter, tcpPing } from '../lan.js';
import type { PrinterRecord } from '../registry.js';
import { failed, type DiscoveredPrinter, type ProbeResult, type Transport } from './transport.js';
import { runScan } from '../lan.js';
import { Socket } from 'node:net';

/**
 * Write a query and collect whatever comes back before the deadline.
 *
 * There is no framing on RAW/9100 and no way to know a reply is complete, so this always waits the
 * full timeout and returns what arrived. Callers use short timeouts for that reason.
 */
function askOverTcp(ip: string, port: number, probe: Buffer, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const deadline = setTimeout(() => finish(chunks.length > 0 ? Buffer.concat(chunks) : null), timeoutMs);
    deadline.unref();

    socket.once('error', () => {
      clearTimeout(deadline);
      finish(null);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.connect(port, ip, () => socket.write(probe));
  });
}

function targetOf(printer: PrinterRecord): { ip: string; port: number } | null {
  if (!printer.address) return null;
  return { ip: printer.address, port: printer.port ?? DEFAULT_PRINTER_PORT };
}

export const networkTransport: Transport = {
  kind: 'network',

  // Always. A TCP socket needs nothing from the host beyond a route, and a container still has
  // one — this is the only driver that works unchanged inside the k8s deployment.
  isAvailable: () => true,

  async probe(printer, timeoutMs): Promise<ProbeResult> {
    const target = targetOf(printer);
    if (!target) return { reachable: false, latency_ms: null, detail: 'no address configured' };
    const result = await tcpPing(target.ip, target.port, timeoutMs);
    return { reachable: result.reachable, latency_ms: result.latency_ms, detail: result.reason };
  },

  async send(printer, bytes, timeoutMs) {
    const startedAt = Date.now();
    const target = targetOf(printer);
    if (!target) return failed('device-missing', 'none', 'no address configured', startedAt);
    return sendToPrinter(target.ip, target.port, bytes, timeoutMs);
  },

  async query(printer, probe, timeoutMs): Promise<Buffer | null> {
    const target = targetOf(printer);
    if (!target) return null;
    return askOverTcp(target.ip, target.port, probe, timeoutMs);
  },

  async discover(): Promise<DiscoveredPrinter[]> {
    const scan = await runScan(DEFAULT_PRINTER_PORT);
    return scan.printers.map((found) => ({
      transport: 'network' as const,
      label: `${found.ip}:${found.port}`,
      address: found.ip,
      port: found.port,
      detail: found.latency_ms === null ? undefined : `${found.latency_ms} ms`,
    }));
  },
};
