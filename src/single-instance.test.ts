import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { localInterfaces } from './lan.js';

/*
 * A second copy of the bridge must not touch the first one's spool.
 *
 * Real processes, because the bug was an ordering inside start-up: the spool was read back and
 * resumed right after `server.listen()` was CALLED, before anyone knew the port was free. A copy
 * that then lost `EADDRINUSE` had already marked the live copy's queued job as being sent and
 * started dialling the printer with it.
 *
 * Both processes are pointed at a relay URL nothing listens on, so neither can reach the real API.
 */

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];

after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address === 'string' || address === null) return reject(new Error('no port'));
      probe.close(() => resolve(address.port));
    });
  });
}

function startBridge(port: number, stateDir: string): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: {
      ...process.env,
      PRINT_BRIDGE_PORT: String(port),
      PRINT_BRIDGE_HOST: '127.0.0.1',
      PRINT_BRIDGE_STATE_DIR: stateDir,
      // Nothing listens on port 9 (discard): any pairing or relay traffic is refused locally.
      PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9',
      PRINT_BRIDGE_LOG_FORMAT: 'text',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let text = '';
  child.stdout?.on('data', (c: Buffer) => (text += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (text += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output: () => text, exited };
}

async function until(ready: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const healthy = (port: number) => async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
  } catch {
    return false;
  }
};

describe('a second copy of the bridge', () => {
  it('exits without reading the spool, so the first copy\'s waiting job is untouched', async (t) => {
    const lan = localInterfaces()[0];
    if (!lan) return t.skip('no private LAN interface on this machine');

    const stateDir = mkdtempSync(join(tmpdir(), 'hankha-single-'));
    dirs.push(stateDir);
    const port = await freePort();

    // The first copy takes the port.
    const first = startBridge(port, stateDir);
    await until(healthy(port), 'the first bridge to answer /health');

    // A printer that records whether anyone dials it.
    let connections = 0;
    const printer = createTcpServer((socket) => {
      connections += 1;
      socket.on('data', () => {});
    });
    await new Promise<void>((resolve) => printer.listen(0, lan.address, resolve));
    const printerPort = (printer.address() as { port: number }).port;

    // A job the first copy is holding. Written directly: the first copy has already loaded, so
    // it will not pick it up — only a copy that LOADS AFTER this point can.
    const job = {
      job_id: 'waiting-job',
      source: 'local',
      printer: {
        id: 'till', name: 'till', transport: 'network', type: 'receipt', language: 'escpos',
        enabled: true, address: lan.address, port: printerPort, dots_per_line: 576,
      },
      payload_base64: Buffer.from('x').toString('base64'),
      bytes: 1,
      copies: 1,
      attempts: 0,
      status: 'queued',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: null,
      retryable: true,
      persistent: true,
      keyed: true,
    };
    const spoolFile = join(stateDir, 'spool', 'waiting-job.json');
    mkdirSync(join(stateDir, 'spool'), { recursive: true });
    const text = JSON.stringify(job);
    writeFileSync(spoolFile, text);

    try {
      // The second copy loses the port.
      const second = startBridge(port, stateDir);
      const code = await Promise.race([
        second.exited,
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 20_000)),
      ]);
      assert.equal(code, 1, `the second copy should have refused to start:\n${second.output()}`);
      assert.match(second.output(), /already in use/);

      // Give a copy that wrongly dialled out time to be seen doing it.
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(connections, 0, 'the second copy sent the first copy\'s job to the printer');
      assert.equal(existsSync(spoolFile), true, 'the second copy settled and removed the first copy\'s job');
      assert.equal(readFileSync(spoolFile, 'utf8'), text, 'the second copy rewrote the first copy\'s job');
      assert.equal(existsSync(join(stateDir, 'settled.jsonl')), false);
      assert.match(first.output(), /listening on/);
    } finally {
      first.child.kill('SIGKILL');
      printer.close();
    }
  });
});
