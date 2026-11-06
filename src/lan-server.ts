/*
 * The LAN print API: a second HTTP listener that does exactly five things and nothing else.
 *
 * Why a second listener instead of more routes on 9200: 9200 is the Bridge's whole control
 * surface — pairing, registry writes, scans, service restart — guarded by "it only listens on
 * loopback". This one is meant to be reachable from the venue's Wi-Fi, so it must not share a
 * route table, a CORS policy or a failure with that. It serves an allow-list of five routes
 * (docs/printing/LAN_WIRE_CONTRACT.md §4); everything else is a 404 before authentication is even
 * considered, and there is no code path from here to anything an administrator could do.
 *
 * Off by default. With no `lan.json` enabling it, `startLan` opens no port, creates no key and
 * writes no file.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './identity.js';
import { prepareLan } from './jobs.js';
import { LanAuth, type AuthOk } from './lan-auth.js';
import { BOOTSTRAP_KEYS, LanKeyStore, parseConfiguredBootstrap, setActiveLanKeys, type LanKeyEntry } from './lan-keys.js';
import { log, LogGate } from './log.js';
import { DEDUPE_KEY, SpoolWriteError, type JobRecord, type PrintQueue } from './queue.js';
import type { PrinterReach } from './keepwarm.js';
import { activeLanPairing, LanPairing, setActiveLanPairing, type PairingDeps } from './lan-pair.js';
import { loadState, saveState } from './identity.js';
import type { ReadbackSummary } from './printer-status.js';
import { loadRegistry, type PrinterRecord } from './registry.js';

export const LAN_PROTOCOL = 1;
export const DEFAULT_LAN_PORT = 9201;
export const DEFAULT_LAN_HOST = '0.0.0.0';
export const LAN_CONFIG_FILE = 'lan.json';
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_KEYS = 100;
const JOB_TYPES = ['RECEIPT', 'KITCHEN', 'BILL', 'TEST'] as const;
const CORS_HEADERS = 'content-type, x-hankha-ticket, x-hankha-nonce, x-hankha-signature';

// ---------------------------------------------------------------------- configuration

export interface LanConfig {
  port: number;
  host: string;
  /**
   * `"pairing_over_lan": true` in lan.json: this Bridge may be enrolled over the shop network by a
   * terminal carrying a backend-signed grant (`lan-pair.ts`). Absent or anything but `true` is OFF,
   * and the two pairing routes then do not exist.
   */
  pairing_over_lan?: true;
  /**
   * `"bootstrap_keys": [{kid, pubkey, not_before?, not_after?}]` in lan.json: backend ticket keys
   * this Bridge trusts from the first start, so one that has never been online can verify a
   * pairing grant. Validated like key-set entries; absent when none are usable.
   */
  bootstrap_keys?: LanKeyEntry[];
}

/**
 * Read `<stateDir>/lan.json`: `{ "enabled": true, "port"?: 9201, "host"?: "0.0.0.0" }`.
 *
 * Null means OFF, for every reason: no file, `enabled` anything but `true`, or a file that cannot
 * be read. A broken switch fails closed. `mainPort` is the port 9200 listens on; the two must
 * differ or the second bind would fail on every start.
 */
