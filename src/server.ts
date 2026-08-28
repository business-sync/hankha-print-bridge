import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import {
  containerSuspect,
  DEFAULT_PRINTER_PORT,
  isPrivateIpv4,
  localInterfaces,
  runScan,
  tcpPing,
} from './lan.js';
import { discoverAll, transportAvailability } from './discovery.js';
import { prepare, targetFrom, type JobRequest } from './jobs.js';
import { log } from './log.js';
import { describeJob, queue } from './queue.js';
import { findPrinter, loadRegistry, parseRegistry, saveRegistry } from './registry.js';
import { relayStatus } from './relay.js';
import { sampleLabel, sampleReceipt } from './samples.js';
import { printerStatuses } from './status.js';
import { render } from './render/index.js';
import { driverFor } from './transports/index.js';
import { BRIDGE_SERVICE, BRIDGE_VERSION } from './version.js';

// Re-exported so existing importers of `server.js` keep working after the constants moved.
export { BRIDGE_SERVICE, BRIDGE_VERSION };
export { DEFAULT_PRINTER_PORT, type ScanResult } from './lan.js';

const PROBE_TIMEOUT_MS = 2000;
const IDENTIFY_TIMEOUT_MS = 1500;
/**
 * How long the synchronous `/print` waits.
 *
 * Matched to the POS terminal's own `PRINT_TIMEOUT_MS` (8000, in
 * `features/printer/transports/network-transport.ts`). A bridge that waits longer than its caller
 * only produces a job nobody is listening for any more.
 */
const SYNC_PRINT_TIMEOUT_MS = Number(process.env.PRINT_BRIDGE_SYNC_TIMEOUT_MS) || 8000;
/** Ample for a full-width raster receipt; small enough that a bad client cannot exhaust memory. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function isValidPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536;
}

/**
 * Only ever dial RFC1918 space. CORS is `*` (the terminal's origin varies too much to pin
 * down), so without this any page a staff member happens to open could use the bridge to port
 * scan the public internet from inside the venue's network.
 */
function isDialableTarget(ip: unknown): ip is string {
  return typeof ip === 'string' && isPrivateIpv4(ip);
}

type BodyOutcome = { ok: true; value: unknown } | { ok: false; reason: 'invalid-json' | 'body-too-large' };

function readJsonBody(req: IncomingMessage): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (outcome: BodyOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Bounded, because this process is reachable from the whole venue LAN when it binds beyond
      // loopback and an unbounded body is a one-line denial of service.
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, reason: 'body-too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        finish({ ok: true, value: undefined });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, reason: 'invalid-json' });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'invalid-json' }));
  });
}

