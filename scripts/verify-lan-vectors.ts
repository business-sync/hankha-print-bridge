/*
 * Run the LAN vectors on whatever runtime launched this — Node or Bun.
 *
 *   node --import tsx scripts/verify-lan-vectors.ts
 *   ~/.bun-1.3.14/bin/bun scripts/verify-lan-vectors.ts
 *
 * The question it answers: does THIS runtime verify an ECDSA P-256 signature in IEEE-P1363 form
 * (`dsaEncoding: 'ieee-p1363'`), refuse the DER form, and verify Ed25519? The installer's binary is
 * built with Bun, so the answer on the Bun that builds it is the one that matters.
 */
import { loadVectors, runVectorChecks } from '../src/test-support/lan-vector-checks.js';

const runtime = (globalThis as { Bun?: { version: string } }).Bun
  ? `Bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
  : `Node ${process.version}`;

try {
  const passed = runVectorChecks(loadVectors());
  for (const name of passed) console.log(`PASS ${name}`);
  console.log(`${runtime}: ${passed.length} checks passed`);
} catch (err) {
  console.error(`${runtime}: FAILED -`, err instanceof Error ? err.message : err);
  process.exit(1);
}
