/*
 * The page a person gets when they open the bridge in a browser.
 *
 * Until now `GET /` answered `{"ok":false,"reason":"not-found"}`, and that is the single most
 * likely thing an operator ever does with this process: the installer says the bridge listens on
 * http://localhost:9200, so they type it in. A JSON 404 reads as "the thing I just installed is
 * broken", which is the opposite of true and costs a support call.
 *
 * What this page is for, in order of how often it is needed:
 *
 *  1. Proving the bridge is alive, and saying WHICH machine is answering. Once installed it is a
 *     launchd daemon or a scheduled task with no window and no dock icon.
 *  2. Handing over the address another till should be pointed at — with the caveat that a POS
 *     served over https can only reach a bridge on loopback, which is the single most common
 *     misconfiguration in this app.
 *  3. Answering "did it print?" — printers online/offline, and the recent jobs with their reasons.
 *
 * It is deliberately NOT a printer configuration UI. `printers.json` is the source of truth and it
 * is edited through `PUT /printers` (or by hand); a second editor here would be a second way for
 * the registry to be wrong. The one action offered is a test print, because "is this printer the
 * one by the till?" cannot be answered by reading anything.
 *
 * Why it lives in a .ts file as a string rather than beside the code as index.html: the shipped
 * artifact is a single self-contained binary (`bun build --compile`), with no assets directory and
 * no cwd worth trusting. Anything read with `readFileSync` at runtime exists in `npm run dev` and
 * is missing in every installed copy — a failure mode that would never show up in development.
 *
 * One trap for anyone editing this: `scripts/package.mjs` compiles with
 * `--define process.env.APP_VERSION=...`, a plain source rewrite that does not care whether the
 * expression is inside a string. Do not write that expression here. The page asks `/health` for
 * the version at runtime instead, which is also how it stays honest after an upgrade.
 */

/*
 * Locked down to what the page actually uses, which is: itself.
 *
 * `default-src 'none'` plus `connect-src 'self'` is the part that earns its keep — this process is
 * reachable from the venue LAN, and it means nothing served here can be made to load or post to an
 * outside host. The inline allowances are not a weakening worth avoiding with a nonce: the page
 * renders every value through `textContent`, so there is no interpolation for a nonce to protect,
 * and a per-request nonce would only make the served bytes differ for no gain.
 *
 * `form-action 'none'` is the one that is not decoration. The token box is a real <form> so Enter
 * submits it; if its JS handler ever failed to run, the browser's default would put the venue's
 * printer token in a URL query string. This makes that navigation impossible rather than unlikely.
 */
export const INDEX_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
  "img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'";

/** The icon the installers ship, redrawn small enough to inline. Saves a request and a 404. */
const FAVICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiNFQzZDMTgiLz48cGF0aCBkPSJNMjMgMTFoMTh2MTRIMjN6IiBmaWxsPSIjZmZmIi8+PHJlY3QgeD0iMTQiIHk9IjI1IiB3aWR0aD0iMzYiIGhlaWdodD0iMjAiIHJ4PSI1IiBmaWxsPSIjZmZmIi8+PHJlY3QgeD0iMjIiIHk9IjMwIiB3aWR0aD0iMjAiIGhlaWdodD0iNCIgcng9IjIiIGZpbGw9IiNERjU2MEIiLz48Y2lyY2xlIGN4PSI0MiIgY3k9IjM5IiByPSIyLjUiIGZpbGw9IiNERjU2MEIiLz48cGF0aCBkPSJNMjIgNTMuNWExNCAxNCAwIDAgMSAyMCAwIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PGNpcmNsZSBjeD0iMzIiIGN5PSI1OCIgcj0iMy4yIiBmaWxsPSIjZmZmIi8+PC9zdmc+';

/*
 * Palette sampled from the installer's own app icon (#F88229 → #DF560B), so the page and the thing
 * in the Applications folder are recognisably one product.
 *
 * Both schemes are defined in full rather than as a dark-mode patch: a till screen is as often a
 * bright counter as a dim kitchen pass, and `prefers-color-scheme` is whatever the OS was set to
 * years ago.
 *
 * The Lao faces are in the stack because printer names come from a venue's own registry and this
 * is a Lao product — a station called ຄົວ must not render as boxes. All three are named on
 * purpose: the CSP below is `default-src 'none'` with no `font-src`, so NOTHING here can be
 * fetched and every name has to already be on the machine. "Noto Sans Lao" covers macOS and most
 * Linux; Windows has neither it nor a Lao-capable `sans-serif`, and ships "Leelawadee UI" (10 and
 * later) or "Lao UI" (7/8) instead. With only the Noto name a stock Windows till fell through to
 * a Latin face and printed the boxes this comment claims to prevent.
 */
