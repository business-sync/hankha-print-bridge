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
import { isValidEnrollCode, normalizeEnrollCode } from './enroll-code.js';
import { prepare, targetFrom, type JobRequest } from './jobs.js';
import { log } from './log.js';
import { INDEX_CSP, INDEX_HTML } from './page.js';
import { describeJob, isSafeJobId, queue } from './queue.js';
import { findPrinter, loadRegistry, parseRegistry, registryPath, saveRegistry } from './registry.js';
import { loadState } from './identity.js';
import { enroll, isRelayRunning, relayStatus, startRelay } from './relay.js';
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
/**
 * How long `POST /printers/:id/test` waits.
 *
 * Longer than the synchronous print above, because a test slip is worth a little more patience
 * than a customer's receipt — but bounded, because a person is watching a button.
 */
const TEST_PRINT_TIMEOUT_MS = 12_000;
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

/**
 * Is this request coming from the machine the bridge runs on?
 *
 * The gate on `POST /enroll`, and the only thing standing between a venue's printers and anyone
 * else on its wifi. Two facts make it load-bearing rather than defensive: `isAuthorized()` above
 * returns TRUE when no token is configured — the default, and what both installers ship — and the
 * Windows installer binds `0.0.0.0` so other tills can reach the bridge. Without this check, a
 * guest on the café wifi could POST a pairing code from their own Hankha organisation and
 * silently take ownership of the shop's bridge, receiving every subsequent bill and kitchen
 * ticket.
 *
 * Physical access to the till is the trust boundary here, exactly as it is for the `--enroll`
 * CLI, which asks for no credential either.
 *
 * The whole 127/8 block counts, not just 127.0.0.1: macOS and Linux both route it entirely to
 * the loopback interface, and a request that arrives on lo cannot have crossed the network.
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is how a dual-stack listener reports an IPv4 client, so
 * it is the form this actually sees on a default Windows install.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress?.trim().toLowerCase();
  if (!remote) return false;
  if (remote === '::1') return true;
  const v4 = remote.startsWith('::ffff:') ? remote.slice('::ffff:'.length) : remote;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
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
 * The only route that answers with anything but JSON.
 *
 * `no-store` rather than an ETag: the page is a few tens of kilobytes over loopback, and the one
 * situation where caching would bite is the one that matters — an operator reloading after an
 * upgrade and being shown the previous build's page while support asks them what it says.
 */
