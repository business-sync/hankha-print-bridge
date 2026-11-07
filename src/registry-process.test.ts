import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostsForInterfaces, localInterfaces, sweep } from './lan.js';
import { EscposFakePrinter } from './test-support/escpos-printer.js';
import { jobBody, mintTicket, TestTerminal } from './test-support/lan-harness.js';
import { LanIpPrinter, privateLanIp } from './test-support/lan-ip-printer.js';

/*
 * Discovery and connection management, through a REAL Bridge process and its REAL HTTP API on the
 * main port (the registry, scan, probe), with fake printers on this machine's private LAN address
 * (the Bridge dials RFC 1918 space only) and LAN jobs signed the way a terminal signs them.
 *
 * What this cannot show: a real printer, a second machine, a real router.
 */

const LAN_IP = privateLanIp();
const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const skip = LAN_IP ? false : 'this machine has no private IPv4 address';
const children: ChildProcess[] = [];
const dirs: string[] = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const free = (host: string) =>
  new Promise<number>((resolve) => {
    const s = netServer();
    s.listen(0, host, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const backend = generateKeyPairSync('ed25519');
const b64u = (b: Buffer) => b.toString('base64url');
const ack = generateKeyPairSync('ed25519');
const ackPub = b64u(ack.publicKey.export({ type: 'spki', format: 'der' }) as Buffer);

interface Rig {
  dir: string;
  main: string;
  lan: string;
  terminal: TestTerminal;
  output: () => string;
  put(printers: unknown[]): Promise<{ status: number; json: any }>;
  post(path: string, body?: unknown): Promise<{ status: number; json: any }>;
  get(path: string): Promise<{ status: number; json: any }>;
  status(key: string): Promise<any>;
  submit(key: string, printerId: string, marker?: string, extra?: Record<string, unknown>): Promise<{ status: number; json: any }>;
  until(key: string, states: string[], ms?: number): Promise<any>;
}

async function startRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-regproc-'));
  dirs.push(dir);
  const mainPort = await free('127.0.0.1');
  const lanPort = await free('127.0.0.1');
  writeFileSync(join(dir, 'lan.json'), JSON.stringify({ enabled: true, port: lanPort, host: '127.0.0.1' }));
  writeFileSync(
    join(dir, 'lan-key.json'),
    JSON.stringify({ v: 1, created_at: new Date().toISOString(), private_key: b64u(ack.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer), public_key: ackPub }),
    { mode: 0o600 }
  );
  writeFileSync(
    join(dir, 'lan-keys.json'),
    JSON.stringify({ v: 1, keys: [{ kid: 'test-backend-1', pubkey: b64u(backend.publicKey.export({ type: 'spki', format: 'der' }) as Buffer), not_before: 0, not_after: null }] })
  );
  writeFileSync(join(dir, 'relay.json'), JSON.stringify({ install_id: 'install-regproc-0001', bridge_id: '77' }));
  writeFileSync(join(dir, 'printers.json'), JSON.stringify({ version: 1, printers: [] }));
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: {
      ...process.env, PRINT_BRIDGE_PORT: String(mainPort), PRINT_BRIDGE_HOST: '127.0.0.1', PRINT_BRIDGE_STATE_DIR: dir,
      PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9', PRINT_BRIDGE_LOG_FORMAT: 'text', PRINT_BRIDGE_LOG_LEVEL: 'info',
      // A probe is an extra connection to the fake printer; these tests count connections.
      PRINT_BRIDGE_KEEPWARM_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  const main = `http://127.0.0.1:${mainPort}`;
  const lan = `http://127.0.0.1:${lanPort}`;
  await until(async () => {
    try {
      return (await fetch(`${main}/health`)).ok && (await fetch(`${lan}/lan/v1/hello`)).ok;
    } catch {
      return false;
    }
  }, 'the bridge and its LAN listener');

  const terminal = new TestTerminal(() => lan);
  terminal.ticket = mintTicket(backend.privateKey, { bridge_pubkey: ackPub, terminal_pubkey: terminal.spki, bridge_id: '77' });
  const json = async (r: Response) => ({ status: r.status, json: await r.json().catch(() => null) });
  const rig: Rig = {
    dir, main, lan, terminal, output: () => output,
    put: async (printers) => json(await fetch(`${main}/printers`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, printers }) })),
    post: async (path, body) => json(await fetch(`${main}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })),
    get: async (path) => json(await fetch(`${main}${path}`)),
    status: async (key) => (await terminal.call('POST', '/lan/v1/jobs/status', { keys: [key] })).json.jobs[0],
    submit: async (key, printerId, marker = `MARK-${key}`, extra = {}) => {
      const r = await terminal.call('POST', '/lan/v1/jobs', jobBody(key, marker, { printer_id: printerId, ...extra }));
      return { status: r.status, json: r.json };
    },
    until: async (key, states, ms = 30_000) => {
      let last: any;
      await until(async () => {
        last = await rig.status(key);
        return states.includes(last.state);
      }, `${key} to reach ${states.join('/')} (last: ${JSON.stringify(last)})`, ms);
      return last;
    },
  };
  return rig;
}

const entry = (id: string, port: number, o: Record<string, unknown> = {}) => ({
  id, name: id, transport: 'network', type: 'receipt', language: 'escpos', enabled: true, role: 'receipt',
  address: LAN_IP, port, dots_per_line: 576, ...o,
});

describe('discovery and connection management through the real HTTP API', { skip }, () => {
  let rig: Rig;
  before(async () => {
    rig = await startRig();
  });

  it('probe: reports a listening fake printer reachable, and unreachable once it is switched off', async () => {
    const p = await new LanIpPrinter(LAN_IP as string).start(0);
    const up = await rig.post('/probe', { ip: LAN_IP, port: p.port });
    assert.equal(up.status, 200);
    assert.equal(up.json.reachable, true);
    await p.down();
    const down = await rig.post('/probe', { ip: LAN_IP, port: p.port });
    assert.equal(down.json.reachable, false);
    // The Bridge refuses to dial anything that is not private space.
    assert.equal((await rig.post('/probe', { ip: '8.8.8.8', port: 9100 })).status, 400);
    assert.equal((await rig.post('/probe', { ip: '127.0.0.1', port: p.port })).status, 400);
  });

  it('scan: the real route sweeps this machine\'s /24 and returns the documented shape; the machine\'s own address is never swept', async () => {
    const p = await new LanIpPrinter(LAN_IP as string).start(0);
    try {
      const scan = await rig.post('/scan', { port: p.port });
      assert.equal(scan.status, 200);
      assert.equal(scan.json.ok, true);
      assert.ok(Array.isArray(scan.json.subnets) && scan.json.subnets.some((s: string) => s.endsWith('/24')), JSON.stringify(scan.json.subnets));
      assert.ok(Array.isArray(scan.json.printers));
      // By design `hostsForInterfaces` skips this machine's own addresses, so a fake printer on the
      // Bridge's own address is not among the results. (A real printer is a different machine.)
      assert.ok(!scan.json.printers.some((f: { ip: string; port: number }) => f.ip === LAN_IP && f.port === p.port));
      const plan = hostsForInterfaces(localInterfaces());
      assert.ok(!plan.hosts.includes(LAN_IP as string));
      assert.ok(plan.hosts.length >= 100, `${plan.hosts.length} hosts`);
      // The detection itself, which the HTTP route reaches through `sweep`: pointed at the fake's address it finds it.
      const found = await sweep([LAN_IP as string], p.port, { concurrency: 4, timeoutMs: 500 });
      assert.deepEqual(found.map((f) => `${f.ip}:${f.port}`), [`${LAN_IP}:${p.port}`]);
      // And /discover returns the same sweep inside its combined answer.
      const disc = await rig.post('/discover', { port: p.port });
      assert.equal(disc.status, 200);
      assert.ok(Array.isArray(disc.json.transports) && disc.json.transports.some((t: { kind: string }) => t.kind === 'network'));
      assert.ok(Array.isArray(disc.json.printers));
    } finally {
      await p.down();
    }
  });

  it('registry: PUT then GET round-trips, validates, and a bad registry changes nothing', async () => {
    const a = await new LanIpPrinter(LAN_IP as string).start(0);
    try {
      const put = await rig.put([entry('reg_a', a.port)]);
      assert.equal(put.status, 200, JSON.stringify(put.json));
      const get = await rig.get('/printers');
      assert.deepEqual(get.json.printers.map((x: { id: string }) => x.id), ['reg_a']);
      const bad = await rig.put([entry('reg_a', a.port), entry('reg_bad', a.port, { address: '8.8.8.8' }), entry('Bad Id!', a.port)]);
      assert.equal(bad.status, 400);
      assert.equal(bad.json.reason, 'invalid-registry');
      assert.ok(bad.json.errors.length >= 2, 'every problem is reported at once');
      assert.deepEqual((await rig.get('/printers')).json.printers.map((x: { id: string }) => x.id), ['reg_a'], 'unchanged');
      assert.equal((await rig.put([entry('reg_a', a.port, { status_readback: 'yes' })])).status, 400, 'only the boolean true turns readback on');
    } finally {
      await a.down();
    }
  });

  it('status readback toggles live: on gives confirmed, off gives bytes_written and no status connection, and the printer list says which', async () => {
    const p = await new EscposFakePrinter().start(0, LAN_IP as string);
    try {
      assert.equal((await rig.put([entry('rb', p.port, { status_readback: true })])).status, 200);
      const list1 = await rig.terminal.call('GET', '/lan/v1/printers');
      assert.equal(list1.json.printers.find((x: { id: string }) => x.id === 'rb').status_readback, 'on');
      assert.equal((await rig.submit('rb-job-on-0001', 'rb')).status, 202);
      const on = await rig.until('rb-job-on-0001', ['confirmed', 'bytes_written', 'unknown', 'failed']);
      assert.equal(on.state, 'confirmed', JSON.stringify(on));
      assert.equal(on.certainty, 'unknown', 'confirmed still forbids a resend');
      assert.ok(p.statusConnections >= 1);
      const statusBefore = p.statusConnections;

      assert.equal((await rig.put([entry('rb', p.port, { status_readback: false })])).status, 200);
      const list2 = await rig.terminal.call('GET', '/lan/v1/printers');
      assert.equal(list2.json.printers.find((x: { id: string }) => x.id === 'rb').status_readback, 'off');
      assert.equal((await rig.submit('rb-job-off-0001', 'rb')).status, 202);
      const off = await rig.until('rb-job-off-0001', ['confirmed', 'bytes_written', 'unknown', 'failed']);
      assert.equal(off.state, 'bytes_written', JSON.stringify(off));
      assert.equal(p.statusConnections, statusBefore, 'no status connection once it is off');
      assert.equal(p.printConnections, 2);

      // A printer that stops answering suspends itself after three silent reads; saving the registry re-arms it.
      assert.equal((await rig.put([entry('rb', p.port, { status_readback: true })])).status, 200);
      p.mode = 'silent';
      for (let i = 0; i < 3; i += 1) {
        await rig.submit(`rb-job-silent-${i}`.padEnd(20, '0'), 'rb');
        await rig.until(`rb-job-silent-${i}`.padEnd(20, '0'), ['bytes_written', 'confirmed', 'unknown', 'failed'], 20_000);
      }
      const list3 = await rig.terminal.call('GET', '/lan/v1/printers');
      assert.equal(list3.json.printers.find((x: { id: string }) => x.id === 'rb').status_readback, 'suspended');
      assert.equal((await rig.put([entry('rb', p.port, { status_readback: true })])).status, 200);
      const list4 = await rig.terminal.call('GET', '/lan/v1/printers');
      assert.equal(list4.json.printers.find((x: { id: string }) => x.id === 'rb').status_readback, 'on', 'saving the registry re-arms it');
    } finally {
      await p.close();
    }
  });

  it('disable and enable: new jobs are refused with 422 printer_disabled; a queued job fails with certainty none; enabling accepts the same key again and it prints once', async () => {
    const p = await new LanIpPrinter(LAN_IP as string).start(0);
    const port = p.port;
    try {
      assert.equal((await rig.put([entry('dis', port)])).status, 200);
      await p.down(); // the printer is off, so the next job waits in the queue
      assert.equal((await rig.submit('dis-job-queued-01', 'dis')).status, 202);
      await sleep(300);
      assert.equal((await rig.status('dis-job-queued-01')).state, 'queued');

      assert.equal((await rig.put([entry('dis', port, { enabled: false })])).status, 200);
      const listed = await rig.terminal.call('GET', '/lan/v1/printers');
      assert.equal(listed.json.printers.find((x: { id: string }) => x.id === 'dis').enabled, false, 'disabled printers are listed as disabled');
      const refused = await rig.submit('dis-job-new-0001', 'dis');
      assert.equal(refused.status, 422);
      assert.equal(refused.json.reason, 'printer_disabled');
      // The job that was already waiting is failed on its next attempt: nothing reached the printer.
      const failed = await rig.until('dis-job-queued-01', ['failed', 'unknown', 'bytes_written', 'confirmed'], 20_000);
      assert.equal(failed.state, 'failed', JSON.stringify(failed));
      assert.equal(failed.certainty, 'none');

      await p.start(port);
      assert.equal((await rig.put([entry('dis', port, { enabled: true })])).status, 200);
      const again = await rig.submit('dis-job-queued-01', 'dis', 'MARK-dis-queued');
      assert.equal(again.status, 202, JSON.stringify(again.json));
      await rig.until('dis-job-queued-01', ['bytes_written']);
      await p.quiet();
      assert.equal(p.count('MARK-dis-queued'), 1, 'printed exactly once');
      assert.equal(p.count('MARK-dis-job-queued'), 0);
    } finally {
      await p.down();
    }
  });

  it('re-pointing a printer\'s address moves its queued jobs to the new address', { timeout: 60_000 }, async () => {
    const oldPrinter = new LanIpPrinter(LAN_IP as string);
    await oldPrinter.start(0);
    const oldPort = oldPrinter.port;
    await oldPrinter.down(); // nothing answers at the old address any more
    const newPrinter = await new LanIpPrinter(LAN_IP as string).start(0);
    try {
      assert.equal((await rig.put([entry('moved', oldPort)])).status, 200);
      assert.equal((await rig.submit('moved-job-0001', 'moved', 'MARK-moved-1')).status, 202);
      assert.equal((await rig.submit('moved-job-0002', 'moved', 'MARK-moved-2')).status, 202);
      await sleep(500);
      assert.equal((await rig.status('moved-job-0001')).state, 'queued', 'waiting on the dead address');
      assert.equal(newPrinter.connections, 0);

      assert.equal((await rig.put([entry('moved', newPrinter.port)])).status, 200); // the operator re-points it
      await rig.until('moved-job-0001', ['bytes_written'], 40_000);
      await rig.until('moved-job-0002', ['bytes_written'], 40_000);
      await newPrinter.quiet();
      assert.equal(newPrinter.count('MARK-moved-1'), 1);
      assert.equal(newPrinter.count('MARK-moved-2'), 1);
      assert.deepEqual(newPrinter.order(['MARK-moved-1', 'MARK-moved-2']), ['MARK-moved-1', 'MARK-moved-2'], 'still FIFO');
      // The same key sent again is the same job, not a second slip.
      const dup = await rig.submit('moved-job-0001', 'moved', 'MARK-moved-1');
      assert.equal(dup.json.deduplicated, true);
      await newPrinter.quiet();
      assert.equal(newPrinter.count('MARK-moved-1'), 1);
    } finally {
      await newPrinter.down();
    }
  });

  it('two registry ids at one address share one lane: while the first slip is on the wire the second does not connect, and order is kept', { timeout: 90_000 }, async () => {
    const p = new LanIpPrinter(LAN_IP as string);
    p.stall = true; // accepts the first connection and reads nothing, so the big slip stays "on the wire"
    await p.start(0);
    try {
      assert.equal((await rig.put([entry('lane_x1', p.port), entry('lane_x2', p.port, { role: 'kitchen' })])).status, 200);
      // A slip big enough to fill the socket buffers (the document cap is 2,000 elements; each is a long line; the rendered slip must stay under the Bridge's 4 MiB cap).
      const big = {
        kind: 'receipt',
        elements: [{ type: 'text', value: 'MARK-lane-first' }, ...Array.from({ length: 1_300 }, (_, i) => ({ type: 'text', value: `${i} ${'x'.repeat(2_800)}` }))],
      };
      const first = await rig.terminal.call('POST', '/lan/v1/jobs', jobBody('lane-job-first-1', 'x', { printer_id: 'lane_x1', document: big, expires_in_s: 600 }));
      assert.equal(first.status, 202, first.text.slice(0, 300));
      await until(() => p.connections === 1, 'the first connection');
      await sleep(400);
      assert.equal((await rig.submit('lane-job-second-1', 'lane_x2', 'MARK-lane-second')).status, 202);
      await sleep(1_500);
      assert.equal(p.connections, 1, 'the second id waits for the first one\'s lane');
      assert.equal((await rig.status('lane-job-first-1')).state, 'sending');
      assert.equal((await rig.status('lane-job-second-1')).state, 'queued');

      p.release();
      await rig.until('lane-job-first-1', ['bytes_written'], 60_000);
      await rig.until('lane-job-second-1', ['bytes_written'], 30_000);
      await p.quiet();
      assert.equal(p.maxOpen, 1, 'never two connections open at once');
      assert.equal(p.count('MARK-lane-first'), 1);
      assert.equal(p.count('MARK-lane-second'), 1);
      assert.deepEqual(p.order(['MARK-lane-first', 'MARK-lane-second']), ['MARK-lane-first', 'MARK-lane-second']);
    } finally {
      p.release();
      await p.down();
    }
  });

  it('two ids at DIFFERENT addresses do not wait for each other', { timeout: 90_000 }, async () => {
    const stuck = new LanIpPrinter(LAN_IP as string);
    stuck.stall = true;
    await stuck.start(0);
    const free1 = await new LanIpPrinter(LAN_IP as string).start(0);
    try {
      assert.equal((await rig.put([entry('own_s', stuck.port), entry('own_f', free1.port, { role: 'kitchen' })])).status, 200);
      const big = { kind: 'receipt', elements: Array.from({ length: 1_300 }, (_, i) => ({ type: 'text', value: `${i} ${'y'.repeat(2_800)}` })) };
      assert.equal((await rig.terminal.call('POST', '/lan/v1/jobs', jobBody('own-job-stuck-01', 'x', { printer_id: 'own_s', document: big, expires_in_s: 600 }))).status, 202);
      await until(() => stuck.connections === 1, 'the stuck printer to be connected');
      assert.equal((await rig.submit('own-job-free-001', 'own_f', 'MARK-own-free')).status, 202);
      await rig.until('own-job-free-001', ['bytes_written'], 15_000);
      assert.equal(free1.count('MARK-own-free'), 1);
    } finally {
      stuck.release();
      await stuck.down();
      await free1.down();
    }
  });

  it('the LAN printer list reflects reachability and the registry, and carries no address', async () => {
    const p = await new LanIpPrinter(LAN_IP as string).start(0);
    try {
      assert.equal((await rig.put([entry('listed', p.port)])).status, 200);
      const r = await rig.terminal.call('GET', '/lan/v1/printers');
      const one = r.json.printers.find((x: { id: string }) => x.id === 'listed');
      assert.deepEqual(Object.keys(one).sort(), ['dots_per_line', 'enabled', 'id', 'last_ok_at', 'name', 'reachable', 'role', 'status_readback', 'type']);
      assert.ok(!JSON.stringify(r.json).includes(LAN_IP as string), 'no address leaves the Bridge');
    } finally {
      await p.down();
    }
  });
});