export function readLanConfig(dir: string = stateDir(), mainPort?: number): LanConfig | null {
  const path = join(dir, LAN_CONFIG_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log.warn(`lan: ${LAN_CONFIG_FILE} is unreadable — the LAN print API stays OFF`, { event: 'lan.config.unreadable', err });
    return null;
  }
  if (!raw || typeof raw !== 'object' || (raw as { enabled?: unknown }).enabled !== true) return null;
  const c = raw as { port?: unknown; host?: unknown };
  const port = c.port === undefined ? DEFAULT_LAN_PORT : c.port;
  const host = c.host === undefined ? DEFAULT_LAN_HOST : c.host;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65536) {
    log.warn(`lan: ${LAN_CONFIG_FILE} has a bad port — the LAN print API stays OFF`, { event: 'lan.config.bad_port' });
    return null;
  }
  if (typeof host !== 'string' || host.trim() === '' || host.length > 255) {
    log.warn(`lan: ${LAN_CONFIG_FILE} has a bad host — the LAN print API stays OFF`, { event: 'lan.config.bad_host' });
    return null;
  }
  if (port === mainPort) {
    log.warn(`lan: ${LAN_CONFIG_FILE} names port ${port}, which the main listener already uses — the LAN print API stays OFF`, {
      event: 'lan.config.port_clash', port,
    });
    return null;
  }
  const pairing = (raw as { pairing_over_lan?: unknown }).pairing_over_lan === true;
  const boot = parseConfiguredBootstrap((raw as { bootstrap_keys?: unknown }).bootstrap_keys);
  if (boot.testKeyRefused) {
    log.error(`lan: ${LAN_CONFIG_FILE} bootstrap_keys names the published TEST key from lan-vectors.json — REFUSED: its private half is public, so trusting it would let anyone mint tickets and pairing grants`, {
      event: 'lan.bootstrap.test_key_refused', expected: false,
    });
  }
  if (boot.rejected.length > 0) {
    log.warn(`lan: ${boot.rejected.length} bootstrap key(s) in ${LAN_CONFIG_FILE} were ignored: ${boot.rejected.join('; ')}`, {
      event: 'lan.bootstrap.rejected', rejected: boot.rejected,
    });
  }
  return {
    port,
    host: host.trim(),
    ...(pairing ? { pairing_over_lan: true as const } : {}),
    ...(boot.keys.length > 0 ? { bootstrap_keys: boot.keys } : {}),
  };
}

// ---------------------------------------------------------------------- job states on the wire

export type LanJobState =
  | 'queued' | 'sending' | 'bytes_written' | 'confirmed' | 'failed' | 'unknown' | 'cancelled' | 'expired' | 'unseen';

export interface LanJobStatus {
  dedupe_key: string;
  state: LanJobState;
  certainty: 'none' | 'unknown';
  error?: string;
  settled_at?: string;
  /**
   * Present only when a printer that opted in to status readback was asked about this job. See
   * `printer-status.ts` and LAN_WIRE_CONTRACT.md section 4.
   */
  readback?: ReadbackSummary;
}

/**
 * Map the queue's record onto the contract's states.
 *
 * `certainty` answers "could paper have come out?": `none` where nothing was sent, `unknown`
 * where bytes were or may have been. `bytes_written` is deliberately `unknown`, not a promise: the
 * socket accepted the bytes, which is not evidence of a slip.
 */
