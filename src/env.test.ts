import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEnv, parseEnvFile } from './env.js';

/**
 * The parse matters more than its size suggests: `scripts/package.mjs` reads the version through
 * this same function to name artifacts and to inline into the binary. Anything it gets wrong
 * ships as a release labelled one thing containing another.
 */
describe('parseEnvFile', () => {
  it('reads plain KEY=value', () => {
    assert.deepEqual(parseEnvFile('APP_VERSION=1.2.0\n'), { APP_VERSION: '1.2.0' });
  });

  it('ignores blank lines and comments', () => {
    assert.deepEqual(parseEnvFile('\n# a comment\n\nA=1\n'), { A: '1' });
  });

  it('strips quotes rather than storing them', () => {
    // A quoted version that kept its quotes would fail the terminal's numeric compare, and the
    // filename would carry them too.
    assert.deepEqual(parseEnvFile('A="1.2.0"\nB=\'x\'\n'), { A: '1.2.0', B: 'x' });
  });

  it('drops a trailing comment after an unquoted value', () => {
    assert.deepEqual(parseEnvFile('APP_VERSION=1.2.0 # bump me\n'), { APP_VERSION: '1.2.0' });
  });

  it('keeps a # that is part of an unquoted value', () => {
    assert.deepEqual(parseEnvFile('A=ab#c\n'), { A: 'ab#c' });
  });

  it('accepts an export prefix and surrounding whitespace', () => {
    assert.deepEqual(parseEnvFile('  export A = 1 \n'), { A: '1' });
  });

  it('keeps = inside a value', () => {
    assert.deepEqual(parseEnvFile('A=b=c\n'), { A: 'b=c' });
  });

  it('skips a line with no =', () => {
    assert.deepEqual(parseEnvFile('nonsense\nA=1\n'), { A: '1' });
  });
});

describe('loadEnv', () => {
  it('does not overwrite a variable that is already set', () => {
    // The precedence CI relies on to stamp a build without editing a file.
    process.env.HANKHA_ENV_TEST_SENTINEL = 'from-process';
    loadEnv();
    assert.equal(process.env.HANKHA_ENV_TEST_SENTINEL, 'from-process');
    delete process.env.HANKHA_ENV_TEST_SENTINEL;
  });

  it('exposes the version the rest of the build reads', () => {
    assert.match(loadEnv().APP_VERSION ?? '', /^\d+\.\d+\.\d+$/);
  });

  it('treats an empty value as unset', () => {
    // `.env.example` lists the optional signing hooks as bare keys purely to document them.
    assert.equal('HANKHA_MACOS_SIGN_IDENTITY' in loadEnv(), false);
  });
});
