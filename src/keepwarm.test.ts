import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/*
 * The keep-warm probe is what stops a sleepy printer from losing the first ticket after a quiet
 * spell. These pin which printers it touches, that it stays off a busy lane, and that it says
 * so — once — when a printer drops off the network and comes back.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-keepwarm-'));
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const { setLogSink } = await import('./log.js');
const { keepWarmMs, startKeepWarm } = await import('./keepwarm.js');
type Rec = import('./log.js').LogRecord;
type Printer = import('./registry.js').PrinterRecord;
type Probe = import('./transports/transport.js').ProbeResult;

const printer = (id: string, extra: Partial<Printer> = {}): Printer => ({
  id, name: id, transport: 'network', type: 'receipt', language: 'escpos', enabled: true,
  address: '192.168.1.50', port: 9100, ...extra,
});

function capture(): { records: Rec[]; restore: () => void } {
  const records: Rec[] = [];
  const restore = setLogSink((r) => records.push(r));
  return { records, restore };
}

describe('configuration', () => {
  it('defaults to a minute, 0 turns it off, and never probes faster than every 5 s', () => {
    assert.equal(keepWarmMs({}), 60_000);
    assert.equal(keepWarmMs({ PRINT_BRIDGE_KEEPWARM_MS: '0' }), 0);
    assert.equal(keepWarmMs({ PRINT_BRIDGE_KEEPWARM_MS: '30000' }), 30_000);
    assert.equal(keepWarmMs({ PRINT_BRIDGE_KEEPWARM_MS: '100' }), 5_000);
    assert.equal(keepWarmMs({ PRINT_BRIDGE_KEEPWARM_MS: 'nonsense' }), 60_000);
  });
});

describe('a pass', () => {
  it('probes enabled network printers only, and skips one whose lane is busy', async () => {
    const probed: string[] = [];
    const warm = startKeepWarm({
      intervalMs: 0,
      printers: () => [
        printer('bill'),
        printer('kitchen'),
        printer('off', { enabled: false }),
        printer('usb', { transport: 'usb', address: undefined, queue: 'EPSON' }),
        printer('blank', { address: undefined }),
      ],
      isBusy: (id) => id === 'kitchen',
      probe: async (p) => {
        probed.push(p.id);
        return { reachable: true, latency_ms: 2 };
      },
    });
    const results = await warm.pass();
    warm.stop();
    assert.deepEqual(probed, ['bill']);
    assert.deepEqual(
      results.map((r) => [r.printer_id, r.reachable]),
      [['bill', true], ['kitchen', null]]
    );
  });

  it('logs a printer going away and coming back once each, not every pass', async () => {
    let answer: Probe = { reachable: false, latency_ms: null, detail: 'timeout' };
    const warm = startKeepWarm({
      intervalMs: 0,
      printers: () => [printer('pizza')],
      isBusy: () => false,
      probe: async () => answer,
    });
    const { records, restore } = capture();
    try {
      await warm.pass();
      await warm.pass();
      answer = { reachable: true, latency_ms: 3 };
      await warm.pass();
      await warm.pass();
    } finally {
      restore();
      warm.stop();
    }
    const events = records.map((r) => r.event).filter((e) => e?.startsWith('printer.') && e !== 'printer.keepwarm');
    assert.deepEqual(events, ['printer.unreachable', 'printer.reachable']);
    const down = records.find((r) => r.event === 'printer.unreachable');
    assert.equal(down?.level, 'warn');
    assert.equal(down?.fields.printer_id, 'pizza');
  });

  it('notes a printer that was slow to answer, gated', async () => {
    const warm = startKeepWarm({
      intervalMs: 0,
      printers: () => [printer('kitchen')],
      isBusy: () => false,
      probe: async () => ({ reachable: true, latency_ms: 3020 }),
    });
    const { records, restore } = capture();
    try {
      await warm.pass();
      await warm.pass();
    } finally {
      restore();
      warm.stop();
    }
    const slow = records.filter((r) => r.event === 'printer.slow');
    assert.equal(slow.length, 1);
    assert.equal(slow[0]?.fields.latency_ms, 3020);
  });

  it('never runs two passes at once', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const warm = startKeepWarm({
      intervalMs: 0,
      printers: () => [printer('bill')],
      isBusy: () => false,
      probe: async () => {
        calls += 1;
        await new Promise<void>((r) => (release = r));
        return { reachable: true, latency_ms: 1 };
      },
    });
    const a = warm.pass();
    const b = warm.pass();
    release();
    await Promise.all([a, b]);
    warm.stop();
    assert.equal(calls, 1);
  });

  it('runs on its interval', async () => {
    let calls = 0;
    const warm = startKeepWarm({
      intervalMs: 40,
      printers: () => [printer('bill')],
      isBusy: () => false,
      probe: async () => {
        calls += 1;
        return { reachable: true, latency_ms: 1 };
      },
    });
    // unref'd, so keep the loop alive for the test.
    await new Promise((resolve) => setTimeout(resolve, 150));
    warm.stop();
    assert.ok(calls >= 2, `probed ${calls} times`);
  });
});
