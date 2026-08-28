/*
 * Serial — and, on every desktop OS, Bluetooth too.
 *
 * A Bluetooth thermal printer paired through the operating system's own Bluetooth settings is
 * exposed as an RFCOMM serial port: `/dev/cu.RPP02N-SPP` on macOS, `/dev/rfcomm0` on Linux, a COM
 * port on Windows. So "Bluetooth support" here is pairing (which belongs to the OS, where the user
 * can see the PIN prompt) plus this driver. There is no BLE path: a GATT-only printer needs a
 * native Bluetooth stack, which is the same cross-compilation problem `spooler.ts` explains, and
 * the OS cannot expose it as a tty.
 *
 * Two platform details that are the whole difference between working and hanging:
 *
 *  - On macOS use the CALL-OUT device (`/dev/cu.*`), never the dial-in one (`/dev/tty.*`).
 *    Opening a `tty.` device blocks until carrier detect asserts, which a printer never does, so
 *    the open never returns and the job simply disappears. `cu.` skips that wait. Paths are
 *    normalised below rather than documented and hoped for.
 *  - The line discipline has to be set out of band. Node has no termios binding, so `stty`
 *    (POSIX) and `mode.com` (Windows) do it — both ship with the OS.
 */
import { constants, existsSync, readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { PrinterRecord } from '../registry.js';
import { DEFAULT_BAUD } from '../registry.js';
import { commandExists, runCommand } from './exec.js';
import { failed, succeeded, type DiscoveredPrinter, type ProbeResult, type Transport } from './transport.js';

const isWindows = (): boolean => process.platform === 'win32';

/**
 * `/dev/tty.Foo` -> `/dev/cu.Foo` on macOS, and `COM3` -> `\\.\COM3` on Windows.
 *
 * The COM rewrite matters past COM9: the bare `COM10` name is not a valid path, and the failure
 * is a confusing ENOENT on a port the operator can see in Device Manager.
 */
export function normalizeDevicePath(device: string): string {
  if (isWindows()) {
    return /^COM\d+$/i.test(device) ? `\\\\.\\${device.toUpperCase()}` : device;
  }
  if (process.platform === 'darwin' && device.startsWith('/dev/tty.')) {
    return `/dev/cu.${device.slice('/dev/tty.'.length)}`;
  }
  return device;
}

/**
 * Apply baud rate and a raw line discipline.
 *
 * Never fatal. A USB-serial adapter that is already at the right settings prints perfectly well
 * without this, and refusing to print because `stty` is missing would trade a working job for a
 * cosmetic guarantee. The detail is returned so a probe can mention it.
 */
async function configureLine(device: string, baud: number, timeoutMs: number): Promise<string | null> {
  if (isWindows()) {
    if (!commandExists('mode.com')) return 'mode.com not found — using the port as configured';
    const port = device.replace(/^\\\\\.\\/, '');
    const result = await runCommand('mode.com',
      [`${port}:`, `BAUD=${baud}`, 'PARITY=n', 'DATA=8', 'STOP=1', 'to=off', 'xon=off', 'odsr=off', 'octs=off', 'dtr=on', 'rts=on', 'idsr=off'],
      { timeoutMs });
    return result.ok ? null : (result.stderr || result.stdout).trim() || 'mode.com refused the port';
  }

  if (!commandExists('stty')) return 'stty not found — using the port as configured';
  // BSD (macOS) spells the device flag `-f`; GNU (Linux) spells it `-F`. There is no spelling
  // both accept, so this is chosen by platform rather than probed.
  const deviceFlag = process.platform === 'darwin' ? '-f' : '-F';
  const result = await runCommand('stty', [deviceFlag, device, String(baud), 'raw', '-echo', '-crtscts'], { timeoutMs });
  return result.ok ? null : (result.stderr || result.stdout).trim() || 'stty refused the port';
}

/**
 * Open, write, close — with a deadline that survives an open that never returns.
 *
 * `opened` is reported separately because it is the certainty boundary: nothing can have printed
 * before the descriptor existed.
 */
async function writeToDevice(
  device: string,
  bytes: Buffer,
  timeoutMs: number
): Promise<{ opened: boolean; wrote: boolean; error: NodeJS.ErrnoException | null; timedOut: boolean }> {
  const state = { opened: false, wrote: false, error: null as NodeJS.ErrnoException | null, timedOut: false };

  // O_NOCTTY: this process is a background service, and acquiring a controlling terminal from a
  // printer would make the printer able to send it signals.
  const opening = open(device, constants.O_WRONLY | constants.O_NOCTTY);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });

  const handle = await Promise.race([opening.then((h) => h), deadline]).catch((err: NodeJS.ErrnoException) => err);

  if (handle === 'timeout') {
    state.timedOut = true;
    // The open may still complete later. Close it when it does, or the descriptor leaks for the
    // life of the process and the port stays busy for every subsequent job.
    void opening.then((late) => late.close().catch(() => {})).catch(() => {});
    clearTimeout(timer);
    return state;
  }
  if (handle instanceof Error) {
    state.error = handle;
    clearTimeout(timer);
    return state;
  }

  state.opened = true;
  try {
    const written = await Promise.race([handle.write(bytes).then(() => 'done' as const), deadline]);
    if (written === 'timeout') state.timedOut = true;
    else state.wrote = true;
    // Flush before the descriptor goes away. A close alone can return while bytes are still in
    // the driver's buffer, and the next job's open then races them.
    if (state.wrote) await handle.datasync().catch(() => {});
  } catch (err) {
    state.error = err as NodeJS.ErrnoException;
  } finally {
    clearTimeout(timer);
    await handle.close().catch(() => {});
  }
  return state;
}

