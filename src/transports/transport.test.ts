import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { PrinterRecord, TransportKind } from '../registry.js';
import { DRIVERS, driverFor } from './index.js';
import { resetCommandCache } from './exec.js';
import { normalizeDevicePath } from './serial.js';

/*
 * Two things are pinned here.
 *
 * The CONTRACT: every driver answers the same four questions, so the queue can hold one reference
 * and never branch on which kind it has.
 *
 * The CERTAINTY: each driver's own answer to "could this have printed?". That single field decides
 * whether the queue is allowed to retry, so a driver that guesses generously hands a customer two
 * receipts and one that guesses meanly leaves a printer silent.
 */

const dirs: string[] = [];
const servers: Server[] = [];
let originalPath = '';

before(() => {
  originalPath = process.env.PATH ?? '';
});
after(() => {
  process.env.PATH = originalPath;
  resetCommandCache();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.close();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-transport-'));
  dirs.push(dir);
  return dir;
}

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      resolve({ server, port: address.port });
    });
  });
}

function printer(overrides: Partial<PrinterRecord> & { transport: TransportKind }): PrinterRecord {
  return {
    id: 'p', name: 'p', type: 'receipt', language: 'escpos', enabled: true, ...overrides,
  };
}

describe('the driver contract', () => {
  it('is satisfied by every transport kind', () => {
    for (const [kind, driver] of Object.entries(DRIVERS)) {
      assert.equal(driver.kind, kind, 'a driver must report the kind it is registered under');
      assert.equal(typeof driver.isAvailable, 'function');
      assert.equal(typeof driver.probe, 'function');
      assert.equal(typeof driver.send, 'function');
    }
  });

  it('exposes query only where the channel is two-way', () => {
    // A print spooler is one-way by construction. A stub returning null would make "the printer
    // did not answer" and "this transport cannot ask" indistinguishable.
    assert.equal(typeof driverFor('network').query, 'function');
    assert.equal(driverFor('usb').query, undefined);
  });
});

describe('network', () => {
  it('writes the bytes to the printer and reports success', async () => {
    const { server, port } = await listen();
    const received: Buffer[] = [];
    server.on('connection', (socket) => socket.on('data', (chunk: Buffer) => received.push(chunk)));

    const outcome = await driverFor('network').send(
      printer({ transport: 'network', address: '127.0.0.1', port }), Buffer.from('\x1b@HI'), 2000
    );
    assert.equal(outcome.ok, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(Buffer.concat(received).toString(), '\x1b@HI');
  });

  it('classifies a refused connection as certainly-not-printed', async () => {
    const { server, port } = await listen();
    await new Promise<void>((r) => server.close(() => r()));
    const outcome = await driverFor('network').send(
      printer({ transport: 'network', address: '127.0.0.1', port }), Buffer.from('x'), 1000
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.printed_certainty, 'none');
  });

  it('fails without an address rather than dialling nothing', async () => {
    const outcome = await driverFor('network').send(printer({ transport: 'network' }), Buffer.from('x'), 500);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'device-missing');
    assert.equal(outcome.printed_certainty, 'none');
  });

  it('reads a reply back, which is what identify needs', async () => {
    const { server, port } = await listen();
    server.on('connection', (socket) => {
      socket.on('data', () => socket.write('EPSON TM-T88'));
    });
    const reply = await driverFor('network').query?.(
      printer({ transport: 'network', address: '127.0.0.1', port }), Buffer.from([0x1d, 0x49, 67]), 400
    );
    assert.equal(reply?.toString(), 'EPSON TM-T88');
  });
});

