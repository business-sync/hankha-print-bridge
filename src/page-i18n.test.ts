import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  I18N_SCRIPT,
  PAGE_LANGS,
  PAGE_LANG_NAMES,
  PAGE_LOCALE_TAGS,
  PAGE_STRINGS,
} from './page-i18n.js';

/*
 * Parity, the way the POS checks its own bundles: a key that exists must exist in all five
 * languages. A missing column is not a crash — `t()` falls back to English — which is exactly
 * why nothing would ever notice it. A Lao till would simply show one English sentence among the
 * Lao ones, and only someone who reads Lao would ever report it.
 */
test('every key is filled in all five languages', () => {
  const missing: string[] = [];

  for (const [key, row] of Object.entries(PAGE_STRINGS)) {
    if (row.length !== PAGE_LANGS.length) {
      missing.push(`${key}: has ${row.length} entries, expected ${PAGE_LANGS.length}`);
      continue;
    }
    row.forEach((value, at) => {
      if (typeof value !== 'string' || value.trim() === '') {
        missing.push(`${key}.${PAGE_LANGS[at]} is empty`);
      }
    });
  }

  assert.deepEqual(missing, [], `Untranslated rows:\n${missing.join('\n')}`);
});

/*
 * A placeholder is filled by name, so one that survives only in English produces a sentence with
 * a literal `{n}` in it in the other four. This is the check that catches a translation that
 * dropped the number out of the sentence.
 */
test('every language of a row carries the same placeholders', () => {
  const wrong: string[] = [];
  const names = (value: string) =>
    (value.match(/\{[a-z]+\}/g) ?? []).slice().sort().join(',');

  for (const [key, row] of Object.entries(PAGE_STRINGS)) {
    const expected = names(row[0]);
    row.forEach((value, at) => {
      if (names(value) !== expected) {
        wrong.push(`${key}.${PAGE_LANGS[at]}: has [${names(value)}], English has [${expected}]`);
      }
    });
  }

  assert.deepEqual(wrong, [], `Placeholder mismatch:\n${wrong.join('\n')}`);
});

test('every language has a native name and a locale tag', () => {
  for (const lang of PAGE_LANGS) {
    assert.ok(PAGE_LANG_NAMES[lang], `${lang} has no name for the picker`);
    assert.match(PAGE_LOCALE_TAGS[lang], /^[a-z]{2}-[A-Z]{2}$/, `${lang} has no locale tag`);
  }
});

/*
 * The reason the table is a TypeScript object rather than more page-literal source.
 *
 * `embed()` serialises it into a template literal inside an inline `<script>`, so a backtick,
 * a `${` or a `</` in any translation would end the literal, start an interpolation, or close
 * the script element. This proves all three are neutralised rather than merely absent today.
 */
test('a translation cannot break out of the script it is embedded in', () => {
  const table = I18N_SCRIPT.slice(I18N_SCRIPT.indexOf('var T = '));
  const openers = table.slice(0, table.indexOf('\n'));

  assert.ok(!openers.includes('`'), 'a backtick reached the emitted table');
  assert.ok(!openers.includes('${'), 'an interpolation reached the emitted table');
  assert.ok(!openers.includes('</'), 'a closing tag reached the emitted table');

  // And the escapes are the reversible kind: this is the same table, parsed back.
  const parsed = JSON.parse(openers.replace(/^var T = /, '').replace(/;$/, ''));
  assert.deepEqual(parsed, PAGE_STRINGS);
});

/*
 * The pairing screen and the "This computer" card read this table through psText/svcText, which
 * prefix the key. A row that lost its prefix would render as an empty string on a screen that
 * is nothing BUT those strings.
 */
test('the pairing screen and service card keys keep their prefixes', () => {
  const keys = Object.keys(PAGE_STRINGS);
  assert.ok(keys.some((key) => key.startsWith('ps.')), 'no pairing-screen rows');
  assert.ok(keys.some((key) => key.startsWith('svc.')), 'no service-card rows');
  for (const key of ['ps.waitLead', 'ps.details', 'svc.title', 'svc.restartBtn']) {
    assert.ok(PAGE_STRINGS[key], `${key} is missing`);
  }
});
