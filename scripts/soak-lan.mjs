#!/usr/bin/env node
/*
 * Soak and resilience harness for the LAN print API. No dependencies; Node >= 22; run from
 * anywhere:  node scripts/soak-lan.mjs --minutes 20
 *
 * WHAT IT IS. A real Bridge process (`node --import tsx src/index.ts`) with the LAN API on, two FAKE
 * ESC/POS printers listening on this machine's private LAN address, and a "terminal" that signs
 * LAN jobs with the published TEST vector key (the backend key in src/test-support/lan-vectors.json,
 * delivered to the Bridge through a scratch `lan-keys.json`). While the jobs flow it injects chaos
 * and samples the Bridge process, then asserts the things a till depends on.
 *
 * WHAT IT IS NOT. It never touches a real printer, the installed Bridge on :9200, or the real
 * state directory: everything lives in a scratch directory on free ports. A pass here is
 * "automated, fake printer, one machine" evidence. It is not a 12-hour soak and says nothing about
 * real hardware, real routers (a "router restart" here is a closed port, not a black-holed
 * packet), real Wi-Fi, or a real browser.
 *
 * CHAOS (scheduled as fractions of the run; durations scale down for short runs):
 *   printer_drop      printer A refuses connections for a while, then accepts again
 *   printer_reset     printer A resets every connection after the first bytes (paper UNKNOWN)
 *   burst_1 / burst_2 200 jobs fired at once (up to 200 concurrent connections; the LAN listener
 *                     caps at 128, and the terminal retries what it loses under the same key)
 *   kill9_1 / kill9_2 SIGKILL the Bridge mid-flight and start it again on the same state dir
 *   kill9_midsend     SIGKILL while a slip is on the wire (stalled printer, big slip): must come back `unknown`
 *                     and must not be sent again
 *   duplicates        50 known keys re-sent 3x each, concurrently, UNKNOWN keys included
 *   cancel_queued     printer A off, 20 jobs queued, all cancelled, printer back
 *   router_outage     printer A unreachable for 60 s (shorter on short runs), then back
 *
 * TERMINAL RULES (what a POS does): a key the Bridge says is `failed`/`expired`/`unseen` (certainty
 * none) is re-sent under the SAME key; `unknown`, `bytes_written`, `confirmed` and `cancelled` are
 * never re-sent by the terminal. The duplicates event re-sends some of those on purpose, to prove
 * the Bridge itself refuses to print twice.
 *
 * ASSERTIONS (exit code 1 if any fails) — see `assertions` below:
 *   no duplicate paper, no lost jobs, spool empty, RSS growth bounded, fd count flat,
 *   Bridge stayed responsive, duplicates were deduplicated, no unexpected errors in the Bridge log.
 *
 * The RSS bound is 64 MB over the longest uninterrupted Bridge process segment (first early window
 * to last window), and a trend of under 3 MB/min over its second half. Why: a V8 heap that served a
 * 200-job burst keeps some of that memory (RSS rarely shrinks), tens of MB is normal; a leak of
 * even one 64 KB buffer per job over ~2,400 jobs would be ~150 MB, and 8 KB per job would show as
 * a steady ~1 MB/min slope. The bound catches the first and the slope check is reported with its
 * number so a reader can judge the second. The check is judged only when the longest uninterrupted
 * Bridge process ran 8+ minutes; a shorter run prints the numbers and marks them NOT JUDGED, because a
 * single 200-job burst dominates a window that short.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const VECTORS = join(REPO, 'src', 'test-support', 'lan-vectors.json');

// ---------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const o = { minutes: 10, rate: 2, out: null, keep: false, report: null, chaos: true, ip: null, bin: null, seed: Date.now() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--minutes') o.minutes = Number(next());
    else if (a === '--rate') o.rate = Number(next());
    else if (a === '--out') o.out = next();
    else if (a === '--keep') o.keep = true;
    else if (a === '--report') o.report = next();
    else if (a === '--no-chaos') o.chaos = false;
    else if (a === '--ip') o.ip = next();
    else if (a === '--bridge-bin') o.bin = next();
    else if (a === '--help' || a === '-h') {
      console.log('usage: soak-lan.mjs [--minutes 10] [--rate 2 (jobs/s)] [--out <dir>] [--keep] [--report <file>] [--no-chaos] [--ip <private ipv4>] [--bridge-bin <compiled binary>]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!(o.minutes > 0.5) || !(o.rate > 0)) throw new Error('--minutes must be above 0.5 and --rate above 0');
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const DURATION_MS = Math.round(opts.minutes * 60_000);
const SCALE = Math.min(1, opts.minutes / 10);
const RUN_ID = randomBytes(3).toString('hex');

// ---------------------------------------------------------------------- small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const events = [];
function note(kind, detail = {}) {
  const e = { t_s: Math.round(elapsed() / 100) / 10, kind, ...detail };
  events.push(e);
  console.log(`[${String(e.t_s).padStart(7)}s] ${kind}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
}
const median = (a) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const percentile = (a, p) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

function privateLanIp() {
  if (opts.ip) return opts.ip;
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  throw new Error('this machine has no private (RFC 1918) IPv4 address; the Bridge refuses to dial anything else');
}

const freePort = (host) =>
  new Promise((res, rej) => {
    const s = netServer();
    s.once('error', rej);
    s.listen(0, host, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

// ---------------------------------------------------------------------- the fake printers

class FakePrinter {
  constructor(name, host) {
    this.name = name;
    this.host = host;
    this.port = 0;
    this.server = null;
    this.sockets = new Set();
    this.mode = 'ok'; // ok | reset
    /** Accept connections but read nothing until release(): a printer that has stopped taking data. */
    this.stall = false;
    this.paused = new Set();
    this.connections = 0;
    this.emptyConnections = 0;
    /** marker key -> number of times its marker appeared in received bytes */
    this.seen = new Map();
    this.bytes = 0;
  }

  record(buf) {
    this.bytes += buf.length;
    const text = buf.toString('latin1');
    for (const m of text.matchAll(/@@([A-Za-z0-9._:-]{8,128})@@/g)) this.seen.set(m[1], (this.seen.get(m[1]) ?? 0) + 1);
  }

  async up() {
    if (this.server) return;
    await new Promise((res, rej) => {
      const s = netServer((socket) => {
        this.connections += 1;
        this.sockets.add(socket);
        if (this.stall) {
          socket.pause();
          this.paused.add(socket);
        }
        let got = 0;
        socket.on('data', (c) => {
          got += c.length;
          // Each chunk is scanned on its own; a marker split across TCP segments would be missed, but
          // the Bridge writes a receipt in one write, so this undercounts only in a reset race.
          this.record(c);
          if (this.mode === 'reset') socket.resetAndDestroy();
        });
        socket.on('error', () => undefined);
        socket.on('close', () => {
          this.sockets.delete(socket);
          this.paused.delete(socket);
          if (got === 0) this.emptyConnections += 1;
        });
      });
      s.once('error', rej);
      s.listen(this.port, this.host, () => {
        this.port = s.address().port;
        this.server = s;
        res();
      });
    });
  }

  release() {
    this.stall = false;
    for (const s of this.paused) s.resume();
    this.paused.clear();
  }

  async down() {
    for (const s of this.sockets) s.destroy();
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(() => r()));
  }

  count(key) {
    return this.seen.get(key) ?? 0;
  }
}

