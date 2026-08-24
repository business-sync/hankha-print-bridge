/**
 * The single source of truth for the bridge's version.
 *
 * It cannot be read from `package.json` at runtime: the shipped artifact is a self-contained
 * binary (`bun build --compile`) with no `package.json` beside it. `version.test.ts` asserts
 * this constant and the manifest stay in step, which is the check `tsc` can't do.
 *
 * The POS terminal gates features on this (`MIN_BRIDGE_VERSION` in the terminal's
 * `bridge-client.ts`), so bump the MINOR whenever an endpoint gains a field a terminal may
 * come to rely on.
 */
export const BRIDGE_VERSION = '1.2.0';

/** Reported by `/health` so the POS can tell a real bridge from some other app on that port. */
export const BRIDGE_SERVICE = 'hankha-print-bridge';
