/*
 * The gate in front of `/service/*`, and the reason this feature can exist at all.
 *
 * Every other route on this bridge answers `Access-Control-Allow-Origin: *` and
 * `Access-Control-Allow-Private-Network: true` (see `withCors` in server.ts). That is a
 * deliberate, documented trade for PRINTING: the terminal's origin varies too much to pin, and
 * the surface is a LAN one the venue's own firewall already scopes.
 *
 * It cannot extend to rebooting a computer or removing the bridge from it. With those headers,
 * any web page an operator happens to open on the till could reboot the till, and a
 * DNS-rebinding page could do it from outside the venue entirely. So this family gets five
 * layers instead, cheapest first — and the last one holds even if every other one is wrong:
 *
 *  1. LOOPBACK. Computed by the caller (server.ts owns the socket) and passed in, so this module
 *     stays free of any import from the request layer.
 *  2. NO CORS HEADERS on the family at all, and `OPTIONS` refused. A cross-origin `fetch` then
 *     fails its preflight and the request never arrives. Our own page is same-origin and never
 *     preflights past it.
 *  3. ORIGIN / SEC-FETCH-SITE. Closes the path layer 2 cannot see: a plain HTML `<form>` POST is
 *     a simple request that skips the preflight entirely, and it still carries `Origin`.
 *  4. HOST PIN. A rebinding page resolves `evil.example` to 127.0.0.1 and sends
 *     `Host: evil.example`. It passes 1 and 3 — and fails here.
 *  5. A ONE-TIME CONFIRM TOKEN, minted by `GET /service`. Blind CSRF cannot guess it, which
 *     makes every layer above it defence in depth rather than the only thing standing there.
 *
 * Plus two properties that are not layers but are load-bearing: one action at a time, and every
 * attempt logged — the answer to "who rebooted the till at 19:40".
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface GateFailure {
  status: number;
  reason: string;
}

/** How long a minted confirmation stays good. Long enough to read a warning, short enough to matter. */
const CONFIRM_TTL_MS = 120_000;
/**
 * More than one live at a time, deliberately.
 *
 * The page refreshes `/service` on its ordinary ten-second poll AND once more immediately before
 * it submits an action. With a single slot those two race, and the loser is the operator's
 * button — which fails with "that confirmation expired" for no reason they can see.
 */
const MAX_LIVE_CONFIRMS = 8;
/** A wedged action must not lock the card forever. */
const ACTION_TIMEOUT_MS = 120_000;

/**
 * The whole family can be switched off for a managed fleet that wants no controls on screen.
 * Anything but an explicit off leaves it on, so a typo cannot silently disable the routes an
 * operator has been told to use.
 */
export function serviceControlEnabled(): boolean {
  const raw = process.env.PRINT_BRIDGE_SERVICE_CONTROL?.trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

/* ------------------------------------------------------------------ host pins */

/** `localhost`, any 127/8 address, or `::1` — with or without a port, bracketed or not. */
function isLocalHostname(value: string | undefined): boolean {
  if (!value) return false;
  let host = value.trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    host = close === -1 ? host.slice(1) : host.slice(1, close);
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The anti-rebinding check.
 *
 * HTTP/1.1 requires a Host header, so an absent one is not a browser and not something this
 * family serves. `curl http://127.0.0.1:9200/service` sends one; a rebinding page sends the
 * attacker's own name, which is the entire point of catching it here.
 */
function hostAllowed(req: IncomingMessage): boolean {
  return isLocalHostname(req.headers.host);
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // Absent is the normal case for `curl` and for a same-origin GET; browsers add it to every
  // cross-origin request, including the form POST that skips a preflight.
  if (!origin || origin === 'null') return !origin;
  try {
    return isLocalHostname(new URL(origin).host);
  } catch {
    return false;
  }
}

function siteAllowed(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === undefined) return true; // not a browser
  const value = Array.isArray(site) ? site[0] : site;
  // `none` is a direct navigation (typing the address); `same-origin` is our own page's fetch.
  return value === 'same-origin' || value === 'none';
}

/**
 * Everything but the confirmation, in one call.
 *
 * Returns null when the request may proceed. The reasons are stable identifiers rather than
 * prose: they are logged, and the page maps them to its own wording.
 */
export function gateServiceRequest(
  req: IncomingMessage,
  options: { loopback: boolean }
): GateFailure | null {
  if (!serviceControlEnabled()) return { status: 404, reason: 'not-found' };
  if (!options.loopback) return { status: 403, reason: 'not-loopback' };
  if (!hostAllowed(req)) return { status: 403, reason: 'bad-host' };
  if (!originAllowed(req)) return { status: 403, reason: 'cross-origin' };
  if (!siteAllowed(req)) return { status: 403, reason: 'cross-site' };
  return null;
}

/* ------------------------------------------------------------ confirm tokens */

const live = new Map<string, number>();

function pruneConfirms(now: number): void {
  for (const [token, expires] of live) {
    if (expires <= now) live.delete(token);
  }
  while (live.size > MAX_LIVE_CONFIRMS) {
    const oldest = live.keys().next().value;
    if (oldest === undefined) break;
    live.delete(oldest);
  }
}

export function issueConfirmToken(): { confirm_token: string; confirm_expires_at: string } {
  const now = Date.now();
  pruneConfirms(now);
  const token = randomBytes(16).toString('hex');
  live.set(token, now + CONFIRM_TTL_MS);
  return { confirm_token: token, confirm_expires_at: new Date(now + CONFIRM_TTL_MS).toISOString() };
}

/**
 * Spend a confirmation. Single use: a token that authorised a reboot cannot then authorise an
 * uninstall, so a captured one is worth exactly one action the operator already intended.
 */
export function consumeConfirmToken(value: unknown): boolean {
  const now = Date.now();
  pruneConfirms(now);
  if (typeof value !== 'string' || value.length === 0) return false;

  const given = Buffer.from(value);
  for (const [token, expires] of live) {
    const expected = Buffer.from(token);
    if (given.length !== expected.length) continue;
    if (!timingSafeEqual(given, expected)) continue;
    live.delete(token);
    return expires > now;
  }
  return false;
}

/** Test-only: drop every outstanding confirmation. */
export function resetConfirmTokens(): void {
  live.clear();
}

/* -------------------------------------------------------------------- mutex */

let running: { name: string; at: number } | null = null;

function pruneAction(): void {
  if (running && Date.now() - running.at > ACTION_TIMEOUT_MS) running = null;
}

export function currentAction(): string | null {
  pruneAction();
  return running?.name ?? null;
}

/** False when something else is already in flight — the caller answers 409 with its name. */
export function beginAction(name: string): boolean {
  pruneAction();
  if (running) return false;
  running = { name, at: Date.now() };
  return true;
}

export function endAction(): void {
  running = null;
}
