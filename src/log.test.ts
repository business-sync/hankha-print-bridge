import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  errorCode,
  localStamp,
  log,
  LogGate,
  type LogRecord,
  redactUrl,
  renderJson,
  renderText,
  serializeError,
  setLogSink,
} from './log.js';

describe('localStamp', () => {
  /*
   * The plain log is what a venue sends in when printing breaks, and without a time on each line
   * it could say what happened but never when.
   */
  it('renders the local clock, zero-padded, to the second', () => {
    assert.equal(localStamp(new Date(2026, 0, 5, 7, 3, 9)), '2026-01-05 07:03:09');
    assert.equal(localStamp(new Date(2026, 9, 22, 13, 46, 56)), '2026-10-22 13:46:56');
  });
});

/** Capture what the logger emits, at whatever level the test sets. */
function capture(level = 'debug') {
  const records: LogRecord[] = [];
  const previous = process.env.PRINT_BRIDGE_LOG_LEVEL;
  process.env.PRINT_BRIDGE_LOG_LEVEL = level;
  const restore = setLogSink((record) => records.push(record));
  return {
    records,
    done: () => {
      restore();
      if (previous === undefined) delete process.env.PRINT_BRIDGE_LOG_LEVEL;
      else process.env.PRINT_BRIDGE_LOG_LEVEL = previous;
    },
  };
}

describe('levels', () => {
  it('drops records below the configured level and keeps the rest', () => {
    const c = capture('warn');
    try {
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      assert.deepEqual(c.records.map((r) => r.level), ['warn', 'error']);
    } finally {
      c.done();
    }
  });

  it('turns debug on with nothing but the environment variable', () => {
    const c = capture('debug');
    try {
      log.debug('now visible', { event: 'test.debug' });
      assert.equal(c.records.length, 1);
      assert.equal(c.records[0]?.event, 'test.debug');
    } finally {
      c.done();
    }
  });
});

describe('rendering', () => {
  const at = new Date(2026, 9, 22, 18, 49, 10);
  const record = (over: Partial<LogRecord> = {}): LogRecord => ({
    ts: at.toISOString(), level: 'info', msg: 'queue: job 7 printed on bill in 2ms',
    event: 'queue.done', fields: { job_id: '7', duration_ms: 2 }, ...over,
  });

  /*
   * Fields used to be dropped entirely in text mode — the format every installed bridge uses — so
   * the one log that reaches support carried none of the structured data.
   */
  it('keeps the prose of an info line and appends the fields', () => {
    assert.equal(
      renderText(record(), at),
      '2026-10-22 18:49:10 queue: job 7 printed on bill in 2ms {event=queue.done job_id=7 duration_ms=2}'
    );
  });

  it('tags non-info lines with their level', () => {
    assert.match(renderText(record({ level: 'warn' }), at), /^2026-10-22 18:49:10 WARN queue:/);
  });

  it('holds every value and the message to one line', () => {
    const line = renderText(
      record({ msg: 'line one\nline two', fields: { stack: 'Error: x\n    at a\n    at b', name: 'a "quoted" {name}' } }),
      at
    );
    assert.equal(line.includes('\n'), false);
    assert.match(line, /line one\\nline two/);
    assert.match(line, /stack="Error: x\\n {4}at a\\n {4}at b"/);
    assert.match(line, /name="a \\"quoted\\" \{name\}"/);
  });

  it('emits the agreed JSON envelope, keeping the existing ts/msg keys', () => {
    const parsed = JSON.parse(renderJson(record())) as Record<string, unknown>;
    assert.equal(parsed.msg, 'queue: job 7 printed on bill in 2ms');
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.event, 'queue.done');
    assert.equal(parsed.service, 'hankha-print-bridge');
    assert.equal(typeof parsed.ts, 'string');
    assert.equal(typeof parsed.pid, 'number');
    assert.ok('version' in parsed && 'env' in parsed);
    assert.equal(parsed.job_id, '7');
  });

  it('never lets a field overwrite the JSON envelope', () => {
    const parsed = JSON.parse(renderJson(record({ fields: { level: 'spoofed', msg: 'spoofed' } }))) as Record<string, unknown>;
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.field_level, 'spoofed');
    assert.equal(parsed.field_msg, 'spoofed');
  });
});

