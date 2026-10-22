/*
 * One log emitter for the whole bridge.
 *
 * Two formats, because there are two readers and they want opposite things:
 *
 *  - An INSTALLED bridge writes to a file (`~/Library/Logs/hankha-print-bridge.log`,
 *    `%ProgramData%\Hankha\PrintBridge\logs\bridge.log`) and that file is the first thing support
 *    asks an operator to send when printing breaks. A shop owner has to be able to read it, so
 *    the default format is the same prose the bridge has always printed — with the structured
 *    fields appended in braces, because a venue's file is often the ONLY evidence there is.
 *  - A bridge running as a container ships its stdout to a log aggregator, where prose is
 *    unqueryable. `PRINT_BRIDGE_LOG_FORMAT=json` switches to one JSON object per line.
 *
 * Both carry the SAME fields; only the rendering differs. That is the point of routing every
 * message through here rather than calling `console.log` at the call site.
 *
 * Everything leaving this module passes through `sanitize`: credential-looking keys are redacted,
 * URLs lose their userinfo and secret query values, and in the text format every value is held to
 * one line so a stack trace or a hostile printer name cannot forge a log line of its own.
 */
import { loadEnv } from './env.js';
import { BRIDGE_SERVICE, BRIDGE_VERSION } from './version.js';

loadEnv();

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/*
 * Read once per call rather than cached in a module constant. `log.ts` is imported by nearly
 * everything, so a constant would freeze the level at whatever the first importer saw — and the
 * tests need to flip the format mid-process to assert both renderings.
 */
function configuredLevel(): LogLevel {
  const raw = process.env.PRINT_BRIDGE_LOG_LEVEL?.trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  // Quiet under `node --test`, which sets this itself. The queue and the relay narrate every job,
  // and interleaving that with the test reporter's own output makes a failure hard to find. An
  // explicit PRINT_BRIDGE_LOG_LEVEL still wins, which is how you get the narration back while
  // debugging one. Chosen over an env prefix in the npm script because that would not run on
  // Windows.
  return process.env.NODE_TEST_CONTEXT ? 'error' : 'info';
}

/** For call sites that would do real work only to build a debug line. */
export function logEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()];
}

function jsonFormat(): boolean {
  return process.env.PRINT_BRIDGE_LOG_FORMAT?.trim().toLowerCase() === 'json';
}

/**
 * Where this process runs, so one aggregator can hold more than one deployment. An explicit
 * `PRINT_BRIDGE_ENV` wins; otherwise a pod says `k8s` and everything else is a venue till.
 */
function environment(): string {
  const explicit = process.env.PRINT_BRIDGE_ENV?.trim();
  if (explicit) return explicit;
  return process.env.KUBERNETES_SERVICE_HOST ? 'k8s' : 'venue';
}

export interface LogFields {
  /** Dotted identifier, e.g. `queue.job.failed`. Stable across wording changes; query on this. */
  event?: string;
  /** An error to serialise into `error_*` / `cause_*` / `stack` fields. */
  err?: unknown;
  /**
   * False marks a failure nobody anticipated — a bug, not a printer that is switched off. Those
   * carry their stack. Expected failures (refused connections, 401s) do not; at debug level
   * every error does.
   */
  expected?: boolean;
  [key: string]: unknown;
}

/** One emitted line, after sanitising. What the test sink receives. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  event?: string;
  fields: Record<string, unknown>;
}

let sink: ((record: LogRecord) => void) | null = null;

/**
 * Route records to `fn` instead of stdout/stderr, and return the function that undoes it.
 * Exists for tests: the level filter still applies, so set `PRINT_BRIDGE_LOG_LEVEL` to capture
 * below `error` under `node --test`.
 */
export function setLogSink(fn: ((record: LogRecord) => void) | null): () => void {
  const previous = sink;
  sink = fn;
  return () => {
    sink = previous;
  };
}

// ---------------------------------------------------------------- sanitising

