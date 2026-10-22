import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskCode } from './pairing.js';

describe('maskCode', () => {
  /*
   * A pairing code is a credential while it lives — whoever claims it first owns the bridge — so
   * the log keeps only enough to match lines about one code together.
   */
  it('keeps the first group and hides the rest', () => {
    assert.equal(maskCode('PSPN-VHP6'), 'PSPN-****');
    assert.equal(maskCode('ABCDEFGH'), 'AB******');
    assert.equal(maskCode(''), '');
  });
});
