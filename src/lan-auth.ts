/*
 * Who may print over the LAN, and proof that it was this Bridge that said yes.
 *
 * The wire rules are in docs/printing/LAN_WIRE_CONTRACT.md §2-3; this file is the Bridge's half.
 * The shape of it:
 *
 *   ticket    Ed25519, signed by the backend. Names one terminal, one Bridge, one terminal key.
 *   request   ECDSA P-256, signed by that terminal key over method, path, body hash and a nonce.
 *   nonce     Issued by `hello`, with a counter that must rise. Replay protection that needs no
 *             agreement about the time of day, which tills do not have.
 *   ack       Ed25519, signed by THIS Bridge, so a terminal can tell it from an app squatting on
 *             the port.
 *
 * Order matters in `verify`: the signature is checked BEFORE a counter is consumed. `hello` is
 * unsigned, so every nonce is public to anyone on the network; if an unsigned request could move a
 * counter, one packet would lock a real terminal out of its own nonce.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { fromB64u, type LanKeyStore } from './lan-keys.js';

export const SIGNING_PREFIX = 'HANKHA-LAN1';
export const ACK_PREFIX = 'HANKHA-LAN1-ACK';

/** A nonce lives this long from the moment `hello` issued it. */
export const NONCE_TTL_MS = 5 * 60_000;
/** Issued nonces kept; the oldest is evicted past this. */
export const NONCE_CAP = 1_024;
/** The longest a ticket may be valid. */
export const MAX_TICKET_LIFETIME_S = 30 * 86_400;
/** How far past `exp` the Bridge still believes a ticket: tills have wrong clocks. */
export const TICKET_SKEW_S = 86_400;

export interface TicketPayload {
  v: 1;
  org_id: string | number;
  branch_id: string | number;
  terminal_id: string | number;
  bridge_id: string | number;
  bridge_pubkey: string;
  terminal_pubkey: string;
  kid: string;
  iat: number;
  exp: number;
}

/** The order the contract signs the payload in. */
const TICKET_FIELDS = [
  'v', 'org_id', 'branch_id', 'terminal_id', 'bridge_id', 'bridge_pubkey', 'terminal_pubkey', 'kid', 'iat', 'exp',
] as const;

/** `canonical_json`: JSON.stringify with the contract's key order and no whitespace. */
export function canonicalTicketJson(payload: TicketPayload): string {
  const ordered: Record<string, unknown> = {};
  for (const field of TICKET_FIELDS) ordered[field] = payload[field];
  return JSON.stringify(ordered);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function signingString(method: string, target: string, body: Buffer, nonceHeader: string): string {
  return `${SIGNING_PREFIX}\n${method}\n${target}\n${sha256Hex(body)}\n${nonceHeader}`;
}

export function ackString(dedupeKey: string, jobId: string, acceptedAt: string, nonceHeader: string): string {
  return `${ACK_PREFIX}\n${dedupeKey}\n${jobId}\n${acceptedAt}\n${nonceHeader}`;
}

// ---------------------------------------------------------------------- the nonce store

interface NonceRecord {
  issuedAt: number;
  highest: number;
}

export class NonceStore {
  private readonly nonces = new Map<string, NonceRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = NONCE_TTL_MS,
    private readonly cap = NONCE_CAP,
    /** Overridden by the test vectors, which need a nonce they can write down in advance. */
    private readonly mint: () => string = () => randomBytes(16).toString('base64url')
  ) {}

  issue(): string {
    const nonce = this.mint();
    this.sweep();
    this.nonces.set(nonce, { issuedAt: this.now(), highest: 0 });
    while (this.nonces.size > this.cap) {
      const oldest = this.nonces.keys().next().value;
      if (oldest === undefined) break;
      this.nonces.delete(oldest);
    }
    return nonce;
  }

  /** Read-only: is this a live nonce, and would `counter` be accepted? Nothing is consumed. */
  peek(nonce: string, counter: number): boolean {
    const record = this.nonces.get(nonce);
    if (!record) return false;
    if (this.now() - record.issuedAt > this.ttlMs) {
      this.nonces.delete(nonce);
      return false;
    }
    return counter > record.highest;
  }

  /** Consume `counter`. False for an unknown or expired nonce, or a counter that did not rise. */
  consume(nonce: string, counter: number): boolean {
    if (!this.peek(nonce, counter)) return false;
    const record = this.nonces.get(nonce);
    if (record) record.highest = counter;
    return true;
  }

  get size(): number {
    return this.nonces.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, record] of this.nonces) {
      // Insertion order is issue order, so the first live one ends the sweep.
      if (now - record.issuedAt <= this.ttlMs) break;
      this.nonces.delete(nonce);
    }
  }
}

// ---------------------------------------------------------------------- verification

export interface AuthOk {
  ok: true;
  ticket: TicketPayload;
  /** The `X-Hankha-Nonce` header value, as sent. */
  nonceHeader: string;
}

export interface AuthFail {
  ok: false;
  status: 401;
  reason: string;
}

export interface AuthInput {
  method: string;
  /** The request target exactly as it arrived: path and query. */
  target: string;
  body: Buffer;
  ticket: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
}

const fail = (reason: string): AuthFail => ({ ok: false, status: 401, reason });

const NONCE_HEADER = /^([A-Za-z0-9_-]{8,64})\.([1-9][0-9]{0,14})$/;
const IDLIKE = (v: unknown): v is string | number =>
  (typeof v === 'string' && v.length > 0 && v.length <= 128) || (typeof v === 'number' && Number.isSafeInteger(v));

export interface LanAuthOptions {
  keys: LanKeyStore;
  /** This Bridge's id once paired, null before. */
  bridgeId: () => string | null;
  now?: () => number;
  /** Test seam: how hello nonces are made. Never set in production. */
  mintNonce?: () => string;
}

