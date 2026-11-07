import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as httpsServer } from 'node:https';
import { connect as netConnect, createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lanReport, readLanConfig, startLan } from './lan-server.js';
import { loadLanTls, parseTlsConfig } from './lan-tls.js';
import { setLogSink, type LogRecord } from './log.js';
import { setActiveLanKeys } from './lan-keys.js';
import { httpsFetcher } from './test-support/https-fetch.js';
import { jobBody, LanHarness } from './test-support/lan-harness.js';
// @ts-expect-error the certificate tool is plain JavaScript with no declarations
import { makeCertificate } from '../scripts/lib/x509-min.mjs';

/*
 * Optional TLS on the LAN listener (task 5). Real TLS handshakes over real sockets, certificates
 * made by the shipped tool (`scripts/gen-lan-cert.mjs`), nothing mocked.
 */

const GEN = fileURLToPath(new URL('../scripts/gen-lan-cert.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const dirs: string[] = [];
const children: ChildProcess[] = [];
const scratch = (p = 'hankha-tls-') => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Venue {
  dir: string;
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  certPath: string;
  keyPath: string;
  caKeyPath: string;
}

/** A venue's certificate material, from the real tool. Loopback is allowed only because the tests connect to 127.0.0.1. */
function makeVenue(extra: string[] = ['--ip', '127.0.0.1']): Venue {
  const dir = scratch();
  const out = join(dir, 'cert');
  const r = spawnSync(process.execPath, [GEN, '--out', out, '--venue', 'Test Venue', '--allow-loopback', ...extra], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return {
    dir: out,
    ca: readFileSync(join(out, 'ca.crt.pem')),
    cert: readFileSync(join(out, 'bridge.crt.pem')),
    key: readFileSync(join(out, 'bridge.key.pem')),
    certPath: join(out, 'bridge.crt.pem'),
    keyPath: join(out, 'bridge.key.pem'),
    caKeyPath: join(out, 'ca.key.pem'),
  };
}

let venue: Venue;
let other: Venue;
let logs: LogRecord[] = [];
let restore: (() => void) | null = null;
let level: string | undefined;
beforeEach(() => {
  logs = [];
  level = process.env.PRINT_BRIDGE_LOG_LEVEL;
  process.env.PRINT_BRIDGE_LOG_LEVEL = 'debug';
  restore = setLogSink((r) => logs.push(r));
});
afterEach(() => {
  setActiveLanKeys(null);
  restore?.();
  if (level === undefined) delete process.env.PRINT_BRIDGE_LOG_LEVEL;
  else process.env.PRINT_BRIDGE_LOG_LEVEL = level;
});

before(() => {
  venue = makeVenue();
  other = makeVenue();
});

describe('loading a certificate', () => {
  it('two venues get two different CAs', () => {
    assert.notEqual(venue.ca.toString(), other.ca.toString(), 'one CA per venue');
    assert.notEqual(venue.cert.toString(), other.cert.toString());
  });

  it('accepts what the tool wrote, with no warnings, and reports the IP SAN', () => {
    const r = loadLanTls({ cert_path: venue.certPath, key_path: venue.keyPath }, venue.dir);
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.deepEqual(r.tls.info.ip_sans, ['127.0.0.1']);
    assert.deepEqual(r.tls.warnings, []);
    assert.match(r.tls.info.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('resolves relative paths against the state directory', () => {
    const state = scratch();
    mkdirSync(join(state, 'lan-tls'));
    copyFileSync(venue.certPath, join(state, 'lan-tls', 'c.pem'));
    copyFileSync(venue.keyPath, join(state, 'lan-tls', 'k.pem'));
    chmodSync(join(state, 'lan-tls', 'k.pem'), 0o600);
    assert.ok(loadLanTls({ cert_path: 'lan-tls/c.pem', key_path: 'lan-tls/k.pem' }, state).ok);
  });

  it('refuses a key that does not belong to the certificate', () => {
    const r = loadLanTls({ cert_path: venue.certPath, key_path: other.keyPath }, venue.dir);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /does not belong/);
  });

  it('refuses a passphrase-protected key, a missing file, a directory and junk', () => {
    const dir = scratch();
    const enc = createPrivateKey(venue.key).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'secret' }) as string;
    writeFileSync(join(dir, 'enc.pem'), enc);
    writeFileSync(join(dir, 'junk.pem'), 'not a pem at all');
    const cases: Array<[string, string, RegExp]> = [
      [venue.certPath, join(dir, 'enc.pem'), /passphrase/],
      [venue.certPath, join(dir, 'nope.pem'), /ENOENT/],
      [venue.certPath, dir, /not a file/],
      [join(dir, 'junk.pem'), venue.keyPath, /not a PEM certificate/],
      [venue.certPath, join(dir, 'junk.pem'), /not a readable/],
    ];
    for (const [cert_path, key_path, why] of cases) {
      const r = loadLanTls({ cert_path, key_path }, dir);
      assert.equal(r.ok, false, key_path);
      assert.match(r.ok ? '' : r.reason, why);
    }
  });

  it('warns, but still loads, when the key is group-readable (POSIX)', (t) => {
    if (process.platform === 'win32') return t.skip('no POSIX modes');
    const dir = scratch();
    const k = join(dir, 'k.pem');
    writeFileSync(k, venue.key, { mode: 0o644 });
    chmodSync(k, 0o644);
    const r = loadLanTls({ cert_path: venue.certPath, key_path: k }, dir);
    assert.ok(r.ok);
    assert.ok(r.ok && r.tls.warnings.some((w) => /readable by group or others/.test(w)), JSON.stringify(r.ok && r.tls.warnings));
  });

  const custom = (o: { sanIps?: string[]; sanDns?: string[]; notAfter?: Date; notBefore?: Date }) => {
    const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const c = makeCertificate({
      subject: { cn: 'x' }, issuer: { cn: 'ca' }, publicKey: leaf.publicKey, issuerPublicKey: ca.publicKey, signingKey: ca.privateKey,
      notBefore: o.notBefore ?? new Date(Date.now() - 3_600_000), notAfter: o.notAfter ?? new Date(Date.now() + 200 * 86_400_000),
      basic: { ca: false }, usage: 'server', sanIps: o.sanIps ?? [], sanDns: o.sanDns ?? [],
    });
    const dir = scratch();
    writeFileSync(join(dir, 'c.pem'), c.pem);
    writeFileSync(join(dir, 'k.pem'), leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return loadLanTls({ cert_path: 'c.pem', key_path: 'k.pem' }, dir);
  };

  it('warns about a certificate with no IP SAN, an expired one, one expiring soon, and a wildcard', () => {
    const noIp = custom({ sanDns: ['bridge.local'] });
    assert.ok(noIp.ok && noIp.tls.warnings.some((w) => /no IP address/.test(w)));
    const expired = custom({ sanIps: ['10.0.0.5'], notBefore: new Date(Date.now() - 400 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) });
    assert.ok(expired.ok && expired.tls.warnings.some((w) => /EXPIRED/.test(w)));
    const soon = custom({ sanIps: ['10.0.0.5'], notAfter: new Date(Date.now() + 10 * 86_400_000) });
    assert.ok(soon.ok && soon.tls.warnings.some((w) => /expires on/.test(w)));
    const wild = custom({ sanIps: ['10.0.0.5'], sanDns: ['*.example.com'] });
    assert.ok(wild.ok && wild.tls.warnings.some((w) => /wildcard/.test(w)));
    assert.ok(custom({ sanIps: ['10.0.0.5'] }).ok);
  });

  it('parseTlsConfig: absent, null and false mean "no TLS"; anything else must be a proper object', () => {
    for (const v of [undefined, null, false]) assert.equal(parseTlsConfig(v), null);
    for (const v of [true, 'yes', 7, [], {}, { cert_path: 'a' }, { cert_path: '', key_path: 'b' }, { cert_path: 'a', key_path: 5 }]) {
      assert.ok(parseTlsConfig(v) && 'error' in (parseTlsConfig(v) as object), JSON.stringify(v));
    }
    assert.deepEqual(parseTlsConfig({ cert_path: ' a ', key_path: 'b' }), { cert_path: 'a', key_path: 'b' });
  });
});

describe('lan.json tls', () => {
  const write = (dir: string, tls: unknown) => writeFileSync(join(dir, 'lan.json'), JSON.stringify({ enabled: true, port: 9393, host: '127.0.0.1', ...(tls === undefined ? {} : { tls }) }));

  it('without tls the config has no tls property and nothing about TLS is logged', () => {
    const dir = scratch();
    write(dir, undefined);
    const c = readLanConfig(dir);
    assert.ok(c);
    assert.equal('tls' in (c ?? {}), false);
    assert.equal(logs.some((l) => /lan\.tls/.test(l.event ?? '')), false);
  });

  it('with a usable tls the config carries the material', () => {
    const dir = scratch();
    write(dir, { cert_path: venue.certPath, key_path: venue.keyPath });
    const c = readLanConfig(dir);
    assert.ok(c?.tls);
    assert.equal(c?.tls?.info.ip_sans[0], '127.0.0.1');
  });

  it('FAILS CLOSED: a configured tls that cannot be used turns the LAN API off, loudly, instead of serving http', () => {
    const dir = scratch();
    for (const tls of [{ cert_path: venue.certPath, key_path: other.keyPath }, { cert_path: join(dir, 'missing.pem'), key_path: venue.keyPath }, 'yes', { cert_path: 1 }]) {
      logs = [];
      write(dir, tls);
      assert.equal(readLanConfig(dir), null, JSON.stringify(tls));
      const l = logs.find((x) => x.event === 'lan.tls.unusable');
      assert.ok(l, 'logged');
      assert.equal(l?.level, 'error');
    }
  });

  it('tls:false is the same as no tls', () => {
    const dir = scratch();
    write(dir, false);
    assert.equal('tls' in (readLanConfig(dir) ?? {}), false);
  });

  it('warnings are logged at start', () => {
    if (process.platform === 'win32') return;
    const dir = scratch();
    const k = join(dir, 'k.pem');
    writeFileSync(k, venue.key);
    chmodSync(k, 0o644);
    write(dir, { cert_path: venue.certPath, key_path: k });
    assert.ok(readLanConfig(dir));
    assert.ok(logs.some((l) => l.event === 'lan.tls.warning' && l.level === 'warn'));
  });
});

describe('over a real TLS listener', () => {
  let h: LanHarness | null = null;
  afterEach(async () => {
    await h?.stop();
    h = null;
  });
  const start = async () => {
    h = await LanHarness.start({ tls: { cert: venue.cert, key: venue.key, ca: venue.ca } });
    return h;
  };

  it('a client that trusts the venue CA does hello and a signed job over https, and the slip prints once', async () => {
    const harness = await start();
    assert.match(harness.base, /^https:/);
    const hello = await harness.terminal.hello();
    assert.equal(hello.scheme, 'https');
    assert.equal(hello.protocol, 1);
    const r = await harness.terminal.call('POST', '/lan/v1/jobs', jobBody('tls-job-0001', 'MARK-TLS-ONE'));
    assert.equal(r.status, 202, r.text);
    await harness.idle();
    assert.equal(harness.printer.count('MARK-TLS-ONE'), 1);
    const st = await harness.terminal.call('POST', '/lan/v1/jobs/status', { keys: ['tls-job-0001'] });
    assert.equal(st.status, 200);
    assert.equal(st.json.jobs[0].state, 'bytes_written');
    const printers = await harness.terminal.call('GET', '/lan/v1/printers');
    assert.equal(printers.status, 200);
  });

  it('a client that does not trust the CA cannot talk to it', async () => {
    const harness = await start();
    const plain = httpsFetcher(Buffer.alloc(0));
    await assert.rejects(plain(`${harness.base}/lan/v1/hello`), (e: NodeJS.ErrnoException) => /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|UNABLE_TO_GET_ISSUER/.test(e.code ?? ''));
    // And the global fetch (system roots) says no too.
    await assert.rejects(fetch(`${harness.base}/lan/v1/hello`));
  });

  it('a client that trusts ANOTHER venue\'s CA cannot talk to it', async () => {
    const harness = await start();
    await assert.rejects(httpsFetcher(other.ca)(`${harness.base}/lan/v1/hello`), (e: NodeJS.ErrnoException) => /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER/.test(e.code ?? ''));
  });

  it('a client that reaches it under another name is refused (the SAN is the IP)', async () => {
    const harness = await start();
    await assert.rejects(httpsFetcher(venue.ca, { servername: 'bridge.example' })(`${harness.base}/lan/v1/hello`), (e: NodeJS.ErrnoException) => e.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('plain http to the TLS port gets no answer: never a served response', async () => {
    const harness = await start();
    const received = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      const s = netConnect(harness.port, '127.0.0.1', () => s.write('GET /lan/v1/hello HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
      s.on('data', (c) => chunks.push(c));
      s.on('error', () => undefined);
      s.on('close', () => resolve(Buffer.concat(chunks)));
      setTimeout(() => s.destroy(), 3_000);
    });
    assert.doesNotMatch(received.toString('latin1'), /HTTP\/1|nonce|protocol/, 'no HTTP bytes came back');
    // The fetch API agrees.
    await assert.rejects(fetch(`http://127.0.0.1:${harness.port}/lan/v1/hello`));
    // And the listener is still healthy for a real client afterwards.
    assert.equal((await harness.terminal.hello()).protocol, 1);
  });

  it('refuses a TLS 1.0/1.1 client (the minimum is TLS 1.2)', async () => {
    const harness = await start();
    await assert.rejects(
      new Promise((resolve, reject) => {
        import('node:tls').then(({ connect }) => {
          const s = connect({ host: '127.0.0.1', port: harness.port, ca: venue.ca, minVersion: 'TLSv1', maxVersion: 'TLSv1.1' }, () => resolve(s));
          s.on('error', reject);
        });
      })
    );
  });

  it('the CA\'s name constraint is real: a certificate it signs for an address it was not given is rejected by the client', async () => {
    // A rogue leaf signed with this venue's CA key, naming 127.0.0.1 AND an address outside the constraint.
    const caKey = createPrivateKey(readFileSync(venue.caKeyPath));
    const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const caX = new X509Certificate(venue.ca);
    const issuer = Object.fromEntries(caX.subject.split('\n').map((l) => l.split('=')).map(([k, ...v]) => [(k as string).toLowerCase(), v.join('=')]));
    const rogue = (ips: string[], dns: string[]) =>
      makeCertificate({
        subject: { cn: 'rogue' }, issuer, publicKey: leaf.publicKey, issuerPublicKey: caX.publicKey, signingKey: caKey,
        notBefore: new Date(Date.now() - 3_600_000), notAfter: new Date(Date.now() + 86_400_000), basic: { ca: false }, usage: 'server',
        sanIps: ips, sanDns: dns,
      });
    const tryServe = async (cert: { pem: string }) => {
      const server = httpsServer({ cert: cert.pem, key: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, (_req, res) => res.end('hi'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      try {
        return await httpsFetcher(venue.ca)(`https://127.0.0.1:${port}/`).then(() => 'accepted', (e: NodeJS.ErrnoException) => e.code ?? 'rejected');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    };
    assert.equal(await tryServe(rogue(['127.0.0.1'], [])), 'accepted', 'control: a leaf inside the constraint is accepted');
    assert.notEqual(await tryServe(rogue(['127.0.0.1', '8.8.8.8'], [])), 'accepted', 'an extra IP outside the constraint');
    assert.notEqual(await tryServe(rogue(['127.0.0.1'], ['bank.example.com'])), 'accepted', 'a real DNS name outside the constraint');
  });
});

describe('off by default', () => {
  it('a listener without tls is plain http, and hello is exactly what it always was', async () => {
    const h = await LanHarness.start();
    try {
      assert.match(h.base, /^http:/);
      const hello = (await (await fetch(`${h.base}/lan/v1/hello`)).json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(hello).sort(), ['bridge_id', 'capabilities', 'install_id', 'max_body_bytes', 'nonce', 'protocol', 'relay']);
      assert.equal('scheme' in hello, false);
    } finally {
      await h.stop();
    }
  });

  it('the lan report carries scheme only when TLS is on', async () => {
    const free = () =>
      new Promise<number>((resolve) => {
        const s = netServer();
        s.listen(0, '127.0.0.1', () => {
          const port = (s.address() as { port: number }).port;
          s.close(() => resolve(port));
        });
      });
    const deps = {
      queue: () => { throw new Error('not used'); }, installId: () => 'i', bridgeId: () => null, relayConnected: () => false,
      reach: () => ({ reachable: null, last_ok_at: null, checked_at: null }),
    } as unknown as Parameters<typeof startLan>[0];
    const dir = scratch();
    const cfgDir = scratch();
    writeFileSync(join(cfgDir, 'lan.json'), JSON.stringify({ enabled: true, port: await free(), host: '127.0.0.1', tls: { cert_path: venue.certPath, key_path: venue.keyPath } }));
    const withTls = startLan({ ...deps, dir, config: readLanConfig(cfgDir) });
    assert.ok(withTls);
    try {
      const rep = lanReport();
      assert.equal(rep?.scheme, 'https');
      assert.equal(new Date(rep?.tls_valid_to as string).getTime() > Date.now(), true);
    } finally {
      await withTls.stop();
    }
    const plain = startLan({ ...deps, dir: scratch(), config: { port: await free(), host: '127.0.0.1' } });
    assert.ok(plain);
    try {
      assert.equal('scheme' in (lanReport() ?? {}), false);
      assert.equal('tls_valid_to' in (lanReport() ?? {}), false);
    } finally {
      await plain.stop();
    }
  });
});

// ---------------------------------------------------------------------- the real Bridge process

describe('a real Bridge process with TLS', () => {
  const free = () =>
    new Promise<number>((resolve) => {
      const s = netServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
  const until = async (ready: () => boolean | Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  async function startBridge(lanJson: unknown) {
    const dir = scratch('hankha-tlsproc-');
    writeFileSync(join(dir, 'lan.json'), JSON.stringify(lanJson));
    const port = await free();
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      env: {
        ...process.env, PRINT_BRIDGE_PORT: String(port), PRINT_BRIDGE_HOST: '127.0.0.1', PRINT_BRIDGE_STATE_DIR: dir,
        PRINT_BRIDGE_RELAY_URL: 'http://127.0.0.1:9', PRINT_BRIDGE_LOG_FORMAT: 'text', PRINT_BRIDGE_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    }, 'the bridge to answer /health');
    return { dir, port, output: () => output };
  }

  it('serves https only: trusted client OK, untrusted and plain http refused; the log names the certificate but not the key', async () => {
    const lanPort = await free();
    const b = await startBridge({ enabled: true, port: lanPort, host: '127.0.0.1', tls: { cert_path: venue.certPath, key_path: venue.keyPath } });
    const trusted = httpsFetcher(venue.ca);
    await until(async () => {
      try {
        return (await trusted(`https://127.0.0.1:${lanPort}/lan/v1/hello`)).status === 200;
      } catch {
        return false;
      }
    }, 'the TLS listener');
    const hello = (await (await trusted(`https://127.0.0.1:${lanPort}/lan/v1/hello`)).json()) as { scheme?: string; protocol: number };
    assert.equal(hello.scheme, 'https');
    assert.equal(hello.protocol, 1);
    await assert.rejects(httpsFetcher(Buffer.alloc(0))(`https://127.0.0.1:${lanPort}/lan/v1/hello`));
    await assert.rejects(fetch(`http://127.0.0.1:${lanPort}/lan/v1/hello`));
    assert.match(b.output(), /print API listening on 127\.0\.0\.1:\d+ over HTTPS/);
    assert.ok(!b.output().includes('PRIVATE KEY'));
    // The 9200 control port is unchanged: plain http on loopback.
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/health`)).status, 200);
  });

  it('a configured-but-broken tls leaves NO listener on the LAN port (and the Bridge itself still runs)', async () => {
    const lanPort = await free();
    const b = await startBridge({ enabled: true, port: lanPort, host: '127.0.0.1', tls: { cert_path: venue.certPath, key_path: other.keyPath } });
    await new Promise((r) => setTimeout(r, 800));
    await assert.rejects(fetch(`http://127.0.0.1:${lanPort}/lan/v1/hello`));
    await assert.rejects(httpsFetcher(venue.ca)(`https://127.0.0.1:${lanPort}/lan/v1/hello`));
    assert.match(b.output(), /asks for TLS but it cannot be used/);
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/health`)).status, 200);
    assert.equal(readdirSync(b.dir).some((f) => f.startsWith('lan-key')), false, 'LAN is off, so no key was created');
  });
});

// ---------------------------------------------------------------------- the certificate tool

describe('scripts/gen-lan-cert.mjs', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' });

  it('writes the expected files, keys at 0600 and nowhere but --out', (t) => {
    const out = join(scratch(), 'v');
    const r = run(['--out', out, '--ip', '192.168.50.7', '--venue', 'Dok Champa']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(out).sort(), ['bridge.crt.pem', 'bridge.key.pem', 'ca.crt.pem', 'ca.json', 'ca.key.pem', 'hankha-bridge-ca.mobileconfig', 'lan.json.snippet']);
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(out, 'ca.key.pem')).mode & 0o777, 0o600);
      assert.equal(statSync(join(out, 'bridge.key.pem')).mode & 0o777, 0o600);
      assert.equal(statSync(out).mode & 0o777, 0o700);
    } else t.diagnostic('POSIX modes do not apply on Windows');
    assert.match(r.stderr, /PRIVATE KEYS WERE JUST WRITTEN/);
    assert.match(r.stderr, /Keep OFFLINE/);
  });

  it('the Bridge certificate: IP SAN only, not a CA, verifies against its CA, bounded validity, no wildcard', () => {
    const out = join(scratch(), 'v');
    assert.equal(run(['--out', out, '--ip', '192.168.50.7,192.168.50.8', '--hostname', 'bridge.local']).status, 0);
    const ca = new X509Certificate(readFileSync(join(out, 'ca.crt.pem')));
    const leaf = new X509Certificate(readFileSync(join(out, 'bridge.crt.pem')));
    assert.equal(leaf.ca, false);
    assert.equal(ca.ca, true);
    assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
    assert.ok(ca.verify(ca.publicKey), 'the CA is self-signed');
    assert.deepEqual(leaf.subjectAltName?.split(', ').sort(), ['DNS:bridge.local', 'IP Address:192.168.50.7', 'IP Address:192.168.50.8']);
    assert.equal(leaf.checkIP('192.168.50.7'), '192.168.50.7');
    assert.equal(leaf.checkIP('192.168.50.9'), undefined);
    const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / 86_400_000;
    assert.ok(days > 360 && days < 367, `${days} days`);
    assert.ok((Date.parse(ca.validTo) - Date.parse(leaf.validTo)) > 0, 'the CA outlives the leaf');
    assert.ok(!/\*/.test(leaf.subjectAltName ?? ''));
    assert.ok(leaf.publicKey.asymmetricKeyType === 'ec');
  });

  it('the CA carries a critical name constraint (and --no-name-constraints really removes it)', () => {
    const NC_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e]);
    const withNc = join(scratch(), 'a');
    const withoutNc = join(scratch(), 'b');
    assert.equal(run(['--out', withNc, '--ip', '10.1.2.3']).status, 0);
    const r = run(['--out', withoutNc, '--ip', '10.1.2.3', '--no-name-constraints']);
    assert.equal(r.status, 0);
    assert.ok(new X509Certificate(readFileSync(join(withNc, 'ca.crt.pem'))).raw.includes(NC_OID));
    assert.ok(!new X509Certificate(readFileSync(join(withoutNc, 'ca.crt.pem'))).raw.includes(NC_OID));
    assert.match(r.stdout, /NO name constraint/);
    // OpenSSL, when this machine has it, reads the CA the same way.
    const o = spawnSync('openssl', ['x509', '-in', join(withNc, 'ca.crt.pem'), '-noout', '-text'], { encoding: 'utf8' });
    if (o.status === 0) assert.match(o.stdout, /Name Constraints: critical[\s\S]*IP:10\.1\.2\.3\/255\.255\.255\.255/);
  });

  it('the iOS profile carries ONLY the CA certificate: no private key, the right payload type', () => {
    const out = join(scratch(), 'v');
    assert.equal(run(['--out', out, '--ip', '192.168.50.7', '--venue', 'A & B <Cafe>']).status, 0);
    const plist = readFileSync(join(out, 'hankha-bridge-ca.mobileconfig'), 'utf8');
    assert.match(plist, /<string>com\.apple\.security\.root<\/string>/);
    assert.match(plist, /<string>Configuration<\/string>/);
    assert.ok(plist.includes('A &amp; B &lt;Cafe&gt;'), 'venue name is escaped');
    const b64 = /<data>([\s\S]*?)<\/data>/.exec(plist)?.[1]?.replace(/\s+/g, '') as string;
    const embedded = new X509Certificate(Buffer.from(b64, 'base64'));
    assert.equal(embedded.fingerprint256, new X509Certificate(readFileSync(join(out, 'ca.crt.pem'))).fingerprint256);
    assert.ok(embedded.ca);
    assert.doesNotMatch(plist, /PRIVATE KEY/);
    const caKeyDer = createPrivateKey(readFileSync(join(out, 'ca.key.pem'))).export({ type: 'pkcs8', format: 'der' }).toString('base64');
    assert.ok(!plist.replace(/\s+/g, '').includes(caKeyDer.slice(0, 40)), 'the CA key is not in the profile');
    const lint = spawnSync('plutil', ['-lint', join(out, 'hankha-bridge-ca.mobileconfig')], { encoding: 'utf8' });
    if (lint.error === undefined) assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  });

  it('refuses public addresses, loopback without the flag, wildcard names, silly lifetimes, and overwriting', () => {
    const out = join(scratch(), 'v');
    for (const args of [
      ['--ip', '8.8.8.8'], ['--ip', '127.0.0.1'], ['--ip', 'not-an-ip'], ['--ip', '192.168.1.5', '--hostname', '*.example.com'],
      ['--ip', '192.168.1.5', '--days', '900'], ['--ip', '192.168.1.5', '--days', '0'], [], ['--ip', '192.168.1.5', '--ca-subnet', '192.168.2.0/24'],
      ['--ip', '192.168.1.5', '--ca-subnet', '10.0.0.0/8'],
    ]) {
      const r = run(['--out', out, ...args]);
      assert.equal(r.status, 2, args.join(' '));
    }
    assert.equal(existsSync(out) && readdirSync(out).length > 0, false, 'nothing was written by the refusals');
    assert.equal(run(['--out', out, '--ip', '192.168.1.5']).status, 0);
    const again = run(['--out', out, '--ip', '192.168.1.5']);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already holds certificate files/);
  });

  it('--renew keeps the CA (iPads need nothing), issues a fresh leaf, and refuses an address the CA does not cover', () => {
    const out = join(scratch(), 'v');
    assert.equal(run(['--out', out, '--ip', '192.168.50.7']).status, 0);
    const caBefore = readFileSync(join(out, 'ca.crt.pem'), 'utf8');
    const profileBefore = readFileSync(join(out, 'hankha-bridge-ca.mobileconfig'), 'utf8');
    const leafBefore = new X509Certificate(readFileSync(join(out, 'bridge.crt.pem')));
    const r = run(['--out', out, '--ip', '192.168.50.7', '--renew']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(out, 'ca.crt.pem'), 'utf8'), caBefore);
    assert.equal(readFileSync(join(out, 'hankha-bridge-ca.mobileconfig'), 'utf8'), profileBefore, 'the profile is untouched');
    const leafAfter = new X509Certificate(readFileSync(join(out, 'bridge.crt.pem')));
    assert.notEqual(leafAfter.serialNumber, leafBefore.serialNumber);
    assert.ok(leafAfter.verify(new X509Certificate(caBefore).publicKey));
    if (process.platform !== 'win32') assert.equal(statSync(join(out, 'bridge.key.pem')).mode & 0o777, 0o600);
    const wrong = run(['--out', out, '--ip', '192.168.50.99', '--renew']);
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /outside what this CA may vouch for/);
    // --ca-subnet makes the later address legitimate.
    const wide = join(scratch(), 'w');
    assert.equal(run(['--out', wide, '--ip', '192.168.50.7', '--ca-subnet', '192.168.50.0/24']).status, 0);
    assert.equal(run(['--out', wide, '--ip', '192.168.50.99', '--renew']).status, 0);
  });

  it('the files it writes are what the Bridge loads: certificate, key, no warnings', () => {
    const out = join(scratch(), 'v');
    assert.equal(run(['--out', out, '--ip', '192.168.50.7']).status, 0);
    const r = loadLanTls({ cert_path: join(out, 'bridge.crt.pem'), key_path: join(out, 'bridge.key.pem') }, out);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.tls.warnings, []);
  });
});
