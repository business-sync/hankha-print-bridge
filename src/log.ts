/*
 * One log emitter for the whole bridge.
 *
 * Two formats, because there are two readers and they want opposite things:
 *
 *  - An INSTALLED bridge writes to a file (`~/Library/Logs/hankha-print-bridge.log`,
 *    `%ProgramData%\Hankha\PrintBridge\logs\bridge.log`) and that file is the first thing support
 *    asks an operator to send when printing breaks. A shop owner has to be able to read it, so
 *    the default format is the same prose the bridge has always printed.
 *  - A bridge running as a container ships its stdout to a log aggregator, where prose is
 *    unqueryable. `PRINT_BRIDGE_LOG_FORMAT=json` switches to one JSON object per line.
 *
 * Both carry the SAME fields; only the rendering differs. That is the point of routing every
 * message through here rather than calling `console.log` at the call site: the structured fields
 * exist even when nobody is reading them as JSON, so turning the env var on in a broken venue
 * yields queryable logs without a code change.
 */
import { loadEnv } from './env.js';

loadEnv();

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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

function jsonFormat(): boolean {
  return process.env.PRINT_BRIDGE_LOG_FORMAT?.trim().toLowerCase() === 'json';
}

/*
 * Read once per call rather than cached in a module constant. `log.ts` is imported by nearly
 * everything, so a constant would freeze the level at whatever the first importer saw — and the
 * tests need to flip the format mid-process to assert both renderings.
 */
export interface LogFields {
  /** Dotted identifier, e.g. `queue.job.failed`. Stable across wording changes; query on this. */
  event?: string;
  [key: string]: unknown;
}

/**
 * An `Error` serialises to `{}` through `JSON.stringify`, which silently turns the one field that
 * mattered into nothing. Unwrap it to a message before it reaches the encoder.
 */
function plain(value: unknown): unknown {
  if (value instanceof Error) return value.message;
  return value;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;

  // warn/error to stderr, everything else to stdout — unchanged from the console.* calls this
  // replaced, and what lets a service wrapper separate the two streams.
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;

  if (!jsonFormat()) {
    stream.write(`${message}\n`);
    return;
  }

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    record[key] = plain(value);
  }
  stream.write(`${JSON.stringify(record)}\n`);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
