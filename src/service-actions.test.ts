import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { clearStopper, registerStopper } from './lifecycle.js';
import { PrintQueue } from './queue.js';
import type { PrinterRecord } from './registry.js';
import {
  cancelReboot,
  launchdPlist,
  rebootPending,
  restartService,
  scheduleReboot,
  uninstallService,
  WINDOWS_HELPER,
} from './service-actions.js';
import type { ServiceReport } from './service.js';

/** A report shaped by hand, so a test can put this machine in a state it is not actually in. */
function report(overrides: Partial<ServiceReport> = {}): ServiceReport {
  const allowed = { allowed: true };
  return {
    manager: 'launchd-agent',
    detected_by: 'stamp',
    label: 'la.hankha.print-bridge',
    supervised: true,
    autostart: true,
    privileged: false,
    packaged: true,
    hostname: 'counter',
    platform: 'darwin',
    install_dir: '/Applications/Hankha Print Bridge.app',
    state_dir: '/tmp/state',
    log_path: '/tmp/bridge.log',
    can: {
      restart: allowed,
      autostart: allowed,
      uninstall: allowed,
      reboot: allowed,
      clear_cache: allowed,
      ...(overrides.can ?? {}),
    },
    ...overrides,
  } as ServiceReport;
}

afterEach(() => {
  clearStopper();
  cancelReboot();
});

describe('restart', () => {
  it('refuses when the capability says so, and passes the manual command through', async () => {
    const outcome = await restartService(
      report({
        can: {
          restart: { allowed: false, reason: 'not-supervised', hint: 'start it again by hand' },
        } as ServiceReport['can'],
      })
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'not-supervised');
    assert.equal(outcome.hint, 'start it again by hand');
  });

  it('refuses when this process has no graceful stop to run', async () => {
    // Under `node --test` nothing registers one, and a route that called process.exit() itself
    // would take the test runner down with it.
    clearStopper();
    const outcome = await restartService(report());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'no-lifecycle');
  });

  it('answers first and stops afterwards', async () => {
    // An answer sent after the listener starts closing reaches the browser as a network error,
    // which reads to an operator as "I broke it".
    let stoppedWith: number | null = null;
    registerStopper((code) => { stoppedWith = code; });

    const outcome = await restartService(report());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.method, 'supervisor');
    assert.equal(stoppedWith, null, 'the process must still be up when the answer is written');

    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(stoppedWith, 0);
  });
});

describe('the Windows helper', () => {
  it('waits for the old process before asking the task to run again', () => {
    // MultipleInstances IgnoreNew silently drops a /Run issued while the old copy still holds the
    // port, so the wait is the whole reason this script exists.
    assert.match(WINDOWS_HELPER, /tasklist \/FI "PID eq %PID%"/);
    assert.ok(WINDOWS_HELPER.indexOf('call :waitforexit') < WINDOWS_HELPER.indexOf('schtasks /Run'));
  });

  it('sleeps with ping, never with timeout', () => {
    // `timeout /t` fails outright with "input redirection is not supported" when there is no
    // console — which is exactly how this runs.
    assert.match(WINDOWS_HELPER, /ping -n \d+ 127\.0\.0\.1/);
    assert.equal(/timeout \/t/.test(WINDOWS_HELPER), false);
  });

  it('carries every mode the actions ask it for', () => {
    for (const mode of ['restart', 'autostart']) {
      assert.ok(WINDOWS_HELPER.includes(`"%MODE%"=="${mode}"`), mode);
    }
    // The registered uninstaller first, so the Settings > Apps entry goes with it.
    assert.match(WINDOWS_HELPER, /Uninstall\.exe" \/S/);
    assert.match(WINDOWS_HELPER, /uninstall\.ps1/);
  });
});

describe('the plist it writes', () => {
  it('binds loopback and comes back by itself', () => {
    const plist = launchdPlist('/Applications/X.app/Contents/MacOS/bin', 9200, '/tmp/x.log', 'launchd-agent');
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<string>127\.0\.0\.1<\/string>/);
    assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    // The stamp, so the next start knows what is running it without asking launchd.
    assert.match(plist, /PRINT_BRIDGE_MANAGED[\s\S]*launchd-agent/);
  });
});

