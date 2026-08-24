import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';

/** One of this machine's own IPv4 addresses, with the mask it was assigned. */
export interface LocalInterface {
  address: string;
  /** e.g. `192.168.18.116/24` — the POS uses this to spot printers on a different network. */
  cidr: string;
}

/**
 * Why a TCP connect failed. The distinction is the whole diagnostic value:
 * - `refused`     → something IS alive at that address but nothing listens on that port
 *                   (right host, wrong port).
 * - `timeout`     → nothing answered at all (powered off, or a different network).
 * - `unreachable` → the OS says there is no route (definitively a different network).
 */
export type PingReason = 'timeout' | 'refused' | 'unreachable';

export interface PingResult {
  reachable: boolean;
  latency_ms: number | null;
  reason?: PingReason;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Dotted-quad → 32-bit int, or null when it isn't a well-formed IPv4 literal. */
export function parseIpv4(ip: string): number | null {
  const m = IPV4_PATTERN.exec(ip.trim());
  if (!m) return null;
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** RFC1918 space. Everything this bridge is allowed to dial lives here. */
export function isPrivateIpv4(ip: string): boolean {
  const v = parseIpv4(ip);
  if (v === null) return false;
  const a = v >>> 24;
  const b = (v >>> 16) & 255;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 169.254.0.0/16 — a self-assigned address, meaning DHCP failed. Never worth scanning. */
export function isLinkLocalIpv4(ip: string): boolean {
  const v = parseIpv4(ip);
  if (v === null) return false;
  return v >>> 16 === (169 << 8) + 254;
}

/**
 * Open a TCP connection just far enough to learn whether something is listening, then drop it.
 *
 * Deliberately does NOT write anything: a thermal printer that receives stray bytes prints
 * garbage, and this runs against every address on the subnet during a scan.
 */
export function tcpPing(ip: string, port: number, timeoutMs: number): Promise<PingResult> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const startedAt = performance.now();
    let settled = false;

    const finish = (result: PingResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish({ reachable: false, latency_ms: null, reason: 'timeout' }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code;
      const reason: PingReason =
        code === 'ECONNREFUSED'
          ? 'refused'
          : code === 'ETIMEDOUT'
            ? 'timeout'
            : 'unreachable';
      finish({ reachable: false, latency_ms: null, reason });
    });
    socket.connect(port, ip, () => {
      finish({ reachable: true, latency_ms: Math.round(performance.now() - startedAt) });
    });
  });
}

/**
 * Whether the bytes could conceivably have reached the printer when a send failed.
 *
 * The distinction is the whole basis of retry safety upstream. RAW/9100 has NO application
 * acknowledgement: a `write` callback firing without error means only that the bytes left this
 * machine's kernel buffer, never that anything was printed. So the honest answer is often
 * "unknown", and the relay must never auto-retry those.
 *
 *  - `none`    → the socket never opened. ECONNREFUSED, EHOSTUNREACH, a connect timeout. The
 *                printer received nothing, so a retry is provably safe.
 *  - `unknown` → we were connected when it went wrong. A retry might print a second copy.
 */
export type PrintedCertainty = 'none' | 'unknown';

export type PrintFailureReason =
  | 'connect-refused'
  | 'unreachable'
  | 'connect-timeout'
  | 'write-timeout';

export type PrintOutcome =
  | { ok: true; duration_ms: number }
  | {
      ok: false;
      reason: PrintFailureReason;
      printed_certainty: PrintedCertainty;
      detail: string;
      duration_ms: number;
    };

/**
 * The one thing a browser can't do itself: open a raw TCP socket to the printer's LAN IP and
 * write the raw ESC/POS bytes. Everything else (building the receipt, base64-encoding it) already
 * happens in the POS terminal — this is a pure forwarder.
 *
 * Resolves with an OUTCOME rather than throwing, because "it failed" is not enough information
 * for the caller: it has to know whether the failure happened before or after the socket opened.
 * Collapsing both into one error is what would make a receipt print twice.
 */
export function sendToPrinter(
  ip: string,
  port: number,
  payload: Buffer,
  timeoutMs: number
): Promise<PrintOutcome> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const startedAt = Date.now();
    // The single fact that decides retry safety. Set inside the connect callback, so anything
    // that fails before it ran provably never reached the printer.
    let connected = false;
    let settled = false;

    const finish = (outcome: PrintOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    const fail = (reason: PrintFailureReason, detail: string) =>
      finish({
        ok: false,
        reason,
        printed_certainty: connected ? 'unknown' : 'none',
        detail,
        duration_ms: Date.now() - startedAt,
      });

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () =>
      fail(connected ? 'write-timeout' : 'connect-timeout', `timed out after ${timeoutMs}ms`)
    );
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const reason: PrintFailureReason =
        err.code === 'ECONNREFUSED' ? 'connect-refused' : connected ? 'write-timeout' : 'unreachable';
      fail(reason, err.code ? `${err.code} ${ip}:${port}` : err.message);
    });
    socket.connect(port, ip, () => {
      connected = true;
      socket.write(payload, (err) =>
        err
          ? fail('write-timeout', err.message)
          : finish({ ok: true, duration_ms: Date.now() - startedAt })
      );
    });
  });
}

/** This machine's own private IPv4 addresses — the networks it can actually reach. */
export function localInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.cidr) continue;
      if (!isPrivateIpv4(entry.address) || isLinkLocalIpv4(entry.address)) continue;
      out.push({ address: entry.address, cidr: entry.cidr });
    }
  }
  return out;
}

