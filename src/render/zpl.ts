/*
 * ZPL II — Zebra and the many printers that emulate it.
 *
 * A label is a canvas: `^FO x,y` positions every field in dots from the top-left, so the document's
 * coordinates map straight across with no layout pass.
 *
 * `^FH` is on for every text field. ZPL reads `^` and `~` as command introducers wherever they
 * appear, so a product name containing one would otherwise truncate the label mid-field — and the
 * result prints, which makes it a data-corruption bug rather than a visible failure.
 */
import type { PrinterRecord } from '../registry.js';
import { RenderError } from './escpos.js';
import { decodeRaster, mmToDots, rasterRowBytes, type BarcodeSymbology, type LabelDocument, type Rotation } from './document.js';
import { labelText } from './label-text.js';

const ORIENTATION: Record<Rotation, string> = { 0: 'N', 90: 'R', 180: 'I', 270: 'B' };

/** `^B` selector per symbology. */
const BARCODE_COMMAND: Record<BarcodeSymbology, string> = {
  CODE128: 'BC', CODE39: 'B3', EAN13: 'BE', EAN8: 'B8', UPCA: 'BU', UPCE: 'B9', ITF: 'B2',
};

/** Hex-escape the three characters ZPL would otherwise read as syntax. Requires `^FH`. */
function escapeField(value: string): string {
  return value.replace(/[\^~_]/g, (char) => `_${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function renderLabelZpl(document: LabelDocument, printer: PrinterRecord): Buffer {
  const errors: string[] = [];
  const dpi = document.dpi ?? printer.dpi ?? 203;
  const widthMm = document.width_mm ?? printer.width_mm;
  const heightMm = document.height_mm ?? printer.height_mm;

  const out: string[] = ['^XA', '^CI28', '^LH0,0', '^LT0'];
  if (widthMm !== undefined) out.push(`^PW${mmToDots(widthMm, dpi)}`);
  if (heightMm !== undefined) out.push(`^LL${mmToDots(heightMm, dpi)}`);
  // ZPL darkness runs 0-30 where the document's scale is 0-15 on the other two languages; doubling
  // keeps one `darkness` number meaning roughly the same heat everywhere.
  if (document.darkness !== undefined) out.push(`^MD${Math.min(30, Math.max(0, document.darkness * 2))}`);
  if (document.speed !== undefined) out.push(`^PR${Math.min(14, Math.max(1, document.speed))}`);

  for (const [index, element] of document.elements.entries()) {
    const where = `elements[${index}]`;
    const at = `^FO${element.x},${element.y}`;

    switch (element.type) {
      case 'text': {
        const height = element.height ?? 24;
        // ZPL's ^A0 takes height then width; 0 means "proportional to the height", which is what a
        // caller wants unless they said otherwise.
        const width = element.width ? element.width : 0;
        const rot = ORIENTATION[element.rotation ?? 0];
        out.push(`${at}^A0${rot},${height},${width}^FH^FD${escapeField(labelText(element.value, errors, where))}^FS`);
        // ZPL has no bold: the closest is a second pass offset by one dot, which is what every
        // label designer does by hand.
        if (element.bold) {
          out.push(`^FO${element.x + 1},${element.y}^A0${rot},${height},${width}^FH^FD${escapeField(labelText(element.value, errors, where))}^FS`);
        }
        break;
      }

      case 'barcode': {
        const rot = ORIENTATION[element.rotation ?? 0];
        const height = element.height ?? 80;
        const hri = element.hri === 'none' ? 'N' : 'Y';
        const above = element.hri === 'above' || element.hri === 'both' ? 'Y' : 'N';
        out.push(`^BY${element.module_width ?? 2},,${height}`);
        out.push(`${at}^${BARCODE_COMMAND[element.symbology]}${rot},${height},${hri},${above},N^FD${element.value}^FS`);
        break;
      }

      case 'qr': {
        const rot = ORIENTATION[element.rotation ?? 0];
        // `^BQ` magnification tops out at 10. The field data carries the error-correction letter
        // and the input mode (`A` = automatic), which is where ZPL differs from every other
        // language: the EC level is in the DATA, not the command.
        out.push(`${at}^BQ${rot},2,${Math.min(10, Math.max(1, element.size ?? 5))}^FD${element.ec ?? 'M'}A,${escapeField(element.value)}^FS`);
        break;
      }

      case 'image': {
        // ^GF treats a set bit as black, the same as `RasterImage`, so no inversion here.
        const data = decodeRaster(element.image);
        const rowBytes = rasterRowBytes(element.image.width);
        out.push(`${at}^GFA,${data.length},${data.length},${rowBytes},${data.toString('hex').toUpperCase()}^FS`);
        break;
      }

      case 'box':
        out.push(`${at}^GB${element.width},${element.height},${element.thickness ?? 2}^FS`);
        break;

      case 'line':
        // A filled rectangle whose border thickness equals its height: ZPL's only line primitive.
        out.push(`${at}^GB${element.width},${element.height},${element.height}^FS`);
        break;
    }
  }

  if (errors.length > 0) throw new RenderError(errors);

  out.push(`^PQ${Math.max(1, document.copies ?? 1)}`, '^XZ');
  return Buffer.from(`${out.join('\n')}\n`, 'latin1');
}
