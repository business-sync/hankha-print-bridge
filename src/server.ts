import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome's Private Network Access preflight: a page on a public origin reaching a private
  // address needs this or the request is blocked before it arrives.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}


export function createBridgeServer(): Server {
  return createServer((req, res) => {
    withCors(res);

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
  });
}
