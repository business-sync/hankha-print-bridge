import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWatchdog, watchdogLimitMs, type WatchdogProbe } from './watchdog.js';

const base: WatchdogProbe = { enrolled: true, running: true, connected: false, rejected: false };

function rig(limitMs = 600_000) {
  let t = 0;
  let probe = { ...base };
  const exits: string[] = [];
  const w = createWatchdog({ probe: () => probe, limitMs, now: () => t, exit: (r) => exits.push(r), intervalMs: 1e9 });
  return {
    w, exits,
    at: (ms: number) => { t = ms; },
    set: (p: Partial<WatchdogProbe>) => { probe = { ...probe, ...p }; },
  };
}

describe('watchdog', () => {
  it('stays quiet through six hours of healthy idle', () => {
    const r = rig();
    r.set({ connected: true });
    for (let m = 0; m <= 360; m += 1) { r.at(m * 60_000); r.w.tick(); }
    assert.deepEqual(r.exits, []);
    r.w.stop();
  });

  it('exits after continuous disconnect past the limit', () => {
    const r = rig();
    r.w.tick(); r.at(599_000); r.w.tick();
    assert.deepEqual(r.exits, []);
    r.at(600_000); r.w.tick();
    assert.equal(r.exits.length, 1);
    r.w.stop();
  });

  it('resets when the relay recovers, so intermittent blips never add up', () => {
    const r = rig();
    r.w.tick(); r.at(500_000); r.set({ connected: true }); r.w.tick();
    r.at(900_000); r.set({ connected: false }); r.w.tick();
    r.at(1_400_000); r.w.tick();
    assert.deepEqual(r.exits, []);
    r.w.stop();
  });

  it('does not restart when a human must re-pair, when not enrolled, or when disabled', () => {
    for (const p of [{ rejected: true }, { enrolled: false }, { running: false }] as Partial<WatchdogProbe>[]) {
      const r = rig(); r.set(p); r.w.tick(); r.at(9e9); r.w.tick();
      assert.deepEqual(r.exits, [], JSON.stringify(p)); r.w.stop();
    }
    const off = rig(0); off.w.tick(); off.at(9e9); off.w.tick();
    assert.deepEqual(off.exits, []); off.w.stop();
  });

  it('parses the env limit', () => {
    assert.equal(watchdogLimitMs({}), 900_000);
    assert.equal(watchdogLimitMs({ PRINT_BRIDGE_WATCHDOG_MINUTES: '0' }), 0);
    assert.equal(watchdogLimitMs({ PRINT_BRIDGE_WATCHDOG_MINUTES: '2' }), 120_000);
    assert.equal(watchdogLimitMs({ PRINT_BRIDGE_WATCHDOG_MINUTES: 'x' }), 900_000);
  });
});