/** Keys whose VALUE is a credential, wherever they appear in a field tree. */
const SENSITIVE_KEY = /token|authorization|password|passwd|secret|api[_-]?key|cookie|pair(ing)?_?code/i;
const REDACTED = '[redacted]';
const MAX_STRING = 1000;
const MAX_DEPTH = 3;
const MAX_KEYS = 30;
const MAX_ITEMS = 20;

/**
 * A URL with its secrets removed: `user:pass@` goes, and so does the value of any query parameter
 * whose name looks like a credential. Anything that does not parse is returned unchanged.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key)) {
      url.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? url.toString() : raw;
}

function capString(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length} chars)` : value;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return capString(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? redactUrl(value) : value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return capString(value.message);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[array(${value.length})]` : '[object]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`…(${value.length - MAX_ITEMS} more)`);
    return items;
  }
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === undefined) continue;
    if (kept++ >= MAX_KEYS) {
      out['…'] = 'truncated';
      break;
    }
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(inner, depth + 1);
  }
  return out;
}

/**
 * The fields an error contributes to a record.
 *
 * `cause` matters more than it looks: a failed `fetch` says only "fetch failed", and the reason
 * a relay dropped (ECONNRESET, a DNS failure, a TLS error) lives one level down.
 */
export function serializeError(err: unknown, opts: { stack?: boolean } = {}): Record<string, unknown> {
  if (!(err instanceof Error)) {
    if (err === undefined || err === null) return {};
    if (typeof err === 'object') {
      const shaped = err as { message?: unknown; code?: unknown; name?: unknown };
      return {
        error_name: typeof shaped.name === 'string' ? shaped.name : undefined,
        error_message: typeof shaped.message === 'string' ? shaped.message : JSON.stringify(sanitize(err)),
        error_code: typeof shaped.code === 'string' || typeof shaped.code === 'number' ? shaped.code : undefined,
      };
    }
    return { error_message: String(err) };
  }
  const code = (err as NodeJS.ErrnoException).code;
  const out: Record<string, unknown> = {
    error_name: err.name,
    error_message: err.message,
    error_code: code,
  };
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    out.cause_name = cause.name;
    out.cause_message = cause.message;
    out.cause_code = (cause as NodeJS.ErrnoException).code;
  } else if (cause && typeof cause === 'object') {
    const shaped = cause as { message?: unknown; code?: unknown };
    if (typeof shaped.message === 'string') out.cause_message = shaped.message;
    if (typeof shaped.code === 'string' || typeof shaped.code === 'number') out.cause_code = shaped.code;
  } else if (cause !== undefined) {
    out.cause_message = String(cause);
  }
  if (opts.stack && err.stack) out.stack = err.stack;
  return out;
}

/** The most specific code an error carries, for one-word log fields and status strings. */
export function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const own = (err as { code?: unknown }).code;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  const pick = typeof cause?.code === 'string' ? cause.code : own;
  return typeof pick === 'string' || typeof pick === 'number' ? String(pick) : undefined;
}

// ---------------------------------------------------------------- rendering

