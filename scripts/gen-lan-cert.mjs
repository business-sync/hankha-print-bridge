#!/usr/bin/env node
/*
 * Make the HTTPS certificate for a Bridge's LAN listener, and the iPad profile that trusts it.
 *
 *   node scripts/gen-lan-cert.mjs --out ./venue-cert --ip 192.168.1.50 [--ip 192.168.1.51] \
 *        [--hostname bridge.local] [--venue "Dok Champa"]
 *
 * Writes into --out:
 *   ca.key.pem                     the venue's local CA PRIVATE KEY. Mode 0600. NEVER copy it to the Bridge PC
 *                                  or to any iPad. Keep it offline (a USB stick in a drawer is fine).
 *   ca.crt.pem                     the CA certificate (public)
 *   ca.json                        what the CA is allowed to vouch for (public, used for --renew)
 *   bridge.key.pem                 the Bridge's TLS PRIVATE KEY. Mode 0600. Goes to the Bridge PC only.
 *   bridge.crt.pem                 the Bridge's certificate (public). IP addresses in its SAN, no wildcard.
 *   hankha-bridge-ca.mobileconfig  iOS/iPadOS profile carrying ONLY the CA certificate (public)
 *   lan.json.snippet               the "tls" block to add to the Bridge's lan.json
 *
 * Design rules this tool enforces:
 *   - ONE CA PER VENUE. Never reuse a CA, a profile or a key across venues: a profile installed on
 *     an iPad makes that iPad trust whatever this CA signs.
 *   - The CA is NAME-CONSTRAINED (RFC 5280 4.2.1.10) to the Bridge IP address(es) you give (plus one
 *     reserved DNS name so no real website name can ever be signed). A stolen CA key therefore cannot
 *     be used to impersonate a bank or any other site to a device that installed the profile. The
 *     constraint is checked by OpenSSL/Node here; whether iOS enforces it as written is a checklist
 *     item for a real iPad (--no-name-constraints exists ONLY to diagnose that, and is loud about it).
 *   - Leaf certificates carry IP SANs (browsers connect to https://192.168.x.y), valid 365 days by
 *     default and never more than 825 (iOS 13+ refuses longer for every server certificate).
 *   - Nothing is written outside --out and nothing is sent anywhere. Private keys are created with
 *     mode 0600 from the first byte.
 *
 * No dependencies; Node >= 22. Without OpenSSL on the machine this still works.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID, X509Certificate } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeCertificate, subjectDerOf } from './lib/x509-min.mjs';

const FILES = {
  caKey: 'ca.key.pem', caCrt: 'ca.crt.pem', caMeta: 'ca.json', key: 'bridge.key.pem', crt: 'bridge.crt.pem',
  profile: 'hankha-bridge-ca.mobileconfig', snippet: 'lan.json.snippet',
};
const RESERVED_DNS = 'bridge.invalid';
const DAY = 86_400_000;

// ---------------------------------------------------------------------- arguments

function parse(argv) {
  const o = {
    out: null, ips: [], hostname: null, venue: 'venue', days: 365, caDays: 1825, caSubnet: null,
    renew: false, newCa: false, allowLoopback: false, noNameConstraints: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--out') o.out = next();
    else if (a === '--ip') o.ips.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--hostname') o.hostname = next().toLowerCase();
    else if (a === '--venue') o.venue = next();
    else if (a === '--days') o.days = Number(next());
    else if (a === '--ca-days') o.caDays = Number(next());
    else if (a === '--ca-subnet') o.caSubnet = next();
    else if (a === '--renew') o.renew = true;
    else if (a === '--new-ca') o.newCa = true;
    else if (a === '--allow-loopback') o.allowLoopback = true;
    else if (a === '--no-name-constraints') o.noNameConstraints = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const USAGE = `usage: gen-lan-cert.mjs --out <dir> --ip <bridge ipv4> [--ip <more>] [--hostname <name>] [--venue <name>]
                       [--days 365] [--ca-days 1825] [--ca-subnet 192.168.1.0/24]
                       [--renew | --new-ca] [--allow-loopback] [--no-name-constraints]

  --out        directory to write into (created, mode 0700)
  --ip         the Bridge's LAN IPv4 address(es); private ranges only. Give the address the iPad will type.
               Reserve it in the router (DHCP reservation): a changed address needs a new certificate.
  --hostname   optional DNS name for the leaf (e.g. bridge.local); added to the CA's constraint as well
  --venue      shown in the CA's name; one CA per venue
  --days       leaf validity, at most 825 (default 365)
  --ca-subnet  let the CA vouch for a whole /24 instead of just the --ip addresses, so a re-issued leaf for
               another address in it needs no new iPad profile (a wider promise: your call)
  --renew      issue a NEW leaf from the existing CA in --out (iPads need nothing new)
  --new-ca     replace everything, CA included (every iPad needs the new profile and the old one removed)`;

function isPrivateIpv4(ip, allowLoopback) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return allowLoopback && a === 127;
}

function maskFromPrefix(prefix) {
  const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join('.');
}

const ipToInt = (ip) => ip.split('.').reduce((acc, n) => (acc * 256 + Number(n)) >>> 0, 0);
const within = (ip, [base, mask]) => ((ipToInt(ip) & ipToInt(mask)) >>> 0) === ((ipToInt(base) & ipToInt(mask)) >>> 0);

// ---------------------------------------------------------------------- file helpers

function writeNew(path, data, mode) {
  // `wx`: never replace a file by accident; the mode is applied at creation, not afterwards.
  const fd = openSync(path, 'wx', mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Replace a file by deleting and creating anew, so a private key never sits at a looser mode, even briefly. */
