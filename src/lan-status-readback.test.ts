import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { lanStatusOf } from './lan-server.js';
import { setLogSink } from './log.js';
import type { JobRecord } from './queue.js';
import { readPrinterStatus } from './printer-status.js';
import { EscposFakePrinter } from './test-support/escpos-printer.js';
import { jobBody, KITCHEN_PRINTER, LanHarness, RECEIPT_PRINTER } from './test-support/lan-harness.js';

/*
 * The opt-in status readback seen from the LAN API: the new `confirmed` state, the `readback`
 * object, the printers listing, and what a resend of a faulted slip does. Fake printers only.
 */

let restoreLog: (() => void) | null = null;
beforeEach(() => {
  restoreLog = setLogSink(() => undefined);
});
afterEach(() => restoreLog?.());

describe('certainty on /lan/v1/jobs/status can never invite a resend', () => {
  const job = (status: JobRecord['status'], result?: JobRecord['result']): JobRecord =>
    ({ job_id: 'j', status, updated_at: '2026-11-07T10:00:00.000Z', ...(result ? { result } : {}) }) as JobRecord;

  it('every state that means bytes may be on the wire or paper may be out says unknown, never none', () => {
    const cases: [string, JobRecord][] = [
      ['sending', job('printing')],
      ['bytes_written', job('done', { ok: true })],
      ['confirmed', job('done', { ok: true, confirmed: true, readback: { answered: true } })],
      ['unknown (interrupted)', job('failed', { ok: false, reason: 'write-timeout', printed_certainty: 'unknown' })],
      ['unknown (printer fault)', job('failed', { ok: false, reason: 'printer-fault', printed_certainty: 'unknown', readback: { answered: true, fault: 'paper_out' } })],
    ];
    for (const [name, j] of cases) {
      assert.equal(lanStatusOf('sale-0001-r0', j).certainty, 'unknown', name);
    }
  });

  it('none is reserved for the states where nothing reached the printer', () => {
    assert.equal(lanStatusOf('k', job('queued')).certainty, 'none');
    assert.equal(lanStatusOf('k', job('failed', { ok: false, reason: 'connect-refused', printed_certainty: 'none' })).certainty, 'none');
    assert.equal(lanStatusOf('k', null).certainty, 'none');
  });
});

describe('LAN API with status readback', () => {
  let h: LanHarness;
  let status: EscposFakePrinter;

  before(async () => {
    status = await new EscposFakePrinter().start();
    h = await LanHarness.start({
      printers: [{ ...RECEIPT_PRINTER, status_readback: true }, KITCHEN_PRINTER],
      queue: {
        readStatus: (p) => readPrinterStatus(p, { dleReplyMs: 120, gsrReplyMs: 250, totalMs: 900, target: () => ({ host: '127.0.0.1', port: status.port }) }),
      },
    });
  });
  after(async () => {
    await h.stop();
    await status.close();
  });

  const state = async (key: string) => {
    const r = await h.terminal.call('POST', '/lan/v1/jobs/status', { keys: [key] });
    assert.equal(r.status, 200);
    return r.json.jobs[0];
  };

  it('a healthy printer: the job reads confirmed, with certainty unknown', async () => {
    status.mode = 'healthy';
    const r = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('readback-ok-0001'));
    assert.equal(r.status, 202);
    await h.idle();
    const s = await state('readback-ok-0001');
    assert.equal(s.state, 'confirmed');
    assert.equal(s.certainty, 'unknown');
    assert.equal(s.readback.answered, true);
  });

  it('paper out: unknown with the fault named, and a resend under the same key prints nothing', async () => {
    status.mode = 'paper_out';
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('readback-paper-001', 'PAPER-OUT-SLIP'));
    await h.idle();
    const s = await state('readback-paper-001');
    assert.equal(s.state, 'unknown');
    assert.equal(s.certainty, 'unknown');
    assert.equal(s.readback.fault, 'paper_out');
    assert.match(s.error, /paper out/);
    const sends = h.sends;
    const again = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('readback-paper-001', 'PAPER-OUT-SLIP'));
    assert.equal(again.status, 202);
    assert.equal(again.json.deduplicated, true);
    assert.equal(again.json.job.state, 'unknown');
    await h.idle();
    assert.equal(h.sends, sends, 'no second send');
  });

  it('a printer that stays silent: still bytes_written, with the note', async () => {
    status.mode = 'silent';
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('readback-quiet-001'));
    await h.idle();
    const s = await state('readback-quiet-001');
    assert.equal(s.state, 'bytes_written');
    assert.equal(s.readback.note, 'no_response');
  });

  it('GET /printers lists the readback state per printer', async () => {
    status.mode = 'healthy';
    h.queue.readback.clear();
    const r = await h.terminal.call('GET', '/lan/v1/printers');
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.json.printers.map((p: any) => [p.id, p]));
    assert.equal(byId.receipt.status_readback, 'on');
    assert.equal(byId.kitchen.status_readback, 'off');
  });

  it('a printer that did not opt in never gets a status byte, through the LAN API either', async () => {
    status.mode = 'healthy';
    const before = status.statusConnections;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('readback-none-001', 'KITCHEN-SLIP', { printer_id: 'kitchen', dots_per_line: 384 }));
    await h.idle();
    const s = await state('readback-none-001');
    assert.equal(s.state, 'bytes_written');
    assert.equal(s.readback, undefined);
    assert.equal(status.statusConnections, before);
  });
});
