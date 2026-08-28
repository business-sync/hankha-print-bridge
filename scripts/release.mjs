#!/usr/bin/env node
/**
 * Cuts a GitHub Release: verifies, builds, tags, uploads.
 *
 *   bun run release              everything — preflight, test, build, tag, publish
 *   bun run release --dry-run    every check and the full build, but pushes nothing
 *   bun run release --draft      publish as a draft to eyeball before it goes out
 *
 * The version is never passed in. It comes from `APP_VERSION` in `.env` like everything else
 * here (see `sync-version.mjs`), so the tag, the artifact filenames and the number the binary
 * reports to the POS cannot disagree — which is the whole reason that file is the one home.
 *
 * Flags:
 *   --dry-run            build and assemble, then stop before `git push` / `gh release create`
 *   --draft              create the release as a draft
 *   --skip-tests         skip typecheck + node:test (they run by default; don't skip lightly)
 *   --skip-build         reuse whatever is already in dist-installers/ — still fully verified
 *                        against this version's filenames and checksums, so a stale build is
 *                        caught rather than shipped
 *   --generate-notes     let GitHub write the notes from commit titles, instead of requiring
 *                        release-notes/v<version>.md
 *   --notes <path>       use a specific notes file
 *   --remote <name>      default: origin
 *   --branch <name>      the branch a release must be cut from. Default: main
 *
 * Deliberately NOT here: `bun install`. `bun.lock` is lockfileVersion 2 and older bun installs
 * cannot parse it — they warn, ignore the lockfile, and regenerate a downgraded one, which then
 * breaks the Docker build's `--frozen-lockfile`. The devDependencies are three pinned packages;
 * install them by hand if node_modules/ is missing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appVersion, syncManifestVersion } from './sync-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist-installers');
const NOTES_DIR = join(ROOT, 'release-notes');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const opts = {
  dryRun: has('--dry-run'),
  draft: has('--draft'),
  skipTests: has('--skip-tests'),
  skipBuild: has('--skip-build'),
  generateNotes: has('--generate-notes'),
  notes: valueOf('--notes', null),
  remote: valueOf('--remote', 'origin'),
  branch: valueOf('--branch', 'main'),
};

const VERSION = appVersion();
const TAG = `v${VERSION}`;

/**
 * The set a complete release has to contain. Asserting the names rather than trusting the build
 * to have succeeded is what catches the quiet failure: with no usable NSIS, `package.mjs` warns
 * and ships only the .zip — exit code 0, four files where five belong, and nobody notices until
 * a venue asks where the Windows installer went.
 */
const ARTIFACTS = [
  `hankha-print-bridge-${VERSION}-macos.dmg`,
  `hankha-print-bridge-${VERSION}-macos-universal.pkg`,
  `hankha-print-bridge-${VERSION}-windows-x64-setup.exe`,
  `hankha-print-bridge-${VERSION}-windows-x64.zip`,
];
const SUMS = 'SHA256SUMS.txt';