export function lanStatusOf(key: string, job: JobRecord | null): LanJobStatus {
  if (!job) return { dedupe_key: key, state: 'unseen', certainty: 'none' };
  const detail = job.result ? (job.result.detail ?? job.result.reason) : undefined;
  const error = detail ? { error: detail } : {};
  switch (job.status) {
    case 'queued':
      return { dedupe_key: key, state: 'queued', certainty: 'none', ...error };
    case 'printing':
      return { dedupe_key: key, state: 'sending', certainty: 'unknown' };
    case 'done': {
      // `confirmed` keeps certainty `unknown`: the enum has no "printed" value and `unknown` is the
      // one that forbids a resend. The state itself carries the evidence.
      const rb = job.result?.readback ? { readback: job.result.readback } : {};
      return {
        dedupe_key: key,
        state: job.result?.confirmed ? 'confirmed' : 'bytes_written',
        certainty: 'unknown',
        settled_at: job.updated_at,
        ...rb,
      };
    }
    case 'expired':
      return { dedupe_key: key, state: 'expired', certainty: 'none', ...error, settled_at: job.updated_at };
    case 'failed': {
      if (job.result?.reason === 'cancelled') {
        return { dedupe_key: key, state: 'cancelled', certainty: 'none', settled_at: job.updated_at };
      }
      const unknown = job.result?.printed_certainty !== 'none';
      return {
        dedupe_key: key,
        state: unknown ? 'unknown' : 'failed',
        certainty: unknown ? 'unknown' : 'none',
        ...error,
        settled_at: job.updated_at,
        ...(job.result?.readback ? { readback: job.result.readback } : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------- the server

export interface LanServerDeps {
  auth: LanAuth;
  queue: () => PrintQueue;
  installId: () => string;
  bridgeId: () => string | null;
  relayConnected: () => boolean;
  /** What the printer probes last saw; keep-warm provides it. */
  reach: (printerId: string) => PrinterReach;
  printers?: () => PrinterRecord[];
  /**
   * The pairing-over-LAN handler (M9), or null/absent while `pairing_over_lan` is off. Asked per
   * request, so the two routes exist exactly as long as the switch is on.
   */
  pairing?: () => LanPairing | null;
  /** `hello` calls allowed per remote address per minute. Past it: 429. */
  helloPerMinute?: number;
}

interface Reply {
  status: number;
  body: unknown;
  /** The request body was not read, so the connection cannot be reused. */
  close?: boolean;
  headers?: Record<string, string>;
}

const authGate = new LogGate(10 * 60_000);

function jsonReply(status: number, body: unknown, extra: Partial<Reply> = {}): Reply {
  return { status, body, ...extra };
}

function reject(status: number, reason: string, extra: Record<string, unknown> = {}, more: Partial<Reply> = {}): Reply {
  return jsonReply(status, { reason, ...extra }, more);
}

function send(res: ServerResponse, reply: Reply): void {
  const data = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(reply.close ? { Connection: 'close' } : {}),
    ...(reply.headers ?? {}),
  });
  res.end(data);
}

function cors(res: ServerResponse): void {
  // Authentication is the signature, not the origin: a terminal's origin varies too much to pin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  // Chrome's Private Network Access: a page on a public origin reaching a private address needs it.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}

type RouteName = 'hello' | 'jobs' | 'status' | 'cancel' | 'printers' | 'pair_info' | 'pair';

interface Matched {
  route: RouteName;
  method: 'GET' | 'POST';
  key?: string;
}

const CANCEL_PATH = /^\/lan\/v1\/jobs\/([^/]+)\/cancel$/;

/** The allow-list. Anything that is not one of these five (method and path) is a 404. */
function matchRoute(method: string, pathname: string, pairingOn = false): Matched | null {
  if (pairingOn && method === 'GET' && pathname === '/lan/v1/pair-info') return { route: 'pair_info', method: 'GET' };
  if (pairingOn && method === 'POST' && pathname === '/lan/v1/pair') return { route: 'pair', method: 'POST' };
  if (method === 'GET' && pathname === '/lan/v1/hello') return { route: 'hello', method: 'GET' };
  if (method === 'GET' && pathname === '/lan/v1/printers') return { route: 'printers', method: 'GET' };
  if (method === 'POST' && pathname === '/lan/v1/jobs') return { route: 'jobs', method: 'POST' };
  if (method === 'POST' && pathname === '/lan/v1/jobs/status') return { route: 'status', method: 'POST' };
  if (method === 'POST') {
    const m = CANCEL_PATH.exec(pathname);
    if (m) return { route: 'cancel', method: 'POST', key: m[1] as string };
  }
  return null;
}

function isRoutePath(pathname: string, pairingOn = false): boolean {
  if (pairingOn && (pathname === '/lan/v1/pair-info' || pathname === '/lan/v1/pair')) return true;
  return (
    pathname === '/lan/v1/hello' || pathname === '/lan/v1/printers' || pathname === '/lan/v1/jobs' ||
    pathname === '/lan/v1/jobs/status' || CANCEL_PATH.test(pathname)
  );
}

type Body = { ok: true; bytes: Buffer } | { ok: false; reply: Reply };

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Body> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ ok: false, reply: reject(413, 'payload_too_large', { max_body_bytes: limit }, { close: true }) });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const end = (b: Body) => {
      if (done) return;
      done = true;
      resolve(b);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        end({ ok: false, reply: reject(413, 'payload_too_large', { max_body_bytes: limit }, { close: true }) });
        return;
      }
      if (!done) chunks.push(chunk);
    });
    req.on('end', () => end({ ok: true, bytes: Buffer.concat(chunks) }));
    req.on('error', () => end({ ok: false, reply: reject(400, 'bad_request', {}, { close: true }) }));
    req.on('aborted', () => end({ ok: false, reply: reject(400, 'bad_request', {}, { close: true }) }));
  });
}

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (bytes.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

const FORBIDDEN_FIELDS = ['target', 'ip', 'address', 'port', 'payload_base64', 'receipt', 'label'] as const;

interface JobBody {
  dedupe_key: string;
  printer_id: string;
  job_type: (typeof JOB_TYPES)[number];
  document: unknown;
  dots_per_line: number;
  expires_in_s: number;
  reprint_of?: string;
}

function validateJobBody(value: unknown): { ok: true; body: JobBody } | { ok: false; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['the body must be a JSON object'] };
  const v = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of FORBIDDEN_FIELDS) {
    if (v[field] !== undefined) {
      errors.push(`${field} is not accepted on the LAN API: name a registry printer_id and send a document`);
    }
  }
  if (typeof v.dedupe_key !== 'string' || !DEDUPE_KEY.test(v.dedupe_key)) {
    errors.push('dedupe_key must be 8-128 characters of A-Z a-z 0-9 . _ : -');
  }
  if (typeof v.printer_id !== 'string' || v.printer_id.length === 0 || v.printer_id.length > 64) {
    errors.push('printer_id must be a registry printer id');
  }
  if (!JOB_TYPES.includes(v.job_type as (typeof JOB_TYPES)[number])) {
    errors.push(`job_type must be one of ${JOB_TYPES.join(', ')}`);
  }
  if (!v.document || typeof v.document !== 'object' || Array.isArray(v.document)) {
    errors.push('document must be an object');
  }
  if (!Number.isInteger(v.dots_per_line) || (v.dots_per_line as number) < 8 || (v.dots_per_line as number) > 4096) {
    errors.push('dots_per_line must be an integer between 8 and 4096');
  }
  if (!Number.isInteger(v.expires_in_s) || (v.expires_in_s as number) < 30 || (v.expires_in_s as number) > 3600) {
    errors.push('expires_in_s must be an integer between 30 and 3600');
  }
  // Copies are separate slips with separate keys, so a failure on copy 2 cannot reprint copy 1.
  if (v.copies !== undefined && v.copies !== 1) errors.push('copies is always 1; send each copy under its own dedupe_key');
  if (v.reprint_of !== undefined && (typeof v.reprint_of !== 'string' || !DEDUPE_KEY.test(v.reprint_of))) {
    errors.push('reprint_of must be a dedupe_key');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      dedupe_key: v.dedupe_key as string,
      printer_id: v.printer_id as string,
      job_type: v.job_type as JobBody['job_type'],
      document: v.document,
      dots_per_line: v.dots_per_line as number,
      expires_in_s: v.expires_in_s as number,
      ...(v.reprint_of !== undefined ? { reprint_of: v.reprint_of as string } : {}),
    },
  };
}

