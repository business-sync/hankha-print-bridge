import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { renderJobDocument, resolveRelayPrinter } from './jobs.js';
import { parseRegistry, type PrinterRecord } from './registry.js';

/**
 * Rendering a document that arrived over the RELAY.
 *
 * The relay used to carry pre-rendered bytes and nothing else, which meant the POS decided the
 * paper width. That is fine on a till wired to its own printer and wrong everywhere else: a
 * tablet is paired to a station it has never seen and cannot know whether the roll is 58 mm or
 * 80 mm. Sending the document instead lets the machine holding the printer render for it.
 *
 * `renderJobDocument` is the seam. It shares `prepare()`'s parsing, size cap and error handling
 * — the relay only resolves the printer differently, so that it can report `device-missing`
 * against the id or address the server actually sent.
 */

function receiptPrinter(over: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: 'till',
    name: 'Till',
    transport: 'network',
    type: 'receipt',
    language: 'escpos',
    enabled: true,
    address: '192.168.18.103',
    port: 9100,
    dots_per_line: 576,
    ...over,
  };
}

function labelPrinter(over: Partial<PrinterRecord> = {}): PrinterRecord {
  return {
    id: 'labels',
    name: 'Labels',
    transport: 'network',
    type: 'label',
    language: 'tspl',
    enabled: true,
    address: '192.168.18.104',
    port: 9100,
    width_mm: 50,
    height_mm: 30,
    gap_mm: 2,
    dpi: 203,
    ...over,
  };
}

