import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { containerSuspect, localInterfaces, sendToPrinter } from './lan.js';
import { queue } from './queue.js';
import { parseRegistry, resetRegistryCache, saveRegistry } from './registry.js';
import { handlePrint } from './relay.js';

/**
 * The retry-safety classification.
 *
 * `printed_certainty` is the single field the relay uses to decide whether a failed job may be
 * re-queued. Get it wrong in the safe direction and a printer stays silent; get it wrong in the
 * other direction and a customer is handed two receipts. These tests pin the direction.
 */

function listenOnEphemeralPort(host = '127.0.0.1'): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, host, () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      resolve({ server, port: address.port });
    });
  });
}

/** A port nothing listens on, so connect() is refused rather than timing out. */
async function closedPort(): Promise<number> {
  const { server, port } = await listenOnEphemeralPort();
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe('sendToPrinter', () => {
  it('reports success once the bytes are written', async () => {
    const { server, port } = await listenOnEphemeralPort();
    server.on('connection', (socket) => socket.resume());
    try {
      const outcome = await sendToPrinter('127.0.0.1', port, Buffer.from('\x1b@TEST\n'), 2000);
      assert.equal(outcome.ok, true);
    } finally {
      server.close();
    }
  });

  /*
   * The connection was refused, so the printer provably received nothing. This is the ONLY
   * class of failure the relay is allowed to retry automatically.
   */
  it('classifies a refused connection as certainly-not-printed', async () => {
    const port = await closedPort();
    const outcome = await sendToPrinter('127.0.0.1', port, Buffer.from('x'), 1000);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.printed_certainty, 'none');
    assert.equal(outcome.reason, 'connect-refused');
  });

  /*
   * An address that swallows packets never completes the handshake, so again nothing printed.
   * 10.255.255.1 is RFC1918 and (in any sane setup) unrouted, which is what makes it hang
   * rather than refuse.
   */
  it('classifies a connect timeout as certainly-not-printed', async () => {
    const outcome = await sendToPrinter('10.255.255.1', 9100, Buffer.from('x'), 300);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.printed_certainty, 'none');
    assert.ok(
      outcome.reason === 'connect-timeout' || outcome.reason === 'unreachable',
      `expected a pre-connect failure, got ${outcome.reason}`
    );
  });

  /*
   * THE case the type exists for. The socket opened, so the printer may have received and
   * printed some or all of the bytes — RAW/9100 never says. Anything that happens after
   * connect must therefore be 'unknown', and the relay must not retry it.
   */
  it('classifies a stall AFTER connecting as might-have-printed', async () => {
    const { server, port } = await listenOnEphemeralPort();
    // Accept the connection, then never read: the write stalls once the buffer fills.
    server.on('connection', () => {
      /* deliberately no resume() — do not drain */
    });
    try {
      const big = Buffer.alloc(64 * 1024 * 1024, 0x41);
      const outcome = await sendToPrinter('127.0.0.1', port, big, 300);
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.printed_certainty, 'unknown');
      assert.equal(outcome.reason, 'write-timeout');
    } finally {
      server.close();
    }
  });
});