function withCors(res: ServerResponse): void {
  // LAN-local and trusted by construction — the terminal's origin varies (localhost dev port,
  // deployed PWA origin, or a kiosk wrapper), and this process only ever accepts connections a
  // firewall already scoped to the venue's own network. `isDialableTarget` is what actually
  // keeps the open CORS policy from mattering.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  // `Authorization` is listed even when no token is configured. Omitting it makes the browser
  // fail the PREFLIGHT for any request that carries the header, and a failed preflight is
  // indistinguishable from an unreachable bridge — the request never leaves the browser and
  // nothing is logged on either side.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Chrome's Private Network Access preflight: a page on a public origin reaching a private
  // address needs this or the request is blocked before it arrives.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

/**
 * Shared secret for the LAN surface, when one is configured.
 *
 * Empty by default, because the shipped default binds loopback where the OS is the boundary.
 * It matters the moment a bridge binds 0.0.0.0 on a shop box: without it, anything on the
 * venue's Wi-Fi — including a guest phone — can drive the printers.
 */
function bridgeToken(): string {
  return process.env.PRINT_BRIDGE_TOKEN?.trim() ?? '';
}

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is compared first — and that
 * comparison leaks only the token's LENGTH, which is not the secret.
 */
function isAuthorized(req: IncomingMessage): boolean {
  const expectedToken = bridgeToken();
  if (!expectedToken) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length).trim());
  const expected = Buffer.from(expectedToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

/**
 * Bring-your-own TLS.
 *
 * Deliberately NOT a certificate this project issues or renews: a scheme that mints a public
 * cert per bridge needs a DNS zone, an ACME pipeline on every shop PC, and public A records
 * pointing at private IPs — which DNS-rebinding protection drops on many venue routers, and
 * which cannot resolve at all during the internet outage it would exist to survive. A venue
 * that already has its own cert (or an MDM-pushed CA) can use it here in two env vars.
 */
function tlsOptions(): { key: Buffer; cert: Buffer } | null {
  const certPath = process.env.PRINT_BRIDGE_TLS_CERT?.trim();
  const keyPath = process.env.PRINT_BRIDGE_TLS_KEY?.trim();
  if (!certPath || !keyPath) return null;
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

export function isTlsEnabled(): boolean {
  return Boolean(process.env.PRINT_BRIDGE_TLS_CERT?.trim() && process.env.PRINT_BRIDGE_TLS_KEY?.trim());
}

/* -------------------------------------------------------------------------- route bodies */

/**
 * The original synchronous print, now going through the queue.
 *
 * Its request and response shapes are FROZEN: `network-transport.ts` in the POS terminal sends
 * exactly `{ip, port, payload_base64}` and treats an HTTP 200 whose body says `ok: true` as proof
 * the receipt printed. So this still blocks until the job settles, and still answers with the same
 * two shapes it always has.
 *
 * What changed underneath is worth stating: the job now takes its turn in the printer's lane
 * instead of opening a socket immediately. That serialises two tills printing to one printer,
 * which is a fix, not a regression — concurrent writes to one device shred both tickets.
 */
async function handleLegacyPrint(res: ServerResponse, body: unknown): Promise<void> {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (!isDialableTarget(raw.ip) || !isValidPort(raw.port) || typeof raw.payload_base64 !== 'string') {
    sendJson(res, 400, { ok: false, reason: 'invalid-body' });
    return;
  }

  const prepared = prepare({ target: { ip: raw.ip, port: raw.port }, payload_base64: raw.payload_base64 });
  if (!prepared.ok) {
    sendJson(res, prepared.status === 413 ? 413 : 400, { ok: false, reason: prepared.reason });
    return;
  }

  // Not persisted and never retried: this caller is holding a socket open and owns its own retry
  // policy. Spooling it would mean a job the client already gave up on printing later anyway.
  const submission = queue().submit({
    source: 'local', printer: prepared.printer, payload: prepared.payload,
    persistent: false, retryable: false,
  });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SYNC_PRINT_TIMEOUT_MS);
    timer.unref();
  });
  const outcome = await Promise.race([submission.settled, deadline]);
  clearTimeout(timer);

  if (outcome === 'timeout') {
    // Cancel tells us whether it ever started. That is the difference between an honest "nothing
    // printed" and a claim that could hand the customer a second receipt on the client's retry.
    const neverStarted = queue().cancel(submission.job.job_id);
    sendJson(res, 502, {
      ok: false,
      reason: 'timeout',
      printed_certainty: neverStarted ? 'none' : 'unknown',
      detail: neverStarted
        ? `the printer queue did not reach this job within ${SYNC_PRINT_TIMEOUT_MS}ms`
        : `the job was still printing after ${SYNC_PRINT_TIMEOUT_MS}ms`,
    });
    return;
  }

  if (outcome.result?.ok) {
    sendJson(res, 200, { ok: true });
    return;
  }

  // `timeout` is kept as an alias for the connect case so terminals older than 1.3 keep
  // reading the reason they were written against; the richer classification is additive.
  sendJson(res, 502, {
    ok: false,
    reason: outcome.result?.reason === 'connect-timeout' ? 'timeout' : outcome.result?.reason,
    printed_certainty: outcome.result?.printed_certainty,
    detail: outcome.result?.detail,
  });
}

