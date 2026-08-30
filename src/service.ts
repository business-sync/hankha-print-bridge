/*
 * What is running this bridge, and what may this process do about it?
 *
 * Every action on the maintenance card depends on this one answer, and getting it wrong is the
 * difference between "restarted" and "the till has no bridge until somebody drives there". So
 * three rules shape the whole module:
 *
 *  1. NEVER infer from a file's existence. `installer/macos/app/HankhaPrintBridge` documents why
 *     at length: once both macOS installers have been used on one Mac, the .pkg's plist exists
 *     while the .dmg's agent is the process actually answering, and a plist-based test reports
 *     the exact opposite of the truth. Ask launchd which pid it is running for our label, and
 *     compare it against our own.
 *  2. A capability that is refused says WHY and hands over the command to run by hand. "No" on
 *     its own, to an operator standing at a till, is indistinguishable from a broken button.
 *  3. Nothing here has a side effect. Acting is service-actions.ts; this module only looks.
 */
import { existsSync } from 'node:fs';
import { homedir, hostname, platform, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { stateDir } from './identity.js';
import { runCommand } from './transports/exec.js';

export const LAUNCHD_LABEL = 'la.hankha.print-bridge';
export const WINDOWS_TASK_NAME = 'Hankha Print Bridge';
export const SYSTEMD_UNIT = 'hankha-print-bridge';

/**
 * How this process was started, which decides everything else.
 *
 * `container` is separate from `systemd` on purpose: an orchestrated bridge is supervised, but
 * the restart policy, the filesystem and the host all belong to whatever started the container.
 * There is nothing here it may honestly do.
 */
export type ServiceManager =
  | 'launchd-daemon'
  | 'launchd-agent'
  | 'scheduled-task'
  | 'systemd'
  | 'container'
  | 'none';

export interface Capability {
  allowed: boolean;
  /** A stable identifier, so the page can pick its own wording. */
  reason?: string;
  /** The command that does it by hand. Always present when `allowed` is false and one exists. */
  hint?: string;
}

export interface ServiceReport {
  manager: ServiceManager;
  /** Whether the manager came from the launcher's own stamp or had to be worked out. */
  detected_by: 'stamp' | 'probe' | 'default';
  label: string | null;
  /** Something will start this bridge again if it stops. */
  supervised: boolean;
  /** ...and will do so after the computer reboots. */
  autostart: boolean;
  /** root, or SYSTEM. */
  privileged: boolean;
  /** A compiled, installed binary rather than `npm run dev`. */
  packaged: boolean;
  hostname: string;
  platform: string;
  install_dir: string | null;
  state_dir: string;
  log_path: string | null;
  can: {
    restart: Capability;
    autostart: Capability;
    uninstall: Capability;
    reboot: Capability;
    clear_cache: Capability;
  };
}

const MANAGERS: ServiceManager[] = [
  'launchd-daemon',
  'launchd-agent',
  'scheduled-task',
  'systemd',
  'container',
  'none',
];

function isManager(value: unknown): value is ServiceManager {
  return typeof value === 'string' && (MANAGERS as string[]).includes(value);
}

/* ------------------------------------------------------------------ small facts */

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Are we the compiled binary an installer put on this machine?
 *
 * Load-bearing for `autostart`: registering a LaunchAgent that points at `node` plus a `.ts`
 * path would write a plist that can never start anything, and it would look successful. Bun's
 * `--compile` output runs as `hankha-print-bridge`; `npm run dev` runs as `node` or `bun`.
 */
export function isPackagedBuild(): boolean {
  const exe = basename(process.execPath).toLowerCase().replace(/\.exe$/, '');
  return exe === 'hankha-print-bridge';
}

/** Where the installed payload lives, when this is one. */
export function installDir(): string | null {
  if (!isPackagedBuild()) return null;
  const dir = dirname(process.execPath);
  // The .dmg bundle keeps the binary in Contents/MacOS; the useful directory to report to an
  // operator is the .app itself, which is the thing they can see and drag to the Trash.
  if (platform() === 'darwin' && dir.endsWith('/Contents/MacOS')) {
    return dir.slice(0, -'/Contents/MacOS'.length);
  }
  return dir;
}

/**
 * The log file an operator will be asked to send, per platform.
 *
 * The three paths are the ones log.ts's header already names; they are repeated here because a
 * page that says "check the log" without saying where has not helped anyone. systemd gets null:
 * its output goes to the journal, and there is no path to print.
 */
export function logPath(): string | null {
  switch (platform()) {
    case 'win32':
      return join(process.env.ProgramData ?? 'C:\\ProgramData', 'Hankha', 'PrintBridge', 'logs', 'bridge.log');
    case 'darwin':
      return isRoot()
        ? '/var/log/hankha-print-bridge.log'
        : join(homedir(), 'Library', 'Logs', 'hankha-print-bridge.log');
    default:
      return null;
  }
}

export function daemonPlistPath(): string {
  return `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
}

export function agentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** Where a detached helper script is written. Never the state dir — `everything` deletes that. */
export function helperDir(): string {
  return tmpdir();
}

function inContainer(): boolean {
  return (
    existsSync('/.dockerenv') ||
    Boolean(process.env.KUBERNETES_SERVICE_HOST) ||
    process.env.PRINT_BRIDGE_IN_CONTAINER === '1'
  );
}

/* ------------------------------------------------------------------- detection */

/** The pid launchd currently has for our label in a domain, or null when it runs nothing. */
async function launchdPid(domainTarget: string): Promise<number | null> {
  const result = await runCommand('/bin/launchctl', ['print', `${domainTarget}/${LAUNCHD_LABEL}`], {
    timeoutMs: 5000,
  });
  if (!result.ok) return null;
  const match = /^\s*pid\s*=\s*(\d+)/m.exec(result.stdout);
  return match ? Number(match[1]) : null;
}

async function probeManager(): Promise<ServiceManager> {
  if (inContainer()) return 'container';

  if (platform() === 'darwin') {
    // Our own pid, matched against what launchd is running. See rule 1 at the top of the file.
    if ((await launchdPid('system')) === process.pid) return 'launchd-daemon';
    const uid = process.getuid?.() ?? -1;
    if (uid >= 0 && (await launchdPid(`gui/${uid}`)) === process.pid) return 'launchd-agent';
    return 'none';
  }

  if (platform() === 'win32') {
    /*
     * Windows has no equivalent of asking launchd for a job's pid, so this is a two-part
     * heuristic: the task is registered, AND we are the binary it points at. Either alone is
     * wrong — the task can be registered while an operator runs a second copy from a console,
     * and an unregistered install still runs from the same directory.
     *
     * A bridge installed by 1.10.0 or later never reaches this branch: `print-bridge.cmd`
     * stamps PRINT_BRIDGE_MANAGED and the stamp wins.
     */
    const query = await runCommand('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK_NAME], {
      timeoutMs: 8000,
    });
    if (!query.ok) return 'none';
    const dir = installDir();
    const expected = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Hankha', 'Print Bridge');
    return dir && dir.toLowerCase() === expected.toLowerCase() ? 'scheduled-task' : 'none';
  }

  // systemd sets INVOCATION_ID for every unit it starts, and nothing else does. Cheaper and more
  // reliable than shelling out to systemctl, which is not present in every base image.
  if (process.env.INVOCATION_ID) return 'systemd';
  return 'none';
}

async function detectAutostart(manager: ServiceManager): Promise<boolean> {
  switch (manager) {
    case 'launchd-daemon':
      return existsSync(daemonPlistPath());
    case 'launchd-agent':
      return existsSync(agentPlistPath());
    case 'scheduled-task': {
      const query = await runCommand('schtasks.exe', ['/Query', '/TN', WINDOWS_TASK_NAME], {
        timeoutMs: 8000,
      });
      return query.ok;
    }
    case 'systemd':
      return true;
    default:
      return false;
  }
}

/* ---------------------------------------------------------------- capabilities */

const MANUAL_RESTART_HINT: Record<string, string> = {
  darwin: 'Quit this process and start it again from wherever you started it.',
  win32: 'Close this window and start hankha-print-bridge.exe again.',
  linux: 'Quit this process and start it again from wherever you started it.',
};

function restartCapability(manager: ServiceManager): Capability {
  switch (manager) {
    case 'launchd-daemon':
    case 'launchd-agent':
    case 'scheduled-task':
    case 'systemd':
      return { allowed: true };
    case 'container':
      return {
        allowed: false,
        reason: 'container',
        hint: 'This bridge runs in a container. Restart the container instead.',
      };
    default:
      // The single most dangerous button on the page if this were ever wrong: a restart that
      // nothing undoes leaves the till with no bridge at all.
      return {
        allowed: false,
        reason: 'not-supervised',
        hint: MANUAL_RESTART_HINT[platform()] ?? MANUAL_RESTART_HINT.linux,
      };
  }
}

function autostartCapability(manager: ServiceManager, autostart: boolean, privileged: boolean): Capability {
  if (autostart) return { allowed: false, reason: 'already-registered' };
  if (manager === 'container') return { allowed: false, reason: 'container' };
  if (!isPackagedBuild()) {
    return {
      allowed: false,
      reason: 'not-packaged',
      hint: 'This is a development build. Install a released bridge to register it as a service.',
    };
  }

  if (platform() === 'darwin') {
    const dir = installDir();
    // The trap the .dmg's own launcher exists to catch: an agent registered from the mounted
    // image records a /Volumes path that breaks silently, weeks later, when the image is ejected.
    if (dir?.startsWith('/Volumes/')) {
      return {
        allowed: false,
        reason: 'running-from-volume',
        hint: 'Drag Hankha Print Bridge to your Applications folder and open it from there.',
      };
    }
    return { allowed: true };
  }

  if (platform() === 'win32') {
    if (!privileged) {
      return {
        allowed: false,
        reason: 'needs-elevation',
        hint: '.\\install.ps1   (in an elevated PowerShell)',
      };
    }
    const script = installDir() ? join(installDir() as string, 'install.ps1') : null;
    if (!script || !existsSync(script)) {
      return {
        allowed: false,
        reason: 'installer-missing',
        hint: '.\\install.ps1   (from the unzipped archive, in an elevated PowerShell)',
      };
    }
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: 'unsupported-platform',
    hint: `sudo systemctl enable --now ${SYSTEMD_UNIT}`,
  };
}

function uninstallCapability(manager: ServiceManager, privileged: boolean): Capability {
  switch (manager) {
    case 'launchd-agent':
      return { allowed: true };
    case 'launchd-daemon':
      return privileged
        ? { allowed: true }
        : { allowed: false, reason: 'needs-root', hint: 'sudo /usr/local/hankha/print-bridge/uninstall.sh' };
    case 'scheduled-task':
      return privileged
        ? { allowed: true }
        : { allowed: false, reason: 'needs-elevation', hint: 'Settings \u203a Apps \u203a Hankha Print Bridge' };
    case 'systemd':
      return {
        allowed: false,
        reason: 'unsupported-platform',
        hint: `sudo systemctl disable --now ${SYSTEMD_UNIT}`,
      };
    case 'container':
      return { allowed: false, reason: 'container' };
    default:
      return { allowed: false, reason: 'not-installed' };
  }
}

function rebootCapability(manager: ServiceManager, privileged: boolean): Capability {
  if (manager === 'container') {
    return { allowed: false, reason: 'container', hint: 'The host is not this container\u2019s to restart.' };
  }
  if (platform() === 'win32') {
    return privileged
      ? { allowed: true }
      : { allowed: false, reason: 'needs-elevation', hint: 'shutdown /r /t 0' };
  }
  if (platform() === 'darwin') {
    // Root reboots outright; a LaunchAgent asks the logged-in session to restart, so open apps
    // still get their chance to save. A user-owned process with no GUI session can do neither.
    if (privileged || manager === 'launchd-agent' || manager === 'none') return { allowed: true };
    return { allowed: false, reason: 'no-session', hint: 'sudo shutdown -r now' };
  }
  return privileged ? { allowed: true } : { allowed: false, reason: 'needs-root', hint: 'sudo systemctl reboot' };
}

/* --------------------------------------------------------------------- report */

let cached: { at: number; value: ServiceReport } | null = null;
const CACHE_TTL_MS = 30_000;

/** Forget the cached report. Called after every action, so the page sees the new truth at once. */
export function invalidateServiceReport(): void {
  cached = null;
}

/**
 * The whole picture, cached.
 *
 * The probe path costs a spawn, so this is deliberately NOT on `/health` — that route is polled
 * by every POS terminal in the venue and has to stay a memory read.
 */
export async function serviceReport(): Promise<ServiceReport> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const stamped = process.env.PRINT_BRIDGE_MANAGED?.trim().toLowerCase();
  const fromStamp = isManager(stamped);
  const manager = fromStamp ? (stamped as ServiceManager) : await probeManager();

  const privileged =
    platform() === 'win32'
      ? process.env.USERNAME?.toUpperCase() === 'SYSTEM' || manager === 'scheduled-task'
      : isRoot();
  const autostart = await detectAutostart(manager);

  const value: ServiceReport = {
    manager,
    detected_by: fromStamp ? 'stamp' : manager === 'none' ? 'default' : 'probe',
    label:
      manager === 'launchd-daemon' || manager === 'launchd-agent'
        ? LAUNCHD_LABEL
        : manager === 'scheduled-task'
          ? WINDOWS_TASK_NAME
          : manager === 'systemd'
            ? SYSTEMD_UNIT
            : null,
    supervised: manager !== 'none',
    autostart,
    privileged,
    packaged: isPackagedBuild(),
    hostname: hostname(),
    platform: platform(),
    install_dir: installDir(),
    state_dir: stateDir(),
    log_path: logPath(),
    can: {
      restart: restartCapability(manager),
      autostart: autostartCapability(manager, autostart, privileged),
      uninstall: uninstallCapability(manager, privileged),
      reboot: rebootCapability(manager, privileged),
      // The only action that touches nothing but our own state directory, so it needs no
      // privilege and no supervisor — and it stays available on a bridge that has neither.
      clear_cache: { allowed: true },
    },
  };

  cached = { at: now, value };
  return value;
}
