/*
 * Pairing over the shop network (M9, Bridge half): enrol a Bridge whose router never has internet.
 *
 * THE PROBLEM. The normal flow has the Bridge call the cloud twice: once to announce itself and be
 * handed a code, once to redeem that code for a token after a tablet claimed it. A Bridge on a
 * router with no uplink can do neither. The terminal (a phone or tablet with a SIM) can reach both
 * the cloud and the Bridge, so it carries the exchange between them.
 *
 * THE SHAPE. Nothing secret crosses the network and the cloud never learns anything the Bridge did
 * not choose to publish:
 *
 *   1. The Bridge holds a pending bearer token T (random, 32 bytes) it will use as its relay
 *      credential. It publishes only `token_hash = sha256(T)` in `GET /lan/v1/pair-info`.
 *   2. A person logged in to Hankha, with the same rights as for a normal claim, asks the BACKEND
 *      for a grant for that Bridge: the backend creates the bridge row exactly as a claim followed
 *      by an enrolment would (org, branch, install_id, `token_hash` = the Bridge's own hash), and
 *      signs a short-lived grant naming it. The backend never sees T.
 *   3. The terminal posts `{code, grant}` to `POST /lan/v1/pair`. The Bridge accepts only if the
 *      grant verifies against its key set, names THIS Bridge (install id and token hash), has not
 *      been used, and the code matches the one shown on the Bridge's own screen. It then writes
 *      the same `relay.json` a redemption would, with T as the token. When the router gets
 *      internet, its first request authenticates with T, which the backend already knows by hash:
 *      there is nothing left to reconcile.
 *
 * WHY A CODE AS WELL AS A GRANT. The grant proves an authorised person asked for THIS Bridge; the
 * code proves that person (or their terminal) is physically at it. Without the code, anybody on
 * the venue wifi holding a stolen grant could finish the job; without the grant, anybody on the
 * wifi who read the code off a glass door could. Both are required. The code is never returned
 * over the network, only shown on the Bridge's own loopback page.
 *
 * OFF BY DEFAULT. Nothing here exists unless `lan.json` says `"pairing_over_lan": true` (and the
 * LAN API is on). An already-paired Bridge refuses, unless somebody at the machine pressed "allow
 * LAN re-pair" (a loopback-only action) in the last few minutes.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileDurable } from './durable-fs.js';
import { normalizeEnrollCode } from './enroll-code.js';
import type { RelayState } from './identity.js';
import { b64u, fromB64u, type LanKeyEntry, type LanKeyStore, parseKeyEntry } from './lan-keys.js';
import { log } from './log.js';

export const PAIR_FILE = 'lan-pair.json';
export const GRANT_KIND = 'bridge_grant';
/** A grant may not live longer than this, whatever the backend signs. */
export const MAX_GRANT_LIFETIME_S = 15 * 60;
/**
 * How far the Bridge's own clock may be from the grant's window. A Bridge with no internet has no
 * NTP, so its clock can drift; replay is stopped by the used-grant list and the token binding, not
 * by time, so this only has to be tight enough to mean something and loose enough to work.
 */
