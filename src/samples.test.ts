import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrinterRecord } from './registry.js';
import { render, type ReceiptDocument, type ReceiptElement } from './render/index.js';
import { resolveSample, sampleFor, sampleKitchenTicket, sampleReceipt, stationBanner } from './samples.js';

/*
 * Which test slip a printer gets.
 *
 * The case that motivated it: a venue pressed Test on its pizza printer, the bridge printed the
 * customer sample (`2x Test item 50,000`, `TOTAL LAK 50,000`, barcode, QR), and staff read it as
 * "the kitchen printer prints bills". A kitchen printer's test slip must not look like a bill.
 */

const pizza: PrinterRecord = {
  id: 'pizza', name: 'Pizza', transport: 'network', type: 'receipt', language: 'escpos',
  enabled: true, address: '192.168.100.170', port: 9100, dots_per_line: 576,
};

const at1119 = new Date(2026, 10, 1, 11, 19);

function elementsOf(doc: unknown): ReceiptElement[] {
  return (doc as ReceiptDocument).elements;
}

function isKitchen(doc: unknown): boolean {
  return !elementsOf(doc).some((e) => e.type === 'columns' && e.left === 'TOTAL');
}

function banner(doc: unknown): string | undefined {
  const big = elementsOf(doc).filter((e) => e.type === 'text' && e.width === 2);
  // The first double-width line is the bridge's own header; the second is the station.
  return big[1]?.type === 'text' ? big[1].value : undefined;
}

describe('resolveSample', () => {
  it('keeps the customer sample for an untagged printer when no main receipt printer is known', () => {
    // Several receipt printers and none named for bills: the registry cannot say, so it stays
    // what every earlier bridge printed.
    assert.deepEqual(resolveSample(pizza), { doc: 'receipt', station: null });
    assert.deepEqual(resolveSample(pizza, {}, { mainReceiptPrinterId: null }), { doc: 'receipt', station: null });
  });

  it('prints a kitchen ticket on an untagged printer that is not the main receipt printer', () => {
    // The venue case: Test pressed on an untagged pizza printer, the bills printer named.
    assert.deepEqual(resolveSample(pizza, {}, { mainReceiptPrinterId: 'bill' }), { doc: 'kitchen', station: 'KITCHEN' });
  });

  it('keeps the customer sample on the main receipt printer itself', () => {
    assert.deepEqual(resolveSample(pizza, {}, { mainReceiptPrinterId: 'pizza' }), { doc: 'receipt', station: null });
  });

  it('lets a role tag beat the main-printer rule', () => {
    assert.deepEqual(resolveSample({ ...pizza, role: 'receipt' }, {}, { mainReceiptPrinterId: 'bill' }), {
      doc: 'receipt', station: null,
    });
    assert.deepEqual(resolveSample({ ...pizza, role: 'kitchen' }, {}, { mainReceiptPrinterId: 'pizza' }), {
      doc: 'kitchen', station: 'KITCHEN',
    });
  });

  it('prints a kitchen ticket for a printer tagged kitchen', () => {
    assert.deepEqual(resolveSample({ ...pizza, role: 'kitchen' }), { doc: 'kitchen', station: 'KITCHEN' });
  });

  it('prints a BAR ticket for a printer tagged bar', () => {
    assert.deepEqual(resolveSample({ ...pizza, role: 'bar' }), { doc: 'kitchen', station: 'BAR' });
  });

  it('keeps the receipt for a printer tagged receipt', () => {
    assert.deepEqual(resolveSample({ ...pizza, role: 'receipt' }), { doc: 'receipt', station: null });
  });

  it('lets the caller override the role either way', () => {
    // The POS knows the slot even when the registry was never tagged — and a printer bound as
    // the bill printer tests as a bill even if someone tagged it kitchen.
    assert.deepEqual(resolveSample(pizza, { doc: 'kitchen', station: 'PIZZA' }), { doc: 'kitchen', station: 'PIZZA' });
    assert.deepEqual(resolveSample({ ...pizza, role: 'kitchen' }, { doc: 'receipt' }), { doc: 'receipt', station: null });
    // ...and over the main-printer rule.
    assert.deepEqual(resolveSample(pizza, { doc: 'receipt' }, { mainReceiptPrinterId: 'bill' }), { doc: 'receipt', station: null });
  });

  it('reads a station on its own as a request for the kitchen ticket', () => {
    assert.deepEqual(resolveSample(pizza, { station: 'hot' }), { doc: 'kitchen', station: 'HOT' });
  });

  it('falls back to the role banner when the station has nothing printable in it', () => {
    assert.deepEqual(resolveSample(pizza, { doc: 'kitchen', station: 'ເຕົາ' }), { doc: 'kitchen', station: 'KITCHEN' });
    // ...and a station alone with nothing printable does not flip an untagged printer to kitchen.
    assert.deepEqual(resolveSample(pizza, { station: '!!' }), { doc: 'receipt', station: null });
  });

  it('always gives a label printer the label', () => {
    const labels: PrinterRecord = { ...pizza, id: 'labels', type: 'label', language: 'tspl', role: 'kitchen' };
    assert.deepEqual(resolveSample(labels, { doc: 'kitchen' }), { doc: 'label', station: null });
    assert.equal(sampleFor(labels, { doc: 'kitchen' }).kind, 'label');
  });
});

