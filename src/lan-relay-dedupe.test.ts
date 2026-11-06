import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { saveState } from './identity.js';
import { setLogSink } from './log.js';
import { queue } from './queue.js';
import { handlePrint } from './relay.js';
import { jobBody, LanHarness, receiptDoc } from './test-support/lan-harness.js';

/*
 * One job, two doors. The terminal may send a slip over the LAN and, not hearing back, ask the
 * backend to send the same key through the relay. Whichever arrives second is ANSWERED, and the
 * printer is written to once.
 *
 * Uses the process-wide queue — the one `handlePrint` submits to — with the network transport aimed
 * at a fake 9100 printer that counts what it is sent.
 */

const BASE = 'http://relay.test';
const TOKEN = 'dedupe-secret';
type PrintWork = Parameters<typeof handlePrint>[2];

let h: LanHarness;
let hold: Promise<void> | undefined;
let restoreLog: (() => void) | null = null;
let fetchMock: { mock: { restore(): void } };
const posts: { id: string; body: Record<string, any> }[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  restoreLog = setLogSink(() => undefined);
  h = await LanHarness.start({ globalQueue: true, gate: () => hold });
  saveState({ install_id: 'install-test-0001', bridge_id: '77', token: 'bridge-token' });
  fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(BASE)) return realFetch(input as string, init);
    posts.push({ id: url.split('/jobs/')[1]?.split('/')[0] ?? url, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(null, { status: 200 });
  });
});
after(async () => {
  fetchMock.mock.restore();
  await h.stop();
  restoreLog?.();
});
beforeEach(() => {
  posts.length = 0;
  hold = undefined;
});
afterEach(async () => {
  hold = undefined;
  await h.idle(8_000).catch(() => undefined);
});

let n = 0;
function relayFrame(key: string | undefined, marker: string, extra: Record<string, unknown> = {}): PrintWork {
  n += 1;
  return {
    type: 'print',
    job: {
      job_id: `server-job-${n}`,
      client_job_id: `client-${n}`,
      printer_id: 'receipt',
      kind: 'RECEIPT',
      target_ip: null,
      target_port: 9100,
      document: receiptDoc(marker),
      payload_sha256: '0'.repeat(64),
      attempt: 1,
      claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
      ...(key ? { dedupe_key: key } : {}),
      ...extra,
    },
  } as PrintWork;
}

const reported = (id: string) => posts.find((p) => p.id === id);
async function untilReported(id: string): Promise<Record<string, any>> {
  await h.until(() => Boolean(reported(id)));
  await h.printer.quiet();
  return (reported(id) as { body: Record<string, any> }).body;
}

describe('the same key by the LAN and by the relay', () => {
  it('LAN first, relay second: prints once, and the relay is told the first outcome', async () => {
    const lan = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-5000-r0', 'LAN-THEN-RELAY'));
    assert.equal(lan.status, 202);
    await h.idle();
    const frame = relayFrame('sale-5000-r0', 'LAN-THEN-RELAY');
    await handlePrint(BASE, TOKEN, frame);
    const result = await untilReported(frame.type === 'print' ? frame.job.job_id : '');
    assert.equal(result.ok, true, 'reported as done: it was');
    assert.equal(h.printer.count('LAN-THEN-RELAY'), 1);
    assert.equal(h.printer.connections, 1);
  });

  it('relay first, LAN second: prints once, and the LAN send is answered', async () => {
    const frame = relayFrame('sale-5001-r0', 'RELAY-THEN-LAN');
    await handlePrint(BASE, TOKEN, frame);
    await untilReported((frame as any).job.job_id);
    const lan = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-5001-r0', 'RELAY-THEN-LAN'));
    assert.equal(lan.status, 202);
    assert.equal(lan.json.deduplicated, true);
    assert.equal(lan.json.job.job_id, (frame as any).job.job_id, 'the one job is the relay\'s');
    assert.equal(lan.json.job.state, 'bytes_written');
    assert.equal(h.printer.count('RELAY-THEN-LAN'), 1);
  });

  it('relay still in flight when the LAN send arrives: the same job, printed once', async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const frame = relayFrame('sale-5002-r0', 'RELAY-INFLIGHT');
    await handlePrint(BASE, TOKEN, frame);
    await h.until(() => h.sends >= 1);
    const lan = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-5002-r0', 'RELAY-INFLIGHT'));
    assert.equal(lan.json.deduplicated, true);
    assert.equal(lan.json.job.state, 'sending');
    release();
    hold = undefined;
    await untilReported((frame as any).job.job_id);
    assert.equal(h.printer.count('RELAY-INFLIGHT'), 1);
  });

  it('LAN still in flight when the relay frame arrives: the relay reports the LAN job\'s outcome', async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const sendsBefore = h.sends;
    await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-5003-r0', 'LAN-INFLIGHT'));
    await h.until(() => h.sends > sendsBefore);
    const frame = relayFrame('sale-5003-r0', 'LAN-INFLIGHT');
    await handlePrint(BASE, TOKEN, frame);
    assert.equal(reported((frame as any).job.job_id), undefined, 'nothing to report yet');
    release();
    hold = undefined;
    const result = await untilReported((frame as any).job.job_id);
    assert.equal(result.ok, true);
    assert.equal(h.printer.count('LAN-INFLIGHT'), 1);
  });

  it('the relay delivering the same key twice (two server job ids) still prints once', async () => {
    const a = relayFrame('sale-5004-r0', 'TWICE');
    const b = relayFrame('sale-5004-r0', 'TWICE');
    await handlePrint(BASE, TOKEN, a);
    await handlePrint(BASE, TOKEN, b);
    await untilReported((a as any).job.job_id);
    await untilReported((b as any).job.job_id);
    assert.equal(h.printer.count('TWICE'), 1);
  });

  it('a relay claim that EXPIRED before it printed does not stop the LAN send from printing', async () => {
    await h.printer.down();
    const connectionsBefore = h.printer.connections;
    try {
      // A claim with 12.5 s left gives the Bridge a 2 s deadline (the claim less the 10 s reserve).
      const frame = relayFrame('sale-5005-r0', 'AFTER-EXPIRY', { claim_expires_at: new Date(Date.now() + 12_500).toISOString() });
      await handlePrint(BASE, TOKEN, frame);
      const result = await untilReported((frame as any).job.job_id);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'expired');
      assert.equal(result.printed_certainty, 'none');
      assert.equal(h.printer.connections, connectionsBefore, 'nothing reached the printer');
    } finally {
      await h.printer.up();
    }
    const lan = await h.terminal.call('POST', '/lan/v1/jobs', jobBody('sale-5005-r0', 'AFTER-EXPIRY'));
    assert.equal(lan.status, 202);
    assert.equal(lan.json.deduplicated, false, 'an expiry is not remembered');
    await h.idle();
    assert.equal(h.printer.count('AFTER-EXPIRY'), 1);
  });
});

