/*
 * ESC/POS: receipts, and the barcode/QR commands a receipt printer already has in firmware.
 *
 * The bridge never had an encoder because the POS terminal has one. It needs one now for two
 * reasons: a label job has to reach an ESC/POS printer when that is all a venue owns, and neither
 * existing client can emit a barcode or a QR at all — the terminal's encoder
 * (`features/printer/lib/escpos-encoder.ts`) has no `GS k` and no `GS ( k`, and prints its QR
 * codes only through the HTML path.
 *
 * NO symbol is computed here. Every ESC/POS printer encodes Code128 and QR in firmware, so this
 * emits commands and hands over the data — which is also why the whole renderer needs no
 * dependency.
 *
 * THE ONE RULE THAT MATTERS: unencodable text raises, it never disappears.
 * The worst bug this project has had in printing was `sanitizeForPrint` silently dropping every
 * codepoint it did not recognise, so a receipt line reading `2x <Lao dish name>` printed as
 * `2x ` — a blank line, with no error anywhere. Lao is in NO ESC/POS code page (CP874 is Thai), so
 * it cannot be fixed by choosing a better page; the only routes are a printer with a Lao font ROM
 * or a raster. This encoder therefore REFUSES text it cannot represent and names the characters,
 * pointing the caller at an `image` element.
 */
import type { PrinterRecord } from '../registry.js';
import {
  decodeRaster,
  rasterRowBytes,
  type Align,
  type BarcodeSymbology,
  type HriPosition,
  type LabelDocument,
  type ReceiptDocument,
  type ReceiptElement,
} from './document.js';

/** Raised when a document cannot be turned into bytes. Carries every problem, not just the first. */
export class RenderError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join('; '));
    this.name = 'RenderError';
    this.errors = errors;
  }
}

const ESC = 0x1b;
const GS = 0x1d;

/**
 * Characters that have an honest ASCII equivalent.
 *
 * Kept deliberately small and explicit. Everything absent from this table and outside ASCII is an
 * error, so growing it is how a character becomes printable — never by widening a codepoint range,
 * which is how the terminal's version once started rastering smart quotes it could already map.
 */
export const PRINT_FALLBACKS: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201a': ',', '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2026': '...', '\u2044': '/',
  // Every space that is not U+0020. Written as escapes because a literal here is invisible in a
  // diff, and a table of seven identical-looking keys is exactly where a duplicate hides.
  '\u00a0': ' ', '\u2002': ' ', '\u2003': ' ', '\u2007': ' ', '\u2009': ' ', '\u200a': ' ', '\u202f': ' ',
  // Zero-width and soft hyphen: they carry no ink, so dropping them loses nothing.
  '\u00ad': '', '\u200b': '', '\ufeff': '',
  '\u00d7': 'x', '\u2022': '*', '\u00b7': '.', '\u00b0': 'deg',
  '\u2039': '<', '\u203a': '>', '\u00ab': '<<', '\u00bb': '>>',
  '\u2122': '(TM)', '\u00ae': '(R)', '\u00a9': '(C)',
  '\u00bd': '1/2', '\u00bc': '1/4', '\u00be': '3/4',
  '\u20ac': 'EUR', '\u00a3': 'GBP', '\u00a5': 'JPY',
  // The kip sign. In no code page any of these printers has, and the single most likely
  // non-ASCII character in this fleet, so mapping it is what keeps a totals line printable.
  '\u20ad': 'LAK',
};

export interface EncodedText {
  bytes: number[];
  /** Distinct characters that could not be represented. Empty on success. */
  unprintable: string[];
}

/** ASCII plus the fallback table. Anything else is reported, never dropped. */
export function encodeText(value: string): EncodedText {
  const bytes: number[] = [];
  const unprintable = new Set<string>();

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) {
      bytes.push(0x0a);
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      bytes.push(code);
      continue;
    }
    const fallback = PRINT_FALLBACKS[char];
    if (fallback !== undefined) {
      for (let i = 0; i < fallback.length; i++) bytes.push(fallback.charCodeAt(i));
      continue;
    }
    if (code === 0x09) {
      bytes.push(0x20, 0x20);
      continue;
    }
    if (code < 0x20) continue; // other control codes are meaningless on paper
    unprintable.add(char);
  }

  return { bytes, unprintable: [...unprintable] };
}