const CSS = `
*, *::before, *::after { box-sizing: border-box; }

:root {
  color-scheme: light dark;
  --accent: #C7500B;
  --accent-ink: #fff;
  --accent-soft: #FCEFE4;
  --bg: #F6F4F1;
  --surface: #fff;
  --surface-2: #FAF8F6;
  --border: #E7E1D9;
  --border-strong: #D5CCC2;
  --text: #1B1917;
  --muted: #6D6660;
  --faint: #9B938B;
  --ok: #15703A;      --ok-bg: #E7F4EB;
  --bad: #B32424;     --bad-bg: #FBEBEB;
  --warn: #8A5D04;    --warn-bg: #FBF1DE;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans Lao", "Leelawadee UI", "Lao UI", sans-serif;
  --radius: 12px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent: #FF8C42;
    --accent-ink: #21160E;
    --accent-soft: #2A1B10;
    --bg: #131110;
    --surface: #1B1917;
    --surface-2: #211E1B;
    --border: #302B27;
    --border-strong: #443C36;
    --text: #F4F0EC;
    --muted: #A39A92;
    --faint: #786F68;
    --ok: #5FD08A;      --ok-bg: #12261A;
    --bad: #FF8A8A;     --bad-bg: #2B1616;
    --warn: #F3C05F;    --warn-bg: #2A2011;
  }
}

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 var(--sans);
  padding: 24px 20px 56px;
}

.wrap { max-width: 1120px; margin: 0 auto; }

/* ------------------------------------------------------------------ header */

.top {
  display: flex; flex-wrap: wrap; align-items: center; gap: 16px;
  padding-bottom: 20px; margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 13px; min-width: 0; }
.brand svg { width: 42px; height: 42px; flex: none; border-radius: 10px; }
.title { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
.sub {
  margin: 3px 0 0; color: var(--muted); font-size: 12.5px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
}
.sub .sep { color: var(--faint); }
.badge {
  font: 600 11.5px/1 var(--mono);
  padding: 5px 8px; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid transparent;
}
.actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto; }

/* ------------------------------------------------------------------ controls */

.btn {
  font: 500 13px var(--sans);
  padding: 7px 13px; border-radius: 8px; cursor: pointer;
  background: var(--accent); color: var(--accent-ink);
  border: 1px solid transparent;
}
.btn:hover { filter: brightness(1.06); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .55; cursor: default; transform: none; filter: none; }
.btn-ghost { background: var(--surface); color: var(--text); border-color: var(--border-strong); }
.btn-ghost:hover { background: var(--surface-2); filter: none; }
.btn-sm { font-size: 12px; padding: 4px 9px; border-radius: 7px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

input[type=password], input[type=text] {
  font: 13px var(--mono);
  padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--text);
  min-width: 0;
}

/* ------------------------------------------------------------------ banners */

/* Plain prose. As a flex row the lead clause became its own narrow column on a phone. */
.banner {
  padding: 11px 14px; border-radius: var(--radius);
  margin-bottom: 12px; font-size: 13px;
  border: 1px solid transparent;
}
.banner b { font-weight: 600; }
.banner-warn { background: var(--warn-bg); color: var(--warn); border-color: currentColor; }
.banner-bad  { background: var(--bad-bg);  color: var(--bad);  border-color: currentColor; }
.banner-ok   { background: var(--ok-bg);   color: var(--ok);   border-color: currentColor; }

/* ------------------------------------------------------------------ token gate */

.gate {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px 18px; margin-bottom: 16px;
}
.gate h2 { margin: 0 0 4px; font-size: 14px; font-weight: 650; }
.gate p { margin: 0 0 12px; color: var(--muted); font-size: 13px; max-width: 62ch; }
.gate form { display: flex; gap: 8px; flex-wrap: wrap; }
.gate input { flex: 1 1 260px; }

/* ------------------------------------------------------------------ pairing */

/*
 * The code is read off a tablet held in the other hand and retyped here, so it is set large,
 * monospaced and letter-spaced: at 13px in the body face, B/8 and S/5 are a coin toss, and a
 * mistyped character costs a whole 15-minute code.
 */
.pair-lead { margin: 0 0 8px; color: var(--muted); font-size: 13px; max-width: 62ch; }
.pair-steps { margin: 0 0 12px; padding-left: 20px; color: var(--muted); font-size: 13px; }
.pair-steps li { margin-bottom: 3px; }
.pair-steps strong { color: var(--text); font-weight: 600; }
#pair-form { display: flex; gap: 8px; flex-wrap: wrap; }
#pair-code {
  flex: 1 1 190px; font-family: var(--mono); font-size: 18px; font-weight: 650;
  letter-spacing: .16em; text-transform: uppercase; text-align: center;
}
.pair-result { margin: 10px 0 0; font-size: 13px; line-height: 1.45; }
.pair-result.is-ok { color: var(--ok); }
.pair-result.is-err { color: var(--bad); }
.pair-result.is-busy { color: var(--muted); }

/* ------------------------------------------------------------------ cards */

/*
 * Two columns, stated rather than derived. An auto-fit track list picks three on a wide
 * screen and leaves the fourth card alone on a row with two card-widths of nothing beside it.
 * Two columns with the wide cards spanning both means every row is full at every size.
 */
.grid { display: grid; gap: 14px; grid-template-columns: 1fr; align-items: start; }
@media (min-width: 800px) { .grid { grid-template-columns: 1fr 1fr; } }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); overflow: hidden;
}
.card-wide { grid-column: 1 / -1; }
.card-head {
  display: flex; align-items: baseline; gap: 10px;
  padding: 13px 16px; border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.card-title {
  margin: 0; font-size: 11px; font-weight: 650;
  letter-spacing: .07em; text-transform: uppercase; color: var(--muted);
}
.card-note { margin-left: auto; font-size: 12px; color: var(--faint); }
.card-body { padding: 14px 16px; }
.card-body > p { margin: 0 0 10px; color: var(--muted); font-size: 12.5px; }
.card-body > p:last-child { margin-bottom: 0; }

/* ------------------------------------------------------------------ key/value */

.kv { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 7px 16px; }
.kv dt { color: var(--muted); font-size: 12.5px; }
.kv dd { margin: 0; text-align: right; overflow-wrap: break-word; }

/* ------------------------------------------------------------------ tables */

.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
/*
 * A floor for the tables that carry real columns. A plain width of 100% makes a narrow screen
 * compress them until a printer id wraps to "counte / r" — legible only in the sense that every
 * letter is present. Below this width the row scrolls sideways instead, which keeps each field
 * readable and is the one place on this page a horizontal scroll is the right answer.
 */
.table-wide { min-width: 620px; }
.table-wide .mono { overflow-wrap: normal; }
th {
  text-align: left; font-size: 10.5px; font-weight: 650;
  letter-spacing: .06em; text-transform: uppercase; color: var(--faint);
  padding: 9px 16px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
td { padding: 11px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.name { font-weight: 550; }
.detail { display: block; margin-top: 3px; color: var(--muted); font-size: 12px; overflow-wrap: break-word; }

/* ------------------------------------------------------------------ status marks */

.dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-right: 8px; flex: none; background: var(--faint);
  vertical-align: 1px;
}
.dot-ok  { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-bg); }
.dot-bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-bg); }
.dot-warn{ background: var(--warn); box-shadow: 0 0 0 3px var(--warn-bg); }
.dot-off { background: var(--faint); }

.pill {
  display: inline-block; padding: 2px 8px; border-radius: 999px;
  font: 600 11px/1.6 var(--sans); white-space: nowrap;
  background: var(--surface-2); color: var(--muted);
}
.pill-ok   { background: var(--ok-bg);   color: var(--ok); }
.pill-bad  { background: var(--bad-bg);  color: var(--bad); }
.pill-warn { background: var(--warn-bg); color: var(--warn); }
/* The neutral one, named rather than left as a bare `.pill` built from an empty string. */
.pill-off  { background: var(--surface-2); color: var(--muted); }

.mono { font: 12.5px/1.5 var(--mono); }
.empty { color: var(--faint); font-size: 13px; padding: 4px 0; }

/* ------------------------------------------------------------------ a11y */

/*
 * Announced but not shown. Every fact this page exists to convey arrives as a DOM mutation on a
 * ten-second timer — a printer going offline, a job failing, a test slip coming back. Without a
 * live region a screen-reader user is told none of it, and this page is nothing BUT that.
 */
.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0;
}

.skip {
  position: absolute; left: -9999px;
  background: var(--surface); color: var(--text);
  padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-strong);
  z-index: 10;
}
.skip:focus { left: 12px; top: 12px; }

/* ------------------------------------------------------------------ addresses */

.urls { list-style: none; margin: 0; padding: 0; }
.urls li {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 0; border-bottom: 1px dashed var(--border);
}
.urls li:last-child { border-bottom: 0; }
.urls li:first-child { padding-top: 0; }
.url { font: 13px var(--mono); overflow-wrap: anywhere; }
.url-why { display: block; color: var(--faint); font-size: 11.5px; font-family: var(--sans); margin-top: 2px; }
.urls .copy { margin-left: auto; flex: none; }

/* ------------------------------------------------------------------ discovery */

/*
 * The way out of an empty registry.
 *
 * This card is the one concession to the "not a configuration UI" rule at the top of this file,
 * and it keeps to the letter of it: nothing here writes. It answers "what can this machine see",
 * which previously could only be asked from a terminal — with a binary that is not on PATH after
 * the macOS installer, by an operator who runs a café.
 */
.find { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.find-note { color: var(--faint); font-size: 12px; }

.found { list-style: none; margin: 0; padding: 0; }
.found li {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 0; border-bottom: 1px dashed var(--border);
}
.found li:last-child { border-bottom: 0; }
.found li:first-child { padding-top: 0; }
.found-main { min-width: 0; }
.found-where { font: 12.5px/1.5 var(--mono); overflow-wrap: anywhere; }
.found-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }

.where-file {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
}
.where-file .path { font: 12px var(--mono); color: var(--muted); overflow-wrap: anywhere; min-width: 0; }

/*
 * Row feedback that does not move the row.
 *
 * A test print used to append its result into the State cell, which grew the row and shunted
 * every printer below it down the page — at the exact moment the operator is looking between the
 * screen and the printer to see whether paper came out.
 */
.row-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.feedback {
  display: block; margin-top: 4px; font-size: 11.5px; line-height: 1.4;
  min-height: 1.4em; overflow-wrap: break-word;
}
.feedback-ok  { color: var(--ok); }
.feedback-bad { color: var(--bad); }
.feedback-busy { color: var(--muted); }

/* ------------------------------------------------------------------ footer */

.foot {
  margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border);
  color: var(--faint); font-size: 12px;
  display: flex; flex-wrap: wrap; gap: 6px 14px;
}
.foot code { font: 11.5px var(--mono); color: var(--muted); }

noscript .banner { display: block; }

@media (max-width: 560px) {
  body { padding: 18px 14px 40px; }
  .kv dd { text-align: left; }
  .kv { grid-template-columns: 1fr; gap: 2px; }
  .kv dd { margin-bottom: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
  .btn:active { transform: none; }
}
`;

