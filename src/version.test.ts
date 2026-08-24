import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseEnvFile } from './env.js';
import { BRIDGE_SERVICE, BRIDGE_VERSION } from './version.js';

/**
 * The version has one home — `APP_VERSION` in `.env` — but two files still restate it, and both
 * matter: `package.json` because npm needs a version field, and `.env.example` because it is the
 * tracked fallback a fresh clone builds from. `scripts/package.mjs` rewrites the manifest for
 * you (`npm run version:sync`); nothing can rewrite the tracked example, so this is what stops a
 * bump landing in `.env` alone and a clean checkout quietly shipping the previous number.
 *
 * The POS terminal gates features on the version `/health` reports, so a wrong one means a
 * terminal refusing an endpoint the installed bridge actually has.
 */
describe('version', () => {
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const manifest = JSON.parse(read('package.json')) as { name: string; version: string };

  it('is the version this build resolved from the environment', () => {
    assert.equal(
      BRIDGE_VERSION,
      manifest.version,
      'package.json is out of step with APP_VERSION — run `npm run version:sync`'
    );
  });

  it('is the version a fresh clone would build', () => {
    assert.equal(
      parseEnvFile(read('.env.example')).APP_VERSION,
      manifest.version,
      'bump APP_VERSION in .env.example too — it is the tracked fallback, not just a template'
    );
  });

  it('is the name the terminal checks /health against', () => {
    assert.equal(BRIDGE_SERVICE, manifest.name);
  });

  it('is a plain three-part version the terminal can compare numerically', () => {
    // `0.0.0-dev` lands here when nothing supplied APP_VERSION at all.
    assert.match(BRIDGE_VERSION, /^\d+\.\d+\.\d+$/);
  });
});
