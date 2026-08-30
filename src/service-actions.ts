/*
 * Doing the things `service.ts` says are possible: restart, register autostart, uninstall,
 * reboot.
 *
 * Three facts about the two platforms drive nearly every decision in this file, and they point
 * in opposite directions:
 *
 *  - macOS can unlink a running binary, and `launchctl bootout` tears down the WHOLE job — so a
 *    detached helper spawned to "finish up after we die" can be killed along with us. Everything
 *    is therefore done in-process, with the step that kills us left for last.
 *  - Windows cannot delete a running .exe, and a scheduled task that ends CLEANLY is not
 *    restarted by `-RestartInterval` (that only fires when the task ends in error). So both
 *    restart and uninstall need a detached helper that outlives us — which Windows, having no
 *    job-scoped teardown, is happy to run.
 *  - Every command that could be composed as one quoted string is written to a FILE instead and
 *    invoked as `cmd /c <path>`. `spooler.ts` already does this for its PowerShell shim, and
 *    `install.ps1` uses `-Execute` rather than `schtasks /TR`, both for the same reason: nested
 *    quoting through spawn, CreateProcess and a shell's own parser is three chances to corrupt
 *    something that cannot be tested from the macOS build machine.
 */
import { spawn } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { canStop, requestStop } from './lifecycle.js';
import { log } from './log.js';
import { queue } from './queue.js';
import {
  agentPlistPath,
  daemonPlistPath,
  helperDir,
  invalidateServiceReport,
  isRoot,
  LAUNCHD_LABEL,
  logPath,
  WINDOWS_TASK_NAME,
  type ServiceReport,
} from './service.js';
import { runCommand } from './transports/exec.js';

/** How long the answer has to reach the browser before this process starts going away. */
const STOP_DELAY_MS = 1500;
/** How long a launchd handover waits before we release the port to the new copy. */
const HANDOVER_DELAY_MS = 2500;
export const DEFAULT_REBOOT_DELAY_SECONDS = 60;
const MAX_REBOOT_DELAY_S = 600;

export type UninstallScope = 'autostart' | 'files' | 'everything';

export interface ActionOutcome {
  ok: boolean;
  /** Stable identifier the page maps to its own wording. */
  reason?: string;
  hint?: string;
  detail?: string;
  [key: string]: unknown;
}

function refused(capability: { reason?: string; hint?: string }): ActionOutcome {
  return { ok: false, reason: capability.reason ?? 'not-allowed', hint: capability.hint };
}

function scheduleStop(exitCode: number): void {
  // Not unref'd: this timer IS the shutdown, and an unref'd one would let node exit first on an
  // otherwise idle process.
  setTimeout(() => {
    if (!requestStop(exitCode)) {
      log.warn('service: nothing registered a graceful stop; staying up', { event: 'service.stop.unavailable' });
    }
  }, STOP_DELAY_MS);
}

/* ------------------------------------------------------------- windows helper */

/**
 * One helper script, four modes. Written to the temp directory rather than the state directory,
 * because `uninstall --everything` deletes the state directory and a script cannot remove the
 * ground it is standing on.
 *
 * A FIXED filename, so repeated use overwrites rather than accumulates — and so nothing has to
 * delete itself while cmd is still reading it line by line.
 *
 * `ping -n` is the delay, not `timeout /t`: this runs detached with no console, and `timeout`
 * fails outright with "input redirection is not supported" in exactly that situation.
 */
