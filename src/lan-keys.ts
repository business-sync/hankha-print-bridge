/*
 * The keys behind the LAN print API.
 *
 * Two kinds, and they point opposite ways:
 *
 *  - The BRIDGE'S OWN Ed25519 key signs the acknowledgement of every accepted job. Its public half
 *    travels to the terminal inside the ticket (`bridge_pubkey`), which is what lets a terminal
 *    tell this Bridge from an app squatting on the port: only the holder of this key can produce a
 *    signature the terminal will accept. Created on first use, kept at mode 0600, and never sent
 *    anywhere but as its public half.
 *  - The BACKEND'S Ed25519 ticket keys, as a `kid` key set, verify tickets. The set arrives from
 *    the backend (enrolment and every heartbeat answer carry `lan_keys`) and from the local setter,
 *    and is persisted so a Bridge that has never again seen the internet keeps verifying.
 *
 * Nothing here runs unless the LAN API is switched on (`lan.json`). A Bridge with it off creates no
 * key file and writes no key set: it is byte-for-byte the M1 Bridge on disk.
 */
import {
  createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileDurable } from './durable-fs.js';
import { log } from './log.js';

export const LAN_KEY_FILE = 'lan-key.json';
export const LAN_KEYSET_FILE = 'lan-keys.json';

export function b64u(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

/** Strict base64url (no padding, no other alphabet): a lenient decode would give two spellings per value. */
export function fromB64u(value: unknown, maxBytes = 16_384): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil((maxBytes * 4) / 3)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const out = Buffer.from(value, 'base64url');
  return out.toString('base64url') === value ? out : null;
}

export interface LanKeyEntry {
  /** Names the key in a ticket. */
  kid: string;
  /** Ed25519 SPKI DER, base64url. */
  pubkey: string;
  /** Unix seconds. A ticket is checked against its own `iat`, not the Bridge's clock. */
  not_before: number;
  /** Unix seconds, or null for no end. */
  not_after: number | null;
}

/*
 * PLACEHOLDER — NOT A REAL TRUST ANCHOR.
 *
 * The one backend key pinned in the binary, so a Bridge that never reaches the internet can still
 * verify a ticket. The production signing key does not exist yet: where it lives is an open
 * decision (plan, M6). This is the public half of a key pair generated for the purpose and then
 * THROWN AWAY — nobody holds the private half, so nothing verifies against it. Until M6 replaces
 * it, a Bridge accepts tickets only for keys delivered through `lan_keys` or `setKeys`.
 *
 * Never put a published key here (the test vectors' backend key is published, private half and
 * all): that would let anyone mint tickets this Bridge accepts.
 */
export const BOOTSTRAP_KEYS: readonly LanKeyEntry[] = [
  {
    kid: 'bootstrap-placeholder',
    pubkey: 'MCowBQYDK2VwAyEAwfDr56-VFRF-9AZHUchksUzqEjUySSGh34hYGPTboUs',
    not_before: 0,
    not_after: null,
  },
];

const KID = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_KEYS = 16;

