/*
 * The printer registry: which printers this bridge knows about, and how to reach each one.
 *
 * Until now the bridge knew about no printers at all — every request carried its own `ip` and
 * `port`, which works for exactly one transport and forces every caller to hold the wiring. A USB
 * printer has no address to carry, so a registry is the precondition for anything but TCP.
 *
 * Stored as JSON beside `relay.json` in `stateDir()`, a directory both installers already create
 * and own, so nothing here needs new permissions.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPrivateIpv4 } from './lan.js';
import { stateDir } from './identity.js';

export type TransportKind = 'network' | 'usb' | 'serial';
export type PrinterType = 'receipt' | 'label';
export type PrinterLanguage = 'escpos' | 'zpl' | 'tspl' | 'epl2';

export const TRANSPORT_KINDS: TransportKind[] = ['network', 'usb', 'serial'];
export const PRINTER_LANGUAGES: PrinterLanguage[] = ['escpos', 'zpl', 'tspl', 'epl2'];

export interface PrinterRecord {
  /** URL-safe, because it appears in `/printers/:id/test`. */
  id: string;
  name: string;
  transport: TransportKind;
  type: PrinterType;
  language: PrinterLanguage;
  enabled: boolean;

  /** network: the printer's own IP. Also usable on other transports — see `resolveByAddress`. */
  address?: string;
  port?: number;

  /** usb: the OS spooler queue name, as `lpstat -p` / `Get-Printer` reports it. */
  queue?: string;

  /** serial + Bluetooth-SPP: the character device, e.g. `/dev/tty.RPP02N-Port` or `COM3`. */
  device?: string;
  baud?: number;

  /** receipts: printable width in dots. 384 on 58 mm paper, 576 on 80 mm. */
  dots_per_line?: number;
  /** ESC/POS `ESC t n`. Only affects the high half of a byte; ASCII is identical everywhere. */
  codepage?: number;

  /** labels: physical media, in millimetres, plus head resolution. */
  width_mm?: number;
  height_mm?: number;
  gap_mm?: number;
  dpi?: number;
}

export interface Registry {
  version: 1;
  printers: PrinterRecord[];
  default_receipt_printer?: string;
  default_label_printer?: string;
}

export const EMPTY_REGISTRY: Registry = { version: 1, printers: [] };

const FILE_NAME = 'printers.json';
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function registryPath(): string {
  return join(stateDir(), FILE_NAME);
}

