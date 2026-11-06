import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { sendToPrinter } from './lan.js';
import { lanStatusOf } from './lan-server.js';
import { setLogSink } from './log.js';
import {
  DEFAULT_TOTAL_MS, judge, readPrinterStatus, StatusReadback, SUSPEND_AFTER, supportsReadback, type StatusReading,
} from './printer-status.js';
import { PrintQueue } from './queue.js';
import { parseRegistry, resetRegistryCache, type PrinterRecord } from './registry.js';
import { wireResult } from './relay.js';
import { EscposFakePrinter, type StatusMode } from './test-support/escpos-printer.js';

/*
 * Opt-in status readback against a fake printer that speaks the Epson ESC/POS status bytes.
 * Real printers are NOT exercised anywhere in this file.
 */

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'hankha-status-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let restoreLog: (() => void) | null = null;
beforeEach(() => {
  restoreLog = setLogSink(() => undefined);
});
afterEach(() => restoreLog?.());

const printerRecord = (extra: Partial<PrinterRecord> = {}): PrinterRecord => ({
  id: 'receipt', name: 'Receipt', transport: 'network', type: 'receipt', language: 'escpos', enabled: true,
  address: '192.168.1.50', port: 9100, dots_per_line: 576, status_readback: true, ...extra,
});

/** Short timeouts so the whole file runs in seconds; the logic under test does not depend on them. */
const FAST = { dleReplyMs: 120, gsrReplyMs: 250, totalMs: 900 };

async function withPrinter<T>(mode: StatusMode, body: (p: EscposFakePrinter) => Promise<T>): Promise<T> {
  const fake = await new EscposFakePrinter().start();
  fake.mode = mode;
  try {
    return await body(fake);
  } finally {
    await fake.close();
  }
}

const aim = (fake: EscposFakePrinter) => (_p: PrinterRecord) => ({ host: '127.0.0.1', port: fake.port });
const read = (fake: EscposFakePrinter, options = FAST) => readPrinterStatus(printerRecord(), { ...options, target: aim(fake) });

// ---------------------------------------------------------------------- the reader