/** Printable columns for a paper width, per font. Font A is 12 dots wide, font B is 9. */
export function charsPerLine(dotsPerLine: number, font: 'A' | 'B' = 'A'): number {
  return Math.max(1, Math.floor(dotsPerLine / (font === 'A' ? 12 : 9)));
}

const ALIGN_CODE: Record<Align, number> = { left: 0, center: 1, right: 2 };
const HRI_CODE: Record<HriPosition, number> = { none: 0, above: 1, below: 2, both: 3 };

/**
 * `GS k` selector for each symbology, using Function B (m >= 65), which takes an explicit length
 * instead of a NUL terminator — the only form that can carry a value containing a zero byte.
 */
/** The ceiling `GS k` function B's single length byte can express. */
const MAX_BARCODE_BYTES = 255;

const BARCODE_CODE: Record<BarcodeSymbology, number> = {
  UPCA: 65, UPCE: 66, EAN13: 67, EAN8: 68, CODE39: 69, ITF: 70, CODE128: 73,
};

/** What each symbology can actually carry. A printer given the wrong data prints nothing at all. */
function checkBarcode(symbology: BarcodeSymbology, value: string): string | null {
  const digitsOnly = /^\d+$/.test(value);
  switch (symbology) {
    case 'EAN13':
      return digitsOnly && (value.length === 12 || value.length === 13) ? null : 'EAN13 needs 12 or 13 digits';
    case 'EAN8':
      return digitsOnly && (value.length === 7 || value.length === 8) ? null : 'EAN8 needs 7 or 8 digits';
    case 'UPCA':
      return digitsOnly && (value.length === 11 || value.length === 12) ? null : 'UPCA needs 11 or 12 digits';
    case 'UPCE':
      return digitsOnly && (value.length === 6 || value.length === 7 || value.length === 8) ? null : 'UPCE needs 6 to 8 digits';
    case 'ITF':
      return digitsOnly && value.length >= 2 && value.length % 2 === 0 ? null : 'ITF needs an even number of digits';
    case 'CODE39':
      return /^[0-9A-Z\-. $/+%]+$/.test(value) ? null : 'CODE39 allows 0-9 A-Z and - . space $ / + %';
    case 'CODE128':
      // eslint-disable-next-line no-control-regex
      return /^[\x00-\x7f]+$/.test(value) ? null : 'CODE128 needs ASCII';
  }
}

/** A fluent byte builder. Mutable and single-use — one instance per document. */
export class EscPosBuilder {
  private readonly bytes: number[] = [];

