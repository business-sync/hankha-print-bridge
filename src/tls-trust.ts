/*
 * TLS-trust failures: the one network fault that waiting never fixes — and the one whose cause
 * must not be guessed.
 *
 * The bridge dials `https://api.hankha.la` with the root certificates compiled into the Bun
 * binary, not the ones the operating system trusts. A relay attempt that fails with
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY or one of its cousins below has one of two causes, and they
 * need opposite advice:
 *
 * - A program on that PC — an antivirus or a corporate proxy doing "HTTPS inspection" — is
 *   terminating the connection and re-signing it with its own root. The bridge is then handed a
 *   certificate issued by "Kaspersky Anti-Virus Personal Root" or the like, and the fix is a
 *   setting in that program.
 * - The runtime itself failed to build the chain to a public root it carries. 1.14.6 assumed the
 *   first cause for every such code, and a Windows till where Bun 1.3.11's `fetch` refused a
 *   valid Google Trust Services chain — while `new WebSocket()` in the same process verified it —
 *   was told to look for an antivirus that was not there (release-notes/v1.14.7.md). The fix for
 *   this one is a newer bridge; no antivirus setting and no added root certificate helps.
 *
 * `tlsTrustCode` tells the failure apart from a dropped network, in whichever shape the runtime
 * throws it — Bun puts the OpenSSL code on the error itself, Node's `fetch` buries it one level
 * down in `cause`. `peekPeerCertificate` opens one more connection, WITHOUT failing on
 * verification, to read who signed the certificate that was presented and whether `node:tls`
 * in this same process accepts the chain. `classifyTlsTrust` turns that into the verdict the log
 * and the status page act on. Nothing is sent over the peek connection and nothing is read from
 * it but the handshake; every real request keeps verifying as before.
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
  /**
   * Whether `node:tls` in THIS process verified the chain against its default trust store. The
   * peek runs with `rejectUnauthorized: false`, which keeps the socket open on failure but still
   * records the verdict here — so a chain that `fetch` refused and `node:tls` accepts is caught
   * in the act, without a second connection.
   */
  authorized: boolean;
  /** The OpenSSL code `node:tls` gave when `authorized` is false; null when it verified. */
  authorization_error: string | null;
}

/**
 * Issuers that are public, browser-trusted certificate authorities, by the organisation or
 * common name they put in the certificates they sign. A leaf for api.hankha.la issued by one of
 * these is the real certificate — an interceptor signs with its own name, never one of these —
 * and a bridge that cannot verify it has a fault in its own trust store, not an interceptor.
 *
 * Deliberately a list of names the certificate itself carries, not a list of roots: the peek
 * only ever sees the leaf (the runtime stops reporting the chain once verification failed), and
 * Cloudflare moves api.hankha.la between Google Trust Services, Let's Encrypt and SSL.com
 * without notice. Matched case-insensitively against the rendered issuer DN.
 */
