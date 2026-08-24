#!/usr/bin/env node
/**
 * Builds every installable artifact for the print bridge.
 *
 *   bun run package          everything this machine can produce
 *   bun run package --macos  just the macOS .dmg and .pkg
 *   bun run package --windows
 *
 * macOS gets TWO artifacts because they suit different situations:
 *   .dmg  drag to Applications, opens with no password, registers a per-user LaunchAgent that
 *         starts the bridge at login. What a venue installing one till should use.
 *   .pkg  needs an admin password, installs a system LaunchDaemon that starts at boot for
 *         every user. For managed fleets and unattended installs.
 *
 * The bridge ships as a self-contained binary (`bun build --compile`) so a venue never has to
 * install a runtime. Cross-compiling the Windows exe works from macOS; building the macOS .pkg
 * does not work anywhere else, so those steps are skipped with a warning rather than failing.
 *
 * The version comes from APP_VERSION in `.env` (falling back to the tracked `.env.example`),
 * read through the app's own loader so this script and the compiled binary can never disagree
 * about how a value parses. It names the artifacts, stamps the macOS bundle and the Windows
 * installer, and is inlined into the binary — which is then made to report it back.
 *
 * Signing is opt-in through the environment and every hook is a no-op when its variable is
 * unset — the default build is unsigned, which is what the README's Gatekeeper/SmartScreen
 * notes are about. Set these in `.env`, never in `.env.example`:
 *
 *   HANKHA_MACOS_SIGN_IDENTITY        Developer ID Application — signs the binary
 *   HANKHA_MACOS_INSTALLER_IDENTITY   Developer ID Installer   — signs the .pkg
 *   HANKHA_NOTARY_PROFILE             notarytool keychain profile — notarizes + staples
 *   HANKHA_WINDOWS_PFX                .pfx path — signs the exe and the setup via osslsigncode
 *   HANKHA_WINDOWS_PFX_PASSWORD
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appVersion, syncManifestVersion } from './sync-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(ROOT, 'dist-bin');
const OUT_DIR = join(ROOT, 'dist-installers');
const INSTALLER = join(ROOT, 'installer');

const VERSION = appVersion();
/**
 * A shipped binary has no `.env` and no `package.json` beside it, so the version is substituted
 * into the source at build time. `version.ts` is written to read exactly this expression.
 */
const DEFINE_VERSION = ['--define', `process.env.APP_VERSION=${JSON.stringify(VERSION)}`];
const IDENTIFIER = 'la.hankha.print-bridge';

const args = process.argv.slice(2);
const only = { macos: args.includes('--macos'), windows: args.includes('--windows') };
const wantAll = !only.macos && !only.windows;
const onMac = process.platform === 'darwin';

const warnings = [];

