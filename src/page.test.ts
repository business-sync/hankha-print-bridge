import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INDEX_CSP, INDEX_HTML } from './page.js';

/*
 * What the built page must contain. The backtick guard that protects this file from failing to
 * load at all lives in `page-source.test.ts`, which reads the source as text precisely so it
 * still runs when this one cannot.
 */
test('the literals are balanced — nothing left open', () => {
  // If a literal were left open, everything after it would be swallowed and these markers would
  // vanish from the built output rather than producing an obvious error.
  assert.match(INDEX_HTML, /<\/html>/);
  assert.match(INDEX_HTML, /<style>/);
});

test('no unresolved interpolation reaches the browser', () => {
  // Scoped to MARKUP, not the whole document: the page's own script says `!== undefined` in
  // several places, and a bare substring check flags those. What matters is an interpolation
  // that resolved to nothing and got rendered as text or as an attribute value.
  assert.ok(!/>\s*undefined\s*</.test(INDEX_HTML), 'an interpolation rendered as text');
  assert.ok(!/="undefined"/.test(INDEX_HTML), 'an interpolation rendered into an attribute');
  // `--define` rewrites `process.env.APP_VERSION` inside strings, so writing that literal in
  // this file bakes a broken value into the page. See the file header.
  assert.ok(!INDEX_HTML.includes('process.env.APP_VERSION'), 'APP_VERSION leaked into the page');
});

test('the pairing screen ships with no English baked into the markup', () => {
  // Every string on that screen is written by psRender() from the five-language table, so a Lao
  // till never briefly renders English before the script runs. An empty shell is the contract.
  const section = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<section class="pairscreen"'),
    INDEX_HTML.indexOf('</section>', INDEX_HTML.indexOf('<section class="pairscreen"'))
  );
  assert.ok(section.length > 0, 'pairing screen markup is missing');
  // Only tags and whitespace between them — no text nodes.
  const text = section.replace(/<[^>]*>/g, '').trim();
  assert.equal(text, '');
});

test('the CSP still forbids everything the page does not need', () => {
  // The pairing screen renders a server-built inline SVG, which needs no new source — if a
  // future change reaches for an external QR image, this is what should stop it.
  assert.match(INDEX_CSP, /default-src 'none'/);
  assert.match(INDEX_CSP, /connect-src 'self'/);
});
