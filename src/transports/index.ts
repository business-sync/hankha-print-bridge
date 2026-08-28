/*
 * The driver lookup.
 *
 * A `Record` keyed by `TransportKind` rather than a switch, for the reason the POS terminal
 * records at `services/transport-pool.ts:80`: a hand-written list of kinds drifts from the union
 * silently, whereas an exhaustive record fails to compile the moment a kind is added and its
 * driver is not.
 */
import type { TransportKind } from '../registry.js';
import { networkTransport } from './network.js';
import { serialTransport } from './serial.js';
import { spoolerTransport } from './spooler.js';
import type { Transport } from './transport.js';

export const DRIVERS: Record<TransportKind, Transport> = {
  network: networkTransport,
  usb: spoolerTransport,
  serial: serialTransport,
};

export function driverFor(kind: TransportKind): Transport {
  return DRIVERS[kind];
}

export * from './transport.js';
export { networkTransport, serialTransport, spoolerTransport };
