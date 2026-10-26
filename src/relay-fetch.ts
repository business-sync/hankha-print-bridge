/*
 * Every HTTPS request the bridge makes to the relay goes through here, for one reason.
 *
 * On a Windows 10 till (DESKTOP-05GF91C, 2026-10-24) the compiled bridge — Bun 1.3.11, the
 * runtime every 1.14.x build has shipped with — refused api.hankha.la on every `fetch` with
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY, from the first second after an upgrade, while in the same
 * process and the same second `new WebSocket()` to the same host verified the same chain and
 * connected. The certificate was the real one: leaf CN=hankha.la, issued by Google Trust Services
 * WE1, chaining to GTS Root R4, which is one of the 144 roots compiled into that very binary.
 * Nothing on the PC inspected HTTPS; Windows itself validated the chain. `fetch`'s trust store
 * had been built from a half-filled root list: Bun's root-certificate setup was not thread-safe
 * before 1.3.13 (oven-sh/bun #28612), and 1.14.4's native websocket had started it on the
 * JavaScript thread in the same instant the first heartbeat started it on the HTTP thread.
 *
 * tls-warmup.ts closes that window and the shipped runtime now carries the fix, but a trust
 * store that is wrong for the life of the process is the kind of fault worth a second line of
 * defence that widens trust by nothing: Bun's `fetch` takes `tls.ca`, and on 1.3.x the list it
 * is handed is ADDED to the default store (checked on 1.3.11: a request with an unrelated CA in
 * `tls.ca` still verifies api.hankha.la). So on a trust failure the same request is tried once
 * more with the runtime's own roots — the bundled list plus NODE_EXTRA_CA_CERTS, the exact set
 * `fetch` was meant to use — passed explicitly. If that verifies, the runtime's default store
 * was the fault, the fact is logged once with the runtime version, and every later relay request
 * carries the roots from the start. If it does not, the chain really does not end in a bundled
 * root, the original error is thrown exactly as before, and the classifier in tls-trust.ts says
 * so.
 *
 * Under Node (the container, `npm run dev`, the tests) `fetch` is undici, which takes no `tls`
 * option and has never shown the fault; the retry is skipped there.
 */
import { log } from './log.js';
import { tlsTrustCode } from './tls-trust.js';
import { bundledAndExtraRoots } from './tls-warmup.js';
import { RUNTIME } from './version.js';

/** `fetch`'s options plus the Bun-only `tls` block the retry adds. */
export type RelayRequestInit = RequestInit & { tls?: { ca?: readonly string[]; rejectUnauthorized?: boolean } };

export type FetchLike = (url: string, init?: RelayRequestInit) => Promise<Response>;

export interface RelayFetchDeps {
  /** Resolved at call time so a test's `mock.method(globalThis, 'fetch', …)` is honoured. */
  fetchImpl: FetchLike;
  /** Only Bun's `fetch` takes `tls.ca`; under Node the retry would be the same request again. */
  isBun: boolean;
  /** The roots the runtime says it trusts — bundled plus NODE_EXTRA_CA_CERTS. Empty disables the retry. */
  roots: () => readonly string[];
  runtime: string;
}

export interface ExplicitRootsState {
  /** A retry with explicit roots has run at least once in this process. */
  tried: boolean;
  /** The retry verified: every relay request now carries the bundled roots. */
  latched: boolean;
  /** The code the retry failed with, when it did; null otherwise. */
  failed_code: string | null;
  /** When the workaround latched, for the status page. */
  latched_at: string | null;
}

export interface RelayFetch {
  (url: string, init?: RelayRequestInit): Promise<Response>;
  state(): ExplicitRootsState;
  /** Tests only: swap the dependencies and forget any latch. */
  configure(deps: Partial<RelayFetchDeps>): void;
  /** Tests only: forget the latch, keep the dependencies. */
  reset(): void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function createRelayFetch(initial: RelayFetchDeps): RelayFetch {
  let deps = { ...initial };
  const state: ExplicitRootsState = { tried: false, latched: false, failed_code: null, latched_at: null };

  const withRoots = (init: RelayRequestInit | undefined, roots: readonly string[]): RelayRequestInit => ({
    ...(init ?? {}),
    tls: { ...(init?.tls ?? {}), ca: roots },
  });

  const relayFetch = (async (url: string, init?: RelayRequestInit): Promise<Response> => {
    if (state.latched) return deps.fetchImpl(url, withRoots(init, deps.roots()));
    try {
      return await deps.fetchImpl(url, init);
    } catch (err) {
      const code = tlsTrustCode(err);
      if (!code || !deps.isBun) throw err;
      const roots = deps.roots();
      if (roots.length === 0) throw err;
      state.tried = true;
      let res: Response;
      try {
        res = await deps.fetchImpl(url, withRoots(init, roots));
      } catch (again) {
        // The chain really is not signed by a bundled root. The ORIGINAL error is what the caller
        // and the classifier see; the retry's outcome is kept for the verdict.
        state.failed_code = tlsTrustCode(again) ?? (again instanceof Error ? again.message : String(again));
        throw err;
      }
      state.latched = true;
      state.failed_code = null;
      state.latched_at = new Date().toISOString();
      const host = hostOf(url);
      log.warn(
        `relay: ${host} verified only once this bridge's own bundled root certificates were handed to fetch ` +
          `explicitly — the runtime (${deps.runtime}) did not apply its default trust store to fetch (${code}). ` +
          `Every relay request from now on carries those ${roots.length} roots; nothing else on this computer ` +
          'needs changing. Update the Print Bridge when a newer build is available',
        { event: 'relay.tls.explicit_roots', code, host, runtime: deps.runtime, roots: roots.length },
      );
      return res;
    }
  }) as RelayFetch;

  relayFetch.state = () => ({ ...state });
  relayFetch.configure = (over) => {
    deps = { ...deps, ...over };
    relayFetch.reset();
  };
  relayFetch.reset = () => {
    state.tried = false;
    state.latched = false;
    state.failed_code = null;
    state.latched_at = null;
  };
  return relayFetch;
}

/** The instance the relay and the pairing flow share, so one latch covers both. */
export const relayFetch = createRelayFetch({
  fetchImpl: (url, init) => globalThis.fetch(url, init as RequestInit),
  isBun: Boolean(process.versions.bun),
  roots: bundledAndExtraRoots,
  runtime: RUNTIME,
});
