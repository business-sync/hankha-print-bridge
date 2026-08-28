/*
 * The test slip and test label.
 *
 * Shared by `POST /printers/:id/test` and by `--test-print` on the command line, so the thing an
 * operator prints from a settings screen is byte-for-byte the thing a technician prints over SSH.
 *
 * Everything on them is chosen to make a misconfiguration visible on the paper: the ruler line
 * shows whether `dots_per_line` matches the physical paper, the barcode and QR prove the printer's
 * symbol firmware answers, and the language is printed in words so a slip that comes out as
 * gibberish still identifies which renderer produced it.
 */
import { BRIDGE_VERSION } from './version.js';
import type { PrinterRecord } from './registry.js';
import { charsPerLine, type LabelDocument, type ReceiptDocument } from './render/index.js';

export function sampleReceipt(printer: PrinterRecord): ReceiptDocument {
  const width = printer.dots_per_line ?? 576;
  const columns = charsPerLine(width, 'A');
  // A repeating 0-9 ruler: if the line wraps, the paper is narrower than `dots_per_line` says.
  const ruler = Array.from({ length: columns }, (_, i) => String(i % 10)).join('');

  return {
    kind: 'receipt',
    elements: [
      { type: 'text', value: 'HANKHA PRINT BRIDGE', align: 'center', bold: true, width: 2, height: 2 },
      { type: 'text', value: `v${BRIDGE_VERSION}`, align: 'center' },
      { type: 'rule' },
      { type: 'columns', left: 'Printer', right: printer.id },
      { type: 'columns', left: 'Transport', right: printer.transport },
      { type: 'columns', left: 'Language', right: printer.language },
      { type: 'columns', left: 'Width', right: `${width} dots / ${columns} cols` },
      { type: 'rule' },
      { type: 'text', value: ruler, font: 'B' },
      { type: 'text', value: 'The ruler above must fit on one line.', font: 'B' },
      { type: 'rule' },
      { type: 'columns', left: '2x Test item', right: '50,000' },
      { type: 'columns', left: 'TOTAL', right: 'LAK 50,000', bold: true },
      { type: 'feed', lines: 1 },
      { type: 'barcode', symbology: 'CODE128', value: 'HANKHA-TEST', height: 60, hri: 'below' },
      { type: 'qr', value: `hankha-print-bridge ${BRIDGE_VERSION} ${printer.id}`, size: 5 },
      { type: 'feed', lines: 1 },
      { type: 'text', value: 'If you can read this, printing works.', align: 'center', font: 'B' },
      { type: 'cut', mode: 'partial' },
    ],
  };
}

export function sampleLabel(printer: PrinterRecord): LabelDocument {
  const dpi = printer.dpi ?? 203;
  const widthMm = printer.width_mm ?? 50;
  const heightMm = printer.height_mm ?? 30;
  const widthDots = Math.round((widthMm * dpi) / 25.4);

  return {
    kind: 'label',
    width_mm: widthMm,
    height_mm: heightMm,
    gap_mm: printer.gap_mm ?? 2,
    dpi,
    copies: 1,
    elements: [
      // A border at the media edges: if it prints partially, the SIZE is wrong for the roll.
      { type: 'box', x: 4, y: 4, width: widthDots - 8, height: Math.round((heightMm * dpi) / 25.4) - 8, thickness: 2 },
      { type: 'text', x: 16, y: 16, value: 'HANKHA TEST', height: 28, bold: true },
      { type: 'text', x: 16, y: 50, value: `${printer.id} / ${printer.language}`, height: 20 },
      { type: 'barcode', x: 16, y: 78, symbology: 'CODE128', value: 'HANKHA-TEST', height: 50, module_width: 2, hri: 'below' },
    ],
  };
}