describe('renderJobDocument', () => {
  it('renders a receipt document to ESC/POS bytes', () => {
    const out = renderJobDocument(
      { kind: 'receipt', elements: [{ type: 'text', value: 'TOTAL 25,000' }] },
      receiptPrinter(),
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    // `ESC @` initialises every slip this renderer emits.
    assert.equal(out.payload.subarray(0, 2).toString('latin1'), '\x1b@');
    assert.match(out.payload.toString('latin1'), /TOTAL 25,000/);
  });

  /*
   * Renders for the PRINTER, not for a width the caller guessed. This is the entire reason the
   * document form exists, so it is worth pinning: the same document on a 58 mm roll must not
   * produce the same bytes as on 80 mm.
   */
  it('lays out to the destination printer’s own paper width', () => {
    const doc = {
      kind: 'receipt' as const,
      elements: [{ type: 'columns', left: 'Coffee', right: '25,000' }],
    };
    const wide = renderJobDocument(doc, receiptPrinter({ dots_per_line: 576 }));
    const narrow = renderJobDocument(doc, receiptPrinter({ dots_per_line: 384 }));
    assert.equal(wide.ok && narrow.ok, true);
    if (!wide.ok || !narrow.ok) return;
    assert.notEqual(wide.payload.toString('latin1'), narrow.payload.toString('latin1'));
  });

  /*
   * The other half of that rule: a caller MAY pin the width, and a pinned slip too wide for the
   * roll is refused rather than wrapped.
   *
   * A pin means "already laid out" — pre-padded rows, paper-width bitmaps — so there is nothing
   * left to re-flow. Printing it anyway wraps every row and reports success, which reads as a
   * broken printer. The server refuses these before queueing, so reaching here means a job that
   * was queued while the registry still said something else; refusing is the honest end.
   */
  it('refuses a pinned slip too wide for the roll, and says both widths', () => {
    const out = renderJobDocument(
      {
        kind: 'receipt' as const,
        elements: [{ type: 'columns', left: 'TOTAL', right: '388,000' }],
        dots_per_line: 576,
      },
      receiptPrinter({ dots_per_line: 384 }),
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.errors.join('; '), /576/);
    assert.match(out.errors.join('; '), /384/);
  });

  it('prints a pinned slip NARROWER than the roll', () => {
    // A 58 mm slip on an 80 mm printer is merely narrow. Refusing it would break every venue
    // that runs mixed rolls, which is most of them.
    const out = renderJobDocument(
      {
        kind: 'receipt' as const,
        elements: [{ type: 'columns', left: 'Coffee', right: '25,000' }],
        dots_per_line: 384,
      },
      receiptPrinter({ dots_per_line: 576 }),
    );
    assert.equal(out.ok, true);
  });

  it('dispatches on the document’s own kind, and speaks the label printer’s language', () => {
    const out = renderJobDocument(
      {
        kind: 'label',
        elements: [{ type: 'text', x: 10, y: 10, value: 'BATCH 42' }],
      },
      labelPrinter(),
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    // TSPL is line-oriented and starts by declaring the media.
    assert.match(out.payload.toString('latin1'), /^SIZE 50 mm,30 mm/);
  });

  /*
   * The anti-regression that matters most on this path. An earlier sanitiser silently DROPPED
   * codepoints it could not encode, so `2x <Lao dish>` printed as `2x ` with no error anywhere
   * — a kitchen ticket that named no dish. Lao is in no ESC/POS code page (CP874 is Thai), so
   * the only correct answer is to refuse and say what to send instead.
   */
  it('refuses Lao text rather than dropping it, and names the way out', () => {
    const out = renderJobDocument(
      { kind: 'receipt', elements: [{ type: 'text', value: '2x ເຂົ້າຜັດໄກ່' }] },
      receiptPrinter(),
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.errors.join(' '), /'image' element/);
  });

  it('returns a receipt-on-a-label-printer as an error, never as a truncated slip', () => {
    const out = renderJobDocument(
      { kind: 'receipt', elements: [{ type: 'text', value: 'BILL' }] },
      labelPrinter(),
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.errors.join(' '), /TSPL/);
  });

  it('reports every problem with a malformed document rather than throwing', () => {
    const out = renderJobDocument({ kind: 'receipt', elements: 'not-an-array' }, receiptPrinter());
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.ok(out.errors.length > 0);
  });

  it('treats a document that is not an object as a parse failure, not a crash', () => {
    for (const bad of [null, undefined, 42, 'receipt']) {
      const out = renderJobDocument(bad, receiptPrinter());
      assert.equal(out.ok, false, `expected ${String(bad)} to be refused`);
    }
  });
});

/**
 * Which printer a CLOUD job lands on — and, the case that mattered, which one it must NOT.
 *
 * The relay used to resolve `findPrinter(id) ?? resolveByAddress(...) ?? adHocNetworkPrinter(...)`.
 * The first never looked at `enabled`. The second did, which handed the third a null it read as
 * "nobody registered this address" and dialled — so a printer the operator had turned off in the
 * POS still printed relay jobs. `resolveRelayPrinter` is the seam that decides, and it is pure: no
 * disk, no socket, so every case below is a plain function call.
 */
describe('resolveRelayPrinter', () => {
  const { registry, errors } = parseRegistry({
    printers: [
      { id: 'counter', name: 'Counter', transport: 'network', address: '192.168.18.103' },
      // A USB printer given an address — the workaround that predates `printer_id`.
      { id: 'kitchen', name: 'Kitchen', transport: 'usb', queue: 'SPRT_SP_EP', address: '192.168.18.200' },
      { id: 'retired', name: 'Retired', transport: 'network', address: '192.168.18.9', enabled: false },
      // A printer retired and replaced on the same IP. The turned-off entry comes FIRST, so a
      // lookup that simply took the first match at the address would pick the wrong one.
      { id: 'swap-old', name: 'Old', transport: 'network', address: '192.168.18.50', enabled: false },
      { id: 'swap-new', name: 'New', transport: 'network', address: '192.168.18.50' },
    ],
  });

  // A typo here would silently drop an entry and turn a refusal test into a "no match" test that
  // still passes.
  before(() => assert.deepEqual(errors, [], 'the fixture registry must parse cleanly'));

  type Resolved = ReturnType<typeof resolveRelayPrinter>;
  /** The printer a job landed on. Fails the test, quoting the refusal, if it was refused instead. */
  const landed = (out: Resolved): PrinterRecord => {
    assert.ok(!('error' in out), `expected a printer, but the job was refused: ${'error' in out ? out.error : ''}`);
    return out;
  };
  /** The sentence a job was refused with. Fails the test if it landed on a printer instead. */
  const refusal = (out: Resolved): string => {
    assert.ok('error' in out, `expected a refusal, but the job landed on '${'id' in out ? out.id : ''}'`);
    return out.error;
  };

  describe('a printer the operator turned off', () => {
    it('refuses a printer_id that names it, and says which printer and why', () => {
      const out = resolveRelayPrinter(registry, { printer_id: 'retired', target_ip: null, target_port: 9100 });
      assert.equal(refusal(out), "printer 'retired' is disabled on this bridge");
    });

    // The id is FINAL. A server that sent both an id and an address meant the id; quietly printing
    // on the address instead would put a slip on a printer nobody chose.
    it('does not fall back to the address a job also carries', () => {
      const out = resolveRelayPrinter(registry, {
        printer_id: 'retired', target_ip: '192.168.18.103', target_port: 9100,
      });
      assert.match(refusal(out), /'retired' is disabled on this bridge/);
    });

    it('refuses an address it claims instead of dialling that address ad hoc', () => {
      const out = resolveRelayPrinter(registry, { target_ip: '192.168.18.9', target_port: 9100 });
      assert.equal(refusal(out), "printer 'retired' at 192.168.18.9:9100 is disabled on this bridge");
    });

    it('lets an enabled printer take over its address', () => {
      // `swap-old` is listed first and is turned off; the replacement moved onto its IP must not
      // be blocked by it.
      const printer = landed(resolveRelayPrinter(registry, { target_ip: '192.168.18.50', target_port: 9100 }));
      assert.equal(printer.id, 'swap-new');
    });
  });

  describe('everything else resolves as it always did', () => {
    it('dials an address no registry entry claims, ad hoc', () => {
      const printer = landed(resolveRelayPrinter(registry, { target_ip: '192.168.18.77', target_port: 9100 }));
      assert.equal(printer.id, 'net:192.168.18.77:9100');
      assert.equal(printer.transport, 'network');
      assert.equal(printer.enabled, true);
    });

    it('resolves an enabled printer by id', () => {
      const printer = landed(
        resolveRelayPrinter(registry, { printer_id: 'counter', target_ip: null, target_port: 9100 }),
      );
      assert.equal(printer.id, 'counter');
    });

    it('prefers the id over an address that names a different enabled printer', () => {
      const printer = landed(
        resolveRelayPrinter(registry, { printer_id: 'counter', target_ip: '192.168.18.200', target_port: 9100 }),
      );
      assert.equal(printer.id, 'counter');
    });

    it('reaches a USB printer through the address it declares', () => {
      const printer = landed(resolveRelayPrinter(registry, { target_ip: '192.168.18.200', target_port: 9100 }));
      assert.equal(printer.id, 'kitchen');
      assert.equal(printer.transport, 'usb');
    });

    it('falls back to the address when the id is one this bridge has never heard of', () => {
      // A server holding a stale registry — not a decision to print somewhere else.
      const printer = landed(
        resolveRelayPrinter(registry, { printer_id: 'ghost', target_ip: '192.168.18.103', target_port: 9100 }),
      );
      assert.equal(printer.id, 'counter');
    });

    it('reports an unknown id with no usable address as no match', () => {
      const out = resolveRelayPrinter(registry, { printer_id: 'ghost', target_ip: null, target_port: 9100 });
      assert.equal(refusal(out), 'no printer matches ghost');
    });

    it('refuses a public address rather than dialling it', () => {
      // The bridge only ever dials RFC1918 space and `targetFrom` drops anything else, so this is a
      // refusal by exhaustion rather than a printer lookup.
      const out = resolveRelayPrinter(registry, { target_ip: '8.8.8.8', target_port: 9100 });
      assert.equal(refusal(out), 'no printer matches 8.8.8.8:9100');
    });
  });
});