export const WINDOWS_HELPER = `@echo off
rem  Written by the Hankha Print Bridge itself and started detached, to finish work that cannot
rem  be done by a process that is about to exit (or be deleted).
rem
rem    %1  mode      restart | autostart | files | everything
rem    %2  pid       the bridge's pid, to wait for
rem    %3  instdir   where the payload lives
rem    %4  statedir  set only for 'everything'
setlocal
set "MODE=%~1"
set "PID=%~2"
set "INSTDIR=%~3"
set "STATEDIR=%~4"
set "TASK=${WINDOWS_TASK_NAME}"

call :waitforexit

if /i "%MODE%"=="restart" goto restart
if /i "%MODE%"=="autostart" goto unregister
goto removeall

:restart
rem  MultipleInstances IgnoreNew means a /Run issued while the old copy is still up is silently
rem  dropped, which is why the wait above is not optional. Three attempts cover a slow release
rem  of the port.
for /l %%i in (1,1,3) do (
  schtasks /Run /TN "%TASK%" >nul 2>&1
  ping -n 6 127.0.0.1 >nul
)
goto done

:unregister
schtasks /End /TN "%TASK%" >nul 2>&1
schtasks /Delete /TN "%TASK%" /F >nul 2>&1
goto done

:removeall
rem  The registered uninstaller first, so the Settings > Apps entry goes with it. Plain /S, not
rem  _?=, so NSIS copies itself to temp and can remove its own directory.
if exist "%INSTDIR%\\Uninstall.exe" (
  "%INSTDIR%\\Uninstall.exe" /S
) else if exist "%INSTDIR%\\uninstall.ps1" (
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%INSTDIR%\\uninstall.ps1"
) else (
  schtasks /End /TN "%TASK%" >nul 2>&1
  schtasks /Delete /TN "%TASK%" /F >nul 2>&1
  taskkill /F /IM hankha-print-bridge.exe >nul 2>&1
  netsh advfirewall firewall delete rule name="%TASK%" >nul 2>&1
  if not "%INSTDIR%"=="" rd /s /q "%INSTDIR%" >nul 2>&1
)
if not "%STATEDIR%"=="" (
  ping -n 4 127.0.0.1 >nul
  rd /s /q "%STATEDIR%" >nul 2>&1
)
goto done

:waitforexit
if "%PID%"=="" goto :eof
for /l %%i in (1,1,60) do (
  tasklist /FI "PID eq %PID%" /NH 2>nul | find /i "hankha-print-bridge" >nul || goto :eof
  ping -n 2 127.0.0.1 >nul
)
goto :eof

:done
exit /b 0
`;

export function windowsHelperPath(): string {
  return join(helperDir(), 'hankha-print-bridge-helper.cmd');
}

/**
 * Write the helper and start it detached. Returns false when either half failed, which is the
 * signal for every caller to fall back to something that needs no helper at all.
 */