// ---------------------------------------------------------------------- scratch state + the Bridge process

const lanIp = privateLanIp();
const outDir = resolve(opts.out ?? mkdtempSync(join(tmpdir(), 'hankha-soak-')));
const stateDir = join(outDir, 'state');
mkdirSync(stateDir, { recursive: true });

const vectors = JSON.parse(readFileSync(VECTORS, 'utf8'));
const backendKey = createPrivateKey({ key: Buffer.from(vectors.backend_key.pkcs8_b64u, 'base64url'), format: 'der', type: 'pkcs8' });
const ackPair = generateKeyPairSync('ed25519');
const ackPub = b64u(ackPair.publicKey.export({ type: 'spki', format: 'der' }));
const terminalPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const terminalPub = b64u(terminalPair.publicKey.export({ type: 'spki', format: 'der' }));
const BRIDGE_ID = '77';

const printerA = new FakePrinter('A', lanIp);
const printerB = new FakePrinter('B', lanIp);
const printers = { soak_a: printerA, soak_b: printerB };

let ports = null;

function writeState() {
  writeFileSync(join(stateDir, 'lan.json'), JSON.stringify({ enabled: true, port: ports.lan, host: lanIp }));
  writeFileSync(
    join(stateDir, 'lan-key.json'),
    JSON.stringify({
      v: 1,
      created_at: new Date().toISOString(),
      private_key: b64u(ackPair.privateKey.export({ type: 'pkcs8', format: 'der' })),
      public_key: ackPub,
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    join(stateDir, 'lan-keys.json'),
    JSON.stringify({ v: 1, keys: [{ kid: vectors.backend_key.kid, pubkey: vectors.backend_key.spki_b64u, not_before: 0, not_after: null }] })
  );
  writeFileSync(join(stateDir, 'relay.json'), JSON.stringify({ install_id: 'soak-install-0001', bridge_id: BRIDGE_ID }));
  const mk = (id, name, role, p) => ({
    id, name, transport: 'network', type: 'receipt', language: 'escpos', enabled: true, role, address: lanIp, port: p.port, dots_per_line: 576,
  });
  writeFileSync(
    join(stateDir, 'printers.json'),
    JSON.stringify({ version: 1, printers: [mk('soak_a', 'Soak A', 'receipt', printerA), mk('soak_b', 'Soak B', 'kitchen', printerB)] })
  );
}

const bridgeLogPath = join(outDir, 'bridge.log');
const bridgeLog = createWriteStream(bridgeLogPath, { flags: 'a' });
const bridge = { child: null, pid: null, epoch: 0, starts: 0, up: false };

async function startBridge() {
  // `--bridge-bin` drives a COMPILED build (dist-bin/hankha-print-bridge) instead of the TypeScript source,
  // so a release artifact can be soaked as shipped.
  const [cmd, cmdArgs] = opts.bin ? [resolve(opts.bin), []] : [process.execPath, ['--import', 'tsx', join(REPO, 'src', 'index.ts')]];
  const child = spawn(cmd, cmdArgs, {
    cwd: REPO,
    env: {
      ...process.env,
      PRINT_BRIDGE_PORT: String(ports.main),
      PRINT_BRIDGE_HOST: '127.0.0.1',
      PRINT_BRIDGE_STATE_DIR: stateDir,
      PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9', // nothing listens on 9: no cloud traffic leaves this machine
      PRINT_BRIDGE_LOG_FORMAT: 'json',
      PRINT_BRIDGE_LOG_LEVEL: 'info',
      PRINT_BRIDGE_DIAG_INTERVAL_MIN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(bridgeLog, { end: false });
  child.stderr.pipe(bridgeLog, { end: false });
  bridge.child = child;
  bridge.pid = child.pid;
  bridge.starts += 1;
  bridge.epoch += 1;
  bridge.exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${ports.main}/health`);
      if (res.ok) {
        const hello = await fetch(`http://${lanIp}:${ports.lan}/lan/v1/hello`);
        if (hello.ok) break;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('the Bridge did not come up in 60 s; see ' + bridgeLogPath);
    await sleep(150);
  }
  bridge.up = true;
}

async function kill9() {
  bridge.up = false;
  const pid = bridge.pid;
  process.kill(pid, 'SIGKILL');
  await bridge.exited;
}

// ---------------------------------------------------------------------- the terminal: tickets, sessions, requests

const nowS = Math.floor(Date.now() / 1000);
const ticket = (() => {
  const iat = nowS - 60;
  const json = JSON.stringify({
    v: 1, org_id: '2', branch_id: '8', terminal_id: 'soak-terminal-1', bridge_id: BRIDGE_ID, bridge_pubkey: ackPub,
    terminal_pubkey: terminalPub, kid: vectors.backend_key.kid, iat, exp: iat + 7 * 86_400,
  });
  return `${b64u(Buffer.from(json))}.${b64u(cryptoSign(null, Buffer.from(json), backendKey))}`;
})();

const agent = new Agent({ keepAlive: true, maxSockets: Infinity, keepAliveMsecs: 10_000 });
const stats = {
  requests: 0, net_errors: 0, status: {}, retries_429: 0, session_refreshes: 0, peak_inflight: 0, inflight: 0,
  hello_429: 0, skipped_generation: 0,
};

function rawRequest(method, path, bodyStr, headers = {}, timeoutMs = 20_000) {
  return new Promise((res) => {
    const started = Date.now();
    stats.inflight += 1;
    stats.peak_inflight = Math.max(stats.peak_inflight, stats.inflight);
    stats.requests += 1;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      stats.inflight -= 1;
      res({ ...v, ms: Date.now() - started });
    };
    const req = httpRequest(
      { host: lanIp, port: ports.lan, method, path, agent, headers: { ...headers, ...(bodyStr ? { 'content-length': Buffer.byteLength(bodyStr), 'content-type': 'application/json' } : {}) }, timeout: timeoutMs },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          stats.status[r.statusCode] = (stats.status[r.statusCode] ?? 0) + 1;
          finish({ status: r.statusCode, json, headers: r.headers });
        });
        r.on('error', (e) => finish({ error: e.code ?? e.message }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      stats.net_errors += 1;
      finish({ error: e.code ?? e.message });
    });
    req.end(bodyStr || undefined);
  });
}

class Session {
  constructor() {
    this.nonce = null;
    this.counter = 0;
    this.issued = 0;
    this.epoch = -1;
    this.chain = Promise.resolve();
  }

  stale() {
    return this.nonce === null || this.epoch !== bridge.epoch || Date.now() - this.issued > 240_000;
  }

  async refresh() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const r = await rawRequest('GET', '/lan/v1/hello', '');
      if (r.status === 200 && r.json?.nonce) {
        this.nonce = r.json.nonce;
        this.counter = 0;
        this.issued = Date.now();
        this.epoch = bridge.epoch;
        stats.session_refreshes += 1;
        return true;
      }
      if (r.status === 429) {
        stats.hello_429 += 1;
        await sleep(1_500);
      } else {
        await sleep(300 + attempt * 100);
      }
    }
    return false;
  }

  /** Serialised: a session's counters must rise in arrival order. */
  call(method, path, body) {
    const run = async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (this.stale() && !(await this.refresh())) return { error: 'no-hello' };
        this.counter += 1;
        const nonceHeader = `${this.nonce}.${this.counter}`;
        const bodyStr = body === undefined ? '' : JSON.stringify(body);
        const signing = `HANKHA-LAN1\n${method}\n${path}\n${sha256hex(bodyStr)}\n${nonceHeader}`;
        const signature = b64u(cryptoSign('sha256', Buffer.from(signing), { key: terminalPair.privateKey, dsaEncoding: 'ieee-p1363' }));
        const r = await rawRequest(method, path, bodyStr, { 'x-hankha-ticket': ticket, 'x-hankha-nonce': nonceHeader, 'x-hankha-signature': signature });
        if (r.status === 401 && (r.json?.reason === 'replayed_or_unknown_nonce')) {
          this.nonce = null;
          continue;
        }
        if (r.status === 429) {
          stats.retries_429 += 1;
          await sleep(Math.min(61, Number(r.headers['retry-after'] ?? 5)) * 1000);
          continue;
        }
        return r;
      }
      return { error: 'gave-up' };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

const steadySessions = Array.from({ length: 8 }, () => new Session());
const pollSession = new Session();
const burstSessions = [];
let rr = 0;
const nextSteady = () => steadySessions[rr++ % steadySessions.length];

// ---------------------------------------------------------------------- the job book

/** key -> record. `final` is set from the Bridge's own status answers. */
const book = new Map();
const counters = {
  posted: 0, accepted: 0, deduplicated_answers: 0, resent_after_none: 0, rejected: 0, gave_up_submit: 0,
  dup_checked: 0, dup_violations: 0, unknown_resent_by_terminal: 0, cancel_ok: 0, cancel_409: 0, cancel_other: 0,
};
let keyN = 0;
const mkKey = (tag = 'j') => `soak-${RUN_ID}-${tag}-${String(++keyN).padStart(6, '0')}`;

function documentFor(key) {
  return { kind: 'receipt', elements: [{ type: 'text', value: `@@${key}@@` }, { type: 'text', value: 'soak receipt line, item 1 x 25,000' }, { type: 'text', value: 'TOTAL 25,000' }] };
}

function bodyFor(key, printer, expires, doc) {
  return { dedupe_key: key, printer_id: printer, job_type: 'RECEIPT', document: doc ?? documentFor(key), dots_per_line: 576, expires_in_s: expires };
}

/** POST the job until the Bridge answers 202/4xx. Retries the SAME key through network errors and 5xx. */
async function submit(key, printer, expires, session = nextSteady(), doc = undefined) {
  let rec = book.get(key);
  if (!rec) {
    rec = { key, printer, expires, accepted: false, final: null, resends: 0, posts: 0, cancelled: false, deduped_on_first: null, events: [] };
    book.set(key, rec);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    rec.posts += 1;
    counters.posted += 1;
    const r = await session.call('POST', '/lan/v1/jobs', bodyFor(key, printer, expires, doc));
    if (r.status === 202) {
      rec.accepted = true;
      counters.accepted += 1;
      if (r.json?.deduplicated) counters.deduplicated_answers += 1;
      rec.last_state = r.json?.job?.state;
      return r;
    }
    if (r.status && r.status < 500 && r.status !== 429) {
      // 4xx other than a rate limit: the Bridge refused the slip. Not expected in this run.
      counters.rejected += 1;
      rec.rejected = { status: r.status, reason: r.json?.reason };
      return r;
    }
    await sleep(Math.min(3_000, 200 + attempt * 150));
  }
  counters.gave_up_submit += 1;
  rec.gave_up_submit = true;
  return { error: 'gave-up' };
}

const FINAL_PRINTED = new Set(['bytes_written', 'confirmed']);

/** One pass of the status poller: ask about every accepted, unsettled key; act as a POS would. */
let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    await pollOnceInner();
  } finally {
    polling = false;
  }
}

