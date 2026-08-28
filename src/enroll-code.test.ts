import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENROLL_CODE_RE, isValidEnrollCode, normalizeEnrollCode } from './enroll-code.js';

/**
 * The code is hashed server-side to find its row, so any difference in case or spacing is a
 * different SHA-256 and comes back as the API's deliberately vague "not valid, already used, or
 * expired" — the same sentence a genuinely wrong code gets.
 *
 * The pairing page folded case from the day it shipped; `--enroll` passed argv through
 * verbatim, so the terminal path punished a lowercase paste with a message that blamed the
 * code. These pin the folding for BOTH, which is the point of the shared module.
 */
describe('normalizeEnrollCode', () => {
  it('leaves a correctly typed code alone', () => {
    assert.equal(normalizeEnrollCode('DNFV-AS68'), 'DNFV-AS68');
  });

  it('folds the ways a correct code actually arrives', () => {
    for (const raw of ['dnfv-as68', '  DNFV-AS68 ', 'DNFVAS68', 'dnfv as68', 'DNFV - AS68']) {
      assert.equal(normalizeEnrollCode(raw), 'DNFV-AS68', `failed on ${JSON.stringify(raw)}`);
    }
  });

  it('does not invent a code out of the wrong number of characters', () => {
    // A truncated paste must fail the gate, not get silently padded into some other venue's
    // code. Eight is the only length that gets a hyphen inserted.
    assert.equal(isValidEnrollCode(normalizeEnrollCode('DNFV-AS6')), false);
    assert.equal(isValidEnrollCode(normalizeEnrollCode('DNFV-AS688')), false);
    assert.equal(isValidEnrollCode(normalizeEnrollCode('')), false);
  });

  it('rejects the letters the alphabet deliberately omits', () => {
    // O/0/I/1 are excluded upstream because the code is read off a tablet and retyped, so a
    // code containing them is always a misread of something else.
    assert.equal(isValidEnrollCode('O0I1-ABCD'), false);
    assert.equal(isValidEnrollCode(normalizeEnrollCode('o0i1-abcd')), false);
  });

  it('matches the alphabet the API mints from', () => {
    // Mirrors CODE_ALPHABET in the backend's print.service.ts. A character accepted here that
    // it never mints is a guaranteed round trip for nothing.
    assert.match('ABCD-2345', ENROLL_CODE_RE);
    assert.equal(ENROLL_CODE_RE.test('ABCDEFGH'), false, 'the hyphen is part of the shape');
  });
});