  push(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  raw(values: Iterable<number>): this {
    for (const value of values) this.bytes.push(value);
    return this;
  }

  /** `ESC @` — resets font, size, alignment and code page in one command. */
  init(): this {
    return this.push(ESC, 0x40);
  }

  /** `ESC t n` */
  codepage(page: number): this {
    return this.push(ESC, 0x74, page & 0xff);
  }

  /** `ESC a n` */
  align(align: Align): this {
    return this.push(ESC, 0x61, ALIGN_CODE[align]);
  }

  /** `ESC E n` */
  bold(on: boolean): this {
    return this.push(ESC, 0x45, on ? 1 : 0);
  }

  /** `ESC - n` */
  underline(on: boolean): this {
    return this.push(ESC, 0x2d, on ? 1 : 0);
  }

  /** `ESC M n` — font A is the 12-dot face, B the 9-dot one. */
  font(face: 'A' | 'B'): this {
    return this.push(ESC, 0x4d, face === 'B' ? 1 : 0);
  }

  /** `GS ! n` — width in the high nibble, height in the low one, both 1-8 as 0-7. */
  size(width: number, height: number): this {
    const w = Math.min(8, Math.max(1, width)) - 1;
    const h = Math.min(8, Math.max(1, height)) - 1;
    return this.push(GS, 0x21, (w << 4) | h);
  }

  text(value: string, errors: string[], where: string): this {
    const encoded = encodeText(value);
    if (encoded.unprintable.length > 0) {
      errors.push(
        `${where}: cannot print ${encoded.unprintable.map((c) => JSON.stringify(c)).join(', ')} — ` +
          `no ESC/POS code page contains these characters. Send this line as an 'image' element instead.`
      );
    }
    return this.raw(encoded.bytes);
  }

  newline(count = 1): this {
    for (let i = 0; i < count; i++) this.bytes.push(0x0a);
    return this;
  }

  /** `ESC d n` — feed n lines without printing. */
  feed(lines: number): this {
    return this.push(ESC, 0x64, Math.min(255, Math.max(0, lines)));
  }

  /**
   * `GS v 0` raster bit image. `xL xH` counts BYTES per row, `yL yH` counts rows.
   *
   * A set bit is black, which is the same convention the incoming `RasterImage` uses, so no
   * inversion here — unlike the label languages.
   */
  raster(width: number, height: number, data: Buffer): this {
    const rowBytes = rasterRowBytes(width);
    this.push(GS, 0x76, 0x30, 0x00);
    this.push(rowBytes & 0xff, (rowBytes >> 8) & 0xff);
    this.push(height & 0xff, (height >> 8) & 0xff);
    return this.raw(data);
  }

  barcode(
    symbology: BarcodeSymbology,
    value: string,
    options: { height: number; moduleWidth: number; hri: HriPosition },
    errors: string[],
    where: string
  ): this {
    const problem = checkBarcode(symbology, value);
    if (problem) {
      errors.push(`${where}: ${problem}`);
      return this;
    }

    this.push(GS, 0x48, HRI_CODE[options.hri]); // HRI position
    this.push(GS, 0x66, 0x00); // HRI font A
    this.push(GS, 0x68, Math.min(255, Math.max(1, options.height))); // height in dots
    this.push(GS, 0x77, Math.min(6, Math.max(2, options.moduleWidth))); // module width

    // Code128 carries its own code-set selector. `{B` is the ASCII set: without it a printer
    // either guesses or refuses, and the guess differs by vendor.
    const payload = symbology === 'CODE128' && !value.startsWith('{') ? `{B${value}` : value;
    const data = Buffer.from(payload, 'ascii');
    /*
     * `GS k` function B carries a ONE-byte length, and `Buffer.from(number[])` masks anything
     * above 255 rather than complaining. So an over-long value does not fail — it announces a
     * wrong length, the printer reads that many bytes as barcode data, and then reads the rest
     * of the payload as commands: random cuts, drawer kicks, a metre of garbage. Checked after
     * the `{B` prefix, because those two bytes count too. `qr()` below bounds itself the same way.
     */
    if (data.length > MAX_BARCODE_BYTES) {
      errors.push(
        `${where}: ${symbology} value is ${data.length} bytes, over the ${MAX_BARCODE_BYTES} a printer can be told about`
      );
      return this;
    }
    this.push(GS, 0x6b, BARCODE_CODE[symbology], data.length);
    return this.raw(data);
  }

  /** `GS ( k` — model 2 QR, in the four-command sequence every ESC/POS printer expects. */
  qr(value: string, size: number, ec: 'L' | 'M' | 'Q' | 'H', errors: string[], where: string): this {
    const data = Buffer.from(value, 'utf8');
    if (data.length === 0) {
      errors.push(`${where}: qr value is empty`);
      return this;
    }
    if (data.length > 7089) {
      errors.push(`${where}: qr value is ${data.length} bytes, over the 7089-byte model 2 limit`);
      return this;
    }

    this.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
    this.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, size))); // module size
    this.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, { L: 48, M: 49, Q: 50, H: 51 }[ec]);

    // Store: the length covers the three header bytes (0x31 0x50 0x30) plus the data.
    const length = data.length + 3;
    this.push(GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, 0x50, 0x30);
    this.raw(data);

    return this.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print
  }

  /**
   * `GS V 66 n` — partial cut after feeding n dots.
   *
   * Partial rather than `GS V 0`, matching the POS terminal: a full cut on a printer without an
   * auto-cutter present is a no-op on some models and an error on others, and the paper tab a
   * partial cut leaves is what stops the next receipt falling on the floor.
   */
  cut(mode: 'partial' | 'full', feedDots: number): this {
    return mode === 'full'
      ? this.push(GS, 0x56, 0x00)
      : this.push(GS, 0x56, 0x42, Math.min(255, Math.max(0, feedDots)));
  }

  /** `ESC p m t1 t2` — pulse the drawer kick connector. */
  drawer(pin: 0 | 1): this {
    return this.push(ESC, 0x70, pin, 25, 250);
  }

  build(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** What a string occupies on paper: the encoder's output, not its code-unit count. */
function printedWidth(value: string): number {
  return encodeText(value).bytes.length;
}

/** The longest prefix of `value` that fits `max` printed columns, cut on a character boundary. */
function truncateToWidth(value: string, max: number): string {
  if (max <= 0) return '';
  let out = '';
  let used = 0;
  for (const char of value) {
    const next = printedWidth(char);
    if (used + next > max) break;
    out += char;
    used += next;
  }
  return out;
}

/**
 * Pad `left` and `right` to fill one line, truncating the left side when they collide.
 *
 * Measured in ENCODED columns, not code units, because `encodeText` expands: `₭` becomes `LAK`,
 * `…` becomes `...`, `½` becomes `1/2`, `°` becomes `deg`. `₭25,000` is seven code units and
 * nine printed columns, so padding by `.length` overran the line by two and wrapped the price
 * onto a row of its own — on the totals line of every receipt in a kip-denominated venue, which
 * is the whole fleet.
 */
export function twoColumns(left: string, right: string, width: number): string {
  const rightWidth = printedWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);
  const room = width - rightWidth;
  // One space minimum, so the price never runs into the name and become unreadable.
  const trimmed = truncateToWidth(left, room - 1);
  return trimmed + ' '.repeat(room - printedWidth(trimmed)) + right;
}