async function pollOnceInner() {
  const open = [...book.values()].filter((r) => r.accepted && !r.final && !r.resending);
  for (let i = 0; i < open.length; i += 100) {
    const batch = open.slice(i, i + 100);
    const r = await pollSession.call('POST', '/lan/v1/jobs/status', { keys: batch.map((b) => b.key) });
    if (r.status !== 200) continue;
    for (const st of r.json.jobs) {
      const rec = book.get(st.dedupe_key);
      if (!rec || rec.final) continue;
      rec.last_state = st.state;
      if (FINAL_PRINTED.has(st.state)) rec.final = st.state;
      else if (st.state === 'unknown') rec.final = 'unknown';
      else if (st.state === 'cancelled') rec.final = 'cancelled';
      else if (st.state === 'failed' || st.state === 'expired' || st.state === 'unseen') {
        // Certainty none: nothing reached the printer, so the terminal sends the same key again.
        if (rec.cancelled) {
          rec.final = 'cancelled_by_terminal';
        } else if (rec.resends >= 8) {
          rec.final = `gave_up_after_${st.state}`;
        } else {
          rec.resends += 1;
          counters.resent_after_none += 1;
          rec.resending = true;
          void submit(rec.key, rec.printer, 900).finally(() => {
            rec.resending = false;
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------- steady load

let generating = true;
let inflightTasks = 0;
function startGenerator() {
  const interval = Math.max(5, Math.round(1000 / opts.rate));
  return setInterval(() => {
    if (!generating) return;
    if (inflightTasks > 400) {
      stats.skipped_generation += 1;
      return;
    }
    const printer = Math.random() < 0.6 ? 'soak_a' : 'soak_b';
    const expires = Math.random() < 0.1 ? 30 : 900;
    const key = mkKey('s');
    inflightTasks += 1;
    void submit(key, printer, expires).finally(() => {
      inflightTasks -= 1;
    });
  }, interval);
}

// Burst sessions: warmed continuously at a rate that leaves hello headroom (the Bridge allows 120/min per address).
let warming = true;
async function warmer() {
  while (warming) {
    if (bridge.up) {
      const target = Math.min(200, Math.max(20, Math.round(200 * Math.min(1, DURATION_MS / 600_000))));
      while (burstSessions.length < target) burstSessions.push(new Session());
      const stale = burstSessions.find((s) => s.stale());
      if (stale) {
        await stale.refresh();
        await sleep(800);
        continue;
      }
    }
    await sleep(1_000);
  }
}

async function burst(tag, n = 200) {
  const keys = Array.from({ length: n }, () => mkKey(tag));
  const ready = burstSessions.filter((s) => !s.stale());
  note('burst_start', { jobs: n, ready_sessions: ready.length });
  const pool = ready.length > 0 ? ready : steadySessions;
  let accepted = 0;
  await Promise.all(
    keys.map(async (key, i) => {
      const r = await submit(key, i % 2 ? 'soak_a' : 'soak_b', 900, pool[i % pool.length]);
      if (r.status === 202) accepted += 1;
    })
  );
  note('burst_done', { accepted, of: n, peak_inflight: stats.peak_inflight });
}

// ---------------------------------------------------------------------- chaos

const OUTAGE_S = opts.minutes >= 10 ? 60 : Math.max(8, Math.round(opts.minutes * 6));
const SHORT_S = Math.max(5, Math.round(15 * SCALE));

const chaos = {
  async printer_drop() {
    note('printer_drop', { for_s: SHORT_S });
    await printerA.down();
    await sleep(SHORT_S * 1000);
    await printerA.up();
    note('printer_back');
  },
  async printer_reset() {
    note('printer_reset', { for_s: SHORT_S });
    printerA.mode = 'reset';
    await sleep(SHORT_S * 1000);
    printerA.mode = 'ok';
    note('printer_reset_over');
  },
  burst_1: () => burst('b1'),
  burst_2: () => burst('b2'),
  async kill9_1() {
    note('kill9', { pid: bridge.pid, pending_keys: [...book.values()].filter((r) => r.accepted && !r.final).length });
    await kill9();
    await sleep(2_000);
    await startBridge();
    note('bridge_restarted', { pid: bridge.pid });
  },
  async kill9_2() {
    return chaos.kill9_1();
  },
  /**
   * SIGKILL while a slip is genuinely on the wire. A printer that has stopped reading plus a slip too
   * big for the socket buffers keeps one job in `sending`; killing the Bridge then leaves bytes that
   * may or may not have reached paper. The Bridge must report it `unknown` after the restart and the
   * terminal must NOT send it again.
   */
  async kill9_midsend() {
    note('kill9_midsend_start');
    const key = mkKey('m');
    midsendKey = key;
    const big = { kind: 'receipt', elements: [{ type: 'text', value: `@@${key}@@` }, ...Array.from({ length: 1300 }, (_, i) => ({ type: 'text', value: `${i} ${'z'.repeat(2800)}` }))] };
    printerB.stall = true;
    const before = printerB.connections;
    await submit(key, 'soak_b', 900, steadySessions[0], big);
    const deadline = Date.now() + 20_000;
    let state = null;
    while (Date.now() < deadline) {
      const r = await pollSession.call('POST', '/lan/v1/jobs/status', { keys: [key] });
      state = r.json?.jobs?.[0]?.state;
      if (state === 'sending' && printerB.connections > before) break;
      await sleep(250);
    }
    note('kill9_midsend', { state_before_kill: state, pid: bridge.pid });
    await kill9();
    await sleep(1_500);
    printerB.release();
    await startBridge();
    note('bridge_restarted', { pid: bridge.pid });
  },
  async duplicates() {
    const pool = [...book.values()].filter((r) => r.accepted && !r.cancelled && !r.resending && (r.final === 'unknown' || FINAL_PRINTED.has(r.final ?? '') || (r.final === null && r.expires === 900 && r.resends === 0)));
    const picked = pool.sort(() => Math.random() - 0.5).slice(0, 50);
    const unknownIncluded = picked.filter((r) => r.final === 'unknown').length;
    note('duplicates_start', { keys: picked.length, unknown_included: unknownIncluded });
    const sessions = burstSessions.filter((s) => !s.stale());
    const pool2 = sessions.length ? sessions : steadySessions;
    let n = 0;
    await Promise.all(
      picked.flatMap((rec) =>
        [0, 1, 2].map(async () => {
          const s = pool2[n++ % pool2.length];
          const r = await s.call('POST', '/lan/v1/jobs', bodyFor(rec.key, rec.printer, 900));
          if (r.status === 202) {
            counters.dup_checked += 1;
            // A key in the queue or the settled ring must be answered, not printed again.
            if (!r.json.deduplicated) {
              counters.dup_violations += 1;
              rec.dup_violation = true;
            }
          }
        })
      )
    );
    note('duplicates_done', { checked: counters.dup_checked, violations: counters.dup_violations });
  },
  async cancel_queued() {
    note('cancel_queued_start');
    await printerA.down();
    const keys = Array.from({ length: 20 }, () => mkKey('c'));
    await Promise.all(keys.map((k) => submit(k, 'soak_a', 900)));
    await sleep(500);
    for (const k of keys) {
      const rec = book.get(k);
      rec.cancelled = true;
      const r = await steadySessions[0].call('POST', `/lan/v1/jobs/${k}/cancel`);
      if (r.status === 200) counters.cancel_ok += 1;
      else if (r.status === 409) counters.cancel_409 += 1;
      else counters.cancel_other += 1;
    }
    await printerA.up();
    note('cancel_queued_done', { cancelled: counters.cancel_ok, already_sending: counters.cancel_409, other: counters.cancel_other });
  },
  async router_outage() {
    note('router_outage', { for_s: OUTAGE_S });
    await printerA.down();
    await sleep(OUTAGE_S * 1000);
    await printerA.up();
    note('router_back');
  },
};

const SCHEDULE = [
  [0.08, 'printer_drop'], [0.14, 'printer_reset'], [0.2, 'burst_1'], [0.3, 'kill9_1'], [0.38, 'duplicates'],
  [0.46, 'cancel_queued'], [0.54, 'router_outage'], [0.66, 'burst_2'], [0.76, 'kill9_midsend'], [0.9, 'kill9_2'],
];

// ---------------------------------------------------------------------- sampling the Bridge process

const samples = [];
async function sampleProcess() {
  if (!bridge.up) return;
  const pid = bridge.pid;
  let rssKb = null;
  let fds = null;
  try {
    rssKb = Number((await execFileP('ps', ['-o', 'rss=', '-p', String(pid)])).stdout.trim());
  } catch {
    /* gone */
  }
  try {
    const { stdout: out } = await execFileP('lsof', ['-p', String(pid), '-n', '-P'], { maxBuffer: 64 * 1024 * 1024 });
    fds = Math.max(0, out.split('\n').filter(Boolean).length - 1);
  } catch {
    /* lsof exits 1 when there is nothing */
  }
  let spoolFiles = null;
  let spoolBytes = 0;
  try {
    const names = readdirSync(join(stateDir, 'spool'));
    spoolFiles = names.length;
    for (const n of names) {
      try {
        spoolBytes += statSync(join(stateDir, 'spool', n)).size;
      } catch {
        /* settled between readdir and stat */
      }
    }
  } catch {
    spoolFiles = 0;
  }
  const s = { t_s: Math.round(elapsed() / 100) / 10, pid, epoch: bridge.epoch, rss_mb: rssKb === null ? null : Math.round((rssKb / 1024) * 10) / 10, fds, spool_files: spoolFiles, spool_kb: Math.round(spoolBytes / 1024) };
  samples.push(s);
  return s;
}

async function sampleStatus() {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${ports.main}/status`, { signal: AbortSignal.timeout(10_000) });
    const j = await res.json();
    const last = samples.at(-1);
    if (last) {
      last.queue_pending = j.queue?.pending;
      last.queue_printing = j.queue?.printing;
      last.heap_mb = j.diagnostics?.heap_used_mb;
      last.status_ms = Date.now() - started;
    }
  } catch {
    /* mid-restart */
  }
}

const latencies = []; // {t_s, ms, epoch}
let probing = true;
async function latencyProbe() {
  while (probing) {
    if (bridge.up) {
      const started = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${ports.main}/health`, { signal: AbortSignal.timeout(10_000) });
        await res.arrayBuffer();
        latencies.push({ t_s: Math.round(elapsed() / 100) / 10, ms: Date.now() - started, epoch: bridge.epoch });
      } catch {
        /* restart window */
      }
    }
    await sleep(1_000);
  }
}

// ---------------------------------------------------------------------- analysis

function regressionSlopePerMin(points) {
  // points: [{t_s, v}]; least squares slope in value per minute
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.t_s, 0) / n;
  const my = points.reduce((a, p) => a + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t_s - mx) * (p.v - my);
    den += (p.t_s - mx) ** 2;
  }
  return den === 0 ? null : (num / den) * 60;
}

function segments() {
  const by = new Map();
  for (const s of samples) {
    if (!by.has(s.epoch)) by.set(s.epoch, []);
    by.get(s.epoch).push(s);
  }
  return [...by.entries()].map(([epoch, list]) => ({ epoch, list, start: list[0].t_s, end: list.at(-1).t_s, span_s: list.at(-1).t_s - list[0].t_s }));
}

function resourceAnalysis() {
  const segs = segments();
  const longest = [...segs].sort((a, b) => b.span_s - a.span_s)[0];
  if (!longest || longest.list.length < 8) return { segment: null, note: 'too few samples for a trend' };
  const l = longest.list.filter((s) => s.rss_mb !== null);
  const warm = Math.min(120, longest.span_s / 4);
  const early = l.filter((s) => s.t_s >= longest.start + warm && s.t_s <= longest.start + warm * 2).map((s) => s.rss_mb);
  const late = l.slice(-6).map((s) => s.rss_mb);
  const half = l.filter((s) => s.t_s >= longest.start + longest.span_s / 2).map((s) => ({ t_s: s.t_s, v: s.rss_mb }));
  const fdEarly = longest.list.filter((s) => s.fds !== null && s.t_s >= longest.start + warm && s.t_s <= longest.start + warm * 2).map((s) => s.fds);
  const fdLate = longest.list.slice(-6).filter((s) => s.fds !== null).map((s) => s.fds);
  return {
    judged: longest.span_s >= 480,
    segment: { epoch: longest.epoch, start_s: longest.start, end_s: longest.end, span_s: Math.round(longest.span_s), samples: longest.list.length },
    rss_early_median_mb: median(early),
    rss_late_median_mb: median(late),
    rss_growth_mb: median(early) !== null && median(late) !== null ? Math.round((median(late) - median(early)) * 10) / 10 : null,
    rss_peak_mb: Math.max(...l.map((s) => s.rss_mb)),
    rss_slope_second_half_mb_per_min: (() => {
      const v = regressionSlopePerMin(half);
      return v === null ? null : Math.round(v * 100) / 100;
    })(),
    fds_early_median: median(fdEarly),
    fds_late_median: median(fdLate),
    fds_peak: Math.max(...longest.list.filter((s) => s.fds !== null).map((s) => s.fds)),
  };
}

function bridgeLogSummary() {
  const text = existsSync(bridgeLogPath) ? readFileSync(bridgeLogPath, 'utf8') : '';
  const levels = { error: {}, warn: {} };
  const lags = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const lvl = rec.level;
    if (lvl === 'error' || lvl === 'warn') {
      const ev = rec.event ?? rec.msg?.slice(0, 60) ?? 'unknown';
      levels[lvl][ev] = (levels[lvl][ev] ?? 0) + 1;
    }
    if (rec.event === 'diag.snapshot' && rec.lag_max_ms !== undefined) lags.push({ lag_max_ms: rec.lag_max_ms, lag_p99_ms: rec.lag_p99_ms });
    if (rec.event === 'diag.event_loop_lag') lags.push({ lag_max_ms: rec.lag_ms, lag_p99_ms: rec.lag_ms });
  }
  return { errors: levels.error, warnings: levels.warn, lag_snapshots: lags.length, lag_max_ms: lags.length ? Math.max(...lags.map((l) => l.lag_max_ms)) : null };
}

