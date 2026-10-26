import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * A throwaway certificate for the TLS tests: what an HTTPS-inspecting antivirus hands the
 * bridge, in miniature — a chain that ends in a root no trust store has heard of.
 *
 * Generated with `openssl` at test time rather than committed, because a private key checked
 * into a repository is a finding for every secret scanner even when it guards nothing. There is
 * no openssl on PATH in some Windows shells, so a missing one is a skip, not a failure.
 */

export interface SelfSignedCertificate {
  key: string;
  cert: string;
  /** The issuer the way `peekPeerCertificate` renders it: `O=…, CN=localhost`. */
  issuer: string;
  organisation: string;
}

export function selfSignedCertificate(organisation = 'Fake Interceptor Inc'): SelfSignedCertificate | null {
  const dir = mkdtempSync(join(tmpdir(), 'hankha-bridge-selfsigned-'));
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  const res = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', keyFile, '-out', certFile,
      '-subj', `/O=${organisation}/CN=localhost`,
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  try {
    if (res.error || res.status !== 0) return null;
    return {
      key: readFileSync(keyFile, 'utf8'),
      cert: readFileSync(certFile, 'utf8'),
      issuer: `O=${organisation}, CN=localhost`,
      organisation,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
