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
  sendToPrinter,
  tcpPing,
} from './lan.js';
import { relayStatus } from './relay.js';
import { BRIDGE_SERVICE, BRIDGE_VERSION } from './version.js';

// Re-exported so existing importers of `server.js` keep working after the constants moved.
export { BRIDGE_SERVICE, BRIDGE_VERSION };
export { DEFAULT_PRINTER_PORT, type ScanResult } from './lan.js';

const PRINT_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;

interface PrintJob {
  ip: string;
  port: number;
  payload_base64: string;
}

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

function isPrintJob(v: unknown): v is PrintJob {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return isDialableTarget(b.ip) && isValidPort(b.port) && typeof b.payload_base64 === 'string';
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function withCors(res: ServerResponse): void {
  // LAN-local and trusted by construction — the terminal's origin varies (localhost dev port,
  // deployed PWA origin, or a kiosk wrapper), and this process only ever accepts connections a
  // firewall already scoped to the venue's own network. `isDialableTarget` is what actually
  // keeps the open CORS policy from mattering.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
const BRIDGE_TOKEN = process.env.PRINT_BRIDGE_TOKEN?.trim() ?? '';

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is compared first — and that
 * comparison leaks only the token's LENGTH, which is not the secret.
 */
function isAuthorized(req: IncomingMessage): boolean {
  if (!BRIDGE_TOKEN) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length).trim());
  const expected = Buffer.from(BRIDGE_TOKEN);
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

export function createBridgeServer(): Server {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    withCors(res);

    // `/health` stays open even when a token is set: the POS uses it to tell "the bridge is
    // down" from "the bridge is up but this terminal has the wrong token", and it discloses
    // nothing an attacker on the same LAN could not learn by scanning.
    if (req.url !== '/health' && req.method !== 'OPTIONS' && !isAuthorized(req)) {
      sendJson(res, 401, { ok: false, reason: 'unauthorized' });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      // `ok` stays first and unchanged: older terminals only look at that. Everything after
      // it is additive — a terminal predating any of these fields simply ignores them.
      //
      // The host/platform/uptime block exists because this process is invisible once it is a
      // launchd daemon or a scheduled task: the POS settings screen is the only place an
      // operator can see WHICH machine is answering, which is the difference between "the
      // bridge is fine" and "the bridge is fine, but it's the one on the office PC".
      const interfaces = localInterfaces();
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
        auth_required: BRIDGE_TOKEN.length > 0,
        relay: relayStatus(),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/probe') {
      void (async () => {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' });
          return;
        }
        const b = (body ?? {}) as Record<string, unknown>;
        const port = b.port ?? DEFAULT_PRINTER_PORT;
        if (!isDialableTarget(b.ip) || !isValidPort(port)) {
          sendJson(res, 400, { ok: false, reason: 'invalid-body' });
          return;
        }
        const result = await tcpPing(b.ip, port, PROBE_TIMEOUT_MS);
        sendJson(res, 200, { ok: true, ...result });
      })();
      return;
    }

    if (req.method === 'POST' && req.url === '/scan') {
      void (async () => {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' });
          return;
        }
        const b = (body ?? {}) as Record<string, unknown>;
        const port = b.port ?? DEFAULT_PRINTER_PORT;
        if (!isValidPort(port)) {
          sendJson(res, 400, { ok: false, reason: 'invalid-body' });
          return;
        }
        sendJson(res, 200, await runScan(port));
      })();
      return;
    }

    if (req.method === 'POST' && req.url === '/print') {
      void (async () => {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' });
          return;
        }
        if (!isPrintJob(body)) {
          sendJson(res, 400, { ok: false, reason: 'invalid-body' });
          return;
        }

        let payload: Buffer;
        try {
          payload = Buffer.from(body.payload_base64, 'base64');
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-payload' });
          return;
        }

        const outcome = await sendToPrinter(body.ip, body.port, payload, PRINT_TIMEOUT_MS);
        if (outcome.ok) {
          sendJson(res, 200, { ok: true });
          return;
        }
        // `timeout` is kept as an alias for the connect case so terminals older than 1.3 keep
        // reading the reason they were written against; the richer classification is additive.
        sendJson(res, 502, {
          ok: false,
          reason: outcome.reason === 'connect-timeout' ? 'timeout' : outcome.reason,
          printed_certainty: outcome.printed_certainty,
          detail: outcome.detail,
        });
      })();
      return;
    }

    sendJson(res, 404, { ok: false, reason: 'not-found' });
  };

  const tls = tlsOptions();
  return tls ? createTlsServer(tls, handler) : createServer(handler);
}
