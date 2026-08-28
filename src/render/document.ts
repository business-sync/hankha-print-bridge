/*
 * The job document: what a caller sends when it wants the bridge to build the bytes.
 *
 * Until now every caller built its own ESC/POS and the bridge forwarded an opaque blob. That still
 * works and always will (`payload_base64`), but it forces every client to own a printer-command
 * encoder — the POS terminal has one, the vendor portal grew a second, and neither can drive a
 * label printer at all. A document is the alternative: describe the slip, and let the bridge emit
 * whichever language the target printer speaks.
 *
 * Two shapes, because receipts and labels are genuinely different problems:
 *
 *  - `ReceiptDocument` is a FLOW. Elements print in order, the paper advances, and position is
 *    expressed as alignment. That is what ESC/POS is.
 *  - `LabelDocument` is a CANVAS. Every element carries x/y in dots, because ZPL, TSPL and EPL2 are
 *    all positional and a flow model would have to invent coordinates none of them can infer.
 *
 * Media geometry stays in millimetres (that is how a label roll is sold and how TSPL's `SIZE` wants
 * it) while element coordinates are in dots (what ZPL's `^FO` and EPL's `A` want). `dpi` converts
 * between the two, and only the renderers that need the conversion do it.
 */

export type Align = 'left' | 'center' | 'right';
export type Rotation = 0 | 90 | 180 | 270;
export type HriPosition = 'none' | 'above' | 'below' | 'both';
export type ErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export type BarcodeSymbology = 'CODE128' | 'CODE39' | 'EAN13' | 'EAN8' | 'UPCA' | 'UPCE' | 'ITF';

export const BARCODE_SYMBOLOGIES: BarcodeSymbology[] = [
  'CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'ITF',
];

/**
 * A 1-bit bitmap, packed MSB-first, each row padded to a whole number of bytes.
 *
 * Deliberately the exact layout the POS terminal's `packToBits` already produces
 * (`features/printer/lib/raster-renderer.ts`), because this is the channel Lao text arrives
 * through. Lao is in no ESC/POS code page, so it cannot be sent as text to any thermal printer;
 * the POS rasterises it in the browser and the result travels as one of these. A set bit is BLACK
 * here — the renderers invert where their language disagrees.
 */
export interface RasterImage {
  width: number;
  height: number;
  data_base64: string;
}

export type ReceiptElement =
  | { type: 'text'; value: string; align?: Align; bold?: boolean; underline?: boolean; width?: number; height?: number; font?: 'A' | 'B' }
  /** Item on the left, price on the right, filled to the paper width. The commonest receipt row. */
  | { type: 'columns'; left: string; right: string; bold?: boolean; font?: 'A' | 'B' }
  | { type: 'rule'; char?: string }
  | { type: 'feed'; lines?: number }
  | { type: 'image'; image: RasterImage; align?: Align }
  | { type: 'barcode'; symbology: BarcodeSymbology; value: string; height?: number; module_width?: number; hri?: HriPosition; align?: Align }
  | { type: 'qr'; value: string; size?: number; ec?: ErrorCorrection; align?: Align }
  | { type: 'cut'; mode?: 'partial' | 'full'; feed?: number }
  | { type: 'drawer'; pin?: 0 | 1 };

export interface ReceiptDocument {
  kind: 'receipt';
  elements: ReceiptElement[];
  /** Overrides the printer's own width. 576 on 80 mm paper, 384 on 58 mm. */
  dots_per_line?: number;
  /** ESC/POS `ESC t n`. Only changes bytes above 0x7F; ASCII is identical on every page. */
  codepage?: number;
  /** Append a partial cut unless the document already ends with one. Defaults to true. */
  cut?: boolean;
}

export type LabelElement =
  | { type: 'text'; x: number; y: number; value: string; height?: number; width?: number; rotation?: Rotation; bold?: boolean }
  | { type: 'barcode'; x: number; y: number; symbology: BarcodeSymbology; value: string; height?: number; module_width?: number; hri?: HriPosition; rotation?: Rotation }
  | { type: 'qr'; x: number; y: number; value: string; size?: number; ec?: ErrorCorrection; rotation?: Rotation }
  | { type: 'image'; x: number; y: number; image: RasterImage }
  | { type: 'box'; x: number; y: number; width: number; height: number; thickness?: number }
  | { type: 'line'; x: number; y: number; width: number; height: number };

