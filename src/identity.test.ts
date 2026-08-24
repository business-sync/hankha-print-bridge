import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

/**
 * The state file is the bridge's ONLY persistent state. Re-enrolling on every boot would mint
 * a new bridge row per restart and leave the operator choosing between a dozen identical
 * "Counter PC" entries, so identity has to survive both restarts and a corrupt file.
 *
 * `PRINT_BRIDGE_STATE_DIR` is set per test and the module re-imported, because `statePath()`
 * reads the env at call time but the tests want full isolation from a real install.
 */

const original = process.env.PRINT_BRIDGE_STATE_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.PRINT_BRIDGE_STATE_DIR;
  else process.env.PRINT_BRIDGE_STATE_DIR = original;
});

function useTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-bridge-state-'));
  process.env.PRINT_BRIDGE_STATE_DIR = dir;
  return dir;
}

describe('relay state', () => {
  it('mints a stable install id on first start and keeps it', async () => {
    useTempDir();
    const { loadState, saveState } = await import('./identity.js');

    const first = loadState();
    assert.ok(first.install_id.length >= 8);
    assert.equal(first.token, undefined);

    saveState({ ...first, bridge_id: '42', token: 'secret-token' });
    const second = loadState();
    assert.equal(second.install_id, first.install_id);
    assert.equal(second.bridge_id, '42');
  });

  /*
   * A bridge that refuses to start because it cannot parse its own scratch file prints
   * nothing at all — strictly worse than one that asks to be enrolled again.
   */
  it('recovers from a corrupt file instead of throwing', async () => {
    const dir = useTempDir();
    const { loadState, statePath } = await import('./identity.js');
    writeFileSync(join(dir, 'relay.json'), '{ this is not json');
    const state = loadState();
    assert.ok(state.install_id.length >= 8);
    assert.ok(statePath().startsWith(dir));
  });

  it('ignores a file with no usable install id', async () => {
    const dir = useTempDir();
    const { loadState } = await import('./identity.js');
    writeFileSync(join(dir, 'relay.json'), JSON.stringify({ token: 'orphan' }));
    const state = loadState();
    assert.ok(state.install_id.length >= 8);
    // The orphaned token is discarded with the identity it belonged to — a token without an
    // install id cannot be re-associated, and keeping it would look like a working enrollment.
    assert.equal(state.token, undefined);
  });

  /*
   * The file holds a bearer token that can print anywhere in the branch, and on macOS/Linux
   * the daemon's directory is otherwise world-readable.
   */
  it('writes the credential file 0600', async () => {
    useTempDir();
    const { loadState, saveState, statePath } = await import('./identity.js');
    saveState({ ...loadState(), token: 'secret-token' });
    assert.equal(statSync(statePath()).mode & 0o777, 0o600);
    assert.match(readFileSync(statePath(), 'utf8'), /secret-token/);
  });
});