export class LanAuth {
  readonly nonces: NonceStore;
  private readonly now: () => number;
  private readonly terminalKeys = new Map<string, KeyObject>();

  constructor(private readonly opts: LanAuthOptions) {
    this.now = opts.now ?? Date.now;
    this.nonces = new NonceStore(this.now, NONCE_TTL_MS, NONCE_CAP, opts.mintNonce);
  }

  /** `GET /hello` — the only unsigned call. */
  issueNonce(): string {
    return this.nonces.issue();
  }

  /** Sign the acknowledgement of an accepted job. */
  ack(dedupeKey: string, jobId: string, acceptedAt: string, nonceHeader: string) {
    return {
      dedupe_key: dedupeKey,
      accepted_at: acceptedAt,
      nonce: nonceHeader,
      sig: this.opts.keys.sign(ackString(dedupeKey, jobId, acceptedAt, nonceHeader)),
    };
  }

  verify(input: AuthInput): AuthOk | AuthFail {
    if (!input.ticket) return fail('ticket_missing');
    if (!input.nonce) return fail('nonce_missing');
    if (!input.signature) return fail('signature_missing');

    const ticket = this.verifyTicket(input.ticket);
    if ('reason' in ticket) return fail(ticket.reason);

    const nonce = NONCE_HEADER.exec(input.nonce);
    if (!nonce) return fail('nonce_malformed');
    const counter = Number(nonce[2]);

    const terminalKey = this.terminalKey(ticket.payload.terminal_pubkey);
    if (!terminalKey) return fail('ticket_invalid');
    const signature = fromB64u(input.signature, 64);
    // P-256 r||s is exactly 64 bytes. A DER signature (the WebCrypto-vs-OpenSSL trap) is longer and
    // is refused here rather than being let near the verifier.
    if (!signature || signature.length !== 64) return fail('bad_signature');
    const signed = Buffer.from(signingString(input.method, input.target, input.body, input.nonce), 'utf8');
    let valid = false;
    try {
      valid = cryptoVerify('sha256', signed, { key: terminalKey, dsaEncoding: 'ieee-p1363' }, signature);
    } catch {
      valid = false;
    }
    if (!valid) return fail('bad_signature');

    // Only now, with a signature that proves the sender holds the terminal key.
    if (!this.nonces.consume(nonce[1] as string, counter)) return fail('replayed_or_unknown_nonce');
    return { ok: true, ticket: ticket.payload, nonceHeader: input.nonce };
  }

  /** Exported for the vectors: verifies a ticket alone, against this Bridge's keys, id and clock. */
  verifyTicket(ticket: string): { payload: TicketPayload } | { reason: string } {
    const parts = ticket.split('.');
    if (parts.length !== 2 || ticket.length > 4_096) return { reason: 'ticket_invalid' };
    const payloadBytes = fromB64u(parts[0], 3_072);
    const sig = fromB64u(parts[1], 64);
    if (!payloadBytes || !sig || sig.length !== 64) return { reason: 'ticket_invalid' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      return { reason: 'ticket_invalid' };
    }
    const payload = this.shape(parsed);
    if (!payload) return { reason: 'ticket_invalid' };
    // The signature covers bytes, so what was signed must be what the contract says gets signed.
    // A payload that parses but is not in canonical form (reordered keys, spaces, a repeated key)
    // is two different documents wearing one signature.
    if (canonicalTicketJson(payload) !== payloadBytes.toString('utf8')) return { reason: 'ticket_invalid' };

    const key = this.opts.keys.verifierFor(payload.kid, payload.iat);
    if (!key) return { reason: 'unknown_kid' };
    let valid = false;
    try {
      valid = cryptoVerify(null, payloadBytes, key, sig);
    } catch {
      valid = false;
    }
    if (!valid) return { reason: 'ticket_invalid' };

    if (payload.v !== 1) return { reason: 'ticket_invalid' };
    if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_TICKET_LIFETIME_S) return { reason: 'ticket_invalid' };
    const nowS = Math.floor(this.now() / 1000);
    if (nowS > payload.exp + TICKET_SKEW_S) return { reason: 'ticket_expired' };

    const own = this.opts.bridgeId();
    // An unpaired Bridge has no id to match, so it matches no ticket.
    if (own === null || String(payload.bridge_id) !== own) return { reason: 'wrong_bridge' };
    // The ticket must name THIS Bridge's acknowledgement key, or the terminal would be handed acks
    // it cannot verify (after a key was regenerated) — better refused here, where the cause is clear.
    if (payload.bridge_pubkey !== this.opts.keys.publicKey()) return { reason: 'bridge_key_mismatch' };
    return { payload };
  }

  private shape(value: unknown): TicketPayload | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const p = value as Record<string, unknown>;
    if (p.v !== 1) return null;
    if (!IDLIKE(p.org_id) || !IDLIKE(p.branch_id) || !IDLIKE(p.terminal_id) || !IDLIKE(p.bridge_id)) return null;
    if (typeof p.bridge_pubkey !== 'string' || typeof p.terminal_pubkey !== 'string') return null;
    if (typeof p.kid !== 'string' || p.kid.length === 0 || p.kid.length > 64) return null;
    if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return null;
    return p as unknown as TicketPayload;
  }

  /** The terminal's P-256 key, parsed once per distinct key. */
  private terminalKey(spki: string): KeyObject | null {
    const cached = this.terminalKeys.get(spki);
    if (cached) return cached;
    const der = fromB64u(spki, 256);
    if (!der) return null;
    try {
      const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
      if (this.terminalKeys.size >= 256) this.terminalKeys.clear();
      this.terminalKeys.set(spki, key);
      return key;
    } catch {
      return null;
    }
  }
}
