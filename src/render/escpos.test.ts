import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrinterRecord } from '../registry.js';
import { charsPerLine, encodeText, PRINT_FALLBACKS, renderReceiptEscPos, RenderError, twoColumns } from './escpos.js';
import { parseReceiptDocument, rasterRowBytes } from './document.js';

const printer: PrinterRecord = {
  id: 'counter', name: 'Counter', transport: 'network', type: 'receipt',
  language: 'escpos', enabled: true, address: '192.168.1.50', port: 9100, dots_per_line: 576,
};

/** Find a byte sequence, so a test can assert a command is present without pinning its neighbours. */
function contains(haystack: Buffer, needle: number[]): boolean {
  return haystack.includes(Buffer.from(needle));
}

function build(elements: unknown[]): Buffer {
  const parsed = parseReceiptDocument({ elements, cut: false });
  assert.deepEqual(parsed.errors, [], 'document should validate');
  assert.ok(parsed.document);
  return renderReceiptEscPos(parsed.document, printer);
}

describe('encodeText', () => {
  it('passes ASCII through unchanged', () => {
    assert.equal(Buffer.from(encodeText('Latte x2  25,000').bytes).toString(), 'Latte x2  25,000');
  });

  it('maps the kip sign, which is in no ESC/POS code page', () => {
    const encoded = encodeText('Total ₭25,000');
    assert.deepEqual(encoded.unprintable, []);
    assert.equal(Buffer.from(encoded.bytes).toString(), 'Total LAK25,000');
  });

  it('maps typographic punctuation rather than reporting it', () => {
    // The terminal's encoder once rastered smart quotes it could already map. Keeping the table
    // and the reporting in step is what stops that.
    const encoded = encodeText('“Dok Champa’s” — café');
    assert.deepEqual(encoded.unprintable, ['é']);
    assert.ok(Buffer.from(encoded.bytes).toString().startsWith('"Dok Champa\'s" - caf'));
  });

  /*
   * THE regression this whole encoder is shaped around. `sanitizeForPrint` in the POS terminal once
   * dropped every codepoint it did not recognise, so `2x <Lao dish>` printed as `2x ` — a blank
   * line, with no error anywhere. Lao is in NO ESC/POS code page, so the only honest answers are a
   * raster or a refusal. Never a silent gap.
   */
  it('REPORTS Lao instead of dropping it', () => {
    const encoded = encodeText('2x ເຂົ້າ');
    assert.ok(encoded.unprintable.length > 0, 'Lao must be reported, never silently dropped');
    assert.equal(Buffer.from(encoded.bytes).toString(), '2x ');
  });

  it('has no duplicate keys in the fallback table', () => {
    // Written as \\u escapes for exactly this reason: seven kinds of space look identical in source.
    assert.equal(new Set(Object.keys(PRINT_FALLBACKS)).size, Object.keys(PRINT_FALLBACKS).length);
  });
});

describe('layout', () => {
  it('sizes a line from the paper width and the font', () => {
    assert.equal(charsPerLine(576, 'A'), 48);
    assert.equal(charsPerLine(576, 'B'), 64);
    assert.equal(charsPerLine(384, 'A'), 32);
  });

  it('pads two columns to exactly the line width', () => {
    const line = twoColumns('Latte', '25,000', 32);
    assert.equal(line.length, 32);
    assert.ok(line.endsWith('25,000'));
  });

  it('keeps a space between a long name and its price', () => {
    // Without this the price runs into the name and the receipt is unreadable at the one place
    // that matters.
    const line = twoColumns('A'.repeat(40), '25,000', 20);
    assert.equal(line.length, 20);
    assert.ok(line.includes(' 25,000'));
  });
});

