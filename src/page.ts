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
 *
 * The other trap: CSS and SCRIPT below are template literals, so a backtick ANYWHERE inside them
 * ends the string — including one used to quote an identifier in a comment, which is how this
 * file has twice been left unparseable and the whole bridge unable to start. Write `fetch()`
 * without the backticks in there, or escape them.
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
/* The neutral one, named rather than left as a bare .pill built from an empty string. */
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
.found-where { display: block; margin-top: 2px; font: 12.5px/1.5 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.found-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }

.where-file {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
}
.where-file .path { font: 12px var(--mono); color: var(--muted); overflow-wrap: anywhere; min-width: 0; }

/* Shown only when the clipboard is unavailable, which is every plain-http LAN origin. */
.found li { flex-wrap: wrap; }
.entry {
  flex-basis: 100%; margin: 10px 0 0; padding: 10px 12px;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px;
  font: 12px/1.5 var(--mono); white-space: pre; overflow-x: auto;
}

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

/*
 * The hidden attribute loses to any explicit display.
 *
 * #report is .grid { display: grid }, so hiding it for the pairing screen did nothing at all:
 * the seven diagnostic cards kept their place in the layout and an operator who scrolled found
 * the whole technician view sitting under the QR code. !important is right here — the attribute
 * is meant to be the last word on visibility, and every other hidden on this page was relying
 * on the same assumption.
 */
[hidden] { display: none !important; }

/* ── Pairing screen ────────────────────────────────────────────────────────
   The whole viewport when this bridge has nobody to print for. Everything else on the page is
   diagnostics for a technician; this is the one screen a shop owner is ever meant to read, so
   it gets the space and the type size, and the seven cards move behind Details. */
