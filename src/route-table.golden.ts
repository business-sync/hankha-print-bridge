/*
 * The 9200 route table as the M1 build answered it: (method, path, body) -> status.
 *
 * M5 adds a SECOND listener and must not change this one. `route-table.test.ts` replays these
 * probes against the current `createBridgeServer()` and requires the same statuses, so a LAN route
 * that leaked onto 9200 (or a legacy route that moved) fails a test instead of shipping.
 */
export interface RouteProbe {
  method: string;
  path: string;
  body?: unknown;
}

export const ROUTE_PROBES: RouteProbe[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/status' },
  { method: 'GET', path: '/jobs' },
  { method: 'GET', path: '/jobs/does-not-exist' },
  { method: 'GET', path: '/printers' },
  { method: 'GET', path: '/service' },
  { method: 'GET', path: '/nope' },
  { method: 'GET', path: '/lan/v1/hello' },
  { method: 'GET', path: '/lan/v1/printers' },
  { method: 'POST', path: '/lan/v1/jobs', body: {} },
  { method: 'POST', path: '/lan/v1/jobs/status', body: { keys: [] } },
  { method: 'POST', path: '/lan/v1/jobs/abcdefgh/cancel', body: {} },
  { method: 'POST', path: '/probe', body: {} },
  { method: 'POST', path: '/print', body: {} },
  { method: 'POST', path: '/jobs', body: {} },
  { method: 'POST', path: '/jobs/does-not-exist/cancel', body: {} },
  { method: 'POST', path: '/nope', body: {} },
  { method: 'OPTIONS', path: '/print' },
  { method: 'OPTIONS', path: '/lan/v1/jobs' },
  { method: 'DELETE', path: '/jobs/x' },
];

/** Recorded by replaying ROUTE_PROBES against the M1 build (commit 5218ed3), before any M5 change. */
export const ROUTE_STATUSES: Record<string, number> = {
  'GET /health': 200,
  'GET /': 200,
  'GET /status': 200,
  'GET /jobs': 200,
  'GET /jobs/does-not-exist': 404,
  'GET /printers': 200,
  'GET /service': 200,
  'GET /nope': 404,
  'GET /lan/v1/hello': 404,
  'GET /lan/v1/printers': 404,
  'POST /lan/v1/jobs': 404,
  'POST /lan/v1/jobs/status': 404,
  'POST /lan/v1/jobs/abcdefgh/cancel': 404,
  'POST /probe': 400,
  'POST /print': 400,
  'POST /jobs': 400,
  'POST /jobs/does-not-exist/cancel': 404,
  'POST /nope': 404,
  'OPTIONS /print': 204,
  'OPTIONS /lan/v1/jobs': 204,
  'DELETE /jobs/x': 404,
};