// ---------------------------------------------------------------------- main

let exitCode = 0;
let midsendKey = null;
async function main() {
  console.log(`soak-lan: ${opts.minutes} min at ${opts.rate} jobs/s, printers on ${lanIp}, scratch dir ${outDir}`);
  console.log('automated, fake printers, this machine; NOT a 12-hour soak and NOT real hardware.');
  ports = { main: await freePort('127.0.0.1'), lan: await freePort(lanIp) };
  await printerA.up();
  await printerB.up();
  writeState();
  await startBridge();
  note('bridge_started', { pid: bridge.pid, main_port: ports.main, lan_port: ports.lan, printer_a: printerA.port, printer_b: printerB.port });
  // A baseline before any load: the idle fd count the end state is compared with.
  await sleep(2_000);
  const idleStart = await sampleProcess();
  note('idle_baseline', { rss_mb: idleStart?.rss_mb, fds: idleStart?.fds });

  const generator = startGenerator();
  const poller = setInterval(() => void pollOnce().catch(() => undefined), 2_000);
  const warm = warmer();
  const probe = latencyProbe();
  let sampling = false;
  const sampler = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void sampleProcess()
      .then(() => sampleStatus())
      .finally(() => {
        sampling = false;
      });
  }, 10_000);

  const chaosDone = [];
  if (opts.chaos) {
    for (const [fraction, name] of SCHEDULE) {
      chaosDone.push(
        (async () => {
          await sleep(Math.max(0, fraction * DURATION_MS - elapsed()));
          try {
            await chaos[name]();
          } catch (e) {
            note('chaos_error', { name, error: String(e) });
            exitCode = 1;
          }
        })()
      );
    }
  }
  await sleep(Math.max(0, DURATION_MS - elapsed()));
  await Promise.all(chaosDone);

  // ---- wind down: stop new work, heal everything, let the Bridge finish what it accepted
  note('winding_down', { accepted_keys: [...book.values()].filter((r) => r.accepted).length });
  generating = false;
  clearInterval(generator);
  printerA.mode = 'ok';
  await printerA.up();
  await printerB.up();
  const settleDeadline = Date.now() + Math.max(180_000, DURATION_MS * 0.15);
  for (;;) {
    await pollOnce().catch(() => undefined);
    const open = [...book.values()].filter((r) => (r.accepted && !r.final) || r.resending);
    if (open.length === 0) break;
    if (Date.now() > settleDeadline) {
      note('settle_timeout', { open: open.length });
      break;
    }
    await sleep(2_000);
  }
  // Spool and queue should now be empty.
  const spoolDeadline = Date.now() + 60_000;
  while (Date.now() < spoolDeadline) {
    const names = existsSync(join(stateDir, 'spool')) ? readdirSync(join(stateDir, 'spool')) : [];
    if (names.length === 0) break;
    await sleep(1_000);
  }
  await sleep(6_000); // let keep-alive sockets close before counting fds
  const idleEnd = await sampleProcess();
  await sampleStatus();
  clearInterval(poller);
  clearInterval(sampler);
  warming = false;
  probing = false;
  await Promise.all([warm, probe]);

  // ---- assertions
  const final = {};
  for (const r of book.values()) {
    const k = r.final ?? (r.accepted ? `OPEN:${r.last_state}` : r.rejected ? 'rejected' : 'never_accepted');
    final[k] = (final[k] ?? 0) + 1;
  }
  const paper = (key) => printerA.count(key) + printerB.count(key);
  const wrongPrinter = [];
  const dupPaper = [];
  const mismatch = [];
  for (const r of book.values()) {
    const n = paper(r.key);
    const onWrong = (r.printer === 'soak_a' ? printerB : printerA).count(r.key);
    if (onWrong > 0) wrongPrinter.push(r.key);
    if (n > 1) dupPaper.push({ key: r.key, copies: n, state: r.final });
    if (FINAL_PRINTED.has(r.final ?? '') && n !== 1) mismatch.push({ key: r.key, state: r.final, copies: n });
    if (['cancelled', 'cancelled_by_terminal'].includes(r.final ?? '') && n !== 0) mismatch.push({ key: r.key, state: r.final, copies: n });
    if (r.final && r.final.startsWith('gave_up') && n !== 0) mismatch.push({ key: r.key, state: r.final, copies: n });
  }
  const nonFinal = [...book.values()].filter((r) => (r.accepted && !r.final) || (!r.accepted && !r.rejected));
  const res = resourceAnalysis();
  const logSum = bridgeLogSummary();
  const spoolLeft = existsSync(join(stateDir, 'spool')) ? readdirSync(join(stateDir, 'spool')).length : 0;
  const lat = latencies.map((l) => l.ms);
  const unexpectedErrors = Object.entries(logSum.errors).filter(([ev]) => !['queue.failed', 'lan.request.failed_expected'].includes(ev));
  const fatalEvents = Object.keys(logSum.errors).filter((ev) => /unhandled|uncaught|lan\.request\.failed|lan\.spool_unwritable|lan\.start_failed/.test(ev));

  const assertions = [
    ['no duplicate paper: every key appears on paper at most once', dupPaper.length === 0, `${dupPaper.length} violations ${JSON.stringify(dupPaper.slice(0, 5))}`],
    ['printed keys have exactly 1 marker, cancelled/gave-up keys have 0', mismatch.length === 0, `${mismatch.length} mismatches ${JSON.stringify(mismatch.slice(0, 5))}`],
    ['no key printed on the wrong printer', wrongPrinter.length === 0, `${wrongPrinter.length}`],
    ['no lost jobs: every accepted key ended settled or reported', nonFinal.length === 0, `${nonFinal.length} open ${JSON.stringify(nonFinal.slice(0, 5).map((r) => [r.key, r.last_state]))}`],
    ['no slip was refused by the Bridge or abandoned by the terminal before acceptance', counters.rejected === 0 && counters.gave_up_submit === 0, `rejected ${counters.rejected}, gave up ${counters.gave_up_submit}`],
    ['spool directory empty after settle', spoolLeft === 0, `${spoolLeft} file(s) left`],
    ['duplicate re-sends were all deduplicated', counters.dup_violations === 0 && (!opts.chaos || counters.dup_checked > 0), `checked ${counters.dup_checked}, violations ${counters.dup_violations}`],
    [
      'RSS growth under 64 MB over the longest process segment, second-half slope under 3 MB/min',
      res.rss_growth_mb === null || !res.judged || (res.rss_growth_mb < 64 && (res.rss_slope_second_half_mb_per_min === null || res.rss_slope_second_half_mb_per_min < 3)),
      `${res.judged === false ? 'NOT JUDGED (longest uninterrupted Bridge process ran under 8 minutes; the numbers are only reported): ' : ''}early ${res.rss_early_median_mb} -> late ${res.rss_late_median_mb} MB (growth ${res.rss_growth_mb}), peak ${res.rss_peak_mb}, slope ${res.rss_slope_second_half_mb_per_min} MB/min`,
    ],
    [
      'fd count flat (late median within 10 of early median; idle end within 10 of idle start)',
      (res.fds_early_median === null || res.fds_late_median === null || res.fds_late_median - res.fds_early_median <= 10) &&
        (!idleStart?.fds || !idleEnd?.fds || idleEnd.fds - idleStart.fds <= 10),
      `segment early ${res.fds_early_median} -> late ${res.fds_late_median} (peak ${res.fds_peak}); idle start ${idleStart?.fds} -> idle end ${idleEnd?.fds}`,
    ],
    ['Bridge stayed responsive: no /health took 5 s or more while it was up', lat.length > 0 && Math.max(...lat) < 5_000, `n ${lat.length}, p50 ${median(lat)} ms, p99 ${percentile(lat, 0.99)} ms, max ${Math.max(...lat)} ms; Bridge-reported loop lag max ${logSum.lag_max_ms} ms`],
    [
      'a slip killed mid-send comes back unknown, is posted once, and is not on paper twice',
      !opts.chaos || (midsendKey !== null && book.get(midsendKey)?.final === 'unknown' && book.get(midsendKey)?.posts === 1 && paper(midsendKey) <= 1),
      midsendKey === null ? 'event did not run' : `final ${book.get(midsendKey)?.final}, posts ${book.get(midsendKey)?.posts}, copies on paper ${paper(midsendKey)}`,
    ],
    ['no unhandled error, request failure or spool failure in the Bridge log', fatalEvents.length === 0, JSON.stringify(logSum.errors)],
  ];

  console.log('\n================ RESULTS ================');
  for (const [name, ok, detail] of assertions) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  if (assertions.some(([, ok]) => !ok)) exitCode = 1;

  const report = {
    label: 'automated, fake printer, this machine; not a 12-hour soak and not real hardware',
    started_at: new Date(t0).toISOString(),
    duration_s: Math.round(elapsed() / 1000),
    configured_minutes: opts.minutes,
    rate_per_s: opts.rate,
    node: process.version,
    host: { platform: process.platform, lan_ip: lanIp },
    jobs: {
      keys: book.size, final_states: final, counters, resent_after_none_keys: [...book.values()].filter((r) => r.resends > 0).length,
      max_resends_for_a_key: Math.max(0, ...[...book.values()].map((r) => r.resends)),
    },
    printers: {
      A: { connections: printerA.connections, empty_connections: printerA.emptyConnections, markers: printerA.seen.size, bytes: printerA.bytes },
      B: { connections: printerB.connections, empty_connections: printerB.emptyConnections, markers: printerB.seen.size, bytes: printerB.bytes },
    },
    terminal_requests: stats,
    bridge_processes_started: bridge.starts,
    resources: res,
    idle_start: idleStart,
    idle_end: idleEnd,
    responsiveness_ms: { n: lat.length, p50: median(lat), p99: percentile(lat, 0.99), max: lat.length ? Math.max(...lat) : null },
    bridge_log: logSum,
    events,
    assertions: assertions.map(([name, ok, detail]) => ({ name, ok, detail })),
    samples,
    out_dir: outDir,
  };
  const reportPath = opts.report ? resolve(opts.report) : join(outDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${reportPath}\nBridge log: ${bridgeLogPath}`);
  if (unexpectedErrors.length) console.log(`Bridge error events: ${JSON.stringify(logSum.errors)}`);
}

async function cleanup() {
  try {
    if (bridge.pid && bridge.up) process.kill(bridge.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  await printerA.down().catch(() => undefined);
  await printerB.down().catch(() => undefined);
  agent.destroy();
  if (!opts.keep && exitCode === 0 && !opts.out) rmSync(outDir, { recursive: true, force: true });
}

process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(130));
});

main()
  .catch((e) => {
    console.error('soak-lan failed:', e);
    exitCode = 2;
  })
  .finally(async () => {
    await cleanup();
    process.exit(exitCode);
  });