describe('readPrinterStatus against the fake ESC/POS printer', () => {
  it('healthy: all four queries answered, nothing wrong', () =>
    withPrinter('healthy', async (fake) => {
      const r = await read(fake);
      assert.equal(r.answered, true);
      assert.equal(r.dle_eot, true);
      assert.equal(r.gs_r, true);
      assert.deepEqual([r.online, r.cover_open, r.paper_end, r.paper_near_end, r.error], [true, false, false, false, false]);
      assert.equal(r.note, undefined);
      assert.deepEqual(fake.queries, ['10 04 01', '10 04 02', '10 04 04', '1d 72 01']);
      assert.equal(fake.printConnections, 0, 'a status read sends no slip');
    }));

  it('paper out is read from DLE EOT 2/4 and GS r', () =>
    withPrinter('paper_out', async (fake) => {
      const r = await read(fake);
      assert.equal(r.paper_end, true);
      assert.equal(judge(r).fault, 'paper_out');
    }));

  it('cover open is read from DLE EOT 2', () =>
    withPrinter('cover_open', async (fake) => {
      const r = await read(fake);
      assert.equal(r.cover_open, true);
      assert.equal(judge(r).fault, 'cover_open');
    }));

  it('an error condition is read from DLE EOT 2', () =>
    withPrinter('error', async (fake) => {
      const r = await read(fake);
      assert.equal(r.error, true);
      assert.equal(judge(r).fault, 'error');
    }));

  it('offline is read from DLE EOT 1', () =>
    withPrinter('offline', async (fake) => {
      const r = await read(fake);
      assert.equal(r.online, false);
    }));

  it('paper near the end is read, and is not a fault', () =>
    withPrinter('near_end', async (fake) => {
      const r = await read(fake);
      assert.equal(r.paper_near_end, true);
      const v = judge(r);
      assert.equal(v.fault, undefined);
      assert.equal(v.confirmed, true);
      assert.equal(v.summary.paper_near_end, true);
    }));

  it('no response: returns within the total timeout, says no_response, decides nothing', () =>
    withPrinter('silent', async (fake) => {
      const started = Date.now();
      const r = await read(fake);
      const took = Date.now() - started;
      assert.equal(r.answered, false);
      assert.equal(r.note, 'no_response');
      assert.ok(took <= FAST.totalMs + 250, `took ${took} ms, limit ${FAST.totalMs}`);
      // The first DLE EOT going unanswered skips 2 and 4, and goes straight to GS r 1.
      assert.deepEqual(fake.queries, ['10 04 01', '1d 72 01']);
      const v = judge(r);
      assert.equal(v.confirmed, false);
      assert.equal(v.fault, undefined);
    }));

  it('garbage: bytes that are not status bytes are rejected, never read as healthy', () =>
    withPrinter('garbage', async (fake) => {
      const r = await read(fake);
      assert.equal(r.answered, false);
      assert.equal(r.note, 'garbage');
      assert.equal(judge(r).confirmed, false);
    }));

  it('closes the socket on the status byte: reported as socket_closed, no throw', () =>
    withPrinter('close_on_status', async (fake) => {
      const started = Date.now();
      const r = await read(fake);
      assert.equal(r.answered, false);
      assert.equal(r.note, 'socket_closed');
      assert.ok(Date.now() - started < FAST.totalMs, 'a hang-up ends the read at once');
    }));

  it('real-time status only: answered, but not confirmed (nothing was answered in order after the data)', () =>
    withPrinter('dle_only', async (fake) => {
      const r = await read(fake);
      assert.equal(r.dle_eot, true);
      assert.equal(r.gs_r, false);
      assert.equal(judge(r).confirmed, false);
    }));

  it('GS r only: confirmed', () =>
    withPrinter('gsr_only', async (fake) => {
      const r = await read(fake);
      assert.equal(r.dle_eot, false);
      assert.equal(r.gs_r, true);
      assert.equal(judge(r).confirmed, true);
    }));

  it('a printer that is not listening is connect_failed, quickly', async () => {
    const fake = await new EscposFakePrinter().start();
    const dead = fake.port;
    await fake.close();
    const started = Date.now();
    const r = await readPrinterStatus(printerRecord(), { ...FAST, target: () => ({ host: '127.0.0.1', port: dead }) });
    assert.equal(r.note, 'connect_failed');
    assert.ok(Date.now() - started < 1500);
  });

  it('a slow GS r (the printer is still printing) is waited for, up to its own limit', () =>
    withPrinter('healthy', async (fake) => {
      fake.gsrDelayMs = 150;
      const r = await read(fake);
      assert.equal(r.gs_r, true);
    }));

  it('the total limit is a hard stop even when every reply is late', () =>
    withPrinter('healthy', async (fake) => {
      fake.gsrDelayMs = 5_000;
      const started = Date.now();
      const r = await readPrinterStatus(printerRecord(), { dleReplyMs: 100, gsrReplyMs: 10_000, totalMs: 500, target: aim(fake) });
      assert.ok(Date.now() - started < 800);
      assert.equal(r.gs_r, false);
      assert.ok(r.took_ms <= 700);
    }));

  it('defaults are short: the lane is never held for more than a few seconds', () => {
    assert.ok(DEFAULT_TOTAL_MS <= 3_000);
  });
});

describe('judge', () => {
  const base: StatusReading = {
    answered: true, dle_eot: true, gs_r: true, online: true, cover_open: false, paper_end: false,
    paper_near_end: false, error: false, took_ms: 5,
  };
  it('a fault wins over everything, in the order paper, cover, error', () => {
    assert.equal(judge({ ...base, paper_end: true, cover_open: true }).fault, 'paper_out');
    assert.equal(judge({ ...base, cover_open: true, error: true }).fault, 'cover_open');
    assert.equal(judge({ ...base, error: true }).fault, 'error');
    assert.equal(judge({ ...base, paper_end: true }).confirmed, false);
  });
  it('offline alone is noted, not a fault and not a confirmation', () => {
    const v = judge({ ...base, online: false });
    assert.equal(v.fault, undefined);
    assert.equal(v.confirmed, false);
    assert.equal(v.summary.offline, true);
  });
  it('mixed good and garbage replies never confirm', () => {
    assert.equal(judge({ ...base, note: 'garbage' }).confirmed, false);
  });
});

// ---------------------------------------------------------------------- the registry setting

