#!/usr/bin/env node
/**
 * Builds every installable artifact for the print bridge.
 *
 *   bun run package          everything this machine can produce
 *   bun run package --macos  just the .pkg
 *   bun run package --windows
 *
 * The bridge ships as a self-contained binary (`bun build --compile`) so a venue never has to
 * install a runtime. Cross-compiling the Windows exe works from macOS; building the macOS .pkg
 * does not work anywhere else, so those steps are skipped with a warning rather than failing.
 *
 * Signing is opt-in through the environment and every hook is a no-op when its variable is
 * unset — the default build is unsigned, which is what the README's Gatekeeper/SmartScreen
 * notes are about:
 *
 *   HANKHA_MACOS_SIGN_IDENTITY        Developer ID Application — signs the binary
 *   HANKHA_MACOS_INSTALLER_IDENTITY   Developer ID Installer   — signs the .pkg
 *   HANKHA_NOTARY_PROFILE             notarytool keychain profile — notarizes + staples
 *   HANKHA_WINDOWS_PFX                .pfx path — signs the exe and the setup via osslsigncode
 *   HANKHA_WINDOWS_PFX_PASSWORD
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(ROOT, 'dist-bin');
const OUT_DIR = join(ROOT, 'dist-installers');
const INSTALLER = join(ROOT, 'installer');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
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

// ---------------------------------------------------------------- binaries

step(`Building hankha-print-bridge v${VERSION}`);
rmSync(BIN_DIR, { recursive: true, force: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(BIN_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const buildMac = (wantAll || only.macos) && onMac;
const buildWin = wantAll || only.windows;

if ((wantAll || only.macos) && !onMac) {
  warn('Skipping the macOS .pkg — pkgbuild/productbuild only exist on macOS.');
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
    identity ?? '-',
    macBinary,
  ]);
  if (!identity) {
    warn(
      'macOS binary is ad-hoc signed only. Staff will need to right-click \u2192 Open, or run ' +
        '`xattr -dr com.apple.quarantine <pkg>`, the first time.'
    );
  }
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

// ---------------------------------------------------------------- Windows zip + setup.exe

if (buildWin) {
  step('Staging the Windows payload');
  const stage = join(BIN_DIR, 'windows-x64');
  mkdirSync(stage, { recursive: true });
  cpSync(winBinary, join(stage, 'hankha-print-bridge.exe'));
  for (const file of ['print-bridge.cmd', 'install.ps1', 'uninstall.ps1']) {
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

const artifacts = readdirSync(OUT_DIR).filter((f) => f !== 'SHA256SUMS.txt').sort();
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