describe('the relay frame\'s new optional fields', () => {
  it('passes dedupe_key to the queue, and looks the printer up again per attempt when it was named by id', async () => {
    const submit = mock.method(queue(), 'submit');
    try {
      const frame = relayFrame('sale-5100-r0', 'PLUMBED');
      await handlePrint(BASE, TOKEN, frame);
      await untilReported((frame as any).job.job_id);
      const input = submit.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
      assert.equal(input.dedupe_key, 'sale-5100-r0');
      assert.equal(input.registry_id, true);
      assert.equal(input.job_id, (frame as any).job.job_id);
    } finally {
      submit.mock.restore();
    }
  });

  it('refuses a dedupe_key outside the contract, reports it, and prints nothing', async () => {
    const connections = h.printer.connections;
    const frame = relayFrame('bad key!', 'NEVER');
    await handlePrint(BASE, TOKEN, frame);
    const result = await untilReported((frame as any).job.job_id);
    assert.equal(result.reason, 'payload-rejected');
    assert.equal(result.printed_certainty, 'none');
    assert.equal(h.printer.connections, connections);
  });

  it('a null dedupe_key is the same as none: the job prints as an ordinary relay job', async () => {
    const frame = relayFrame(undefined, 'NULL-KEY', { dedupe_key: null });
    await handlePrint(BASE, TOKEN, frame);
    const result = await untilReported((frame as any).job.job_id);
    assert.equal(result.ok, true);
    assert.equal(h.queue.isKnown('null'), false, 'null is not taken as a key');
  });

  it('refuses a job pinned to another Bridge, and reports that nothing was sent', async () => {
    const connections = h.printer.connections;
    const frame = relayFrame('sale-5101-r0', 'PINNED-ELSEWHERE', { pin_bridge_id: '78' });
    await handlePrint(BASE, TOKEN, frame);
    const result = await untilReported((frame as any).job.job_id);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'device-missing');
    assert.equal(result.printed_certainty, 'none');
    assert.match(result.detail, /pinned to bridge 78/);
    assert.equal(h.printer.connections, connections);
    assert.equal(h.queue.isKnown('sale-5101-r0'), false);
  });

  it('prints a job pinned to this Bridge, whether the pin is a string or a number', async () => {
    for (const pin of ['77', 77]) {
      const frame = relayFrame(`sale-5102-r${pin}`, `PINNED-HERE-${pin}`, { pin_bridge_id: pin });
      await handlePrint(BASE, TOKEN, frame);
      await untilReported((frame as any).job.job_id);
      assert.equal(h.printer.count(`PINNED-HERE-${pin}`), 1);
    }
  });

  it('a frame without the new fields is handled as it always was: no key, no ring file, job_id identity', async () => {
    const submit = mock.method(queue(), 'submit');
    try {
      const frame = relayFrame(undefined, 'LEGACY-FRAME');
      await handlePrint(BASE, TOKEN, frame);
      await untilReported((frame as any).job.job_id);
      const input = submit.mock.calls.at(-1)?.arguments[0] as Record<string, unknown>;
      assert.equal('dedupe_key' in input, false);
      assert.equal('registry_id' in input, false);
      assert.equal(h.printer.count('LEGACY-FRAME'), 1);
      // The same job_id again is answered from the OLD ring, as before.
      await handlePrint(BASE, TOKEN, frame);
      await h.until(() => posts.filter((p) => p.id === (frame as any).job.job_id).length >= 2);
      assert.equal(h.printer.count('LEGACY-FRAME'), 1);
    } finally {
      submit.mock.restore();
    }
    assert.ok(existsSync(join(h.dir, 'settled.jsonl')));
  });
});