describe('status_readback in the registry', () => {
  const entry = (extra: Record<string, unknown> = {}) => ({
    version: 1,
    printers: [{ id: 'r', transport: 'network', address: '192.168.1.50', type: 'receipt', language: 'escpos', ...extra }],
  });

  it('is OFF by default, and a registry that never used it serialises exactly as before', () => {
    const { registry, errors } = parseRegistry(entry());
    assert.deepEqual(errors, []);
    assert.equal(registry.printers[0]?.status_readback, undefined);
    assert.equal('status_readback' in (registry.printers[0] as object), false);
    assert.ok(!JSON.stringify(registry).includes('status_readback'));
  });

  it('true is kept; false is the same as absent', () => {
    assert.equal(parseRegistry(entry({ status_readback: true })).registry.printers[0]?.status_readback, true);
    assert.equal(parseRegistry(entry({ status_readback: false })).registry.printers[0]?.status_readback, undefined);
    assert.equal(parseRegistry(entry({ status_readback: null })).registry.printers[0]?.status_readback, undefined);
  });

  it('a string is refused (the string "false" is truthy), on disk and over PUT alike', () => {
    for (const strict of [false, true]) {
      const { errors, registry } = parseRegistry(entry({ status_readback: 'true' }), { strict });
      assert.match(errors.join(' '), /status_readback must be true or false/);
      assert.equal(registry.printers.length, 0);
    }
    assert.match(parseRegistry(entry({ status_readback: 1 })).errors.join(' '), /true or false/);
  });

  it('PUT (strict) refuses it on a printer that cannot answer; a file on disk merely drops it', () => {
    const cases: Record<string, unknown>[] = [
      { transport: 'usb', queue: 'EPSON', address: undefined },
      { transport: 'serial', device: '/dev/ttyUSB0', address: undefined },
      { type: 'label', language: 'zpl', width_mm: 50, height_mm: 30 },
    ];
    for (const c of cases) {
      const strict = parseRegistry(entry({ status_readback: true, ...c }), { strict: true, strictDevice: true });
      assert.match(strict.errors.join(' '), /status_readback needs a network ESC\/POS receipt printer/, JSON.stringify(c));
      const loose = parseRegistry(entry({ status_readback: true, ...c }));
      assert.deepEqual(loose.errors, [], 'an upgrade must not make a working printer vanish');
      assert.equal(loose.registry.printers[0]?.status_readback, undefined);
    }
  });

  it('supportsReadback is true only for network ESC/POS receipt printers', () => {
    assert.equal(supportsReadback(printerRecord()), true);
    assert.equal(supportsReadback(printerRecord({ transport: 'usb' })), false);
    assert.equal(supportsReadback(printerRecord({ language: 'zpl' })), false);
    assert.equal(supportsReadback(printerRecord({ type: 'label' })), false);
  });
});

// ---------------------------------------------------------------------- the queue

interface Rig {
  q: PrintQueue;
  fake: EscposFakePrinter;
  live: Map<string, PrinterRecord>;
  dir: string;
  restart: () => PrintQueue;
  stop: () => Promise<void>;
}

async function rig(mode: StatusMode, printer = printerRecord()): Promise<Rig> {
  const fake = await new EscposFakePrinter().start();
  fake.mode = mode;
  const dir = scratch();
  const live = new Map<string, PrinterRecord>([[printer.id, printer]]);
  const make = () => {
    const q = new PrintQueue({
      dir,
      // The real socket write, aimed at the fake.
      send: (_p, bytes, timeoutMs) => sendToPrinter('127.0.0.1', fake.port, bytes, timeoutMs, 1_000),
      resolvePrinter: (id) => live.get(id) ?? null,
      readStatus: (p) => readPrinterStatus(p, { ...FAST, target: aim(fake) }),
      maxAttempts: 3,
    });
    q.load();
    return q;
  };
  let q = make();
  return {
    get q() {
      return q;
    },
    fake,
    live,
    dir,
    restart: () => (q = make()),
    stop: async () => {
      await q.drain(200);
      await fake.close();
    },
  } as Rig;
}

const slip = (marker: string) => Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.from(marker), Buffer.from([0x0a])]);