/*
 * No build step, no framework, no dependency — this file is the whole client.
 *
 * Two rules it does not break:
 *
 *  - Every value from the bridge is written with `textContent`, never `innerHTML`. Printer names
 *    come from a registry a venue edits by hand, and `detail` strings carry raw error text and
 *    printer replies. With no HTML sink there is no escaping question to get wrong later.
 *  - The auto-refresh stops while the tab is hidden. `GET /status` probes every printer once its
 *    five-second cache lapses, and a page left open on a till overnight would otherwise keep a
 *    permanent trickle of connects running against the venue's network for nobody to look at.
 */
const SCRIPT = `
(function () {
  'use strict';

  /*
   * Double the /status probe cache (5s), so roughly every other poll is a real probe rather than
   * a continuous one. An operator watching a printer come back can hit Refresh, which asks for a
   * fresh probe explicitly with ?probe=1 — the distinction that parameter exists for.
   */
  var POLL_MS = 10000;
  var MAX_JOBS = 12;
  /*
   * Every fetch is bounded, and the bounds differ because the work does.
   *
   * A poll is a memory read on the bridge and should never take seconds. A test print is a real
   * job with the server's own 12s deadline, so this sits above it — the point is to outlive the
   * honest answer and still catch a socket that has stopped talking. Discovery sweeps a /24.
   */
  var TIMEOUT_MS = 8000;
  var TEST_TIMEOUT_MS = 20000;
  var DISCOVER_TIMEOUT_MS = 30000;
  /*
   * sessionStorage, not localStorage: this is the venue's shared printer secret, and a page that
   * remembered it forever would turn any browser profile on the till into a permanent key holder.
   * One paste per troubleshooting session is the right trade.
   */
  var TOKEN_KEY = 'hankha-print-bridge-token';

  var timer = null;
  /* Re-rendering the table under a running test print would replace the button mid-click. */
  var testsInFlight = 0;
  /*
   * Sticky, because a rejection is otherwise invisible.
   *
   * A 401 clears the stored token, so the very next poll finds no token at all and would put the
   * generic "this bridge needs a token" back up — leaving someone who just pasted the wrong one
   * looking at a box that appears to have swallowed it. This keeps the answer on screen until
   * they submit something else.
   */
  var tokenRejected = false;

  function $(id) { return document.getElementById(id); }

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /*
   * Rebuild a section only when something a person can see in it has changed.
   *
   * Replacing a table wholesale every ten seconds drops any text selection inside it, and the
   * moment an operator is most likely to be selecting text is when they are copying a failure
   * reason into a support chat. Note what this buys, because it is not obvious: an offline
   * printer has a null latency and an unchanging reason, so a page in the state worth reading
   * settles and stops rebuilding entirely. A healthy one keeps redrawing as latencies jitter by
   * a millisecond, and there is nothing on it anyone is reading.
   */
  var lastRendered = {};
  function changed(key, value) {
    var next = JSON.stringify(value);
    if (lastRendered[key] === next) return false;
    lastRendered[key] = next;
    return true;
  }

  function placeholder(body, columns, text) {
    clear(body);
    var row = h('tr');
    var cell = h('td', 'empty', text);
    cell.colSpan = columns;
    row.appendChild(cell);
    body.appendChild(row);
  }

  /*
   * What the guarded sections say while the token box is up.
   *
   * Not the "Loading" they start on: nothing is loading, and a spinner that never resolves is how
   * an operator concludes the bridge is broken when it is merely asking them for a password.
   */
  function awaitingToken() {
    placeholder($('printers-body'), 5, 'Waiting for the token above.');
    placeholder($('jobs-body'), 4, 'Waiting for the token above.');
    clear($('transports-body'));
    clear($('queue-counts'));
    $('printers-note').textContent = '';
    $('queue-note').textContent = '';
    $('checked').textContent = '';
    /* The DOM no longer matches any signature cached against it. */
    lastRendered = {};
  }

  /* ----------------------------------------------------------------- transport */

  function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (err) { return ''; }
  }

  function writeToken(value) {
    /* Private browsing throws on write; the page still works, it just asks again next reload. */
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (err) { /* ignored on purpose */ }
  }

  /*
   * One transport for the whole page, and the only place a timeout is set.
   *
   * `fetch` has no timeout of its own. A printer that accepts a TCP connection and then never
   * answers used to leave the test-print request pending for the life of the tab — and because a
   * test in flight suppresses the poll, that single hung request stopped the page updating
   * entirely, with the button stuck on "Printing" and nothing on screen explaining why. An abort
   * surfaces as a rejection the callers already handle.
   */
  function request(method, path, payload, timeoutMs) {
    var headers = {};
    var tok = readToken();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    var init = { method: method, headers: headers, cache: 'no-store' };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }

    var timer = null;
    if (typeof AbortController === 'function') {
      var controller = new AbortController();
      init.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || TIMEOUT_MS);
    }
    var done = function () { if (timer) clearTimeout(timer); };

    return fetch(path, init).then(function (res) {
      return res.text().then(function (raw) {
        var body = null;
        try { body = JSON.parse(raw); } catch (err) { body = null; }
        return { status: res.status, body: body };
      });
    }).then(
      function (out) { done(); return out; },
      function (err) {
        done();
        /* An abort is a timeout as far as anyone reading this page is concerned. */
        throw (err && err.name === 'AbortError')
          ? new Error('The bridge did not answer within ' + Math.round((timeoutMs || TIMEOUT_MS) / 1000) + 's.')
          : err;
      }
    );
  }

  function get(path, timeoutMs) { return request('GET', path, undefined, timeoutMs); }
  function post(path, payload, timeoutMs) { return request('POST', path, payload, timeoutMs); }

  /* ----------------------------------------------------------------- formatting */

  function duration(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds)) return '\\u2014';
    var s = Math.max(0, Math.round(seconds));
    var d = Math.floor(s / 86400);
    var hrs = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d) return d + 'd ' + hrs + 'h';
    if (hrs) return hrs + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  function ago(iso) {
    if (!iso) return 'never';
    var then = Date.parse(iso);
    if (isNaN(then)) return String(iso);
    var delta = Math.round((Date.now() - then) / 1000);
    if (delta < 2) return 'just now';
    return duration(delta) + ' ago';
  }

  function clockOf(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '\\u2014';
    return new Date(t).toLocaleTimeString();
  }

  function sizeOf(n) {
    if (typeof n !== 'number') return '\\u2014';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function dot(kind) { return h('span', 'dot dot-' + kind); }

  function banner(kind, strong, rest) {
    var node = h('div', 'banner banner-' + kind);
    node.appendChild(h('b', null, strong));
    if (rest) node.appendChild(document.createTextNode(' ' + rest));
    return node;
  }

  /* ----------------------------------------------------------------- sections */

  function renderIdentity(health) {
    $('version').textContent = 'v' + (health.version || '?');
    var sub = $('sub');
    clear(sub);
    var bits = [
      health.hostname,
      health.platform + '/' + health.arch,
      'pid ' + health.pid,
      'up ' + duration(health.uptime_s)
    ];
    for (var i = 0; i < bits.length; i++) {
      if (i > 0) sub.appendChild(h('span', 'sep', '\\u00b7'));
      sub.appendChild(h('span', i === 0 ? 'name' : null, bits[i]));
    }
  }

  /*
   * The addresses another device would use, straight from the interfaces /health reports.
   *
   * The mixed-content note is not padding: a POS served over https may only call http:// on
   * localhost, so every LAN address below is unreachable from that terminal no matter how the
   * network is set up. It is the most common way this install is got wrong.
   *
   * But it is CONDITIONAL, and stating it unconditionally was worse than not stating it. Served
   * over https — which this bridge supports, via PRINT_BRIDGE_TLS_CERT — the page printed
   * "reachable only by a POS served over plain http" directly beneath an https:// address: both
   * self-contradictory, and backwards, since a bridge behind TLS is reachable from an https
   * terminal and being reachable from one is the whole reason to configure it. The rule only
   * bites when THIS page is served over plain http, so it is only said then.
   */
  function renderReach(health) {
    var list = $('urls');
    clear(list);
    var scheme = location.protocol;
    var secure = scheme === 'https:';
    /* A default port is noise on the line an operator is about to retype. */
    var port = location.port && location.port !== (secure ? '443' : '80') ? ':' + location.port : '';

    var rows = [{
      url: scheme + '//localhost' + port,
      why: secure
        ? 'What a POS on this machine should use.'
        : 'What a POS on this machine should use \\u2014 and the only address one served over https can reach.'
    }];
    var interfaces = health.interfaces || [];
    for (var i = 0; i < interfaces.length; i++) {
      rows.push({
        url: scheme + '//' + interfaces[i].address + port,
        why: secure
          ? 'This LAN (' + interfaces[i].cidr + ') \\u2014 reachable by any POS that trusts this bridge\\u2019s certificate.'
          : 'This LAN (' + interfaces[i].cidr + ') \\u2014 reachable only by a POS served over plain http.'
      });
    }

    for (var j = 0; j < rows.length; j++) list.appendChild(urlRow(rows[j]));
    if (rows.length === 1) {
      list.appendChild(h('li', 'empty', 'No other network interfaces \\u2014 this bridge is bound to loopback.'));
    }
  }

  function urlRow(row) {
    var li = h('li');
    var text = h('span', 'url', row.url);
    text.appendChild(h('span', 'url-why', row.why));
    li.appendChild(text);

    var copy = h('button', 'btn btn-ghost btn-sm copy', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', function () { copyUrl(row.url, copy); });
    li.appendChild(copy);
    return li;
  }

  /*
   * navigator.clipboard is undefined on a plain-http LAN address: only localhost counts as a
   * secure context. Selecting the text is the honest fallback \\u2014 the operator finishes with
   * their own keyboard rather than being told the button does not work here.
   */
  function copyUrl(url, button) {
    var done = function (label) {
      button.textContent = label;
      setTimeout(function () { button.textContent = 'Copy'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done('Copied'); }, function () { selectText(button, done); });
      return;
    }
    selectText(button, done);
  }

  function selectText(button, done) {
    var node = button.parentNode.querySelector('.url');
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    done('Selected');
  }

  function renderPrinters(statuses, registry) {
    var body = $('printers-body');
    var configured = (registry && registry.printers) || [];
    /* checked_at moves on every probe and is not on the page; comparing it would defeat this. */
    if (!changed('printers', [statuses.map(function (p) {
      return [p.id, p.name, p.transport, p.type, p.language, p.enabled, p.online, p.latency_ms, p.detail];
    }), configured])) return;

    var byId = {};
    for (var i = 0; i < configured.length; i++) byId[configured[i].id] = configured[i];

    clear(body);
    $('printers-note').textContent = statuses.length === 1 ? '1 configured' : statuses.length + ' configured';

    if (statuses.length === 0) {
      placeholder(body, 5, 'No printers configured. Add them with PUT /printers, or run hankha-print-bridge --list-printers to see what this machine can see.');
      return;
    }

    for (var j = 0; j < statuses.length; j++) body.appendChild(printerRow(statuses[j], byId[statuses[j].id]));
  }

  function printerRow(status, record) {
    var tr = h('tr');

    var first = h('td');
    first.appendChild(dot(!status.enabled ? 'off' : status.online ? 'ok' : 'bad'));
    first.appendChild(h('span', 'name', status.name || status.id));
    first.appendChild(h('span', 'detail mono', status.id));
    tr.appendChild(first);

    var where = h('td', 'mono');
    where.textContent = locate(status, record);
    where.appendChild(h('span', 'detail', status.transport + ' \\u00b7 ' + status.type + ' \\u00b7 ' + status.language));
    tr.appendChild(where);

    var state = h('td');
    state.appendChild(h('span',
      'pill pill-' + (!status.enabled ? 'warn' : status.online ? 'ok' : 'bad'),
      !status.enabled ? 'Disabled' : status.online ? 'Online' : 'Offline'));
    if (status.detail) state.appendChild(h('span', 'detail', status.detail));
    tr.appendChild(state);

    tr.appendChild(h('td', 'num', status.latency_ms === null || status.latency_ms === undefined
      ? '\\u2014'
      : status.latency_ms + ' ms'));

    var action = h('td', 'num');
    var button = h('button', 'btn btn-ghost btn-sm', 'Test print');
    button.type = 'button';
    button.disabled = !status.enabled;
    button.addEventListener('click', function () { testPrint(status.id, button, state); });
    action.appendChild(button);
    tr.appendChild(action);

    return tr;
  }

  /* /status answers with what a printer IS; the registry knows WHERE it is. Only together do they
     answer "is that the one by the till". */
  function locate(status, record) {
    if (!record) return '\\u2014';
    if (record.queue) return record.queue;
    if (record.device) return record.device;
    if (record.address) return record.address + ':' + (record.port || 9100);
    return '\\u2014';
  }

  function testPrint(printerId, button, cell) {
    testsInFlight++;
    button.disabled = true;
    button.textContent = 'Printing\\u2026';

    post('/printers/' + encodeURIComponent(printerId) + '/test').then(function (res) {
      var ok = res.status === 200 && res.body && res.body.ok === true;
      var result = res.body && res.body.job && res.body.job.result;
      button.textContent = ok ? 'Sent' : 'Failed';
      var note = h('span', 'detail', ok
        ? 'Test slip sent \\u2014 check the paper.'
        : (result && (result.detail || result.reason)) || 'The bridge answered ' + res.status + '.');
      cell.appendChild(note);
      setTimeout(function () {
        button.textContent = 'Test print';
        button.disabled = false;
        if (note.parentNode) note.parentNode.removeChild(note);
      }, 6000);
    }, function () {
      button.textContent = 'Failed';
      button.disabled = false;
    }).then(function () {
      testsInFlight--;
      /* The row was drawn before this ran, so the cached signature no longer matches the DOM. */
      delete lastRendered.printers;
    });
  }

  function renderQueue(queue, jobs) {
    if (!changed('queue', [queue, jobs])) return;
    var counts = $('queue-counts');
    clear(counts);
    var order = ['queued', 'printing', 'done', 'failed', 'expired'];
    for (var i = 0; i < order.length; i++) {
      counts.appendChild(h('dt', null, order[i]));
      counts.appendChild(h('dd', 'num', queue && typeof queue[order[i]] === 'number' ? queue[order[i]] : 0));
    }
    $('queue-note').textContent = (queue && queue.pending ? queue.pending : 0) + ' in flight';

    var body = $('jobs-body');
    clear(body);
    if (!jobs || jobs.length === 0) {
      placeholder(body, 4, 'Nothing printed since this bridge started.');
      return;
    }

    /* queue.list() returns in-flight jobs first and then history, not newest first. */
    var recent = jobs.slice().sort(function (a, b) {
      return Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at);
    }).slice(0, MAX_JOBS);

    for (var j = 0; j < recent.length; j++) body.appendChild(jobRow(recent[j]));
  }

  function jobRow(job) {
    var tr = h('tr');
    tr.appendChild(h('td', 'mono', clockOf(job.updated_at || job.created_at)));

    var who = h('td');
    who.appendChild(h('span', 'name', job.printer_name || job.printer_id));
    who.appendChild(h('span', 'detail mono', job.job_id));
    tr.appendChild(who);

    var state = h('td');
    var kind = job.status === 'done' ? 'ok'
      : job.status === 'failed' || job.status === 'expired' ? 'bad'
      : 'warn';
    state.appendChild(h('span', 'pill pill-' + kind, job.status));
    if (job.result && !job.result.ok) {
      var why = job.result.reason || 'failed';
      /* printed_certainty is the field that decides whether a retry is safe. It is the whole
         reason a failure here is not simply "try again". */
      if (job.result.printed_certainty) why += ' \\u00b7 printed: ' + job.result.printed_certainty;
      state.appendChild(h('span', 'detail', why));
    }
    tr.appendChild(state);

    var meta = h('td', 'num');
    meta.textContent = sizeOf(job.bytes);
    meta.appendChild(h('span', 'detail', 'attempt ' + job.attempts + (job.copies > 1 ? ' \\u00b7 ' + job.copies + ' copies' : '')));
    tr.appendChild(meta);

    return tr;
  }

  function renderTransports(transports) {
    if (!changed('transports', transports)) return;
    var body = $('transports-body');
    clear(body);
    for (var i = 0; i < (transports || []).length; i++) {
      var t = transports[i];
      var tr = h('tr');
      var first = h('td');
      first.appendChild(dot(t.available ? 'ok' : 'off'));
      first.appendChild(h('span', 'name', t.kind));
      tr.appendChild(first);
      var state = h('td');
      state.appendChild(h('span', 'pill pill-' + (t.available ? 'ok' : ''), t.available ? 'Available' : 'Unavailable'));
      if (t.reason) state.appendChild(h('span', 'detail', t.reason));
      tr.appendChild(state);
      body.appendChild(tr);
    }
  }

  /*
   * The outbound half. Worth its own card because "printing works from the till but not from a
   * phone" is exactly the difference between the LAN surface and this one.
   */
  function renderRelay(relay) {
    /* last_ok_at renders as "12s ago", so this one has to redraw as the clock moves. */
    if (!changed('relay', [relay, ago(relay && relay.last_ok_at)])) return;
    var list = $('relay-kv');
    clear(list);
    relay = relay || {};

    var rows = [['Enrolled', relay.enrolled ? 'yes' : 'no']];
    if (relay.enrolled) {
      rows.push(['Bridge id', relay.bridge_id || '\\u2014']);
      rows.push(['Connected', relay.connected ? 'yes' : 'no']);
      rows.push(['Channel', relay.transport || 'not yet established']);
      rows.push(['Last contact', ago(relay.last_ok_at)]);
      if (relay.last_error) rows.push(['Last error', relay.last_error]);
    }

    for (var i = 0; i < rows.length; i++) {
      list.appendChild(h('dt', null, rows[i][0]));
      list.appendChild(h('dd', null, rows[i][1]));
    }

    $('relay-note').textContent = !relay.enrolled ? 'not enrolled' : relay.connected ? 'connected' : 'offline';
    /*
     * Hidden the moment the bridge is enrolled, including when the enrolment came from another
     * tab or the CLI — the poll is what notices, so nothing here needs to know who paired it.
     * The success message is left standing rather than cleared: it names the bridge, and the
     * operator has usually looked away at the POS by the time this redraws.
     */
    $('pair').hidden = Boolean(relay.enrolled);
  }

  /* ----------------------------------------------------------------- pairing */

  function pairResult(kind, message) {
    var node = $('pair-result');
    node.hidden = false;
    node.className = 'pair-result is-' + kind;
    node.textContent = message;
  }

  /*
   * Formats as the operator types: uppercase, and a hyphen after the fourth character.
   *
   * The code is displayed as XXXX-XXXX on the POS but people type the hyphen inconsistently,
   * and on a tablet keyboard it is two taps away. Inserting it here means the box always looks
   * like the thing being copied from, which is how a transposition gets noticed before Connect
   * is pressed rather than after the API has refused it.
   */
  function formatPairCode(raw) {
    var clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return clean.length > 4 ? clean.slice(0, 4) + '-' + clean.slice(4) : clean;
  }

  /* ----------------------------------------------------------------- token gate */

  function showGate(message) {
    var gate = $('gate');
    gate.hidden = false;
    $('gate-message').textContent = message;
    $('token').focus();
  }

  function hideGate() { $('gate').hidden = true; }

  /* ----------------------------------------------------------------- the loop */

  function setBanners(nodes) {
    var host = $('banners');
    clear(host);
    for (var i = 0; i < nodes.length; i++) host.appendChild(nodes[i]);
  }

  function refresh(force) {
    if (testsInFlight > 0) return Promise.resolve();
    var button = $('refresh');
    button.disabled = true;
    /* Nothing to forget on the shipped default, where no token is configured at all. */
    $('forget').hidden = !readToken();

    return get('/health').then(function (res) {
      if (res.status !== 200 || !res.body) {
        throw new Error('The bridge answered ' + res.status + ' on /health.');
      }
      var health = res.body;
      renderIdentity(health);
      renderReach(health);
      renderRelay(health.relay);

      var warnings = [];
      if (health.net_warning === 'container-suspect') {
        warnings.push(banner('warn', 'Running in a container without host networking.',
          'Printing still works, but the addresses above are the container\\u2019s own \\u2014 not this machine\\u2019s, and a scan will sweep the wrong network.'));
      }

      if (health.auth_required && !readToken()) {
        setBanners(warnings);
        awaitingToken();
        showGate(tokenRejected
          ? 'That token was not accepted. Check PRINT_BRIDGE_TOKEN on the machine running the bridge.'
          : 'This bridge is started with PRINT_BRIDGE_TOKEN set, so everything except its health check needs that token.');
        return;
      }

      var probe = force ? '/status?probe=1' : '/status';
      return Promise.all([get(probe), get('/printers'), get('/jobs')]).then(function (all) {
        var status = all[0], registry = all[1], jobs = all[2];

        if (status.status === 401) {
          writeToken('');
          tokenRejected = true;
          setBanners(warnings);
          awaitingToken();
          showGate('That token was not accepted. Check PRINT_BRIDGE_TOKEN on the machine running the bridge.');
          return;
        }
        if (status.status !== 200 || !status.body) {
          throw new Error('The bridge answered ' + status.status + ' on /status.');
        }

        hideGate();
        var offline = (status.body.printers || []).filter(function (p) { return p.enabled && !p.online; });
        if (offline.length > 0) {
          warnings.push(banner('bad',
            offline.length === 1 ? '1 printer is not answering.' : offline.length + ' printers are not answering.',
            'Jobs for them queue until they come back, or until they expire.'));
        }
        setBanners(warnings);

        renderPrinters(status.body.printers || [], registry.body);
        renderQueue(status.body.queue, jobs.body && jobs.body.jobs);
        renderTransports(status.body.transports);
        $('checked').textContent = 'checked ' + new Date().toLocaleTimeString();
      });
    }).catch(function (err) {
      setBanners([banner('bad', 'Cannot reach the bridge.',
        (err && err.message ? err.message : String(err)) + ' It may have stopped, or another program may have taken its port.')]);
    }).then(function () {
      button.disabled = false;
    });
  }

  function startPolling() {
    stopPolling();
    timer = setInterval(function () { refresh(false); }, POLL_MS);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /* ----------------------------------------------------------------- wiring */

  $('refresh').addEventListener('click', function () { refresh(true); });

  $('gate-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = $('token').value.trim();
    if (!value) return;
    writeToken(value);
    tokenRejected = false;
    $('token').value = '';
    hideGate();
    refresh(false);
  });

  $('forget').addEventListener('click', function () {
    writeToken('');
    refresh(false);
  });

  $('pair-code').addEventListener('input', function () {
    this.value = formatPairCode(this.value);
  });

  $('pair-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var code = formatPairCode($('pair-code').value);
    if (code.length < 9) {
      pairResult('err', 'A pairing code is eight characters, like XXXX-XXXX.');
      return;
    }

    var button = $('pair-submit');
    button.disabled = true;
    pairResult('busy', 'Connecting\\u2026');

    post('/enroll', { code: code }).then(function (res) {
      var body = res.body || {};
      if (res.status === 200 && body.ok) {
        $('pair-code').value = '';
        /*
         * restart_required comes back only when a relay loop was ALREADY running — a re-pair
         * onto a different venue. That loop holds the previous token in its closure, so the new
         * credential does not take effect until the service restarts. Saying "connected" there
         * would be a lie the operator only discovers when nothing prints.
         */
        pairResult(
          'ok',
          body.restart_required
            ? 'Paired as bridge ' + body.bridge_id + '. Restart the Print Bridge service to finish.'
            : 'Connected. This bridge is now paired \\u2014 the POS should show it within a few seconds.'
        );
        refresh(false);
        return;
      }
      pairResult('err', pairError(res.status, body));
    }).catch(function () {
      pairResult('err', 'Could not reach the Print Bridge on this computer.');
    }).then(function () {
      button.disabled = false;
    });
  });

  /* The reasons are the bridge's own; each one has a different thing for the operator to do. */
  function pairError(status, body) {
    if (body.reason === 'invalid-code-format') return 'That does not look like a pairing code. Check it against the POS.';
    if (body.reason === 'already-enrolled') return 'This bridge is already paired with a venue. Remove it in Settings > Printing first.';
    if (body.reason === 'not-loopback') return 'Pairing has to be done in a browser on this computer, not from another device.';
    if (body.message) return body.message;
    return 'Pairing failed (HTTP ' + status + '). Check this computer is online, then try again.';
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopPolling();
      return;
    }
    refresh(false);
    startPolling();
  });

  refresh(false);
  startPolling();
})();
`;