describe('containerSuspect', () => {
  /*
   * Detecting this matters because the symptom lies: printing still works through NAT, but the
   * scan finds nothing and the reported subnets make the POS tell an operator their printer is
   * "on a different network" when it is sitting next to them.
   */
  it('flags a process whose every interface is a Docker bridge', () => {
    assert.equal(
      containerSuspect([{ address: '172.17.0.2', cidr: '172.17.0.2/16' }]),
      true
    );
  });

  it('flags a process with no interfaces at all', () => {
    assert.equal(containerSuspect([]), true);
  });

  it('does not flag a host-networked bridge on a real shop LAN', () => {
    assert.equal(
      containerSuspect([{ address: '192.168.18.116', cidr: '192.168.18.116/24' }]),
      false
    );
  });

  // Host networking on a machine that also runs Docker: the shop interface is present, so
  // this is a normal install and must not be warned about.
  it('does not flag a host that merely has a Docker bridge alongside its LAN', () => {
    assert.equal(
      containerSuspect([
        { address: '192.168.18.116', cidr: '192.168.18.116/24' },
        { address: '172.17.0.1', cidr: '172.17.0.1/16' },
      ]),
      false
    );
  });

  /*
   * The prefix list alone answered `false` here, which is how a production pod spent its life
   * offering its own cluster-internal address as somewhere to point a till. A /32 is the
   * giveaway: it is an address that routes to nothing but itself.
   */
  it('flags a Kubernetes pod, whose address is outside every Docker bridge range', () => {
    assert.equal(containerSuspect([{ address: '10.42.4.121', cidr: '10.42.4.121/32' }]), true);
  });

  it('flags a /31 point-to-point interface', () => {
    assert.equal(containerSuspect([{ address: '10.88.0.7', cidr: '10.88.0.7/31' }]), true);
  });

  // The shape test must not swallow the real case it sits next to: a shop LAN in the same
  // 10/8 space is an ordinary network, and only the mask tells the two apart.
  it('does not flag a shop LAN that happens to use 10.x', () => {
    assert.equal(containerSuspect([{ address: '10.0.1.24', cidr: '10.0.1.24/24' }]), false);
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(ready: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * A cloud print job for a printer the operator turned off in the POS.
 *
 * The POS promises "Printer turned off — nothing will print here", and the LAN routes have always
 * honoured it. The relay did not: a `printer_id` naming a turned-off entry went straight to it, and
 * a `target_ip` that only a turned-off entry claimed came back from the registry as "no match",
 * which the ad-hoc fallback read as "nobody registered this" and dialled.
 *
 * These drive `handlePrint` itself with the result POST stubbed. The refusals need no network at
 * all; the ones with a live listener are skipped on a machine with no private LAN interface, since
 * the bridge only ever dials RFC1918 space.
 */
describe('a cloud job for a printer the operator turned off', () => {
  const BASE = 'http://relay.test';
  const TOKEN = 'test-token';
  const BILL = '\x1b@BILL\n';
  const ENV_KEYS = ['PRINT_BRIDGE_STATE_DIR', 'PRINT_BRIDGE_SEND_TIMEOUT_MS', 'PRINT_BRIDGE_MAX_ATTEMPTS'] as const;

  type PrintWork = Parameters<typeof handlePrint>[2];
  const originalEnv = new Map<string, string | undefined>();
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let stateDir = '';
  let fetchStub: { mock: { restore(): void } };
  let jobs = 0;

  before(() => {
    for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
    stateDir = mkdtempSync(join(tmpdir(), 'hankha-relay-'));
    process.env.PRINT_BRIDGE_STATE_DIR = stateDir;
    // Caps the damage if a regression DOES dial: one attempt of one second, so a job aimed at an
    // unroutable address settles before the file ends instead of retrying for the queue's default.
    process.env.PRINT_BRIDGE_SEND_TIMEOUT_MS = '1000';
    process.env.PRINT_BRIDGE_MAX_ATTEMPTS = '1';
    resetRegistryCache();

    // Stubbed for the whole block rather than per test. A job that is wrongly submitted settles
    // AFTER the test that made it, and its report must not go anywhere real.
    fetchStub = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(null, { status: 200 });
    });
  });

  beforeEach(() => {
    posts.length = 0;
  });

  after(() => {
    fetchStub.mock.restore();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRegistryCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function relayJob(over: Partial<PrintWork['job']> = {}): PrintWork {
    jobs += 1;
    return {
      type: 'print',
      job: {
        job_id: `relay-job-${jobs}`,
        client_job_id: `client-${jobs}`,
        kind: 'RECEIPT',
        target_ip: null,
        target_port: 9100,
        payload_base64: Buffer.from(BILL).toString('base64'),
        payload_sha256: '0'.repeat(64),
        attempt: 1,
        // Absent, so no `ttl_s`: a job that IS dialled fails once and stops.
        claim_expires_at: '',
        ...over,
      },
    };
  }

  /** Write `printers.json` the way a real one reaches the bridge: parsed, so defaults are filled in. */
  function register(printers: Record<string, unknown>[]): void {
    const { registry, errors } = parseRegistry({ printers });
    assert.deepEqual(errors, []);
    saveRegistry(registry);
  }

  /** A TCP listener standing in for a printer, on this machine's LAN address. */
  async function fakePrinter(host: string) {
    const received: Buffer[] = [];
    let connections = 0;
    const { server, port } = await listenOnEphemeralPort(host);
    server.on('connection', (socket) => {
      connections += 1;
      socket.on('data', (chunk) => received.push(chunk));
    });
    return {
      port,
      bytes: () => Buffer.concat(received).toString('latin1'),
      connections: () => connections,
      close: () => server.close(),
    };
  }

  const resultUrl = (work: PrintWork) => `${BASE}/api/v1/modules/print/bridge/jobs/${work.job.job_id}/result`;
  /**
   * The reports made for THIS job. Filtered by URL because a job a broken build wrongly queued
   * settles during a later test, and its report must neither stand in for that test's own nor
   * fail it.
   */
  const reportsFor = (work: PrintWork) => posts.filter((p) => p.url === resultUrl(work));

  /** The refusal the server must be told about: retryable, because nothing reached any printer. */
  async function assertRefused(work: PrintWork, detail: string | RegExp): Promise<void> {
    await handlePrint(BASE, TOKEN, work);
    const reports = reportsFor(work);
    assert.equal(reports.length, 1, 'exactly one result must be reported for this job');
    const body = reports[0]?.body ?? {};
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'device-missing');
    assert.equal(body.printed_certainty, 'none');
    if (typeof detail === 'string') assert.equal(body.detail, detail);
    else assert.match(String(body.detail), detail);
    // Submitted jobs are registered synchronously, so this proves the job never reached the queue —
    // and a job that is not in the queue cannot have been sent to any printer.
    assert.equal(queue().get(work.job.job_id), null, 'the job was queued for a printer that is turned off');
  }

  const retired = { id: 'retired', name: 'Retired', transport: 'network', address: '192.168.255.251', enabled: false };

  it('is refused when a printer_id names the turned-off printer', async () => {
    register([retired]);
    await assertRefused(relayJob({ printer_id: 'retired' }), "printer 'retired' is disabled on this bridge");
  });

  it('is refused when the address is one only the turned-off printer claims', async () => {
    register([retired]);
    await assertRefused(
      relayJob({ target_ip: '192.168.255.251', target_port: 9100 }),
      "printer 'retired' at 192.168.255.251:9100 is disabled on this bridge",
    );
  });

  // The strongest form of the address case: something is actually listening there, so a bridge that
  // fell through to the ad-hoc dial would print — and the test would see the connection.
  it('never connects to a turned-off printer that is live at that address', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const printer = await fakePrinter(lan.address);
    try {
      register([{ id: 'retired', name: 'Retired', transport: 'network', address: lan.address, port: printer.port, enabled: false }]);
      await assertRefused(
        relayJob({ target_ip: lan.address, target_port: printer.port }),
        `printer 'retired' at ${lan.address}:${printer.port} is disabled on this bridge`,
      );
      // A negative can only be shown by waiting; the queue check above is the deterministic half.
      await sleep(100);
      assert.equal(printer.connections(), 0, 'the bridge dialled a printer that was turned off');
    } finally {
      printer.close();
    }
  });

  it('still prints to an address no registry entry claims', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const printer = await fakePrinter(lan.address);
    try {
      // An unrelated turned-off entry must not get in the way of an address it does not claim.
      register([retired]);
      const work = relayJob({ target_ip: lan.address, target_port: printer.port });
      await handlePrint(BASE, TOKEN, work);
      await until(() => reportsFor(work).length === 1, 'the result report');
      assert.equal(reportsFor(work)[0]?.body.ok, true);
      await until(() => printer.bytes() === BILL, 'the bytes to reach the printer');
    } finally {
      printer.close();
    }
  });

  it('still prints to an enabled registry printer, named by id or by address', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const printer = await fakePrinter(lan.address);
    try {
      register([{ id: 'till', name: 'Till', transport: 'network', address: lan.address, port: printer.port }]);
      const byId = relayJob({ printer_id: 'till' });
      const byAddress = relayJob({ target_ip: lan.address, target_port: printer.port });
      await handlePrint(BASE, TOKEN, byId);
      await handlePrint(BASE, TOKEN, byAddress);
      await until(() => reportsFor(byId).length === 1 && reportsFor(byAddress).length === 1, 'both result reports');
      assert.deepEqual([reportsFor(byId)[0]?.body.ok, reportsFor(byAddress)[0]?.body.ok], [true, true]);
      await until(() => printer.bytes() === BILL + BILL, 'both slips to reach the printer');
    } finally {
      printer.close();
    }
  });
});