export function createLanServer(deps: LanServerDeps): Server {
  const helloLimit = deps.helloPerMinute ?? 120;
  const helloCalls = new Map<string, { windowStart: number; count: number }>();

  const helloAllowed = (remote: string): boolean => {
    const now = Date.now();
    if (helloCalls.size > 1_024) helloCalls.clear();
    const entry = helloCalls.get(remote);
    if (!entry || now - entry.windowStart >= 60_000) {
      helloCalls.set(remote, { windowStart: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= helloLimit;
  };

  const authFailed = (req: IncomingMessage, status: number, reason: string, route: string): Reply => {
    const pass = authGate.hit(`lan.auth:${reason}`);
    if (pass) {
      log.warn(`lan: refused a request to ${route} — ${reason}${pass.repeated > 0 ? ` (repeated ${pass.repeated} times)` : ''}`, {
        event: 'lan.auth.refused', reason, route, remote: req.socket.remoteAddress, repeated: pass.repeated || undefined,
      });
    }
    return reject(status, reason);
  };

  const jobEnvelope = (job: JobRecord, key: string) => ({
    dedupe_key: key,
    job_id: job.job_id,
    state: lanStatusOf(key, job).state,
  });

  async function handleJobs(auth: AuthOk, bytes: Buffer): Promise<Reply> {
    const parsed = parseJson(bytes);
    if (!parsed.ok) return reject(400, 'invalid_json');
    const checked = validateJobBody(parsed.value);
    if (!checked.ok) return reject(400, 'invalid_body', { errors: checked.errors });
    const body = checked.body;
    const queue = deps.queue();

    // A key already handled — queued, or settled and remembered — is answered, not printed. Before
    // the printer is even looked at: a resend of a job that printed must succeed even if the
    // printer has since been renamed.
    if (queue.isKnown(body.dedupe_key)) {
      const known = queue.get(body.dedupe_key);
      if (known) {
        return jsonReply(202, {
          job: jobEnvelope(known, body.dedupe_key),
          deduplicated: true,
          ack: deps.auth.ack(body.dedupe_key, known.job_id, known.created_at, auth.nonceHeader),
        });
      }
    }

    const prepared = prepareLan({
      printer_id: body.printer_id,
      document: body.document,
      dots_per_line: body.dots_per_line,
      expires_in_s: body.expires_in_s,
    });
    if (!prepared.ok) {
      return reject(prepared.status, prepared.reason, {
        ...(prepared.errors ? { errors: prepared.errors } : {}),
        ...(prepared.expected !== undefined ? { expected: prepared.expected } : {}),
      });
    }

    let submission: ReturnType<PrintQueue['submit']>;
    try {
      submission = queue.submit({
        dedupe_key: body.dedupe_key,
        source: 'local',
        printer: prepared.printer,
        payload: prepared.payload,
        copies: 1,
        ttl_s: prepared.ttl_s,
        registry_id: true,
        ...(prepared.rendered_dots !== undefined ? { rendered_dots: prepared.rendered_dots } : {}),
        // 202 means "this survives a crash". `submit` has fsynced the spool file by the time it
        // returns; if the write fails it throws, and the answer is 507, never a false 202.
        requireDurable: true,
      });
    } catch (err) {
      if (err instanceof SpoolWriteError) {
        log.error(`lan: refused ${body.dedupe_key} — the spool is not writable (${err.message})`, {
          event: 'lan.spool_unwritable', dedupe_key: body.dedupe_key, err,
        });
        return reject(507, 'spool-write-failed', { printed_certainty: 'none' });
      }
      throw err;
    }
    const job = submission.job;
    log.info(`lan: accepted ${body.dedupe_key} for ${prepared.printer.id}${submission.deduplicated ? ' (already known)' : ''}`, {
      event: 'lan.accepted', dedupe_key: body.dedupe_key, job_id: job.job_id, printer_id: prepared.printer.id,
      job_type: body.job_type, terminal_id: auth.ticket.terminal_id, deduplicated: submission.deduplicated,
      reprint_of: body.reprint_of,
    });
    return jsonReply(202, {
      job: jobEnvelope(job, body.dedupe_key),
      deduplicated: submission.deduplicated,
      ack: deps.auth.ack(body.dedupe_key, job.job_id, job.created_at, auth.nonceHeader),
    });
  }

  function handleStatus(bytes: Buffer): Reply {
    const parsed = parseJson(bytes);
    if (!parsed.ok) return reject(400, 'invalid_json');
    const keys = (parsed.value as { keys?: unknown } | undefined)?.keys;
    if (!Array.isArray(keys)) return reject(400, 'invalid_body', { errors: ['keys must be an array'] });
    if (keys.length > MAX_STATUS_KEYS) return reject(400, 'invalid_body', { errors: [`at most ${MAX_STATUS_KEYS} keys per call`] });
    for (const key of keys) {
      if (typeof key !== 'string' || !DEDUPE_KEY.test(key)) return reject(400, 'invalid_body', { errors: ['every key must be a dedupe_key'] });
    }
    const queue = deps.queue();
    return jsonReply(200, { jobs: (keys as string[]).map((key) => lanStatusOf(key, queue.get(key))) });
  }

  function handleCancel(key: string): Reply {
    if (!DEDUPE_KEY.test(key)) return reject(400, 'invalid_key');
    const queue = deps.queue();
    const job = queue.get(key);
    if (!job) return reject(404, 'not_found');
    const state = lanStatusOf(key, job).state;
    // Cancelling twice is not an error: the second caller wants the same end state.
    if (state === 'cancelled') return jsonReply(200, { state: 'cancelled' });
    if (queue.isKnown(key) && queue.cancel(key)) return jsonReply(200, { state: 'cancelled' });
    // Once bytes may be on the wire there is nothing safe to take back, and a settled job is done.
    return reject(409, state === 'sending' ? 'already_sending' : 'not_cancellable', { state: lanStatusOf(key, queue.get(key)).state });
  }

  function handlePrinters(): Reply {
    const queue = deps.queue();
    const printers = (deps.printers ?? (() => loadRegistry().printers))().map((p) => {
      const reach = deps.reach(p.id);
      const okAt = [reach.last_ok_at, queue.lastPrintOk(p.id)].filter((t): t is string => Boolean(t)).sort().at(-1) ?? null;
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        role: p.role ?? null,
        dots_per_line: p.dots_per_line ?? null,
        enabled: p.enabled,
        status_readback: queue.readback.stateOf(p),
        reachable: reach.reachable,
        last_ok_at: okAt,
      };
    });
    return jsonReply(200, { printers });
  }

  async function route(req: IncomingMessage, matched: Matched, target: string): Promise<Reply> {
    if (matched.route === 'hello') {
      if (!helloAllowed(req.socket.remoteAddress ?? 'unknown')) {
        return reject(429, 'rate_limited', {}, { headers: { 'Retry-After': '60' } });
      }
      return jsonReply(200, {
        protocol: LAN_PROTOCOL,
        install_id: deps.installId(),
        bridge_id: deps.bridgeId(),
        capabilities: deps.pairing?.() ? ['print_lan_v1', 'pair_lan_v1'] : ['print_lan_v1'],
        relay: { connected: deps.relayConnected() },
        nonce: deps.auth.issueNonce(),
        max_body_bytes: MAX_BODY_BYTES,
      });
    }

    if (matched.route === 'pair_info' || matched.route === 'pair') {
      const pairing = deps.pairing?.();
      if (!pairing) return reject(404, 'not_found');
      if (!helloAllowed(req.socket.remoteAddress ?? 'unknown')) {
        return reject(429, 'rate_limited', {}, { headers: { 'Retry-After': '60' } });
      }
      if (matched.route === 'pair_info') {
        const answer = pairing.info();
        return jsonReply(answer.status, answer.body, answer.headers ? { headers: answer.headers } : {});
      }
      const pairBody = await readBody(req, pairing.maxBodyBytes);
      if (!pairBody.ok) return pairBody.reply;
      const answer = pairing.pair(pairBody.bytes);
      return jsonReply(answer.status, answer.body, answer.headers ? { headers: answer.headers } : {});
    }

    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };

    // The ticket alone says who is asking and whether they may; check it before reading a body of
    // up to 8 MiB for someone who has no business sending one.
    const ticket = header('x-hankha-ticket');
    if (!ticket) return { ...authFailed(req, 401, 'ticket_missing', matched.route), close: true };
    const early = deps.auth.verifyTicket(ticket);
    if ('reason' in early) return { ...authFailed(req, 401, early.reason, matched.route), close: true };

    const body = await readBody(req);
    if (!body.ok) return body.reply;

    const auth = deps.auth.verify({
      method: req.method ?? '',
      target,
      body: body.bytes,
      ticket,
      nonce: header('x-hankha-nonce'),
      signature: header('x-hankha-signature'),
    });
    if (!auth.ok) return authFailed(req, auth.status, auth.reason, matched.route);

    switch (matched.route) {
      case 'jobs':
        return handleJobs(auth, body.bytes);
      case 'status':
        return handleStatus(body.bytes);
      case 'cancel':
        return handleCancel(matched.key as string);
      case 'printers':
        return handlePrinters();
      default:
        return reject(404, 'not_found');
    }
  }

  const server = createServer((req, res) => {
    cors(res);
    const target = req.url ?? '';
    // A request target is a path. Anything else (an absolute-form URL, `*`, empty) is not ours.
    if (!target.startsWith('/')) {
      send(res, reject(400, 'bad_request', {}, { close: true }));
      return;
    }
    const q = target.indexOf('?');
    const pathname = q === -1 ? target : target.slice(0, q);
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      // Preflight is answered for the five paths only; anything else is not a route.
      if (isRoutePath(pathname, Boolean(deps.pairing?.()))) {
        res.writeHead(204, { 'Content-Length': '0' });
        res.end();
      } else {
        send(res, reject(404, 'not_found', {}, { close: true }));
      }
      return;
    }

    const matched = matchRoute(method, pathname, Boolean(deps.pairing?.()));
    if (!matched) {
      // Unauthenticated and unread: a 404 reveals nothing and costs nothing.
      send(res, reject(404, 'not_found', {}, { close: true }));
      return;
    }

    void route(req, matched, target)
      .then((reply) => {
        send(res, reply);
        // An early refusal leaves the body unread; the response said `Connection: close`, and the
        // socket is dropped once it is written so the unread bytes are never parsed as a request.
        if (reply.close) res.on('finish', () => req.destroy());
      })
      .catch((err: unknown) => {
        log.error(`lan: request failed: ${err instanceof Error ? err.message : String(err)}`, {
          event: 'lan.request.failed', route: matched.route, err, expected: false,
        });
        if (!res.headersSent) send(res, reject(500, 'internal_error'));
        else res.end();
      });
  });

  // A slow or stalled client must not hold a connection (or a nonce's worth of attention) forever.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 128;
  return server;
}

