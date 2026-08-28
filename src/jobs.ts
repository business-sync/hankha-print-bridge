/*
 * Turning a request into something the queue can print.
 *
 * Two callers reach this — the LAN HTTP routes and the cloud relay — and they must resolve a
 * printer identically, or the same job would go to different hardware depending on which door it
 * came in through.
 *
 * The resolution order is the interesting part:
 *
 *   1. `printer_id`, when given. Forward-compatible: the server does not send one today, and this
 *      is what it will use when it does.
 *   2. `ip:port` matched against the registry. THIS is what lets a cloud job reach a USB printer.
 *      A relay job carries only `target_ip`/`target_port` — there is no printer id on the wire —
 *      so giving a USB entry an `address` in `printers.json` makes it addressable by every client
 *      that already speaks the old contract, with no change on the server or in the POS.
 *   3. An ad-hoc network dial to that `ip:port`. Exactly what the bridge has always done, kept as
 *      the fallback so an unregistered printer still works.
 *   4. The registry's default for the document's kind, when no target was named at all.
 */
import { DEFAULT_PRINTER_PORT, isPrivateIpv4 } from './lan.js';
import {
  defaultPrinter, findPrinter, loadRegistry, resolveByAddress,
  DEFAULT_DOTS_PER_LINE, type PrinterRecord,
} from './registry.js';
import { parseLabelDocument, parseReceiptDocument, render, RenderError } from './render/index.js';

/** A raster receipt on 80 mm paper is a few hundred KB; four megabytes is far past any real slip. */
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface JobRequest {
  job_id?: string;
  printer_id?: string;
  target?: { ip: string; port: number };
  copies?: number;
  ttl_s?: number;
  payload_base64?: string;
  receipt?: unknown;
  label?: unknown;
}

export type Prepared =
  | { ok: true; printer: PrinterRecord; payload: Buffer; copies: number; ttl_s: number | undefined; job_id: string | undefined }
  | { ok: false; status: number; reason: string; errors?: string[] };

/** A target the registry has never heard of. Network only — the other transports need real config. */
export function adHocNetworkPrinter(ip: string, port: number): PrinterRecord {
  return {
    id: `net:${ip}:${port}`,
    name: `${ip}:${port}`,
    transport: 'network',
    type: 'receipt',
    language: 'escpos',
    enabled: true,
    address: ip,
    port,
    dots_per_line: DEFAULT_DOTS_PER_LINE,
  };
}

function resolvePrinter(request: JobRequest, wants: 'receipt' | 'label'): PrinterRecord | { error: string } {
  const registry = loadRegistry();

  if (request.printer_id) {
    const printer = findPrinter(registry, request.printer_id);
    if (!printer) return { error: `no printer with id '${request.printer_id}'` };
    if (!printer.enabled) return { error: `printer '${printer.id}' is disabled` };
    return printer;
  }

  if (request.target) {
    const { ip, port } = request.target;
    if (!isPrivateIpv4(ip)) return { error: 'target.ip must be a private (RFC1918) IPv4 address' };
    return resolveByAddress(registry, ip, port) ?? adHocNetworkPrinter(ip, port);
  }

  const fallback = defaultPrinter(registry, wants);
  if (fallback) return fallback;
  return {
    error:
      registry.printers.length === 0
        ? 'no printers are configured — add one with PUT /printers, or send target.ip'
        : `no default ${wants} printer — set default_${wants}_printer, or name one with printer_id`,
  };
}

/**
 * Validate, resolve and render.
 *
 * Everything that can go wrong is returned rather than thrown, with the HTTP status the caller
 * should use, because both callers need to report a reason and only one of them is HTTP.
 */
export function prepare(request: JobRequest): Prepared {
  const forms = [request.payload_base64, request.receipt, request.label].filter((v) => v !== undefined);
  if (forms.length === 0) {
    return { ok: false, status: 400, reason: 'invalid-body', errors: ['send exactly one of payload_base64, receipt or label'] };
  }
  if (forms.length > 1) {
    return { ok: false, status: 400, reason: 'invalid-body', errors: ['send only one of payload_base64, receipt or label'] };
  }

  const copies = Number.isInteger(request.copies) ? Math.min(20, Math.max(1, request.copies as number)) : 1;
  const ttl_s = Number.isInteger(request.ttl_s) && (request.ttl_s as number) > 0
    ? Math.min(3600, request.ttl_s as number)
    : undefined;

  const wants: 'receipt' | 'label' = request.label !== undefined ? 'label' : 'receipt';
  const resolved = resolvePrinter(request, wants);
  if ('error' in resolved) return { ok: false, status: 400, reason: 'unknown-printer', errors: [resolved.error] };
  const printer = resolved;

  // Raw passthrough. Kept forever: it is the contract every existing client speaks, and the escape
  // hatch for anything the document model cannot express.
  if (request.payload_base64 !== undefined) {
    if (typeof request.payload_base64 !== 'string') {
      return { ok: false, status: 400, reason: 'invalid-body', errors: ['payload_base64 must be a string'] };
    }
    const payload = Buffer.from(request.payload_base64, 'base64');
    if (payload.length === 0) {
      return { ok: false, status: 400, reason: 'invalid-payload', errors: ['payload_base64 decoded to zero bytes'] };
    }
    if (payload.length > MAX_PAYLOAD_BYTES) {
      return { ok: false, status: 413, reason: 'payload-too-large', errors: [`${payload.length} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte limit`] };
    }
    return { ok: true, printer, payload, copies, ttl_s, job_id: request.job_id };
  }

  const parsed = request.label !== undefined
    ? parseLabelDocument(request.label)
    : parseReceiptDocument(request.receipt);
  if (!parsed.document) {
    return { ok: false, status: 400, reason: 'invalid-document', errors: parsed.errors };
  }

  try {
    const payload = render(parsed.document, printer);
    if (payload.length > MAX_PAYLOAD_BYTES) {
      return { ok: false, status: 413, reason: 'payload-too-large', errors: [`the rendered document is ${payload.length} bytes`] };
    }
    return { ok: true, printer, payload, copies, ttl_s, job_id: request.job_id };
  } catch (err) {
    if (err instanceof RenderError) return { ok: false, status: 422, reason: 'render-failed', errors: err.errors };
    throw err;
  }
}

/** The `ip`/`port` shape the legacy `/print` route and every relay job still use. */
export function targetFrom(ip: unknown, port: unknown): { ip: string; port: number } | null {
  if (typeof ip !== 'string' || !isPrivateIpv4(ip)) return null;
  const resolved = port === undefined || port === null ? DEFAULT_PRINTER_PORT : port;
  if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved <= 0 || resolved >= 65536) return null;
  return { ip, port: resolved };
}
