import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * An UNPAIRED Bridge has no relay.json. `loadState()` used to invent a new install id on every call
 * that found none, and the LAN identity cache re-reads every 2 s — so `hello` reported a different
 * identity every couple of seconds, and a different one again from `pair-info` (which saved its own).
 * Found by smoke-testing the compiled 1.15.0 binary. Real processes, because the bug lived in how
 * index.ts wires the cache to the state file.
 */

const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const free = () =>
  new Promise<number>((resolve) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function boot(dir: string, lanPort: number) {
  const port = await free();
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: {
      ...process.env,
      PRINT_BRIDGE_PORT: String(port),
      PRINT_BRIDGE_HOST: '127.0.0.1',
      PRINT_BRIDGE_STATE_DIR: dir,
      PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9',
      PRINT_BRIDGE_LOG_FORMAT: 'text',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  children.push(child);
  const lan = `http://127.0.0.1:${lanPort}`;
  await until(async () => {
    try {
      return (await fetch(`${lan}/lan/v1/hello`)).ok;
    } catch {
      return false;
    }
  }, 'the LAN hello to answer');
  return { child, lan };
}

const installOf = async (url: string) => ((await (await fetch(url)).json()) as { install_id: string }).install_id;

describe('an unpaired Bridge keeps ONE install id', () => {
  it('hello, pair-info and a restart all say the same thing, well past the 2 s identity cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-instid-'));
    dirs.push(dir);
    const lanPort = await free();
    writeFileSync(join(dir, 'lan.json'), JSON.stringify({ enabled: true, port: lanPort, host: '127.0.0.1', pairing_over_lan: true }));

    const first = await boot(dir, lanPort);
    const a = await installOf(`${first.lan}/lan/v1/hello`);
    assert.ok(a.length >= 8);
    assert.equal(existsSync(join(dir, 'relay.json')), true, 'the first id was never saved');
    assert.equal(JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8')).install_id, a);

    await new Promise((r) => setTimeout(r, 2_300)); // longer than the cache lifetime
    assert.equal(await installOf(`${first.lan}/lan/v1/hello`), a, 'hello changed identity after the cache expired');
    assert.equal(await installOf(`${first.lan}/lan/v1/pair-info`), a, 'pair-info disagrees with hello');

    first.child.kill('SIGKILL');
    await new Promise((r) => first.child.once('exit', r));
    const second = await boot(dir, lanPort);
    assert.equal(await installOf(`${second.lan}/lan/v1/hello`), a, 'a restart minted a new identity');
  });

  it('a Bridge with the LAN API off still writes nothing it did not write before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hankha-instid-off-'));
    dirs.push(dir);
    const port = await free();
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: { ...process.env, PRINT_BRIDGE_PORT: String(port), PRINT_BRIDGE_HOST: '127.0.0.1', PRINT_BRIDGE_STATE_DIR: dir, PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9' },
      stdio: 'ignore',
    });
    children.push(child);
    await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    }, '/health');
    assert.equal(existsSync(join(dir, 'lan-key.json')), false);
    assert.equal(existsSync(join(dir, 'lan.json')), false);
  });
});
