/*
 * Finish the runtime's root-certificate setup on the main thread, before anything else can
 * start it from two threads at once.
 *
 * Bun up to 1.3.12 initialises its bundled root list lazily and not thread-safely (oven-sh/bun
 * #28612, fixed by #29426 in 1.3.13): the first TLS context created on each thread triggers the
 * setup, the "done" flag is raised before the list is full, and a second thread arriving in that
 * window builds its trust store from a partial list — and keeps it. `fetch` lives on Bun's HTTP
 * thread; `new WebSocket()` and `node:tls` live on the JavaScript thread. 1.14.4 moved the
 * relay's websocket onto Bun's native client, so from that build on the first heartbeat (fetch)
 * and the first socket dial raced each other at start-up, and on a Windows till — where no
 * `/etc/ssl/cert.pem` exists to paper over a short list — every `fetch` of the process then
 * failed with UNABLE_TO_GET_ISSUER_CERT_LOCALLY while the websocket connected.
 *
 * `tls.getCACertificates()` runs that same setup to completion, synchronously, on this thread.
 * Called once here, before the server, the relay or the pairing flow open a single connection,
 * every later thread finds the list complete. Harmless on a runtime without the bug, and a no-op
 * on one without the function (Node before 22.15).
 */
import tls from 'node:tls';

export interface TlsWarmup {
  /** Bundled roots plus NODE_EXTRA_CA_CERTS, as the runtime reports them. */
  roots: number;
  ms: number;
}

type GetCACertificates = (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];

function getter(): GetCACertificates | null {
  const get = (tls as { getCACertificates?: unknown }).getCACertificates;
  return typeof get === 'function' ? (get as GetCACertificates) : null;
}

/** Null when the runtime has no `tls.getCACertificates`; never throws. */
export function warmTlsTrustStore(): TlsWarmup | null {
  const get = getter();
  if (!get) return null;
  const started = Date.now();
  try {
    // `default` builds the store the way every TLS context will; `extra` is the NODE_EXTRA_CA_CERTS
    // half of the same setup.
    const bundled = get('bundled').length;
    const extra = get('extra').length;
    get('default');
    return { roots: bundled + extra, ms: Date.now() - started };
  } catch {
    return null;
  }
}

/**
 * The roots relay-fetch.ts passes explicitly when the runtime's own store failed: the bundled
 * list plus NODE_EXTRA_CA_CERTS, so an operator's added root survives even on a Bun (1.4+) where
 * `tls.ca` replaces the default store instead of adding to it. Falls back to the raw bundled
 * list where the newer API is missing.
 */
export function bundledAndExtraRoots(): readonly string[] {
  const get = getter();
  if (get) {
    try {
      return [...get('bundled'), ...get('extra')];
    } catch {
      // fall through
    }
  }
  return tls.rootCertificates;
}