/**
 * The whole page: markup, style and behaviour in one response.
 *
 * Served on `GET /` and `GET /index.html`, and — like `/health` — served without a token. It
 * carries no venue data of its own; every value on it is fetched afterwards through the routes
 * that ARE guarded. A page that 401'd would only mean an operator sees raw JSON instead of the
 * sentence explaining that their bridge wants a token.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Hankha Print Bridge</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">

  <header class="top">
    <div class="brand">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#EC6C18"/>
        <path d="M23 11h18v14H23z" fill="#fff"/>
        <rect x="14" y="25" width="36" height="20" rx="5" fill="#fff"/>
        <rect x="22" y="30" width="20" height="4" rx="2" fill="#DF560B"/>
        <circle cx="42" cy="39" r="2.5" fill="#DF560B"/>
        <path d="M22 53.5a14 14 0 0 1 20 0" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
        <circle cx="32" cy="58" r="3.2" fill="#fff"/>
      </svg>
      <div>
        <h1 class="title">Hankha Print Bridge</h1>
        <div class="sub" id="sub">connecting&hellip;</div>
      </div>
    </div>
    <span class="badge" id="version">&nbsp;</span>
    <div class="actions">
      <span class="card-note" id="checked"></span>
      <button type="button" class="btn btn-ghost" id="forget" hidden>Forget token</button>
      <button type="button" class="btn" id="refresh">Refresh</button>
    </div>
  </header>

  <noscript>
    <div class="banner banner-warn">
      <b>JavaScript is turned off,</b> so this page cannot show the bridge&rsquo;s state. The same
      information is available as JSON at <code>/health</code> and <code>/status</code>.
    </div>
  </noscript>

  <div id="banners"></div>

  <section class="gate" id="gate" hidden>
    <h2>This bridge needs a token</h2>
    <p id="gate-message"></p>
    <form id="gate-form" autocomplete="off">
      <input type="password" id="token" placeholder="PRINT_BRIDGE_TOKEN" autocomplete="off" spellcheck="false" aria-label="Bridge token">
      <button type="submit" class="btn">Connect</button>
    </form>
  </section>

  <div class="grid">

    <section class="card card-wide">
      <div class="card-head">
        <h2 class="card-title">Printers</h2>
        <span class="card-note" id="printers-note"></span>
      </div>
      <div class="scroll">
        <table class="table-wide">
          <thead>
            <tr>
              <th>Printer</th>
              <th>Where</th>
              <th>State</th>
              <th class="num">Latency</th>
              <th class="num">Test</th>
            </tr>
          </thead>
          <tbody id="printers-body">
            <tr><td class="empty" colspan="5">Loading&hellip;</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2 class="card-title">Point a terminal here</h2></div>
      <div class="card-body">
        <ul class="urls" id="urls"></ul>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Queue</h2>
        <span class="card-note" id="queue-note"></span>
      </div>
      <div class="card-body">
        <dl class="kv" id="queue-counts"></dl>
      </div>
    </section>

    <section class="card card-wide">
      <div class="card-head"><h2 class="card-title">Recent jobs</h2></div>
      <div class="scroll">
        <table class="table-wide">
          <thead>
            <tr>
              <th>Time</th>
              <th>Printer</th>
              <th>Outcome</th>
              <th class="num">Size</th>
            </tr>
          </thead>
          <tbody id="jobs-body">
            <tr><td class="empty" colspan="4">Loading&hellip;</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2 class="card-title">Transports on this machine</h2></div>
      <div class="scroll">
        <table><tbody id="transports-body"></tbody></table>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Cloud relay</h2>
        <span class="card-note" id="relay-note"></span>
      </div>
      <div class="card-body">
        <dl class="kv" id="relay-kv"></dl>
        <div id="pair" hidden>
          <p class="pair-lead">Jobs only arrive over the LAN. To let a phone or tablet print
          through this bridge, pair it with your venue.</p>
          <ol class="pair-steps">
            <li>In the POS, open <strong>Settings &rsaquo; Printing</strong> and tap
            <strong>Add bridge</strong>.</li>
            <li>Type the pairing code it shows into the box below.</li>
          </ol>
          <form id="pair-form" autocomplete="off">
            <input type="text" id="pair-code" placeholder="XXXX-XXXX" maxlength="9" spellcheck="false"
              autocapitalize="characters" autocorrect="off" aria-label="Pairing code">
            <button type="submit" class="btn" id="pair-submit">Connect</button>
          </form>
          <p class="pair-result" id="pair-result" hidden></p>
        </div>
      </div>
    </section>

  </div>

  <footer class="foot">
    <span>Printers are configured in <code>printers.json</code> &mdash; not here.</span>
    <span><code>--list-printers</code> shows where that file is, and what this machine can see.</span>
  </footer>

</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
