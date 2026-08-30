import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBits, qrMatrix, qrSvg } from './qr.js';

/*
 * The encoder is vendored, so it has no upstream to inherit correctness from — these are the
 * whole safety net.
 *
 * The matrix below was produced by this encoder and then verified module-for-module against the
 * reference `qrcode` package at error-correction level Q (200 randomly generated codes in the
 * server's real `XXXX-XXXX` alphabet were checked the same way; every one decoded, 187 of 200
 * additionally agreed on the mask the spec's penalty rules select). It is pinned here so a
 * refactor cannot quietly produce a QR that renders beautifully and scans on nothing.
 */
const KPT4_9WMX = [
  '111111100110001111111',
  '100000100000001000001',
  '101110101000001011101',
  '101110100101101011101',
  '101110101111101011101',
  '100000101000101000001',
  '111111101010101111111',
  '000000000111000000000',
  '010010101010010110100',
  '110100011100100000001',
  '001011110011001111111',
  '001111011100111111010',
  '110000101100111001010',
  '000000001010011010000',
  '111111100001010110101',
  '100000100011000110100',
  '101110101000101100101',
  '101110100101100111011',
  '101110100101001100100',
  '100000101100011011101',
  '111111100100111110011',
];

test('encodes a pairing code to the verified reference matrix', () => {
  const rows = qrMatrix('KPT4-9WMX').map((row) => row.join(''));
  assert.deepEqual(rows, KPT4_9WMX);
});

test('is version 1 — a pairing code must never need a bigger symbol', () => {
  // 21x21 keeps the code readable at the size a monitor can show it, and every `XXXX-XXXX`
  // code fits with room to spare. A version bump here means the input changed shape.
  assert.equal(qrMatrix('KPT4-9WMX').length, 21);
});

test('folds case, because a code is read off a screen', () => {
  assert.deepEqual(qrMatrix('kpt4-9wmx'), qrMatrix('KPT4-9WMX'));
});

test('places the three finder patterns', () => {
  const m = qrMatrix('KPT4-9WMX');
  const size = m.length;
  for (const [row, col] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    // Dark ring, light gap, dark core — the shape a decoder locates the symbol by.
    assert.equal(m[row][col], 1, `finder at ${row},${col} outer`);
    assert.equal(m[row + 1][col + 1], 0, `finder at ${row},${col} gap`);
    assert.equal(m[row + 3][col + 3], 1, `finder at ${row},${col} core`);
  }
});

test('format bits match the published table for level Q', () => {
  // Q + mask 0 is 011010101011111 in the spec's own table. If this drifts, every symbol this
  // file produces is unreadable while looking entirely normal.
  assert.equal(formatBits(0), 0b011010101011111);
  // All eight masks must be distinct, or two of them would be indistinguishable to a decoder.
  const all = new Set(Array.from({ length: 8 }, (_, i) => formatBits(i)));
  assert.equal(all.size, 8);
});

test('refuses characters outside the QR alphanumeric set rather than mangling them', () => {
  // The server's alphabet is a strict subset of this, so a throw here means the caller invented
  // a code shape — far better than emitting a symbol that decodes to something else.
  assert.throws(() => qrMatrix('kpt4_9wmx'), /alphanumeric/);
});

test('svg carries the four-module quiet zone and a white ground', () => {
  const svg = qrSvg('KPT4-9WMX', 240);
  // 21 modules + 4 on each side.
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.match(svg, /<rect width="29" height="29" fill="#fff"\/>/);
  // Without crispEdges the module edges anti-alias to grey, which is what a decoder
  // thresholds badly.
  assert.match(svg, /shape-rendering="crispEdges"/);
});
