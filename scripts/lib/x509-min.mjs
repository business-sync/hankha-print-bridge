/*
 * A minimal X.509 v3 writer for the LAN certificate tool. No dependencies: Node's `crypto` can
 * parse certificates but cannot make them, and the machines this runs on (a venue PC, a Mac) do not
 * all have OpenSSL.
 *
 * Scope is exactly what `gen-lan-cert.mjs` needs: ECDSA P-256 keys, ecdsa-with-SHA256 signatures,
 * a name-constrained CA and a server leaf with IP (and optionally DNS) subject alternative names.
 * It is not a general certificate library; every certificate it writes is parsed back and verified
 * by Node's own X509 implementation in the tests.
 */
import { createHash, createPublicKey, randomBytes, sign as cryptoSign } from 'node:crypto';

// ---------------------------------------------------------------------- DER

const concat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));

function lengthBytes(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const der = (tag, body) => concat([tag], lengthBytes(body.length), body);
export const seq = (...items) => der(0x30, concat(...items));
export const set = (...items) => der(0x31, concat(...items));
export const octet = (buf) => der(0x04, buf);
export const bool = (v) => der(0x01, Buffer.from([v ? 0xff : 0x00]));
export const bitString = (buf, unused = 0) => der(0x03, concat([unused], buf));
export const utf8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
export const explicit = (n, body) => der(0xa0 | n, body);

export function int(value) {
  let b;
  if (typeof value === 'number') {
    const bytes = [];
    for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    b = Buffer.from(bytes.length ? bytes : [0]);
  } else {
    b = Buffer.from(value);
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i += 1;
    b = b.subarray(i);
  }
  if (b[0] & 0x80) b = concat([0], b);
  return der(0x02, b);
}

export function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

function time(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const y = date.getUTCFullYear();
  const rest = `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  return y < 2050 ? der(0x17, Buffer.from(`${p(y % 100)}${rest}`)) : der(0x18, Buffer.from(`${p(y, 4)}${rest}`));
}

/** Read one DER element at `at`: {tag, start, bodyStart, end}. */
function readElement(buf, at) {
  const tag = buf[at];
  let len = buf[at + 1];
  let bodyStart = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[at + 2 + i];
    bodyStart = at + 2 + n;
  }
  return { tag, start: at, bodyStart, end: bodyStart + len };
}

/**
 * The raw subject Name (DER) of a certificate. A leaf's issuer must be this EXACT byte string: building
 * it again from a parsed, printed form changes the encoding for any name with a character the printable
 * set lacks (an ampersand in a venue name, say) and the chain no longer verifies.
 */
export function subjectDerOf(certDer) {
  const cert = readElement(certDer, 0);
  const tbs = readElement(certDer, cert.bodyStart);
  let at = tbs.bodyStart;
  const first = readElement(certDer, at);
  if (first.tag === 0xa0) at = first.end; // [0] version
  for (let skip = 0; skip < 4; skip += 1) at = readElement(certDer, at).end; // serial, sigAlg, issuer, validity
  const subject = readElement(certDer, at);
  return Buffer.from(certDer.subarray(subject.start, subject.end));
}

// ---------------------------------------------------------------------- names and extensions

const OID = {
  cn: '2.5.4.3', o: '2.5.4.10', ou: '2.5.4.11',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', extKeyUsage: '2.5.29.37', serverAuth: '1.3.6.1.5.5.7.3.1',
  san: '2.5.29.17', nameConstraints: '2.5.29.30', ski: '2.5.29.14', aki: '2.5.29.35',
};
export const OIDS = OID;

export function name(attrs) {
  const rdn = (type, value) => set(seq(oid(OID[type]), utf8(value)));
  return seq(...Object.entries(attrs).map(([k, v]) => rdn(k, v)));
}

const extension = (dotted, critical, value) => seq(oid(dotted), ...(critical ? [bool(true)] : []), octet(value));

export function ipv4Bytes(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) throw new Error(`not an IPv4 address: ${ip}`);
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) throw new Error(`not an IPv4 address: ${ip}`);
  return Buffer.from(parts);
}

const generalNameIp = (ip) => der(0x87, ipv4Bytes(ip));
const generalNameDns = (host) => der(0x82, Buffer.from(host, 'ascii'));

const asPublic = (k) => (k.type === 'private' ? createPublicKey(k) : k);

function readTlv(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1];
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k += 1) len = len * 256 + buf[off + 2 + k];
    header = 2 + n;
  }
  return { tag, header, len, start: off + header, end: off + header + len };
}

/** The key identifier RFC 5280 suggests: SHA-1 of the subjectPublicKey bits (not the algorithm). */
export function keyIdentifier(publicKey) {
  const spki = asPublic(publicKey).export({ type: 'spki', format: 'der' });
  const outer = readTlv(spki, 0); // SEQUENCE
  const alg = readTlv(spki, outer.start); // AlgorithmIdentifier
  const bits = readTlv(spki, alg.end); // BIT STRING: first content byte is the unused-bits count
  return createHash('sha1').update(spki.subarray(bits.start + 1, bits.end)).digest();
}

// ---------------------------------------------------------------------- certificates

/**
 * @param {object} o
 * @param {Record<string,string>} o.subject
 * @param {Record<string,string>} [o.issuer]
 * @param {Buffer} [o.issuerDer]   the issuer's subject, byte for byte (preferred over `issuer`)
 * @param {import('node:crypto').KeyObject} o.publicKey      the subject's public key
 * @param {import('node:crypto').KeyObject} o.signingKey     the issuer's private key
 * @param {import('node:crypto').KeyObject} o.issuerPublicKey
 * @param {Date} o.notBefore
 * @param {Date} o.notAfter
 * @param {{ca: boolean, pathLen?: number}} o.basic
 * @param {'ca'|'server'} o.usage
 * @param {string[]} [o.sanIps]
 * @param {string[]} [o.sanDns]
 * @param {{ips: Array<[string,string]>, dns: string[]} | null} [o.nameConstraints]  permitted subtrees: [ip, mask] pairs, DNS names
 * @returns {{der: Buffer, pem: string}}
 */
export function makeCertificate(o) {
  const exts = [];
  exts.push(extension(OID.basicConstraints, true, o.basic.ca ? seq(bool(true), int(o.basic.pathLen ?? 0)) : seq()));
  exts.push(extension(OID.keyUsage, true, o.usage === 'ca' ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)));
  if (o.usage === 'server') exts.push(extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))));
  exts.push(extension(OID.ski, false, octet(keyIdentifier(o.publicKey))));
  if (!o.selfSigned) exts.push(extension(OID.aki, false, seq(der(0x80, keyIdentifier(o.issuerPublicKey)))));
  else exts.push(extension(OID.aki, false, seq(der(0x80, keyIdentifier(o.publicKey)))));
  if ((o.sanIps?.length ?? 0) + (o.sanDns?.length ?? 0) > 0) {
    exts.push(extension(OID.san, false, seq(...(o.sanIps ?? []).map(generalNameIp), ...(o.sanDns ?? []).map(generalNameDns))));
  }
  if (o.nameConstraints) {
    const subtrees = [
      ...o.nameConstraints.ips.map(([ip, mask]) => seq(der(0x87, concat(ipv4Bytes(ip), ipv4Bytes(mask))))),
      ...o.nameConstraints.dns.map((host) => seq(generalNameDns(host))),
    ];
    exts.push(extension(OID.nameConstraints, true, seq(der(0xa0, concat(...subtrees)))));
  }

  const sigAlg = seq(oid(OID.ecdsaSha256));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  const tbs = seq(
    explicit(0, int(2)),
    int(serial),
    sigAlg,
    o.issuerDer ?? name(o.issuer),
    seq(time(o.notBefore), time(o.notAfter)),
    name(o.subject),
    asPublic(o.publicKey).export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...exts))
  );
  const signature = cryptoSign('sha256', tbs, o.signingKey); // ECDSA, DER-encoded: what X.509 wants
  const certDer = seq(tbs, sigAlg, bitString(signature, 0));
  const b64 = certDer.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
  return { der: certDer, pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n` };
}
