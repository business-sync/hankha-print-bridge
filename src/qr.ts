/*
 * A minimal QR encoder, vendored rather than depended on.
 *
 * The bridge ships as a single `bun build --compile` binary with zero runtime dependencies, so
 * `npm i qrcode` is not available to it — and the pairing screen needs a QR or the whole
 * reversed flow collapses back into typing a code by hand.
 *
 * Scope is deliberately tiny, because everything it does not support is complexity that could
 * be wrong: ALPHANUMERIC mode only, error-correction level Q, versions 1 and 2 only. That is
 * exactly what a pairing code needs — `XXXX-XXXX` is nine characters and every one of them
 * (A–Z, 2–9, and `-`) is already in the QR alphanumeric charset, so no byte-mode fallback is
 * required. Versions 1 and 2 at level Q are also both SINGLE-BLOCK, which removes block
 * interleaving from this file entirely.
 *
 * Level Q (~25% recovery) rather than the usual M: this code is read off a glossy monitor at an
 * angle, in a café, by whatever camera the shop happens to own.
 *
 * Verified against the reference `qrcode` package's matrix output — see `qr.test.ts`.
 */

/** A–Z, 0–9 and the eight punctuation characters QR alphanumeric mode allows. */
const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

interface VersionSpec {
  size: number;
  /** Data codewords at EC level Q. */
  dataCodewords: number;
  /** EC codewords at level Q. Single block for both supported versions. */
  ecCodewords: number;
  /** Centres of alignment patterns. Version 1 has none. */
  alignment: number[];
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { size: 21, dataCodewords: 13, ecCodewords: 13, alignment: [] },
  2: { size: 25, dataCodewords: 22, ecCodewords: 22, alignment: [6, 18] },
};

// ─── GF(256) ────────────────────────────────────────────────────────────────
// Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D), as the QR spec requires.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number);
}

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      const coeff = poly[j] as number;
      next[j] = (next[j] as number) ^ coeff;
      next[j + 1] = (next[j + 1] as number) ^ gfMul(coeff, EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: number[], ecCount: number): number[] {
  const gen = generatorPoly(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < ecCount; i++) {
      remainder[i] = (remainder[i] as number) ^ gfMul(gen[i + 1] as number, factor);
    }
  }
  return remainder;
}

// ─── Bit buffer ─────────────────────────────────────────────────────────────

class Bits {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      out.push(byte);
    }
    // 0xEC / 0x11 alternating, as the spec fixes them — not arbitrary filler.
    const pad = [0xec, 0x11] as const;
    let p = 0;
    while (out.length < count) out.push(pad[p++ % 2] as number);
    return out.slice(0, count);
  }
}

// ─── Encoding ───────────────────────────────────────────────────────────────

function encodeAlphanumeric(text: string, spec: VersionSpec): number[] {
  const bits = new Bits();
  bits.push(0b0010, 4); // alphanumeric mode indicator
  bits.push(text.length, 9); // count indicator is 9 bits for versions 1–9

  for (let i = 0; i < text.length; i += 2) {
    const first = ALPHANUM.indexOf(text[i] as string);
    if (first < 0) throw new Error(`character not in QR alphanumeric set: ${text[i]}`);
    if (i + 1 < text.length) {
      const second = ALPHANUM.indexOf(text[i + 1] as string);
      if (second < 0) throw new Error(`character not in QR alphanumeric set: ${text[i + 1]}`);
      bits.push(first * 45 + second, 11);
    } else {
      bits.push(first, 6);
    }
  }

  const capacity = spec.dataCodewords * 8;
  if (bits.length > capacity) throw new Error('text too long for this QR version');
  // Terminator: up to four zero bits, fewer if the capacity is nearly full.
  bits.push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0, 1);

  return bits.toCodewords(spec.dataCodewords);
}

// ─── Matrix ─────────────────────────────────────────────────────────────────

/**
 * A flat grid with explicit accessors.
 *
 * Not `(0|1|null)[][]`: under `noUncheckedIndexedAccess` every `m[r][c]` in a QR encoder is two
 * possibly-undefined reads, and the assertions needed to silence that would outnumber the
 * logic. `-1` means "not yet written", which the data placement depends on.
 */
class Grid {
  readonly size: number;
  private readonly cells: Int8Array;
  /** Which modules the zigzag actually wrote — the only ones a mask may flip. */
  private readonly data: Uint8Array;

