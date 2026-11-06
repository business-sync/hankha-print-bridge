import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLogSink } from './log.js';
import { resetRegistryCache } from './registry.js';
import { createBridgeServer } from './server.js';
import { ROUTE_PROBES, ROUTE_STATUSES } from './route-table.golden.js';

/*
 * Port 9200's route table is the M1 one. M5 added a second listener; nothing about the first moved.
 * `route-table.golden.ts` holds the statuses the M1 build (5218ed3) gave these probes; the same
 * probes are replayed here against the current server.
 */

let dir = '';
let server: Server;
let port = 0;
let restoreLog: (() => void) | null = null;
const previous = process.env.PRINT_BRIDGE_STATE_DIR;

before(async () => {
  restoreLog = setLogSink(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'hankha-routes-'));
  process.env.PRINT_BRIDGE_STATE_DIR = dir;
  resetRegistryCache();
  server = createBridgeServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
after(() => {
  server.close();
  if (previous === undefined) delete process.env.PRINT_BRIDGE_STATE_DIR;
  else process.env.PRINT_BRIDGE_STATE_DIR = previous;
  resetRegistryCache();
  rmSync(dir, { recursive: true, force: true });
  restoreLog?.();
});

describe('the 9200 route table', () => {
  for (const probe of ROUTE_PROBES) {
    const name = `${probe.method} ${probe.path}`;
    it(`${name} answers ${ROUTE_STATUSES[name]}, as it did in M1`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${probe.path}`, {
        method: probe.method,
        headers: probe.body !== undefined ? { 'content-type': 'application/json' } : {},
        body: probe.body !== undefined ? JSON.stringify(probe.body) : undefined,
      });
      await res.arrayBuffer();
      assert.equal(res.status, ROUTE_STATUSES[name]);
    });
  }

  it('serves no LAN route: /lan/v1/* is a 404 on 9200, signed or not', async () => {
    for (const [method, path] of [['GET', '/lan/v1/hello'], ['POST', '/lan/v1/jobs'], ['GET', '/lan/v1/printers']] as const) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'x-hankha-ticket': 'x' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  it('server.ts does not import the LAN modules: the two listeners share no route table', () => {
    const source = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');
    assert.ok(!/lan-server|lan-auth|lan-keys/.test(source));
  });
});