export interface ParseResult {
  registry: Registry;
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalInt(
  raw: unknown,
  field: string,
  where: string,
  errors: string[],
  min: number,
  max: number
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    errors.push(`${where}: ${field} must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return raw;
}

/**
 * Validate one entry, collecting every problem rather than stopping at the first.
 *
 * A registry is edited by hand or pushed whole through `PUT /printers`, so telling an operator
 * about all four mistakes at once is the difference between one round trip and four.
 */
function parsePrinter(value: unknown, index: number, errors: string[]): PrinterRecord | null {
  const raw = asRecord(value);
  const where = `printers[${index}]`;
  if (!raw) {
    errors.push(`${where}: must be an object`);
    return null;
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ID_PATTERN.test(id)) {
    errors.push(`${where}: id must match ${ID_PATTERN} (lowercase, url-safe)`);
    return null;
  }

  const before = errors.length;

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;

  const transport = raw.transport;
  if (typeof transport !== 'string' || !TRANSPORT_KINDS.includes(transport as TransportKind)) {
    errors.push(`${where}: transport must be one of ${TRANSPORT_KINDS.join(', ')}`);
  }

  const type = raw.type === 'label' ? 'label' : 'receipt';
  if (raw.type !== undefined && raw.type !== 'label' && raw.type !== 'receipt') {
    errors.push(`${where}: type must be 'receipt' or 'label'`);
  }

  // `auto` is accepted and means escpos. Nothing probes the printer to find out: an
  // identification query sent to the wrong language prints a page of garbage, so guessing is
  // opt-in through /printers/:id/identify and never a side effect of loading a config file.
  let language: PrinterLanguage = 'escpos';
  if (raw.language === undefined || raw.language === 'auto') {
    if (type === 'label') {
      // A label printer has no safe default: ZPL sent to a TSPL head prints the commands as
      // text, one label per line, until the roll runs out.
      errors.push(`${where}: language is required for a label printer (${PRINTER_LANGUAGES.join(', ')})`);
    }
  } else if (typeof raw.language === 'string' && PRINTER_LANGUAGES.includes(raw.language as PrinterLanguage)) {
    language = raw.language as PrinterLanguage;
  } else {
    errors.push(`${where}: language must be one of ${PRINTER_LANGUAGES.join(', ')} or 'auto'`);
  }

  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : undefined;
  if (address !== undefined && !isPrivateIpv4(address)) {
    // Same rule the HTTP routes enforce: this process only ever dials RFC1918 space, so an
    // address it could never use has no business being stored as if it worked.
    errors.push(`${where}: address must be a private (RFC1918) IPv4 address`);
  }
  const port = optionalInt(raw.port, 'port', where, errors, 1, 65535);
  const queue = typeof raw.queue === 'string' && raw.queue.trim() ? raw.queue.trim() : undefined;
  const device = typeof raw.device === 'string' && raw.device.trim() ? raw.device.trim() : undefined;
  const baud = optionalInt(raw.baud, 'baud', where, errors, 300, 4_000_000);

  if (transport === 'network' && !address) errors.push(`${where}: a network printer needs an address`);
  if (transport === 'usb' && !queue) errors.push(`${where}: a usb printer needs a queue name`);
  if (transport === 'serial' && !device) errors.push(`${where}: a serial printer needs a device path`);

  const dots_per_line = optionalInt(raw.dots_per_line, 'dots_per_line', where, errors, 8, 4096);
  const codepage = optionalInt(raw.codepage, 'codepage', where, errors, 0, 255);
  const width_mm = optionalInt(raw.width_mm, 'width_mm', where, errors, 1, 1000);
  const height_mm = optionalInt(raw.height_mm, 'height_mm', where, errors, 1, 1000);
  const gap_mm = optionalInt(raw.gap_mm, 'gap_mm', where, errors, 0, 100);
  const dpi = optionalInt(raw.dpi, 'dpi', where, errors, 100, 1200);

  if (type === 'label' && (width_mm === undefined || height_mm === undefined)) {
    errors.push(`${where}: a label printer needs width_mm and height_mm`);
  }

  if (errors.length !== before) return null;

  return {
    id,
    name,
    transport: transport as TransportKind,
    type,
    language,
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    address,
    port: port ?? (transport === 'network' ? DEFAULT_PRINTER_PORT_FALLBACK : undefined),
    queue,
    device,
    baud: baud ?? (transport === 'serial' ? DEFAULT_BAUD : undefined),
    dots_per_line: dots_per_line ?? (type === 'receipt' ? DEFAULT_DOTS_PER_LINE : undefined),
    codepage,
    width_mm,
    height_mm,
    gap_mm: type === 'label' ? (gap_mm ?? DEFAULT_LABEL_GAP_MM) : undefined,
    dpi: type === 'label' ? (dpi ?? DEFAULT_LABEL_DPI) : undefined,
  };
}

/** 80 mm paper. The overwhelmingly common receipt width, and what the POS assumes by default. */
export const DEFAULT_DOTS_PER_LINE = 576;
/** Every thermal printer in this fleet listens on the RAW/JetDirect port. */
const DEFAULT_PRINTER_PORT_FALLBACK = 9100;
/** What virtually every ESC/POS serial and Bluetooth-SPP printer ships with. */
export const DEFAULT_BAUD = 9600;
/** 203 dpi = 8 dots/mm, the standard thermal label head. */
export const DEFAULT_LABEL_DPI = 203;
/** The die-cut gap between labels on a roll. */
export const DEFAULT_LABEL_GAP_MM = 2;

export function parseRegistry(value: unknown): ParseResult {
  const errors: string[] = [];
  const raw = asRecord(value);
  if (!raw) return { registry: { ...EMPTY_REGISTRY, printers: [] }, errors: ['registry must be an object'] };

  const list = Array.isArray(raw.printers) ? raw.printers : [];
  if (!Array.isArray(raw.printers)) errors.push('printers must be an array');

  const printers: PrinterRecord[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const printer = parsePrinter(entry, index, errors);
    if (!printer) continue;
    if (seen.has(printer.id)) {
      errors.push(`printers[${index}]: duplicate id '${printer.id}'`);
      continue;
    }
    seen.add(printer.id);
    printers.push(printer);
  }

  const registry: Registry = { version: 1, printers };

  for (const key of ['default_receipt_printer', 'default_label_printer'] as const) {
    const id = raw[key];
    if (id === undefined || id === null || id === '') continue;
    if (typeof id !== 'string' || !seen.has(id)) {
      errors.push(`${key}: '${String(id)}' is not one of the printers listed`);
      continue;
    }
    registry[key] = id;
  }

  return { registry, errors };
}

let cached: Registry | null = null;

/**
 * Read the registry, falling back to an empty one.
 *
 * Never throws. A bridge that refused to start because its printer list had a typo would take
 * the raw `/print` passthrough down with it — and that path needs no registry at all.
 */
export function loadRegistry(): Registry {
  if (cached) return cached;
  const path = registryPath();
  if (!existsSync(path)) {
    cached = { ...EMPTY_REGISTRY, printers: [] };
    return cached;
  }
  try {
    const { registry, errors } = parseRegistry(JSON.parse(readFileSync(path, 'utf8')));
    cached = registry;
    if (errors.length > 0) {
      // Surfaced through /status too; logging here is what an operator sees at startup.
      for (const error of errors) process.stderr.write(`printers.json: ${error}\n`);
    }
    return cached;
  } catch (err) {
    process.stderr.write(`printers.json is unreadable (${err instanceof Error ? err.message : String(err)}) — starting with no printers\n`);
    cached = { ...EMPTY_REGISTRY, printers: [] };
    return cached;
  }
}

/**
 * Replace the registry on disk, atomically.
 *
 * Temp file plus rename: `rename` within a directory is atomic on every platform this runs on, so
 * a power cut during a save leaves either the old file or the new one — never a half-written list
 * that `loadRegistry` would then discard entirely.
 */
export function saveRegistry(registry: Registry): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(temp, path);
  cached = registry;
}

/** Test-only: drop the memo so a test can point `stateDir()` somewhere else and reload. */
export function resetRegistryCache(): void {
  cached = null;
}

export function findPrinter(registry: Registry, id: string): PrinterRecord | null {
  return registry.printers.find((p) => p.id === id) ?? null;
}

/**
 * Find the printer a bare `ip:port` refers to.
 *
 * This is what lets a cloud print job reach a USB printer. A relay job carries only
 * `target_ip`/`target_port` — there is no printer id on the wire — so an operator who gives a USB
 * entry an `address` makes it addressable by everything that already speaks the old contract,
 * with no change on the server or in the POS.
 */
export function resolveByAddress(registry: Registry, ip: string, port: number): PrinterRecord | null {
  return registry.printers.find((p) => p.enabled && p.address === ip && (p.port ?? 9100) === port) ?? null;
}

export function defaultPrinter(registry: Registry, type: PrinterType): PrinterRecord | null {
  const configured = type === 'label' ? registry.default_label_printer : registry.default_receipt_printer;
  if (configured) {
    const printer = findPrinter(registry, configured);
    if (printer?.enabled) return printer;
  }
  // A one-printer venue should never have to name a default.
  const candidates = registry.printers.filter((p) => p.enabled && p.type === type);
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