describe('command bytes', () => {
  it('starts with ESC @, so the printer is not left in a previous job state', () => {
    const bytes = build([{ type: 'text', value: 'hi' }]);
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]);
  });

  it('emits alignment, bold and size around a styled line', () => {
    const bytes = build([{ type: 'text', value: 'TOTAL', align: 'center', bold: true, width: 2, height: 2 }]);
    assert.ok(contains(bytes, [0x1b, 0x61, 0x01]), 'ESC a 1 (centre)');
    assert.ok(contains(bytes, [0x1b, 0x45, 0x01]), 'ESC E 1 (bold on)');
    // GS ! with width and height both 2 packs as ((2-1) << 4) | (2-1) = 0x11.
    assert.ok(contains(bytes, [0x1d, 0x21, 0x11]), 'GS ! 0x11');
    assert.ok(contains(bytes, [0x1b, 0x45, 0x00]), 'bold turned off again');
  });

  it('emits a partial cut, not a full one', () => {
    const parsed = parseReceiptDocument({ elements: [{ type: 'text', value: 'x' }] });
    assert.ok(parsed.document);
    const bytes = renderReceiptEscPos(parsed.document, printer);
    // GS V 66 n. A full cut (GS V 0) is a no-op on some cutters and an error on others, and the
    // paper tab a partial cut leaves is what stops the next receipt falling on the floor.
    assert.ok(contains(bytes, [0x1d, 0x56, 0x42]), 'GS V 66');
    assert.ok(!contains(bytes, [0x1d, 0x56, 0x00]), 'must not emit a full cut');
  });

  it('does not add a second cut when the document ends with one', () => {
    const parsed = parseReceiptDocument({ elements: [{ type: 'text', value: 'x' }, { type: 'cut' }] });
    assert.ok(parsed.document);
    const bytes = renderReceiptEscPos(parsed.document, printer);
    let cuts = 0;
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] === 0x1d && bytes[i + 1] === 0x56 && bytes[i + 2] === 0x42) cuts += 1;
    }
    assert.equal(cuts, 1);
  });

  it('kicks the cash drawer', () => {
    assert.ok(contains(build([{ type: 'drawer', pin: 0 }]), [0x1b, 0x70, 0x00, 25, 250]));
  });

  it('emits a Code128 barcode with its code-set selector', () => {
    const bytes = build([{ type: 'barcode', symbology: 'CODE128', value: 'HK-421', height: 60 }]);
    assert.ok(contains(bytes, [0x1d, 0x68, 60]), 'GS h 60 (height)');
    // Function B: GS k 73 <len> <data>. The data is prefixed `{B` because without a code-set
    // selector each vendor guesses differently.
    const payload = Buffer.from('{BHK-421', 'ascii');
    assert.ok(contains(bytes, [0x1d, 0x6b, 73, payload.length, ...payload]));
  });

  it('refuses barcode data the symbology cannot carry', () => {
    const parsed = parseReceiptDocument({ elements: [{ type: 'barcode', symbology: 'EAN13', value: 'not-digits' }] });
    assert.ok(parsed.document);
    // A printer handed impossible data prints nothing at all and reports nothing, so this has to
    // fail here rather than on the paper.
    assert.throws(() => renderReceiptEscPos(parsed.document!, printer), RenderError);
  });

  it('emits the four-command QR sequence', () => {
    const bytes = build([{ type: 'qr', value: 'hankha', size: 6, ec: 'M' }]);
    assert.ok(contains(bytes, [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), 'select model 2');
    assert.ok(contains(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 6]), 'module size');
    assert.ok(contains(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 49]), 'error correction M');
    // Store: the length covers the three header bytes plus the data.
    const data = Buffer.from('hankha', 'utf8');
    assert.ok(contains(bytes, [0x1d, 0x28, 0x6b, data.length + 3, 0x00, 0x31, 0x50, 0x30, ...data]), 'store');
    assert.ok(contains(bytes, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]), 'print');
  });

  it('emits GS v 0 with the row count in BYTES and the height in ROWS', () => {
    const width = 384;
    const height = 3;
    const rowBytes = rasterRowBytes(width);
    assert.equal(rowBytes, 48);
    const data = Buffer.alloc(rowBytes * height, 0xff);
    const bytes = build([{ type: 'image', image: { width, height, data_base64: data.toString('base64') } }]);
    // Getting xL/xH wrong shears the image and every row after it — it still prints, which is what
    // makes it look like a font bug rather than a data bug.
    assert.ok(contains(bytes, [0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, height & 0xff, height >> 8]));
  });

  it('rejects a raster whose byte count disagrees with its dimensions', () => {
    const parsed = parseReceiptDocument({
      elements: [{ type: 'image', image: { width: 384, height: 3, data_base64: Buffer.alloc(10).toString('base64') } }],
    });
    assert.equal(parsed.document, null);
    assert.match(parsed.errors[0] ?? '', /needs 144/);
  });

  it('refuses a receipt containing text no printer could render', () => {
    const parsed = parseReceiptDocument({ elements: [{ type: 'text', value: 'ເຂົ້າ' }] });
    assert.ok(parsed.document);
    try {
      renderReceiptEscPos(parsed.document, printer);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof RenderError);
      // The message has to say what to do about it, or the caller has no route forward.
      assert.match(err.errors[0] ?? '', /'image' element/);
    }
  });
});