describe('errors', () => {
  it('serialises name, message, code and the cause behind "fetch failed"', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const err = new TypeError('fetch failed', { cause });
    const out = serializeError(err, { stack: true });
    assert.equal(out.error_name, 'TypeError');
    assert.equal(out.error_message, 'fetch failed');
    assert.equal(out.cause_code, 'ECONNRESET');
    assert.equal(out.cause_message, 'read ECONNRESET');
    assert.match(String(out.stack), /TypeError: fetch failed/);
    assert.equal(errorCode(err), 'ECONNRESET');
  });

  it('includes the stack for an unexpected error, and leaves it off an expected one at info', () => {
    const c = capture('info');
    try {
      log.error('boom', { event: 'test.unexpected', err: new Error('bug'), expected: false });
      log.warn('refused', { event: 'test.expected', err: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
      const [unexpected, expected] = c.records;
      assert.match(String(unexpected?.fields.stack), /Error: bug/);
      assert.equal(unexpected?.fields.expected, false);
      assert.equal(expected?.fields.stack, undefined);
      assert.equal(expected?.fields.error_code, 'ECONNREFUSED');
    } finally {
      c.done();
    }
  });

  it('copes with a thrown non-Error', () => {
    assert.deepEqual(serializeError('just a string'), { error_message: 'just a string' });
    assert.deepEqual(serializeError(undefined), {});
  });
});

describe('redaction', () => {
  it('redacts credential-looking keys at any depth', () => {
    const c = capture();
    try {
      log.info('x', {
        event: 'test.redact',
        token: 'secret-token-value',
        headers: { Authorization: 'Bearer abc', 'x-api-key': 'k' },
        nested: { deeper: { password: 'p', pair_code: 'PSPN-VHP6' } },
        auth_required: true,
      });
      const fields = c.records[0]?.fields ?? {};
      const flat = JSON.stringify(fields);
      for (const secret of ['secret-token-value', 'Bearer abc', 'PSPN-VHP6']) {
        assert.equal(flat.includes(secret), false, `${secret} leaked`);
      }
      assert.equal(fields.token, '[redacted]');
      assert.equal(fields.auth_required, true, 'a boolean about auth is not itself a secret');
    } finally {
      c.done();
    }
  });

  it('strips userinfo and secret query values from URLs, wherever they appear as a value', () => {
    assert.equal(redactUrl('https://user:pw@api.hankha.la/x?token=abc&wait=25'), 'https://api.hankha.la/x?token=%5Bredacted%5D&wait=25');
    assert.equal(redactUrl('https://api.hankha.la'), 'https://api.hankha.la');
    assert.equal(redactUrl('not a url'), 'not a url');
    const c = capture();
    try {
      log.info('x', { relay_url: 'https://bob:hunter2@api.hankha.la' });
      assert.equal(String(c.records[0]?.fields.relay_url).includes('hunter2'), false);
    } finally {
      c.done();
    }
  });

  it('caps long strings so one value cannot flood the file', () => {
    const c = capture();
    try {
      log.info('x', { detail: 'a'.repeat(5000) });
      assert.ok(String(c.records[0]?.fields.detail).length < 1100);
    } finally {
      c.done();
    }
  });
});

describe('LogGate', () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000_000;
  });
  afterEach(() => undefined);

  /*
   * A revoked token logged the same 401 every 30 s for hours. The gate lets the first through,
   * counts the rest, and reports the count once per window and on recovery.
   */
  it('lets the first through, swallows repeats inside the window, then reports the count', () => {
    const gate = new LogGate(60_000, () => now);
    assert.deepEqual(gate.hit('hb'), { repeated: 0, over_ms: 0 });
    now += 30_000;
    assert.equal(gate.hit('hb'), null);
    now += 20_000;
    assert.equal(gate.hit('hb'), null);
    now += 20_000;
    assert.deepEqual(gate.hit('hb'), { repeated: 2, over_ms: 70_000 });
  });

  it('reports what a run swallowed when it clears, and starts fresh afterwards', () => {
    const gate = new LogGate(60_000, () => now);
    gate.hit('hb');
    now += 1000;
    gate.hit('hb');
    now += 1000;
    assert.deepEqual(gate.clear('hb'), { repeated: 1, over_ms: 2000 });
    assert.equal(gate.active('hb'), false);
    assert.deepEqual(gate.hit('hb'), { repeated: 0, over_ms: 0 });
    assert.equal(gate.clear('never-seen'), null);
  });

  it('keeps separate runs per key', () => {
    const gate = new LogGate(60_000, () => now);
    assert.ok(gate.hit('a'));
    assert.ok(gate.hit('b'));
    assert.equal(gate.hit('a'), null);
  });
});
