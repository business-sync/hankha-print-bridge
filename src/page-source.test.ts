import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/*
 * A guard for the one mistake this file keeps attracting — and it deliberately does NOT import
 * `page.ts`.
 *
 * `page.ts` is three big TS template literals. A single backtick anywhere inside them — in CSS,
 * in a script comment, in an HTML comment — terminates the string, and the blast radius is the
 * WHOLE bridge: `server.ts` imports this module, so the daemon will not start, `tsc` fails and
 * `npm test` fails, all with parse errors pointing hundreds of lines from the character that
 * caused them. It has now happened four times.
 *
 * ⚠ The first version of this guard lived in `page.test.ts` and imported the module it was
 * checking, which made it useless in exactly the case it existed for: a stray backtick stops
 * that file from loading, so the guard never ran and the suite reported an import error instead
 * of the sentence explaining what was actually wrong. Reading the source as TEXT is the whole
 * point. Do not add an import of `./page.js` to this file.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('./page.ts', import.meta.url)), 'utf8');

test('no stray backtick inside the CSS, SCRIPT or HTML literals', () => {
  // Every line that legitimately opens or closes one of the three literals.
  const openers = [/^const CSS = `$/, /^const SCRIPT = `$/, /^export const INDEX_HTML = `<!doctype html>$/];
  const lines = SOURCE.split('\n');
  let inside = false;
  const offenders: string[] = [];

  lines.forEach((line, i) => {
    if (!inside && openers.some((re) => re.test(line))) {
      inside = true;
      return;
    }
    if (inside && line === '`;') {
      inside = false;
      return;
    }
    if (inside && line.includes('`')) offenders.push(`line ${i + 1}: ${line.trim()}`);
  });

  assert.deepEqual(
    offenders,
    [],
    'A backtick inside one of the page literals ends the string early and stops the bridge ' +
      'from starting. Use plain quotes, even in comments:\n' + offenders.join('\n')
  );
});

