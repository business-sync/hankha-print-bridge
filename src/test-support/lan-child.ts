/*
 * A Bridge process for the crash tests: the real queue, spool, settled rings and LAN listener, in a
 * process the parent can `kill -9`.
 *
 * It differs from `index.ts` in exactly one way — what the queue's sender does — because a registry
 * printer must have an RFC1918 address and the fake printer lives on loopback. The sender is chosen
 * by CHILD_MODE so a test can stop a job at the precise moment it wants to kill the process:
 *
 *   refuse        every send fails with certainty `none` (a printer that is off)
 *   hang          announces SENDING, then never returns (killed with bytes "on the wire")
 *   write-hang    really writes the bytes to the fake printer, announces WRITTEN, then never returns:
 *                 the paper is out and the Bridge has not yet recorded it
 *   real          really writes the bytes and returns
 *
 * Events go to stdout, one JSON object per line.
 */
import { sendToPrinter } from '../lan.js';
import { LanAuth } from '../lan-auth.js';
import { LanKeyStore } from '../lan-keys.js';
import { createLanServer } from '../lan-server.js';
import { PrintQueue } from '../queue.js';
import type { PrintOutcome } from '../lan.js';

const dir = process.env.CHILD_STATE_DIR as string;
const mode = process.env.CHILD_MODE ?? 'real';
const printerPort = Number(process.env.CHILD_PRINTER_PORT);
const emit = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...extra }));

const send = async (_printer: unknown, bytes: Buffer, timeoutMs: number): Promise<PrintOutcome> => {
  if (mode === 'refuse') {
    emit('ATTEMPT');
    return { ok: false, reason: 'connect-refused', printed_certainty: 'none', detail: 'ECONNREFUSED', duration_ms: 1 };
  }
  if (mode === 'hang') {
    emit('SENDING');
    return new Promise<PrintOutcome>(() => undefined);
  }
  const outcome = await sendToPrinter('127.0.0.1', printerPort, bytes, timeoutMs, 1_000);
  if (mode === 'write-hang') {
    emit('WRITTEN');
    return new Promise<PrintOutcome>(() => undefined);
  }
  emit('SENT');
  return outcome;
};

const queue = new PrintQueue({ dir, send });
queue.load();
const keys = new LanKeyStore(dir, []);
keys.setKeys([{ kid: 'test-backend-1', pubkey: process.env.CHILD_BACKEND_SPKI as string, not_before: 0, not_after: null }]);
const auth = new LanAuth({ keys, bridgeId: () => '77' });
const server = createLanServer({
  auth,
  queue: () => queue,
  installId: () => 'install-test-0001',
  bridgeId: () => '77',
  relayConnected: () => false,
  reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
});
server.listen(0, '127.0.0.1', () => {
  emit('READY', { port: (server.address() as { port: number }).port, bridge_pubkey: keys.publicKey(), pid: process.pid });
});