export const serialTransport: Transport = {
  kind: 'serial',

  // Unlike the spooler driver this stays true everywhere, including in a container: a serial
  // printer can be passed straight through with `--device=/dev/ttyUSB0`, so the honest answer is
  // "the driver works, ask a specific device whether it is there".
  isAvailable: () => true,

  async probe(printer, timeoutMs): Promise<ProbeResult> {
    if (!printer.device) return { reachable: false, latency_ms: null, detail: 'no device configured' };
    const device = normalizeDevicePath(printer.device);
    const startedAt = Date.now();

    // On Windows a COM path is not a filesystem entry, so existence has to be answered by trying
    // to configure it instead.
    if (!isWindows() && !existsSync(device)) {
      return { reachable: false, latency_ms: null, detail: `${device} is not present — is the printer plugged in and paired?` };
    }

    const problem = await configureLine(device, printer.baud ?? DEFAULT_BAUD, timeoutMs);
    return { reachable: problem === null, latency_ms: problem === null ? Date.now() - startedAt : null, detail: problem ?? undefined };
  },

  async send(printer, bytes, timeoutMs) {
    const startedAt = Date.now();
    if (!printer.device) return failed('device-missing', 'none', 'no device configured', startedAt);

    const device = normalizeDevicePath(printer.device);
    if (!isWindows() && !existsSync(device)) {
      return failed('device-missing', 'none', `${device} is not present`, startedAt);
    }

    // Best effort, and deliberately not checked: a port already at the right settings prints
    // fine, and failing the job over a cosmetic stty error would be a regression against doing
    // nothing at all.
    await configureLine(device, printer.baud ?? DEFAULT_BAUD, Math.min(timeoutMs, 2000));

    const result = await writeToDevice(device, bytes, timeoutMs);

    if (result.wrote) return succeeded(startedAt);
    if (result.timedOut) {
      // If the descriptor never opened nothing can have printed; if it did, some of the bytes may
      // already be on the paper.
      return result.opened
        ? failed('write-timeout', 'unknown', `${device} stopped accepting data`, startedAt)
        : failed('connect-timeout', 'none', `${device} did not open within ${timeoutMs}ms`, startedAt);
    }

    const code = result.error?.code;
    const detail = result.error?.message ?? 'the write failed';
    if (code === 'EBUSY' || code === 'EACCES' || code === 'EPERM') {
      return failed('device-busy', 'none', `${device} is held by another program (${code})`, startedAt);
    }
    if (code === 'ENOENT' || code === 'ENXIO' || code === 'ENODEV') {
      return failed('device-missing', 'none', `${device} is not present (${code})`, startedAt);
    }
    return failed(result.opened ? 'write-timeout' : 'unreachable', result.opened ? 'unknown' : 'none', detail, startedAt);
  },

  async discover(timeoutMs): Promise<DiscoveredPrinter[]> {
    const found: DiscoveredPrinter[] = [];
    const add = (device: string, detail?: string) =>
      found.push({ transport: 'serial', label: device, device, detail });

    if (isWindows()) {
      // The registry rather than PowerShell: this is one fast read with no CIM round trip, and it
      // lists ports whose driver did not register a WMI instance.
      const result = await runCommand('reg.exe',
        ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], { timeoutMs });
      if (result.ok) {
        for (const line of result.stdout.split(/\r?\n/)) {
          const match = /REG_SZ\s+(COM\d+)\s*$/.exec(line.trim());
          if (match?.[1]) add(match[1]);
        }
      }
      return found;
    }

    if (process.platform === 'darwin') {
      try {
        for (const entry of readdirSync('/dev')) {
          // Call-out devices only, and never the inbound Bluetooth listener or the debug console:
          // both are always present and neither is ever a printer.
          if (!entry.startsWith('cu.')) continue;
          if (entry === 'cu.Bluetooth-Incoming-Port' || entry.includes('debug-console')) continue;
          add(`/dev/${entry}`, entry.includes('.') && !entry.startsWith('cu.usb') ? 'bluetooth or usb serial' : 'usb serial');
        }
      } catch {
        /* /dev is unreadable — report nothing rather than fail discovery for every transport */
      }
      return found;
    }

    // Linux. `by-id` first: those names survive a replug, where `ttyUSB0` renumbers.
    try {
      for (const entry of readdirSync('/dev/serial/by-id')) add(`/dev/serial/by-id/${entry}`, 'stable name');
    } catch {
      /* no /dev/serial on this kernel or in this container */
    }
    try {
      for (const entry of readdirSync('/dev')) {
        if (/^(ttyUSB|ttyACM|rfcomm)\d+$/.test(entry)) {
          add(`/dev/${entry}`, entry.startsWith('rfcomm') ? 'bluetooth' : 'usb serial');
        }
      }
    } catch {
      /* unreadable /dev */
    }
    return found;
  },
};
