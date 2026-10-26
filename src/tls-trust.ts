/*
 * TLS-trust failures: the one network fault that waiting never fixes.
 *
 * The bridge dials `https://api.hankha.la` with the root certificates compiled into the Bun
 * binary, not the ones the operating system trusts. On most tills those agree. On a venue PC
 * where an antivirus or a corporate proxy does "HTTPS inspection", every TLS connection is
 * terminated by that program and re-signed with a root it has installed into the OS store — so
 * the browser is happy, and the bridge is handed a certificate it has never heard of. Every
 * relay attempt then fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY or one of its cousins below,
 * and until this file existed that read on the status page as an uplink drop that "usually
 * reconnects on its own". It never does: the fix is a setting on that computer.
 *
 * Two things live here. `tlsTrustCode` tells that failure apart from a dropped network, in
 * whichever shape the runtime throws it — Bun puts the OpenSSL code on the error itself, Node's
 * `fetch` buries it one level down in `cause`. `peekPeerCertificate` opens one more connection,
 * WITHOUT verification, purely to read who signed the certificate that was presented, so that a
 * bridge.log sent in from a venue names the interceptor ("O=Kaspersky, CN=Kaspersky Anti-Virus
 * Personal Root Certificate") instead of only the code. Nothing is sent over that connection and
 * nothing is read from it but the handshake; every real request keeps verifying as before.
 */
import { isIP } from 'node:net';
import { connect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { errorCode } from './log.js';

/**
 * The OpenSSL verification results that mean "the chain is signed by a root this process does
 * not have" — as opposed to an expired certificate, a hostname mismatch, or no TLS at all, none
 * of which an interceptor produces and none of which NODE_EXTRA_CA_CERTS would fix.
 *
 * The same list is compiled into the status page (`page.ts`), which matches `last_error`
 * against it to choose its advice; keep it here so the two cannot drift.
 */
export const TLS_TRUST_CODES = [
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_UNTRUSTED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
] as const;

export type TlsTrustCode = (typeof TLS_TRUST_CODES)[number];

export function isTlsTrustCode(code: unknown): code is TlsTrustCode {
  return typeof code === 'string' && (TLS_TRUST_CODES as readonly string[]).includes(code);
}

/** The trust code an error carries, wherever the runtime put it, or null for any other failure. */
export function tlsTrustCode(err: unknown): TlsTrustCode | null {
  const code = errorCode(err);
  return isTlsTrustCode(code) ? code : null;
}

export interface PeerCertificateSummary {
  /** `C=US, O=Google Trust Services, CN=WE1` — the field that names an interceptor. */
  issuer: string;
  subject: string;
  fingerprint_sha256: string;
  valid_from: string;
  valid_to: string;
  /** Issuer and subject are the same name: the certificate vouches for itself. */
  self_signed: boolean;
}

/**
 * `{ C: 'US', O: 'Google Trust Services', CN: 'WE1' }` → `C=US, O=Google Trust Services, CN=WE1`.
 *
 * Attribute order is the certificate's own, which is how a vendor's root is usually written
 * in its documentation and in the Windows certificate manager — the strings an operator will
 * compare against.
 */
export function distinguishedName(name: PeerCertificate['issuer'] | undefined): string {
  if (!name || typeof name !== 'object') return '';
  return Object.entries(name as Record<string, unknown>)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : String(value)}`)
    .join(', ');
}

/**
 * Who signed the certificate `url`'s server presents right now. Null when it cannot be read —
 * a plain-http URL, a host that does not answer, no TLS on that port, or a handshake that takes
 * longer than `timeoutMs`. Never rejects: this runs from a failure path that must not fail.
 *
 * `rejectUnauthorized: false` is deliberate and confined to this one socket, which carries no
 * request: it is the only way to see the certificate behind a chain that verification refuses.
 */
export function peekPeerCertificate(url: string, timeoutMs = 5_000): Promise<PeerCertificateSummary | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(null);
  }
  if (target.protocol !== 'https:' && target.protocol !== 'wss:') return Promise.resolve(null);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port) || 443;

  return new Promise((resolve) => {
    let socket: TLSSocket | null = null;
    let done = false;
    const finish = (value: PeerCertificateSummary | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      socket = connect(
        {
          host,
          port,
          // SNI is what makes a shared edge (Cloudflare, a load balancer) present THIS host's
          // certificate rather than a default one. An IP literal is not a valid server name, so
          // none is sent for one.
          ...(isIP(host) ? {} : { servername: host }),
          rejectUnauthorized: false,
        },
        () => {
          const cert = socket?.getPeerCertificate();
          if (!cert || Object.keys(cert).length === 0) {
            finish(null);
            return;
          }
          const issuer = distinguishedName(cert.issuer);
          const subject = distinguishedName(cert.subject);
          finish({
            issuer,
            subject,
            fingerprint_sha256: cert.fingerprint256 ?? '',
            valid_from: cert.valid_from ?? '',
            valid_to: cert.valid_to ?? '',
            self_signed: issuer !== '' && issuer === subject,
          });
        },
      );
      socket.once('error', () => finish(null));
      socket.once('close', () => finish(null));
    } catch {
      finish(null);
    }
  });
}