export interface LabelDocument {
  kind: 'label';
  elements: LabelElement[];
  width_mm?: number;
  height_mm?: number;
  gap_mm?: number;
  dpi?: number;
  /** Label printers repeat natively, which is faster and keeps the roll registered. */
  copies?: number;
  /** Print head heat, 0-15 on TSPL/EPL, 0-30 on ZPL. Clamped by the renderer. */
  darkness?: number;
  speed?: number;
}

export type JobDocument = ReceiptDocument | LabelDocument;

/* ------------------------------------------------------------------ validation helpers */

export interface DocumentParse<T> {
  document: T | null;
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(raw: unknown, field: string, where: string, errors: string[], required = true): string {
  if (typeof raw === 'string') return raw;
  if (raw === undefined && !required) return '';
  errors.push(`${where}: ${field} must be a string`);
  return '';
}

function int(raw: unknown, field: string, where: string, errors: string[], min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`${where}: ${field} must be a number`);
    return fallback;
  }
  const rounded = Math.round(raw);
  if (rounded < min || rounded > max) {
    errors.push(`${where}: ${field} must be between ${min} and ${max}`);
    return fallback;
  }
  return rounded;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string, where: string, errors: string[], fallback: T): T {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
  errors.push(`${where}: ${field} must be one of ${allowed.join(', ')}`);
  return fallback;
}

const ALIGNS = ['left', 'center', 'right'] as const;
const HRIS = ['none', 'above', 'below', 'both'] as const;
const ECS = ['L', 'M', 'Q', 'H'] as const;
const ROTATIONS = [0, 90, 180, 270];

function rotation(raw: unknown, where: string, errors: string[]): Rotation {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number' && ROTATIONS.includes(raw)) return raw as Rotation;
  errors.push(`${where}: rotation must be 0, 90, 180 or 270`);
  return 0;
}

/**
 * Decode a raster and check that its byte count matches its declared dimensions.
 *
 * Worth failing loudly on: a mismatch does not error at the printer, it shears the image and every
 * row after it, so the slip prints and looks like a font problem rather than a data problem.
 */
export function decodeRaster(image: RasterImage): Buffer {
  return Buffer.from(image.data_base64, 'base64');
}

export function rasterRowBytes(width: number): number {
  return Math.ceil(width / 8);
}

function parseRaster(raw: unknown, where: string, errors: string[]): RasterImage | null {
  const record = asRecord(raw);
  if (!record) {
    errors.push(`${where}: image must be an object`);
    return null;
  }
  const width = int(record.width, 'image.width', where, errors, 1, 4096, 0);
  const height = int(record.height, 'image.height', where, errors, 1, 8192, 0);
  const data_base64 = str(record.data_base64, 'image.data_base64', where, errors);
  if (!width || !height || !data_base64) return null;

  const expected = rasterRowBytes(width) * height;
  const actual = Buffer.from(data_base64, 'base64').length;
  if (actual !== expected) {
    errors.push(`${where}: image data is ${actual} bytes but ${width}x${height} needs ${expected} (rows pad to whole bytes)`);
    return null;
  }
  return { width, height, data_base64 };
}

/* --------------------------------------------------------------------- receipt parsing */