function warn(message) {
  warnings.push(message);
  console.warn(`\n  !  ${message}\n`);
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} exited with ${res.status}`);
}

function tryRun(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...opts });
  return !res.error && res.status === 0;
}

function has(cmd) {
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

/**
 * Being on PATH is not enough. Homebrew's makensis 3.12 aborts with std::bad_alloc on macOS 26
 * for every script, including an empty one, so "installed" and "usable" are separate questions
 * — and finding that out at the last step of a four-minute build is a bad way to learn it.
 */
function makensisWorks() {
  if (!has('makensis')) return false;
  const probe = join(BIN_DIR, 'makensis-probe.nsi');
  writeFileSync(probe, `OutFile "${join(BIN_DIR, 'makensis-probe.exe')}"\nSection\nSectionEnd\n`);
  const ok = spawnSync('makensis', ['-V1', probe], { stdio: 'ignore' }).status === 0;
  rmSync(probe, { force: true });
  rmSync(join(BIN_DIR, 'makensis-probe.exe'), { force: true });
  return ok;
}

/** `docker build` is cached after the first run, so this costs a second or two thereafter. */
function dockerNsisAvailable() {
  if (!has('docker')) return false;
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return false;
  return tryRun('docker', [
    'build', '-q', '-t', 'hankha-nsis',
    '-f', join(INSTALLER, 'windows/Dockerfile.nsis'),
    join(INSTALLER, 'windows'),
  ]);
}

function step(label) {
  console.log(`\n\u2500\u2500 ${label}`);
}

/** `bun build --compile` for one target triple. */
function compile(target, outfile) {
  const flags = [
    'build',
    '--compile',
    '--minify',
    ...DEFINE_VERSION,
    '--target',
    target,
    '--outfile',
    outfile,
    'src/index.ts',
  ];
  // Bun rejects --windows-* metadata unless it is itself running on Windows, so a cross-build
  // produces an exe with no version/publisher properties. Only cosmetic: the *installer* still
  // carries them (VIAddVersionKey in the .nsi), which is what Add/Remove Programs reads.
  //
  // Deliberately NOT --windows-hide-console either: under the scheduled task the bridge runs
  // as SYSTEM in session 0 where nothing is visible anyway, and keeping the console means
  // double-clicking the exe is a usable way to see why it won't start.
  if (target.startsWith('bun-windows') && process.platform === 'win32') {
    flags.push(
      '--windows-title=Hankha Print Bridge',
      '--windows-publisher=Hankha',
      '--windows-description=Lets the POS terminal print to network printers',
      `--windows-version=${VERSION}.0`,
      '--windows-copyright=Hankha'
    );
  }
  run('bun', flags);
  // `bun build --compile` writes a sourcemap beside the binary; it has no place in a payload.
  rmSync(`${outfile}.map`, { force: true });
  rmSync(join(BIN_DIR, 'index.js.map'), { force: true });
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Make the binary say its own version back.
 *
 * The number is inlined by `--define`, and a `--define` that silently fails to apply leaves the
 * binary reporting `0.0.0-dev` while every filename, plist and installer around it still says
 * 1.2.0. The POS gates features on what `/health` reports, so that artifact would be wrong in
 * the one place nobody checks by eye.
 */
function assertBinaryVersion(binary) {
  const res = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  const reported = (res.stdout ?? '').trim();
  if (res.status !== 0 || reported !== VERSION) {
    throw new Error(
      `The compiled binary reports ${JSON.stringify(reported) || '(nothing)'}, but this build ` +
        `is ${VERSION}. Check that --define reached \`bun build\`.`
    );
  }
  console.log(`   binary reports v${reported}`);
}

/**
 * The same question for the targets this machine cannot execute, asked of the transform instead
 * of the artifact. `--define` is a source rewrite, so bundling the one module that reads the
 * version settles it for every target at once — and in well under a second.
 */
