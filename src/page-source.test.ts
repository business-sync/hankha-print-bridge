import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/*
 * A guard for the one mistake these files keep attracting — and it deliberately does NOT import
 * either of them.
 *
 * `page.ts` and `page-service.ts` are big TS template literals. A single backtick anywhere inside
 * one — in CSS, in a script comment, in an HTML comment — terminates the string, and the blast
 * radius is the WHOLE bridge: `server.ts` imports `page.ts`, which imports `page-service.ts`, so
 * the daemon will not start, `tsc` fails and `npm test` fails, all with parse errors pointing
 * hundreds of lines from the character that caused them. It has now happened four times.
 *
 * ⚠ The first version of this guard lived in `page.test.ts` and imported the module it was
 * checking, which made it useless in exactly the case it existed for: a stray backtick stops
 * that file from loading, so the guard never ran and the suite reported an import error instead
 * of the sentence explaining what was actually wrong. Reading the source as TEXT is the whole
 * point. Do not add an import of `./page.js` or `./page-service.js` to this file.
 */
const FILES: { name: string; openers: RegExp[] }[] = [
  {
    name: 'page.ts',
    openers: [/^const CSS = `$/, /^const SCRIPT = `$/, /^export const INDEX_HTML = `<!doctype html>$/],
  },
  {
    name: 'page-service.ts',
    openers: [
      /^export const SERVICE_CSS = `$/,
      /^export const SERVICE_HTML = `$/,
      /^export const SERVICE_SCRIPT = `$/,
    ],
  },
];

/** Every line inside one of a file's page literals, with its 1-based line number. */
function literalLines(name: string, openers: RegExp[]): { line: string; at: number }[] {
  const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
  const out: { line: string; at: number }[] = [];
  let inside = false;

  source.split('\n').forEach((line, i) => {
    if (!inside && openers.some((re) => re.test(line))) {
      inside = true;
      return;
    }
    if (inside && line === '`;') {
      inside = false;
      return;
    }
    if (inside) out.push({ line, at: i + 1 });
  });

  return out;
}

for (const file of FILES) {
  test(`no stray backtick inside the literals in ${file.name}`, () => {
    const offenders = literalLines(file.name, file.openers)
      .filter((entry) => entry.line.includes('`'))
      .map((entry) => `${file.name} line ${entry.at}: ${entry.line.trim()}`);

    assert.deepEqual(
      offenders,
      [],
      'A backtick inside one of the page literals ends the string early and stops the bridge ' +
        'from starting. Use plain quotes, even in comments:\n' + offenders.join('\n')
    );
  });
}

/*
 * The other rewrite that does not care about quoting.
 *
 * `scripts/package.mjs` compiles with a `--define` on the compile-time version expression: a
 * plain source substitution that happily rewrites it inside a string literal. The page asks
 * `/health` for the version at runtime instead, which is also how it stays honest after an
 * upgrade — so the expression must not appear in the served bytes.
 *
 * Scoped to the literals on purpose. The prose ABOVE them names the expression to explain this
 * rule, and rewriting a comment harms nothing.
 */
test('no compile-time version expression inside the served page', () => {
  // Assembled rather than written out, so this file does not trip its own check.
  const needle = ['process', 'env', 'APP_VERSION'].join('.');
  for (const file of FILES) {
    const offenders = literalLines(file.name, file.openers)
      .filter((entry) => entry.line.includes(needle))
      .map((entry) => `${file.name} line ${entry.at}`);

    assert.deepEqual(
      offenders,
      [],
      `${file.name} names the compile-time version expression inside a page literal, where ` +
        'bun build --define would rewrite it. Ask /health for the version instead:\n' +
        offenders.join('\n')
    );
  }
});
