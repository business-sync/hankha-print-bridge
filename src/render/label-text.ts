/*
 * Shared text handling for the three label languages.
 *
 * Deliberately the SAME rule as ESC/POS: ASCII plus the fallback table, and anything else is an
 * error naming the characters. A Zebra with `^CI28` will accept UTF-8 bytes, but its resident
 * scalable font has no Lao glyphs, so the label would come out blank in exactly the way that cost
 * this project a week the first time. One rule across all four languages is also one rule to
 * remember: non-Latin goes through an `image` element, everywhere.
 */
import { encodeText } from './escpos.js';

export function labelText(value: string, errors: string[], where: string): string {
  const encoded = encodeText(value);
  if (encoded.unprintable.length > 0) {
    errors.push(
      `${where}: cannot print ${encoded.unprintable.map((c) => JSON.stringify(c)).join(', ')} — ` +
        `the printer's resident font has no such glyphs. Send this as an 'image' element instead.`
    );
  }
  return Buffer.from(encoded.bytes).toString('latin1');
}

/**
 * Flip every bit.
 *
 * ESC/POS `GS v 0` and ZPL `^GF` treat a set bit as BLACK; TSPL `BITMAP` and EPL2 `GW` treat a set
 * bit as WHITE. `RasterImage` is defined as set-bit-is-black, so those two languages get the
 * inverse. Getting this wrong produces a solid black label with white text, which wastes a roll
 * and is instantly recognisable — but only if you know to look for it.
 */
export function invertBits(data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = ~(data[i] ?? 0) & 0xff;
  return out;
}
