import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bundledAndExtraRoots, warmTlsTrustStore } from './tls-warmup.js';

/*
 * The warm-up runs before the first connection of the process (index.ts). It must complete the
 * runtime's root setup on this thread and never throw; what it returns is only for the log.
 */
describe('warmTlsTrustStore', () => {
  it('reports the roots it readied, or null on a runtime without the API, and never throws', () => {
    const warm = warmTlsTrustStore();
    if (warm === null) return; // Node before 22.15 has no tls.getCACertificates
    assert.ok(warm.roots > 100, `a real root list, got ${warm.roots}`);
    assert.ok(warm.ms >= 0 && warm.ms < 5_000, `synchronous and quick, took ${warm.ms}ms`);
  });
});

describe('bundledAndExtraRoots', () => {
  it('is the bundled list in PEM, the shape fetch’s tls.ca takes', () => {
    const roots = bundledAndExtraRoots();
    assert.ok(roots.length > 100, `got ${roots.length}`);
    for (const pem of roots) assert.match(pem, /^-----BEGIN CERTIFICATE-----/);
  });
});
