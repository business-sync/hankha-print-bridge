import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  formatIpv4,
  hostsForInterfaces,
  isLinkLocalIpv4,
  isPrivateIpv4,
  parseIpv4,
  sweep,
  tcpPing,
} from './lan.js';

/** A stand-in for a thermal printer: accepts a TCP connection and says nothing. */
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

describe('parseIpv4 / formatIpv4', () => {
  it('round-trips a dotted quad', () => {
    const value = parseIpv4('192.168.18.103');
    assert.equal(value, 192 * 2 ** 24 + 168 * 2 ** 16 + 18 * 2 ** 8 + 103);
    assert.equal(formatIpv4(value as number), '192.168.18.103');
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', 'localhost', '1.2.3.-1']) {
      assert.equal(parseIpv4(bad), null, `expected ${bad} to be rejected`);
    }
  });

  it('handles the high bit without sign errors', () => {
    // 192.x.x.x sets the top byte above 127, where a signed shift would wrap negative.
    assert.equal(formatIpv4(parseIpv4('255.255.255.255') as number), '255.255.255.255');
  });
});

describe('isPrivateIpv4', () => {
  it('accepts RFC1918 space', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.18.103']) {
      assert.equal(isPrivateIpv4(ip), true, ip);
    }
  });

  it('rejects public and near-miss addresses', () => {
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '193.168.0.1', 'nope']) {
      assert.equal(isPrivateIpv4(ip), false, ip);
    }
  });

  it('treats link-local as private-but-not-scannable', () => {
    assert.equal(isLinkLocalIpv4('169.254.1.1'), true);
    assert.equal(isLinkLocalIpv4('192.168.1.1'), false);
  });
});

describe('hostsForInterfaces', () => {
  it('clamps to a /24 and skips the machine itself', () => {
    const plan = hostsForInterfaces([{ address: '192.168.18.116', cidr: '192.168.18.116/16' }]);
    assert.deepEqual(plan.subnets, ['192.168.18.0/24']);
    // 254 usable hosts, minus our own address.
    assert.equal(plan.hosts.length, 253);
    assert.ok(!plan.hosts.includes('192.168.18.116'));
    assert.ok(!plan.hosts.includes('192.168.18.0'));
    assert.ok(!plan.hosts.includes('192.168.18.255'));
    assert.ok(plan.hosts.includes('192.168.18.103'));
  });

  it('dedupes interfaces that share a subnet', () => {
    const plan = hostsForInterfaces([
      { address: '192.168.18.116', cidr: '192.168.18.116/24' },
      { address: '192.168.18.117', cidr: '192.168.18.117/24' },
    ]);
    assert.deepEqual(plan.subnets, ['192.168.18.0/24']);
    assert.ok(!plan.hosts.includes('192.168.18.116'));
    assert.ok(!plan.hosts.includes('192.168.18.117'));
  });

  it('sweeps each distinct subnet on a multi-homed host', () => {
    const plan = hostsForInterfaces([
      { address: '192.168.18.116', cidr: '192.168.18.116/24' },
      { address: '10.0.0.5', cidr: '10.0.0.5/24' },
    ]);
    assert.deepEqual(plan.subnets, ['192.168.18.0/24', '10.0.0.0/24']);
  });

  it('honours the host cap', () => {
    const plan = hostsForInterfaces([{ address: '192.168.18.116', cidr: '192.168.18.116/24' }], 10);
    assert.equal(plan.hosts.length, 10);
  });
});

describe('tcpPing', () => {
  let server: Server;
  let openPort: number;

  before(async () => {
    const started = await listenOnEphemeralPort();
    server = started.server;
    openPort = started.port;
  });

  after(() => {
    server.close();
  });

  it('reports a listening port as reachable, with a latency', async () => {
    const result = await tcpPing('127.0.0.1', openPort, 1000);
    assert.equal(result.reachable, true);
    assert.equal(result.reason, undefined);
    assert.ok(typeof result.latency_ms === 'number' && result.latency_ms >= 0);
  });

  it('distinguishes a closed port (refused) from a dead host', async () => {
    // Reuse a port we know nothing listens on: close the fake printer's sibling first.
    const { server: temp, port: closedPort } = await listenOnEphemeralPort();
    await new Promise<void>((resolve) => temp.close(() => resolve()));

    const result = await tcpPing('127.0.0.1', closedPort, 1000);
    assert.equal(result.reachable, false);
    assert.equal(result.reason, 'refused');
  });

  it('gives up on an unrouted address rather than hanging', async () => {
    // 10.255.255.1 is private space that is almost never routed. Whether the kernel reports
    // "unreachable" or the socket simply times out depends on the network, so assert only the
    // part that matters: it settles quickly and is not reachable.
    const startedAt = performance.now();
    const result = await tcpPing('10.255.255.1', 9100, 300);
    assert.equal(result.reachable, false);
    assert.ok(result.reason);
    assert.ok(performance.now() - startedAt < 2000, 'should respect the timeout');
  });
});

describe('sweep', () => {
  it('finds the listening host among dead ones and leaves the rest out', async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      const found = await sweep(['127.0.0.1', '10.255.255.1', '10.255.255.2'], port, {
        concurrency: 8,
        timeoutMs: 300,
      });
      assert.deepEqual(
        found.map((f) => f.ip),
        ['127.0.0.1']
      );
      assert.equal(found[0]?.port, port);
    } finally {
      server.close();
    }
  });

  it('returns nothing for an empty host list without hanging', async () => {
    assert.deepEqual(await sweep([], 9100, { concurrency: 8, timeoutMs: 100 }), []);
  });
});
