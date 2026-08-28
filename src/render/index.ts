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
