import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The real entry point, as a process: does the LAN print API stay OFF unless `lan.json` turns it on?
 *
 * "Off" is checked the strong way — by asking the operating system which TCP ports the process is
 * listening on — not by connecting to 9201 and hoping nothing else on this machine answers.
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

function listeningPorts(pid: number): number[] | null {
  try {
    const out = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => l.startsWith('n')).map((l) => Number(l.slice(l.lastIndexOf(':') + 1))).sort((a, b) => a - b);
  } catch (err) {
    // lsof exits 1 when it finds nothing; any other failure means it is not there to ask.
    return (err as { status?: number }).status === 1 ? [] : null;
  }
}

async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startBridge(lanJson?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-lanproc-'));
  dirs.push(dir);
  if (lanJson !== undefined) writeFileSync(join(dir, 'lan.json'), JSON.stringify(lanJson));
  const port = await free();
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: {
      ...process.env,
      PRINT_BRIDGE_PORT: String(port),
      PRINT_BRIDGE_HOST: '127.0.0.1',
      PRINT_BRIDGE_STATE_DIR: dir,
      PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9', // nothing listens on 9: no pairing or relay traffic leaves this machine
      PRINT_BRIDGE_LOG_FORMAT: 'text',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }, 'the bridge to answer /health');
  return { child, port, dir, output: () => output, exited, pid: child.pid as number };
}

const haveLsof = (() => {
  try {
    execFileSync('lsof', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    // `lsof -v` exits non-zero on some builds but still exists.
    try {
      execFileSync('which', ['lsof'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
})();

describe('the LAN print API is off by default', () => {
  it('with no lan.json the process listens on its own port and nothing else — in particular not 9201', async (t) => {
    const b = await startBridge();
    // Give a late-starting listener every chance to appear.
    await new Promise((r) => setTimeout(r, 1_000));
    const ports = listeningPorts(b.pid);
    if (ports === null) t.diagnostic('lsof is not available; fell back to the weaker checks');
    else assert.deepEqual(ports, [b.port], 'the main listener is the only one');

    assert.ok(!ports?.includes(9201));
    const lanFiles = readdirSync(b.dir).filter((f) => /^lan|settled-keyed/.test(f));
    assert.deepEqual(lanFiles, [], 'no key, key set or ring file is created');
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/lan/v1/hello`)).status, 404);
    assert.ok(!/lan: print API listening/.test(b.output()));
    b.child.kill('SIGTERM');
    assert.equal(await b.exited, 0);
  });

  it('lan.json with enabled:false, or enabled as anything but true, still opens nothing', async (t) => {
    for (const config of [{ enabled: false, port: 9301 }, { enabled: 'yes' }, { port: 9301 }]) {
      const b = await startBridge(config);
      await new Promise((r) => setTimeout(r, 500));
      const ports = listeningPorts(b.pid);
      if (ports !== null) assert.deepEqual(ports, [b.port], JSON.stringify(config));
      else t.diagnostic('lsof is not available');
      b.child.kill('SIGKILL');
      await b.exited;
    }
  });

  it('a lan.json naming the main port is refused, not half-applied', async (t) => {
    const probe = await free();
    const dir = mkdtempSync(join(tmpdir(), 'hankha-lanproc-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'lan.json'), JSON.stringify({ enabled: true, port: probe }));
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: { ...process.env, PRINT_BRIDGE_PORT: String(probe), PRINT_BRIDGE_HOST: '127.0.0.1', PRINT_BRIDGE_STATE_DIR: dir, PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${probe}/health`)).ok;
      } catch {
        return false;
      }
    }, '/health');
    const ports = child.pid ? listeningPorts(child.pid) : null;
    if (ports !== null) assert.deepEqual(ports, [probe]);
    else t.diagnostic('lsof is not available');
    assert.ok(!existsSync(join(dir, 'lan-key.json')));
    child.kill('SIGKILL');
  });
});

describe('with lan.json enabling it', () => {
  it('opens a second listener, serves only /lan/v1 there, leaves 9200 as it was, and closes with the process', async (t) => {
    const lanPort = await free();
    const b = await startBridge({ enabled: true, port: lanPort, host: '127.0.0.1' });
    await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${lanPort}/lan/v1/hello`)).ok;
      } catch {
        return false;
      }
    }, 'the LAN listener');

    const hello = (await (await fetch(`http://127.0.0.1:${lanPort}/lan/v1/hello`)).json()) as { bridge_id: unknown; protocol: number };
    assert.equal(hello.protocol, 1);
    assert.equal(hello.bridge_id, null, 'an unpaired Bridge has no id to give');

    // Nothing but the five routes on the LAN port: the whole 9200 surface is a 404 there.
    for (const path of ['/health', '/', '/status', '/printers', '/jobs', '/service', '/pairing']) {
      assert.equal((await fetch(`http://127.0.0.1:${lanPort}${path}`)).status, 404, path);
    }
    // And the LAN routes are still not on 9200.
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/lan/v1/hello`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/health`)).status, 200);

    const ports = listeningPorts(b.pid);
    if (ports === null) t.diagnostic('lsof is not available');
    else assert.deepEqual(ports, [b.port, lanPort].sort((a, c) => a - c));

    assert.ok(existsSync(join(b.dir, 'lan-key.json')), 'the Bridge\'s key exists once the API is on');

    b.child.kill('SIGTERM');
    assert.equal(await b.exited, 0, 'a clean stop');
    await assert.rejects(fetch(`http://127.0.0.1:${lanPort}/lan/v1/hello`));
  });

  it('a LAN port that is taken does not take the Bridge down', async () => {
    const taken = await free();
    const squatter = netServer();
    await new Promise<void>((r) => squatter.listen(taken, '127.0.0.1', r));
    try {
      const b = await startBridge({ enabled: true, port: taken, host: '127.0.0.1' });
      assert.equal((await fetch(`http://127.0.0.1:${b.port}/health`)).status, 200);
      await until(() => /could not listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/.test(b.output()), 'the listen failure to be logged');
      b.child.kill('SIGKILL');
    } finally {
      squatter.close();
    }
  });
});

void haveLsof;