describe('the queue and the opt-in readback', () => {
  it('NOT opted in: no status connection is ever made and the result is exactly what it was', async () => {
    const r = await rig('healthy', printerRecord({ status_readback: undefined }));
    try {
      const printer = r.live.get('receipt') as PrinterRecord;
      const sub = r.q.submit({ source: 'local', printer, payload: slip('PLAIN-1') });
      const job = await sub.settled;
      await r.fake.quiet();
      assert.deepEqual(Object.keys(job.result ?? {}).sort(), ['duration_ms', 'ok']);
      assert.equal(job.result?.ok, true);
      assert.equal(r.fake.statusConnections, 0);
      assert.equal(r.fake.count('PLAIN-1'), 1);
      assert.equal(lanStatusOf('k', job).state, 'bytes_written');
      assert.equal(lanStatusOf('k', job).readback, undefined);
    } finally {
      await r.stop();
    }
  });

  it('opted in, healthy: bytes_written becomes confirmed, with certainty unknown', async () => {
    const r = await rig('healthy');
    try {
      const job = await r.q.submit({ dedupe_key: 'sale-1-r0-aaaa', source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip('OK-1') }).settled;
      await r.fake.quiet();
      assert.equal(job.result?.ok, true);
      assert.equal(job.result?.confirmed, true);
      const s = lanStatusOf('sale-1-r0-aaaa', job);
      assert.equal(s.state, 'confirmed');
      assert.equal(s.certainty, 'unknown');
      assert.equal(s.readback?.answered, true);
      assert.equal(r.fake.printConnections, 1);
      assert.equal(r.fake.statusConnections, 1, 'one extra connection, after the slip');
      assert.equal(r.fake.count('OK-1'), 1);
    } finally {
      await r.stop();
    }
  });

  it('confirmed survives a restart: it is read back from the ring, and a resend prints nothing', async () => {
    const r = await rig('healthy');
    try {
      const key = 'sale-2-r0-bbbb';
      await r.q.submit({ dedupe_key: key, source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip('RING-1') }).settled;
      await r.fake.quiet();
      const q2 = r.restart();
      assert.equal(lanStatusOf(key, q2.get(key)).state, 'confirmed');
      const again = q2.submit({ dedupe_key: key, source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip('RING-1') });
      assert.equal(again.deduplicated, true);
      await r.fake.quiet();
      assert.equal(r.fake.count('RING-1'), 1);
    } finally {
      await r.stop();
    }
  });

  for (const [mode, fault] of [['paper_out', 'paper_out'], ['cover_open', 'cover_open'], ['error', 'error']] as const) {
    it(`${mode}: an UNKNOWN failure, recorded, never resent`, async () => {
      const r = await rig(mode);
      try {
        const key = `sale-3-${mode}-cccc`;
        const job = await r.q.submit({ dedupe_key: key, source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip(`FAULT-${mode}`) }).settled;
        await r.fake.quiet();
        assert.equal(job.result?.ok, false);
        assert.equal(job.result?.reason, 'printer-fault');
        assert.equal(job.result?.printed_certainty, 'unknown');
        assert.equal(job.result?.readback?.fault, fault);
        const s = lanStatusOf(key, job);
        assert.equal(s.state, 'unknown');
        assert.equal(s.certainty, 'unknown');
        assert.equal(s.readback?.fault, fault);
        // The queue's retry rule resends only `none`: exactly one slip went out, and stays one.
        await new Promise((res) => setTimeout(res, 300));
        assert.equal(r.fake.printConnections, 1);
        // And the key is remembered, so the terminal's own resend is answered, not printed.
        const again = r.q.submit({ dedupe_key: key, source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip(`FAULT-${mode}`) });
        assert.equal(again.deduplicated, true);
        await r.fake.quiet();
        assert.equal(r.fake.count(`FAULT-${mode}`), 1);
      } finally {
        await r.stop();
      }
    });
  }

  it('a legacy job (no dedupe key) on an opted-in printer is also settled unknown and reported once', async () => {
    const r = await rig('paper_out');
    try {
      const job = await r.q.submit({ job_id: 'relay-job-9', source: 'relay', printer: r.live.get('receipt') as PrinterRecord, payload: slip('LEGACY-1') }).settled;
      assert.equal(job.status, 'failed');
      assert.equal(job.result?.printed_certainty, 'unknown');
      assert.equal(r.q.pending(), 0);
    } finally {
      await r.stop();
    }
  });

  it('no response: the job is NOT failed, stays bytes_written, and the lane is held no longer than the limit', async () => {
    const r = await rig('silent');
    try {
      const printer = r.live.get('receipt') as PrinterRecord;
      const started = Date.now();
      const first = r.q.submit({ dedupe_key: 'sale-4-a-dddd', source: 'local', printer, payload: slip('SILENT-1') });
      const second = r.q.submit({ dedupe_key: 'sale-4-b-dddd', source: 'local', printer, payload: slip('SILENT-2') });
      const j1 = await first.settled;
      const j2 = await second.settled;
      assert.equal(j1.result?.ok, true);
      assert.equal(lanStatusOf('x', j1).state, 'bytes_written');
      assert.equal(j1.result?.readback?.note, 'no_response');
      assert.equal(j2.result?.ok, true);
      // Two slips, two bounded status reads: nowhere near a stuck lane.
      assert.ok(Date.now() - started < 2 * FAST.totalMs + 1500, `took ${Date.now() - started} ms`);
      await r.fake.quiet();
      assert.equal(r.fake.count('SILENT-1'), 1);
      assert.equal(r.fake.count('SILENT-2'), 1);
    } finally {
      await r.stop();
    }
  });

  it('garbage: not failed, not confirmed', async () => {
    const r = await rig('garbage');
    try {
      const job = await r.q.submit({ dedupe_key: 'sale-5-gggg1', source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip('GARBAGE-1') }).settled;
      assert.equal(job.result?.ok, true);
      assert.equal(job.result?.confirmed, undefined);
      assert.equal(job.result?.readback?.note, 'garbage');
      assert.equal(lanStatusOf('k', job).state, 'bytes_written');
    } finally {
      await r.stop();
    }
  });

  it('closes the socket on the status byte: not failed, not confirmed, the slip is not reprinted', async () => {
    const r = await rig('close_on_status');
    try {
      const job = await r.q.submit({ dedupe_key: 'sale-6-cccc1', source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip('HANGUP-1') }).settled;
      await r.fake.quiet();
      assert.equal(job.result?.ok, true);
      assert.equal(job.result?.readback?.note, 'socket_closed');
      assert.equal(r.fake.count('HANGUP-1'), 1);
      assert.equal(r.fake.printConnections, 1);
    } finally {
      await r.stop();
    }
  });

  it('offline alone changes nothing about the job, only notes it', async () => {
    const r = await rig('offline');
    try {
      const job = await r.q.submit({ dedupe_key: 'sale-7-offl1', source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip('OFFLINE-1') }).settled;
      assert.equal(job.result?.ok, true);
      assert.equal(job.result?.confirmed, undefined);
      assert.equal(job.result?.readback?.offline, true);
    } finally {
      await r.stop();
    }
  });

  it('only the last copy is followed by a status read', async () => {
    const r = await rig('healthy');
    try {
      await r.q.submit({ dedupe_key: 'sale-8-copy1', source: 'local', printer: r.live.get('receipt') as PrinterRecord, payload: slip('COPIES'), copies: 2 }).settled;
      await r.fake.quiet();
      assert.equal(r.fake.printConnections, 2);
      assert.equal(r.fake.statusConnections, 1);
    } finally {
      await r.stop();
    }
  });
});

