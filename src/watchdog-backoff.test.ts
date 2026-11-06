import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';
import { type BackoffStore, createWatchdog, fileBackoffStore, type WatchdogProbe } from './watchdog.js';

/*
 * What stops an ordinary internet outage from taking local printing down.
 *
 * "The cloud is unreachable" is exactly what a venue's dead router looks like, and a restart
 * costs the till at least ten seconds of not printing at all. The base behaviour (exit after a
 * continuous outage) lives in watchdog.test.ts; these are the three limits on it.
 */

const MIN = 60_000;
const down: WatchdogProbe = { enrolled: true, running: true, connected: false, rejected: false };

let restoreLog: (() => void) | null = null;
let records: LogRecord[] = [];
beforeEach(() => {
  records = [];
  restoreLog = setLogSink((r) => records.push(r));
});
afterEach(() => restoreLog?.());

function memoryStore(initial = 0): BackoffStore & { step: number; writes: number[] } {
  const store = {
    step: initial,
    writes: [] as number[],
    read: () => store.step,
    write: (s: number) => {
      store.step = s;
      store.writes.push(s);
    },
  };
  return store;
}

function rig(opts: { limitMs?: number; inUse?: () => boolean; maxDeferMs?: number; store?: BackoffStore; stableMs?: number } = {}) {
  let t = 0;
  let probe = { ...down };
  const exits: string[] = [];
  const w = createWatchdog({
    probe: () => probe,
    limitMs: opts.limitMs ?? 15 * MIN,
    now: () => t,
    exit: (r) => exits.push(r),
    intervalMs: 1e9,
    inUse: opts.inUse,
    maxDeferMs: opts.maxDeferMs,
    backoff: opts.store,
    stableMs: opts.stableMs,
  });
  return {
    w, exits,
    at: (ms: number) => { t = ms; },
    set: (p: Partial<WatchdogProbe>) => { probe = { ...probe, ...p }; },
  };
}

describe('waiting while the bridge is printing', () => {
  it('does not restart while jobs are in flight, then restarts once it goes quiet', () => {
    let busy = true;
    const r = rig({ inUse: () => busy });
    r.w.tick();
    r.at(15 * MIN); r.w.tick();
    assert.deepEqual(r.exits, [], 'restarted in the middle of service');
    r.at(30 * MIN); r.w.tick();
    assert.deepEqual(r.exits, [], 'still busy');
    busy = false;
    r.at(31 * MIN); r.w.tick();
    assert.equal(r.exits.length, 1);
    r.w.stop();
  });

  it('says once that it is waiting, not on every tick', () => {
    const r = rig({ inUse: () => true });
    r.w.tick();
    for (let m = 15; m <= 25; m += 1) { r.at(m * MIN); r.w.tick(); }
    assert.equal(records.filter((x) => x.event === 'relay.watchdog.deferred').length, 1);
    r.w.stop();
  });

  it('still restarts after the longest wait, however busy it is — a wedge must not hide behind traffic', () => {
    const r = rig({ inUse: () => true, maxDeferMs: 60 * MIN });
    r.w.tick();
    r.at(15 * MIN); r.w.tick();
    r.at(74 * MIN); r.w.tick();
    assert.deepEqual(r.exits, []);
    r.at(75 * MIN); r.w.tick();
    assert.equal(r.exits.length, 1);
    r.w.stop();
  });

  it('an outage that ends while it is waiting cancels the restart', () => {
    const r = rig({ inUse: () => true });
    r.w.tick(); r.at(20 * MIN); r.w.tick();
    r.set({ connected: true }); r.at(21 * MIN); r.w.tick();
    r.set({ connected: false }); r.at(22 * MIN); r.w.tick();
    r.at(36 * MIN); r.w.tick();
    assert.deepEqual(r.exits, [], 'the new outage must start its own clock');
    r.w.stop();
  });

  it('behaves exactly as before when nothing says the bridge is in use', () => {
    const r = rig();
    r.w.tick(); r.at(15 * MIN); r.w.tick();
    assert.equal(r.exits.length, 1);
    r.w.stop();
  });
});