export function spawnWindowsHelper(mode: 'restart' | UninstallScope, report: ServiceReport): boolean {
  const path = windowsHelperPath();
  try {
    writeFileSync(path, WINDOWS_HELPER);
  } catch (err) {
    log.warn(`service: could not write the Windows helper (${describe(err)})`, {
      event: 'service.helper.write_failed', path,
    });
    return false;
  }

  try {
    const child = spawn(
      'cmd.exe',
      [
        '/c',
        path,
        mode,
        String(process.pid),
        report.install_dir ?? '',
        mode === 'everything' ? report.state_dir : '',
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
    return true;
  } catch (err) {
    log.warn(`service: could not start the Windows helper (${describe(err)})`, {
      event: 'service.helper.spawn_failed',
    });
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* -------------------------------------------------------------------- restart */

export async function restartService(report: ServiceReport): Promise<ActionOutcome> {
  if (!report.can.restart.allowed) return refused(report.can.restart);
  if (!canStop()) {
    return { ok: false, reason: 'no-lifecycle', detail: 'this process has no graceful stop registered' };
  }

  let method: 'supervisor' | 'task-run' | 'error-exit' = 'supervisor';
  let exitCode = 0;

  if (report.manager === 'scheduled-task') {
    if (spawnWindowsHelper('restart', report)) {
      method = 'task-run';
    } else {
      /*
       * The fallback that must never be skipped. Exiting 1 makes the task end IN ERROR, which is
       * the only condition `-RestartInterval 1 minute` reacts to. Slower than the helper, and
       * the difference between a bridge that is back in a minute and one that is back in five.
       */
      method = 'error-exit';
      exitCode = 1;
    }
  }

  log.warn(`service: restarting (${method})`, { event: 'service.restart', method, manager: report.manager });
  scheduleStop(exitCode);
  invalidateServiceReport();

  return { ok: true, method, expect_back_in_s: method === 'error-exit' ? 75 : 20 };
}

/* ------------------------------------------------------------------ autostart */

/**
 * The plist, in the shape `installer/macos/app/HankhaPrintBridge` already writes.
 *
 * Loopback only, for the reason repeated in every other copy of it: a POS served over https can
 * reach a bridge on localhost and nowhere else, so listening wider on a till widens exposure and
 * buys nothing.
 */
export function launchdPlist(binary: string, port: number, logFile: string, managed: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRINT_BRIDGE_PORT</key>
    <string>${port}</string>
    <key>PRINT_BRIDGE_HOST</key>
    <string>127.0.0.1</string>
    <key>PRINT_BRIDGE_MANAGED</key>
    <string>${managed}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;
}

/**
 * Hand this running bridge over to the operating system, so it comes back on its own.
 *
 * The handover is the subtle part. Bootstrapping an agent that points at our own binary starts a
 * SECOND copy while we still hold port 9200, and it dies on EADDRINUSE. launchd's KeepAlive plus
 * a 10s ThrottleInterval turns that into a retry loop — so we bootstrap, then stop ourselves, and
 * the next attempt binds. The page waits for a pid that is not ours, exactly as it does for a
 * restart.
 */
export async function registerAutostart(report: ServiceReport): Promise<ActionOutcome> {
  if (!report.can.autostart.allowed) return refused(report.can.autostart);

  if (platform() === 'win32') return registerWindowsTask(report);
  if (platform() !== 'darwin') return { ok: false, reason: 'unsupported-platform' };

  const asDaemon = isRoot();
  const plistPath = asDaemon ? daemonPlistPath() : agentPlistPath();
  const domain = asDaemon ? 'system' : `gui/${process.getuid?.() ?? 0}`;
  const logFile = logPath() ?? join(homedir(), 'Library', 'Logs', 'hankha-print-bridge.log');
  const port = Number(process.env.PRINT_BRIDGE_PORT ?? 9200) || 9200;

  try {
    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(
      plistPath,
      launchdPlist(process.execPath, port, logFile, asDaemon ? 'launchd-daemon' : 'launchd-agent')
    );
    if (asDaemon) {
      // launchd refuses a daemon plist that is not root-owned with tight permissions, and the
      // refusal is SILENT — the same trap `installer/macos/scripts/postinstall` re-stamps for.
      chownSync(plistPath, 0, 0);
      chmodSync(plistPath, 0o644);
    }
  } catch (err) {
    return { ok: false, reason: 'plist-write-failed', detail: describe(err) };
  }

  await runCommand('/bin/launchctl', ['enable', `${domain}/${LAUNCHD_LABEL}`], { timeoutMs: 8000 });
  const bootstrap = await runCommand('/bin/launchctl', ['bootstrap', domain, plistPath], { timeoutMs: 15_000 });
  if (!bootstrap.ok) {
    // Leave nothing half-registered behind: a plist launchd never accepted is a file that does
    // nothing and makes the next detection lie about autostart.
    rmSync(plistPath, { force: true });
    return {
      ok: false,
      reason: 'bootstrap-failed',
      detail: (bootstrap.stderr || bootstrap.stdout).trim().slice(0, 400),
    };
  }

  log.warn('service: registered autostart, handing the port over', {
    event: 'service.autostart', domain, plist: plistPath,
  });
  invalidateServiceReport();
  setTimeout(() => requestStop(0), HANDOVER_DELAY_MS);

  return { ok: true, handover: true, plist: plistPath, expect_back_in_s: 30 };
}

async function registerWindowsTask(report: ServiceReport): Promise<ActionOutcome> {
  const dir = report.install_dir;
  const script = dir ? join(dir, 'install.ps1') : null;
  if (!script || !existsSync(script)) {
    return { ok: false, reason: 'installer-missing', hint: report.can.autostart.hint };
  }

  /*
   * `install.ps1 -SkipCopy` is the SAME call the NSIS installer makes, so there is still exactly
   * one implementation of "install" on this platform. It stops any running copy first — which is
   * us — and then registers and starts the task, so no separate handover is needed here.
   */
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SkipCopy', '-InstallDir', dir as string],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
  } catch (err) {
    return { ok: false, reason: 'spawn-failed', detail: describe(err) };
  }

  log.warn('service: registering the scheduled task', { event: 'service.autostart', script });
  invalidateServiceReport();
  return { ok: true, handover: true, expect_back_in_s: 45 };
}

/* ------------------------------------------------------------------ uninstall */

export interface UninstallOutcome extends ActionOutcome {
  removed?: string[];
  /** Paths only a person can deal with — the .app bundle in /Applications. */
  manual?: string[];
  kept?: string[];
}

export async function uninstallService(report: ServiceReport, scope: UninstallScope): Promise<UninstallOutcome> {
  if (!report.can.uninstall.allowed) return refused(report.can.uninstall);

  if (report.manager === 'scheduled-task') return uninstallWindows(report, scope);
  if (report.manager === 'launchd-agent' || report.manager === 'launchd-daemon') {
    return uninstallLaunchd(report, scope);
  }
  return { ok: false, reason: 'not-installed' };
}

async function uninstallLaunchd(report: ServiceReport, scope: UninstallScope): Promise<UninstallOutcome> {
  const asDaemon = report.manager === 'launchd-daemon';
  const plistPath = asDaemon ? daemonPlistPath() : agentPlistPath();
  const domain = asDaemon ? 'system' : `gui/${process.getuid?.() ?? 0}`;
  const removed: string[] = [];
  const manual: string[] = [];

  try {
    if (existsSync(plistPath)) {
      rmSync(plistPath, { force: true });
      removed.push(plistPath);
    }

    if (asDaemon) {
      // Best effort: a package the receipt database has already forgotten is not an error.
      await runCommand('/usr/sbin/pkgutil', ['--forget', LAUNCHD_LABEL], { timeoutMs: 10_000 });
    }

    if (scope !== 'autostart') {
      if (asDaemon) {
        // Unlinking a running binary is legal here, which is the whole reason this needs no
        // helper process — and why it must not be attempted the same way on Windows.
        rmSync('/usr/local/hankha/print-bridge', { recursive: true, force: true });
        removed.push('/usr/local/hankha/print-bridge');
      } else if (report.install_dir) {
        // The .app in /Applications is the operator's, not ours. Its own dialog says to drag it
        // to the Trash, and saying anything different here would be a second story.
        manual.push(report.install_dir);
      }
    }

    if (scope === 'everything') {
      rmSync(report.state_dir, { recursive: true, force: true });
      removed.push(report.state_dir);
    }
  } catch (err) {
    return { ok: false, reason: 'remove-failed', detail: describe(err), removed };
  }

  log.warn(`service: uninstalling (${scope})`, { event: 'service.uninstall', scope, manager: report.manager });
  invalidateServiceReport();

  // Last, because it kills us. `requestStop` is the backstop for a bootout that fails: without
  // it a bridge whose plist is already gone would keep running with nothing left to manage it.
  setTimeout(() => {
    void runCommand('/bin/launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`], { timeoutMs: 10_000 }).finally(
      () => requestStop(0)
    );
  }, STOP_DELAY_MS);

  return { ok: true, scope, removed, manual, kept: keptPaths(scope, report) };
}

async function uninstallWindows(report: ServiceReport, scope: UninstallScope): Promise<UninstallOutcome> {
  if (!spawnWindowsHelper(scope, report)) {
    return { ok: false, reason: 'helper-failed', hint: report.can.uninstall.hint };
  }
  log.warn(`service: uninstalling (${scope})`, { event: 'service.uninstall', scope, manager: report.manager });
  invalidateServiceReport();
  scheduleStop(0);
  return {
    ok: true,
    scope,
    removed: scope === 'autostart' ? [WINDOWS_TASK_NAME] : [WINDOWS_TASK_NAME, report.install_dir ?? ''].filter(Boolean),
    manual: [],
    kept: keptPaths(scope, report),
  };
}

/**
 * What survives, said out loud.
 *
 * Logs are on every list on purpose: both existing uninstallers and the README already promise
 * it, because they are the only record of why a till stopped printing.
 */
function keptPaths(scope: UninstallScope, report: ServiceReport): string[] {
  const kept: string[] = [];
  if (report.log_path) kept.push(report.log_path);
  if (scope !== 'everything') kept.push(report.state_dir);
  return kept;
}

/* --------------------------------------------------------------------- reboot */

interface PendingReboot {
  at: number;
  timer: NodeJS.Timeout;
  force: boolean;
}

let pendingReboot: PendingReboot | null = null;

export function rebootPending(): { rebooting_at: string; in_s: number } | null {
  if (!pendingReboot) return null;
  return {
    rebooting_at: new Date(pendingReboot.at).toISOString(),
    in_s: Math.max(0, Math.round((pendingReboot.at - Date.now()) / 1000)),
  };
}

export function cancelReboot(): boolean {
  if (!pendingReboot) return false;
  clearTimeout(pendingReboot.timer);
  pendingReboot = null;
  log.warn('service: scheduled reboot cancelled', { event: 'service.reboot.cancelled' });
  return true;
}

/**
 * Arm a reboot, after a delay the operator can still call off.
 *
 * The delay is held HERE rather than handed to the operating system, and that is a deliberate
 * choice: `shutdown /r /t 60` and `shutdown -r +1` behave differently, cancel differently
 * (`shutdown /a` versus killing a pid), and macOS has a one-minute floor. One timer in this
 * process is one mechanism on every platform, and it is the only version the page can show a
 * countdown for.
 */
export function scheduleReboot(
  report: ServiceReport,
  delaySeconds: number,
  force: boolean
): ActionOutcome {
  if (!report.can.reboot.allowed) return refused(report.can.reboot);
  if (pendingReboot) return { ok: false, reason: 'already-scheduled', ...rebootPending() };

  // A till mid-service is the normal case, so this is a real guard and not a formality. Queued
  // jobs survive in the spool and print on the way back up; the one being sent right now is
  // settled `unknown` by the queue's own recovery, because nobody can ask the paper.
  const pending = queue().pending();
  if (pending > 0 && !force) {
    return { ok: false, reason: 'queue-not-empty', pending };
  }

  const delay = Math.min(Math.max(0, Math.round(delaySeconds)), MAX_REBOOT_DELAY_S);
  const at = Date.now() + delay * 1000;
  const timer = setTimeout(() => {
    pendingReboot = null;
    void performReboot(report);
  }, delay * 1000);

  pendingReboot = { at, timer, force };
  log.warn(`service: reboot scheduled in ${delay}s`, {
    event: 'service.reboot.scheduled', delay_s: delay, pending, force,
  });
  return { ok: true, rebooting_at: new Date(at).toISOString(), in_s: delay, pending };
}

/** The one command per platform, chosen by who we are rather than by what is installed. */
export function rebootCommand(report: ServiceReport): { file: string; args: string[] } | null {
  if (platform() === 'win32') {
    return { file: 'shutdown.exe', args: ['/r', '/t', '0', '/c', 'Hankha Print Bridge maintenance'] };
  }
  if (platform() === 'darwin') {
    if (isRoot()) return { file: '/sbin/shutdown', args: ['-r', 'now'] };
    // Asks the logged-in session to restart, so open applications still get to save. A bare
    // `shutdown` here would only fail, needing a password nobody can type into a web page.
    return { file: '/usr/bin/osascript', args: ['-e', 'tell application "System Events" to restart'] };
  }
  if (isRoot()) return { file: 'systemctl', args: ['reboot'] };
  return null;
}

async function performReboot(report: ServiceReport): Promise<void> {
  const command = rebootCommand(report);
  if (!command) {
    log.error('service: no way to reboot this machine', { event: 'service.reboot.unsupported' });
    return;
  }
  log.warn(`service: rebooting via ${command.file}`, { event: 'service.reboot.firing' });
  const result = await runCommand(command.file, command.args, { timeoutMs: 20_000 });
  if (!result.ok) {
    log.error(`service: reboot command failed — ${(result.stderr || result.stdout).trim()}`, {
      event: 'service.reboot.failed', code: result.code,
    });
  }
}

/* ----------------------------------------------------------------------- logs */

/**
 * The log file and its rotated predecessor, with sizes — the fourth line of the cache panel.
 *
 * `print-bridge.cmd` keeps one previous file (`bridge.log.1`) once the live one passes 5 MB, so
 * reporting only the live file would show 3 MB on a till holding 8.
 */
export function logFileInfo(): { path: string | null; bytes: number; files: string[] } {
  const live = logPath();
  if (!live) return { path: null, bytes: 0, files: [] };

  const files: string[] = [];
  let bytes = 0;
  for (const candidate of [live, `${live}.1`]) {
    try {
      bytes += statSync(candidate).size;
      files.push(candidate);
    } catch {
      // Not every install has rotated yet, and a fresh one has no log at all.
    }
  }
  return { path: live, bytes, files };
}

/**
 * Empty the logs by TRUNCATING them, never by deleting them.
 *
 * Both writers hold the file open — launchd through `StandardOutPath`, and `print-bridge.cmd`
 * through its `>>` redirect. Unlinking on Windows fails outright while a handle is open, and on
 * macOS it succeeds and leaves the daemon writing to an inode with no name, so the log appears
 * to stop existing until the next restart. Writing zero bytes is the one form of "clear" that
 * both writers survive.
 */
export function clearLogs(): { cleared: string[]; bytes: number } {
  const info = logFileInfo();
  const cleared: string[] = [];
  for (const file of info.files) {
    try {
      writeFileSync(file, '');
      cleared.push(file);
    } catch (err) {
      log.warn(`service: could not clear ${file} (${describe(err)})`, { event: 'service.logs.clear_failed' });
    }
  }
  return { cleared, bytes: info.bytes };
}
