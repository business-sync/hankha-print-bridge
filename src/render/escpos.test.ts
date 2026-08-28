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

  /*
   * The line is measured in what the ENCODER emits, not in code units. `₭` is one character and
   * three printed columns, so padding by `.length` made every kip total two columns too long and
   * wrapped the price onto its own row — on the totals line of essentially every receipt in this
   * fleet.
   */
  it('pads a kip price by its printed width, not its character count', () => {
    const line = twoColumns('Beer Lao', '₭25,000', 32);
    assert.equal(encodeText(line).bytes.length, 32);
    assert.ok(encodeText(line).unprintable.length === 0);
  });

  it('measures an expanding character on the left side too', () => {
    // `…` encodes to three dots, so a name padded by code units overruns by two.
    const line = twoColumns('Long name…', '5,000', 24);
    assert.equal(encodeText(line).bytes.length, 24);
  });

  it('still fills the line exactly when the name has to be cut', () => {
    const line = twoColumns('₭'.repeat(30), '25,000', 20);
    assert.equal(encodeText(line).bytes.length, 20);
    assert.ok(line.endsWith(' 25,000'));
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

  /*
   * `GS k` announces its payload in a single byte. `Buffer.from(number[])` masks anything over
   * 255 instead of complaining, so an over-long value used to print a truncated barcode and then
   * hand the rest of the payload to the printer as commands. 254 characters plus the `{B`
   * selector is 256, which masks to zero — the worst case, and the one pinned here.
   */
  it('refuses a barcode longer than the one-byte length can describe', () => {
    const parsed = parseReceiptDocument({
      elements: [{ type: 'barcode', symbology: 'CODE128', value: 'A'.repeat(254) }],
    });
    assert.deepEqual(parsed.errors, []);
    assert.throws(() => renderReceiptEscPos(parsed.document!, printer), RenderError);
  });

  it('still emits a barcode that fits the length byte', () => {
    // 253 + the two-byte `{B` selector is exactly 255.
    const bytes = build([{ type: 'barcode', symbology: 'CODE128', value: 'A'.repeat(253) }]);
    assert.ok(contains(bytes, [0x1d, 0x6b, 73, 255]));
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

/*
 * The receipt parser's own error path.
 *
 * `dots_per_line` and `codepage` are validated INSIDE the returned object literal, so their
 * errors are pushed after the early `errors.length > 0` guard has already run. Returning a
 * document alongside them dropped both, because `jobs.ts` only tests `!parsed.document` — an
 * out-of-range value answered 200 and quietly printed at the fallback width.
 */
describe('receipt document validation', () => {
  it('reports an out-of-range dots_per_line instead of falling back silently', () => {
    const parsed = parseReceiptDocument({
      elements: [{ type: 'text', value: 'hi' }],
      dots_per_line: 1_000_000,
    });
    assert.equal(parsed.document, null);
    assert.match(parsed.errors.join('; '), /dots_per_line/);
  });

  it('reports an out-of-range codepage', () => {
    const parsed = parseReceiptDocument({
      elements: [{ type: 'text', value: 'hi' }],
      codepage: 999,
    });
    assert.equal(parsed.document, null);
    assert.match(parsed.errors.join('; '), /codepage/);
  });

  it('still accepts a receipt whose optional numbers are in range', () => {
    const parsed = parseReceiptDocument({
      elements: [{ type: 'text', value: 'hi' }],
      dots_per_line: 384,
      codepage: 16,
    });
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.document?.dots_per_line, 384);
  });
});
