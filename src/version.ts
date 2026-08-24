import { loadEnv } from './env.js';

/*
 * Must run before the constant below is evaluated, and this module is the earliest point that
 * is guaranteed: `server.ts` imports it directly, so the tests reach it without going through
 * `index.ts`. Loading here also means `PRINT_BRIDGE_PORT` / `PRINT_BRIDGE_HOST` in `.env` take
 * effect under `npm run dev`, which previously needed an exported shell variable.
 */
loadEnv();

/**
 * Reported when nothing supplied a version. Deliberately not a plausible number: it fails the
 * terminal's `^\d+\.\d+\.\d+$` check, so a POS reads it as "can't tell" and stays quiet rather
 * than acting on a version that was never really set. `version.test.ts` fails on it too.
 */
const UNSET_VERSION = '0.0.0-dev';

/**
 * The single source of truth for the bridge's version is `APP_VERSION` in `.env` (falling back
 * to the tracked `.env.example`, so a fresh clone still builds a correctly-numbered release).
 *
 * A shipped bridge reads no files: `scripts/package.mjs` substitutes this expression for a
 * string literal at compile time (`bun build --define`), because the artifact is a
 * self-contained binary with neither `.env` nor `package.json` beside it. Same value either
 * way — `package.mjs` stamps the artifact names from the very variable it inlines here, and
 * asserts the built binary reports it back.
 *
 * Do not reference `process.env.APP_VERSION` anywhere else: `--define` rewrites that exact
 * expression wherever it appears, so assigning to it would not survive the build.
 *
 * The POS terminal gates features on this (`MIN_BRIDGE_VERSION` in the terminal's
 * `bridge-client.ts`), so bump the MINOR whenever an endpoint gains a field a terminal may
 * come to rely on.
 */
export const BRIDGE_VERSION = process.env.APP_VERSION?.trim() || UNSET_VERSION;

/** Reported by `/health` so the POS can tell a real bridge from some other app on that port. */
export const BRIDGE_SERVICE = 'hankha-print-bridge';
