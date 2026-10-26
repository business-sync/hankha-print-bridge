// Hankha print-bridge TLS probe: runs the same four Bun TLS clients the bridge uses against
// public hosts and reports which verify. Read-only; writes probe-output-<variant>.txt beside the exe.
import tls from 'node:tls';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import r4 from './gts-root-r4.pem' with { type: 'text' };
import gsr1 from './globalsign-root-r1.pem' with { type: 'text' };

declare const VARIANT: string;
const lines: string[] = [];
const log = (...a: unknown[]) => { const s = a.join(' '); lines.push(s); console.log(s); };
const code = (e: any) => `${e?.code ?? '-'} | ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 140)}`;
const T = 12_000;

log('hankha tls probe', VARIANT, '| bun', Bun.version, process.platform, process.arch, '|', new Date().toISOString());
log('execArgv', JSON.stringify(process.execArgv), 'argv', JSON.stringify(process.argv));
log('user', process.env.USERNAME ?? '?', 'computer', process.env.COMPUTERNAME ?? '?');
log('env of interest', JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /proxy|ssl_cert|extra_ca|tls_reject|node_options|^bun_|openssl|curl_ca/i.test(k)))));
const roots: string[] = (tls as any).rootCertificates ?? [];
const subj = roots.map((p) => { try { return new X509Certificate(p).subject.replace(/\n/g, ', '); } catch { return '?'; } });
const has = (n: string) => subj.some((s) => s.includes(n));
log('tls.rootCertificates', roots.length, '| GTS Root R4', has('CN=GTS Root R4'), '| GTS Root R1', has('CN=GTS Root R1'), '| GlobalSign Root CA (R1)', has('CN=GlobalSign Root CA'), '| ISRG Root X1', has('ISRG Root X1'));

async function tryFetch(label: string, url: string, init?: any) {
  try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(T) }); log(`  fetch ${label}: OK ${r.status}`); await r.arrayBuffer(); }
  catch (e) { log(`  fetch ${label}: ERR ${code(e)}`); }
}
function tryHttps(label: string, url: string) {
  return new Promise<void>((res) => {
    const req = https.get(url, { timeout: T }, (r) => { log(`  node:https ${label}: OK ${r.statusCode}`); r.resume(); res(); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { log(`  node:https ${label}: ERR ${code(e)}`); res(); });
  });
}
function tryTls(label: string, host: string, verify: boolean) {
  return new Promise<void>((res) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: verify, timeout: T }, () => {
      let c: any = s.getPeerCertificate(true); const chain: string[] = []; const seen = new Set<any>();
      while (c && typeof c === 'object' && Object.keys(c).length && !seen.has(c)) {
        seen.add(c); chain.push(`[${c.subject?.CN ?? c.subject?.O}] <- [${c.issuer?.CN ?? c.issuer?.O}]${c.raw ? '' : ' (no raw)'}`);
        if (c.issuerCertificate === c) break; c = c.issuerCertificate;
      }
      log(`  node:tls ${label} verify=${verify}: authorized=${s.authorized} ${s.authorizationError ?? ''} | chain: ${chain.join(' | ')}`);
      s.end(); res();
    });
    s.on('timeout', () => s.destroy(new Error('timeout')));
    s.on('error', (e) => { log(`  node:tls ${label} verify=${verify}: ERR ${code(e)}`); res(); });
  });
}
function tryWs(label: string, url: string) {
  return new Promise<void>((res) => {
    let done = false;
    const fin = (m: string) => { if (!done) { done = true; log(`  WebSocket ${label}: ${m}`); res(); } };
    const t = setTimeout(() => fin('TIMEOUT'), T);
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => { clearTimeout(t); fin('OPEN'); ws.close(); };
      ws.onerror = (ev: any) => { clearTimeout(t); fin('ERR ' + String(ev?.message ?? ev?.error?.message ?? '').slice(0, 140)); };
      ws.onclose = (ev: any) => { clearTimeout(t); fin(`CLOSE ${ev.code} ${String(ev.reason).slice(0, 140)}`); };
    } catch (e) { clearTimeout(t); fin('THROW ' + code(e)); }
  });
}


if (process.argv[2] === 'race') {
  log('== race: WebSocket dial and first fetch started together (fresh process)');
  const wsP = new Promise<string>((res) => { const s = new WebSocket('wss://api.hankha.la/api/v1/modules/print/bridge/socket'); s.onopen = () => { res('OPEN'); s.close(); }; s.onerror = (e: any) => res('ERR ' + String(e.message).slice(-40)); s.onclose = (e: any) => res('CLOSE ' + e.code); });
  const fP = fetch('https://api.hankha.la/api/v1/system/health', { signal: AbortSignal.timeout(T) }).then((r) => 'OK ' + r.status, (e: any) => 'ERR ' + code(e));
  const [w, f1] = await Promise.all([wsP, fP]);
  const f2 = await fetch('https://api.hankha.la/api/v1/system/health', { signal: AbortSignal.timeout(T) }).then((r) => 'OK ' + r.status, (e: any) => 'ERR ' + code(e));
  log(`  websocket=${w} | fetch during dial=${f1} | fetch after=${f2}`);
}

const targets: Array<[string, string]> = [
  ['api.hankha.la', 'https://api.hankha.la/api/v1/system/health'],
  ['www.google.com', 'https://www.google.com/generate_204'],
  ['letsencrypt.org', 'https://letsencrypt.org/'],
  ['www.digicert.com', 'https://www.digicert.com/'],
  ['www.cloudflare.com', 'https://www.cloudflare.com/cdn-cgi/trace'],
];
for (const [host, url] of targets) {
  log(`== ${host}`);
  await tryFetch('default', url);
  await tryHttps('default', url);
  await tryTls('default', host, true);
  await tryTls('peek', host, false);
}
log('== api.hankha.la with explicit tls options');
const api = 'https://api.hankha.la/api/v1/system/health';
await tryFetch('ca=[GTS Root R4]', api, { tls: { ca: [r4] } });
await tryFetch('ca=[GlobalSign Root CA R1]', api, { tls: { ca: [gsr1] } });
await tryFetch('ca=tls.rootCertificates (all bundled)', api, { tls: { ca: roots } });
await tryFetch('rejectUnauthorized=false', api, { tls: { rejectUnauthorized: false } });
log('== WebSocket (badssl hosts: "Expected 101" means TLS passed, "TLS handshake failed" means it was verified and rejected)');
await tryWs('api.hankha.la socket', 'wss://api.hankha.la/api/v1/modules/print/bridge/socket');
await tryWs('untrusted-root.badssl.com', 'wss://untrusted-root.badssl.com/');
await tryWs('self-signed.badssl.com', 'wss://self-signed.badssl.com/');
await tryTls('untrusted-root.badssl.com', 'untrusted-root.badssl.com', true);
await tryFetch('untrusted-root.badssl.com', 'https://untrusted-root.badssl.com/');
log('== done');
const out = (process.execPath.match(/\.exe$/i) ? process.execPath.replace(/[^\\/]+$/, "") : "") + `probe-output-${VARIANT}${process.argv[2] === 'race' ? '-race' : ''}.txt`;
try { writeFileSync(out, lines.join('\n') + '\n'); console.log('written', out); } catch (e: any) { console.log('could not write', out, e?.message); }
