/*
 * The USB driver — implemented by handing the bytes to the operating system's own print spooler
 * in RAW mode, not by talking to the USB bus.
 *
 * Why not libusb: the shipped bridge is a `bun build --compile` binary cross-compiled for
 * darwin-arm64, darwin-x64 and windows-x64 from a single macOS machine, and it also builds as a
 * `node:22-slim` container. A native N-API addon (`usb`, `node-hid`) is a per-platform artifact —
 * it cannot be cross-compiled, so adopting one would mean three CI runners and a different
 * shipping story for the whole app, to reach hardware the OS is already holding open.
 *
 * Going through the spooler instead costs one thing and buys three. It costs endpoint-level
 * control — no bulk-transfer tuning, and no reading status back from the printer. It buys: the
 * driver the vendor already installed, printers shared over a network queue for free, and an
 * install that needs no elevated USB permissions on either platform.
 *
 *   macOS / Linux   `lp -d <queue> -o raw -`, bytes on stdin. CUPS is present on both.
 *   Windows         OpenPrinter / StartDocPrinter("RAW") / WritePrinter through winspool.drv,
 *                   driven by a PowerShell shim. No compiler, no addon, no admin rights.
 *
 * The honest limit, stated once here because it drives `printed_certainty` below: a spooler
 * ACCEPTS a job. It does not tell you the printer was on. So a successful send means "the queue
 * took it", and any failure after that point has to be `unknown`.
 */
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrinterRecord } from '../registry.js';
import { commandExists, runCommand } from './exec.js';
import { failed, succeeded, type DiscoveredPrinter, type ProbeResult, type Transport } from './transport.js';

const isWindows = (): boolean => process.platform === 'win32';

/**
 * The Windows raw-print shim.
 *
 * Written to a temp `.ps1` and run with `-File` rather than passed through `-Command`: the script
 * contains quotes, braces and a C# block, and quoting that through `spawn` -> `CreateProcess` ->
 * PowerShell's own parser is three chances to corrupt it, on a platform this project cannot test
 * from its build machine.
 *
 * `StartDocPrinter` with datatype RAW is what stops the spooler putting the bytes through a
 * printer driver — ESC/POS reaching a GDI driver comes out as pages of mojibake.
 */
const WINDOWS_RAW_PS1 = `
param([Parameter(Mandatory=$true)][string]$PrinterName, [Parameter(Mandatory=$true)][string]$PayloadPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HankhaRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
}
'@
$bytes = [System.IO.File]::ReadAllBytes($PayloadPath)
$handle = [IntPtr]::Zero
if (-not [HankhaRawPrinter]::OpenPrinter($PrinterName, [ref]$handle, [IntPtr]::Zero)) {
  [Console]::Error.Write('OPEN_FAILED ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 2
}
$doc = New-Object HankhaRawPrinter+DOCINFOW
$doc.pDocName = 'Hankha print job'
$doc.pDataType = 'RAW'
$unmanaged = [IntPtr]::Zero
try {
  if (-not [HankhaRawPrinter]::StartDocPrinter($handle, 1, $doc)) {
    [Console]::Error.Write('OPEN_FAILED ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
    exit 2
  }
  [void][HankhaRawPrinter]::StartPagePrinter($handle)
  $unmanaged = [System.Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $unmanaged, $bytes.Length)
  $written = 0
  $wrote = [HankhaRawPrinter]::WritePrinter($handle, $unmanaged, $bytes.Length, [ref]$written)
  [void][HankhaRawPrinter]::EndPagePrinter($handle)
  [void][HankhaRawPrinter]::EndDocPrinter($handle)
  if (-not $wrote -or $written -ne $bytes.Length) {
    [Console]::Error.Write('WRITE_FAILED wrote=' + $written + ' of ' + $bytes.Length)
    exit 3
  }
} finally {
  if ($unmanaged -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeCoTaskMem($unmanaged) }
  [void][HankhaRawPrinter]::ClosePrinter($handle)
}
exit 0
`;

/** `lp` on CUPS, `powershell` on Windows. Named once so the error messages can say which. */
function requiredCommand(): string {
  return isWindows() ? 'powershell.exe' : 'lp';
}

/**
 * CUPS says "The printer or class does not exist" for a bad queue. Distinguishing that from a
 * spooler that merely refused the job is what turns a support call into a settings fix.
 */
function looksMissing(text: string): boolean {
  return /does not exist|unknown destination|no such|cannot find|not found/i.test(text);
}

async function sendViaCups(printer: PrinterRecord, bytes: Buffer, timeoutMs: number, startedAt: number) {
  const queue = printer.queue ?? '';
  const result = await runCommand(
    'lp',
    // `-o raw` is load-bearing: without it CUPS runs the job through the queue's filter chain and
    // ESC/POS control codes come out as printed text. `-` reads the document from stdin.
    ['-d', queue, '-o', 'raw', '-t', `hankha-${printer.id}`, '-'],
    { timeoutMs, input: bytes }
  );

  if (result.spawnError) {
    return failed('not-supported', 'none', `lp is not installed (${result.spawnError.code ?? 'ENOENT'})`, startedAt);
  }
  if (result.timedOut) {
    // `lp` was killed after it had already read some of the document. It may or may not have
    // submitted a job, and CUPS will not be asked twice.
    return failed('write-timeout', 'unknown', `lp did not finish within ${timeoutMs}ms`, startedAt);
  }
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim() || `lp exited ${result.code}`;
    // CUPS accepts a job atomically: it either creates one and prints "request id is ...", or it
    // creates nothing. A non-zero exit therefore means nothing was queued, which is the one
    // failure class a retry is provably safe for.
    return failed(looksMissing(detail) ? 'device-missing' : 'spooler-error', 'none', detail, startedAt);
  }
  return succeeded(startedAt);
}