  constructor(size: number, from?: Grid) {
    this.size = size;
    this.cells = from ? Int8Array.from(from.cells) : new Int8Array(size * size).fill(-1);
    this.data = from ? Uint8Array.from(from.data) : new Uint8Array(size * size);
  }

  get(r: number, c: number): number {
    return this.cells[r * this.size + c] as number;
  }

  set(r: number, c: number, v: number): void {
    this.cells[r * this.size + c] = v;
  }

  isUnset(r: number, c: number): boolean {
    return this.get(r, c) === -1;
  }

  markData(r: number, c: number): void {
    this.data[r * this.size + c] = 1;
  }

  isData(r: number, c: number): boolean {
    return this.data[r * this.size + c] === 1;
  }

  /** 1 for dark, 0 for anything else — including modules that were never written. */
  dark(r: number, c: number): number {
    return this.get(r, c) === 1 ? 1 : 0;
  }

  clone(): Grid {
    return new Grid(this.size, this);
  }

  toMatrix(): (0 | 1)[][] {
    return Array.from({ length: this.size }, (_, r) =>
      Array.from({ length: this.size }, (_, c) => (this.dark(r, c) as 0 | 1))
    );
  }
}

function placeFinder(g: Grid, row: number, col: number): void {
  // -1..7 so the one-module light separator around each finder is written too.
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= g.size || cc >= g.size) continue;
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      g.set(rr, cc, inside && (edge || core) ? 1 : 0);
    }
  }
}

function placeAlignment(g: Grid, spec: VersionSpec): void {
  const centres = spec.alignment;
  const last = centres[centres.length - 1];
  for (const r of centres) {
    for (const c of centres) {
      // The three corners already carry finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          g.set(r + dr, c + dc, edge || (dr === 0 && dc === 0) ? 1 : 0);
        }
      }
    }
  }
}

function placeTimingAndReserved(g: Grid): void {
  const size = g.size;
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    g.set(6, i, bit);
    g.set(i, 6, bit);
  }
  // Always-dark module, just above the bottom-left finder's format strip.
  g.set(size - 8, 8, 1);
  // Reserve both format-information strips so the data zigzag steps over them. The real bits
  // are written per-mask afterwards.
  for (let i = 0; i < 9; i++) {
    if (g.isUnset(8, i)) g.set(8, i, 0);
    if (g.isUnset(i, 8)) g.set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (g.isUnset(8, size - 1 - i)) g.set(8, size - 1 - i, 0);
    if (g.isUnset(size - 1 - i, 8)) g.set(size - 1 - i, 8, 0);
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const maskFn = (i: number) => MASKS[i] as (r: number, c: number) => boolean;

/** Two-module columns, zigzagging up then down from the bottom right, skipping column 6. */
function placeData(g: Grid, codewords: number[]): void {
  const size = g.size;
  const bits: number[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);

  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern, not a data column at all.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!g.isUnset(row, col)) continue;
        g.set(row, col, bits[index] ?? 0);
        g.markData(row, col);
        index++;
      }
    }
    upward = !upward;
  }
}

function applyMask(base: Grid, mask: number): Grid {
  const out = base.clone();
  const fn = maskFn(mask);
  for (let r = 0; r < out.size; r++) {
    for (let c = 0; c < out.size; c++) {
      if (out.isData(r, c) && fn(r, c)) out.set(r, c, out.get(r, c) === 1 ? 0 : 1);
    }
  }
  return out;
}

/** BCH(15,5) format information: EC level Q (0b11) plus the mask, XORed with the fixed 0x5412. */
export function formatBits(mask: number): number {
  const value = (0b11 << 3) | mask;
  let bch = value << 10;
  for (let i = 14; i >= 10; i--) {
    if ((bch >>> i) & 1) bch ^= 0x537 << (i - 10);
  }
  return ((value << 10) | bch) ^ 0x5412;
}

/**
 * Write both copies of the 15 format bits.
 *
 * ⚠ The two copies run in OPPOSITE directions and it is easy to mirror them: bit 0 sits at the
 * TOP of the left column and at the RIGHT end of row 8, while bit 14 sits at the BOTTOM of the
 * column and the LEFT of the row. Getting this backwards produces a QR whose data modules are
 * all correct and which no decoder will read, because the format strip is the first thing it
 * parses. Row and column 6 are the timing patterns and are stepped over in both runs.
 */
