/*
 * The test slips (a customer receipt and a kitchen ticket) and the test label.
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
import { charsPerLine, type JobDocument, type LabelDocument, type ReceiptDocument, type ReceiptElement } from './render/index.js';

/**
 * Which test slip a receipt-type printer gets.
 *
 * A receipt roll in the kitchen used to get the CUSTOMER sample: item, price, `TOTAL LAK 50,000`,
 * a barcode and a QR. At a venue that pressed Test on its pizza printer, that read as "the
 * kitchen printer prints bills" — the exact misroute staff were trying to rule out. A kitchen
 * printer now prints something shaped like what it will actually print: a station banner, an
 * order number and quantities, no money.
 */
export const SAMPLE_DOCS = ['receipt', 'kitchen'] as const;
export type SampleDoc = (typeof SAMPLE_DOCS)[number];

/** What a caller may ask for. Both optional; the registry's `role` decides when they are absent. */
export interface SampleRequest {
  doc?: SampleDoc;
  /** The station the slip is for (`PIZZA`, `HOT`) — printed as the banner. Implies `kitchen`. */
  station?: string;
}

/** The longest banner a double-width line holds on 58 mm paper (384 dots / 24 / 2 = 16) and then some. */
const STATION_MAX = 20;

/**
 * A station code fit for the banner: upper-case ASCII letters, digits, space, `_` and `-`.
 *
 * Station codes are the POS's ASCII enum (`PIZZA`, `HOT`, `BAR`), but this arrives over HTTP and
 * is printed verbatim, so anything else is dropped rather than sent to the printer as bytes it
 * would interpret. Null when nothing printable is left.
 */
export function stationBanner(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STATION_MAX)
    .trim();
  return cleaned || null;
}

/** What the caller knows beyond the printer itself. */
export interface SampleContext {
  /**
   * The bridge's main receipt printer — `defaultPrinter(registry, 'receipt')`: the one named
   * `default_receipt_printer` ("Use for bills" in the POS console), or the only receipt printer.
   * Null when the registry cannot say, i.e. several receipt printers and none named.
   */
  mainReceiptPrinterId?: string | null;
  /** The kitchen ticket's clock. */
  now?: Date;
}

/**
 * Which test slip a printer gets, honouring what the caller asked for.
 *
 * Label printers always get the label. Otherwise, first match wins:
 *  1. an explicit `doc`;
 *  2. a `station` alone means kitchen;
 *  3. the registry `role`: `kitchen` / `bar` print the kitchen ticket, `receipt` the customer sample;
 *  4. untagged: the main receipt printer prints the customer sample, any OTHER printer the kitchen
 *     ticket. Venues rarely tag roles, and a kitchen printer whose test page reads
 *     `TOTAL LAK 50,000` is taken for a kitchen printer that prints bills. When the registry
 *     cannot say which printer is the main one, untagged stays the customer sample, as every
 *     bridge before 1.14.8 printed.
 */
export function resolveSample(
  printer: PrinterRecord,
  request: SampleRequest = {},
  context: SampleContext = {},
): ResolvedSample {
  if (printer.type === 'label') return { doc: 'label', station: null };
  const asked = stationBanner(request.station);
  const doc: SampleDoc = request.doc ?? (asked ? 'kitchen' : byRegistry(printer, context.mainReceiptPrinterId ?? null));
  if (doc === 'receipt') return { doc, station: null };
  return { doc, station: asked ?? (printer.role === 'bar' ? 'BAR' : 'KITCHEN') };
}

/** Steps 3 and 4 of `resolveSample`: what the registry alone says this printer is for. */
function byRegistry(printer: PrinterRecord, mainReceiptPrinterId: string | null): SampleDoc {
  if (printer.role === 'kitchen' || printer.role === 'bar') return 'kitchen';
  if (printer.role === 'receipt') return 'receipt';
  if (mainReceiptPrinterId === null) return 'receipt';
  return printer.id === mainReceiptPrinterId ? 'receipt' : 'kitchen';
}

/** What `resolveSample` decided — also what the test route logs, so a venue log says which slip came out. */
export interface ResolvedSample {
  doc: SampleDoc | 'label';
  /** The kitchen ticket's banner; null for the receipt and the label. */
  station: string | null;
}

/** The document `resolveSample` picked, ready to render. */
export function sampleFor(printer: PrinterRecord, request: SampleRequest = {}, context: SampleContext = {}): JobDocument {
  const { doc, station } = resolveSample(printer, request, context);
  if (doc === 'label') return sampleLabel(printer);
  if (doc === 'receipt') return sampleReceipt(printer);
  return sampleKitchenTicket(printer, station ?? 'KITCHEN', context.now ?? new Date());
}

/** The printer-facts block both slips open with: what to compare the paper against. */
function diagnostics(printer: PrinterRecord, subtitle: string): ReceiptElement[] {
  const width = printer.dots_per_line ?? 576;
  const columns = charsPerLine(width, 'A');
  // A repeating 0-9 ruler: if the line wraps, the paper is narrower than `dots_per_line` says.
  const ruler = Array.from({ length: columns }, (_, i) => String(i % 10)).join('');
  return [
    { type: 'text', value: 'HANKHA PRINT BRIDGE', align: 'center', bold: true, width: 2, height: 2 },
    { type: 'text', value: subtitle, align: 'center' },
    { type: 'rule' },
    { type: 'columns', left: 'Printer', right: printer.id },
    { type: 'columns', left: 'Transport', right: printer.transport },
    { type: 'columns', left: 'Language', right: printer.language },
    { type: 'columns', left: 'Width', right: `${width} dots / ${columns} cols` },
    { type: 'rule' },
    { type: 'text', value: ruler, font: 'B' },
    { type: 'text', value: 'The ruler above must fit on one line.', font: 'B' },
  ];
}

/**
 * A kitchen ticket with no money on it.
 *
 * Shaped like the slip the POS sends a station — banner, order number and time, big quantities,
 * a modifier line — so a cook holding it sees "this is my kind of paper" and nobody mistakes the
 * printer for the bill printer. No barcode or QR: kitchen tickets never carry them, and a test
 * that exercised them would pass or fail on something the station will never print.
 */
export function sampleKitchenTicket(printer: PrinterRecord, station: string, now: Date = new Date()): ReceiptDocument {
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return {
    kind: 'receipt',
    elements: [
      ...diagnostics(printer, `v${BRIDGE_VERSION} - kitchen test ticket`),
      { type: 'rule', char: '=' },
      { type: 'text', value: station, align: 'center', bold: true, width: 2, height: 2 },
      { type: 'columns', left: '#TEST-0001', right: time, bold: true },
      { type: 'rule' },
      { type: 'text', value: '2x Test item', bold: true, height: 2 },
      { type: 'text', value: '   - no onion' },
      { type: 'text', value: '1x Test item', bold: true, height: 2 },
      { type: 'rule' },
      { type: 'text', value: 'Kitchen ticket - no prices.', align: 'center', font: 'B' },
      { type: 'text', value: 'If you can read this, printing works.', align: 'center', font: 'B' },
      { type: 'cut', mode: 'partial' },
    ],
  };
}

/** The customer sample: priced lines, a total, a barcode and a QR — what the bill printer prints. */
export function sampleReceipt(printer: PrinterRecord): ReceiptDocument {
  return {
    kind: 'receipt',
    elements: [
      ...diagnostics(printer, `v${BRIDGE_VERSION}`),
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
