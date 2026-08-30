/*
 * The "This computer" card: restart, start automatically, remove, restart the computer, and
 * clear stored print data.
 *
 * Split out of page.ts, which is already 2,200 lines of three enormous template literals, and
 * subject to the same two rules that file states at the top — both load-bearing, both discovered
 * the hard way:
 *
 *   ⚠ NO BACKTICK anywhere inside the literals below. One ends the string, and the blast radius
 *     is the whole bridge: server.ts imports this, so the daemon will not start and tsc fails
 *     with a parse error hundreds of lines from the cause. `page-source.test.ts` guards both
 *     files as TEXT precisely because a guard that imported them could never run.
 *   ⚠ NEVER name the compile-time version expression here (the one `version.ts` reads).
 *     `bun build --define` rewrites it wherever it appears, strings included — and this guard is
 *     itself asserted by `page-source.test.ts`, so writing it even in a comment fails the suite.
 *
 * The fragments are spliced into page.ts's own CSS / SCRIPT / HTML literals, so the script half
 * shares the page's IIFE scope and uses its helpers directly: $, h, clear, get, post, notice,
 * announce, changed, psIndex, stopPolling.
 */

export const SERVICE_CSS = `
/* -------------------------------------------------- this computer (maintenance) */
.svc-facts { margin-bottom: 14px; }
.svc-rows { list-style: none; margin: 0; padding: 0; }
.svc-row { padding: 12px 0; border-bottom: 1px solid var(--border); }
.svc-row:first-child { padding-top: 0; }
.svc-row:last-child { border-bottom: 0; padding-bottom: 0; }
.svc-head { display: flex; gap: 12px; align-items: flex-start; }
.svc-text { flex: 1; min-width: 0; }
.svc-label { display: block; font-size: 13px; font-weight: 600; }
.svc-note { display: block; margin-top: 2px; font-size: 12px; color: var(--muted); }
.svc-hint {
  display: block; margin-top: 5px; padding: 5px 7px; border-radius: 6px;
  background: var(--surface-2); font: 12px/1.5 var(--mono); color: var(--muted);
  overflow-wrap: anywhere;
}
.svc-head > .btn { flex: none; }

/* The one destructive affordance on the page, and the only place this colour is used. */
.btn-danger { background: var(--bad); border-color: var(--bad); color: #fff; }

.svc-confirm {
  margin-top: 11px; padding: 11px 12px; border-radius: 9px;
  border: 1px solid var(--bad); background: var(--bad-bg);
}
.svc-confirm.svc-plain { border-color: var(--border-strong); background: var(--surface-2); }
.svc-confirm p { margin: 0 0 9px; font-size: 12.5px; color: var(--text); }
.svc-confirm-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.svc-confirm input[type="text"] {
  flex: 1 1 160px; min-width: 0; padding: 7px 9px; border-radius: 8px;
  border: 1px solid var(--border-strong); background: var(--surface);
  color: var(--text); font: 13px/1.3 var(--mono);
}
.svc-error { margin: 8px 0 0; font-size: 12px; color: var(--bad); }

.svc-items { list-style: none; margin: 0 0 10px; padding: 0; }
.svc-items li { display: flex; gap: 9px; align-items: flex-start; padding: 6px 0; }
.svc-items input[type="checkbox"] { margin-top: 2px; flex: none; }
.svc-item-text { flex: 1; min-width: 0; font-size: 12.5px; }
.svc-item-size { color: var(--faint); font-size: 12px; white-space: nowrap; }
.svc-item-warn { display: block; margin-top: 2px; font-size: 12px; color: var(--warn); }

/* A stage replaces the card body outright, so a screen left on a till never shows a half state. */
.svc-stage { text-align: center; padding: 8px 0 4px; }
.svc-stage h3 { margin: 0 0 6px; font-size: 15px; }
.svc-stage p { margin: 0 0 10px; font-size: 12.5px; color: var(--muted); }
.svc-count { font: 600 30px/1.1 var(--sans); font-variant-numeric: tabular-nums; margin-bottom: 8px; }
.svc-paths { list-style: none; margin: 8px 0 0; padding: 0; font: 12px/1.7 var(--mono); color: var(--muted); }
`;