export const PUBLIC_CA_RE =
  /(^|[=, ])(google trust services|let'?s encrypt|internet security research group|isrg|digicert|globalsign|sectigo|comodo|usertrust|amazon|cloudflare|ssl\.com|entrust|identrust|godaddy|go daddy|starfield|buypass|zerossl|actalis|certum|geotrust|thawte|rapidssl|quovadis|harica|telia|swisssign|d-trust|microsoft (rsa|ecc|azure)|apple public|certainly|trustasia|wotrus)( |,|$|\b)/i;

/** True when `issuer` (a DN as `distinguishedName` renders it) names a public certificate authority. */
export function publicCaIssuer(issuer: string): boolean {
  return PUBLIC_CA_RE.test(issuer);
}

/**
 * What the failure IS, which is what the advice hangs on.
 *
 * - `intercepted`: the certificate presented is signed by something that is not a public CA, and
 *   nothing in this process accepts it. A program on this computer is re-signing HTTPS.
 * - `runtime`: the certificate is the real one — a public issuer, or a chain `node:tls` in this
 *   same process accepts, or one `fetch` accepted once handed the bundled roots explicitly — and
 *   the runtime still refused it. A fault in this bridge build, to be fixed by a newer one.
 * - `unverified`: the certificate could not even be read back (no answer, no TLS on that port),
 *   so neither cause can be named.
 */
export type TlsTrustKind = 'intercepted' | 'runtime' | 'unverified';

export interface TlsTrustVerdict {
  kind: TlsTrustKind;
  code: TlsTrustCode;
  /** The issuer of the certificate presented, when it could be read. */
  issuer: string | null;
  /** One sentence of evidence for `kind`, for the log line. */
  evidence: string;
}

export interface TlsTrustInput {
  code: TlsTrustCode;
  cert: PeerCertificateSummary | null;
  /**
   * What happened when the same request was retried with the bundled roots passed to `fetch`
   * explicitly (see relay-fetch.ts): `verified` settles it as a runtime fault; `failed` means
   * the chain really does not end in a bundled root; null when no such retry ran.
   */
  explicit_roots?: 'verified' | 'failed' | null;
}

/**
 * The verdict, from the strongest evidence down. Verification by another TLS client in this
 * process, or by `fetch` once handed the roots it should have had, beats the issuer's name; the
 * name alone is still enough to refuse the interception verdict, because an interceptor cannot
 * sign as Google Trust Services. A self-signed leaf, or an issuer no browser has heard of, with
 * nothing in the process accepting it, is an interceptor.
 */
export function classifyTlsTrust(input: TlsTrustInput): TlsTrustVerdict {
  const { code, cert } = input;
  const issuer = cert?.issuer || null;
  if (input.explicit_roots === 'verified') {
    return {
      kind: 'runtime', code, issuer,
      evidence: 'fetch verified the same chain once handed the root certificates bundled in this binary',
    };
  }
  if (cert?.authorized) {
    return {
      kind: 'runtime', code, issuer,
      evidence: 'node:tls in this same process verifies the chain against the same bundled roots',
    };
  }
  if (cert && !cert.self_signed && publicCaIssuer(cert.issuer)) {
    return {
      kind: 'runtime', code, issuer,
      evidence: `the certificate is issued by a public certificate authority (${cert.issuer})${
        input.explicit_roots === 'failed' ? ', although the bundled roots passed explicitly did not verify it either' : ''
      }`,
    };
  }
  if (cert) {
    return {
      kind: 'intercepted', code, issuer,
      evidence: cert.self_signed
        ? 'the certificate presented is self-signed'
        : `the certificate presented is issued by "${cert.issuer}", which is not a public certificate authority, and nothing in this process accepts it`,
    };
  }
  return {
    kind: 'unverified', code, issuer: null,
    evidence: 'the certificate could not be read back to name its issuer',
  };
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
 * Who signed the certificate `url`'s server presents right now, and whether `node:tls` here
 * accepts it. Null when it cannot be read — a plain-http URL, a host that does not answer, no
 * TLS on that port, or a handshake that takes longer than `timeoutMs`. Never rejects: this runs
 * from a failure path that must not fail.
 *
 * `rejectUnauthorized: false` is deliberate and confined to this one socket, which carries no
 * request: it is the only way to see the certificate behind a chain that verification refuses.
 * The socket still verifies — it just does not hang up on failure — and `authorized` is that
 * result.
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
          const authorized = socket?.authorized === true;
          const authorizationError = socket?.authorizationError;
          finish({
            issuer,
            subject,
            fingerprint_sha256: cert.fingerprint256 ?? '',
            valid_from: cert.valid_from ?? '',
            valid_to: cert.valid_to ?? '',
            self_signed: issuer !== '' && issuer === subject,
            authorized,
            authorization_error: authorized
              ? null
              : typeof authorizationError === 'string'
                ? authorizationError
                : (errorCode(authorizationError) ?? (authorizationError ? String(authorizationError) : null)),
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