describe('backing off after a restart that did not help', () => {
  it('doubles the wait each time and remembers it across the restart', () => {
    const store = memoryStore();
    const waits: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      // A new process each round: only the store carries over.
      const r = rig({ store });
      r.w.tick();
      let minutes = 0;
      while (r.exits.length === 0 && minutes < 24 * 60) { minutes += 1; r.at(minutes * MIN); r.w.tick(); }
      waits.push(minutes);
      r.w.stop();
    }
    assert.deepEqual(waits, [15, 30, 60, 120]);
    assert.deepEqual(store.writes, [1, 2, 3, 4]);
  });

  it('never waits longer than six hours', () => {
    const store = memoryStore(9);
    const r = rig({ store });
    r.w.tick();
    r.at(6 * 60 * MIN - 1); r.w.tick();
    assert.deepEqual(r.exits, []);
    r.at(6 * 60 * MIN); r.w.tick();
    assert.equal(r.exits.length, 1);
    r.w.stop();
  });

  it('a limit the operator set above six hours is respected, not cut down', () => {
    const r = rig({ limitMs: 8 * 60 * MIN, store: memoryStore(3) });
    r.w.tick();
    r.at(7 * 60 * MIN); r.w.tick();
    assert.deepEqual(r.exits, []);
    r.at(8 * 60 * MIN); r.w.tick();
    assert.equal(r.exits.length, 1);
    r.w.stop();
  });

  it('forgets the history only after the relay has stayed connected for a while', () => {
    const store = memoryStore(3);
    const r = rig({ store, stableMs: 10 * MIN });
    r.set({ connected: true });
    r.at(0); r.w.tick();
    r.at(9 * MIN); r.w.tick();
    assert.equal(store.step, 3, 'a blip of connectivity is not recovery');
    r.at(10 * MIN); r.w.tick();
    assert.equal(store.step, 0);
    assert.deepEqual(store.writes, [0]);
    r.w.stop();
  });

  it('a relay that connects and drops again keeps its backoff', () => {
    const store = memoryStore(2);
    const r = rig({ store, stableMs: 10 * MIN });
    r.set({ connected: true }); r.at(0); r.w.tick();
    r.at(5 * MIN); r.w.tick();
    r.set({ connected: false }); r.at(6 * MIN); r.w.tick();
    r.set({ connected: true }); r.at(7 * MIN); r.w.tick();
    // Connected again, but the clock for "stable" restarted at 7.
    r.at(15 * MIN); r.w.tick();
    assert.equal(store.step, 2);
    r.at(17 * MIN); r.w.tick();
    assert.equal(store.step, 0);
    r.w.stop();
  });

  it('saves the step BEFORE it exits, because the next process reads it', () => {
    const order: string[] = [];
    let t = 0;
    const w = createWatchdog({
      probe: () => down,
      limitMs: 15 * MIN,
      now: () => t,
      intervalMs: 1e9,
      backoff: { read: () => 0, write: (s) => order.push(`write:${s}`) },
      exit: () => order.push('exit'),
    });
    w.tick(); t = 15 * MIN; w.tick();
    assert.deepEqual(order, ['write:1', 'exit']);
    w.stop();
  });

  it('an unenrolled or re-pairing bridge neither restarts nor changes the backoff', () => {
    const store = memoryStore(2);
    for (const p of [{ enrolled: false }, { rejected: true }] as Partial<WatchdogProbe>[]) {
      const r = rig({ store });
      r.set(p); r.w.tick(); r.at(48 * 60 * MIN); r.w.tick();
      assert.deepEqual(r.exits, []);
      r.w.stop();
    }
    assert.equal(store.step, 2);
    assert.deepEqual(store.writes, []);
  });
});

describe('fileBackoffStore', () => {
  const dirs: string[] = [];
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'hankha-wd-')); dirs.push(d); return d; };

  it('starts at zero when there is no file', () => {
    assert.equal(fileBackoffStore(join(scratch(), 'watchdog.json')).read(), 0);
  });

  it('keeps the step for the next process', () => {
    const path = join(scratch(), 'watchdog.json');
    fileBackoffStore(path).write(3);
    assert.equal(fileBackoffStore(path).read(), 3);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).step, 3);
  });

  it('reads garbage as zero rather than refusing to start', () => {
    const path = join(scratch(), 'watchdog.json');
    writeFileSync(path, '{not json');
    assert.equal(fileBackoffStore(path).read(), 0);
    writeFileSync(path, JSON.stringify({ step: 'many' }));
    assert.equal(fileBackoffStore(path).read(), 0);
  });

  it('creates the directory, and a write that fails is a log line, not a crash', () => {
    const dir = scratch();
    fileBackoffStore(join(dir, 'nested', 'watchdog.json')).write(1);
    assert.equal(existsSync(join(dir, 'nested', 'watchdog.json')), true);
    // A file where the directory must go.
    writeFileSync(join(dir, 'blocked'), 'x');
    assert.doesNotThrow(() => fileBackoffStore(join(dir, 'blocked', 'watchdog.json')).write(1));
    assert.ok(records.some((r) => r.event === 'relay.watchdog.backoff_save_failed'));
  });
});