function parseReceiptElement(raw: unknown, index: number, errors: string[]): ReceiptElement | null {
  const record = asRecord(raw);
  const where = `elements[${index}]`;
  if (!record) {
    errors.push(`${where}: must be an object`);
    return null;
  }
  const before = errors.length;
  const align = () => oneOf(record.align, ALIGNS, 'align', where, errors, 'left');

  let element: ReceiptElement | null = null;
  switch (record.type) {
    case 'text':
      element = {
        type: 'text',
        value: str(record.value, 'value', where, errors),
        align: align(),
        bold: record.bold === true,
        underline: record.underline === true,
        width: int(record.width, 'width', where, errors, 1, 8, 1),
        height: int(record.height, 'height', where, errors, 1, 8, 1),
        font: oneOf(record.font, ['A', 'B'] as const, 'font', where, errors, 'A'),
      };
      break;
    case 'columns':
      element = {
        type: 'columns',
        left: str(record.left, 'left', where, errors),
        right: str(record.right, 'right', where, errors),
        bold: record.bold === true,
        font: oneOf(record.font, ['A', 'B'] as const, 'font', where, errors, 'A'),
      };
      break;
    case 'rule': {
      const char = record.char === undefined ? '-' : str(record.char, 'char', where, errors);
      if (char.length !== 1) errors.push(`${where}: char must be a single character`);
      element = { type: 'rule', char: char.slice(0, 1) || '-' };
      break;
    }
    case 'feed':
      element = { type: 'feed', lines: int(record.lines, 'lines', where, errors, 0, 64, 1) };
      break;
    case 'image': {
      const image = parseRaster(record.image, where, errors);
      element = image ? { type: 'image', image, align: align() } : null;
      break;
    }
    case 'barcode':
      element = {
        type: 'barcode',
        symbology: oneOf(record.symbology, BARCODE_SYMBOLOGIES, 'symbology', where, errors, 'CODE128'),
        value: str(record.value, 'value', where, errors),
        height: int(record.height, 'height', where, errors, 1, 255, 80),
        module_width: int(record.module_width, 'module_width', where, errors, 2, 6, 3),
        hri: oneOf(record.hri, HRIS, 'hri', where, errors, 'below'),
        align: align(),
      };
      break;
    case 'qr':
      element = {
        type: 'qr',
        value: str(record.value, 'value', where, errors),
        size: int(record.size, 'size', where, errors, 1, 16, 6),
        ec: oneOf(record.ec, ECS, 'ec', where, errors, 'M'),
        align: align(),
      };
      break;
    case 'cut':
      element = {
        type: 'cut',
        mode: oneOf(record.mode, ['partial', 'full'] as const, 'mode', where, errors, 'partial'),
        feed: int(record.feed, 'feed', where, errors, 0, 255, 100),
      };
      break;
    case 'drawer':
      element = { type: 'drawer', pin: int(record.pin, 'pin', where, errors, 0, 1, 0) as 0 | 1 };
      break;
    default:
      errors.push(`${where}: unknown element type '${String(record.type)}'`);
      return null;
  }

  return errors.length === before ? element : null;
}

export function parseReceiptDocument(raw: unknown): DocumentParse<ReceiptDocument> {
  const errors: string[] = [];
  const record = asRecord(raw);
  if (!record) return { document: null, errors: ['receipt must be an object'] };

  const list = Array.isArray(record.elements) ? record.elements : null;
  if (!list) return { document: null, errors: ['receipt.elements must be an array'] };
  if (list.length === 0) return { document: null, errors: ['receipt.elements is empty'] };
  if (list.length > 2000) return { document: null, errors: ['receipt.elements is longer than 2000'] };

  const elements: ReceiptElement[] = [];
  for (const [index, entry] of list.entries()) {
    const element = parseReceiptElement(entry, index, errors);
    if (element) elements.push(element);
  }
  if (errors.length > 0) return { document: null, errors };

  return {
    document: {
      kind: 'receipt',
      elements,
      dots_per_line: record.dots_per_line === undefined ? undefined : int(record.dots_per_line, 'dots_per_line', 'receipt', errors, 8, 4096, 576),
      codepage: record.codepage === undefined ? undefined : int(record.codepage, 'codepage', 'receipt', errors, 0, 255, 0),
      cut: record.cut === undefined ? true : record.cut === true,
    },
    errors,
  };
}

/* ----------------------------------------------------------------------- label parsing */

