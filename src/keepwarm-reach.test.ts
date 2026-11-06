import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { widthMismatch } from './render/index.js';

process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-reach-'));
const { setLogSink } = await import('./log.js');
const { startKeepWarm } = await import('./keepwarm.js');
type Printer = import('./registry.js').PrinterRecord;

setLogSink(() => undefined);
const printer = (id: string, extra: Partial<Printer> = {}): Printer => ({
  id, name: id, transport: 'network', type: 'receipt', language: 'escpos', enabled: true,
  address: '192.168.1.50', port: 9100, dots_per_line: 576, ...extra,
});

/*
 * `GET /lan/v1/printers` reports what the probe last saw. These pin that the answer is kept apart
 * from the lane: a pass that skips a busy printer must not erase what it knew, and a printer never
 * probed is "unknown", which is not the same as "down".
 */
describe('what the probe last saw of a printer', () => {
  it('is unknown before the first probe — null, not false', () => {
    const warm = startKeepWarm({ intervalMs: 0, printers: () => [printer('a')], isBusy: () => false, probe: async () => ({ reachable: true, latency_ms: 1 }) });
    assert.deepEqual(warm.reach('a'), { reachable: null, last_ok_at: null, checked_at: null });
    warm.stop();
  });

  it('records reachable with a time, then down while remembering when it was last well', async () => {
    let up = true;
    const warm = startKeepWarm({
      intervalMs: 0, printers: () => [printer('a')], isBusy: () => false,
      probe: async () => (up ? { reachable: true, latency_ms: 2 } : { reachable: false, latency_ms: null, detail: 'timeout' }),
    });
    await warm.pass();
    const first = warm.reach('a');
    assert.equal(first.reachable, true);
    assert.match(first.last_ok_at ?? '', /^\d{4}-\d\d-\d\dT/);
    up = false;
    await new Promise((r) => setTimeout(r, 5));
    await warm.pass();
    const second = warm.reach('a');
    assert.equal(second.reachable, false);
    assert.equal(second.last_ok_at, first.last_ok_at, 'down now, but it was fine at that time');
    assert.notEqual(second.checked_at, first.checked_at);
    warm.stop();
  });

  it('a pass that skips a busy printer leaves the previous answer standing', async () => {
    let busy = false;
    const warm = startKeepWarm({ intervalMs: 0, printers: () => [printer('a')], isBusy: () => busy, probe: async () => ({ reachable: true, latency_ms: 1 }) });
    await warm.pass();
    const before = warm.reach('a');
    busy = true;
    const results = await warm.pass();
    assert.equal(results[0]?.reachable, null, 'this pass did not probe it');
    assert.deepEqual(warm.reach('a'), before, 'but what was known is still known');
    warm.stop();
  });

  it('forgets a printer that was removed or disabled', async () => {
    let list = [printer('a')];
    const warm = startKeepWarm({ intervalMs: 0, printers: () => list, isBusy: () => false, probe: async () => ({ reachable: true, latency_ms: 1 }) });
    await warm.pass();
    list = [];
    await warm.pass();
    assert.equal(warm.reach('a').reachable, null);
    warm.stop();
  });
});

describe('width mismatch', () => {
  const doc = (dots?: number) => ({ kind: 'receipt' as const, elements: [{ type: 'text' as const, value: 'x' }], ...(dots ? { dots_per_line: dots } : {}) });

  it('is none when the widths agree, or nothing is declared', () => {
    assert.equal(widthMismatch(doc(), printer('a'), 576), null);
    assert.equal(widthMismatch(doc(), printer('a')), null);
    assert.equal(widthMismatch(doc(384), printer('a', { dots_per_line: 384 }), 384), null);
  });

  it('names the printer\'s width when the declared one differs, in either direction', () => {
    assert.deepEqual(widthMismatch(doc(), printer('a'), 384), { expected: 576 });
    assert.deepEqual(widthMismatch(doc(), printer('a', { dots_per_line: 384 }), 576), { expected: 384 });
  });

  it('refuses a document pinned wider than the head, but allows a narrower one', () => {
    assert.deepEqual(widthMismatch(doc(576), printer('a', { dots_per_line: 384 })), { expected: 384 });
    assert.equal(widthMismatch(doc(384), printer('a')), null, 'a 58 mm slip on an 80 mm roll is merely narrow');
  });

  it('has nothing to compare on a printer with no line width', () => {
    assert.equal(widthMismatch(doc(), printer('label', { dots_per_line: undefined }), 999), null);
  });
});
