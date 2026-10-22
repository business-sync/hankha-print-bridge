import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

/*
 * The periodic snapshot is what turns "it stopped some time this afternoon" into evidence. These
 * pin what it carries, that it can be turned off, and that it notices a background timer that
 * has gone quiet.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-diag-'));
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const { setLogSink } = await import('./log.js');
const { collectSnapshot, diagIntervalMs, diagnosticsRunning, lagWarnMs, startDiagnostics } = await import('./diagnostics.js');
const { markTick, resetTicks } = await import('./ticks.js');
type Rec = import('./log.js').LogRecord;

afterEach(() => resetTicks());

describe('configuration', () => {
  it('defaults to 15 minutes, takes fractions, and 0 turns it off', () => {
    assert.equal(diagIntervalMs({}), 15 * 60_000);
    assert.equal(diagIntervalMs({ PRINT_BRIDGE_DIAG_INTERVAL_MIN: '0.5' }), 30_000);
    assert.equal(diagIntervalMs({ PRINT_BRIDGE_DIAG_INTERVAL_MIN: '0' }), 0);
    assert.equal(diagIntervalMs({ PRINT_BRIDGE_DIAG_INTERVAL_MIN: 'nonsense' }), 15 * 60_000);
    assert.equal(lagWarnMs({}), 1000);
    assert.equal(lagWarnMs({ PRINT_BRIDGE_DIAG_LAG_WARN_MS: '250' }), 250);
  });
});

describe('snapshot', () => {
  it('carries memory, relay and queue state', () => {
    const snap = collectSnapshot();
    assert.ok(snap.rss_mb > 0 && snap.heap_used_mb > 0);
    assert.equal(typeof snap.uptime_s, 'number');
    assert.equal(snap.relay_connected, false);
    assert.equal(snap.queue_pending, 0);
    assert.equal(snap.printers, 0);
  });

  it('logs a snapshot with loop lag measured by the sampler', async () => {
    const records: Rec[] = [];
    const restore = setLogSink((r) => records.push(r));
    const diag = startDiagnostics({ intervalMs: 0, sampleMs: 20 });
    try {
      await new Promise((r) => setTimeout(r, 120));
      const snap = diag.logSnapshot();
      assert.equal(typeof snap.lag_max_ms, 'number');
      const line = records.find((r) => r.event === 'diag.snapshot');
      assert.ok(line);
      assert.equal(line.level, 'info');
      assert.equal(typeof line.fields.rss_mb, 'number');
      assert.match(line.msg, /^diag: up /);
    } finally {
      diag.stop();
      restore();
    }
  });

  it('warns about a background timer that has stopped ticking', () => {
    const records: Rec[] = [];
    const restore = setLogSink((r) => records.push(r));
    const diag = startDiagnostics({ intervalMs: 0, sampleMs: 60_000 });
    try {
      markTick('relay.heartbeat', 1000, Date.now() - 10_000);
      const snap = diag.logSnapshot();
      assert.deepEqual(snap.stalled_timers, ['relay.heartbeat']);
      const warn = records.find((r) => r.event === 'diag.timer_stalled');
      assert.equal(warn?.fields.timer, 'relay.heartbeat');
    } finally {
      diag.stop();
      restore();
    }
  });

  it('warns when the event loop is blocked past the threshold', async () => {
    const records: Rec[] = [];
    const restore = setLogSink((r) => records.push(r));
    const diag = startDiagnostics({ intervalMs: 0, sampleMs: 20, lagWarnMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 30));
      const until = Date.now() + 150;
      while (Date.now() < until) {
        /* block the loop on purpose */
      }
      await new Promise((r) => setTimeout(r, 60));
      const lag = records.find((r) => r.event === 'diag.event_loop_lag');
      assert.ok(lag, 'a 150 ms stall is reported');
      assert.ok(Number(lag.fields.lag_ms) >= 50);
    } finally {
      diag.stop();
      restore();
    }
  });
});

describe('lifecycle', () => {
  it('stops every timer it started', () => {
    const diag = startDiagnostics({ intervalMs: 60_000, sampleMs: 20 });
    assert.equal(diagnosticsRunning(), true);
    diag.stop();
    assert.equal(diagnosticsRunning(), false);
  });
});
