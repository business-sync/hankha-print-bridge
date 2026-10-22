import { log, LogGate } from './log.js';
import { queue } from './queue.js';
import { loadRegistry } from './registry.js';
import { relayDiagnostics } from './relay.js';
import { markTick, tickReport } from './ticks.js';

/**
 * Periodic proof that a long-running bridge is still healthy — and the numbers to explain it
 * when it is not.
 *
 * The failures that only show up after hours (a slow leak, an event loop starved by something,
 * a background timer that quietly stopped, a link that is "connected" but carries nothing) leave
 * no line of their own. A snapshot every few minutes turns "it stopped some time this afternoon"
 * into a line-by-line account of memory, loop lag, relay state and queue depth leading up to it.
 *
 * Cheap on purpose: one 500 ms timer measuring its own drift, and one line per interval.
 */

const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_LAG_WARN_MS = 1000;
const SAMPLE_MS = 500;
/** Enough drift samples for a p99 over a 15-minute window at the 500 ms sample rate. */
const MAX_SAMPLES = 2000;

/** `PRINT_BRIDGE_DIAG_INTERVAL_MIN`: default 15, `0` turns the periodic line off. */
export function diagIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRINT_BRIDGE_DIAG_INTERVAL_MIN?.trim();
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MIN * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60_000) : DEFAULT_INTERVAL_MIN * 60_000;
}

/** `PRINT_BRIDGE_DIAG_LAG_WARN_MS`: loop lag above this is logged as a warning. */
export function lagWarnMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PRINT_BRIDGE_DIAG_LAG_WARN_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LAG_WARN_MS;
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Event-loop lag, measured as how late a fixed-interval timer fires.
 *
 * `perf_hooks.monitorEventLoopDelay` would be more precise, but the shipped binary is built by
 * Bun, and a diagnostic that might be missing in the one build that matters is no diagnostic.
 * Drift is crude and portable, and lag worth worrying about is hundreds of milliseconds anyway.
 */
class LagSampler {
  private timer: NodeJS.Timeout | undefined;
  private expected = 0;
  private samples: number[] = [];
  private max = 0;

  constructor(
    private readonly sampleMs: number,
    private readonly warnMs: number,
    private readonly gate: LogGate
  ) {}

  start(): void {
    this.expected = Date.now() + this.sampleMs;
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  private sample(): void {
    const now = Date.now();
    const lag = Math.max(0, now - this.expected);
    this.expected = now + this.sampleMs;
    markTick('diag.sampler', this.sampleMs, now);
    this.max = Math.max(this.max, lag);
    this.samples.push(lag);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    if (lag > this.warnMs) {
      const pass = this.gate.hit('diag.event_loop_lag');
      if (pass) {
        log.warn(`diag: the event loop was blocked for ${lag}ms`, {
          event: 'diag.event_loop_lag', lag_ms: lag, warn_ms: this.warnMs, repeated: pass.repeated || undefined,
        });
      }
    }
  }

  /** Max and p99 since the last call, then start a fresh window. */
  take(): { lag_max_ms: number; lag_p99_ms: number } | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
    const out = { lag_max_ms: this.max, lag_p99_ms: p99 };
    this.samples = [];
    this.max = 0;
    return out;
  }
}

export interface DiagSnapshot {
  uptime_s: number;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  rss_delta_mb?: number;
  lag_max_ms?: number;
  lag_p99_ms?: number;
  relay_connected: boolean;
  relay_transport: string | null;
  relay_connection_id?: string;
  relay_session_ms?: number;
  relay_since_frame_ms?: number;
  relay_since_poll_ok_ms?: number;
  relay_since_heartbeat_ok_ms?: number;
  relay_down_ms?: number;
  relay_failures: number;
  relay_heartbeat_failures: number;
  relay_reconnects_last_hour: number;
  queue_pending: number;
  queue_printing: number;
  printers: number;
  stalled_timers?: string[];
}

let sampler: LagSampler | null = null;
let lastRssMb: number | null = null;

/**
 * Everything worth knowing about this process right now. Flat, so the text log stays readable.
 * `takeLag` starts a new lag window; `/status` reads without it so polling the page does not
 * reset what the periodic line reports.
 */