describe('stationBanner', () => {
  it('upper-cases and keeps only what a thermal printer prints as text', () => {
    assert.equal(stationBanner('  pizza  '), 'PIZZA');
    assert.equal(stationBanner('cold_prep-2'), 'COLD_PREP-2');
    assert.equal(stationBanner('hot\u001b@\nline'), 'HOTLINE');
  });

  it('caps the banner at 20 characters', () => {
    assert.equal(stationBanner('A'.repeat(30)), 'A'.repeat(20));
  });

  it('is null for nothing printable', () => {
    assert.equal(stationBanner(undefined), null);
    assert.equal(stationBanner('   '), null);
    assert.equal(stationBanner('ພິຊຊ່າ'), null);
  });
});

describe('the kitchen test ticket', () => {
  const ticket = sampleKitchenTicket(pizza, 'PIZZA', at1119);
  const text = render(ticket, pizza).toString('latin1');

  it('carries no money, barcode or QR — nothing a bill has', () => {
    assert.ok(isKitchen(ticket));
    assert.ok(!elementsOf(ticket).some((e) => e.type === 'barcode' || e.type === 'qr'));
    assert.ok(!text.includes('TOTAL'));
    assert.ok(!text.includes('50,000'));
  });

  it('names the station, the order and the time like a real ticket', () => {
    assert.equal(banner(ticket), 'PIZZA');
    assert.ok(text.includes('PIZZA'));
    assert.ok(text.includes('#TEST-0001'));
    assert.ok(text.includes('11:19'));
    assert.ok(text.includes('2x Test item'));
    assert.ok(text.includes('kitchen test ticket'));
  });

  it('keeps the diagnostics a test slip exists for', () => {
    assert.ok(text.includes('Printer'));
    assert.ok(text.includes('pizza'));
    assert.ok(text.includes('576 dots / 48 cols'));
    assert.ok(text.includes('0123456789'));
  });

  it('is what sampleFor renders for a kitchen request', () => {
    assert.deepEqual(sampleFor(pizza, { doc: 'kitchen', station: 'pizza' }, { now: at1119 }), ticket);
  });
});

describe('the customer sample', () => {
  /*
   * Byte for byte what 1.14.7 printed: 979 / 980 / 982 bytes are how those jobs read in a venue
   * log (`bytes=980` on `pizza`), and support matches a log line to "that was a test page" by
   * them. Refactoring the shared header must not move them.
   */
  it('renders exactly as before for an 80 mm ESC/POS printer', () => {
    for (const [id, bytes] of [['bill', 979], ['pizza', 980], ['kitchen', 982]] as const) {
      const printer = { ...pizza, id };
      assert.equal(render(sampleReceipt(printer), printer).length, bytes, id);
    }
  });

  it('still has its price, total, barcode and QR', () => {
    const doc = sampleReceipt(pizza);
    assert.ok(!isKitchen(doc));
    assert.ok(elementsOf(doc).some((e) => e.type === 'barcode'));
    assert.ok(elementsOf(doc).some((e) => e.type === 'qr'));
  });
});