async function handleSubmitJob(res: ServerResponse, body: unknown): Promise<void> {
  const raw = (body ?? {}) as Record<string, unknown>;

  // `target` accepts the same `{ip, port}` the legacy route takes, so a client can move to /jobs
  // without also having to learn the registry.
  let target: { ip: string; port: number } | undefined;
  if (raw.target !== undefined) {
    const parsed = targetFrom((raw.target as Record<string, unknown>)?.ip, (raw.target as Record<string, unknown>)?.port);
    if (!parsed) {
      sendJson(res, 400, { ok: false, reason: 'invalid-body', errors: ['target must be { ip, port? } with a private IPv4 address'] });
      return;
    }
    target = parsed;
  }

  const request: JobRequest = {
    job_id: typeof raw.job_id === 'string' ? raw.job_id : undefined,
    printer_id: typeof raw.printer_id === 'string' ? raw.printer_id : undefined,
    target,
    copies: typeof raw.copies === 'number' ? raw.copies : undefined,
    ttl_s: typeof raw.ttl_s === 'number' ? raw.ttl_s : undefined,
    payload_base64: typeof raw.payload_base64 === 'string' ? raw.payload_base64 : undefined,
    receipt: raw.receipt,
    label: raw.label,
  };

  const prepared = prepare(request);
  if (!prepared.ok) {
    sendJson(res, prepared.status, { ok: false, reason: prepared.reason, errors: prepared.errors });
    return;
  }

  const submission = queue().submit({
    job_id: prepared.job_id,
    source: 'local',
    printer: prepared.printer,
    payload: prepared.payload,
    copies: prepared.copies,
    ttl_s: prepared.ttl_s,
  });

  // 202: accepted, not printed. A caller that needs the outcome polls `GET /jobs/:id`, or uses the
  // synchronous `/print` route instead.
  sendJson(res, 202, {
    ok: true,
    job: describeJob(submission.job),
    deduplicated: submission.deduplicated,
  });
}

async function handleTestPrint(res: ServerResponse, printerId: string): Promise<void> {
  const printer = findPrinter(loadRegistry(), printerId);
  if (!printer) {
    sendJson(res, 404, { ok: false, reason: 'unknown-printer' });
    return;
  }

  const document = printer.type === 'label' ? sampleLabel(printer) : sampleReceipt(printer);
  let payload: Buffer;
  try {
    payload = render(document, printer);
  } catch (err) {
    sendJson(res, 422, {
      ok: false,
      reason: 'render-failed',
      errors: err instanceof Error && 'errors' in err ? (err as { errors: string[] }).errors : [String(err)],
    });
    return;
  }

  const submission = queue().submit({ source: 'local', printer, payload, ttl_s: 60 });
  const settled = await submission.settled;
  sendJson(res, settled.result?.ok ? 200 : 502, { ok: settled.result?.ok === true, job: describeJob(settled) });
}

/**
 * Ask a printer what it is.
 *
 * Network only, and that is a property of the transports rather than an omission: a print spooler
 * is one-way by construction, so there is no channel to read a reply on. Both probes are chosen to
 * be harmless — `GS I` and `~HI` are status queries, not print commands — but a probe in the wrong
 * language still prints its own three or four characters, which is why nothing calls this
 * automatically.
 */
