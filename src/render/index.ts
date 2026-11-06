/*
 * Pick a renderer for (document, printer).
 *
 * The matrix is deliberately incomplete in one corner, and the gap is a refusal rather than an
 * approximation: a RECEIPT document sent to a label printer is rejected. A receipt flows for as
 * long as it needs to; a label is a fixed rectangle. Silently truncating a bill at the bottom of a
 * 30 mm label would produce a slip that looks right until the total is missing from it, which is
 * the worst possible failure for a document whose entire job is to be correct about money.
 */
import type { PrinterRecord } from '../registry.js';
import type { JobDocument } from './document.js';
import { RenderError, renderLabelEscPos, renderReceiptEscPos } from './escpos.js';
import { renderLabelEpl2 } from './epl2.js';
import { renderLabelTspl } from './tspl.js';
import { renderLabelZpl } from './zpl.js';

export * from './document.js';
export { RenderError, charsPerLine, encodeText, EscPosBuilder, PRINT_FALLBACKS, twoColumns } from './escpos.js';
export { renderLabelEpl2, renderLabelEscPos, renderLabelTspl, renderLabelZpl, renderReceiptEscPos };

/**
 * Whether a document cannot be printed on this printer because of the paper width, and the width
 * the printer actually has.
 *
 * The LAN API answers this with a structured 422 (`width_mismatch`, `expected`) instead of a render
 * error's sentence, because the terminal that laid the slip out has to act on it: re-lay it for
 * `expected` and resend, not show a message to a cashier.
 *
 *  - `declared` is the width the terminal says it built for; any difference from the printer's is a
 *    mismatch, wider OR narrower, because a slip padded for 80 mm is wrong on 58 mm and the other
 *    way round is a layout the terminal did not intend;
 *  - a receipt document that pins its own `dots_per_line` wider than the head is refused by the
 *    renderer anyway; this just says so first, in the same words.
 *
 * Null when there is nothing to compare against — a label printer has no line width.
 */
export function widthMismatch(
  document: JobDocument,
  printer: PrinterRecord,
  declared?: number
): { expected: number } | null {
  const head = printer.dots_per_line;
  if (head === undefined) return null;
  if (declared !== undefined && declared !== head) return { expected: head };
  if (document.kind === 'receipt' && document.dots_per_line !== undefined && document.dots_per_line > head) {
    return { expected: head };
  }
  return null;
}

export function render(document: JobDocument, printer: PrinterRecord): Buffer {
  if (document.kind === 'receipt') {
    if (printer.language !== 'escpos') {
      throw new RenderError([
        `printer '${printer.id}' speaks ${printer.language.toUpperCase()}, which has no flowing text mode. ` +
          `Send a label document, or raw payload_base64.`,
      ]);
    }
    return renderReceiptEscPos(document, printer);
  }

  switch (printer.language) {
    case 'escpos':
      return renderLabelEscPos(document, printer);
    case 'zpl':
      return renderLabelZpl(document, printer);
    case 'tspl':
      return renderLabelTspl(document, printer);
    case 'epl2':
      return renderLabelEpl2(document, printer);
  }
}