function placeFormat(g: Grid, mask: number): void {
  const size = g.size;
  const bits = formatBits(mask);
  const bit = (i: number) => (bits >>> i) & 1;

  for (let i = 0; i < 15; i++) {
    const value = bit(i);

    // Vertical copy, down column 8: rows 0–5, then 7–8 (skipping the timing row), then the
    // bottom seven above the lower-left finder.
    if (i < 6) g.set(i, 8, value);
    else if (i < 8) g.set(i + 1, 8, value);
    else g.set(size - 15 + i, 8, value);

    // Horizontal copy, along row 8: the rightmost eight, then column 7, then columns 5–0.
    if (i < 8) g.set(8, size - 1 - i, value);
    else if (i === 8) g.set(8, 7, value);
    else g.set(8, 14 - i, value);
  }

  // Always dark, and it is part of the format region rather than the data.
  g.set(size - 8, 8, 1);
}

/** The four penalty rules from the spec; the lowest-scoring mask is the one that ships. */
function penalty(g: Grid): number {
  const size = g.size;
  let score = 0;

  // Rule 1 — runs of five or more identical modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const prev = horizontal ? g.dark(i, j - 1) : g.dark(j - 1, i);
        const cur = horizontal ? g.dark(i, j) : g.dark(j, i);
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — every 2x2 block of a single colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = g.dark(r, c);
      if (v === g.dark(r, c + 1) && v === g.dark(r + 1, c) && v === g.dark(r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 sequence with four light modules on one side.
  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (window: number[], pattern: number[]) => window.every((v, k) => v === pattern[k]);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      for (const horizontal of [true, false]) {
        const window = Array.from({ length: 11 }, (_, k) =>
          horizontal ? g.dark(i, j + k) : g.dark(j + k, i)
        );
        if (matches(window, patternA) || matches(window, patternB)) score += 40;
      }
    }
  }

  // Rule 4 — deviation from an even balance of dark and light.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += g.dark(r, c);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` as a QR matrix of 1s and 0s, row-major.
 *
 * Throws rather than silently truncating or quietly dropping to a weaker error-correction
 * level: a QR that renders but does not scan is the worst possible outcome for this screen, so
 * every route to one is an exception instead.
 */
export function qrMatrix(text: string): (0 | 1)[][] {
  const upper = text.toUpperCase();
  const version = ([1, 2] as const).find((v) => {
    try {
      encodeAlphanumeric(upper, VERSIONS[v] as VersionSpec);
      return true;
    } catch {
      return false;
    }
  });
  if (!version) throw new Error('text does not fit a version 1 or 2 alphanumeric QR');

  const spec = VERSIONS[version] as VersionSpec;
  const data = encodeAlphanumeric(upper, spec);
  const codewords = [...data, ...reedSolomon(data, spec.ecCodewords)];

  const base = new Grid(spec.size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, spec.size - 7);
  placeFinder(base, spec.size - 7, 0);
  placeAlignment(base, spec);
  placeTimingAndReserved(base);
  // Runs on a grid whose reserved regions are already filled, so the zigzag steps over them —
  // and `markData` records exactly which modules a mask is then allowed to flip.
  placeData(base, codewords);

  let best: Grid | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, mask);
    placeFormat(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return (best as Grid).toMatrix();
}

/**
 * The matrix as a self-contained SVG.
 *
 * One `<rect>` per dark module rather than a single path: a few hundred bytes larger, and
 * trivially inspectable when a scan fails. `shape-rendering="crispEdges"` is load-bearing — the
 * default anti-aliases module edges into grey, which is exactly what a decoder thresholds
 * badly.
 *
 * The quiet zone is not decoration. Four light modules on every side is what the spec requires,
 * and its absence is the difference between scanning instantly and not at all — especially on
 * this page, which a viewer may be seeing in dark mode.
 */
export function qrSvg(text: string, pixelSize = 240): string {
  const matrix = qrMatrix(text);
  const quiet = 4;
  const span = matrix.length + quiet * 2;
  const rects: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] as (0 | 1)[];
    for (let c = 0; c < row.length; c++) {
      if (row[c]) rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" ` +
    `width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${span}" height="${span}" fill="#fff"/>` +
    `<g fill="#000">${rects.join('')}</g></svg>`
  );
}
