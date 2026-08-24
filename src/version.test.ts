import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { BRIDGE_SERVICE, BRIDGE_VERSION } from './version.js';

/**
 * The shipped artifact is a self-contained binary with no `package.json` beside it, so the
 * version has to be a compiled-in constant. That leaves two copies free to drift — and the one
 * that drifts is always the constant, because bumping the manifest is the habitual step. The
 * POS terminal gates features on the reported version, so a stale constant means a terminal
 * refusing to use an endpoint the installed bridge actually has.
 */
describe('version', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { name: string; version: string };

  it('matches package.json', () => {
    assert.equal(BRIDGE_VERSION, manifest.version);
  });

  it('is the name the terminal checks /health against', () => {
    assert.equal(BRIDGE_SERVICE, manifest.name);
  });

  it('is a plain three-part version the terminal can compare numerically', () => {
    assert.match(BRIDGE_VERSION, /^\d+\.\d+\.\d+$/);
  });
});
