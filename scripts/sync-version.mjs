#!/usr/bin/env node
/**
 * Keeps `package.json` in step with `APP_VERSION` in `.env`.
 *
 * The version has exactly one home now — the env file — but npm still needs a `version` field,
 * and `version.test.ts` asserts the two agree so nothing can ship under a number its own
 * manifest disagrees with. Rather than making that a second thing to hand-edit on every bump,
 * `scripts/package.mjs` calls this first and it rewrites the mirror.
 *
 *   node --import tsx scripts/sync-version.mjs        (npm run version:sync)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The shape the POS terminal can compare numerically; anything else it ignores outright. */
export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Read and validate `APP_VERSION`, failing with the one instruction that fixes it. */
export function appVersion() {
  const version = loadEnv().APP_VERSION?.trim();
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(
      `APP_VERSION must be three numeric parts (e.g. 1.2.0), got ${JSON.stringify(version ?? null)}.\n` +
        `Set it in ${join(ROOT, '.env')} (or .env.example, which is the tracked fallback).`
    );
  }
  return version;
}

function patchJson(file, version, apply) {
  const path = join(ROOT, file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false; // package-lock.json is absent on a fresh clone until `npm install`.
  }
  const json = JSON.parse(text);
  if (!apply(json, version)) return false;
  // Preserve npm's own formatting: two-space indent, trailing newline.
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

/** Returns the files it actually rewrote, so callers can say so out loud. */
export function syncManifestVersion(version = appVersion()) {
  const changed = [];

  if (
    patchJson('package.json', version, (json, v) => {
      if (json.version === v) return false;
      json.version = v;
      return true;
    })
  ) {
    changed.push('package.json');
  }

  if (
    patchJson('package-lock.json', version, (json, v) => {
      let touched = false;
      if (json.version !== v) {
        json.version = v;
        touched = true;
      }
      // npm keeps a second copy for the root workspace entry.
      const root = json.packages?.[''];
      if (root && root.version !== v) {
        root.version = v;
        touched = true;
      }
      return touched;
    })
  ) {
    changed.push('package-lock.json');
  }

  return changed;
}

// Only act when run directly; `package.mjs` imports the functions above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = appVersion();
  const changed = syncManifestVersion(version);
  console.log(
    changed.length > 0
      ? `Set version ${version} in ${changed.join(', ')}`
      : `Already at version ${version}`
  );
}