function step(label) {
  console.log(`\n── ${label}`);
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function run(cmd, args, opt = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opt });
  if (res.error) throw res.error;
  if (res.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${res.status}`);
}

/** Same, but the caller decides what a non-zero status means. */
function tryRun(cmd, args, opt = {}) {
  const res = spawnSync(cmd, args, { stdio: 'ignore', cwd: ROOT, ...opt });
  return !res.error && res.status === 0;
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return (res.stdout ?? '').trim();
}

function onPath(cmd) {
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------- preflight

step(`Releasing hankha-print-bridge ${TAG}${opts.dryRun ? '  (dry run)' : ''}`);

if (!onPath('gh')) fail('The GitHub CLI is not installed. `brew install gh`.');
if (!tryRun('gh', ['auth', 'status'])) fail('`gh` is not authenticated. Run `gh auth login`.');

const remoteUrl = capture('git', ['remote', 'get-url', opts.remote]);
if (!remoteUrl) fail(`No git remote named "${opts.remote}".`);
const REPO = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
if (!REPO) fail(`Remote "${opts.remote}" is not a GitHub URL: ${remoteUrl}`);
console.log(`   repo ${REPO}`);

// `package.mjs` rewrites package.json when it has drifted from .env. Doing that mid-release
// would dirty the tree after the clean check and tag a commit that does not contain the number
// it is named for, so settle it first and make an out-of-date mirror the caller's problem.
const synced = syncManifestVersion(VERSION);
if (synced.length > 0) {
  fail(
    `${synced.join(', ')} did not match APP_VERSION=${VERSION} and has been rewritten.\n` +
      `    Review and commit that change, then run the release again.`
  );
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== opts.branch) {
  fail(`Releases are cut from "${opts.branch}", but HEAD is "${branch}". (--branch overrides.)`);
}

if (capture('git', ['status', '--porcelain'])) {
  fail('The working tree is dirty. Commit or stash first — a release must name a real commit.');
}

console.log(`   fetching ${opts.remote}`);
run('git', ['fetch', opts.remote, '--tags', '--prune'], { stdio: 'ignore' });

const counts = capture('git', ['rev-list', '--left-right', '--count', `${opts.remote}/${opts.branch}...HEAD`]);
const [behind, ahead] = (counts ?? '0\t0').split(/\s+/).map(Number);
if (behind > 0) {
  fail(
    `HEAD is ${behind} commit(s) behind ${opts.remote}/${opts.branch}. ` +
      `Pull first, or you will ship an old build under a new tag.`
  );
}
if (ahead > 0) {
  fail(`HEAD is ${ahead} commit(s) ahead of ${opts.remote}/${opts.branch}. Push them first.`);
}

const commit = capture('git', ['rev-parse', '--short', 'HEAD']);
console.log(`   ${opts.branch} at ${commit}, in step with ${opts.remote}`);

// A tag can legitimately already exist: the upload is the step most likely to fail halfway, and
// re-running should finish the job rather than demand a version bump. A *release* existing is
// different — that is a finished release, and overwriting one silently is never right.
const releaseExists = tryRun('gh', ['release', 'view', TAG, '--repo', REPO]);
if (releaseExists) {
  fail(
    `A release for ${TAG} already exists.\n` +
      `    Bump APP_VERSION in .env and .env.example, or replace single assets with\n` +
      `    \`gh release upload ${TAG} <file> --clobber --repo ${REPO}\`.`
  );
}
const tagLocal = tryRun('git', ['rev-parse', '--verify', `refs/tags/${TAG}`]);
const tagRemote = Boolean(capture('git', ['ls-remote', '--tags', opts.remote, `refs/tags/${TAG}`]));
if (tagLocal) {
  const tagged = capture('git', ['rev-list', '-n', '1', TAG]);
  const head = capture('git', ['rev-parse', 'HEAD']);
  if (tagged !== head) {
    fail(`Tag ${TAG} already exists but points at ${tagged?.slice(0, 7)}, not HEAD (${commit}).`);
  }
  console.log(`   tag ${TAG} already exists at HEAD${tagRemote ? ' and is pushed' : ''}`);
}

// Cheap heads-up before a four-minute build. Not a hard gate — makensis may be fine on another
// machine, and the artifact check after the build is what actually decides.
if (!opts.skipBuild && !onPath('docker')) {
  console.log('   ! docker is not installed — setup.exe needs it unless makensis works here');
} else if (!opts.skipBuild && !tryRun('docker', ['info'])) {
  console.log('   ! Docker is not running. Start it now if this machine has no usable makensis;');
  console.log('     without either, no setup.exe is produced and this release will be rejected.');
}

// ---------------------------------------------------------------- notes

const notesPath = opts.notes
  ? resolve(ROOT, opts.notes)
  : join(NOTES_DIR, `${TAG}.md`);

if (!opts.generateNotes && !existsSync(notesPath)) {
  fail(
    `No release notes at ${notesPath.replace(ROOT + '/', '')}.\n` +
      `    Write them (the checksum section is appended for you), pass --notes <path>,\n` +
      `    or use --generate-notes to let GitHub list the commits instead.`
  );
}

// ---------------------------------------------------------------- tests

if (opts.skipTests) {
  console.log('\n   ! skipping typecheck and tests (--skip-tests)');
} else {
  step('Typecheck');
  run('bun', ['run', 'typecheck']);
  step('Tests');
  run('bun', ['run', 'test']);
}

// ---------------------------------------------------------------- build

if (opts.skipBuild) {
  console.log('\n   ! reusing dist-installers/ as-is (--skip-build)');
} else {
  run('node', ['--import', 'tsx', 'scripts/package.mjs']);
}