function assertDefineApplies() {
  const res = spawnSync('bun', ['build', ...DEFINE_VERSION, '--target', 'node', 'src/version.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`bun build failed while checking --define:\n${res.stderr}`);
  }
  if (
    res.stdout.includes('process.env.APP_VERSION') ||
    !res.stdout.includes(JSON.stringify(VERSION))
  ) {
    throw new Error(
      `--define did not substitute the version. Every binary this build produced would report ` +
        `the unset fallback instead of ${VERSION}.`
    );
  }
}

// ---------------------------------------------------------------- binaries

step(`Building hankha-print-bridge v${VERSION}`);

// `.env` is the source of truth; package.json only mirrors it, and `version.test.ts` fails when
// the two drift. Rewrite the mirror here rather than making a bump two hand-edits.
const synced = syncManifestVersion(VERSION);
if (synced.length > 0) console.log(`   version ${VERSION} written to ${synced.join(', ')}`);
assertDefineApplies();
rmSync(BIN_DIR, { recursive: true, force: true });
mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const buildMac = (wantAll || only.macos) && onMac;
const buildWin = wantAll || only.windows;

if ((wantAll || only.macos) && !onMac) {
  warn('Skipping the macOS .pkg — pkgbuild/productbuild only exist on macOS.');
}

// Clear only what this run will replace. Wiping the whole directory meant `--windows` threw
// away the macOS .dmg and .pkg, and the checksum file — built from whatever is present — then
// listed half a release without saying so.
const platformOf = (f) => (f.includes('macos') ? 'macos' : f.includes('windows') ? 'windows' : null);
for (const file of readdirSync(OUT_DIR)) {
  const platform = platformOf(file);
  if ((platform === 'macos' && buildMac) || (platform === 'windows' && buildWin)) {
    rmSync(join(OUT_DIR, file), { force: true });
  }
}

let macBinary = null;
if (buildMac) {
  compile('bun-darwin-arm64', join(BIN_DIR, 'bridge-arm64'));
  compile('bun-darwin-x64', join(BIN_DIR, 'bridge-x64'));
  macBinary = join(BIN_DIR, 'hankha-print-bridge');
  run('lipo', ['-create', '-output', macBinary, join(BIN_DIR, 'bridge-arm64'), join(BIN_DIR, 'bridge-x64')]);
  rmSync(join(BIN_DIR, 'bridge-arm64'));
  rmSync(join(BIN_DIR, 'bridge-x64'));

  // Apple silicon refuses to launch an unsigned binary outright, so ad-hoc signing is not
  // optional the way Developer ID signing is — without it the daemon dies at exec with a
  // "Killed: 9" that never reaches the installer log.
  const identity = process.env.HANKHA_MACOS_SIGN_IDENTITY;
  step(identity ? `Signing the binary as ${identity}` : 'Ad-hoc signing the binary');
  run('codesign', [
    '--force',
    '--timestamp' + (identity ? '' : '=none'),
    ...(identity ? ['--options', 'runtime'] : []),
    '--sign',
    identity || '-',
    macBinary,
  ]);
  if (!identity) {
    warn(
      'macOS binary is ad-hoc signed only. Staff will need to right-click \u2192 Open, or run ' +
        '`xattr -dr com.apple.quarantine <pkg>`, the first time.'
    );
  }

  // After signing, so what is checked is byte-for-byte what goes into the .pkg and .dmg.
  assertBinaryVersion(macBinary);
}

let winBinary = null;
if (buildWin) {
  winBinary = join(BIN_DIR, 'hankha-print-bridge.exe');
  compile('bun-windows-x64', winBinary);
  if (process.platform !== 'win32') {
    warn(
      'Cross-built from ' + process.platform + ', so the .exe carries no version/publisher ' +
        'properties (bun rejects --windows-* off Windows). The setup.exe still has them.'
    );
  }

  const pfx = process.env.HANKHA_WINDOWS_PFX;
  if (pfx && has('osslsigncode')) {
    step('Signing the Windows binary');
    run('osslsigncode', ['sign', '-pkcs12', pfx, '-pass', process.env.HANKHA_WINDOWS_PFX_PASSWORD ?? '',
      '-n', 'Hankha Print Bridge', '-t', 'http://timestamp.digicert.com',
      '-in', winBinary, '-out', `${winBinary}.signed`]);
    cpSync(`${winBinary}.signed`, winBinary);
    rmSync(`${winBinary}.signed`);
  } else if (pfx) {
    warn('HANKHA_WINDOWS_PFX is set but osslsigncode is not installed — shipping unsigned.');
  } else {
    warn(
      'Windows artifacts are unsigned. SmartScreen will show "Windows protected your PC" \u2014 ' +
        'staff must click "More info" \u2192 "Run anyway".'
    );
  }
}

// ---------------------------------------------------------------- macOS .pkg

if (buildMac) {
  step('Building the macOS package');
  const stage = join(BIN_DIR, 'pkgroot');
  const target = join(stage, 'usr/local/hankha/print-bridge');
  mkdirSync(target, { recursive: true });
  mkdirSync(join(stage, 'Library/LaunchDaemons'), { recursive: true });
  cpSync(macBinary, join(target, 'hankha-print-bridge'));
  cpSync(join(INSTALLER, 'macos/uninstall.sh'), join(target, 'uninstall.sh'));
  cpSync(
    join(INSTALLER, `macos/${IDENTIFIER}.plist`),
    join(stage, `Library/LaunchDaemons/${IDENTIFIER}.plist`)
  );

  const component = join(BIN_DIR, 'component.pkg');
  run('pkgbuild', [
    '--root', stage,
    '--scripts', join(INSTALLER, 'macos/scripts'),
    '--identifier', IDENTIFIER,
    '--version', VERSION,
    '--install-location', '/',
    component,
  ]);

  // productbuild resolves `component.pkg` relative to --package-path, so the distribution file
  // is templated only for the version.
  const dist = join(BIN_DIR, 'distribution.xml');
  writeFileSync(
    dist,
    readFileSync(join(INSTALLER, 'macos/distribution.xml'), 'utf8').replaceAll('__VERSION__', VERSION)
  );

  const unsignedPkg = join(BIN_DIR, 'unsigned.pkg');
  run('productbuild', [
    '--distribution', dist,
    '--package-path', BIN_DIR,
    '--resources', join(INSTALLER, 'macos/resources'),
    unsignedPkg,
  ]);

  const finalPkg = join(OUT_DIR, `hankha-print-bridge-${VERSION}-macos-universal.pkg`);
  const installerIdentity = process.env.HANKHA_MACOS_INSTALLER_IDENTITY;
  if (installerIdentity) {
    run('productsign', ['--sign', installerIdentity, unsignedPkg, finalPkg]);
  } else {
    cpSync(unsignedPkg, finalPkg);
  }

  const notaryProfile = process.env.HANKHA_NOTARY_PROFILE;
  if (notaryProfile && installerIdentity) {
    step('Notarizing');
    run('xcrun', ['notarytool', 'submit', finalPkg, '--keychain-profile', notaryProfile, '--wait']);
    run('xcrun', ['stapler', 'staple', finalPkg]);
  } else if (notaryProfile) {
    warn('HANKHA_NOTARY_PROFILE is set but HANKHA_MACOS_INSTALLER_IDENTITY is not — cannot notarize an unsigned package.');
  }
}

// ---------------------------------------------------------------- macOS .app + .dmg

if (buildMac) {
  step('Building the macOS app bundle');
  const appName = 'Hankha Print Bridge.app';
  const dmgStage = join(BIN_DIR, 'dmg');
  const app = join(dmgStage, appName);
  const macOsDir = join(app, 'Contents/MacOS');
  const resources = join(app, 'Contents/Resources');
  mkdirSync(macOsDir, { recursive: true });
  mkdirSync(resources, { recursive: true });

  const appSrc = join(INSTALLER, 'macos/app');
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    readFileSync(join(appSrc, 'Info.plist'), 'utf8').replaceAll('__VERSION__', VERSION)
  );
  cpSync(join(appSrc, 'AppIcon.icns'), join(resources, 'AppIcon.icns'));
  // The bundle's entry point is the control script; the server binary rides alongside it and
  // is what the LaunchAgent the script writes actually points at.
  cpSync(join(appSrc, 'HankhaPrintBridge'), join(macOsDir, 'HankhaPrintBridge'));
  chmodSync(join(macOsDir, 'HankhaPrintBridge'), 0o755);
  cpSync(macBinary, join(macOsDir, 'hankha-print-bridge'));
  chmodSync(join(macOsDir, 'hankha-print-bridge'), 0o755);

  // Sign inside-out: a nested Mach-O signed after its enclosing bundle invalidates the outer
  // signature, and macOS then refuses the whole app.
  const identity = process.env.HANKHA_MACOS_SIGN_IDENTITY;
  const signArgs = identity
    ? ['--force', '--timestamp', '--options', 'runtime', '--sign', identity]
    : ['--force', '--timestamp=none', '--sign', '-'];
  run('codesign', [...signArgs, join(macOsDir, 'hankha-print-bridge')]);
  run('codesign', [...signArgs, app]);

  step('Building the disk image');
  // The symlink is what makes the window a drag target: the user sees the app beside a folder
  // labelled Applications and drops one on the other.
  run('ln', ['-s', '/Applications', join(dmgStage, 'Applications')]);
  const dmg = join(OUT_DIR, `hankha-print-bridge-${VERSION}-macos.dmg`);
  run('hdiutil', [
    'create',
    '-volname', 'Hankha Print Bridge',
    '-srcfolder', dmgStage,
    '-fs', 'HFS+',
    '-format', 'UDZO',
    '-ov',
    '-quiet',
    dmg,
  ]);

  if (process.env.HANKHA_MACOS_INSTALLER_IDENTITY) {
    run('codesign', ['--force', '--sign', process.env.HANKHA_MACOS_INSTALLER_IDENTITY, dmg]);
  }

  const notaryProfile = process.env.HANKHA_NOTARY_PROFILE;
  if (notaryProfile && identity) {
    step('Notarizing the disk image');
    run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', notaryProfile, '--wait']);
    run('xcrun', ['stapler', 'staple', dmg]);
  }
}