function applyElement(
  builder: EscPosBuilder,
  element: ReceiptElement,
  index: number,
  width: number,
  errors: string[]
): void {
  const where = `elements[${index}]`;
  switch (element.type) {
    case 'text':
      builder.align(element.align ?? 'left');
      builder.font(element.font ?? 'A');
      builder.bold(element.bold === true);
      builder.underline(element.underline === true);
      builder.size(element.width ?? 1, element.height ?? 1);
      builder.text(element.value, errors, where);
      builder.newline();
      // Reset, so an element never inherits styling from the one before it. A document is a list
      // of independent rows, not a stream of mode changes.
      builder.size(1, 1).bold(false).underline(false).font('A').align('left');
      break;

    case 'columns': {
      const font = element.font ?? 'A';
      builder.align('left').font(font).bold(element.bold === true);
      builder.text(twoColumns(element.left, element.right, charsPerLine(width, font)), errors, where);
      builder.newline();
      builder.bold(false).font('A');
      break;
    }

    case 'rule': {
      builder.align('left').font('A');
      // Counted in printed columns for the same reason `twoColumns` is: a rule drawn with `°`
      // encodes to `deg` and would otherwise run three lines long.
      const mark = element.char ?? '-';
      const markWidth = printedWidth(mark) || 1;
      builder.text(mark.repeat(Math.max(1, Math.floor(charsPerLine(width, 'A') / markWidth))), errors, where);
      builder.newline();
      break;
    }

    case 'feed':
      builder.feed(element.lines ?? 1);
      break;

    case 'image': {
      const data = decodeRaster(element.image);
      builder.align(element.align ?? 'center');
      builder.raster(element.image.width, element.image.height, data);
      builder.align('left');
      if (element.image.width > width) {
        errors.push(`${where}: image is ${element.image.width} dots wide but the paper prints ${width}`);
      }
      break;
    }

    case 'barcode':
      builder.align(element.align ?? 'center');
      builder.barcode(
        element.symbology,
        element.value,
        { height: element.height ?? 80, moduleWidth: element.module_width ?? 3, hri: element.hri ?? 'below' },
        errors,
        where
      );
      builder.newline().align('left');
      break;

    case 'qr':
      builder.align(element.align ?? 'center');
      builder.qr(element.value, element.size ?? 6, element.ec ?? 'M', errors, where);
      builder.newline().align('left');
      break;

    case 'cut':
      builder.cut(element.mode ?? 'partial', element.feed ?? 100);
      break;

    case 'drawer':
      builder.drawer(element.pin ?? 0);
      break;
  }
}