/** Control characters out, line breaks escaped: one record is always one line. */
function oneLine(text: string): string {
  return text.replace(/\r?\n/g, '\\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quoting escapes line breaks and control characters on its own, so it is the one-line
    // guarantee for anything that needs quoting at all.
    return value === '' || /[\s"{}=\u0000-\u001f\u007f]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return oneLine(JSON.stringify(value) ?? String(value));
}

/**
 * `2026-10-22 13:46:57` in the computer's own clock — the time the shop owner reading the file
 * lives in, and the time on the launcher's `==== started ====` banner beside it.
 *
 * Without one, a log sent in by a venue could say WHAT happened but never WHEN: whether two
 * tickets went out a second apart or an hour apart, or which failure lined up with a complaint.
 */
export function localStamp(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ` +
    `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
  );
}

/**
 * `2026-10-22 13:46:57 WARN relay: … {event=relay.retry wait_ms=1000}`. Info lines carry no level
 * tag, so the prose a venue is used to reading starts exactly where it always did.
 */
export function renderText(record: LogRecord, at: Date): string {
  const tag = record.level === 'info' ? '' : `${record.level.toUpperCase()} `;
  const parts: string[] = [];
  if (record.event) parts.push(`event=${textValue(record.event)}`);
  for (const [key, value] of Object.entries(record.fields)) parts.push(`${key}=${textValue(value)}`);
  const suffix = parts.length > 0 ? ` {${parts.join(' ')}}` : '';
  return `${localStamp(at)} ${tag}${oneLine(record.msg)}${suffix}`;
}

const BASE_KEYS = new Set(['ts', 'level', 'service', 'version', 'env', 'pid', 'msg', 'event']);

export function renderJson(record: LogRecord): string {
  const out: Record<string, unknown> = {
    ts: record.ts,
    level: record.level,
    service: BRIDGE_SERVICE,
    version: BRIDGE_VERSION,
    env: environment(),
    pid: process.pid,
    msg: record.msg,
  };
  if (record.event) out.event = record.event;
  // A caller's field never overwrites the envelope: `level` or `msg` as a field name would
  // otherwise silently change what the aggregator files the line under.
  for (const [key, value] of Object.entries(record.fields)) out[BASE_KEYS.has(key) ? `field_${key}` : key] = value;
  return JSON.stringify(out);
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (!logEnabled(level)) return;

  const { event, err, expected, ...rest } = fields ?? {};
  const extra: Record<string, unknown> = { ...rest };
  if (err !== undefined) {
    Object.assign(extra, serializeError(err, { stack: expected === false || logEnabled('debug') }));
  }
  if (expected === false) extra.expected = false;

  const clean = sanitize(extra) as Record<string, unknown>;
  const now = new Date();
  const record: LogRecord = {
    ts: now.toISOString(),
    level,
    msg: capString(message),
    ...(typeof event === 'string' ? { event } : {}),
    fields: clean,
  };

  if (sink) {
    sink(record);
    return;
  }

  // warn/error to stderr, everything else to stdout — unchanged from the console.* calls this
  // replaced, and what lets a service wrapper separate the two streams.
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${jsonFormat() ? renderJson(record) : renderText(record, now)}\n`);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

// ---------------------------------------------------------------- repeat suppression

export interface GatePass {
  /** Occurrences swallowed since the last one that was let through. */
  repeated: number;
  /** How long those occurrences spanned. */
  over_ms: number;
}

/**
 * Lets the first of a run of identical events through, counts the rest, and lets one through
 * again (with the count) once per window.
 *
 * A bridge with a revoked token used to write the same 401 every 30 seconds for hours — a venue
 * log of hundreds of identical lines where the one line that mattered, the pairing just before,
 * was buried. With a gate the file says it once, then "…repeated 118 times over 59 min".
 */
export class LogGate {
  private readonly runs = new Map<string, { since: number; lastLoggedAt: number; suppressed: number }>();

  constructor(private readonly windowMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

  /** Null when this occurrence should be swallowed; otherwise what was swallowed before it. */
  hit(key: string): GatePass | null {
    const at = this.now();
    const run = this.runs.get(key);
    if (!run) {
      this.runs.set(key, { since: at, lastLoggedAt: at, suppressed: 0 });
      return { repeated: 0, over_ms: 0 };
    }
    if (at - run.lastLoggedAt < this.windowMs) {
      run.suppressed += 1;
      return null;
    }
    const pass = { repeated: run.suppressed, over_ms: at - run.since };
    run.lastLoggedAt = at;
    run.suppressed = 0;
    return pass;
  }

  /**
   * End a run — the condition cleared. Returns what the run swallowed since its last logged line,
   * for the recovery message, or null when there was no run.
   */
  clear(key: string): GatePass | null {
    const run = this.runs.get(key);
    if (!run) return null;
    this.runs.delete(key);
    return { repeated: run.suppressed, over_ms: this.now() - run.since };
  }

  active(key: string): boolean {
    return this.runs.has(key);
  }
}
