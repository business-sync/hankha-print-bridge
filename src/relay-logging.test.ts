import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type LogRecord, setLogSink } from './log.js';

/*
 * What the relay loop SAYS while it rides out faults: the lines a venue's log needs to explain a
 * disconnect. Runs the real loop (long-poll) against a fake API whose answers the test flips.
 *
 * Own file: the loop's state is module-global. Heartbeat shortened to 200 ms so a run of beats,
 * a failure window and a recovery fit in a few seconds.
 */
process.env.PRINT_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), 'hankha-bridge-logging-'));
process.env.PRINT_BRIDGE_RELAY_TRANSPORT = 'poll';
process.env.PRINT_BRIDGE_HEARTBEAT_MS = '200';
process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';

const records: LogRecord[] = [];
setLogSink((r) => records.push(r));
const events = (name: string) => records.filter((r) => r.event === name);

let work: '204' | '500' | '401' | 'hang' = '204';
let beat: 'ok' | 'drop' = 'ok';
let accepted = 'tok-1';
let server: Server;

const waitFor = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  setTimeout(() => process.exit(0), 100).unref();
});

describe('relay loop logging', () => {
  it('starts, connects, and refuses a second loop out loud', async () => {
    server = createServer((req, res) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (req.url?.includes('/bridge/heartbeat')) {
        if (beat === 'drop') {
          req.socket.destroy();
          return;
        }
        res.writeHead(token === accepted ? 200 : 401).end();
        return;
      }
      if (req.url?.includes('/bridge/work')) {
        if (work === 'hang') return;
        if (work === '401' || token !== accepted) {
          res.writeHead(401).end();
          return;
        }
        setTimeout(() => res.writeHead(work === '500' ? 500 : 204).end(), 30);
        return;
      }
      res.writeHead(404).end();
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    );
    process.env.PRINT_BRIDGE_RELAY_URL = `http://127.0.0.1:${port}`;
    const { loadState, saveState } = await import('./identity.js');
    saveState({ ...loadState(), bridge_id: '18', token: 'tok-1' });

    const relay = await import('./relay.js');
    relay.startRelay();
    await waitFor(() => relay.relayStatus().connected);

    const start = events('relay.start')[0];
    assert.ok(start);
    assert.equal(start.fields.bridge_id, '18');
    assert.equal(start.fields.transport_mode, 'poll');
    assert.ok(events('relay.poll').length > 0, 'each poll is narrated at debug');

    relay.startRelay();
    assert.equal(events('relay.already_running').length, 1);
    assert.equal(relay.isRelayRunning(), true);
  });

  it('logs a failing poll with its status, then the recovery with how long it was down', async () => {
    const relay = await import('./relay.js');
    work = '500';
    await waitFor(() => events('relay.retry').length > 0);
    const retry = events('relay.retry')[0];
    assert.equal(retry?.level, 'warn', 'a retry is the bridge riding out a fault, not an error');
    assert.equal(retry?.fields.status, 500);
    assert.equal(retry?.fields.failures, 1);
    assert.equal(relay.relayStatus().connected, false);

    work = '204';
    await waitFor(() => events('relay.recovered').length > 0);
    const recovered = events('relay.recovered')[0];
    assert.equal(recovered?.fields.transport, 'long-poll');
    assert.ok(Number(recovered?.fields.down_ms) > 0);
    assert.equal(relay.relayStatus().connected, true);
  });

  /*
   * Heartbeat network errors used to be swallowed outright, while a rejected heartbeat was logged
   * on every beat. Now: the first failure, once per window after that, and the recovery.
   */
  it('logs a heartbeat that cannot reach the server once, then its recovery', async () => {
    const relay = await import('./relay.js');
    beat = 'drop';
    await waitFor(() => relay.relayDiagnostics().heartbeat_failures >= 3);
    const failed = events('relay.heartbeat.failed');
    assert.equal(failed.length, 1, 'repeats inside the window are counted, not written');
    assert.equal(failed[0]?.level, 'warn');
    assert.ok(failed[0]?.fields.error_message, 'the network error is in the record');

    beat = 'ok';
    await waitFor(() => events('relay.heartbeat.recovered').length > 0);
    assert.ok(Number(events('relay.heartbeat.recovered')[0]?.fields.failures) >= 3);
  });

  it('exposes the timings a diagnostics snapshot needs', async () => {
    const relay = await import('./relay.js');
    const d = relay.relayDiagnostics();
    assert.equal(d.connected, true);
    assert.equal(d.transport, 'long-poll');
    assert.equal(typeof d.since_poll_ok_ms, 'number');
    assert.equal(typeof d.since_heartbeat_ok_ms, 'number');
    assert.equal(d.down_ms, null);
  });

  it('logs a rejected token with the rejection count, and recovers on a new one', async () => {
    const relay = await import('./relay.js');
    const { loadState, saveState } = await import('./identity.js');
    work = '401';
    await waitFor(() => events('relay.token_rejected').length > 0);
    const rejected = events('relay.token_rejected')[0];
    assert.equal(rejected?.level, 'error');
    assert.equal(rejected?.fields.rejections, 1);
    const before = events('relay.recovered').length;

    accepted = 'tok-2';
    work = '204';
    saveState({ ...loadState(), bridge_id: '19', token: 'tok-2' });
    relay.wakeRelay();
    await waitFor(() => events('relay.recovered').length > before);
    assert.equal(relay.relayStatus().bridge_id, '19');
  });

  /*
   * The watchdog only acts on `connected === false`. A long-poll that never answers keeps
   * `connected` true, and this is the line that says so.
   */
  it('warns when it is marked connected but nothing has arrived for three heartbeats', async () => {
    work = 'hang';
    await waitFor(() => events('relay.stale').length > 0, 4000);
    const stale = events('relay.stale')[0];
    assert.equal(stale?.fields.transport, 'long-poll');
    assert.ok(Number(stale?.fields.silent_ms) > 600);
  });

  it('never writes a bearer token into any record', () => {
    const all = JSON.stringify(records);
    assert.equal(all.includes('tok-1'), false);
    assert.equal(all.includes('tok-2'), false);
    assert.equal(/Bearer /.test(all), false);
  });
});