describe('the per-printer kill', () => {
  it('unticking status_readback takes effect for the very next job, queued ones included', async () => {
    const r = await rig('healthy');
    try {
      const printer = r.live.get('receipt') as PrinterRecord;
      await r.q.submit({ dedupe_key: 'kill-1-aaaaaaa', source: 'local', printer, payload: slip('K1') }).settled;
      assert.equal(r.fake.statusConnections, 1);
      // The operator turns it off in the registry; the job below carries the OLD snapshot.
      r.live.set('receipt', { ...printer, status_readback: undefined });
      const job = await r.q.submit({ dedupe_key: 'kill-2-aaaaaaa', source: 'local', printer, payload: slip('K2') }).settled;
      await r.fake.quiet();
      assert.equal(r.fake.statusConnections, 1, 'no second status read');
      assert.equal(job.result?.readback, undefined);
      assert.equal(r.q.readback.stateOf(printer), 'off');
    } finally {
      await r.stop();
    }
  });

  it('PRINT_BRIDGE_STATUS_READBACK=off turns every printer off', async () => {
    const r = await rig('healthy');
    const previous = process.env.PRINT_BRIDGE_STATUS_READBACK;
    process.env.PRINT_BRIDGE_STATUS_READBACK = 'off';
    try {
      const printer = r.live.get('receipt') as PrinterRecord;
      await r.q.submit({ dedupe_key: 'kill-3-aaaaaaa', source: 'local', printer, payload: slip('K3') }).settled;
      assert.equal(r.fake.statusConnections, 0);
      assert.equal(r.q.readback.stateOf(printer), 'off');
    } finally {
      if (previous === undefined) delete process.env.PRINT_BRIDGE_STATUS_READBACK;
      else process.env.PRINT_BRIDGE_STATUS_READBACK = previous;
      await r.stop();
    }
  });

  it(`a model that gives nothing usable ${SUSPEND_AFTER} times in a row is cut off by itself`, async () => {
    const r = await rig('silent');
    try {
      const printer = r.live.get('receipt') as PrinterRecord;
      for (let i = 0; i < SUSPEND_AFTER; i += 1) {
        assert.equal(r.q.readback.stateOf(printer), 'on');
        await r.q.submit({ dedupe_key: `kill-4-${i}-aaaaa`, source: 'local', printer, payload: slip(`S${i}`) }).settled;
      }
      assert.equal(r.q.readback.stateOf(printer), 'suspended');
      const before = r.fake.statusConnections;
      const started = Date.now();
      const job = await r.q.submit({ dedupe_key: 'kill-4-after-aa', source: 'local', printer, payload: slip('AFTER') }).settled;
      assert.equal(job.result?.ok, true);
      assert.equal(r.fake.statusConnections, before, 'suspended: no more status reads');
      assert.ok(Date.now() - started < FAST.totalMs / 2, 'and no more timeouts on the lane');
      // Saving the printer list is how an operator says "try again".
      r.q.readback.clear();
      assert.equal(r.q.readback.stateOf(printer), 'on');
    } finally {
      await r.stop();
    }
  });

  it('a usable answer resets the count: two silent reads, a healthy one, two silent again are not suspended', async () => {
    const reads: StatusReading[] = [];
    const blank: StatusReading = { answered: false, dle_eot: false, gs_r: false, online: true, cover_open: false, paper_end: false, paper_near_end: false, error: false, took_ms: 1, note: 'no_response' };
    const healthy: StatusReading = { ...blank, answered: true, gs_r: true, note: undefined };
    const script = [blank, blank, healthy, blank, blank];
    const printer = printerRecord();
    const rb = new StatusReadback(async () => script[reads.push(blank) - 1] as StatusReading, () => printer, () => false);
    for (let i = 0; i < script.length; i += 1) await rb.check(printer);
    assert.equal(rb.stateOf(printer), 'on');
  });

  it('a connect failure right after a good send is not held against the model', async () => {
    const printer = printerRecord();
    const gone: StatusReading = { answered: false, dle_eot: false, gs_r: false, online: true, cover_open: false, paper_end: false, paper_near_end: false, error: false, took_ms: 1, note: 'connect_failed' };
    const rb = new StatusReadback(async () => gone, () => printer, () => false);
    for (let i = 0; i < SUSPEND_AFTER + 2; i += 1) await rb.check(printer);
    assert.equal(rb.stateOf(printer), 'on');
  });

  it('a reader that throws is swallowed: the job is untouched', async () => {
    const printer = printerRecord();
    const rb = new StatusReadback(async () => { throw new Error('boom'); }, () => printer, () => false);
    assert.equal(await rb.check(printer), null);
  });
});