.pairscreen{
  min-height:min(72vh,640px);display:flex;flex-direction:column;align-items:center;
  justify-content:center;text-align:center;gap:18px;padding:32px 16px;
}
.ps-lead{font-size:22px;font-weight:800;letter-spacing:-.02em;line-height:1.3;max-width:22ch}
.ps-sub{font-size:14px;color:var(--muted);max-width:40ch;line-height:1.55}
.ps-qr{background:#fff;padding:14px;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.18);line-height:0}
.ps-qr svg{display:block;width:min(280px,62vw);height:auto}
.ps-codewrap{display:flex;flex-direction:column;align-items:center;gap:6px}
.ps-codelabel{
  font-size:11px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;color:var(--muted);
}
.ps-code{
  font-family:var(--mono);font-size:clamp(26px,6vw,38px);font-weight:700;letter-spacing:.16em;
}
.ps-meta{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.ps-icon{
  width:64px;height:64px;border-radius:999px;display:grid;place-items:center;font-size:30px;
}
.ps-icon.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.ps-icon.bad{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.ps-icon.warn{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn)}
.ps-langs{display:flex;gap:4px;flex-wrap:wrap;justify-content:center;margin-top:4px}
.ps-langs button{
  appearance:none;border:0;background:transparent;font:inherit;font-size:12px;font-weight:700;
  color:var(--muted);padding:4px 9px;border-radius:8px;cursor:pointer;
}
.ps-langs button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
.ps-details{
  appearance:none;border:0;background:transparent;font:inherit;font-size:13px;color:var(--muted);
  text-decoration:underline;cursor:pointer;padding:8px;
}
@media (prefers-reduced-motion:no-preference){
  .ps-dot{animation:pairpulse 1.6s ease-in-out infinite}
}
@keyframes pairpulse{0%,100%{opacity:1}50%{opacity:.35}}
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
   * One refresh at a time. The poll fires on a fixed interval regardless of how long the last
   * one took, so a bridge answering slowly stacked requests — and whichever finished first
   * re-enabled the Refresh button while another was still running.
   */
  var refreshing = false;
  /* Where printers.json lives, from /status. Empty until the first authorised poll returns. */
  var registryPath = '';
  /* The registry as last loaded, so a discovered device can be marked already-configured. */
  var configured = [];
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
   * Say something out loud.
   *
   * Everything this page reports arrives as a silent DOM mutation on a ten-second timer, so
   * without a live region a screen-reader user is never told a printer stopped answering or a
   * test slip failed — on a page that exists to report exactly those two things. Kept to state
   * CHANGES rather than every poll, or it would read the whole table out every ten seconds.
   */
  var lastAnnounced = '';
  function announce(message) {
    if (!message || message === lastAnnounced) return;
    lastAnnounced = message;
    $('live').textContent = message;
  }

  /* A short, visible aside for something the operator just did. Not an error, not a banner. */
  var noticeTimer = null;
  function notice(message) {
    var node = $('notice');
    node.textContent = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { node.textContent = ''; }, 5000);
  }

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
    placeholder($('jobs-body'), 5, 'Waiting for the token above.');
    clear($('transports-body'));
    clear($('queue-counts'));
    clear($('where-file'));
    clear($('found'));
    $('printers-note').textContent = '';
    $('queue-note').textContent = '';
    $('jobs-note').textContent = '';
    $('find-note').textContent = '';
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
   * fetch() has no timeout of its own. A printer that accepts a TCP connection and then never
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

  function renderPrinters(statuses, registry, registryOk) {
    var body = $('printers-body');
    var configured = (registry && registry.printers) || [];
    /* checked_at moves on every probe and is not on the page; comparing it would defeat this. */
    if (!changed('printers', [statuses.map(function (p) {
      return [p.id, p.name, p.transport, p.type, p.language, p.enabled, p.online, p.latency_ms, p.detail];
    }), configured, registryOk])) return;

    var byId = {};
    for (var i = 0; i < configured.length; i++) byId[configured[i].id] = configured[i];

    clear(body);
    $('printers-note').textContent = statuses.length === 1 ? '1 configured' : statuses.length + ' configured';

    if (statuses.length === 0) {
      /*
       * The dead end this page used to be. It said "add them with PUT /printers, or run
       * hankha-print-bridge --list-printers" — one instruction naming an HTTP verb, the other a
       * binary that is not on PATH after the macOS installer, to a person who runs a cafe. The
       * card below answers the same question without either.
       */
      placeholder(body, 5, 'No printers configured yet. Use Find printers below to see what this machine can see.');
      return;
    }

    for (var j = 0; j < statuses.length; j++) {
      body.appendChild(printerRow(statuses[j], byId[statuses[j].id], registryOk));
    }
  }

  function printerRow(status, record, registryOk) {
    var tr = h('tr');
    var label = status.name || status.id;

    var first = h('td');
    first.appendChild(dot(!status.enabled ? 'off' : status.online ? 'ok' : 'bad'));
    first.appendChild(h('span', 'name', label));
    first.appendChild(h('span', 'detail mono', status.id));
    tr.appendChild(first);

    var where = h('td', 'mono');
    where.textContent = locate(status, record, registryOk);
    where.appendChild(h('span', 'detail', status.transport + ' · ' + status.type + ' · ' + status.language));
    tr.appendChild(where);

    var state = h('td');
    state.appendChild(h('span',
      'pill pill-' + (!status.enabled ? 'warn' : status.online ? 'ok' : 'bad'),
      !status.enabled ? 'Disabled' : status.online ? 'Online' : 'Offline'));
    if (status.detail) state.appendChild(h('span', 'detail', status.detail));
    tr.appendChild(state);

    tr.appendChild(h('td', 'num', status.latency_ms === null || status.latency_ms === undefined
      ? '—'
      : status.latency_ms + ' ms'));

    /*
     * Both actions share ONE feedback line, which is always in the DOM at a fixed minimum height.
     * The old code appended its result into the State cell, which grew the row and shunted every
     * printer below it down the page — at exactly the moment the operator is looking between the
     * screen and the printer to see whether paper came out.
     */
    var action = h('td');
    var actions = h('div', 'row-actions');
    var feedback = h('span', 'feedback');

    var test = h('button', 'btn btn-ghost btn-sm', 'Test print');
    test.type = 'button';
    test.disabled = !status.enabled;
    test.addEventListener('click', function () { testPrint(status, test, feedback); });
    actions.appendChild(test);

    /*
     * Identify is offered only where it can work, and only on demand.
     *
     * A print spooler is one-way by construction, so usb and serial have no channel to read a
     * reply on and the bridge answers 501 for them. And the probe is sent in BOTH languages, one
     * of which is wrong for any given printer and prints three or four stray characters when it
     * lands — which is why nothing calls this automatically, and why the button says so before
     * it is pressed rather than after.
     */
    if (status.transport === 'network') {
      var ident = h('button', 'btn btn-ghost btn-sm', 'Identify');
      ident.type = 'button';
      ident.title = 'Asks the printer which language it speaks. Harmless, but it may print a few stray characters.';
      ident.disabled = !status.enabled;
      ident.addEventListener('click', function () { identify(status, ident, feedback); });
      actions.appendChild(ident);
    }

    action.appendChild(actions);
    action.appendChild(feedback);
    tr.appendChild(action);

    return tr;
  }

  /* /status answers with what a printer IS; the registry knows WHERE it is. Only together do they
     answer "is that the one by the till". */
  function locate(status, record, registryOk) {
    /* Distinct from an em dash: "we asked and it has no address" is not "we could not ask". */
    if (!registryOk) return 'not loaded';
    if (!record) return '—';
    if (record.queue) return record.queue;
    if (record.device) return record.device;
    if (record.address) return record.address + ':' + (record.port || 9100);
    return '—';
  }

  function setFeedback(node, kind, message) {
    node.className = 'feedback feedback-' + kind;
    node.textContent = message;
  }

  /*
   * Runs a per-row action and puts its answer on the row.
   *
   * testsInFlight is what stops the poll redrawing the table under a button that is mid-click,
   * and it MUST come back to zero on every path — including a rejection. When it did not, the
   * page stopped refreshing for the rest of the session.
   */
  function rowAction(status, button, feedback, busyLabel, busyText, run, describe) {
    testsInFlight++;
    var label = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    button.setAttribute('aria-busy', 'true');
    setFeedback(feedback, 'busy', busyText);

    return run().then(function (res) {
      var told = describe(res);
      setFeedback(feedback, told.kind, told.text);
      announce(label + ' — ' + status.name + ': ' + told.text);
    }, function (err) {
      var why = (err && err.message) || 'The bridge did not answer.';
      setFeedback(feedback, 'bad', why);
      announce(label + ' — ' + status.name + ': ' + why);
    }).then(function () {
      button.textContent = label;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      testsInFlight--;
    });
  }

  function testPrint(status, button, feedback) {
    rowAction(
      status, button, feedback, 'Printing…', 'Sending a test slip…',
      function () { return post('/printers/' + encodeURIComponent(status.id) + '/test', undefined, TEST_TIMEOUT_MS); },
      function (res) {
        var body = res.body || {};
        if (res.status === 200 && body.ok === true) {
          return { kind: 'ok', text: 'Test slip sent — check the paper.' };
        }
        var result = body.job && body.job.result;
        return {
          kind: 'bad',
          text: body.detail || (result && (result.detail || result.reason)) || 'The bridge answered ' + res.status + '.'
        };
      }
    );
  }

  /*
   * A language mismatch is the root cause of the whole "it prints garbage" class of fault, and it
   * is invisible: the printer is online, the job succeeds, and the paper is nonsense. This is the
   * only way to see it without walking to the printer.
   */
  function identify(status, button, feedback) {
    rowAction(
      status, button, feedback, 'Asking…', 'Asking the printer what it is…',
      function () { return post('/printers/' + encodeURIComponent(status.id) + '/identify', undefined, TEST_TIMEOUT_MS); },
      function (res) {
        var body = res.body || {};
        /* Not a fault: a spooler simply has nothing to answer on. */
        if (res.status === 501) {
          return { kind: 'busy', text: 'Only network printers can answer — ' + status.transport + ' is one-way.' };
        }
        if (res.status !== 200 || body.ok !== true) {
          return { kind: 'bad', text: body.detail || 'The bridge answered ' + res.status + '.' };
        }
        if (!body.detected_language) {
          return { kind: 'busy', text: body.detail || 'The printer did not answer — many models never do.' };
        }
        if (body.detected_language === body.configured_language) {
          return { kind: 'ok', text: 'Answered as ' + body.detected_language + ', which matches printers.json.' };
        }
        return {
          kind: 'bad',
          text: 'Answered as ' + body.detected_language + ', but printers.json says '
            + body.configured_language + '. Set language to ' + body.detected_language + '.'
        };
      }
    );
  }
  function renderQueue(queue, jobs, jobsOk) {
    if (!changed('queue', [queue, jobs, jobsOk])) return;
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
    /*
     * "Could not load" and "nothing has printed" are opposite facts, and this used to show the
     * second for both: /jobs failing left the list undefined, and the page then stated as fact that
     * nothing had printed since the bridge started. Only /status's status code was ever checked.
     */
    if (!jobsOk) {
      placeholder(body, 5, 'Could not load recent jobs.');
      return;
    }
    if (!jobs || jobs.length === 0) {
      placeholder(body, 5, 'Nothing printed since this bridge started.');
      return;
    }

    /* queue.list() returns in-flight jobs first and then history, not newest first. */
    var recent = jobs.slice().sort(function (a, b) {
      return Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at);
    }).slice(0, MAX_JOBS);

    for (var j = 0; j < recent.length; j++) body.appendChild(jobRow(recent[j]));
    if (jobs.length > recent.length) {
      /* Say what was left out. A list silently capped reads as a complete one. */
      $('jobs-note').textContent = 'newest ' + recent.length + ' of ' + jobs.length;
    } else {
      $('jobs-note').textContent = '';
    }
  }

  function jobRow(job) {
    var tr = h('tr');

    var when = h('td', 'mono');
    when.textContent = clockOf(job.updated_at || job.created_at);
    /*
     * Where the job came from. This is THE question the Cloud relay card exists to answer —
     * "printing works from the till but not from the phone" is entirely a question of whether
     * relay jobs are arriving at all — and the bridge has always reported it and the page has
     * always thrown it away.
     */
    if (job.source) when.appendChild(h('span', 'detail', job.source === 'relay' ? 'via relay' : 'over LAN'));
    tr.appendChild(when);

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
      if (job.result.printed_certainty) why += ' · printed: ' + job.result.printed_certainty;
      state.appendChild(h('span', 'detail', why));
    } else if (job.status === 'queued' && job.expires_at) {
      /* The offline banner promises jobs queue "until they expire". This is that deadline. */
      state.appendChild(h('span', 'detail', 'expires ' + clockOf(job.expires_at)));
    }
    tr.appendChild(state);

    var meta = h('td', 'num');
    meta.textContent = sizeOf(job.bytes);
    meta.appendChild(h('span', 'detail', 'attempt ' + job.attempts + (job.copies > 1 ? ' · ' + job.copies + ' copies' : '')));
    tr.appendChild(meta);

    /*
     * Cancel is offered only while a job is still queued, which is the only state the bridge can
     * honestly withdraw it from — once it is printing, paper may already be moving. The route has
     * existed since the queue landed with nothing able to call it.
     */
    var act = h('td');
    if (job.status === 'queued') {
      var actions = h('div', 'row-actions');
      var feedback = h('span', 'feedback');
      var cancel = h('button', 'btn btn-ghost btn-sm', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { cancelJob(job, cancel, feedback); });
      actions.appendChild(cancel);
      act.appendChild(actions);
      act.appendChild(feedback);
    }
    tr.appendChild(act);

    return tr;
  }

  function cancelJob(job, button, feedback) {
    var name = job.printer_name || job.printer_id;
    rowAction(
      { id: job.job_id, name: name }, button, feedback, 'Cancelling…', 'Withdrawing this job…',
      function () { return post('/jobs/' + encodeURIComponent(job.job_id) + '/cancel', {}); },
      function (res) {
        if (res.status === 200) return { kind: 'ok', text: 'Cancelled before it reached the printer.' };
        /* 409 is not a failure to report as one: it means the paper is already moving. */
        if (res.status === 409) return { kind: 'busy', text: 'Too late — it had already started printing.' };
        if (res.status === 404) return { kind: 'bad', text: 'That job is no longer in the queue.' };
        return { kind: 'bad', text: 'The bridge answered ' + res.status + '.' };
      }
    ).then(function () { delete lastRendered.queue; });
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
  /*
   * Whether the next Connect is a RE-pair. Enrolling twice moves this machine's printers to
   * whichever venue supplied the code, so the bridge refuses a second enrolment unless the
   * caller says so; this flag is that say-so, and it is only ever true while the box is being
   * shown for a pairing the server has stopped accepting.
   */
  var pairForce = false;

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
     * Hidden once the bridge is paired AND connected, including when the pairing came from
     * another tab or the CLI — the poll is what notices, so nothing here needs to know who
     * paired it. The success message is left standing rather than cleared: it names the bridge,
     * and the operator has usually looked away at the POS by the time this redraws.
     *
     * Enrolled-but-not-connected keeps the box, because it is the one state with no other way
     * out. Hiding it whenever a token merely existed on disk meant a bridge whose credential the
     * server had rejected offered no code field at all, and the only route back was a terminal.
     */
    pairForce = Boolean(relay.enrolled) && !relay.connected;
    $('pair').hidden = Boolean(relay.enrolled) && Boolean(relay.connected);

    /*
     * Disconnected has two causes and they need opposite advice. A REJECTED credential never
     * recovers by waiting — the bridge stops its heartbeat and leaves its poll loop — while an
     * uplink that dropped comes back on its own, and re-pairing it would mean deleting a
     * working bridge row for nothing. The box is offered either way, because being wrong about
     * which one this is must never leave the operator with no way out; only the wording moves.
     */
    var rejected = pairForce && /token rejected|revoked|re-?enroll/i.test(relay.last_error || '');
    var why = relay.last_error ? ' (' + relay.last_error + ')' : '';

    $('pair-submit').textContent = pairForce ? 'Re-pair' : 'Connect';
    $('pair-lead').textContent = !pairForce
      ? 'Jobs only arrive over the LAN. To let a phone or tablet print through this bridge, ' +
        'pair it with your venue.'
      : rejected
        ? 'This bridge is paired, but the server is not accepting its credential' + why +
          '. Pair it again with a fresh code.'
        : 'This bridge is paired, but it is not reaching the server right now' + why +
          '. It usually reconnects on its own — pair it again only if this does not clear.';

    /*
     * The removal step is not tidiness. One computer holds one bridge row per organisation, so
     * enrolling into a freshly added row while the old one is still live is refused upstream as
     * "this computer is already paired" — the operator has to retire the dead row first. Shown
     * only for a rejection: telling someone to delete their bridge row during a thirty-second
     * network blip is how a working station gets thrown away.
     */
    var steps = $('pair-steps');
    clear(steps);
    if (rejected) {
      steps.appendChild(h('li', null, 'In the POS, open Settings > Printing, remove this print bridge, then tap Add bridge.'));
      steps.appendChild(h('li', null, 'Type the new pairing code into the box below.'));
    } else {
      steps.appendChild(h('li', null, 'In the POS, open Settings > Printing and tap Add bridge.'));
      steps.appendChild(h('li', null, 'Type the pairing code it shows into the box below.'));
    }
  }

  /* ----------------------------------------------------------------- discovery */

  /*
   * "What can this machine see?"
   *
   * The question the empty state used to answer with a terminal command. POST /discover has
   * existed since the transports landed and nothing in a browser has ever called it.
   *
   * Never on load, always on a press: discoverAll sweeps a /24, which is a couple of seconds of
   * SYN traffic across the venue's network. A page left open on a till would turn that into a
   * background hum for nobody's benefit — the same reasoning that put a cache in front of the
   * printer probes. The button is the consent.
   *
   * And nothing here writes. printers.json stays the only way the registry changes; this card
   * only shortens the distance between "I plugged in a printer" and knowing what to put in it.
   */
  function findPrinters() {
    var button = $('find');
    var note = $('find-note');
    var label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Looking…';
    note.textContent = 'Checking USB, serial and this machine’s own subnets…';
    clear($('found'));

    post('/discover', {}, DISCOVER_TIMEOUT_MS).then(function (res) {
      var body = res.body || {};
      if (res.status !== 200 || body.ok !== true) {
        note.textContent = 'Could not look: the bridge answered ' + res.status + '.';
        return;
      }
      renderFound(body);
    }, function (err) {
      note.textContent = (err && err.message) || 'Could not look.';
    }).then(function () {
      button.textContent = label;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    });
  }

  function renderFound(result) {
    var out = $('found');
    clear(out);

    var found = result.printers || [];
    var subnets = result.subnets || [];
    /*
     * Saying WHERE it looked is the difference between "you have no printers" and "this machine
     * cannot see the network your printers are on" — and the second is exactly what a
     * containerised bridge reports, confidently and wrongly.
     */
    var where = subnets.length
      ? 'Swept ' + subnets.join(', ') + '.'
      : 'No subnets to sweep — this bridge can only see its own machine.';
    var summary = found.length
      ? found.length + (found.length === 1 ? ' device found. ' : ' devices found. ') + where
      : 'Nothing found. ' + where;
    $('find-note').textContent = summary;
    announce(summary);

    for (var i = 0; i < found.length; i++) out.appendChild(foundRow(found[i], i));
  }

  function locationOf(item) {
    if (item.queue) return item.queue;
    if (item.device) return item.device;
    if (item.address) return item.address + ':' + (item.port || 9100);
    return item.transport;
  }

  /* Matched on where a device IS, not on its name: the label a spooler reports and the name a
     venue gave the same printer in printers.json are rarely the same string. */
  function isConfigured(item) {
    for (var i = 0; i < configured.length; i++) {
      var p = configured[i];
      if (p.transport !== item.transport) continue;
      if (item.queue && p.queue === item.queue) return true;
      if (item.device && p.device === item.device) return true;
      if (item.address && p.address === item.address && (p.port || 9100) === (item.port || 9100)) return true;
    }
    return false;
  }

  function foundRow(item, index) {
    var li = h('li');

    var main = h('div', 'found-main');
    var where = locationOf(item);
    var label = item.label || where;
    main.appendChild(h('span', 'name', label));
    /* A spooler reports its queue name as its label, so printing both is the same string twice. */
    if (where !== label) main.appendChild(h('span', 'found-where', where));
    if (item.detail) main.appendChild(h('span', 'detail', item.detail));
    li.appendChild(main);

    var actions = h('div', 'found-actions');
    if (isConfigured(item)) {
      actions.appendChild(h('span', 'pill pill-ok', 'In printers.json'));
    } else {
      actions.appendChild(h('span', 'pill pill-off', 'Not configured'));
      var copy = h('button', 'btn btn-ghost btn-sm', 'Copy entry');
      copy.type = 'button';
      copy.title = 'Copies a printers.json entry for this device, ready to paste.';
      copy.addEventListener('click', function () { copyEntry(item, index, copy); });
      actions.appendChild(copy);
    }
    li.appendChild(actions);

    return li;
  }

  /*
   * Hands over the exact object to paste, rather than a shape to reconstruct from a README.
   *
   * The id is positional, not derived from the label. The registry requires
   * ^[a-z0-9][a-z0-9_-]{0,63}$ and there is no slug helper anywhere in this app — a Lao station
   * name reduces to the empty string and an address to a run of digits and dots, so deriving one
   * produces an entry that fails validation on paste.
   *
   * type and language are guesses, and deliberately the safe ones: receipt/escpos is what a
   * thermal printer at a till almost always is, and a label printer has no safe default at all —
   * the registry refuses one without an explicit language for exactly that reason.
   */
  function copyEntry(item, index, button) {
    var entry = {
      id: item.transport + '-' + (index + 1),
      name: item.label || locationOf(item),
      transport: item.transport,
      type: 'receipt',
      language: 'escpos',
      enabled: true
    };
    if (item.address) { entry.address = item.address; entry.port = item.port || 9100; }
    if (item.queue) entry.queue = item.queue;
    if (item.device) entry.device = item.device;

    var text = JSON.stringify(entry, null, 2);
    var done = function (label) {
      button.textContent = label;
      setTimeout(function () { button.textContent = 'Copy entry'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('Copied'); }, function () { revealEntry(button, text, done); });
      return;
    }
    /* No clipboard on a plain-http LAN origin: only localhost counts as a secure context. */
    revealEntry(button, text, done);
  }

  function revealEntry(button, text, done) {
    var li = button.parentNode.parentNode;
    var existing = li.querySelector('.entry');
    if (existing) existing.parentNode.removeChild(existing);

    var pre = h('pre', 'entry', text);
    li.appendChild(pre);
    var range = document.createRange();
    range.selectNodeContents(pre);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    done('Selected');
  }

  /* The path the footer used to send people to a CLI to discover, on a machine where that binary
     is not on PATH. The process has known it all along. */
  function renderRegistryPath(path) {
    if (!changed('registry-path', path)) return;
    var host = $('where-file');
    clear(host);
    if (!path) return;
    host.appendChild(h('span', 'find-note', 'Printers are configured in'));
    host.appendChild(h('span', 'path', path));
    var copy = h('button', 'btn btn-ghost btn-sm', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', function () { copyPlain(path, copy); });
    host.appendChild(copy);
  }

  function copyPlain(text, button) {
    var done = function (label) {
      button.textContent = label;
      setTimeout(function () { button.textContent = 'Copy'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('Copied'); }, function () { selectSibling(button, done); });
      return;
    }
    selectSibling(button, done);
  }

  function selectSibling(button, done) {
    var node = button.parentNode.querySelector('.path');
    if (!node) return;
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    done('Selected');
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
    /*
     * Two guards, for two different failures.
     *
     * testsInFlight stops a redraw replacing a button mid-click — and now SAYS so. It used to
     * return silently, so pressing Refresh during a test print did nothing at all and read as a
     * dead button. refreshing stops the fixed ten-second timer stacking requests on a bridge
     * that is answering slowly, where whichever call returned first re-enabled the button
     * underneath one that was still running.
     */
    if (refreshing) return Promise.resolve();
    if (testsInFlight > 0) {
      notice('Waiting for the printer — this will refresh once it answers.');
      return Promise.resolve();
    }
    refreshing = true;
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

        /* Any of the three answering 401 means the same thing; only /status was ever checked. */
        if (status.status === 401 || registry.status === 401 || jobs.status === 401) {
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

        /*
         * Each payload carries whether it actually arrived. Falling back to an empty list made a
         * failed /printers empty the Where column of every row, and a failed /jobs state as fact
         * that nothing had printed since the bridge started — both indistinguishable, on screen,
         * from the truth.
         */
        var registryOk = registry.status === 200 && !!registry.body;
        var jobsOk = jobs.status === 200 && !!jobs.body;
        configured = (registryOk && registry.body.printers) || [];

        renderPrinters(status.body.printers || [], registryOk ? registry.body : null, registryOk);
        renderQueue(status.body.queue, jobsOk ? jobs.body.jobs : null, jobsOk);
        renderTransports(status.body.transports);
        registryPath = status.body.registry_path || '';
        renderRegistryPath(registryPath);

        announce(offline.length > 0
          ? offline.length + (offline.length === 1 ? ' printer is not answering.' : ' printers are not answering.')
          : 'All printers are answering.');
        $('checked').textContent = 'checked ' + new Date().toLocaleTimeString();
        setTitle(offline.length);
      });
    }).catch(function (err) {
      setBanners([banner('bad', 'Cannot reach the bridge.',
        (err && err.message ? err.message : String(err)) + ' It may have stopped, or another program may have taken its port.')]);
    }).then(function () {
      refreshing = false;
      button.disabled = false;
    });
  }

  /*
   * The tab title carries the count too. This page is left open on a till, usually behind
   * something else, and a number in the tab is the only way a problem is noticed without
   * someone deciding to go and look.
   */
  function setTitle(offline) {
    document.title = offline > 0 ? '(' + offline + ') Hankha Print Bridge' : 'Hankha Print Bridge';
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
  $('find').addEventListener('click', findPrinters);

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

    post('/enroll', { code: code, force: pairForce }).then(function (res) {
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

  /* ------------------------------------------------- pairing screen */

  /*
   * The one screen on this page written for a shop owner rather than a technician.
   *
   * Everything above is diagnostics. This takes the whole viewport whenever the bridge has
   * nobody to print for, because in that state the diagnostics answer a question nobody asked:
   * the only useful thing to say is "scan this". The seven cards move behind Details.
   *
   * Translated, unlike the rest of the page, and that is the point — this is the screen a
   * Lao-speaking member of staff is sent to, and it was English-only.
   */

  var PS_LANGS = ['en', 'lo', 'th', 'zh', 'vi'];
  var PS_LANG_NAMES = { en: 'English', lo: 'ລາວ', th: 'ไทย', zh: '中文', vi: 'Tiếng Việt' };
  var PS_LANG_KEY = 'hankha-bridge-lang';

  /* Order matches SUPPORTED_LANGS in the POS, so the two stay comparable by eye. */
  var PS_T = {
    waitLead: [
      'Scan this with your Hankha tablet or phone',
      'ສະແກນອັນນີ້ດ້ວຍແທັບເລັດ ຫຼື ໂທລະສັບ Hankha',
      'สแกนรหัสนี้ด้วยแท็บเล็ตหรือมือถือ Hankha',
      '用你的 Hankha 平板或手机扫描',
      'Quét mã này bằng máy tính bảng hoặc điện thoại Hankha'
    ],
    waitSub: [
      'Open the Hankha app, then go to Settings, Printing, Connect.',
      'ເປີດແອັບ Hankha, ໄປທີ່ ຕັ້ງຄ່າ, ການພິມ, ເຊື່ອມຕໍ່.',
      'เปิดแอป Hankha ไปที่ ตั้งค่า การพิมพ์ เชื่อมต่อ',
      '打开 Hankha 应用，进入 设置、打印、连接。',
      'Mở ứng dụng Hankha, vào Cài đặt, In ấn, Kết nối.'
    ],
    orType: ['or type this code', 'ຫຼື ພິມລະຫັດນີ້', 'หรือพิมพ์รหัสนี้', '或输入此代码', 'hoặc nhập mã này'],
    waiting: ['Waiting', 'ກຳລັງລໍຖ້າ', 'กำลังรอ', '等待中', 'Đang chờ'],
    requesting: [
      'Getting a code',
      'ກຳລັງຂໍລະຫັດ',
      'กำลังขอรหัส',
      '正在获取代码',
      'Đang lấy mã'
    ],
    connectingLead: ['Connecting to', 'ກຳລັງເຊື່ອມຕໍ່ຫາ', 'กำลังเชื่อมต่อกับ', '正在连接到', 'Đang kết nối tới'],
    connectingSub: [
      'Almost done. Do not close this window.',
      'ເກືອບແລ້ວ. ຢ່າປິດປ່ອງຢ້ຽມນີ້.',
      'ใกล้เสร็จแล้ว อย่าปิดหน้าต่างนี้',
      '就快好了。请不要关闭此窗口。',
      'Sắp xong. Đừng đóng cửa sổ này.'
    ],
    okLead: ['Connected', 'ເຊື່ອມຕໍ່ແລ້ວ', 'เชื่อมต่อแล้ว', '已连接', 'Đã kết nối'],
    okSub: [
      'Bills sent from your tablets will print here.',
      'ໃບບິນທີ່ສົ່ງຈາກແທັບເລັດຈະພິມອອກຢູ່ນີ້.',
      'ใบเสร็จที่ส่งจากแท็บเล็ตจะพิมพ์ที่นี่',
      '从平板发送的账单将在这里打印。',
      'Hóa đơn gửi từ máy tính bảng sẽ in ở đây.'
    ],
    removedLead: [
      'This computer was disconnected',
      'ຄອມພິວເຕີເຄື່ອງນີ້ຖືກຕັດການເຊື່ອມຕໍ່',
      'คอมพิวเตอร์เครื่องนี้ถูกตัดการเชื่อมต่อ',
      '这台电脑已被断开',
      'Máy tính này đã bị ngắt kết nối'
    ],
    removedSub: [
      'Someone removed it from your shop. Get a new code and connect it again.',
      'ມີຄົນລຶບມັນອອກຈາກຮ້ານຂອງທ່ານ. ຂໍລະຫັດໃໝ່ ແລ້ວເຊື່ອມຕໍ່ອີກຄັ້ງ.',
      'มีคนลบออกจากร้านของคุณ ขอรหัสใหม่แล้วเชื่อมต่ออีกครั้ง',
      '有人把它从你的门店中移除了。获取新代码后重新连接。',
      'Ai đó đã xóa nó khỏi cửa hàng của bạn. Lấy mã mới và kết nối lại.'
    ],
    removedBtn: ['Get a new code', 'ຂໍລະຫັດໃໝ່', 'ขอรหัสใหม่', '获取新代码', 'Lấy mã mới'],
    offlineLead: [
      'Cannot reach Hankha right now',
      'ຕິດຕໍ່ Hankha ບໍ່ໄດ້ໃນຕອນນີ້',
      'ติดต่อ Hankha ไม่ได้ตอนนี้',
      '目前无法连接 Hankha',
      'Hiện không kết nối được Hankha'
    ],
    offlineSub: [
      'Retrying. Printing will start again by itself, there is nothing to do.',
      'ກຳລັງລອງໃໝ່. ການພິມຈະກັບມາເອງ, ບໍ່ຕ້ອງເຮັດຫຍັງ.',
      'กำลังลองใหม่ การพิมพ์จะกลับมาเอง ไม่ต้องทำอะไร',
      '正在重试。打印会自行恢复，无需操作。',
      'Đang thử lại. Việc in sẽ tự khôi phục, không cần làm gì.'
    ],
    details: ['Details', 'ລາຍລະອຽດ', 'รายละเอียด', '详细信息', 'Chi tiết'],
    hideDetails: ['Hide details', 'ເຊື່ອງລາຍລະອຽດ', 'ซ่อนรายละเอียด', '隐藏详细信息', 'Ẩn chi tiết']
  };

  var psLang = 'en';
  var psShowDetails = false;
  /* Null until the first /pairing answer. Kept so a language switch can redraw without refetching. */
  var psState = null;

  function psIndex() {
    var at = PS_LANGS.indexOf(psLang);
    return at < 0 ? 0 : at;
  }

  /* Falls back to English rather than rendering undefined, exactly as i18next does in the POS. */
  function psText(key) {
    var row = PS_T[key];
    if (!row) return '';
    return row[psIndex()] || row[0];
  }

  function psReadLang() {
    try {
      var stored = window.localStorage.getItem(PS_LANG_KEY);
      if (stored && PS_LANGS.indexOf(stored) !== -1) return stored;
    } catch (err) { /* private mode: fall through to the browser's own preference */ }
    /* The browser already knows what the person reads. Honour it before defaulting. */
    var nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return PS_LANGS.indexOf(nav) !== -1 ? nav : 'en';
  }

  function psWriteLang(value) {
    try { window.localStorage.setItem(PS_LANG_KEY, value); } catch (err) { /* not worth failing over */ }
  }

  function psBuildLangs() {
    var host = $('ps-langs');
    host.textContent = '';
    PS_LANGS.forEach(function (code) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = PS_LANG_NAMES[code];
      button.setAttribute('aria-pressed', String(code === psLang));
      button.addEventListener('click', function () {
        psLang = code;
        psWriteLang(code);
        psBuildLangs();
        psRender();
      });
      host.appendChild(button);
    });
  }

  /*
   * Which of the five screens to show.
   *
   * The distinction that matters is the last two: a bridge whose token the SERVER rejected will
   * never recover by waiting and needs a person, while one that simply cannot reach the network
   * recovers on its own and must not be offered a button that throws a working station away.
   * The pairing phase tells them apart properly, instead of the old page's regex over last_error.
   */
  function psScreen(state) {
    if (!state) return 'hidden';
    if (state.phase === 'paired') return 'ok';
    if (state.phase === 'redeeming') return 'connecting';
    if (state.phase === 'waiting' || state.phase === 'requesting') {
      return state.has_credential ? 'removed-repairing' : 'waiting';
    }
    if (state.phase === 'offline') return 'offline';
    /* Idle with a credential is the ordinary healthy bridge: nothing to pair, show diagnostics. */
    if (state.has_credential) {
      return state.relay && state.relay.connected ? 'hidden' : 'removed';
    }
    return 'waiting';
  }

  function psShow(id, on) {
    $(id).hidden = !on;
  }

  function psRender() {
    var state = psState;
    var screen = psScreen(state);

    /* Details is a manual override: once someone opens the diagnostics, keep them open. */
    var showPairing = screen !== 'hidden' && !psShowDetails;
    $('pairscreen').hidden = !showPairing;
    $('report').hidden = showPairing;
    $('ps-details').textContent = psShowDetails ? psText('hideDetails') : psText('details');
    if (screen === 'hidden') return;

    var icon = $('ps-icon');
    var lead = $('ps-lead');
    var sub = $('ps-sub');
    var action = $('ps-action');

    psShow('ps-qr', false);
    psShow('ps-codewrap', false);
    psShow('ps-meta', false);
    psShow('ps-action', false);
    psShow('ps-icon', false);
    icon.className = 'ps-icon';

    var who = [state.org_name, state.branch_name].filter(Boolean).join(' \u00b7 ');

    if (screen === 'waiting' || screen === 'removed-repairing') {
      lead.textContent = psText('waitLead');
      sub.textContent = psText('waitSub');
      if (state.qr_svg) {
        $('ps-qr').innerHTML = state.qr_svg;
        psShow('ps-qr', true);
      }
      if (state.code) {
        $('ps-codelabel').textContent = psText('orType');
        $('ps-code').textContent = state.code;
        psShow('ps-codewrap', true);
      }
      $('ps-metatext').textContent =
        state.phase === 'requesting' ? psText('requesting') : psText('waiting');
      psShow('ps-meta', true);
      return;
    }

    if (screen === 'connecting') {
      icon.textContent = '\u2b1c';
      icon.className = 'ps-icon warn';
      psShow('ps-icon', true);
      lead.textContent = who ? psText('connectingLead') + ' ' + who : psText('connectingLead');
      sub.textContent = psText('connectingSub');
      return;
    }

    if (screen === 'ok') {
      icon.textContent = '\u2713';
      icon.className = 'ps-icon ok';
      psShow('ps-icon', true);
      lead.textContent = psText('okLead');
      sub.textContent = who ? who + ' \u2014 ' + psText('okSub') : psText('okSub');
      return;
    }

    if (screen === 'offline') {
      icon.textContent = '\u26a0';
      icon.className = 'ps-icon warn';
      psShow('ps-icon', true);
      lead.textContent = psText('offlineLead');
      sub.textContent = psText('offlineSub');
      return;
    }

    /* removed */
    icon.textContent = '\u26a0';
    icon.className = 'ps-icon bad';
    psShow('ps-icon', true);
    lead.textContent = psText('removedLead');
    sub.textContent = psText('removedSub');
    action.textContent = psText('removedBtn');
    psShow('ps-action', true);
  }

  /*
   * Loopback-only, like the route it calls. A 403 here means the page is being viewed from
   * another machine, which is exactly when the pairing screen must NOT appear: the code on it
   * would let whoever is looking claim this computer into their own organisation.
   */
  function psRefresh() {
    return get('/pairing').then(function (res) {
      psState = res.status === 200 && res.body && res.body.ok ? res.body : null;
      psRender();
    }).catch(function () {
      /* Leave the last known state up. The bridge being briefly unreachable from its own
         browser says nothing about whether it is paired. */
    });
  }

  $('ps-details').addEventListener('click', function () {
    psShowDetails = !psShowDetails;
    psRender();
  });

  $('ps-action').addEventListener('click', function () {
    var button = $('ps-action');
    button.disabled = true;
    post('/pairing/restart', {}).then(function () {
      return psRefresh();
    }).finally(function () {
      button.disabled = false;
    });
  });

  psLang = psReadLang();
  psBuildLangs();
  psRefresh();
  setInterval(psRefresh, 3000);

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
<a class="skip" href="#report">Skip to the bridge status</a>
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
      <span class="card-note" id="notice"></span>
      <span class="card-note" id="checked"></span>
      <button type="button" class="btn btn-ghost" id="forget" hidden>Forget token</button>
      <button type="button" class="btn" id="refresh">Refresh</button>
    </div>
  </header>

  <!--
    The one place this page speaks. Everything it reports arrives as a DOM mutation on a
    ten-second timer, so without this a screen-reader user is told nothing at all.
  -->
  <p class="sr-only" id="live" role="status" aria-live="polite" aria-atomic="true"></p>

  <noscript>
    <div class="banner banner-warn">
      <b>JavaScript is turned off,</b> so this page cannot show the bridge&rsquo;s state. The same
      information is available as JSON at <code>/health</code> and <code>/status</code>.
    </div>
  </noscript>

  <div id="banners" role="alert" aria-live="assertive"></div>

  <!--
    The pairing screen. Shown INSTEAD of the diagnostics whenever this bridge has nobody to
    print for, which is the only state a shop owner is ever meant to read. Everything is written
    by psRender(); the markup is a shell so there is no English baked into the document for a
    Lao till to fall back to.

    ⚠ Every id here is prefixed ps-. The Cloud relay card further down already owns
    pair-code, pair-lead and friends, and a duplicate id would have this screen quietly stealing
    the manual-entry input's element out from under it.

    ⚠ No backticks anywhere in this literal, including in comments. See the file header.
  -->
  <section class="pairscreen" id="pairscreen" hidden>
    <div class="ps-icon" id="ps-icon" hidden></div>
    <h2 class="ps-lead" id="ps-lead"></h2>
    <div class="ps-qr" id="ps-qr" hidden></div>
    <div class="ps-codewrap" id="ps-codewrap" hidden>
      <span class="ps-codelabel" id="ps-codelabel"></span>
      <span class="ps-code" id="ps-code"></span>
    </div>
    <p class="ps-sub" id="ps-sub"></p>
    <p class="ps-meta" id="ps-meta" hidden><span class="dot dot-warn ps-dot"></span><span id="ps-metatext"></span></p>
    <button type="button" class="btn" id="ps-action" hidden></button>
    <div class="ps-langs" id="ps-langs"></div>
    <button type="button" class="ps-details" id="ps-details"></button>
  </section>

  <section class="gate" id="gate" hidden>
    <h2>This bridge needs a token</h2>
    <p id="gate-message" role="status" aria-live="polite"></p>
    <form id="gate-form" autocomplete="off">
      <input type="password" id="token" placeholder="PRINT_BRIDGE_TOKEN" autocomplete="off" spellcheck="false" aria-label="Bridge token">
      <button type="submit" class="btn">Connect</button>
    </form>
  </section>

  <main class="grid" id="report">

    <section class="card card-wide">
      <div class="card-head">
        <h2 class="card-title">Printers</h2>
        <span class="card-note" id="printers-note"></span>
      </div>
      <div class="scroll">
        <table class="table-wide">
          <thead>
            <tr>
              <th scope="col">Printer</th>
              <th scope="col">Where</th>
              <th scope="col">State</th>
              <th scope="col" class="num">Latency</th>
              <th scope="col" class="num">Actions</th>
            </tr>
          </thead>
          <tbody id="printers-body">
            <tr><td class="empty" colspan="5">Loading&hellip;</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!--
      The way out of an empty registry, and the only card here that asks the bridge to do
      something rather than report. It still writes nothing: printers.json remains the single
      source of truth, exactly as the header of this file requires. What it removes is the step
      where an operator was told to open a terminal and run a binary that the macOS installer
      does not put on PATH.
    -->
    <section class="card card-wide">
      <div class="card-head">
        <h2 class="card-title">What this machine can see</h2>
      </div>
      <div class="card-body">
        <div class="find">
          <button type="button" class="btn" id="find">Find printers</button>
          <span class="find-note" id="find-note">Checks USB and serial, and sweeps this machine&rsquo;s own subnets.</span>
        </div>
        <ul class="found" id="found"></ul>
        <div class="where-file" id="where-file"></div>
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
      <div class="card-head">
        <h2 class="card-title">Recent jobs</h2>
        <span class="card-note" id="jobs-note"></span>
      </div>
      <div class="scroll">
        <table class="table-wide">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Printer</th>
              <th scope="col">Outcome</th>
              <th scope="col" class="num">Size</th>
              <th scope="col" class="num">Actions</th>
            </tr>
          </thead>
          <tbody id="jobs-body">
            <tr><td class="empty" colspan="5">Loading&hellip;</td></tr>
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
          <p class="pair-lead" id="pair-lead"></p>
          <ol class="pair-steps" id="pair-steps"></ol>
          <form id="pair-form" autocomplete="off">
            <input type="text" id="pair-code" placeholder="XXXX-XXXX" maxlength="9" spellcheck="false"
              autocapitalize="characters" autocorrect="off" aria-label="Pairing code">
            <button type="submit" class="btn" id="pair-submit">Connect</button>
          </form>
          <p class="pair-result" id="pair-result" hidden></p>
        </div>
      </div>
    </section>

  </main>

  <footer class="foot">
    <span>Printers are configured in <code>printers.json</code> &mdash; not here.</span>
    <span>This page reads the bridge and can test it; it never edits the registry.</span>
  </footer>

</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
