/*
 * Reads `.env` / `.env.example` into `process.env`. Deliberately not the `dotenv` package.
 *
 * Three things make a dependency the wrong call here:
 *
 *  - The shipped bridge is a `bun build --compile` binary with no files beside it, so the
 *    loader has to degrade to a silent no-op. That is a handful of lines, not a library.
 *  - The same parse has to run in two places: the app at dev time, and `scripts/package.mjs`,
 *    which stamps the version it reads here into the artifact names AND into the compiled
 *    binary. Two parsers that disagreed about quoting would give you a release labelled
 *    1.2.0 containing a binary that reports `"1.2.0"`, quotes and all.
 *  - Zero runtime dependencies is the reason this thing installs anywhere.
 *
 * `.env.example` is a FALLBACK here, not only a template. It is the tracked file, so it holds
 * the committed defaults — the version among them — and a fresh clone builds correctly with no
 * `.env` at all. `.env` is gitignored and wins wherever it sets a key; a real environment
 * variable beats both, which is how CI overrides a value without editing a file.
 *
 * Scope: development and packaging. An INSTALLED bridge never reads these — its configuration
 * comes from the launchd plist on macOS and from `bridge.env` (read by `print-bridge.cmd`) on
 * Windows. Adding a third mechanism next to the binary would only create ambiguity about which
 * one an operator is looking at.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `KEY=value` per line. Understands `#` comments, blank lines, an optional `export ` prefix,
 * quoted values, and a trailing ` # comment` after an unquoted value — the subset that shows
 * up in a real `.env`, and nothing beyond it.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (key === '') continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      // Only double quotes carry escapes, same as every other dotenv dialect.
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else {
      // An unquoted `1.2.0 # bump me` must not become the version string `1.2.0 # bump me`.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

/**
 * The app directory — the one holding `package.json`, `src/` and `dist/`.
 *
 * `src/env.ts` and `dist/env.js` are both one level down from it, so the same expression covers
 * running under tsx and running the compiled JS. Inside a `--compile` binary this resolves into
 * Bun's virtual filesystem, where the `existsSync` below simply finds nothing.
 */
function appRoot(): string | null {
  try {
    return fileURLToPath(new URL('../', import.meta.url));
  } catch {
    return null;
  }
}

let cached: Record<string, string> | null = null;

/**
 * Apply `.env` (then `.env.example`) to `process.env` and return the effective values.
 *
 * Never overwrites a variable that is already set, so an exported shell variable or a CI secret
 * always wins. Idempotent: safe to call from every module that needs it.
 *
 * An empty value counts as unset. `.env.example` lists the optional signing hooks as bare keys
 * to document that they exist, and exporting those as empty strings would put them in a third
 * state that reads as "configured" — `HANKHA_MACOS_SIGN_IDENTITY=` would have reached
 * `codesign --sign ''` through a `??`, which fails in a way that looks nothing like its cause.
 */
export function loadEnv(): Record<string, string> {
  if (cached) return cached;

  const root = appRoot();
  const merged: Record<string, string> = {};
  if (root) {
    // Last file listed loses: `.env` overrides `.env.example`.
    for (const name of ['.env.example', '.env']) {
      const path = `${root}${name}`;
      if (!existsSync(path)) continue;
      Object.assign(merged, parseEnvFile(readFileSync(path, 'utf8')));
    }
  }

  const effective: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === '') continue;
    if (process.env[key] === undefined) process.env[key] = value;
    effective[key] = process.env[key] ?? value;
  }

  cached = effective;
  return effective;
}
