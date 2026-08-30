import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { resetRegistryCache } from './registry.js';
import { createBridgeServer } from './server.js';
import { resetConfirmTokens } from './service-control.js';
import { invalidateServiceReport, isPackagedBuild, serviceReport } from './service.js';

/* ------------------------------------------------------------------ detection */

describe('what is running this bridge', () => {
  afterEach(() => {
    delete process.env.PRINT_BRIDGE_MANAGED;
    invalidateServiceReport();
  });

  it('believes the stamp its own launcher wrote', async () => {
    // The cheap path, and the only one that is authoritative: print-bridge.cmd, both plists and
    // the systemd unit all set this. Everything else is a probe working it out afterwards.
    process.env.PRINT_BRIDGE_MANAGED = 'systemd';
    invalidateServiceReport();
    const report = await serviceReport();
    assert.equal(report.manager, 'systemd');
    assert.equal(report.detected_by, 'stamp');
    assert.equal(report.supervised, true);
  });

  it('ignores a stamp that names nothing real', async () => {
    process.env.PRINT_BRIDGE_MANAGED = 'nonsense';
    invalidateServiceReport();
    const report = await serviceReport();
    // Falls through to working it out. `detected_by` is then 'probe' or — when the probe finds
    // nothing, which is the case on a development machine — 'default'. Never 'stamp', and the
    // unknown word never reaches `manager`, where it would be treated as a supervisor.
    assert.notEqual(report.detected_by, 'stamp');
    assert.notEqual(report.manager, 'nonsense');
  });

  it('refuses to restart a bridge nothing would start again', async () => {
    process.env.PRINT_BRIDGE_MANAGED = 'none';
    invalidateServiceReport();
    const report = await serviceReport();

    // The most dangerous button on the page if this were ever wrong: a restart nothing undoes
    // leaves the till with no bridge at all until somebody drives there.
    assert.equal(report.can.restart.allowed, false);
    assert.equal(report.can.restart.reason, 'not-supervised');
    assert.ok(report.can.restart.hint, 'a refusal must say what to do instead');
    assert.equal(report.supervised, false);
    assert.equal(report.autostart, false);
  });

  it('owns nothing in a container', async () => {
    process.env.PRINT_BRIDGE_MANAGED = 'container';
    invalidateServiceReport();
    const report = await serviceReport();
    for (const name of ['restart', 'autostart', 'uninstall', 'reboot'] as const) {
      assert.equal(report.can[name].allowed, false, name);
    }
    // Except this one: it touches only our own state directory, which is ours everywhere.
    assert.equal(report.can.clear_cache.allowed, true);
  });

  it('never offers to register a development build as a service', async () => {
    // A LaunchAgent pointing at `node` plus a .ts path is a plist that can never start anything,
    // and it would look like a successful install.
    assert.equal(isPackagedBuild(), false);
    process.env.PRINT_BRIDGE_MANAGED = 'none';
    invalidateServiceReport();
    const report = await serviceReport();
    assert.equal(report.packaged, false);
    assert.equal(report.can.autostart.allowed, false);
    assert.equal(report.can.autostart.reason, 'not-packaged');
  });

  it('says where the files are, so the page never tells anyone to go and find out', async () => {
    process.env.PRINT_BRIDGE_MANAGED = 'none';
    invalidateServiceReport();
    const report = await serviceReport();
    assert.ok(report.state_dir.length > 0);
    assert.ok(report.hostname.length > 0);
  });
});

/* --------------------------------------------------------------------- routes */

let stateDir = '';
let bridge: Server;
let port = 0;

/**
 * A raw request, because `fetch` silently drops the headers these tests are about: `Host` is a
 * forbidden header name there, and it is the one DNS rebinding gets wrong.
 */
function raw(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown
): Promise<{ status: number; json: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json: any = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode ?? 0, json, headers: res.headers as Record<string, unknown> });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), 'hankha-service-'));
  process.env.PRINT_BRIDGE_STATE_DIR = stateDir;
  // Nothing here may act on the developer's own machine.
  process.env.PRINT_BRIDGE_MANAGED = 'none';
  invalidateServiceReport();
  resetRegistryCache();
  bridge = createBridgeServer();
  port = await new Promise<number>((resolve) => {
    bridge.listen(0, '127.0.0.1', () => {
      const address = bridge.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      resolve(address.port);
    });
  });
});

