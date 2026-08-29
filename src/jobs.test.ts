import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderJobDocument } from './jobs.js';
import type { PrinterRecord } from './registry.js';

/**
 * Rendering a document that arrived over the RELAY.
 *
 * The relay used to carry pre-rendered bytes and nothing else, which meant the POS decided the
 * paper width. That is fine on a till wired to its own printer and wrong everywhere else: a
 * tablet is paired to a station it has never seen and cannot know whether the roll is 58 mm or
 * 80 mm. Sending the document instead lets the machine holding the printer render for it.
 *
 * `renderJobDocument` is the seam. It shares `prepare()`'s parsing, size cap and error handling
 * — the relay only resolves the printer differently, so that it can report `device-missing`
 * against the id or address the server actually sent.
 */

function receiptPrinter(over: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: 'till',
    name: 'Till',
    transport: 'network',
    type: 'receipt',
    language: 'escpos',
    enabled: true,
    address: '192.168.18.103',
    port: 9100,
    dots_per_line: 576,
    ...over,
  };
}

function labelPrinter(over: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: 'labels',
    name: 'Labels',
    transport: 'network',
    type: 'label',
    language: 'tspl',
    enabled: true,
    address: '192.168.18.104',
    port: 9100,
    width_mm: 50,
    height_mm: 30,
    gap_mm: 2,
    dpi: 203,
    ...over,
  };
}

describe('renderJobDocument', () => {
  it('renders a receipt document to ESC/POS bytes', () => {
    const out = renderJobDocument(
      { kind: 'receipt', elements: [{ type: 'text', value: 'TOTAL 25,000' }] },
      receiptPrinter(),
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    // `ESC @` initialises every slip this renderer emits.
    assert.equal(out.payload.subarray(0, 2).toString('latin1'), '\x1b@');
    assert.match(out.payload.toString('latin1'), /TOTAL 25,000/);
  });

  /*
   * Renders for the PRINTER, not for a width the caller guessed. This is the entire reason the
   * document form exists, so it is worth pinning: the same document on a 58 mm roll must not
   * produce the same bytes as on 80 mm.
   */
  it('lays out to the destination printer’s own paper width', () => {
    const doc = {
      kind: 'receipt' as const,
      elements: [{ type: 'columns', left: 'Coffee', right: '25,000' }],
    };
    const wide = renderJobDocument(doc, receiptPrinter({ dots_per_line: 576 }));
    const narrow = renderJobDocument(doc, receiptPrinter({ dots_per_line: 384 }));
    assert.equal(wide.ok && narrow.ok, true);
    if (!wide.ok || !narrow.ok) return;
    assert.notEqual(wide.payload.toString('latin1'), narrow.payload.toString('latin1'));
  });

  it('dispatches on the document’s own kind, and speaks the label printer’s language', () => {
    const out = renderJobDocument(
      {
        kind: 'label',
        elements: [{ type: 'text', x: 10, y: 10, value: 'BATCH 42' }],
      },
      labelPrinter(),
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    // TSPL is line-oriented and starts by declaring the media.
    assert.match(out.payload.toString('latin1'), /^SIZE 50 mm,30 mm/);
  });

  /*
   * The anti-regression that matters most on this path. An earlier sanitiser silently DROPPED
   * codepoints it could not encode, so `2x <Lao dish>` printed as `2x ` with no error anywhere
   * — a kitchen ticket that named no dish. Lao is in no ESC/POS code page (CP874 is Thai), so
   * the only correct answer is to refuse and say what to send instead.
   */
  it('refuses Lao text rather than dropping it, and names the way out', () => {
    const out = renderJobDocument(
      { kind: 'receipt', elements: [{ type: 'text', value: '2x ເຂົ້າຜັດໄກ່' }] },
      receiptPrinter(),
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.errors.join(' '), /'image' element/);
  });

  it('returns a receipt-on-a-label-printer as an error, never as a truncated slip', () => {
    const out = renderJobDocument(
      { kind: 'receipt', elements: [{ type: 'text', value: 'BILL' }] },
      labelPrinter(),
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.errors.join(' '), /TSPL/);
  });

  it('reports every problem with a malformed document rather than throwing', () => {
    const out = renderJobDocument({ kind: 'receipt', elements: 'not-an-array' }, receiptPrinter());
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.ok(out.errors.length > 0);
  });

  it('treats a document that is not an object as a parse failure, not a crash', () => {
    for (const bad of [null, undefined, 42, 'receipt']) {
      const out = renderJobDocument(bad, receiptPrinter());
      assert.equal(out.ok, false, `expected ${String(bad)} to be refused`);
    }
  });
});
