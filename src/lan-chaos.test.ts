import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakePrinter, jobBody, mintTicket, RECEIPT_PRINTER, TestTerminal } from './test-support/lan-harness.js';

/*
 * `kill -9` at each state, with a real process, a real spool on disk and a real printer socket.
 *
 * The harness's `CHILD_MODE` stops a job exactly where the test wants to cut the power: before it
 * is sent, with bytes on the wire, after the bytes were written but before the Bridge recorded
 * them, and after everything was recorded. After each kill a NEW process reads the same directory,
 * and the printer counts what it was sent. The rule under test: queued work resumes, anything that
 * might have reached the paper is never sent again, and nothing prints twice.
 *
 * Integration tested on this machine. Not a physical printer.
 */

const CHILD = fileURLToPath(new URL('./test-support/lan-child.ts', import.meta.url));
const backend = generateKeyPairSync('ed25519');
const backendSpki = backend.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

let dir = '';
let printer: FakePrinter;
const children: ChildProcess[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hankha-chaos-'));
  writeFileSync(join(dir, 'printers.json'), JSON.stringify({ version: 1, printers: [RECEIPT_PRINTER] }));
  printer = await new FakePrinter().start();
});
after(async () => {
  for (const c of children) c.kill('SIGKILL');
  await printer.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Running {
  proc: ChildProcess;
  port: number;
  bridgePubkey: string;
  events: string[];
  waitFor(event: string, timeoutMs?: number): Promise<void>;
  kill9(): Promise<void>;
}

async function startBridge(mode: 'refuse' | 'hang' | 'write-hang' | 'real'): Promise<Running> {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    env: {
      ...process.env,
      CHILD_STATE_DIR: dir,
      PRINT_BRIDGE_STATE_DIR: dir,
      CHILD_MODE: mode,
      CHILD_PRINTER_PORT: String(printer.port),
      CHILD_BACKEND_SPKI: backendSpki,
      PRINT_BRIDGE_LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  const events: string[] = [];
  let ready: { port: number; bridge_pubkey: string } | null = null;
  let buffer = '';
  proc.stdout?.on('data', (c: Buffer) => {
    buffer += c.toString();
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const e = JSON.parse(line) as { event: string; port?: number; bridge_pubkey?: string };
        events.push(e.event);
        if (e.event === 'READY') ready = { port: e.port as number, bridge_pubkey: e.bridge_pubkey as string };
      } catch {
        /* a log line */
      }
    }
  });
  const waitFor = async (event: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!events.includes(event)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${event}; saw ${events.join(',')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await waitFor('READY');
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  return {
    proc,
    port: (ready as unknown as { port: number }).port,
    bridgePubkey: (ready as unknown as { bridge_pubkey: string }).bridge_pubkey,
    events,
    waitFor,
    kill9: async () => {
      proc.kill('SIGKILL');
      await exited;
    },
  };
}

/** The same terminal and key across restarts; a new nonce from each new process. */
const terminal = new TestTerminal(() => base);
let base = '';
async function connect(b: Running): Promise<void> {
  base = `http://127.0.0.1:${b.port}`;
  terminal.ticket = mintTicket(backend.privateKey, { bridge_pubkey: b.bridgePubkey, terminal_pubkey: terminal.spki });
  await terminal.hello();
}
const post = (key: string, marker: string) => terminal.call('POST', '/lan/v1/jobs', jobBody(key, marker));
const status = async (key: string) => (await terminal.call('POST', '/lan/v1/jobs/status', { keys: [key] })).json.jobs[0];
async function until(ready: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('kill -9 and restart', () => {
  it('while queued (printer off): the work resumes in order, once, when the printer is back', async () => {
    const first = await startBridge('refuse');
    await connect(first);
    for (const n of [1, 2, 3]) assert.equal((await post(`chaos-queued-${n}`, `QUEUED-${n}-`)).status, 202);
    await first.waitFor('ATTEMPT');
    assert.equal((await status('chaos-queued-1')).state, 'queued');
    await first.kill9();
    assert.equal(printer.count('QUEUED-'), 0, 'nothing reached the printer while it was off');

    const second = await startBridge('real');
    await connect(second);
    await until(async () => (await status('chaos-queued-3')).state === 'bytes_written');
    await printer.quiet();
    const printed = Buffer.concat(printer.received).toString('latin1');
    assert.deepEqual(
      ['QUEUED-1-', 'QUEUED-2-', 'QUEUED-3-'].map((m) => printed.split(m).length - 1),
      [1, 1, 1], 'each exactly once'
    );
    assert.ok(printed.indexOf('QUEUED-1-') < printed.indexOf('QUEUED-2-') && printed.indexOf('QUEUED-2-') < printed.indexOf('QUEUED-3-'), 'in the order they were sent');

    // The terminal resends everything it is unsure of: all answered, nothing printed.
    for (const n of [1, 2, 3]) {
      const again = await post(`chaos-queued-${n}`, `QUEUED-${n}-`);
      assert.equal(again.json.deduplicated, true);
    }
    await printer.quiet();
    assert.equal(printer.count('QUEUED-'), 3);
    await second.kill9();
  });

  it('with the bytes on the wire: UNKNOWN, never sent again, and a resend is answered', async () => {
    const first = await startBridge('hang');
    await connect(first);
    assert.equal((await post('chaos-sending-1', 'SENDING-MARK')).status, 202);
    await first.waitFor('SENDING');
    assert.equal((await status('chaos-sending-1')).state, 'sending');
    await first.kill9();

    const second = await startBridge('real');
    await connect(second);
    const s = await status('chaos-sending-1');
    assert.equal(s.state, 'unknown');
    assert.equal(s.certainty, 'unknown');
    await new Promise((r) => setTimeout(r, 500));
    const again = await post('chaos-sending-1', 'SENDING-MARK');
    assert.equal(again.json.deduplicated, true);
    assert.equal(again.json.job.state, 'unknown');
    await printer.quiet();
    assert.equal(printer.count('SENDING-MARK'), 0, 'it is not resent: it may be on the paper, and only a person can look');
    await second.kill9();
  });

  it('after the bytes were written but before the Bridge recorded it: the paper is out, so it is UNKNOWN and is not printed again', async () => {
    const first = await startBridge('write-hang');
    await connect(first);
    assert.equal((await post('chaos-written-1', 'WRITTEN-MARK')).status, 202);
    await first.waitFor('WRITTEN');
    await printer.quiet();
    assert.equal(printer.count('WRITTEN-MARK'), 1, 'the slip came out');
    await first.kill9();

    const second = await startBridge('real');
    await connect(second);
    assert.equal((await status('chaos-written-1')).state, 'unknown');
    const again = await post('chaos-written-1', 'WRITTEN-MARK');
    assert.equal(again.json.deduplicated, true);
    await new Promise((r) => setTimeout(r, 500));
    await printer.quiet();
    assert.equal(printer.count('WRITTEN-MARK'), 1, 'still one slip');
    await second.kill9();
  });

  it('after everything was recorded: BYTES_WRITTEN survives, and a resend is answered', async () => {
    const first = await startBridge('real');
    await connect(first);
    assert.equal((await post('chaos-done-1', 'DONE-MARK')).status, 202);
    await until(async () => (await status('chaos-done-1')).state === 'bytes_written');
    await first.kill9();

    const second = await startBridge('real');
    await connect(second);
    assert.equal((await status('chaos-done-1')).state, 'bytes_written');
    const again = await post('chaos-done-1', 'DONE-MARK');
    assert.equal(again.json.deduplicated, true);
    await printer.quiet();
    assert.equal(printer.count('DONE-MARK'), 1);
    await second.kill9();
  });
});
