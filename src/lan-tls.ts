/*
 * Optional HTTPS for the LAN listener (`lan.json` `"tls": {"cert_path", "key_path"}`).
 *
 * Why it exists: Safari on an iPad may refuse `http://` calls from an HTTPS page, and an iPad cannot
 * run the Android Helper gateway. Serving the LAN API over TLS with a per-Bridge certificate (see
 * `scripts/gen-lan-cert.mjs`) is the candidate path for iOS. It changes nothing for a Bridge that
 * does not configure it.
 *
 * Rules:
 *  - FAIL CLOSED. If `tls` is configured and cannot be loaded (missing file, key that does not match
 *    the certificate, passphrase-protected key, not PEM), the LAN API stays OFF. It never falls back
 *    to plain http on a port the operator asked to be https: a till that believes it talks TLS must
 *    never be served in clear.
 *  - The certificate is read once at start. Renewing needs a restart.
 *  - Things that are wrong but not fatal are WARNINGS, logged at start and carried in the load
 *    result: a private key readable by group or others, a certificate with no IP address in its SAN
 *    (clients connect by IP), one that is expired or about to expire.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface LanTlsConfig {
  cert_path: string;
  key_path: string;
}

export interface LanTlsMaterial {
  cert: Buffer;
  key: Buffer;
  /** What an operator needs to recognise the certificate in a log line. Public information. */
  info: {
    subject: string;
    issuer: string;
    fingerprint256: string;
    valid_from: string;
    valid_to: string;
    ip_sans: string[];
    dns_sans: string[];
  };
  warnings: string[];
}

export type LanTlsLoad = { ok: true; tls: LanTlsMaterial } | { ok: false; reason: string };

const MAX_PEM_BYTES = 64 * 1024;
const SOON_MS = 30 * 86_400_000;

/** Shape check only; the files are not touched. `null` is "TLS is not configured". */
export function parseTlsConfig(raw: unknown): LanTlsConfig | null | { error: string } {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'tls must be an object {cert_path, key_path}' };
  const t = raw as { cert_path?: unknown; key_path?: unknown };
  for (const field of ['cert_path', 'key_path'] as const) {
    const v = t[field];
    if (typeof v !== 'string' || v.trim() === '' || v.length > 1024 || v.includes('\0')) return { error: `tls.${field} must be a file path` };
  }
  return { cert_path: (t.cert_path as string).trim(), key_path: (t.key_path as string).trim() };
}

function readPem(path: string, what: string): { ok: true; data: Buffer } | { ok: false; reason: string } {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    return { ok: false, reason: `${what} ${path}: ${(err as NodeJS.ErrnoException).code ?? 'cannot be read'}` };
  }
  if (!st.isFile()) return { ok: false, reason: `${what} ${path} is not a file` };
  if (st.size === 0 || st.size > MAX_PEM_BYTES) return { ok: false, reason: `${what} ${path} is empty or larger than ${MAX_PEM_BYTES} bytes` };
  try {
    return { ok: true, data: readFileSync(path) };
  } catch (err) {
    return { ok: false, reason: `${what} ${path}: ${(err as NodeJS.ErrnoException).code ?? 'cannot be read'}` };
  }
}

/** Load and validate. Relative paths are relative to `dir` (the state directory). */
export function loadLanTls(config: LanTlsConfig, dir: string, now: number = Date.now()): LanTlsLoad {
  const certPath = isAbsolute(config.cert_path) ? config.cert_path : join(dir, config.cert_path);
  const keyPath = isAbsolute(config.key_path) ? config.key_path : join(dir, config.key_path);
  const warnings: string[] = [];

  const certFile = readPem(certPath, 'certificate');
  if (!certFile.ok) return certFile;
  const keyFile = readPem(keyPath, 'private key');
  if (!keyFile.ok) return keyFile;

  if (!certFile.data.toString('latin1').includes('-----BEGIN CERTIFICATE-----')) return { ok: false, reason: `certificate ${certPath} is not a PEM certificate` };
  const keyText = keyFile.data.toString('latin1');
  if (/ENCRYPTED/.test(keyText.split('\n', 3).join('\n'))) {
    return { ok: false, reason: `private key ${keyPath} is passphrase-protected; the Bridge cannot unlock it. Re-create it without a passphrase (and protect the file with its mode instead)` };
  }
  let key;
  try {
    key = createPrivateKey(keyFile.data);
  } catch {
    return { ok: false, reason: `private key ${keyPath} is not a readable unencrypted PEM private key` };
  }
  if (key.asymmetricKeyType !== 'ec' && key.asymmetricKeyType !== 'rsa') {
    return { ok: false, reason: `private key ${keyPath} is ${key.asymmetricKeyType}; use an ECDSA P-256 or RSA key (Safari does not accept others)` };
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certFile.data);
  } catch {
    return { ok: false, reason: `certificate ${certPath} cannot be parsed` };
  }
  if (!cert.checkPrivateKey(key)) return { ok: false, reason: `the private key ${keyPath} does not belong to the certificate ${certPath}` };

  // ---- warnings
  if (cert.ca) warnings.push('the certificate is a CA certificate; serve the leaf made for this Bridge, not the CA');
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (to < now) warnings.push(`the certificate EXPIRED on ${cert.validTo}: clients will refuse it until it is replaced and the Bridge restarted`);
  else if (to - now < SOON_MS) warnings.push(`the certificate expires on ${cert.validTo} (under 30 days): renew it and restart the Bridge`);
  if (from > now + 86_400_000) warnings.push(`the certificate is not valid until ${cert.validFrom}; check this computer's clock`);
  const sans = (cert.subjectAltName ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ipSans = sans.filter((s) => s.startsWith('IP Address:')).map((s) => s.slice('IP Address:'.length));
  const dnsSans = sans.filter((s) => s.startsWith('DNS:')).map((s) => s.slice('DNS:'.length));
  if (ipSans.length === 0) warnings.push('the certificate has no IP address in its subject alternative names; a till that opens https://<ip>:port will refuse it');
  if (dnsSans.some((d) => d.startsWith('*'))) warnings.push('the certificate has a wildcard name; a per-Bridge certificate should not');
  if (process.platform !== 'win32') {
    try {
      const keyMode = statSync(keyPath).mode & 0o777;
      if ((keyMode & 0o077) !== 0) warnings.push(`the private key file ${keyPath} is readable by group or others (mode ${keyMode.toString(8)}); run chmod 600 on it`);
      const certMode = statSync(certPath).mode & 0o777;
      if ((certMode & 0o022) !== 0) warnings.push(`the certificate file ${certPath} is writable by group or others (mode ${certMode.toString(8)})`);
    } catch {
      /* the stat that just worked would have to fail twice */
    }
  }

  return {
    ok: true,
    tls: {
      cert: certFile.data,
      key: keyFile.data,
      info: {
        subject: cert.subject.replace(/\n/g, ', '),
        issuer: cert.issuer.replace(/\n/g, ', '),
        fingerprint256: cert.fingerprint256,
        valid_from: cert.validFrom,
        valid_to: cert.validTo,
        ip_sans: ipSans,
        dns_sans: dnsSans,
      },
      warnings,
    },
  };
}