// ---------------------------------------------------------------- Windows zip + setup.exe

if (buildWin) {
  step('Staging the Windows payload');
  const stage = join(BIN_DIR, 'windows-x64');
  mkdirSync(stage, { recursive: true });
  cpSync(winBinary, join(stage, 'hankha-print-bridge.exe'));
  for (const file of ['print-bridge.cmd', 'install.ps1', 'uninstall.ps1', 'status.ps1']) {
    cpSync(join(INSTALLER, 'windows', file), join(stage, file));
  }
  cpSync(join(ROOT, 'installer/windows/README-windows.txt'), join(stage, 'README.txt'));

  const zip = join(OUT_DIR, `hankha-print-bridge-${VERSION}-windows-x64.zip`);
  run('zip', ['-q', '-r', '-X', zip, 'windows-x64'], { cwd: BIN_DIR });

  step('Building the Windows setup.exe');
  const setup = join(OUT_DIR, `hankha-print-bridge-${VERSION}-windows-x64-setup.exe`);
  const nsisRunner = makensisWorks()
    ? { cmd: 'makensis', prefix: [], path: (p) => p }
    : dockerNsisAvailable()
      ? {
          cmd: 'docker',
          prefix: ['run', '--rm', '-v', `${ROOT}:/w`, '-w', '/w', 'hankha-nsis'],
          // Everything the container touches is under the app root, mounted at /w.
          path: (p) => p.replace(ROOT, '/w'),
        }
      : null;

  if (nsisRunner) {
    if (nsisRunner.cmd === 'docker') {
      console.log('   using the containerised NSIS (local makensis unusable or absent)');
    }
    run(nsisRunner.cmd, [
      ...nsisRunner.prefix,
      `-DVERSION=${VERSION}`,
      `-DSTAGE=${nsisRunner.path(stage)}`,
      `-DOUTFILE=${nsisRunner.path(setup)}`,
      nsisRunner.path(join(INSTALLER, 'windows/hankha-print-bridge.nsi')),
    ]);
    const pfx = process.env.HANKHA_WINDOWS_PFX;
    if (pfx && has('osslsigncode')) {
      run('osslsigncode', ['sign', '-pkcs12', pfx, '-pass', process.env.HANKHA_WINDOWS_PFX_PASSWORD ?? '',
        '-n', 'Hankha Print Bridge Setup', '-t', 'http://timestamp.digicert.com',
        '-in', setup, '-out', `${setup}.signed`]);
      cpSync(`${setup}.signed`, setup);
      rmSync(`${setup}.signed`);
    }
  } else {
    warn(
      'No usable NSIS, so NO setup.exe was produced \u2014 only the .zip. Start Docker Desktop ' +
        '(the containerised toolchain is built automatically), or install a working makensis.'
    );
  }
}

// ---------------------------------------------------------------- checksums

// Dotfiles are never artifacts, and Finder drops a .DS_Store in here the moment anyone opens
// the folder or mounts the built .dmg — which then ships as a checksummed "release file".
const artifacts = readdirSync(OUT_DIR)
  .filter((f) => f !== 'SHA256SUMS.txt' && !f.startsWith('.'))
  .sort();
writeFileSync(
  join(OUT_DIR, 'SHA256SUMS.txt'),
  artifacts.map((f) => `${sha256(join(OUT_DIR, f))}  ${f}\n`).join('')
);

step('Done');
for (const file of artifacts) {
  const mb = (statSync(join(OUT_DIR, file)).size / 1024 / 1024).toFixed(1);
  console.log(`   dist-installers/${file}  (${mb} MB)`);
}
console.log('   dist-installers/SHA256SUMS.txt');

if (warnings.length > 0) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`   - ${w}`);
}