function sendHtml(res: ServerResponse, html: string): void {
  const data = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': data.length,
    'Content-Security-Policy': INDEX_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
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
/*
 * The shape and normalization of a pairing code live in `enroll-code.ts`, shared with
 * `--enroll`. Checked locally either way, so an obvious typo is answered instantly and in the
 * operator's own words, rather than after a round trip that comes back as the API's
 * deliberately vague "not valid, already used, or expired" — wording that exists so the
 * endpoint is not an oracle, and which is unhelpful when the real problem is a transposed
 * character. Checking here also keeps the API's per-IP enrolment limiter for real attempts.
 */

/**
 * Pair this bridge with a venue, from the browser on the machine it runs on.
 *
 * The reason this exists rather than leaving it to `--enroll`: the command the POS used to print
 * cannot be run as shown. Neither installer puts `hankha-print-bridge` on PATH — on Windows it
 * lives under `%ProgramFiles%\Hankha\Print Bridge\`, and the macOS .dmg keeps it inside the app
 * bundle — so an operator following the instructions to the letter got `command not found`.
 * Worse on the .pkg, where the daemon runs as root: a bare `--enroll` writes the token into the
 * user's own Application Support directory (`identity.ts`), reports success, and never connects.
 *
 * Opening the address the installer already printed and pasting the code has none of those
 * failure modes, and needs no terminal at all.
 */
async function handleEnroll(res: ServerResponse, record: Record<string, unknown>): Promise<void> {
  const raw = typeof record.code === 'string' ? record.code : '';
  const normalized = normalizeEnrollCode(raw);

  if (!isValidEnrollCode(normalized)) {
    sendJson(res, 400, { ok: false, reason: 'invalid-code-format' });
    return;
  }

  // A second enrolment moves this machine's printers to whichever organisation supplied the
  // code, so it is never the incidental outcome of a pasted string. `force` makes re-pairing
  // possible without making it accidental.
  //
  // Read from disk rather than from `relayStatus()`: that reports on the LOOP, which is false
  // whenever the relay has not started — including on a bridge that is paired but whose relay
  // never came up. Treating that as unpaired would let a stray code quietly move a venue's
  // bridge in precisely the situation where nobody is watching it work.
  if (loadState().token && record.force !== true) {
    sendJson(res, 409, { ok: false, reason: 'already-enrolled' });
    return;
  }

  try {
    const { bridge_id } = await enroll(normalized);

    // Connect NOW. `--enroll` tells the operator to restart the service, which is fine for a
    // command line and useless here: the POS is sitting on "Waiting for the bridge to connect…"
    // and would wait forever. `startRelay` is guarded against a double start, so the only case
    // it declines is a forced re-pair over a live loop — which keeps the OLD token in its
    // closure, and is the one time a restart genuinely is required. Say so instead of implying
    // success.
    const wasRunning = isRelayRunning();
    if (!wasRunning) startRelay();

    log.info(`enrolled as bridge ${bridge_id} from the local page`, {
      event: 'relay.enrolled', bridge_id, source: 'page',
    });
    sendJson(res, 200, { ok: true, bridge_id, restart_required: wasRunning });
  } catch (err) {
    // The API answers every enrolment failure identically on purpose. Pass its sentence straight
    // through rather than inventing a more specific one this side cannot actually justify.
    const message = err instanceof Error ? err.message : 'Enrollment failed.';
    log.warn(`enrolment from the local page failed: ${message}`, { event: 'relay.enroll_failed' });
    sendJson(res, 502, { ok: false, reason: 'enroll-failed', message });
  }
}

async function handleLegacyPrint(res: ServerResponse, body: unknown): Promise<void> {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (typeof raw.payload_base64 !== 'string') {
    sendJson(res, 400, { ok: false, reason: 'invalid-body' });
    return;
  }

  /*
   * `printer_id` names a printer in the registry instead of a socket, and is the ONLY way this
   * synchronous route can reach a USB or serial printer — one wired to this machine has no
   * address to dial, so the `ip`/`port` form cannot express it at all. `prepare()` has resolved
   * ids since the queue landed; the route simply never offered the field, which left the POS
   * able to SEE such a printer in the registry and unable to print to it.
   *
   * The address form below is untouched: it is what every terminal in the field speaks, and a
   * client that sends both gets the id, matching `prepare()`'s own resolution order.
   */
  const printerId = typeof raw.printer_id === 'string' ? raw.printer_id.trim() : '';
  if (!printerId && (!isDialableTarget(raw.ip) || !isValidPort(raw.port))) {
    sendJson(res, 400, { ok: false, reason: 'invalid-body' });
    return;
  }

  const prepared = prepare(
    printerId
      ? { printer_id: printerId, payload_base64: raw.payload_base64 }
      : { target: { ip: raw.ip as string, port: raw.port as number }, payload_base64: raw.payload_base64 }
  );
  if (!prepared.ok) {
    sendJson(res, prepared.status === 413 ? 413 : 400, { ok: false, reason: prepared.reason, errors: prepared.errors });
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

  // Checked here so the caller gets a plain 400 naming the field, rather than the queue's throw.
  // The id ends up as a spool filename, which is why it is constrained at all.
  if (typeof raw.job_id === 'string' && raw.job_id.trim() && !isSafeJobId(raw.job_id.trim())) {
    sendJson(res, 400, {
      ok: false,
      reason: 'invalid-body',
      errors: ['job_id may contain only letters, digits, dot, dash and underscore, and cannot start with a dot'],
    });
    return;
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

  /*
   * A test print is something a person is standing in front of, waiting for.
   *
   * `ttl_s: 60` plus a retryable job means `withinDeadline` keeps trying for the whole minute, and
   * this used to `await submission.settled` with no deadline of its own — so pressing "Test print"
   * on a printer that was switched off held the HTTP request open for sixty seconds. The status
   * page has no fetch timeout either, which turned that into a page that stopped updating until
   * it was reloaded. `handleLegacyPrint` has always raced a deadline; this does the same, and
   * cancels afterwards so the answer about whether anything printed is an honest one.
   */
  const submission = queue().submit({ source: 'local', printer, payload, ttl_s: TEST_PRINT_TIMEOUT_MS / 1000 });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), TEST_PRINT_TIMEOUT_MS);
    timer.unref();
  });
  const outcome = await Promise.race([submission.settled, deadline]);
  clearTimeout(timer);

  if (outcome === 'timeout') {
    const neverStarted = queue().cancel(submission.job.job_id);
    sendJson(res, 502, {
      ok: false,
      reason: 'timeout',
      job: describeJob(queue().get(submission.job.job_id) ?? submission.job),
      printed_certainty: neverStarted ? 'none' : 'unknown',
      detail: neverStarted
        ? `the printer did not accept the test slip within ${TEST_PRINT_TIMEOUT_MS}ms`
        : `the test slip was still printing after ${TEST_PRINT_TIMEOUT_MS}ms`,
    });
    return;
  }

  sendJson(res, outcome.result?.ok ? 200 : 502, { ok: outcome.result?.ok === true, job: describeJob(outcome) });
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

    /*
     * `req.url` is a request target — always a path — but `new URL(target, base)` does not know
     * that and resolves it as a reference against the base. So `//print` parses as the HOST
     * `print` with the path `/`, and a bare `//` is not a valid URL at all and THROWS. Thrown
     * synchronously from a request listener that is an uncaughtException, which stops the
     * process: one unauthenticated `GET //` from anywhere on the venue LAN took the bridge down,
     * because this runs before the token check.
     *
     * Not hypothetical either. The POS terminal builds bridge URLs by concatenation, and its own
     * `normalizeBase` exists because a stored `http://host:9200/` was producing `…9200//print`.
     *
     * Interpolating the target after the authority is what pins it to the path: `new URL` has
     * already consumed the host by the time it reads a slash. The try/catch still stands, because
     * a proxy may send an absolute-form target and nothing here should die on a malformed one.
     */
    const target = req.url ?? '/';
    let url: URL;
    try {
      url = new URL(`http://bridge.local${target.startsWith('/') ? '' : '/'}${target}`);
    } catch {
      sendJson(res, 400, { ok: false, reason: 'invalid-request-target' });
      return;
    }
    // Neither a repeated slash nor a trailing one may change the route: half the clients in this
    // fleet build URLs by concatenation and the other half do not.
    const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    const segments = path.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    // `/health` stays open even when a token is set: the POS uses it to tell "the bridge is
    // down" from "the bridge is up but this terminal has the wrong token", and it discloses
    // nothing an attacker on the same LAN could not learn by scanning.
    //
    // The root page is open for the same reason, one step further along: it is static markup with
    // no venue data in it, and every value it displays comes from the routes below that ARE
    // guarded. Guarding the page itself would only mean an operator who opened the bridge in a
    // browser saw a bare JSON 401 instead of the sentence telling them it wants a token.
    const isPageRequest =
      (method === 'GET' || method === 'HEAD') && (path === '/' || path === '/index.html');
    // `/enroll` skips the token gate because it is the route that EXISTS to obtain a credential:
    // a bridge being paired for the first time has none, and the person pasting the code is
    // standing at the machine. Loopback is its gate instead, checked first and unconditionally
    // so no later edit to the POST block below can widen it by accident.
    const openToAnyone = path === '/health' || path === '/enroll' || isPageRequest;
    if (path === '/enroll' && method !== 'OPTIONS' && !isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, reason: 'not-loopback' });
      return;
    }
    if (!openToAnyone && method !== 'OPTIONS' && !isAuthorized(req)) {
      sendJson(res, 401, { ok: false, reason: 'unauthorized' });
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Typing the address the installer printed is the most likely thing anyone ever does with
    // this process. Answering that with `{"ok":false,"reason":"not-found"}` reads as "the thing I
    // just installed is broken".
    // HEAD as well as GET: `curl -I` and every uptime monitor ever pointed at a service aim at
    // its root. Node suppresses the body on a HEAD itself, so the headers stay honest.
    if (isPageRequest) {
      sendHtml(res, INDEX_HTML);
      return;
    }

    // HEAD as well as GET, for the same reason the root page accepts it: `curl -I` and every
    // uptime monitor aim at a URL with HEAD, and this — not `/` — is the endpoint they are told
    // to watch. Node suppresses the body on a HEAD itself, so the headers stay honest.
    if ((method === 'GET' || method === 'HEAD') && path === '/health') {
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
          // Where printers.json actually lives. The status page used to tell an operator to run
          // `--list-printers` to find this out — a CLI round trip for a string this process has
          // in hand, on a machine where the binary is not on PATH after the macOS installer.
          //
          // On /status rather than /health deliberately: /health is unauthenticated and reachable
          // from the whole venue LAN, and on macOS this path contains the account name.
          registry_path: registryPath(),
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

      if (method === 'POST' && path === '/enroll') {
        await handleEnroll(res, record);
        return;
      }

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
        const jobId = segments[1] ?? '';
        /*
         * `cancel()` answers false for "unknown id", "already settled" and "currently printing"
         * alike, and its return value is load-bearing for `/print`'s printed_certainty — so the
         * distinction is drawn HERE rather than by changing it. Without this a typo'd id came
         * back as `already-printing-or-finished`, which tells a caller that a job it never
         * created is on the paper: the one answer that suppresses a retry.
         */
        if (!queue().get(jobId)) {
          sendJson(res, 404, { ok: false, reason: 'not-found' });
          return;
        }
        const cancelled = queue().cancel(jobId);
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
