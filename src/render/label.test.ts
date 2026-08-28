import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PrinterRecord, PrinterLanguage } from '../registry.js';
import { parseLabelDocument, parseReceiptDocument, mmToDots } from './document.js';
import { RenderError } from './escpos.js';
import { invertBits } from './label-text.js';
import { render } from './index.js';

function labelPrinter(language: PrinterLanguage): PrinterRecord {
  return {
    id: 'labels', name: 'Labels', transport: 'network', type: 'label',
    language, enabled: true, address: '192.168.1.60', port: 9100,
    width_mm: 50, height_mm: 30, gap_mm: 2, dpi: 203,
  };
}

const SHARED = {
  elements: [
    { type: 'text', x: 16, y: 16, value: 'Dok Champa', height: 24 },
    { type: 'barcode', x: 16, y: 60, symbology: 'CODE128', value: 'HK-00421', height: 50, module_width: 2 },
    { type: 'qr', x: 260, y: 60, value: 'https://hankha.la/p/421', size: 4 },
    { type: 'box', x: 4, y: 4, width: 392, height: 232, thickness: 2 },
  ],
  copies: 3,
};

function renderAs(language: PrinterLanguage): string {
  const parsed = parseLabelDocument(SHARED);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.document);
  return render(parsed.document, labelPrinter(language)).toString('latin1');
}

describe('ZPL', () => {
  const out = renderAs('zpl');

  it('wraps the label and sets the media from millimetres', () => {
    assert.ok(out.startsWith('^XA'));
    assert.ok(out.trimEnd().endsWith('^XZ'));
    assert.ok(out.includes(`^PW${mmToDots(50, 203)}`), '50 mm at 203 dpi is 400 dots');
    assert.ok(out.includes(`^LL${mmToDots(30, 203)}`));
  });

  it('positions every element with ^FO', () => {
    assert.ok(out.includes('^FO16,16^A0N,24,0^FH^FDDok Champa^FS'));
    assert.ok(out.includes('^FO16,60^BCN,50,Y,N,N^FDHK-00421^FS'));
    // The error-correction letter lives in the FIELD DATA for ^BQ, not in the command — the one
    // place ZPL differs from every other language here.
    assert.ok(out.includes('^FO260,60^BQN,2,4^FDMA,https://hankha.la/p/421^FS'));
    assert.ok(out.includes('^FO4,4^GB392,232,2^FS'));
  });

  it('repeats natively rather than by resending the label', () => {
    assert.ok(out.includes('^PQ3'));
  });

  it('hex-escapes a caret so a product name cannot truncate the label', () => {
    const parsed = parseLabelDocument({ elements: [{ type: 'text', x: 0, y: 0, value: 'A^B~C' }] });
    assert.ok(parsed.document);
    const escaped = render(parsed.document, labelPrinter('zpl')).toString('latin1');
    // ZPL reads ^ and ~ as command introducers wherever they appear. Unescaped, the field ends
    // early and the label still prints — a data-corruption bug rather than a visible failure.
    assert.ok(escaped.includes('^FH^FDA_5EB_7EC^FS'));
  });
});

describe('TSPL', () => {
  const out = renderAs('tspl');

  it('sets media in millimetres and clears the buffer', () => {
    assert.ok(out.startsWith('SIZE 50 mm,30 mm\r\n'));
    assert.ok(out.includes('GAP 2 mm,0 mm'));
    assert.ok(out.includes('\r\nCLS\r\n'));
  });

  it('emits the line-oriented element commands', () => {
    assert.ok(out.includes('TEXT 16,16,"3",0,1,1,"Dok Champa"'));
    assert.ok(out.includes('BARCODE 16,60,"128",50,1,0,2,4,"HK-00421"'));
    assert.ok(out.includes('QRCODE 260,60,M,4,A,0,M1,"https://hankha.la/p/421"'));
    assert.ok(out.includes('BOX 4,4,396,236,2'));
  });

  it('ends with PRINT carrying the copy count', () => {
    assert.ok(out.trimEnd().endsWith('PRINT 1,3'));
  });

  it('escapes a quote in the content', () => {
    const parsed = parseLabelDocument({ elements: [{ type: 'text', x: 0, y: 0, value: 'say "hi"' }] });
    assert.ok(parsed.document);
    assert.ok(render(parsed.document, labelPrinter('tspl')).toString('latin1').includes('"say \\"hi\\""'));
  });
});

describe('EPL2', () => {
  const out = renderAs('epl2');

  it('clears the buffer and sets the media in dots', () => {
    assert.ok(out.startsWith('N\r\n'));
    assert.ok(out.includes(`q${mmToDots(50, 203)}`));
    assert.ok(out.includes(`Q${mmToDots(30, 203)},${mmToDots(2, 203)}`));
  });

  it('counts rotation in quarter turns and ends with the copy count', () => {
    assert.ok(out.includes('A16,16,0,4,1,1,N,"Dok Champa"'));
    assert.ok(out.includes('B16,60,0,"1",2,4,50,B,"HK-00421"'));
    assert.ok(out.includes('b260,60,Q,m2,s4,"https://hankha.la/p/421"'));
    assert.ok(out.trimEnd().endsWith('P3'));
  });
});

describe('raster polarity', () => {
  it('inverts for the languages that print a CLEARED bit', () => {
    // ESC/POS `GS v 0` and ZPL `^GF` treat a set bit as black; TSPL `BITMAP` and EPL2 `GW` treat a
    // set bit as white. Getting it wrong yields a solid black label with white text.
    const black = Buffer.from([0b10110000]);
    assert.deepEqual([...invertBits(black)], [0b01001111]);
  });

  it('sends ZPL rasters as hex without inverting them', () => {
    const data = Buffer.from([0xf0, 0x0f]);
    const parsed = parseLabelDocument({
      elements: [{ type: 'image', x: 0, y: 0, image: { width: 8, height: 2, data_base64: data.toString('base64') } }],
    });
    assert.ok(parsed.document);
    assert.ok(render(parsed.document, labelPrinter('zpl')).toString('latin1').includes('^GFA,2,2,1,F00F^FS'));
  });

  it('sends TSPL rasters as raw inverted binary after the header', () => {
    const data = Buffer.from([0xf0, 0x0f]);
    const parsed = parseLabelDocument({
      elements: [{ type: 'image', x: 0, y: 0, image: { width: 8, height: 2, data_base64: data.toString('base64') } }],
    });
    assert.ok(parsed.document);
    const bytes = render(parsed.document, labelPrinter('tspl'));
    const header = Buffer.from('BITMAP 0,0,1,2,0,', 'latin1');
    const at = bytes.indexOf(header);
    assert.ok(at !== -1);
    assert.deepEqual([...bytes.subarray(at + header.length, at + header.length + 2)], [0x0f, 0xf0]);
  });
});

describe('the corner the matrix leaves open', () => {
  it('refuses a receipt document on a label printer instead of truncating it', () => {
    const parsed = parseReceiptDocument({ elements: [{ type: 'text', value: 'TOTAL 250,000' }] });
    assert.ok(parsed.document);
    // Silently clipping a bill at the bottom of a 30 mm label produces a slip that looks right
    // until the total is missing from it.
    assert.throws(() => render(parsed.document!, labelPrinter('zpl')), RenderError);
  });
});
