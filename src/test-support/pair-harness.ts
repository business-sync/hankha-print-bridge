/*
 * Shared setup for the M9 (pairing over the shop network) tests: a Bridge that is not paired, a
 * stand-in for the backend that signs grants, and a fake clock.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelayState } from '../identity.js';
import { b64u, LanKeyStore, type LanKeyEntry } from '../lan-keys.js';
import { LanAuth } from '../lan-auth.js';
import { canonicalGrantJson, LanPairing, type GrantPayload, type PairingDeps } from '../lan-pair.js';
import { createLanServer } from '../lan-server.js';
import { PrintQueue } from '../queue.js';

export const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export class FakeClock {
  constructor(public ms = Date.parse('2026-11-07T10:00:00Z')) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
  get seconds(): number {
    return Math.floor(this.ms / 1000);
  }
}

export interface PairRig {
  dir: string;
  clock: FakeClock;
  keys: LanKeyStore;
  backend: { privateKey: KeyObject; publicSpki: string };
  /** The Bridge's relay state, in memory: what `relay.json` would hold. */
  state: RelayState;
  saves: RelayState[];
  paired: string[];
  pairing: LanPairing;
  codes: string[];
  tokens: string[];
  /** Build a second LanPairing over the same directory and state (a Bridge restart). */
  restart: () => LanPairing;
  stop: () => Promise<void>;
  server?: Server;
  base?: string;
}

export interface RigOptions {
  state?: Partial<RelayState>;
  /** Mint this token every time (so a replay can match the token binding). */
  fixedToken?: string;
  http?: boolean;
  /** Extra keys the Bridge was told about before the test. */
  keyEntries?: LanKeyEntry[];
  /** Failed requests per remote per minute before a 429 (http rigs only). The limiter reads the rig's clock. */
  failuresPerMinute?: number;
}

export async function pairRig(opts: RigOptions = {}): Promise<PairRig> {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-pair-'));
  mkdirSync(dir, { recursive: true });
  const clock = new FakeClock();
  const backendPair = generateKeyPairSync('ed25519');
  const publicSpki = b64u(backendPair.publicKey.export({ type: 'spki', format: 'der' }));
  const keys = new LanKeyStore(dir, []);
  keys.setKeys([{ kid: 'backend-1', pubkey: publicSpki, not_before: 0, not_after: null }, ...(opts.keyEntries ?? [])]);

  const state: RelayState = { install_id: 'install-pair-0001', ...opts.state };
  const saves: RelayState[] = [];
  const paired: string[] = [];
  const codes: string[] = [];
  const tokens: string[] = [];
  let codeN = 0;
  let tokenN = 0;
  const make = (): LanPairing => {
    const deps: PairingDeps = {
      dir,
      keys,
      loadState: () => ({ ...state }),
      saveState: (next) => {
        Object.assign(state, next);
        // The install-id pin is a save with no credential; only a credential counts as a pairing.
        if (next.token) saves.push({ ...next });
      },
      relayBase: () => 'https://api.example.test',
      onPaired: ({ bridge_id }) => paired.push(bridge_id),
      describe: () => ({ hostname: 'till-1', platform: 'win32', arch: 'x64', version: '1.15.0' }),
      now: clock.now,
      // Distinct, valid-looking codes: AAAA-AAA2, AAAA-AAA3, ...
      mintCode: () => {
        const code = `AAAA-AAA${((codeN++ % 8) + 2).toString()}`;
        codes.push(code);
        return code;
      },
      mintToken: () => {
        const t = opts.fixedToken ?? `token-${String(++tokenN).padStart(3, '0')}-${'x'.repeat(40)}`;
        tokens.push(t);
        return t;
      },
    };
    return new LanPairing(deps);
  };
  const rig: PairRig = {
    dir,
    clock,
    keys,
    backend: { privateKey: backendPair.privateKey, publicSpki },
    state,
    saves,
    paired,
    codes,
    tokens,
    pairing: make(),
    restart: () => (rig.pairing = make()),
    stop: async () => {
      if (rig.server) {
        rig.server.closeAllConnections?.();
        await new Promise<void>((r) => rig.server?.close(() => r()));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };

  if (opts.http) {
    const queue = new PrintQueue({ dir });
    const auth = new LanAuth({ keys, bridgeId: () => state.bridge_id ?? null, now: clock.now });
    rig.server = createLanServer({
      auth,
      queue: () => queue,
      installId: () => state.install_id,
      bridgeId: () => state.bridge_id ?? null,
      relayConnected: () => false,
      reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
      pairing: () => rig.pairing,
      // The failure limiter reads the rig's clock like the pairing does, so a test that moves time moves both.
      now: clock.now,
      ...(opts.failuresPerMinute !== undefined ? { failuresPerMinute: opts.failuresPerMinute } : {}),
    });
    await new Promise<void>((r) => rig.server?.listen(0, '127.0.0.1', r));
    rig.base = `http://127.0.0.1:${(rig.server.address() as { port: number }).port}`;
  }
  return rig;
}

export interface GrantOptions {
  grant_id?: string;
  org_id?: string | number;
  branch_id?: string | number;
  bridge_id?: string | number;
  install_id?: string;
  token_hash?: string;
  bridge_pubkey?: string;
  lan_keys?: LanKeyEntry[];
  kid?: string;
  iat?: number;
  exp?: number;
  kind?: string;
  v?: number;
}

let grantN = 0;

/** What the backend would sign: the contract's key order, no whitespace. */
export function mintGrant(rig: PairRig, o: GrantOptions = {}, signer: KeyObject = rig.backend.privateKey): string {
  const info = rig.pairing.info();
  const iat = o.iat ?? rig.clock.seconds - 5;
  const payload = {
    v: o.v ?? 1,
    kind: o.kind ?? 'bridge_grant',
    grant_id: o.grant_id ?? `grant-${String(++grantN).padStart(6, '0')}`,
    org_id: o.org_id ?? '2',
    branch_id: o.branch_id ?? '8',
    bridge_id: o.bridge_id ?? '77',
    install_id: o.install_id ?? rig.state.install_id,
    token_hash: o.token_hash ?? ((info.body.token_hash as string | undefined) ?? 'f'.repeat(64)),
    bridge_pubkey: o.bridge_pubkey ?? rig.keys.publicKey(),
    lan_keys: o.lan_keys ?? [],
    kid: o.kid ?? 'backend-1',
    iat,
    exp: o.exp ?? iat + 600,
  };
  return signRaw(JSON.stringify(payload), signer);
}

export function signRaw(json: string, signer: KeyObject): string {
  return `${b64u(Buffer.from(json))}.${b64u(cryptoSign(null, Buffer.from(json), signer))}`;
}

export { canonicalGrantJson };
export type { GrantPayload };

export async function postPair(rig: PairRig, code: string, grant: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${rig.base}/lan/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, grant }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

export async function getPairInfo(rig: PairRig): Promise<{ status: number; json: any }> {
  const res = await fetch(`${rig.base}/lan/v1/pair-info`);
  return { status: res.status, json: await res.json().catch(() => null) };
}
