/*
 * A `fetch` look-alike over node:https with an explicit trust anchor. The global fetch trusts the
 * system store only, and the LAN listener's certificate comes from a per-venue CA that is not in it.
 * Only what the tests use is implemented: status, headers, text(), json().
 */
import { request } from 'node:https';

export function httpsFetcher(ca: Buffer | string, extra: { servername?: string } = {}): typeof fetch {
  const impl = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers: Record<string, string> = {};
      if (init.headers) for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
      const body = init.body === undefined || init.body === null ? undefined : String(init.body);
      const req = request(
        {
          host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: init.method ?? 'GET', ca,
          headers: { ...headers, ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
          // A fresh connection per call: a test that wants to see a handshake failure must not reuse a socket.
          agent: false,
          ...(extra.servername ? { servername: extra.servername } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v);
            resolve({
              status: res.statusCode ?? 0,
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
              headers: h,
              text: async () => text,
              json: async () => JSON.parse(text),
            } as unknown as Response);
          });
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  return impl as typeof fetch;
}