function publicKeyOf(spki: string): KeyObject | null {
  const der = fromB64u(spki, 512);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** One entry, or the reason it was refused. */
export function parseKeyEntry(raw: unknown): LanKeyEntry | string {
  if (!raw || typeof raw !== 'object') return 'not an object';
  const e = raw as Record<string, unknown>;
  if (typeof e.kid !== 'string' || !KID.test(e.kid)) return 'kid is missing or malformed';
  if (typeof e.pubkey !== 'string' || !publicKeyOf(e.pubkey)) return `key ${e.kid}: pubkey is not an Ed25519 SPKI`;
  const notBefore = e.not_before === undefined ? 0 : e.not_before;
  if (typeof notBefore !== 'number' || !Number.isFinite(notBefore) || notBefore < 0) return `key ${e.kid}: not_before must be unix seconds`;
  const notAfter = e.not_after === undefined || e.not_after === null ? null : e.not_after;
  if (notAfter !== null && (typeof notAfter !== 'number' || !Number.isFinite(notAfter) || notAfter <= notBefore)) {
    return `key ${e.kid}: not_after must be unix seconds after not_before, or null`;
  }
  return { kid: e.kid, pubkey: e.pubkey, not_before: notBefore, not_after: notAfter };
}

export interface SetKeysResult {
  accepted: number;
  rejected: string[];
  changed: boolean;
}

interface BridgeKey {
  priv: KeyObject;
  publicSpki: string;
}

export class LanKeyStore {
  private bridge: BridgeKey | null = null;
  private persisted: LanKeyEntry[] = [];
  private readonly keyObjects = new Map<string, KeyObject>();

  constructor(
    private readonly dir: string,
    private readonly bootstrap: readonly LanKeyEntry[] = BOOTSTRAP_KEYS
  ) {
    this.loadKeySet();
  }

  // ------------------------------------------------------------------ the Bridge's own key

  private keyPath(): string {
    return join(this.dir, LAN_KEY_FILE);
  }

  /** Loads the key pair, creating and persisting one the first time. */
  private ensureBridgeKey(): BridgeKey {
    if (this.bridge) return this.bridge;
    const path = this.keyPath();
    if (existsSync(path)) {
      try {
        const file = JSON.parse(readFileSync(path, 'utf8')) as { private_key?: string };
        const der = fromB64u(file.private_key, 256);
        if (!der) throw new Error('private_key is not valid');
        const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
        if (priv.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
        const publicSpki = b64u(createPublicKey(priv).export({ type: 'spki', format: 'der' }));
        this.bridge = { priv, publicSpki };
        return this.bridge;
      } catch (err) {
        // Not regenerated silently and not deleted: every ticket issued so far names the old public
        // key, so this is an event worth a line and a kept copy, not a quiet repair.
        const kept = `${path}.unreadable-${Date.now()}`;
        try {
          renameSync(path, kept);
        } catch {
          /* the new key replaces it either way */
        }
        log.error(`lan: the Bridge's key file is unreadable (${err instanceof Error ? err.message : String(err)}) — made a new one; tickets issued for the old key will be refused until they are renewed`, {
          event: 'lan.key.unreadable', kept, err,
        });
      }
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicSpki = b64u(publicKey.export({ type: 'spki', format: 'der' }));
    mkdirSync(this.dir, { recursive: true });
    writeFileDurable(
      path,
      `${JSON.stringify({
        v: 1,
        created_at: new Date().toISOString(),
        // The secret. Mode 0600 from creation (see writeFileDurable), then asserted below.
        private_key: b64u(privateKey.export({ type: 'pkcs8', format: 'der' })),
        public_key: publicSpki,
      })}\n`,
      `${path}.tmp`,
      0o600
    );
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows has no POSIX modes; the ProgramData ACL is the boundary there */
    }
    log.info('lan: created this Bridge\'s acknowledgement key', { event: 'lan.key.created' });
    this.bridge = { priv: privateKey, publicSpki };
    return this.bridge;
  }

  /** The public half the terminal sees in its ticket: SPKI DER, base64url. */
  publicKey(): string {
    return this.ensureBridgeKey().publicSpki;
  }

  /** Ed25519 signature, base64url. */
  sign(data: string): string {
    return b64u(cryptoSign(null, Buffer.from(data, 'utf8'), this.ensureBridgeKey().priv));
  }

  // ------------------------------------------------------------------ the ticket key set

  private setPath(): string {
    return join(this.dir, LAN_KEYSET_FILE);
  }

  private loadKeySet(): void {
    const path = this.setPath();
    if (!existsSync(path)) return;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { keys?: unknown };
      const parsed = this.validate(file.keys);
      this.persisted = parsed.keys;
    } catch (err) {
      log.warn('lan: the ticket key set is unreadable — using the pinned key only until the backend sends it again', {
        event: 'lan.keyset.unreadable', err,
      });
    }
  }

  private validate(raw: unknown): { keys: LanKeyEntry[]; rejected: string[] } {
    const keys: LanKeyEntry[] = [];
    const rejected: string[] = [];
    if (!Array.isArray(raw)) return { keys, rejected: ['keys must be an array'] };
    const pinned = new Set(this.bootstrap.map((k) => k.kid));
    const seen = new Set<string>();
    for (const item of raw.slice(0, MAX_KEYS)) {
      const entry = parseKeyEntry(item);
      if (typeof entry === 'string') {
        rejected.push(entry);
      } else if (pinned.has(entry.kid)) {
        rejected.push(`key ${entry.kid}: the kid belongs to a key pinned in this build`);
      } else if (seen.has(entry.kid)) {
        rejected.push(`key ${entry.kid}: listed twice`);
      } else {
        seen.add(entry.kid);
        keys.push(entry);
      }
    }
    if (raw.length > MAX_KEYS) rejected.push(`only the first ${MAX_KEYS} keys are read`);
    return { keys, rejected };
  }

  /**
   * Replace the backend's key set — the local setter, and what `lan_keys` from the backend calls.
   *
   * An answer with no usable key changes nothing: a backend that returns an empty list by mistake
   * must not lock every terminal out of a till that cannot reach the internet to be fixed. The
   * pinned key is never removed by this.
   */
  setKeys(raw: unknown): SetKeysResult {
    const { keys, rejected } = this.validate(raw);
    if (keys.length === 0) return { accepted: 0, rejected, changed: false };
    const changed = JSON.stringify(keys) !== JSON.stringify(this.persisted);
    if (changed) {
      mkdirSync(this.dir, { recursive: true });
      writeFileDurable(this.setPath(), `${JSON.stringify({ v: 1, updated_at: new Date().toISOString(), keys }, null, 2)}\n`);
      this.persisted = keys;
      this.keyObjects.clear();
      log.info(`lan: ticket key set updated (${keys.map((k) => k.kid).join(', ')})`, {
        event: 'lan.keyset.updated', kids: keys.map((k) => k.kid),
      });
    }
    if (rejected.length > 0) {
      log.warn(`lan: ${rejected.length} key(s) in the ticket key set were ignored: ${rejected.join('; ')}`, {
        event: 'lan.keyset.rejected', rejected,
      });
    }
    return { accepted: keys.length, rejected, changed };
  }

  /** Every key this Bridge would verify with: the pinned ones, then the delivered ones. */
  keys(): LanKeyEntry[] {
    return [...this.bootstrap, ...this.persisted];
  }

  /**
   * The key that may verify a ticket issued at `iat` (unix seconds) under `kid`.
   *
   * Validity is judged against the ticket's own issue time, never the Bridge's clock: tills have
   * wrong clocks, and a key rotated out last week must still verify a ticket it issued before.
   */
  verifierFor(kid: string, iat: number): KeyObject | null {
    for (const entry of this.keys()) {
      if (entry.kid !== kid) continue;
      if (iat < entry.not_before || (entry.not_after !== null && iat > entry.not_after)) continue;
      const cached = this.keyObjects.get(`${entry.kid}:${entry.pubkey}`);
      if (cached) return cached;
      const key = publicKeyOf(entry.pubkey);
      if (key) this.keyObjects.set(`${entry.kid}:${entry.pubkey}`, key);
      return key;
    }
    return null;
  }

  /** The kids this Bridge can verify, for the heartbeat. Public information. */
  kids(): string[] {
    return this.keys().map((k) => k.kid);
  }
}

// ---------------------------------------------------------------------- process-wide instance

let active: LanKeyStore | null = null;

/** Set when the LAN API starts; null while it is off, which is how every other module tells. */
export function setActiveLanKeys(store: LanKeyStore | null): void {
  active = store;
}

export function activeLanKeys(): LanKeyStore | null {
  return active;
}

/**
 * Hand over a `lan_keys` field from an enrolment or heartbeat answer.
 *
 * A no-op while the LAN API is off: an off-by-default feature writes nothing to disk. The keys
 * arrive again with the next heartbeat after it is switched on.
 */
export function applyRelayLanKeys(raw: unknown): void {
  if (raw === undefined || raw === null || !active) return;
  active.setKeys(raw);
}