// ---------------------------------------------------------------------- lifecycle

/** The shape LAN_WIRE_CONTRACT.md §6.1 defines (`enabled`, `port`, `protocol`, `pubkey`, `capabilities`, `key_ids`),
 *  plus three additive fields the backend ignores: `listening`, `host`, `listen_error`. */
export interface LanReport {
  /** The LAN API is switched on in `lan.json` (it may still be waiting for its port: see `listening`). */
  enabled: true;
  protocol: number;
  port: number;
  /** This Bridge's acknowledgement key, SPKI DER base64url: what a ticket must name as `bridge_pubkey`. */
  pubkey: string;
  capabilities: string[];
  /** The ticket key ids this Bridge can verify. */
  key_ids: string[];
  listening: boolean;
  host: string;
  listen_error?: string;
  /** Present (true) only while lan.json turns pairing over the LAN on; see LAN_WIRE_CONTRACT.md section 9. */
  pairing_over_lan?: true;
  /**
   * A real backend trust anchor is pinned (built in or in lan.json `bootstrap_keys`). False means
   * the Bridge verifies nothing until the backend delivers its key set. Additive; section 6.1.
   */
  bootstrap_pinned: boolean;
}

let current: { config: LanConfig; keys: LanKeyStore; listening: boolean; error?: string } | null = null;

