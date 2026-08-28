/*
 * EPL2 — the older Zebra language, still on LP2824 / TLP2844 units that outlive their replacements.
 *
 * Kept alongside ZPL because a printer that speaks EPL2 usually does NOT speak ZPL: the two are
 * separate firmware personalities, and sending ZPL to an EPL2 head prints the commands as text.
 *
 * Like TSPL it is line oriented, and like TSPL its `GW` graphic treats a set bit as WHITE, so
 * rasters are inverted on the way out.
 */
import type { PrinterRecord } from '../registry.js';
import { RenderError } from './escpos.js';
import { decodeRaster, mmToDots, rasterRowBytes, type BarcodeSymbology, type LabelDocument, type Rotation } from './document.js';
import { invertBits, labelText } from './label-text.js';

/** EPL2 counts rotation in quarter turns. */
const ROTATION: Record<Rotation, number> = { 0: 0, 90: 1, 180: 2, 270: 3 };

const BARCODE_SELECTOR: Record<BarcodeSymbology, string> = {
  CODE128: '1', CODE39: '3', EAN13: 'E30', EAN8: 'E80', UPCA: 'UA0', UPCE: 'UE0', ITF: '2',
};

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderLabelEpl2(document: LabelDocument, printer: PrinterRecord): Buffer {
  const errors: string[] = [];
  const chunks: Buffer[] = [];
  const line = (text: string) => chunks.push(Buffer.from(`${text}\r\n`, 'latin1'));

  const dpi = document.dpi ?? printer.dpi ?? 203;
  const widthMm = document.width_mm ?? printer.width_mm;
  const heightMm = document.height_mm ?? printer.height_mm;
  const gapMm = document.gap_mm ?? printer.gap_mm ?? 2;

  line('N'); // clear the image buffer — without it the previous label reprints underneath
  if (widthMm !== undefined) line(`q${mmToDots(widthMm, dpi)}`);
  if (heightMm !== undefined) line(`Q${mmToDots(heightMm, dpi)},${mmToDots(gapMm, dpi)}`);
  if (document.darkness !== undefined) line(`D${Math.min(15, Math.max(0, document.darkness))}`);
  if (document.speed !== undefined) line(`S${Math.min(6, Math.max(1, document.speed))}`);

  for (const [index, element] of document.elements.entries()) {
    const where = `elements[${index}]`;
    const rot = ROTATION[('rotation' in element ? element.rotation : 0) ?? 0];

    switch (element.type) {
      case 'text': {
        // Font 4 is the 14x24 resident face; EPL2 scales by whole multiples only.
        const multiplier = Math.min(8, Math.max(1, Math.round((element.height ?? 24) / 24)));
        const content = quote(labelText(element.value, errors, where));
        // The trailing `N` is "normal", as opposed to `R` for reverse (white on black).
        line(`A${element.x},${element.y},${rot},4,${multiplier},${multiplier},N,${content}`);
        // No bold attribute here either — overprint rather than stretch. See the note in tspl.ts.
        if (element.bold) line(`A${element.x + 1},${element.y},${rot},4,${multiplier},${multiplier},N,${content}`);
        break;
      }

      case 'barcode': {
        const narrow = element.module_width ?? 2;
        const hri = element.hri === 'none' ? 'N' : 'B';
        line(
          `B${element.x},${element.y},${rot},${quote(BARCODE_SELECTOR[element.symbology])},` +
            `${narrow},${narrow * 2},${element.height ?? 80},${hri},${quote(element.value)}`
        );
        break;
      }

      case 'qr':
        // `b` is the 2D barcode command; `Q` selects QR, `m2` model 2, `s` the cell size.
        line(`b${element.x},${element.y},Q,m2,s${Math.min(10, Math.max(1, element.size ?? 5))},${quote(element.value)}`);
        break;

      case 'image': {
        const data = decodeRaster(element.image);
        const rowBytes = rasterRowBytes(element.image.width);
        chunks.push(Buffer.from(`GW${element.x},${element.y},${rowBytes},${element.image.height},`, 'latin1'));
        chunks.push(invertBits(data));
        chunks.push(Buffer.from('\r\n', 'latin1'));
        break;
      }

      case 'box': {
        const thickness = element.thickness ?? 2;
        line(`X${element.x},${element.y},${thickness},${element.x + element.width},${element.y + element.height}`);
        break;
      }

      case 'line':
        line(`LO${element.x},${element.y},${element.width},${element.height}`);
        break;
    }
  }

  if (errors.length > 0) throw new RenderError(errors);

  line(`P${Math.max(1, document.copies ?? 1)}`);
  return Buffer.concat(chunks);
}