function writeNewOrOverwrite(path, data, mode) {
  if (existsSync(path)) rmSync(path);
  writeNew(path, data, mode);
}

function pemOfPrivate(key) {
  return key.export({ type: 'pkcs8', format: 'pem' });
}

// ---------------------------------------------------------------------- the profile

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mobileconfig({ caDer, venue, caName }) {
  const contentUuid = randomUUID().toUpperCase();
  const outerUuid = randomUUID().toUpperCase();
  const b64 = caDer.toString('base64').replace(/(.{64})/g, '$1\n\t\t\t').trimEnd();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>hankha-bridge-ca.cer</string>
			<key>PayloadContent</key>
			<data>
			${b64}
			</data>
			<key>PayloadDescription</key>
			<string>Lets this device trust the Hankha print Bridge at ${xml(venue)} (this certificate authority can only vouch for that Bridge's address).</string>
			<key>PayloadDisplayName</key>
			<string>${xml(caName)}</string>
			<key>PayloadIdentifier</key>
			<string>la.hankha.bridge-ca.${contentUuid}</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>${contentUuid}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Trusts the print Bridge of ${xml(venue)} on its local network. Remove it when this device leaves the venue.</string>
	<key>PayloadDisplayName</key>
	<string>Hankha Bridge (${xml(venue)})</string>
	<key>PayloadIdentifier</key>
	<string>la.hankha.bridge-profile.${outerUuid}</string>
	<key>PayloadOrganization</key>
	<string>Hankha</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${outerUuid}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------- main

function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) {
    console.log(USAGE);
    return;
  }
  if (!o.out) throw new Error(`--out is required\n${USAGE}`);
  if (o.ips.length === 0) throw new Error('give at least one --ip (the address the iPad will browse to)');
  if (o.renew && o.newCa) throw new Error('--renew keeps the CA and --new-ca replaces it: pick one');
  if (!(o.days >= 1 && o.days <= 825)) throw new Error('--days must be between 1 and 825');
  if (!(o.caDays >= o.days)) throw new Error('--ca-days must be at least --days');
  for (const ip of o.ips) {
    if (!isPrivateIpv4(ip, o.allowLoopback)) throw new Error(`${ip} is not a private IPv4 address (10/8, 172.16/12, 192.168/16, 169.254/16). A venue Bridge never has a public name.`);
  }
  if (o.hostname !== null && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(o.hostname)) {
    throw new Error('--hostname must be a plain DNS name (letters, digits, hyphen, dots); no wildcard');
  }
  let caSubnet = null;
  if (o.caSubnet !== null) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(o.caSubnet);
    if (!m || !isPrivateIpv4(m[1], o.allowLoopback) || Number(m[2]) < 16 || Number(m[2]) > 32) {
      throw new Error('--ca-subnet must be a private IPv4 network with a prefix between /16 and /32, e.g. 192.168.1.0/24');
    }
    caSubnet = [m[1], maskFromPrefix(Number(m[2]))];
    for (const ip of o.ips) if (!within(ip, caSubnet)) throw new Error(`${ip} is outside --ca-subnet ${o.caSubnet}`);
  }

  const out = resolve(o.out);
  const p = (name) => join(out, name);
  const haveCa = existsSync(p(FILES.caKey)) && existsSync(p(FILES.caCrt));
  const haveLeaf = existsSync(p(FILES.key)) || existsSync(p(FILES.crt));
  if (!o.renew && !o.newCa && (haveCa || haveLeaf)) {
    throw new Error(`${out} already holds certificate files. Use --renew to issue a new Bridge certificate from the same CA, or --new-ca to start the venue over (every iPad then needs the new profile).`);
  }
  if (o.renew && !haveCa) throw new Error(`--renew needs ${FILES.caKey} and ${FILES.caCrt} in ${out}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  try {
    chmodSync(out, 0o700);
  } catch {
    /* Windows has no POSIX modes */
  }

  const now = Date.now();
  const notBefore = new Date(now - 60 * 60_000); // an hour of slack for a device clock that runs slow
  let caKey;
  let caCert;
  let caMeta;
  let createdCa = false;

  if (o.renew) {
    caKey = createPrivateKey(readFileSync(p(FILES.caKey)));
    caCert = new X509Certificate(readFileSync(p(FILES.caCrt)));
    caMeta = JSON.parse(readFileSync(p(FILES.caMeta), 'utf8'));
    if (new Date(caCert.validTo).getTime() < now + o.days * DAY) {
      console.error(`warning: the CA expires ${caCert.validTo}, before the new leaf would (${o.days} days). iPads will refuse the leaf after the CA expires; use --new-ca soon.`);
    }
    if (!o.noNameConstraints && caMeta.name_constraints) {
      const permitted = caMeta.permitted_ips;
      for (const ip of o.ips) {
        if (!permitted.some((range) => within(ip, range))) {
          throw new Error(`${ip} is outside what this CA may vouch for (${permitted.map(([a, m]) => `${a}/${m}`).join(', ')}). Use --new-ca, or renew with an address the CA already covers.`);
        }
      }
      if (o.hostname && !caMeta.permitted_dns.includes(o.hostname)) {
        throw new Error(`the hostname ${o.hostname} is outside what this CA may vouch for (${caMeta.permitted_dns.join(', ')}). Use --new-ca.`);
      }
    }
  } else {
    createdCa = true;
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    caKey = pair.privateKey;
    const permittedIps = (caSubnet ? [caSubnet] : o.ips.map((ip) => [ip, '255.255.255.255']));
    const permittedDns = [o.hostname ?? RESERVED_DNS];
    caMeta = {
      v: 1, venue: o.venue, created_at: new Date(now).toISOString(), name_constraints: !o.noNameConstraints,
      permitted_ips: permittedIps, permitted_dns: permittedDns,
    };
    const caName = { cn: `Hankha Bridge CA - ${o.venue} - ${Math.random().toString(16).slice(2, 8)}`, o: 'Hankha' };
    const ca = makeCertificate({
      subject: caName, issuer: caName, publicKey: pair.publicKey, issuerPublicKey: pair.publicKey, signingKey: pair.privateKey,
      selfSigned: true, notBefore, notAfter: new Date(now + o.caDays * DAY), basic: { ca: true, pathLen: 0 }, usage: 'ca',
      nameConstraints: o.noNameConstraints ? null : { ips: permittedIps, dns: permittedDns },
    });
    caCert = new X509Certificate(ca.der);
    caMeta.ca_subject = caName.cn;
    if (o.newCa) {
      for (const f of [FILES.caKey, FILES.caCrt, FILES.caMeta, FILES.key, FILES.crt, FILES.profile, FILES.snippet]) {
        if (existsSync(p(f))) rmSync(p(f));
      }
    }
    writeNew(p(FILES.caKey), pemOfPrivate(caKey), 0o600);
    writeNew(p(FILES.caCrt), ca.pem, 0o644);
    writeNew(p(FILES.caMeta), `${JSON.stringify(caMeta, null, 2)}\n`, 0o644);
    writeNew(p(FILES.profile), mobileconfig({ caDer: ca.der, venue: o.venue, caName: caName.cn }), 0o644);
  }

  // The leaf: its own key, IP SANs, valid for --days.
  const leafPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leaf = makeCertificate({
    // NOT the IP: with no DNS name in the SAN, OpenSSL falls back to checking a host-name-looking CN against
    // the CA's DNS constraint, and an IP in the CN would fail it ("permitted subtree violation"). The SAN is what
    // clients match; the CN is a label (spaces keep it from looking like a host name).
    subject: { cn: o.hostname ?? 'Hankha Print Bridge', o: 'Hankha' },
    issuerDer: subjectDerOf(caCert.raw),
    publicKey: leafPair.publicKey, issuerPublicKey: caCert.publicKey, signingKey: caKey,
    notBefore, notAfter: new Date(now + o.days * DAY),
    basic: { ca: false }, usage: 'server', sanIps: o.ips, sanDns: o.hostname ? [o.hostname] : [],
  });
  const leafX = new X509Certificate(leaf.der);
  if (!leafX.checkIssued(caCert) || !leafX.verify(caCert.publicKey)) throw new Error('internal error: the new certificate does not verify against its CA');
  writeNewOrOverwrite(p(FILES.key), pemOfPrivate(leafPair.privateKey), 0o600);
  writeNewOrOverwrite(p(FILES.crt), leaf.pem, 0o644);
  const snippet = { tls: { cert_path: 'lan-tls/bridge.crt.pem', key_path: 'lan-tls/bridge.key.pem' } };
  writeNewOrOverwrite(p(FILES.snippet), `${JSON.stringify(snippet, null, 2)}\n`, 0o644);

  const err = (s = '') => process.stderr.write(`${s}\n`);
  err('');
  err('==========================================================================================');
  err(' PRIVATE KEYS WERE JUST WRITTEN. Treat them like passwords.');
  err(`   ${p(FILES.caKey)}   <- the venue CA key. Keep OFFLINE. Never on the Bridge PC, never on an iPad,`);
  err('                                           never in git, chat, email, a shared drive or a backup that syncs.');
  err(`   ${p(FILES.key)}  <- the Bridge's TLS key. Bridge PC only, mode 0600 (readable by the service account only).`);
  err(' Anyone holding ca.key.pem can make certificates that every iPad with this profile trusts (for the');
  err(' names the CA is constrained to). Anyone holding bridge.key.pem can impersonate the Bridge to the tills.');
  err('==========================================================================================');
  err('');
  console.log(`${createdCa ? 'Created a new CA and' : 'Re-issued'} a Bridge certificate in ${out}`);
  console.log(`  Bridge certificate: ${leafX.subject.replace(/\n/g, ', ')}`);
  console.log(`  SAN:                ${leafX.subjectAltName}`);
  console.log(`  valid:              ${leafX.validFrom}  ->  ${leafX.validTo}`);
  console.log(`  CA:                 ${caCert.subject.replace(/\n/g, ', ')}  (expires ${caCert.validTo})`);
  console.log(`  SHA-256 of the CA:  ${caCert.fingerprint256}`);
  if (o.noNameConstraints || caMeta.name_constraints === false) {
    console.log('');
    console.log('  !! This CA has NO name constraint. A stolen ca.key.pem could impersonate ANY website to every device');
    console.log('  !! that installed the profile. Use --no-name-constraints only to find out whether an iPad rejects the');
    console.log('  !! constraint, then start over WITH it (--new-ca) for anything real.');
  } else {
    console.log(`  CA may vouch for:   IP ${caMeta.permitted_ips.map(([a, m]) => `${a}/${m}`).join(', ')}; DNS ${caMeta.permitted_dns.join(', ')} (and nothing else)`);
  }
  console.log('');
  console.log('Next steps');
  console.log(`  1. Copy ONLY ${FILES.crt} and ${FILES.key} to the Bridge PC, into its state directory under lan-tls/ (key mode 0600),`);
  console.log(`     and add this to the Bridge's lan.json next to "enabled": true  (see ${FILES.snippet}):`);
  console.log(JSON.stringify(snippet, null, 2).replace(/^/gm, '       '));
  console.log('     Restart the Bridge. From then on port 9201 speaks HTTPS ONLY: plain http:// to it stops working,');
  console.log('     and so does the Android Helper gateway (it speaks http). One Bridge, one scheme.');
  if (createdCa) {
    console.log(`  2. Put ${FILES.profile} on each iPad of THIS venue (AirDrop, or open it from Files/Safari). Never email or`);
    console.log('     upload ca.key.pem. Then on the iPad:');
    console.log('       Settings > General > VPN & Device Management > the downloaded profile > Install (passcode);');
    console.log('       Settings > General > About > Certificate Trust Settings > switch ON full trust for the "Hankha Bridge CA".');
    console.log(`     Then Safari: https://${o.ips[0]}:9201/lan/v1/hello must show JSON with no warning.`);
  } else {
    console.log('  2. iPads that trust this CA need nothing new.');
  }
  console.log(`  3. Renew before ${leafX.validTo}: node scripts/gen-lan-cert.mjs --out ${o.out} --ip ${o.ips.join(' --ip ')}${o.hostname ? ` --hostname ${o.hostname}` : ''} --renew`);
  console.log('  4. When an iPad leaves the venue, remove the profile: Settings > General > VPN & Device Management.');
}

try {
  main();
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`); if (process.env.DEBUG_GEN) console.error(e);
  process.exit(2);
}
