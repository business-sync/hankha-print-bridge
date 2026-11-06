import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadVectors, runVectorChecks, VECTORS_PATH } from './test-support/lan-vector-checks.js';

/*
 * The shared vectors (docs/printing/lan-vectors.json): fixed keys, a ticket, signed requests and an
 * acknowledgement that the POS, the Helper and the backend test against too. This is the Bridge's
 * side of that agreement.
 */

describe('lan-vectors.json', () => {
  it('every vector verifies with plain crypto, and the Bridge accepts and refuses what the file says', () => {
    const passed = runVectorChecks(loadVectors());
    // 3 groups of file checks + 3 bridge checks + one per negative vector.
    const grant = loadVectors().grant;
    assert.equal(passed.length, 6 + loadVectors().negative.length + (grant ? 2 + grant.negative.length : 0), passed.join('\n'));
    assert.ok(grant, 'the M9 grant vectors are present');
    assert.ok(passed.some((p) => p.startsWith('negative: der-signature')), 'the DER trap is covered');
  });

  it('the copy published for the other implementations is byte-identical to the one tested here', () => {
    // docs/ sits above the app repo, so a checkout of the app alone has no copy to compare.
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      const published = join(dir, 'docs', 'printing', 'lan-vectors.json');
      if (existsSync(published)) {
        assert.equal(readFileSync(published, 'utf8'), readFileSync(VECTORS_PATH, 'utf8'));
        return;
      }
      dir = dirname(dir);
    }
  });

  it('pins none of the published test keys as the Bridge trust anchor', async () => {
    const { BOOTSTRAP_KEYS } = await import('./lan-keys.js');
    const v = loadVectors();
    for (const k of BOOTSTRAP_KEYS) {
      assert.notEqual(k.pubkey, v.backend_key.spki_b64u, 'the bootstrap key must never be a key whose private half is published');
      assert.notEqual(k.pubkey, v.bridge_key.spki_b64u);
    }
  });
});