describe('usb (OS spooler)', () => {
  const posix = process.platform !== 'win32';

  function fakeSpooler(script: string): void {
    const dir = scratch();
    for (const name of ['lp', 'lpstat']) {
      const path = join(dir, name);
      writeFileSync(path, script);
      chmodSync(path, 0o755);
    }
    process.env.PATH = `${dir}:${originalPath}`;
    resetCommandCache();
  }

  it('accepts a job the spooler took', async (t) => {
    if (!posix) return t.skip('CUPS path is posix only');
    // Reads stdin to completion, then exits 0 — what a real `lp` does on success.
    fakeSpooler('#!/bin/sh\ncat > /dev/null\necho "request id is q-1 (1 file(s))"\nexit 0\n');

    const outcome = await driverFor('usb').send(printer({ transport: 'usb', queue: 'q' }), Buffer.from('x'), 3000);
    assert.equal(outcome.ok, true);
  });

  it('calls a rejected job certainly-not-printed', async (t) => {
    if (!posix) return t.skip('CUPS path is posix only');
    fakeSpooler('#!/bin/sh\ncat > /dev/null\necho "lp: The printer or class does not exist." >&2\nexit 1\n');

    const outcome = await driverFor('usb').send(printer({ transport: 'usb', queue: 'nope' }), Buffer.from('x'), 3000);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    // CUPS accepts a job atomically: it either creates one or it creates nothing. That is what
    // makes this the safe-to-retry class.
    assert.equal(outcome.printed_certainty, 'none');
    assert.equal(outcome.reason, 'device-missing');
  });

  it('calls a spooler that hung MIGHT-have-printed', async (t) => {
    if (!posix) return t.skip('CUPS path is posix only');
    fakeSpooler('#!/bin/sh\ncat > /dev/null\nsleep 30\n');

    const outcome = await driverFor('usb').send(printer({ transport: 'usb', queue: 'q' }), Buffer.from('x'), 300);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    // It read the document before we killed it, so a job may be sitting in the queue.
    assert.equal(outcome.printed_certainty, 'unknown');
    assert.equal(outcome.reason, 'write-timeout');
  });

  it('is unavailable when the machine has no spooler, and says so instead of failing oddly', async () => {
    const empty = scratch();
    process.env.PATH = empty;
    resetCommandCache();

    assert.equal(driverFor('usb').isAvailable(), false, 'this is the container case');
    const outcome = await driverFor('usb').send(printer({ transport: 'usb', queue: 'q' }), Buffer.from('x'), 500);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'not-supported');
    assert.equal(outcome.printed_certainty, 'none');
  });

  it('lists the queues the spooler reports', async (t) => {
    if (!posix) return t.skip('CUPS path is posix only');
    fakeSpooler('#!/bin/sh\nprintf "printer SPRT_SP_EP is idle.  enabled since Thu\\nprinter Zebra_TLP is idle.\\n"\n');

    const found = (await driverFor('usb').discover?.(3000)) ?? [];
    assert.deepEqual(found.map((p) => p.queue), ['SPRT_SP_EP', 'Zebra_TLP']);
    assert.equal(found[0]?.transport, 'usb');
  });
});

describe('serial', () => {
  it('stays available everywhere, because a container can be given a device', () => {
    // Unlike the spooler: `--device=/dev/ttyUSB0` is a real deployment, so the honest answer is
    // "the driver works, ask a specific device whether it is there".
    assert.equal(driverFor('serial').isAvailable(), true);
  });

  it('reports a missing device as certainly-not-printed', async () => {
    const outcome = await driverFor('serial').send(
      printer({ transport: 'serial', device: join(scratch(), 'not-a-tty') }), Buffer.from('x'), 500
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason, 'device-missing');
    assert.equal(outcome.printed_certainty, 'none');
  });

  it('prefers the macOS call-out device over the dial-in one', (t) => {
    if (process.platform !== 'darwin') return t.skip('darwin only');
    // Opening /dev/tty.* blocks until carrier detect, which a printer never asserts — the open
    // never returns and the job simply disappears. /dev/cu.* skips that wait.
    assert.equal(normalizeDevicePath('/dev/tty.RPP02N-SPP'), '/dev/cu.RPP02N-SPP');
    assert.equal(normalizeDevicePath('/dev/cu.usbserial-10'), '/dev/cu.usbserial-10');
  });

  it('rewrites a COM port to its device path', (t) => {
    if (process.platform !== 'win32') return t.skip('windows only');
    // The bare name stops working past COM9, and the failure is an ENOENT on a port the operator
    // can see in Device Manager.
    assert.equal(normalizeDevicePath('COM10'), '\\\\.\\COM10');
  });
});