after(() => {
  bridge.close();
  delete process.env.PRINT_BRIDGE_STATE_DIR;
  delete process.env.PRINT_BRIDGE_MANAGED;
  rmSync(stateDir, { recursive: true, force: true });
});

afterEach(() => resetConfirmTokens());

describe('GET /service', () => {
  it('reports the machine and hands over one confirmation', async () => {
    const res = await raw('GET', '/service');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.service.manager, 'none');
    assert.equal(res.json.pid, process.pid);
    assert.match(res.json.confirm_token, /^[0-9a-f]{32}$/);
  });

  it('carries no CORS grant, unlike every other route here', async () => {
    // This is layer 2. Without it a page on any origin could preflight its way to /service/reboot.
    const service = await raw('GET', '/service');
    const health = await raw('GET', '/health');
    assert.equal(service.headers['access-control-allow-origin'], undefined);
    assert.equal(service.headers['access-control-allow-private-network'], undefined);
    assert.equal(health.headers['access-control-allow-origin'], '*');
  });

  it('refuses a preflight outright', async () => {
    // Our own page is same-origin and never preflights. Anything that does is another origin
    // asking permission to reboot this computer.
    const res = await raw('OPTIONS', '/service/restart');
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'preflight-refused');
  });

  it('refuses a rebound Host', async () => {
    const res = await raw('GET', '/service', { Host: 'evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'bad-host');
  });

  it('refuses a cross-origin caller', async () => {
    const res = await raw('POST', '/service/restart', { Origin: 'https://evil.example' }, {});
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'cross-origin');
  });
});

describe('the mutating routes', () => {
  it('will not act without a confirmation', async () => {
    for (const path of ['/service/restart', '/service/autostart', '/service/reboot', '/service/cache']) {
      const res = await raw('POST', path, {}, {});
      assert.equal(res.status, 403, path);
      assert.equal(res.json.reason, 'confirm-required', path);
    }
  });

  it('will not act on a stale confirmation', async () => {
    const first = (await raw('GET', '/service')).json.confirm_token;
    const spent = await raw('POST', '/service/cache', {}, { confirm: first, items: [] });
    assert.equal(spent.status, 200);
    const replay = await raw('POST', '/service/cache', {}, { confirm: first, items: [] });
    assert.equal(replay.status, 403);
    assert.equal(replay.json.reason, 'confirm-required');
  });

  it('refuses an uninstall scope it does not recognise', async () => {
    const confirm = (await raw('GET', '/service')).json.confirm_token;
    const res = await raw('POST', '/service/uninstall', {}, { confirm, scope: 'the-whole-computer' });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'invalid-scope');
  });

  it('refuses a restart that nothing would undo', async () => {
    const confirm = (await raw('GET', '/service')).json.confirm_token;
    const res = await raw('POST', '/service/restart', {}, { confirm });
    assert.equal(res.status, 409);
    assert.equal(res.json.reason, 'not-supervised');
    assert.ok(res.json.hint);
  });

  it('clears only what it was asked for', async () => {
    const confirm = (await raw('GET', '/service')).json.confirm_token;
    const res = await raw('POST', '/service/cache', {}, { confirm, items: ['history'] });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.purged.settled, 0);
    assert.equal(res.json.logs.cleared.length, 0);
  });
});

describe('GET /service/cache', () => {
  it('itemises what a purge would remove, and names what it never touches', async () => {
    const res = await raw('GET', '/service/cache');
    assert.equal(res.status, 200);
    for (const item of ['spool', 'history', 'settled', 'logs'] as const) {
      assert.equal(typeof res.json.cache[item].count, 'number', item);
    }
    // printers.json and relay.json: the configuration and this computer's pairing credential.
    assert.equal(res.json.never_touched.length, 2);
    for (const path of res.json.never_touched) assert.ok(path.startsWith(stateDir), path);
  });
});