export const SERVICE_HTML = `
    <section class="card card-wide" id="svc" hidden>
      <div class="card-head">
        <h2 class="card-title" id="svc-title">This computer</h2>
        <span class="card-note" id="svc-note"></span>
      </div>
      <div class="card-body">
        <dl class="kv svc-facts" id="svc-facts"></dl>
        <ul class="svc-rows" id="svc-rows"></ul>
        <div class="svc-stage" id="svc-stage" hidden></div>
      </div>
    </section>
`;

export const SERVICE_SCRIPT = `
  /* ================================================================ this computer */

  /*
   * Five languages, like the rest of the page and for the same reason: a shop owner is exactly
   * who presses Restart. The words live in page-i18n.ts under the svc. prefix, and svcText(key)
   * is t('svc.' + key) — this file keeps its own vocabulary, not its own table.
   *
   * FACTS stay as the bridge reports them: a path, a version and a hostname read the same in
   * every language and have to match what is on disk. Only the terms beside them move.
   */

  /* Last /service body, last /service/cache body, and which strip is open. */
  var svcState = null;
  var svcCache = null;
  var svcOpen = null;
  /* null | 'restarting' | 'back' | 'notback' | 'rebooting' | 'removed' */
  var svcStage = null;
  var svcStageData = null;
  var svcError = '';
  /*
   * What has been typed into a confirmation box, kept OUTSIDE the strip.
   *
   * Every render rebuilds the strip, and the first thing a render happens for is showing the
   * error that says the name was wrong — which threw away what the operator had just typed and
   * made a near-miss cost the whole entry again.
   */
  var svcTyped = '';
  var svcBusy = false;
  var svcWatch = null;
  var svcTick = null;

  /*
   * While we are the reason the bridge is unreachable, silence is the honest answer.
   *
   * refresh() in page.ts otherwise puts a red "Cannot reach the bridge" banner up the moment a
   * restart begins — which is exactly the thing the operator just asked for, reported as a
   * failure.
   */
  function svcQuiet() {
    return svcStage === 'restarting' || svcStage === 'rebooting' || svcStage === 'removed';
  }

  /*
   * Not a translation. The name is used to CONFIRM the two destructive actions, so it must be
   * matched against what the operator can actually see: macOS reports 'Counter.local' where the
   * sticker on the machine says 'Counter'.
   */
  function svcNameMatches(typed, machine) {
    var a = String(typed || '').trim().toLowerCase();
    var b = String(machine || '').trim().toLowerCase();
    if (!a || !b) return false;
    return a === b || a === b.split('.')[0];
  }

  function svcBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* --------------------------------------------------------------- fetching */

  function svcRefresh() {
    return get('/service').then(function (res) {
      /*
       * 403 is the ordinary answer when this page is open on ANOTHER machine over the LAN, and
       * it is the correct one: nothing here should be reachable from a second terminal. The card
       * simply does not exist for that viewer.
       */
      svcState = res.status === 200 && res.body && res.body.ok ? res.body : null;
      svcRender();
    }).catch(function () {
      /* Mid-restart. Leave the last known state up; the stage below is already saying so. */
    });
  }

  function svcRefreshCache() {
    return get('/service/cache').then(function (res) {
      svcCache = res.status === 200 && res.body && res.body.ok ? res.body.cache : null;
      svcRender();
    }).catch(function () { });
  }

  /*
   * Fetch a confirmation immediately before spending it.
   *
   * The token is single-use and short-lived, and this ordering — rather than a longer lifetime —
   * is what keeps it fresh. The bridge keeps several live at once so the ten-second poll cannot
   * invalidate the one an operator is in the middle of using.
   */
  function svcPost(path, payload) {
    return get('/service').then(function (res) {
      if (res.status !== 200 || !res.body || !res.body.confirm_token) {
        throw new Error(svcText('noConfirm'));
      }
      svcState = res.body;
      var body = { confirm: res.body.confirm_token };
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
      }
      return post(path, body, 20000);
    });
  }

  function svcReason(res) {
    var body = res && res.body ? res.body : null;
    if (!body) return t('answered', { status: res ? res.status : '?' });
    if (body.reason === 'queue-not-empty') return svcText('rebootQueue');
    if (body.reason === 'busy') return svcText('busy');
    if (body.reason === 'confirm-required') return svcText('confirmExpired');
    return (body.hint || body.detail || body.reason || svcText('didNotWork'));
  }

  /* ---------------------------------------------------------------- actions */

  function svcAct(name, path, payload, after) {
    svcBusy = true;
    svcError = '';
    svcRender();
    return svcPost(path, payload).then(function (res) {
      var body = res.body || {};
      if (res.status >= 200 && res.status < 300 && body.ok) {
        svcOpen = null;
        after(body);
      } else {
        svcError = svcReason(res);
      }
    }).catch(function (err) {
      svcError = err && err.message ? err.message : String(err);
    }).then(function () {
      svcBusy = false;
      svcRender();
      return svcRefresh();
    });
  }

  /*
   * Wait for a pid that is NOT the one we just stopped.
   *
   * "Something answered /health" is not the same as "our bridge came back": if another program
   * takes the port, it answers perfectly well while the bridge crash-loops behind it. That
   * mistake is the reason the macOS package's postinstall was rewritten, and repeating it here
   * would report a successful restart on a till that can no longer print.
   */
  function svcWaitForNewPid(previousPid, seconds) {
    svcStage = 'restarting';
    svcStageData = null;
    svcWatch = { pid: previousPid, until: Date.now() + Math.max(30, seconds) * 1000 };
    svcRender();
    svcPump();
  }

  function svcPump() {
    if (svcTick) clearTimeout(svcTick);
    svcTick = setTimeout(function () {
      if (!svcWatch) return;
      if (Date.now() > svcWatch.until) {
        svcWatch = null;
        svcStage = 'notback';
        svcRender();
        return;
      }
      get('/health', 4000).then(function (res) {
        /* Cancelled while this request was on the wire — the operator navigated, or a stage
           moved on. Reading .pid off a null watch here would throw inside a promise. */
        if (!svcWatch) return;
        var pid = res.body && res.body.pid;
        if (res.status === 200 && pid && pid !== svcWatch.pid) {
          svcWatch = null;
          svcStage = 'back';
          svcRender();
          announce(svcText('backLead'));
          refresh(true);
          setTimeout(function () {
            if (svcStage === 'back') { svcStage = null; svcRender(); }
          }, 6000);
          return;
        }
        svcPump();
      }).catch(function () { svcPump(); });
    }, 1500);
  }

  /* --------------------------------------------------------------- rendering */

  /*
   * Reasons whose hint is a COMMAND or a settings path rather than a sentence. For these the
   * translated reason explains WHY the button is missing and the bridge's own hint is still
   * printed under it, in mono, because a command is not a thing to translate. For every other
   * reason the hint IS the sentence, and the translation replaces it outright.
   */
  var SVC_HINT_IS_COMMAND = {
    'needs-root': true, 'needs-elevation': true, 'installer-missing': true,
    'no-session': true, 'unsupported-platform': true
  };

  /*
   * Which rows end printing rather than pause it.
   *
   * Restart is a few seconds of nothing and comes back on its own. Remove uninstalls the bridge,
   * and Restart the computer drops whatever sale is open on this till. All three were the same
   * ghost button, so the first thing telling an operator that one of them was different in kind
   * was the confirmation strip — after it had already been pressed. The strip still does the
   * real work; this is what stops them being pressed alike.
   */
  var SVC_RISKY = { remove: true, reboot: true };

  function svcRow(key, label, note, capability, buttonText, onClick) {
    var row = h('li', 'svc-row');
    var head = h('div', 'svc-head');
    var text = h('div', 'svc-text');
    text.appendChild(h('span', 'svc-label', label));
    text.appendChild(h('span', 'svc-note', note));
    /*
     * Gated on the HINT, not on the translation: a reason with no hint rendered nothing before
     * and must keep rendering nothing, or rows the offer() below deliberately hides would come
     * back as headings with a sentence and no button.
     */
    if (capability && !capability.allowed && capability.hint) {
      var why = tCode('svc.cap', capability.reason);
      if (why) text.appendChild(h('span', 'svc-note', why));
      if (!why || SVC_HINT_IS_COMMAND[capability.reason]) {
        text.appendChild(h('span', 'svc-hint', capability.hint));
      }
    }
    head.appendChild(text);

    if (capability && capability.allowed) {
      var button = h('button',
        'btn btn-ghost btn-sm' + (SVC_RISKY[key] ? ' btn-risk' : ''), buttonText);
      button.type = 'button';
      button.disabled = svcBusy;
      button.addEventListener('click', function () {
        svcOpen = svcOpen === key ? null : key;
        svcError = '';
        svcTyped = '';
        if (key === 'cache' && !svcCache) svcRefreshCache();
        svcRender();
      });
      head.appendChild(button);
    }

    row.appendChild(head);
    if (svcOpen === key) row.appendChild(svcConfirm(key));
    return row;
  }

  function svcConfirm(key) {
    var form = h('form', 'svc-confirm');
    var needsName = key === 'remove' || key === 'reboot';
    if (!needsName) form.className = 'svc-confirm svc-plain';

    var machine = svcState && svcState.service ? svcState.service.hostname : '';
    var scope = null;
    var items = null;
    var nameInput = null;

    if (key === 'restart') form.appendChild(h('p', null, svcText('restartAsk')));
    if (key === 'install') form.appendChild(h('p', null, svcText('installAsk')));

    if (key === 'remove') {
      form.appendChild(h('p', null, svcText('removeAsk') + ' ' + machine));
      scope = document.createElement('select');
      scope.className = 'svc-scope';
      [['autostart', svcText('scopeAutostart')],
       ['files', svcText('scopeFiles')],
       ['everything', svcText('scopeEverything')]].forEach(function (pair) {
        var option = document.createElement('option');
        option.value = pair[0];
        option.textContent = pair[1];
        scope.appendChild(option);
      });
      form.appendChild(scope);
    }

    if (key === 'reboot') {
      form.appendChild(h('p', null, svcText('rebootAsk') + ' ' + machine));
    }

    if (key === 'cache') {
      items = {};
      var list = h('ul', 'svc-items');
      var sizes = svcCache || {};
      [['spool', svcText('itemSpool'), true, ''],
       ['history', svcText('itemHistory'), true, ''],
       ['settled', svcText('itemSettled'), false, svcText('itemSettledWarn')],
       ['logs', svcText('itemLogs'), false, '']].forEach(function (spec) {
        var entry = sizes[spec[0]] || { count: 0, bytes: 0 };
        var li = h('li');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = spec[2];
        box.id = 'svc-item-' + spec[0];
        items[spec[0]] = box;

        var label = document.createElement('label');
        label.className = 'svc-item-text';
        label.htmlFor = box.id;
        label.appendChild(document.createTextNode(spec[1]));
        if (spec[3]) label.appendChild(h('span', 'svc-item-warn', spec[3]));

        var size = svcBytes(entry.bytes);
        li.appendChild(box);
        li.appendChild(label);
        li.appendChild(h('span', 'svc-item-size', entry.count + (size ? ' \\u00b7 ' + size : '')));
        list.appendChild(li);
      });
      form.appendChild(list);
    }

    var row = h('div', 'svc-confirm-row');
    if (needsName) {
      nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.autocomplete = 'off';
      nameInput.spellcheck = false;
      nameInput.placeholder = machine;
      nameInput.setAttribute('aria-label', machine);
      nameInput.value = svcTyped;
      nameInput.addEventListener('input', function () { svcTyped = nameInput.value; });
      row.appendChild(nameInput);
    }

    var go = h('button', needsName ? 'btn btn-danger' : 'btn',
      svcBusy ? svcText('working')
        : key === 'restart' ? svcText('restartBtn')
        : key === 'install' ? svcText('installBtn')
        : key === 'remove' ? svcText('removeBtn')
        : key === 'reboot' ? svcText('rebootBtn')
        : svcText('clearBtn'));
    go.type = 'submit';
    go.disabled = svcBusy;
    row.appendChild(go);

    var no = h('button', 'btn btn-ghost', svcText('cancel'));
    no.type = 'button';
    no.addEventListener('click', function () {
      svcOpen = null; svcError = ''; svcTyped = '';
      svcRender();
    });
    row.appendChild(no);
    form.appendChild(row);

    if (svcError) form.appendChild(h('p', 'svc-error', svcError));

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (svcBusy) return;

      if (needsName && !svcNameMatches(nameInput.value, machine)) {
        svcError = svcText('nameWrong');
        svcRender();
        // The strip was just rebuilt, so this is the new box, with the old text still in it.
        var again = $('svc-rows').querySelector('.svc-confirm input[type="text"]');
        if (again) { again.focus(); again.select(); }
        return;
      }

      var previousPid = svcState && svcState.pid;

      if (key === 'restart') {
        svcAct('restart', '/service/restart', {}, function (body) {
          svcWaitForNewPid(previousPid, body.expect_back_in_s || 30);
        });
        return;
      }
      if (key === 'install') {
        svcAct('autostart', '/service/autostart', {}, function (body) {
          svcWaitForNewPid(previousPid, body.expect_back_in_s || 45);
        });
        return;
      }
      if (key === 'remove') {
        svcAct('uninstall', '/service/uninstall', { scope: scope.value }, function (body) {
          svcStage = 'removed';
          svcStageData = body;
          stopPolling();
          svcRender();
        });
        return;
      }
      if (key === 'reboot') {
        svcAct('reboot', '/service/reboot', { force: true }, function (body) {
          svcStage = 'rebooting';
          svcStageData = body;
          svcRender();
          svcCountdown();
        });
        return;
      }

      var chosen = [];
      for (var name in items) {
        if (Object.prototype.hasOwnProperty.call(items, name) && items[name].checked) chosen.push(name);
      }
      if (chosen.length === 0) { svcOpen = null; svcRender(); return; }
      svcAct('clear-cache', '/service/cache', { items: chosen }, function (body) {
        var purged = body.purged || {};
        notice(svcText('cleared') + ' ' + (purged.spool || 0) + ' + ' + (purged.history || 0));
        svcCache = null;
        svcRefreshCache();
      });
    });

    return form;
  }

  function svcCountdown() {
    if (svcTick) clearTimeout(svcTick);
    svcTick = setTimeout(function () {
      if (svcStage !== 'rebooting') return;
      svcRender();
      svcCountdown();
    }, 1000);
  }

  function svcStageBody(host) {
    var data = svcStageData || {};

    if (svcStage === 'restarting') {
      host.appendChild(h('h3', null, svcText('restartingLead')));
      host.appendChild(h('p', null, svcText('restartingSub')));
      return;
    }
    if (svcStage === 'back') {
      host.appendChild(h('h3', null, svcText('backLead')));
      return;
    }
    if (svcStage === 'notback') {
      host.appendChild(h('h3', null, svcText('notBackLead')));
      host.appendChild(h('p', null, svcText('notBackSub')));
      var where = svcState && svcState.service ? svcState.service.log_path : null;
      if (where) host.appendChild(h('div', 'mono', where));
      return;
    }
    if (svcStage === 'rebooting') {
      var left = Math.max(0, Math.round((new Date(data.rebooting_at).getTime() - Date.now()) / 1000));
      host.appendChild(h('h3', null, svcText('rebootingLead')));
      host.appendChild(h('div', 'svc-count', left + 's'));
      var stop = h('button', 'btn', svcText('rebootStop'));
      stop.type = 'button';
      stop.addEventListener('click', function () {
        stop.disabled = true;
        svcPost('/service/reboot/cancel', {}).then(function () {
          svcStage = null;
          svcStageData = null;
          svcRender();
          startPolling();
        }).catch(function () { stop.disabled = false; });
      });
      host.appendChild(stop);
      return;
    }

    /* removed */
    host.appendChild(h('h3', null, svcText('removedLead')));
    if (data.manual && data.manual.length) {
      host.appendChild(h('p', null, svcText('removedManual')));
      var manual = h('ul', 'svc-paths');
      data.manual.forEach(function (path) { manual.appendChild(h('li', null, path)); });
      host.appendChild(manual);
    }
    if (data.kept && data.kept.length) {
      host.appendChild(h('p', null, svcText('removedKept')));
      var kept = h('ul', 'svc-paths');
      data.kept.forEach(function (path) { kept.appendChild(h('li', null, path)); });
      host.appendChild(kept);
    }
  }

  function svcFact(list, term, value) {
    list.appendChild(h('dt', null, term));
    list.appendChild(h('dd', 'mono', value));
  }

  /* 'launchd-daemon' -> svc.mgrLaunchdDaemon. A manager this page has never heard of prints
     its own name, which is more use than an empty cell. */
  function svcManager(manager) {
    return tCode('svc.mgr', manager) || manager;
  }

  function svcRender() {
    var card = $('svc');
    if (!svcState || !svcState.service) { card.hidden = true; return; }
    var svc = svcState.service;

    /*
     * Rebuild only on a real change. The poll runs every ten seconds, and redrawing through it
     * would close a confirmation strip while someone is typing a machine name into it.
     */
    var signature = {
      manager: svc.manager, autostart: svc.autostart, can: svc.can, busy: svcState.busy,
      // svcTyped is deliberately NOT here. It changes on every keystroke, and a signature that
      // moved with it would let the ten-second poll rebuild the box mid-word and jump the cursor
      // to the end. The error line is what the redraw is for, and that IS here.
      reboot: svcState.reboot, open: svcOpen, stage: svcStage, error: svcError,
      working: svcBusy, lang: psIndex(), cache: svcCache
    };
    if (!changed('service', signature) && svcStage !== 'rebooting') return;

    card.hidden = false;
    $('svc-title').textContent = svcText('title');
    $('svc-note').textContent = svc.hostname;

    var stage = $('svc-stage');
    clear(stage);
    stage.hidden = !svcStage;
    $('svc-facts').hidden = !!svcStage;
    $('svc-rows').hidden = !!svcStage;
    if (svcStage) { svcStageBody(stage); return; }

    var facts = $('svc-facts');
    clear(facts);
    svcFact(facts, svcText('factStartedBy'), svcManager(svc.manager));
    svcFact(facts, svcText('factBoot'), t(svc.autostart ? 'yes' : 'no'));
    if (svc.install_dir) svcFact(facts, svcText('factFiles'), svc.install_dir);
    svcFact(facts, svcText('factData'), svc.state_dir);
    if (svc.log_path) svcFact(facts, svcText('factLog'), svc.log_path);

    var rows = $('svc-rows');
    clear(rows);

    /*
     * A row earns its place by offering something: a button, or the command to run by hand.
     * Anything else is a heading with nothing under it — 'Remove from this computer' on a
     * machine where nothing is installed reads as a broken button rather than as 'not
     * applicable'.
     *
     * The install row is the exception, and deliberately so: its NOTE is the answer, and
     * 'it comes back on its own every time this computer starts' is the single most useful
     * sentence on the card.
     */
    function offer(key, label, note, capability, buttonText) {
      if (!capability.allowed && !capability.hint) return;
      rows.appendChild(svcRow(key, label, note, capability, buttonText));
    }

    offer('restart', svcText('restartLabel'), svcText('restartNote'),
      svc.can.restart, svcText('restartBtn'));
    rows.appendChild(svcRow('install', svcText('installLabel'),
      svc.autostart ? svcText('installOn') : svcText('installOff'),
      svc.can.autostart, svcText('installBtn')));
    offer('cache', svcText('cacheLabel'), svcText('cacheNote'),
      svc.can.clear_cache, svcText('cacheBtn'));
    offer('remove', svcText('removeLabel'), svcText('removeNote'),
      svc.can.uninstall, svcText('removeBtn'));
    offer('reboot', svcText('rebootLabel'), svcText('rebootNote'),
      svc.can.reboot, svcText('rebootBtn'));
  }

  svcRefresh();
  setInterval(svcRefresh, 15000);
`;