/** What the heartbeat reports. Null while the LAN API is off, so the field is simply absent. */
export function lanReport(): LanReport | null {
  if (!current) return null;
  return {
    enabled: true,
    protocol: LAN_PROTOCOL,
    port: current.config.port,
    pubkey: current.keys.publicKey(),
    capabilities: activeLanPairing() ? ['print_lan_v1', 'pair_lan_v1'] : ['print_lan_v1'],
    key_ids: current.keys.kids(),
    bootstrap_pinned: current.keys.bootstrapPinned(),
    listening: current.listening,
    host: current.config.host,
    ...(current.error ? { listen_error: current.error } : {}),
    ...(activeLanPairing() ? { pairing_over_lan: true as const } : {}),
  };
}

export interface LanHandle {
  server: Server;
  config: LanConfig;
  auth: LanAuth;
  keys: LanKeyStore;
  stop(): Promise<void>;
}

export interface StartLanOptions extends Omit<LanServerDeps, 'auth'> {
  /** The port 9200 listens on, which `lan.json` must not also name. */
  mainPort?: number;
  dir?: string;
  /**
   * What pairing over the LAN needs from the rest of the Bridge. Without it `pairing_over_lan` in
   * lan.json is ignored (and logged): the hooks that start the relay after a pairing live in
   * `index.ts`, and a pairing that saved a credential and then never connected would be worse than
   * none.
   */
  pairingDeps?: Pick<PairingDeps, 'relayBase'> & Partial<Pick<PairingDeps, 'loadState' | 'saveState' | 'onPaired' | 'describe' | 'mintCode' | 'mintToken'>>;
  /** Overrides `lan.json`; for tests. */
  config?: LanConfig | null;
  retryMs?: number;
  now?: () => number;
}

