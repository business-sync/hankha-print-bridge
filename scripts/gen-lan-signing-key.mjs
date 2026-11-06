#!/usr/bin/env node
/*
 * Generate the Ed25519 key pair that signs LAN printing tickets and pairing grants.
 *
 *   node scripts/gen-lan-signing-key.mjs                 print everything to the terminal, write nothing
 *   node scripts/gen-lan-signing-key.mjs --kid lan-2027  choose the key id yourself
 *   node scripts/gen-lan-signing-key.mjs --out key.json  also write the pair to a NEW file, mode 0600
 *   node scripts/gen-lan-signing-key.mjs --public-only   print only the public half (no secret on screen)
 *
 * No dependencies; Node >= 22.
 *
 * ============================================================================================
 *  THE PRIVATE KEY BELOW IS THE ROOT OF TRUST FOR EVERY LAN-PRINTING TERMINAL AND BRIDGE.
 *  Whoever holds it can mint a ticket for any Bridge and a pairing grant for any venue.
 *    - It goes into the backend's SECRET STORE only (PRINT_LAN_SIGNING_KEY), next to JWT_SECRET.
 *    - NEVER commit it, paste it in a chat or ticket, put it in a ConfigMap, a Dockerfile, a log,
 *      a CI variable that prints, or a screenshot. This script never logs it anywhere but this
 *      terminal, and writes no file unless you pass --out.
 *    - The PUBLIC half (SPKI) is not secret: it goes into each Bridge's lan.json "bootstrap_keys"
 *      and is what the backend publishes at GET /lan/keys.
 *  Lose the private key and you must issue a new one and re-pin it on every Bridge that never
 *  comes online. Rotate by adding the new public key to Bridges first (they accept both), then
 *  switching the backend.
 * ============================================================================================
 */
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';

const KID = /^[A-Za-z0-9._-]{1,32}$/;

function parse(argv) {
  const o = { kid: null, out: null, publicOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--kid') o.kid = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--public-only') o.publicOnly = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) {
    console.log('usage: gen-lan-signing-key.mjs [--kid <id>] [--out <new file>] [--public-only]');
    return;
  }
  if (o.kid !== null && !KID.test(o.kid ?? '')) throw new Error('--kid must be 1-32 characters of A-Z a-z 0-9 . _ -');
  if (o.out !== null && !o.out) throw new Error('--out needs a file name');
  if (o.out && o.publicOnly) throw new Error('--out writes the secret; it cannot be combined with --public-only');
  if (o.out && existsSync(o.out)) throw new Error(`${o.out} already exists; refusing to overwrite a key file`);

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  // Round trip: prove what we are about to hand over parses back to the same public key.
  if (createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url') !== spki) {
    throw new Error('internal error: key did not round-trip');
  }
  const fingerprint = createHash('sha256').update(spki).digest('hex').slice(0, 6);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const kid = o.kid ?? `lan-${day}-${fingerprint}`;

  const err = (s) => process.stderr.write(`${s}\n`);
  err('');
  err('############################################################################');
  err('#  SECRET WARNING: the PKCS8 value below can sign tickets for EVERY Bridge. #');
  err('#  Put it in the backend secret store ONLY. Never commit, log or paste it.  #');
  err('############################################################################');
  err('');

  console.log(`kid (suggested):  ${kid}`);
  console.log('');
  console.log('PUBLIC (safe to share; goes in each Bridge lan.json and is what GET /lan/keys serves)');
  console.log(`  SPKI base64url: ${spki}`);
  console.log('');
  console.log('  lan.json on a Bridge (add to the existing file):');
  console.log(JSON.stringify({ bootstrap_keys: [{ kid, pubkey: spki, not_before: 0, not_after: null }] }, null, 2).replace(/^/gm, '    '));
  console.log('');
  if (o.publicOnly) {
    console.log('(--public-only: no private key was printed; this pair is gone, run again without it to get a usable one)');
    return;
  }
  console.log('SECRET (backend secret store only)');
  console.log(`  PRINT_LAN_SIGNING_KEY=${pkcs8}`);
  console.log(`  PRINT_LAN_SIGNING_KID=${kid}`);
  console.log('');
  if (o.out) {
    // `wx` so an existing file is never replaced; mode 0600 from creation, not chmod afterwards.
    const fd = openSync(o.out, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ kid, pkcs8_base64: pkcs8, spki_b64u: spki, created_at: new Date().toISOString() }, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    err(`wrote ${o.out} (mode 0600). It holds the SECRET: move it into the secret store and delete it.`);
  } else {
    err('nothing was written to disk (pass --out <new file> if you want a 0600 copy).');
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