export interface SweepPlan {
  /** The /24s that will actually be swept, e.g. `['192.168.18.0/24']`. */
  subnets: string[];
  hosts: string[];
}

/**
 * Turn this machine's interfaces into the list of addresses a scan should try.
 *
 * Every interface is clamped to the /24 around its own address regardless of the real mask.
 * A venue on a /16 would otherwise mean 65k connect attempts — minutes of scanning and a lot
 * of stray SYNs — to find a printer that is, in practice, always a neighbour.
 */
export function hostsForInterfaces(interfaces: LocalInterface[], maxHosts = 1024): SweepPlan {
  const own = new Set(interfaces.map((i) => i.address));
  const seenSubnets = new Set<string>();
  const subnets: string[] = [];
  const hosts: string[] = [];

  for (const iface of interfaces) {
    const value = parseIpv4(iface.address);
    if (value === null) continue;
    const base = value & 0xffffff00;
    const label = `${formatIpv4(base)}/24`;
    if (seenSubnets.has(label)) continue;
    seenSubnets.add(label);
    subnets.push(label);

    // .0 is the network address and .255 the broadcast — neither is ever a printer.
    for (let host = 1; host <= 254 && hosts.length < maxHosts; host++) {
      const ip = formatIpv4(base + host);
      if (own.has(ip)) continue;
      hosts.push(ip);
    }
  }

  return { subnets, hosts };
}

export interface FoundPrinter {
  ip: string;
  port: number;
  latency_ms: number | null;
}

/**
 * Probe every host in parallel batches. Concurrency is capped so a scan can't exhaust the file
 * descriptor table, and each attempt gets a short timeout because a LAN device that is there at
 * all answers in single-digit milliseconds — waiting longer only slows down the dead addresses,
 * which are the overwhelming majority.
 */
export async function sweep(
  hosts: string[],
  port: number,
  options: { concurrency: number; timeoutMs: number }
): Promise<FoundPrinter[]> {
  const found: FoundPrinter[] = [];
  let cursor = 0;

  // Single-threaded event loop: reading and advancing the cursor without an await between
  // them is atomic, so workers never claim the same host.
  const worker = async (): Promise<void> => {
    while (cursor < hosts.length) {
      const ip = hosts[cursor++];
      if (!ip) continue;
      const result = await tcpPing(ip, port, options.timeoutMs);
      if (result.reachable) found.push({ ip, port, latency_ms: result.latency_ms });
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency, hosts.length));
  await Promise.all(Array.from({ length: workers }, worker));

  found.sort((a, b) => (parseIpv4(a.ip) ?? 0) - (parseIpv4(b.ip) ?? 0));
  return found;
}

/** The de-facto standard RAW/JetDirect port. Every thermal printer here listens on it. */
export const DEFAULT_PRINTER_PORT = 9100;

/** Short on purpose: a live LAN device answers in single-digit ms; this only bounds dead hosts. */
const SCAN_HOST_TIMEOUT_MS = 500;
const SCAN_CONCURRENCY = 64;
const SCAN_MAX_HOSTS = 1024;

export interface ScanResult {
  ok: true;
  subnets: string[];
  duration_ms: number;
  printers: FoundPrinter[];
}

/**
 * One scan at a time, per port. A scan is ~1000 sockets; an operator tapping "Find printers"
 * twice should join the run already in flight, not start a second one.
 *
 * Lives here rather than in the HTTP layer because BOTH callers are equal peers: the LAN
 * `/scan` route and the relay's cloud-issued scan command. Sharing this map is what stops a
 * button press and a remote command from racing two sweeps against the same subnet — and
 * keeping it out of `server.ts` is what keeps `server` and `relay` from importing each other.
 */
const scansInFlight = new Map<number, Promise<ScanResult>>();

export function runScan(port: number): Promise<ScanResult> {
  const existing = scansInFlight.get(port);
  if (existing) return existing;

  const started = performance.now();
  const promise = (async (): Promise<ScanResult> => {
    const { subnets, hosts } = hostsForInterfaces(localInterfaces(), SCAN_MAX_HOSTS);
    const printers = await sweep(hosts, port, {
      concurrency: SCAN_CONCURRENCY,
      timeoutMs: SCAN_HOST_TIMEOUT_MS,
    });
    return {
      ok: true,
      subnets,
      duration_ms: Math.round(performance.now() - started),
      printers,
    };
  })().finally(() => {
    scansInFlight.delete(port);
  });

  scansInFlight.set(port, promise);
  return promise;
}

/**
 * Docker's default bridge networks. A process whose every interface sits in one of these is
 * almost certainly containerised WITHOUT host networking.
 *
 * Worth detecting because the failure is so misleading: printing still works (outbound NATs
 * fine), but a scan sweeps the container bridge and finds nothing, and the interfaces reported
 * upstream drive the POS's subnet comparison — which then tells an operator their printer is
 * "on a different network" when it is sitting right there. A UI that lies is worse than one
 * that admits it cannot see.
 */
export function containerSuspect(interfaces: LocalInterface[]): boolean {
  if (interfaces.length === 0) return true;
  return interfaces.every((i) =>
    ['172.17.', '172.18.', '172.19.', '172.20.'].some((p) => i.address.startsWith(p))
  );
}
