import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { describe, it } from 'node:test';
import { containerSuspect, sendToPrinter } from './lan.js';

/**
 * The retry-safety classification.
 *
 * `printed_certainty` is the single field the relay uses to decide whether a failed job may be
 * re-queued. Get it wrong in the safe direction and a printer stays silent; get it wrong in the
 * other direction and a customer is handed two receipts. These tests pin the direction.
 */

function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
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