function parseLabelElement(raw: unknown, index: number, errors: string[]): LabelElement | null {
  const record = asRecord(raw);
  const where = `elements[${index}]`;
  if (!record) {
    errors.push(`${where}: must be an object`);
    return null;
  }
  const before = errors.length;
  const x = int(record.x, 'x', where, errors, 0, 20_000, 0);
  const y = int(record.y, 'y', where, errors, 0, 20_000, 0);

  let element: LabelElement | null = null;
  switch (record.type) {
    case 'text':
      element = {
        type: 'text', x, y,
        value: str(record.value, 'value', where, errors),
        // In dots, so a caller sizes text against the same coordinate space it positions it in.
        height: int(record.height, 'height', where, errors, 8, 2000, 24),
        width: int(record.width, 'width', where, errors, 0, 2000, 0),
        rotation: rotation(record.rotation, where, errors),
        bold: record.bold === true,
      };
      break;
    case 'barcode':
      element = {
        type: 'barcode', x, y,
        symbology: oneOf(record.symbology, BARCODE_SYMBOLOGIES, 'symbology', where, errors, 'CODE128'),
        value: str(record.value, 'value', where, errors),
        height: int(record.height, 'height', where, errors, 8, 2000, 80),
        module_width: int(record.module_width, 'module_width', where, errors, 1, 10, 2),
        hri: oneOf(record.hri, HRIS, 'hri', where, errors, 'below'),
        rotation: rotation(record.rotation, where, errors),
      };
      break;
    case 'qr':
      element = {
        type: 'qr', x, y,
        value: str(record.value, 'value', where, errors),
        size: int(record.size, 'size', where, errors, 1, 16, 5),
        ec: oneOf(record.ec, ECS, 'ec', where, errors, 'M'),
        rotation: rotation(record.rotation, where, errors),
      };
      break;
    case 'image': {
      const image = parseRaster(record.image, where, errors);
      element = image ? { type: 'image', x, y, image } : null;
      break;
    }
    case 'box':
      element = {
        type: 'box', x, y,
        width: int(record.width, 'width', where, errors, 1, 20_000, 100),
        height: int(record.height, 'height', where, errors, 1, 20_000, 100),
        thickness: int(record.thickness, 'thickness', where, errors, 1, 100, 2),
      };
      break;
    case 'line':
      element = {
        type: 'line', x, y,
        width: int(record.width, 'width', where, errors, 1, 20_000, 100),
        height: int(record.height, 'height', where, errors, 1, 20_000, 2),
      };
      break;
    default:
      errors.push(`${where}: unknown element type '${String(record.type)}'`);
      return null;
  }

  return errors.length === before ? element : null;
}

export function parseLabelDocument(raw: unknown): DocumentParse<LabelDocument> {
  const errors: string[] = [];
  const record = asRecord(raw);
  if (!record) return { document: null, errors: ['label must be an object'] };

  const list = Array.isArray(record.elements) ? record.elements : null;
  if (!list) return { document: null, errors: ['label.elements must be an array'] };
  if (list.length === 0) return { document: null, errors: ['label.elements is empty'] };
  if (list.length > 500) return { document: null, errors: ['label.elements is longer than 500'] };

  const elements: LabelElement[] = [];
  for (const [index, entry] of list.entries()) {
    const element = parseLabelElement(entry, index, errors);
    if (element) elements.push(element);
  }

  const document: LabelDocument = {
    kind: 'label',
    elements,
    width_mm: record.width_mm === undefined ? undefined : int(record.width_mm, 'width_mm', 'label', errors, 1, 1000, 50),
    height_mm: record.height_mm === undefined ? undefined : int(record.height_mm, 'height_mm', 'label', errors, 1, 1000, 30),
    gap_mm: record.gap_mm === undefined ? undefined : int(record.gap_mm, 'gap_mm', 'label', errors, 0, 100, 2),
    dpi: record.dpi === undefined ? undefined : int(record.dpi, 'dpi', 'label', errors, 100, 1200, 203),
    copies: int(record.copies, 'copies', 'label', errors, 1, 999, 1),
    darkness: record.darkness === undefined ? undefined : int(record.darkness, 'darkness', 'label', errors, 0, 30, 8),
    speed: record.speed === undefined ? undefined : int(record.speed, 'speed', 'label', errors, 1, 14, 4),
  };

  return errors.length > 0 ? { document: null, errors } : { document, errors };
}

/** Millimetres to dots at a given head resolution. Labels are sold in mm; every language wants dots. */
export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}