async function sendViaWinspool(printer: PrinterRecord, bytes: Buffer, timeoutMs: number, startedAt: number) {
  const stem = join(tmpdir(), `hankha-print-${randomUUID()}`);
  const scriptPath = `${stem}.ps1`;
  const payloadPath = `${stem}.bin`;

  // Through a file rather than stdin. A 1 MiB raster on stdin has to survive PowerShell's own
  // encoding of the pipe, which mangles anything that is not text; a file is bytes either way.
  try {
    writeFileSync(scriptPath, WINDOWS_RAW_PS1);
    writeFileSync(payloadPath, bytes);
  } catch (err) {
    return failed('spooler-error', 'none', `could not stage the job: ${err instanceof Error ? err.message : String(err)}`, startedAt);
  }

  try {
    const result = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
       '-PrinterName', printer.queue ?? '', '-PayloadPath', payloadPath],
      { timeoutMs }
    );

    if (result.spawnError) {
      return failed('not-supported', 'none', 'powershell.exe is not available', startedAt);
    }
    if (result.timedOut) {
      return failed('write-timeout', 'unknown', `the spooler did not finish within ${timeoutMs}ms`, startedAt);
    }
    if (result.ok) return succeeded(startedAt);

    const detail = (result.stderr || result.stdout).trim() || `exited ${result.code}`;
    // OPEN_FAILED means the document was never started, so nothing reached the spooler.
    // WRITE_FAILED means StartDocPrinter succeeded and a partial job may be sitting in the queue —
    // unknown, and never retried automatically.
    if (detail.startsWith('OPEN_FAILED')) {
      return failed('device-missing', 'none', `cannot open printer '${printer.queue}' (${detail})`, startedAt);
    }
    if (detail.startsWith('WRITE_FAILED')) {
      return failed('spooler-error', 'unknown', detail, startedAt);
    }
    return failed('spooler-error', 'none', detail, startedAt);
  } finally {
    rmSync(scriptPath, { force: true });
    rmSync(payloadPath, { force: true });
  }
}

export const spoolerTransport: Transport = {
  kind: 'usb',

  // False inside a container, where `lp` is not installed — which is exactly right: the k8s
  // deployment has no printers attached and should say so rather than fail every job at send time.
  isAvailable: () => commandExists(requiredCommand()),

  async probe(printer, timeoutMs): Promise<ProbeResult> {
    if (!spoolerTransport.isAvailable()) {
      return { reachable: false, latency_ms: null, detail: `${requiredCommand()} is not available on this machine` };
    }
    if (!printer.queue) return { reachable: false, latency_ms: null, detail: 'no queue configured' };

    const startedAt = Date.now();
    const result = isWindows()
      ? await runCommand('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `Get-Printer -Name '${printer.queue.replace(/'/g, "''")}' | Out-Null`],
          { timeoutMs })
      : await runCommand('lpstat', ['-p', printer.queue], { timeoutMs });

    if (result.spawnError) return { reachable: false, latency_ms: null, detail: 'the spooler could not be queried' };
    if (result.timedOut) return { reachable: false, latency_ms: null, detail: 'the spooler did not answer' };
    if (!result.ok) return { reachable: false, latency_ms: null, detail: `no queue named '${printer.queue}'` };

    // A CUPS queue that exists but is stopped still accepts jobs — they just sit there. Worth
    // saying, because "printing works but nothing comes out" is otherwise unexplainable.
    const disabled = /\bdisabled\b/i.test(result.stdout);
    return {
      reachable: true,
      latency_ms: Date.now() - startedAt,
      detail: disabled ? 'the queue is paused — jobs will be held, not printed' : undefined,
    };
  },

  async send(printer, bytes, timeoutMs) {
    const startedAt = Date.now();
    if (!printer.queue) return failed('device-missing', 'none', 'no queue configured', startedAt);
    if (!spoolerTransport.isAvailable()) {
      return failed('not-supported', 'none', `${requiredCommand()} is not available on this machine`, startedAt);
    }
    return isWindows()
      ? sendViaWinspool(printer, bytes, timeoutMs, startedAt)
      : sendViaCups(printer, bytes, timeoutMs, startedAt);
  },

  async discover(timeoutMs): Promise<DiscoveredPrinter[]> {
    if (!spoolerTransport.isAvailable()) return [];

    if (isWindows()) {
      const result = await runCommand('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
         'Get-Printer | Select-Object Name,PortName,DriverName | ConvertTo-Json -Compress'],
        { timeoutMs });
      if (!result.ok) return [];
      try {
        const parsed = JSON.parse(result.stdout || '[]') as unknown;
        // ConvertTo-Json emits a bare object, not an array, when there is exactly one printer.
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows
          .filter((row): row is { Name: string; PortName?: string; DriverName?: string } =>
            Boolean(row) && typeof (row as { Name?: unknown }).Name === 'string')
          .map((row) => ({
            transport: 'usb' as const,
            label: row.Name,
            queue: row.Name,
            detail: [row.DriverName, row.PortName].filter(Boolean).join(' · ') || undefined,
          }));
      } catch {
        return [];
      }
    }

    const result = await runCommand('lpstat', ['-p'], { timeoutMs });
    if (result.spawnError || result.timedOut) return [];
    const printers: DiscoveredPrinter[] = [];
    // `printer <name> is idle.  enabled since ...` — the one line format that has been stable
    // across every CUPS version this will meet.
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^printer\s+(\S+)\s+is\s+(\w+)/.exec(line.trim());
      if (!match?.[1]) continue;
      printers.push({
        transport: 'usb',
        label: match[1],
        queue: match[1],
        detail: match[2],
      });
    }
    return printers;
  },
};
