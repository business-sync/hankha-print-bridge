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

test('the page knows the TLS-trust codes the relay reports, and has words for them', async () => {
  const { TLS_TRUST_CODES } = await import('./tls-trust.js');
  const { PAGE_STRINGS } = await import('./page-i18n.js');
  // One list, interpolated at build time: the page matches last_error against exactly the codes
  // the relay classifies, so the two cannot drift apart.
  const regex = INDEX_HTML.match(/var TLS_TRUST_RE = \/([A-Z_|]+)\/;/);
  assert.ok(regex, 'the regex reached the page');
  assert.deepEqual(regex?.[1]?.split('|'), [...TLS_TRUST_CODES]);
  // The words for all three verdicts, in every language.
  const tlsKeys = [
    'pairLeadTlsIntercepted', 'pairLeadTlsRuntime', 'pairLeadTlsUnverified',
    'pairStepTlsStop', 'pairStepTlsUpdate', 'pairStepTlsSupport',
    'ps.interceptedLead', 'ps.interceptedSub', 'ps.runtimeLead', 'ps.runtimeSub', 'ps.unverifiedLead', 'ps.unverifiedSub',
    'relayCertificate', 'relayTlsIntercepted', 'relayTlsRuntime', 'relayTlsUnverified', 'relayRootsWorkaround', 'relayRootsWorkaroundOn',
  ];
  for (const key of tlsKeys) {
    assert.ok(PAGE_STRINGS[key], `${key} is not in the table`);
    assert.ok(INDEX_HTML.includes(`"${key}"`), `${key} is not in the page`);
  }
  // No verdict tells a shop to exclude the bridge from antivirus scanning or to add a root
  // certificate: for a runtime fault that fixes nothing and widens trust, and for an interceptor
  // it is the computer's administrator who acts (the README has the detail).
  for (const key of tlsKeys) {
    for (const text of PAGE_STRINGS[key] ?? []) {
      assert.doesNotMatch(text, /NODE_EXTRA_CA_CERTS|bridge\.env|exclude|exclusion/i, `${key}: ${text.slice(0, 40)}…`);
    }
  }
  // The runtime-fault strings say whose fault it is and what to do.
  for (const text of PAGE_STRINGS['pairLeadTlsRuntime'] ?? []) assert.ok(text.includes('{runtime}'), text.slice(0, 40));
  for (const text of PAGE_STRINGS['ps.runtimeSub'] ?? []) assert.ok(text.includes('{runtime}'), text.slice(0, 40));
  // Both places that choose advice for a disconnected bridge consult the verdict, with the code
  // alone meaning "unverified" until the verdict arrives.
  assert.match(INDEX_HTML, /relay\.tls_trust/);
  assert.match(INDEX_HTML, /'pairLeadTlsIntercepted'/);
  assert.match(INDEX_HTML, /'pairLeadTlsRuntime' : 'pairLeadTlsUnverified'/);
  assert.match(INDEX_HTML, /if \(kind === 'intercepted'\) return 'intercepted';/);
  assert.match(INDEX_HTML, /if \(kind === 'runtime'\) return 'runtime';/);
});

test('the page script parses', () => {
  // The regex above is built by interpolation; a stray character in it would be a syntax error
  // that no test of the markup can see, and the whole page would then render without a script.
  const start = INDEX_HTML.lastIndexOf('<script>') + '<script>'.length;
  const end = INDEX_HTML.lastIndexOf('</script>');
  assert.ok(start > 0 && end > start, 'the inline script is present');
  assert.doesNotThrow(() => new Function(INDEX_HTML.slice(start, end)));
});