export function collectSnapshot(opts: { takeLag?: boolean } = {}): DiagSnapshot {
  const mem = process.memoryUsage();
  const relay = relayDiagnostics();
  const depth = queue().depth();
  const lag = opts.takeLag ? sampler?.take() : null;
  const rss = mb(mem.rss);
  const stalled = tickReport()
    .filter((t) => t.stalled)
    .map((t) => t.name);
  const optional = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);
  return {
    uptime_s: Math.round(process.uptime()),
    rss_mb: rss,
    heap_used_mb: mb(mem.heapUsed),
    heap_total_mb: mb(mem.heapTotal),
    external_mb: mb(mem.external),
    rss_delta_mb: opts.takeLag && lastRssMb !== null ? Math.round((rss - lastRssMb) * 10) / 10 : undefined,
    lag_max_ms: lag?.lag_max_ms,
    lag_p99_ms: lag?.lag_p99_ms,
    relay_connected: relay.connected,
    relay_transport: relay.transport,
    relay_connection_id: optional(relay.connection_id),
    relay_session_ms: optional(relay.session_ms),
    relay_since_frame_ms: optional(relay.since_last_frame_ms),
    relay_since_poll_ok_ms: optional(relay.since_poll_ok_ms),
    relay_since_heartbeat_ok_ms: optional(relay.since_heartbeat_ok_ms),
    relay_down_ms: optional(relay.down_ms),
    relay_failures: relay.failures,
    relay_heartbeat_failures: relay.heartbeat_failures,
    relay_reconnects_last_hour: relay.reconnects_last_hour,
    queue_pending: queue().pending(),
    queue_printing: depth.printing,
    printers: loadRegistry().printers.length,
    stalled_timers: stalled.length > 0 ? stalled : undefined,
  };
}

function hours(seconds: number): string {
  return seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
}

export interface Diagnostics {
  /** Log one snapshot now (what the timer does). Returns it, for tests. */
  logSnapshot(): DiagSnapshot;
  stop(): void;
}

export function startDiagnostics(
  opts: { intervalMs?: number; sampleMs?: number; lagWarnMs?: number } = {}
): Diagnostics {
  const intervalMs = opts.intervalMs ?? diagIntervalMs();
  const gate = new LogGate(10 * 60_000);
  sampler?.stop();
  sampler = new LagSampler(opts.sampleMs ?? SAMPLE_MS, opts.lagWarnMs ?? lagWarnMs(), gate);
  sampler.start();

  const logSnapshot = (): DiagSnapshot => {
    const snap = collectSnapshot({ takeLag: true });
    lastRssMb = snap.rss_mb;
    const relayWord = snap.relay_connected ? `connected over ${snap.relay_transport}` : 'not connected';
    log.info(
      `diag: up ${hours(snap.uptime_s)}, ${snap.rss_mb} MB memory, loop lag max ${snap.lag_max_ms ?? '?'}ms, ` +
        `relay ${relayWord}, ${snap.queue_pending} job(s) pending`,
      { event: 'diag.snapshot', ...snap }
    );
    for (const name of snap.stalled_timers ?? []) {
      const tick = tickReport().find((t) => t.name === name);
      const pass = gate.hit(`diag.timer_stalled:${name}`);
      if (pass && tick) {
        log.warn(`diag: background timer ${name} has not run for ${Math.round(tick.since_ms / 1000)}s`, {
          event: 'diag.timer_stalled', timer: name, since_ms: tick.since_ms, interval_ms: tick.interval_ms,
        });
      }
    }
    return snap;
  };

  let timer: NodeJS.Timeout | undefined;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      markTick('diag.snapshot', intervalMs);
      logSnapshot();
    }, intervalMs);
    timer.unref();
  }

  return {
    logSnapshot,
    stop: () => {
      clearInterval(timer);
      sampler?.stop();
      sampler = null;
    },
  };
}

/** Whether the lag sampler is live. Tests only. */
export function diagnosticsRunning(): boolean {
  return sampler?.running ?? false;
}