/** Start the LAN listener if `lan.json` enables it; null (and nothing opened) otherwise. */
export function startLan(options: StartLanOptions): LanHandle | null {
  const dir = options.dir ?? stateDir();
  const config = options.config === undefined ? readLanConfig(dir, options.mainPort) : options.config;
  if (!config) return null;

  const keys = new LanKeyStore(dir, [...BOOTSTRAP_KEYS, ...(config.bootstrap_keys ?? [])]);
  keys.publicKey(); // create the Bridge's key now, so the first heartbeat can report it
  setActiveLanKeys(keys);
  const auth = new LanAuth({ keys, bridgeId: options.bridgeId, now: options.now });
  let pairing: LanPairing | null = null;
  if (config.pairing_over_lan && !keys.bootstrapPinned()) {
    // Not an error (a Bridge that was online has been given its keys), but for a router that never
    // has internet this is the line that explains why every grant is refused as `grant_unknown_kid`.
    log.warn('lan: LAN pairing cannot verify any grant until a bootstrap key is configured (lan.json "bootstrap_keys"; see scripts/gen-lan-signing-key.mjs). Only keys the backend has already delivered count.', {
      event: 'lan.pair.no_bootstrap_key', delivered_keys: keys.kids().length - BOOTSTRAP_KEYS.length,
    });
  }
  if (config.pairing_over_lan) {
    if (options.pairingDeps) {
      pairing = new LanPairing({
        dir,
        keys,
        loadState: options.pairingDeps.loadState ?? loadState,
        saveState: options.pairingDeps.saveState ?? saveState,
        relayBase: options.pairingDeps.relayBase,
        now: options.now,
        ...(options.pairingDeps.onPaired ? { onPaired: options.pairingDeps.onPaired } : {}),
        ...(options.pairingDeps.describe ? { describe: options.pairingDeps.describe } : {}),
        ...(options.pairingDeps.mintCode ? { mintCode: options.pairingDeps.mintCode } : {}),
        ...(options.pairingDeps.mintToken ? { mintToken: options.pairingDeps.mintToken } : {}),
      });
      setActiveLanPairing(pairing);
      log.info('lan: pairing over the shop network is ON (a paired Bridge still refuses)', { event: 'lan.pair.enabled' });
    } else {
      log.warn('lan: pairing_over_lan is set but this build did not wire it — pairing over the LAN stays OFF', { event: 'lan.pair.unwired' });
    }
  }
  const server = createLanServer({ ...options, auth, pairing: () => pairing });
  current = { config, keys, listening: false };

  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  const listen = () => {
    if (stopped) return;
    server.listen(config.port, config.host);
  };
  server.on('listening', () => {
    // `listen` resolves the host asynchronously, so a `stop()` that arrives first finds nothing to
    // close and would leave the port bound for the life of the process.
    if (stopped) {
      server.close();
      return;
    }
    if (!current) return;
    current.listening = true;
    delete current.error;
    log.info(`lan: print API listening on ${config.host}:${config.port}`, {
      event: 'lan.listening', host: config.host, port: config.port,
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (current) {
      current.listening = false;
      current.error = err.code ?? err.message;
    }
    // The LAN API is optional; the Bridge must keep printing without it. Say why, and try again.
    log.error(`lan: could not listen on ${config.host}:${config.port} (${err.code ?? err.message}) — the LAN print API is DOWN; trying again`, {
      event: 'lan.listen_failed', host: config.host, port: config.port, err, expected: false,
    });
    if (!stopped) {
      retry = setTimeout(listen, options.retryMs ?? 30_000);
      retry.unref();
    }
  });
  listen();

  return {
    server,
    config,
    auth,
    keys,
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        clearTimeout(retry);
        setActiveLanKeys(null);
        setActiveLanPairing(null);
        current = null;
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