export function renderReceiptEscPos(document: ReceiptDocument, printer: PrinterRecord): Buffer {
  const errors: string[] = [];
  const width = document.dots_per_line ?? printer.dots_per_line ?? 576;
  const builder = new EscPosBuilder().init();

  const codepage = document.codepage ?? printer.codepage;
  if (codepage !== undefined) builder.codepage(codepage);

  for (const [index, element] of document.elements.entries()) {
    applyElement(builder, element, index, width, errors);
  }

  if (errors.length > 0) throw new RenderError(errors);

  // Only when the document did not already ask for one, so a caller printing two slips back to
  // back does not get a stray cut between them.
  const endsWithCut = document.elements.at(-1)?.type === 'cut';
  if (document.cut !== false && !endsWithCut) builder.feed(3).cut('partial', 100);

  return builder.build();
}

/**
 * A label document on a receipt printer.
 *
 * ESC/POS has no coordinate system, so the canvas is flattened: elements are sorted top to bottom
 * and printed in that order, with the x offset ignored. Not a substitute for a real label printer,
 * but it is what makes "print a barcode" work in a venue that owns one thermal printer — which is
 * most of them.
 */
export function renderLabelEscPos(document: LabelDocument, printer: PrinterRecord): Buffer {
  const errors: string[] = [];
  const width = printer.dots_per_line ?? 576;
  const builder = new EscPosBuilder().init();
  const ordered = [...document.elements].sort((a, b) => a.y - b.y || a.x - b.x);

  for (const [index, element] of ordered.entries()) {
    const where = `elements[${index}]`;
    switch (element.type) {
      case 'text': {
        // Label text is sized in dots; ESC/POS only multiplies its base 24-dot cell.
        const multiplier = Math.min(8, Math.max(1, Math.round((element.height ?? 24) / 24)));
        builder.align('left').bold(element.bold === true).size(multiplier, multiplier);
        builder.text(element.value, errors, where);
        builder.newline().size(1, 1).bold(false);
        break;
      }
      case 'barcode':
        builder.align('center').barcode(
          element.symbology, element.value,
          { height: Math.min(255, element.height ?? 80), moduleWidth: Math.min(6, Math.max(2, element.module_width ?? 2)), hri: element.hri ?? 'below' },
          errors, where
        );
        builder.newline().align('left');
        break;
      case 'qr':
        builder.align('center').qr(element.value, element.size ?? 5, element.ec ?? 'M', errors, where);
        builder.newline().align('left');
        break;
      case 'image':
        builder.align('center').raster(element.image.width, element.image.height, decodeRaster(element.image));
        builder.align('left');
        if (element.image.width > width) {
          errors.push(`${where}: image is ${element.image.width} dots wide but the paper prints ${width}`);
        }
        break;
      case 'box':
      case 'line':
        // No line-drawing primitive exists in ESC/POS; a rule is the closest honest equivalent.
        builder.align('left').text('-'.repeat(charsPerLine(width, 'A')), errors, where).newline();
        break;
    }
  }

  if (errors.length > 0) throw new RenderError(errors);

  builder.feed(3).cut('partial', 100);
  const once = builder.build();
  // ESC/POS has no `PRINT n` — copies are repetition.
  return Buffer.concat(Array.from({ length: Math.max(1, document.copies ?? 1) }, () => once));
}