export const GRANT_SKEW_S = 10 * 60;
export const CODE_TTL_MS = 15 * 60_000;
export const REPAIR_WINDOW_MS = 10 * 60_000;
export const FAILURES_BEFORE_LOCK = 5;
export const FIRST_LOCK_MS = 60_000;
export const MAX_LOCK_MS = 15 * 60_000;
const USED_GRANTS_KEPT = 256;
const MAX_PAIR_BODY = 16 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GRANT_ID = /^[A-Za-z0-9._:-]{8,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IDLIKE = (v: unknown): v is string | number =>
  (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

export interface GrantPayload {
  v: 1;
  kind: typeof GRANT_KIND;
  grant_id: string;
  org_id: string | number;
  branch_id: string | number;
  bridge_id: string | number;
  install_id: string;
  token_hash: string;
  /**
   * The Ed25519 ack key the Bridge published in `pair-info`. The backend stores it as the Bridge's
   * `lan.pubkey` when it issues the grant, which is how a Bridge that never reaches the internet
   * (and so never heartbeats) can still be named in tickets. The Bridge refuses a grant that names
   * a different key.
   */
  bridge_pubkey: string;
  lan_keys: LanKeyEntry[];
  kid: string;
  iat: number;
  exp: number;
}

/** The contract's canonical form: this key order, no whitespace. */
export function canonicalGrantJson(p: GrantPayload): string {
  return JSON.stringify({
    v: p.v, kind: p.kind, grant_id: p.grant_id, org_id: p.org_id, branch_id: p.branch_id, bridge_id: p.bridge_id,
    install_id: p.install_id, token_hash: p.token_hash, bridge_pubkey: p.bridge_pubkey, lan_keys: p.lan_keys,
    kid: p.kid, iat: p.iat, exp: p.exp,
  });
}

export type PairFailure =
  | 'invalid_json' | 'invalid_body'
  | 'already_paired' | 'locked'
  | 'grant_invalid' | 'grant_unknown_kid' | 'grant_expired' | 'grant_not_yet_valid'
  | 'grant_replayed' | 'grant_wrong_bridge' | 'wrong_org'
  | 'wrong_code';

export interface PairReply {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface PairingDeps {
  dir: string;
  keys: LanKeyStore;
  loadState: () => RelayState;
  saveState: (state: RelayState) => void;
  /** The relay base URL the Bridge would have used to enrol: whatever `relayUrl(state)` says. */
  relayBase: (state: RelayState) => string;
  /** Called after a successful pairing, once the credential is on disk. */
  onPaired?: (paired: { bridge_id: string }) => void;
  describe?: () => { hostname: string; platform: string; arch: string; version: string };
  now?: () => number;
  /** Test seams. */
  mintCode?: () => string;
  mintToken?: () => string;
}

interface PairFile {
  v: 1;
  /** The bearer token this Bridge will use once paired. Mode 0600, like relay.json. */
  token: string;
  used: { id: string; at: string }[];
}

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function codesEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

function defaultCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i += 1) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export type PairState = 'unpaired' | 'paired' | 'repair_allowed';

export class LanPairing {
  private code: string | null = null;
  private codeExpiresAt = 0;
  private failures = 0;
  private lockedUntil = 0;
  private lockCount = 0;
  private repairUntil = 0;
  private file: PairFile | null = null;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly deps: PairingDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ persistence

  private path(): string {
    return join(this.deps.dir, PAIR_FILE);
  }

  private pinned = false;

  /**
   * Make this Bridge's install id stable before anyone is told it.
   *
   * `loadState()` mints a NEW random id on every call while no `relay.json` exists, which has never
   * mattered (the cloud flow lets the redemption overwrite whatever the announce said). Here the
   * terminal reads the id in `pair-info` and the backend binds a grant to it, so it must be the
   * same one when `pair` arrives. Saving the state with no credential changes nothing else: the
   * Bridge is still unpaired. Only runs while pairing over the LAN is on.
   */
  private pinInstallId(): void {
    if (this.pinned) return;
    this.pinned = true;
    const state = this.deps.loadState();
    if (!state.token) this.deps.saveState(state);
  }

  private load(): PairFile {
    this.pinInstallId();
    if (this.file) return this.file;
    try {
      if (existsSync(this.path())) {
        const raw = JSON.parse(readFileSync(this.path(), 'utf8')) as Partial<PairFile>;
        if (typeof raw.token === 'string' && raw.token.length >= 32) {
          this.file = {
            v: 1,
            token: raw.token,
            used: Array.isArray(raw.used)
              ? raw.used.filter((u): u is { id: string; at: string } => !!u && typeof u.id === 'string' && typeof u.at === 'string').slice(-USED_GRANTS_KEPT)
              : [],
          };
          return this.file;
        }
        // A readable file with a missing or short token is not trusted: a new token is minted, but
        // the list of grants already spent is kept, or deleting a field would re-arm old grants.
        this.file = { v: 1, token: this.freshToken(), used: Array.isArray(raw.used) ? (raw.used as PairFile['used']).slice(-USED_GRANTS_KEPT) : [] };
        this.persist();
        return this.file;
      }
    } catch (err) {
      // Unreadable: start over with a new token. The spent-grant list is lost, but the token a
      // spent grant was bound to is gone with it, so none of them can match.
      log.warn('lan pairing: lan-pair.json is unreadable — a new pending token was minted', { event: 'lan.pair.file_unreadable', err });
    }
    this.file = { v: 1, token: this.freshToken(), used: [] };
    this.persist();
    return this.file;
  }

  private freshToken(): string {
    return this.deps.mintToken ? this.deps.mintToken() : randomBytes(32).toString('base64url');
  }

  private persist(): void {
    if (!this.file) return;
    writeFileDurable(this.path(), `${JSON.stringify(this.file)}\n`, `${this.path()}.tmp`, 0o600);
  }

  // ------------------------------------------------------------------ state

  private hasCredential(): boolean {
    return Boolean(this.deps.loadState().token);
  }

  state(): PairState {
    if (!this.hasCredential()) return 'unpaired';
    return this.now() < this.repairUntil ? 'repair_allowed' : 'paired';
  }

  private eligible(): boolean {
    return this.state() !== 'paired';
  }

  private currentCode(): string {
    const t = this.now();
    if (this.code === null || t >= this.codeExpiresAt) this.rotateCode();
    return this.code as string;
  }

  /** A new code resets the guess counter: guesses against the old one are worth nothing now. */
  private rotateCode(): void {
    this.code = this.deps.mintCode ? this.deps.mintCode() : defaultCode();
    this.codeExpiresAt = this.now() + CODE_TTL_MS;
    this.failures = 0;
  }

  // ------------------------------------------------------------------ what the loopback page shows

  /**
   * For the Bridge's own screen, and ONLY for a loopback caller: it contains the code. Null code
   * when this Bridge would refuse to pair anyway, so a paired Bridge never displays a live one.
   */
  localSnapshot(): {
    state: PairState;
    code: string | null;
    code_expires_at: string | null;
    repair_until: string | null;
    locked_until: string | null;
  } {
    const state = this.state();
    const eligible = state !== 'paired';
    return {
      state,
      code: eligible ? this.currentCode() : null,
      code_expires_at: eligible ? new Date(this.codeExpiresAt).toISOString() : null,
      repair_until: state === 'repair_allowed' ? new Date(this.repairUntil).toISOString() : null,
      locked_until: this.now() < this.lockedUntil ? new Date(this.lockedUntil).toISOString() : null,
    };
  }

  /** "Allow LAN re-pair": somebody at the machine opens a short window for a paired Bridge. */
  allowRepair(ms = REPAIR_WINDOW_MS): void {
    this.repairUntil = this.now() + ms;
    this.rotateCode();
    this.failures = 0;
    log.info('lan pairing: re-pair allowed from this computer', { event: 'lan.pair.repair_allowed', minutes: Math.round(ms / 60_000) });
  }

  closeRepair(): void {
    this.repairUntil = 0;
  }

  /** "Show a new code": presence at the machine clears a lock-out and the guess count. */
  newCode(): void {
    this.rotateCode();
    this.failures = 0;
    this.lockedUntil = 0;
    this.lockCount = 0;
  }

  // ------------------------------------------------------------------ GET /lan/v1/pair-info

  info(): PairReply {
    if (!this.eligible()) return { status: 409, body: { reason: 'already_paired' } };
    const file = this.load();
    const self = this.deps.describe?.();
    const t = this.now();
    return {
      status: 200,
      body: {
        protocol: 1,
        state: this.state(),
        install_id: this.deps.loadState().install_id,
        // Only the hash. The token itself never leaves this machine until the pairing is final,
        // and then only into relay.json.
        token_hash: sha256hex(file.token),
        bridge_pubkey: this.deps.keys.publicKey(),
        ...(self ?? {}),
        // So a terminal can say "this computer's clock is wrong" instead of "grant expired".
        now: Math.floor(t / 1000),
        grant_skew_s: GRANT_SKEW_S,
        ...(t < this.lockedUntil ? { locked_for_s: Math.ceil((this.lockedUntil - t) / 1000) } : {}),
      },
    };
  }

  // ------------------------------------------------------------------ POST /lan/v1/pair

  private fail(status: number, reason: PairFailure, extra: Record<string, unknown> = {}, countIt = true): PairReply {
    if (countIt) this.countFailure(reason);
    return { status, body: { reason, ...extra } };
  }

  private countFailure(reason: PairFailure): void {
    this.failures += 1;
    log.warn(`lan pairing: refused (${reason}), failure ${this.failures} of ${FAILURES_BEFORE_LOCK}`, {
      event: 'lan.pair.refused', reason, failures: this.failures,
    });
    if (this.failures < FAILURES_BEFORE_LOCK) return;
    this.lockCount += 1;
    const wait = Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (this.lockCount - 1));
    this.lockedUntil = this.now() + wait;
    // The code is thrown away with the lock: five guesses never carry over to the next code.
    this.rotateCode();
    log.warn(`lan pairing: ${FAILURES_BEFORE_LOCK} failures — locked for ${Math.round(wait / 1000)}s and the code was replaced`, {
      event: 'lan.pair.locked', wait_ms: wait, locks: this.lockCount,
    });
  }

  /** The request body limit for this route, for the server to read with. */
  get maxBodyBytes(): number {
    return MAX_PAIR_BODY;
  }

  pair(bodyBytes: Buffer): PairReply {
    if (!this.eligible()) return { status: 409, body: { reason: 'already_paired' } };
    const t = this.now();
    if (t < this.lockedUntil) {
      const left = Math.ceil((this.lockedUntil - t) / 1000);
      return { status: 429, body: { reason: 'locked', retry_after_s: left }, headers: { 'Retry-After': String(left) } };
    }
    // Two simultaneous requests would both pass "not used yet" before either marks it.
    if (this.busy) return { status: 429, body: { reason: 'locked', retry_after_s: 1 }, headers: { 'Retry-After': '1' } };

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyBytes.toString('utf8'));
    } catch {
      return this.fail(400, 'invalid_json', {}, false);
    }
    const input = parsed as { code?: unknown; grant?: unknown } | null;
    if (!input || typeof input !== 'object' || typeof input.code !== 'string' || typeof input.grant !== 'string' || input.grant.length > 12_288) {
      return this.fail(400, 'invalid_body', { errors: ['code and grant must be strings'] }, false);
    }

    this.busy = true;
    try {
      return this.complete(input.code, input.grant);
    } finally {
      this.busy = false;
    }
  }

  private complete(rawCode: string, grantText: string): PairReply {
    const file = this.load();
    const state = this.deps.loadState();

    // The grant first: a caller with no valid grant never gets as far as learning anything about
    // the code, so the code cannot be probed by someone who cannot also forge a signature.
    const checked = this.verifyGrant(grantText);
    if ('reason' in checked) return this.fail(checked.reason === 'grant_replayed' ? 409 : 403, checked.reason);
    const grant = checked.payload;

    if (grant.install_id !== state.install_id) return this.fail(403, 'grant_wrong_bridge');
    if (grant.token_hash !== sha256hex(file.token)) return this.fail(403, 'grant_wrong_bridge');
    if (grant.bridge_pubkey !== this.deps.keys.publicKey()) return this.fail(403, 'grant_wrong_bridge');
    if (file.used.some((u) => u.id === grant.grant_id)) return this.fail(409, 'grant_replayed');

    // A Bridge that was paired over the LAN remembers its organisation, and a re-pair may not move
    // it to another one. (Moving shops is a deliberate act done at the machine, not over wifi.)
    if (state.org_id !== undefined && String(state.org_id) !== String(grant.org_id)) return this.fail(403, 'wrong_org');

    if (!codesEqual(normalizeEnrollCode(rawCode), this.currentCode())) return this.fail(403, 'wrong_code');

    // ---- accepted. The credential first: that is the effect; the bookkeeping follows it.
    const base = this.deps.relayBase(state);
    this.deps.saveState({
      ...state,
      relay_url: base,
      bridge_id: String(grant.bridge_id),
      token: file.token,
      enrolled_at: new Date(this.now()).toISOString(),
      org_id: String(grant.org_id),
      branch_id: String(grant.branch_id),
      paired_via: 'lan',
    });
    file.used = [...file.used, { id: grant.grant_id, at: new Date(this.now()).toISOString() }].slice(-USED_GRANTS_KEPT);
    // The token that was just made the credential must never be offered again.
    file.token = this.freshToken();
    this.persist();

    if (grant.lan_keys.length > 0) {
      const applied = this.deps.keys.setKeys(grant.lan_keys);
      log.info(`lan pairing: key set from the grant — ${applied.accepted} key(s)`, { event: 'lan.pair.keys', accepted: applied.accepted });
    }

    this.failures = 0;
    this.lockCount = 0;
    this.lockedUntil = 0;
    this.repairUntil = 0;
    this.code = null;
    log.info(`lan pairing: paired as bridge ${String(grant.bridge_id)} (org ${String(grant.org_id)}) over the shop network`, {
      event: 'lan.pair.paired', bridge_id: String(grant.bridge_id), org_id: String(grant.org_id), grant_id: grant.grant_id,
    });
    try {
      this.deps.onPaired?.({ bridge_id: String(grant.bridge_id) });
    } catch (err) {
      log.warn('lan pairing: the paired hook failed — the credential is saved', { event: 'lan.pair.hook_failed', err });
    }
    return {
      status: 200,
      body: {
        paired: true,
        bridge_id: String(grant.bridge_id),
        org_id: String(grant.org_id),
        branch_id: String(grant.branch_id),
        bridge_pubkey: this.deps.keys.publicKey(),
      },
    };
  }

  // ------------------------------------------------------------------ the grant

  /** Exported for the vectors and tests. Does not consult the used-grant list or the code. */
  verifyGrant(text: string): { payload: GrantPayload } | { reason: PairFailure } {
    const parts = text.split('.');
    if (parts.length !== 2) return { reason: 'grant_invalid' };
    const payloadBytes = fromB64u(parts[0], 10_240);
    const sig = fromB64u(parts[1], 64);
    if (!payloadBytes || !sig || sig.length !== 64) return { reason: 'grant_invalid' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      return { reason: 'grant_invalid' };
    }
    const payload = this.shape(parsed);
    if (!payload) return { reason: 'grant_invalid' };
    // What was signed must be the canonical bytes, or one signature covers two documents.
    if (canonicalGrantJson(payload) !== payloadBytes.toString('utf8')) return { reason: 'grant_invalid' };

    const key = this.deps.keys.verifierFor(payload.kid, payload.iat);
    if (!key) return { reason: 'grant_unknown_kid' };
    let valid = false;
    try {
      valid = cryptoVerify(null, payloadBytes, key, sig);
    } catch {
      valid = false;
    }
    if (!valid) return { reason: 'grant_invalid' };

    if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_GRANT_LIFETIME_S) return { reason: 'grant_invalid' };
    const nowS = Math.floor(this.now() / 1000);
    if (nowS > payload.exp + GRANT_SKEW_S) return { reason: 'grant_expired' };
    if (nowS < payload.iat - GRANT_SKEW_S) return { reason: 'grant_not_yet_valid' };
    return { payload };
  }

  private shape(value: unknown): GrantPayload | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const p = value as Record<string, unknown>;
    if (p.v !== 1 || p.kind !== GRANT_KIND) return null;
    if (typeof p.grant_id !== 'string' || !GRANT_ID.test(p.grant_id)) return null;
    if (!IDLIKE(p.org_id) || !IDLIKE(p.branch_id) || !IDLIKE(p.bridge_id)) return null;
    if (typeof p.install_id !== 'string' || p.install_id.length < 8 || p.install_id.length > 128) return null;
    if (typeof p.token_hash !== 'string' || !SHA256_HEX.test(p.token_hash)) return null;
    if (typeof p.bridge_pubkey !== 'string' || p.bridge_pubkey.length < 40 || p.bridge_pubkey.length > 128) return null;
    if (typeof p.kid !== 'string' || p.kid.length === 0 || p.kid.length > 64) return null;
    if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return null;
    if (!Array.isArray(p.lan_keys) || p.lan_keys.length > 16) return null;
    const keys: LanKeyEntry[] = [];
    for (const raw of p.lan_keys) {
      const entry = parseKeyEntry(raw);
      if (typeof entry === 'string') return null;
      keys.push(entry);
    }
    // Rebuilt from the parsed entries so the canonical comparison is against normalised keys; a key
    // that did not survive parsing unchanged makes the whole grant non-canonical.
    return { ...(p as unknown as GrantPayload), lan_keys: keys };
  }
}

// ---------------------------------------------------------------------- active instance

let active: LanPairing | null = null;

export function setActiveLanPairing(p: LanPairing | null): void {
  active = p;
}

/** The pairing in force, or null: the loopback routes and the page ask this and are inert on null. */
export function activeLanPairing(): LanPairing | null {
  return active;
}

export { b64u };