step('Verifying the artifacts');

const missing = ARTIFACTS.filter((f) => !existsSync(join(OUT_DIR, f)));
if (missing.length > 0) {
  fail(
    `dist-installers/ is missing ${missing.length} artifact(s):\n` +
      missing.map((f) => `      ${f}`).join('\n') +
      `\n    A build can exit 0 having skipped one — a missing setup.exe means no usable NSIS\n` +
      `    (start Docker), and missing .dmg/.pkg means this is not a Mac.`
  );
}
if (!existsSync(join(OUT_DIR, SUMS))) fail(`dist-installers/${SUMS} is missing.`);

// Re-hash rather than trust the file. With --skip-build the checksums could describe a previous
// version's artifacts, and a SHA256SUMS.txt that disagrees with the bytes beside it is worse
// than none at all — it is the one thing a cautious installer actually checks.
const recorded = new Map(
  readFileSync(join(OUT_DIR, SUMS), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, name] = line.trim().split(/\s+/);
      return [name, hash];
    })
);
for (const file of ARTIFACTS) {
  const actual = sha256(join(OUT_DIR, file));
  if (recorded.get(file) !== actual) {
    fail(`${SUMS} disagrees with ${file}. Rebuild without --skip-build.`);
  }
}
const strays = [...recorded.keys()].filter((f) => !ARTIFACTS.includes(f));
if (strays.length > 0) {
  fail(`${SUMS} lists files that are not part of ${TAG}: ${strays.join(', ')}. Rebuild.`);
}
for (const file of ARTIFACTS) console.log(`   ${file}`);
console.log(`   ${SUMS} matches all ${ARTIFACTS.length}`);

// The hashes belong in the notes, and hand-copying them is how they end up describing the
// build before last. The tracked notes file stays prose; this appends the verified block.
let notesBody = null;
if (!opts.generateNotes) {
  const prose = readFileSync(notesPath, 'utf8').trimEnd();
  const checksums = ARTIFACTS.map((f) => `${recorded.get(f)}  ${f}`).join('\n');
  notesBody =
    `${prose}\n\n## Verify your download\n\n` +
    'Download `SHA256SUMS.txt` alongside the installer, then from that folder:\n\n' +
    '```bash\nshasum -a 256 -c SHA256SUMS.txt\n```\n\n' +
    `\`\`\`\n${checksums}\n\`\`\`\n`;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'RELEASE_NOTES.md'), notesBody);
}

// ---------------------------------------------------------------- publish

const assets = [...ARTIFACTS, SUMS].map((f) => join(OUT_DIR, f));
const ghArgs = [
  'release', 'create', TAG,
  '--repo', REPO,
  '--title', `Hankha Print Bridge ${VERSION}`,
  ...(opts.draft ? ['--draft'] : ['--latest']),
  ...(opts.generateNotes
    ? ['--generate-notes']
    : ['--notes-file', join(OUT_DIR, 'RELEASE_NOTES.md')]),
  ...assets,
];

if (opts.dryRun) {
  step('Dry run — nothing was pushed');
  console.log(`   would tag  ${TAG} at ${commit}${tagLocal ? ' (exists)' : ''}`);
  console.log(`   would push ${opts.remote} ${TAG}`);
  console.log(`   would run  gh ${ghArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  if (notesBody) console.log(`   notes assembled at dist-installers/RELEASE_NOTES.md`);
  process.exit(0);
}

if (!tagLocal) {
  step(`Tagging ${TAG}`);
  run('git', ['tag', '-a', TAG, '-m', `hankha-print-bridge ${VERSION}`]);
}
if (!tagRemote) {
  run('git', ['push', opts.remote, TAG]);
}

step(`Publishing ${TAG}${opts.draft ? ' as a draft' : ''}`);
const created = spawnSync('gh', ghArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
if (created.status !== 0) {
  fail(
    `gh release create failed. The tag is pushed, so fix the cause and re-run —\n` +
      `    it will reuse the tag. To undo the tag entirely:\n` +
      `      git tag -d ${TAG} && git push ${opts.remote} :refs/tags/${TAG}`
  );
}

step('Done');
console.log(`   ${(created.stdout ?? '').trim()}`);
