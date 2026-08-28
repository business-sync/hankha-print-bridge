/*
 * TSPL / TSPL2 — TSC, Xprinter, Gprinter, Rongta.
 *
 * The dominant label language in this fleet's market: a Lao venue buying a barcode printer is far
 * more likely to end up with an Xprinter speaking TSPL than a Zebra speaking ZPL.
 *
 * Two things separate it from ZPL and drive the shape of this file:
 *
 *  - It is LINE oriented and CRLF terminated, not a `^`-delimited stream.
 *  - `BITMAP` carries RAW BINARY straight after its comma, so the output cannot be assembled as a
 *    string. Everything below builds a list of Buffers.
 */
import type { PrinterRecord } from '../registry.js';
import { RenderError } from './escpos.js';
import { decodeRaster, rasterRowBytes, type BarcodeSymbology, type LabelDocument, type Rotation } from './document.js';
import { invertBits, labelText } from './label-text.js';

const ROTATION: Record<Rotation, number> = { 0: 0, 90: 90, 180: 180, 270: 270 };

/** TSPL barcode type names, quoted in the command. */
const BARCODE_TYPE: Record<BarcodeSymbology, string> = {
  CODE128: '128', CODE39: '39', EAN13: 'EAN13', EAN8: 'EAN8', UPCA: 'UPCA', UPCE: 'UPCE', ITF: 'ITF14',
};

/** Content is double-quoted; TSPL escapes with a backslash. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderLabelTspl(document: LabelDocument, printer: PrinterRecord): Buffer {
  const errors: string[] = [];
  const chunks: Buffer[] = [];
  const line = (text: string) => chunks.push(Buffer.from(`${text}\r\n`, 'latin1'));

  const widthMm = document.width_mm ?? printer.width_mm;
  const heightMm = document.height_mm ?? printer.height_mm;
  const gapMm = document.gap_mm ?? printer.gap_mm ?? 2;

  // SIZE and GAP take millimetres — the one place a label language speaks the same units the media
  // is sold in, which is why the document keeps geometry in mm and positions in dots.
  if (widthMm !== undefined && heightMm !== undefined) {
    line(`SIZE ${widthMm} mm,${heightMm} mm`);
    line(`GAP ${gapMm} mm,0 mm`);
  }
  if (document.darkness !== undefined) line(`DENSITY ${Math.min(15, Math.max(0, document.darkness))}`);
  if (document.speed !== undefined) line(`SPEED ${Math.min(14, Math.max(1, document.speed))}`);
  line('DIRECTION 1');
  line('CLS');

  for (const [index, element] of document.elements.entries()) {
    const where = `elements[${index}]`;
    const rot = ROTATION[('rotation' in element ? element.rotation : 0) ?? 0];

    switch (element.type) {
      case 'text': {
        // Font "3" is the built-in 16x24 face. TSPL scales only by whole multiples, so a requested
        // height becomes the nearest multiple of 24 rather than an exact dot count.
        const multiplier = Math.min(10, Math.max(1, Math.round((element.height ?? 24) / 24)));
        const content = quote(labelText(element.value, errors, where));
        line(`TEXT ${element.x},${element.y},"3",${rot},${multiplier},${multiplier},${content}`);
        // TSPL has no bold attribute. Overprinting one dot to the right thickens the stroke, which
        // is what a label designer does by hand; widening the horizontal multiplier instead would
        // stretch the glyphs rather than embolden them.
        if (element.bold) line(`TEXT ${element.x + 1},${element.y},"3",${rot},${multiplier},${multiplier},${content}`);
        break;
      }

      case 'barcode': {
        const hri = element.hri === 'none' ? 0 : element.hri === 'above' ? 2 : 1;
        const narrow = element.module_width ?? 2;
        line(
          `BARCODE ${element.x},${element.y},"${BARCODE_TYPE[element.symbology]}",` +
            `${element.height ?? 80},${hri},${rot},${narrow},${narrow * 2},${quote(element.value)}`
        );
        break;
      }

      case 'qr':
        // cell width, then `A` for automatic encoding and `M1` for the standard mask.
        line(
          `QRCODE ${element.x},${element.y},${element.ec ?? 'M'},` +
            `${Math.min(10, Math.max(1, element.size ?? 5))},A,${rot},M1,${quote(element.value)}`
        );
        break;

      case 'image': {
        const data = decodeRaster(element.image);
        const rowBytes = rasterRowBytes(element.image.width);
        // Mode 0 = OVERWRITE. The header is text, the data that follows it is not.
        chunks.push(Buffer.from(`BITMAP ${element.x},${element.y},${rowBytes},${element.image.height},0,`, 'latin1'));
        // TSPL prints a CLEARED bit, the opposite of `RasterImage`.
        chunks.push(invertBits(data));
        chunks.push(Buffer.from('\r\n', 'latin1'));
        break;
      }

      case 'box': {
        const thickness = element.thickness ?? 2;
        line(`BOX ${element.x},${element.y},${element.x + element.width},${element.y + element.height},${thickness}`);
        break;
      }

      case 'line':
        line(`BAR ${element.x},${element.y},${element.width},${element.height}`);
        break;
    }
  }

  if (errors.length > 0) throw new RenderError(errors);

  // `PRINT sets,copies` — one set, N copies of it. The printer repeats without another round trip.
  line(`PRINT 1,${Math.max(1, document.copies ?? 1)}`);
  return Buffer.concat(chunks);
}