describe('what goes to the server', () => {
  it('a result without readback fields is sent untouched', () => {
    const r = { ok: true, duration_ms: 12 };
    assert.deepEqual(wireResult(r), r);
  });
  it('confirmed and readback are stripped; printer-fault is sent as spooler-error with unknown certainty', () => {
    assert.deepEqual(
      wireResult({ ok: true, duration_ms: 3, confirmed: true, readback: { answered: true } }),
      { ok: true, duration_ms: 3 }
    );
    const fault = wireResult({
      ok: false, reason: 'printer-fault', printed_certainty: 'unknown', detail: 'the printer reports paper out',
      readback: { answered: true, fault: 'paper_out' },
    });
    assert.equal(fault.reason, 'spooler-error');
    assert.equal(fault.printed_certainty, 'unknown');
    assert.match(fault.detail ?? '', /paper out/);
    assert.equal('readback' in fault, false);
  });
});

describe('PUT /printers keeps the opt-in through a save and a reload', () => {
  it('round trips through printers.json', async () => {
    const dir = scratch();
    const previous = process.env.PRINT_BRIDGE_STATE_DIR;
    process.env.PRINT_BRIDGE_STATE_DIR = dir;
    try {
      const { registry } = parseRegistry({ version: 1, printers: [printerRecord()] }, { strict: true });
      writeFileSync(join(dir, 'printers.json'), JSON.stringify(registry));
      resetRegistryCache();
      const { loadRegistry } = await import('./registry.js');
      assert.equal(loadRegistry().printers[0]?.status_readback, true);
    } finally {
      if (previous === undefined) delete process.env.PRINT_BRIDGE_STATE_DIR;
      else process.env.PRINT_BRIDGE_STATE_DIR = previous;
      resetRegistryCache();
    }
  });
});
