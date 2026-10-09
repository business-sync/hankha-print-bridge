import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The bridge's only persistent state: who it is, and its relay credential.
 *
 * Until now the process was entirely stateless, which is why this is one small JSON file
 * rather than anything larger. It has to survive restarts and upgrades — re-enrolling on every
 * boot would mint a new bridge row per restart and leave the operator picking between a dozen
 * identical "Counter PC" entries.
 */
export interface RelayState {
  /** Minted once, on first start. Stable across upgrades; the (org, install_id) key. */
  install_id: string;
  relay_url?: string;
  bridge_id?: string;
  /** Opaque bearer token. The server only ever stored its hash. */
  token?: string;
  enrolled_at?: string;
}

const FILE_NAME = 'relay.json';

/**
 * Where the state file lives, per platform.
 *
 * Each path is a directory the corresponding installer already creates and already owns, so
 * nothing here needs new permissions. Resolved from real OS paths and never from
 * `import.meta.url`: the shipped artifact is a `bun build --compile` binary whose module paths
 * point into a virtual filesystem that is read-only and thrown away on exit.
 */
export function stateDir(): string {
  const override = process.env.PRINT_BRIDGE_STATE_DIR?.trim();
  if (override) return override;

  switch (platform()) {
    case 'win32':
      // The directory `print-bridge.cmd` already creates for its env file and logs.
      return join(process.env.ProgramData ?? 'C:\\ProgramData', 'Hankha', 'PrintBridge');
    case 'darwin':
      // The .pkg installs the binary here and its LaunchDaemon runs as root. The .dmg's
      // LaunchAgent runs as the user, so it falls back to a per-user path it can write.
      return process.getuid?.() === 0
        ? '/usr/local/hankha/print-bridge'
        : join(homedir(), 'Library', 'Application Support', 'Hankha', 'PrintBridge');
    default:
      return '/var/lib/hankha-print-bridge';
  }
}

export function statePath(): string {
  return join(stateDir(), FILE_NAME);
}

/**
 * Read the state file, creating an install id if this is a first start.
 *
 * Never throws: an unreadable or corrupt file yields a fresh identity rather than stopping the
 * process. A bridge that refuses to start because it cannot read its own scratch file is worse
 * than one that asks to be enrolled again — the first prints nothing at all.
 */
export function loadState(): RelayState {
  const path = statePath();
  // The previous copy is tried before giving up: an interrupted write or a transient read error
  // (antivirus holding the file on Windows) must not turn a paired bridge into an unpaired one.
  return readStateFile(path) ?? readStateFile(`${path}.bak`) ?? { install_id: randomUUID() };
}

function readStateFile(path: string): RelayState | null {
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RelayState>;
      if (typeof parsed.install_id === 'string' && parsed.install_id.length >= 8) {
        return parsed as RelayState;
      }
    }
  } catch {
    // fall through to the caller's next candidate
  }
  return null;
}

/**
 * Persist state. Mode 0600 — the file holds a bearer token that can print anywhere in the
 * branch, and on macOS/Linux the daemon's directory is otherwise world-readable.
 */
export function saveState(state: RelayState): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  /*
   * Write-then-rename, so a crash or power cut leaves either the old file or the new one — never
   * half of one. A plain `writeFileSync` truncates first, and a truncated file used to read as
   * "this computer was never paired": the bridge went silent and announced itself as a new machine.
   * The outgoing file is kept as `.bak` for `loadState` to fall back on.
   */
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  } catch {
    // The backup is a convenience; failing to take it must not fail the save.
  }
  renameSync(tmp, path);
}