describe('reboot', () => {
  it('refuses when the capability says so', () => {
    const outcome = scheduleReboot(
      report({ can: { reboot: { allowed: false, reason: 'container' } } as ServiceReport['can'] }),
      0,
      false
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'container');
  });

  it('arms once, reports the deadline, and can be called off', () => {
    const outcome = scheduleReboot(report(), 600, false);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.in_s, 600);
    assert.ok(rebootPending());

    // A second press must not stack two timers on one machine.
    const again = scheduleReboot(report(), 600, false);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already-scheduled');

    assert.equal(cancelReboot(), true);
    assert.equal(rebootPending(), null);
    assert.equal(cancelReboot(), false);
  });
});

describe('uninstall', () => {
  it('refuses on a machine where nothing is installed', async () => {
    const outcome = await uninstallService(
      report({
        manager: 'none',
        can: { uninstall: { allowed: false, reason: 'not-installed' } } as ServiceReport['can'],
      }),
      'files'
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'not-installed');
  });
});

/* ------------------------------------------------------------------ the purge */

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-purge-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const printer: PrinterRecord = {
  id: 'counter', name: 'counter', transport: 'network', type: 'receipt', language: 'escpos',
  enabled: true, address: '192.168.1.50', port: 9100, dots_per_line: 576,
};

describe('clearing stored print data', () => {
  it('cancels waiting jobs instead of deleting them from under the queue', async () => {
    // Sweeping the spool directory would leave the lanes holding jobs whose payloads are gone,
    // and everything awaiting `settled` hanging forever. A cancelled job settles properly.
    let sends = 0;
    const queue = new PrintQueue({
      dir: scratch(),
      send: async () => {
        sends += 1;
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true, duration_ms: 1 };
      },
    });

    const first = queue.submit({ source: 'local', printer, payload: Buffer.from('a') });
    const second = queue.submit({ source: 'local', printer, payload: Buffer.from('b') });
    const third = queue.submit({ source: 'local', printer, payload: Buffer.from('c') });

    const purged = queue.purge({ spool: true });
    // The head of the lane is already on the wire; the two behind it are not.
    assert.equal(purged.spool + purged.skipped_printing, 3);

    const settled = await Promise.all([first.settled, second.settled, third.settled]);
    for (const job of settled) assert.ok(job.status === 'done' || job.status === 'failed');
    assert.ok(sends <= 1, 'nothing behind the head should have reached a printer');
  });

  it('leaves duplicate protection alone unless it is asked for by name', async () => {
    const queue = new PrintQueue({ dir: scratch(), send: async () => ({ ok: true, duration_ms: 1 }) });
    await queue.submit({ job_id: 'bill-1', source: 'relay', printer, payload: Buffer.from('x') }).settled;

    assert.equal(queue.cacheSizes().settled.count, 1);
    queue.purge({ spool: true, history: true });
    assert.equal(queue.cacheSizes().settled.count, 1, 'the ring must survive an ordinary clear');

    // A redelivery still replays rather than printing a second bill.
    assert.equal(queue.submit({ job_id: 'bill-1', source: 'relay', printer, payload: Buffer.from('x') }).deduplicated, true);

    queue.purge({ settled: true });
    assert.equal(queue.cacheSizes().settled.count, 0);
  });

  it('never touches printers.json or relay.json', async () => {
    // The regression that would cost a venue its configuration and its pairing in one press.
    const dir = scratch();
    const queue = new PrintQueue({ dir, send: async () => ({ ok: true, duration_ms: 1 }) });
    const { writeFileSync, existsSync } = await import('node:fs');
    writeFileSync(join(dir, 'printers.json'), '{"version":1,"printers":[]}');
    writeFileSync(join(dir, 'relay.json'), '{"install_id":"abcdefgh"}');

    queue.purge({ spool: true, history: true, settled: true });

    assert.equal(existsSync(join(dir, 'printers.json')), true);
    assert.equal(existsSync(join(dir, 'relay.json')), true);
  });

  it('counts what it would remove before anything is pressed', async () => {
    const queue = new PrintQueue({ dir: scratch(), send: async () => ({ ok: true, duration_ms: 1 }) });
    await queue.submit({ source: 'local', printer, payload: Buffer.from('hello') }).settled;
    const sizes = queue.cacheSizes();
    assert.equal(sizes.spool.count, 0);
    assert.equal(sizes.history.count, 1);
    assert.ok(sizes.settled.bytes >= 0);
  });
});
