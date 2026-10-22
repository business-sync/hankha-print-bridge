import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { localStamp } from './log.js';

describe('localStamp', () => {
  /*
   * The plain log is what a venue sends in when printing breaks, and without a time on each line
   * it could say what happened but never when.
   */
  it('renders the local clock, zero-padded, to the second', () => {
    assert.equal(localStamp(new Date(2026, 0, 5, 7, 3, 9)), '2026-01-05 07:03:09');
    assert.equal(localStamp(new Date(2026, 9, 22, 13, 46, 56)), '2026-10-22 13:46:56');
  });
});