async function handleIdentify(res: ServerResponse, printerId: string): Promise<void> {
  const printer = findPrinter(loadRegistry(), printerId);
  if (!printer) {
    sendJson(res, 404, { ok: false, reason: 'unknown-printer' });
    return;
  }
  const driver = driverFor(printer.transport);
  if (!driver.query) {
    sendJson(res, 501, {
      ok: false,
      reason: 'not-supported',
      detail: `the ${printer.transport} transport is one-way — a printer behind a spooler cannot answer a query`,
    });
    return;
  }

  // `GS I 67` asks an ESC/POS printer for its firmware id; `~HI` asks a ZPL printer for its host
  // identification. Sent one after the other, with the reply attributed to whichever answered.
  const escpos = await driver.query(printer, Buffer.from([0x1d, 0x49, 67]), IDENTIFY_TIMEOUT_MS);
  const zpl = escpos ? null : await driver.query(printer, Buffer.from('~HI\r\n', 'ascii'), IDENTIFY_TIMEOUT_MS);

  sendJson(res, 200, {
    ok: true,
    printer_id: printer.id,
    configured_language: printer.language,
    detected_language: escpos ? 'escpos' : zpl ? 'zpl' : null,
    reply: (escpos ?? zpl)?.toString('latin1').replace(/[^\x20-\x7e]/g, '.') ?? null,
    detail: escpos || zpl ? undefined : 'the printer did not answer either query — many models never reply',
  });
}

function handlePutPrinters(res: ServerResponse, body: unknown): void {
  const { registry, errors } = parseRegistry(body);
  if (errors.length > 0) {
    // Every problem at once. A registry is edited whole, so reporting the first mistake only turns
    // one round trip into four.
    sendJson(res, 400, { ok: false, reason: 'invalid-registry', errors });
    return;
  }
  try {
    saveRegistry(registry);
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: 'write-failed', detail: err instanceof Error ? err.message : String(err) });
    return;
  }
  log.info(`registry: saved ${registry.printers.length} printer(s)`, {
    event: 'registry.saved', printers: registry.printers.length,
  });
  sendJson(res, 200, { ok: true, ...registry });
}

/* ------------------------------------------------------------------------------ the server */

export function createBridgeServer(): Server {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    withCors(res);

    const url = new URL(req.url ?? '/', 'http://bridge.local');
    // A trailing slash must not change the route: half the clients in this fleet build URLs by
    // concatenation and the other half do not.
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const segments = path.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    // `/health` stays open even when a token is set: the POS uses it to tell "the bridge is
    // down" from "the bridge is up but this terminal has the wrong token", and it discloses
    // nothing an attacker on the same LAN could not learn by scanning.
    if (path !== '/health' && method !== 'OPTIONS' && !isAuthorized(req)) {
      sendJson(res, 401, { ok: false, reason: 'unauthorized' });
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/health') {
      // `ok` stays first and unchanged: older terminals only look at that. Everything after
      // it is additive — a terminal predating any of these fields simply ignores them.
      //
      // The host/platform/uptime block exists because this process is invisible once it is a
      // launchd daemon or a scheduled task: the POS settings screen is the only place an
      // operator can see WHICH machine is answering, which is the difference between "the
      // bridge is fine" and "the bridge is fine, but it's the one on the office PC".
      //
      // Deliberately does NOT probe printers. This is the endpoint the POS polls, so it must stay
      // a memory read — `/status` is where the expensive question lives.
      const interfaces = localInterfaces();
      const registry = loadRegistry();
      sendJson(res, 200, {
        ok: true,
        service: BRIDGE_SERVICE,
        version: BRIDGE_VERSION,
        interfaces,
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        // Containerised without host networking: printing still works, but a scan sweeps the
        // container bridge and the interfaces above would make the POS claim the printer is on
        // a different network. Saying so is the difference between a confusing UI and an
        // honest one.
        net_warning: containerSuspect(interfaces) ? 'container-suspect' : null,
        // Lets the terminal prompt for a token instead of showing a bare 401, which otherwise
        // reads to an operator as "the bridge is broken".
        auth_required: bridgeToken().length > 0,
        relay: relayStatus(),
        printers: registry.printers.length,
        queue: queue().pending(),
      });
      return;
    }

    if (method === 'GET' && path === '/status') {
      void (async () => {
        const interfaces = localInterfaces();
        sendJson(res, 200, {
          ok: true,
          service: BRIDGE_SERVICE,
          version: BRIDGE_VERSION,
          hostname: hostname(),
          platform: platform(),
          arch: arch(),
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
          interfaces,
          net_warning: containerSuspect(interfaces) ? 'container-suspect' : null,
          auth_required: bridgeToken().length > 0,
          relay: relayStatus(),
          transports: transportAvailability(),
          printers: await printerStatuses(url.searchParams.get('probe') === '1'),
          queue: { pending: queue().pending(), ...queue().depth() },
        });
      })();
      return;
    }

    if (method === 'GET' && path === '/printers') {
      sendJson(res, 200, { ok: true, ...loadRegistry() });
      return;
    }

    if (method === 'GET' && path === '/jobs') {
      sendJson(res, 200, {
        ok: true,
        queue: { pending: queue().pending(), ...queue().depth() },
        jobs: queue().list().map(describeJob),
      });
      return;
    }

    if (method === 'GET' && segments[0] === 'jobs' && segments.length === 2) {
      const job = queue().get(segments[1] ?? '');
      if (!job) {
        sendJson(res, 404, { ok: false, reason: 'not-found' });
        return;
      }
      sendJson(res, 200, { ok: true, job: describeJob(job) });
      return;
    }

    if (method !== 'POST' && method !== 'PUT') {
      sendJson(res, 404, { ok: false, reason: 'not-found' });
      return;
    }

    void (async () => {
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, body.reason === 'body-too-large' ? 413 : 400, { ok: false, reason: body.reason });
        return;
      }
      const value = body.value;
      const record = (value ?? {}) as Record<string, unknown>;

      if (method === 'POST' && path === '/probe') {
        const port = record.port ?? DEFAULT_PRINTER_PORT;
        if (!isDialableTarget(record.ip) || !isValidPort(port)) {
          sendJson(res, 400, { ok: false, reason: 'invalid-body' });
          return;
        }
        sendJson(res, 200, { ok: true, ...(await tcpPing(record.ip, port, PROBE_TIMEOUT_MS)) });
        return;
      }

      if (method === 'POST' && path === '/scan') {
        const port = record.port ?? DEFAULT_PRINTER_PORT;
        if (!isValidPort(port)) {
          sendJson(res, 400, { ok: false, reason: 'invalid-body' });
          return;
        }
        sendJson(res, 200, await runScan(port));
        return;
      }

      if (method === 'POST' && path === '/print') {
        await handleLegacyPrint(res, value);
        return;
      }

      if (method === 'POST' && path === '/jobs') {
        await handleSubmitJob(res, value);
        return;
      }

      if (method === 'POST' && segments[0] === 'jobs' && segments[2] === 'cancel' && segments.length === 3) {
        const cancelled = queue().cancel(segments[1] ?? '');
        sendJson(res, cancelled ? 200 : 409, {
          ok: cancelled,
          reason: cancelled ? undefined : 'already-printing-or-finished',
        });
        return;
      }

      if (method === 'POST' && path === '/discover') {
        const port = record.port === undefined ? DEFAULT_PRINTER_PORT : record.port;
        if (!isValidPort(port)) {
          sendJson(res, 400, { ok: false, reason: 'invalid-body' });
          return;
        }
        sendJson(res, 200, await discoverAll({ network: record.network !== false, port }));
        return;
      }

      if (method === 'PUT' && path === '/printers') {
        handlePutPrinters(res, value);
        return;
      }

      if (method === 'POST' && segments[0] === 'printers' && segments.length === 3) {
        const printerId = segments[1] ?? '';
        if (segments[2] === 'test') {
          await handleTestPrint(res, printerId);
          return;
        }
        if (segments[2] === 'identify') {
          await handleIdentify(res, printerId);
          return;
        }
      }

      sendJson(res, 404, { ok: false, reason: 'not-found' });
    })();
  };

  const tls = tlsOptions();
  return tls ? createTlsServer(tls, handler) : createServer(handler);
}
