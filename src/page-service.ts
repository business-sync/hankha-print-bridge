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
   * Five languages, like the pairing screen and for the same reason: a shop owner is exactly who
   * presses Restart. Facts stay in English — a path, a version and a hostname read the same in
   * every language, and translating the labels around them is what actually helps.
   *
   * Row order matches PS_LANGS in page.ts, and svcText reuses its psIndex().
   */
  var SVC_T = {
    title: ['This computer', 'ຄອມພິວເຕີເຄື່ອງນີ້', 'คอมพิวเตอร์เครื่องนี้', '这台电脑', 'Máy tính này'],
    restartLabel: [
      'Restart the print bridge',
      'ເປີດໂປຣແກຣມພິມຄືນໃໝ່',
      'เริ่มตัวเชื่อมเครื่องพิมพ์ใหม่',
      '重启打印桥',
      'Khởi động lại cầu nối in'
    ],
    restartNote: [
      'Printing pauses for a few seconds, then carries on.',
      'ການພິມຈະຢຸດຊົ່ວຄາວສອງສາມວິນາທີ ແລ້ວສືບຕໍ່.',
      'การพิมพ์จะหยุดชั่วครู่ แล้วทำงานต่อ',
      '打印会暂停几秒，然后继续。',
      'Việc in tạm dừng vài giây rồi tiếp tục.'
    ],
    restartBtn: ['Restart', 'ເປີດຄືນໃໝ່', 'เริ่มใหม่', '重启', 'Khởi động lại'],
    restartAsk: [
      'Restart now? Anything waiting to print will print when it is back.',
      'ເປີດຄືນໃໝ່ດຽວນີ້ບໍ? ວຽກທີ່ລໍຖ້າຢູ່ຈະພິມເມື່ອກັບມາ.',
      'เริ่มใหม่ตอนนี้ไหม งานที่รออยู่จะพิมพ์เมื่อกลับมา',
      '现在重启？排队的打印会在恢复后继续。',
      'Khởi động lại ngay? Các bản in đang chờ sẽ in khi hoạt động lại.'
    ],

    installLabel: [
      'Start automatically',
      'ເລີ່ມເອງອັດຕະໂນມັດ',
      'เริ่มอัตโนมัติ',
      '开机自动启动',
      'Tự động khởi chạy'
    ],
    installOn: [
      'It comes back on its own every time this computer starts.',
      'ມັນຈະເປີດເອງທຸກຄັ້ງທີ່ຄອມພິວເຕີເປີດ.',
      'จะเปิดเองทุกครั้งที่เปิดเครื่อง',
      '每次开机都会自动运行。',
      'Sẽ tự chạy mỗi lần máy khởi động.'
    ],
    installOff: [
      'Nothing starts it when this computer boots.',
      'ບໍ່ມີຫຍັງເປີດມັນເມື່ອຄອມພິວເຕີເປີດ.',
      'ไม่มีอะไรเปิดให้เมื่อเปิดเครื่อง',
      '开机时没有任何程序会启动它。',
      'Không có gì khởi chạy nó khi máy bật.'
    ],
    installBtn: ['Turn on', 'ເປີດໃຊ້', 'เปิดใช้', '开启', 'Bật'],
    installAsk: [
      'Let this computer start the print bridge on its own? It restarts once to hand over.',
      'ໃຫ້ຄອມພິວເຕີເປີດໂປຣແກຣມນີ້ເອງບໍ? ມັນຈະເປີດຄືນໃໝ່ໜຶ່ງຄັ້ງ.',
      'ให้เครื่องเปิดโปรแกรมนี้เองไหม จะเริ่มใหม่หนึ่งครั้ง',
      '让这台电脑自动启动打印桥？它会重启一次完成交接。',
      'Cho máy tự khởi chạy cầu nối in? Nó sẽ khởi động lại một lần.'
    ],

    removeLabel: [
      'Remove from this computer',
      'ລຶບອອກຈາກຄອມພິວເຕີນີ້',
      'ลบออกจากเครื่องนี้',
      '从这台电脑移除',
      'Gỡ khỏi máy tính này'
    ],
    removeNote: [
      'This computer stops printing. The log file is always kept.',
      'ຄອມພິວເຕີນີ້ຈະຢຸດພິມ. ໄຟລ໌ບັນທຶກຈະຖືກເກັບໄວ້ສະເໝີ.',
      'เครื่องนี้จะหยุดพิมพ์ ไฟล์บันทึกจะถูกเก็บไว้เสมอ',
      '这台电脑将停止打印。日志文件始终保留。',
      'Máy này sẽ ngừng in. Tệp nhật ký luôn được giữ lại.'
    ],
    removeBtn: ['Remove', 'ລຶບອອກ', 'ลบออก', '移除', 'Gỡ bỏ'],
    removeAsk: [
      'This computer will stop printing. Type its name to confirm:',
      'ຄອມພິວເຕີນີ້ຈະຢຸດພິມ. ພິມຊື່ຂອງມັນເພື່ອຢືນຢັນ:',
      'เครื่องนี้จะหยุดพิมพ์ พิมพ์ชื่อเครื่องเพื่อยืนยัน:',
      '这台电脑将停止打印。请输入它的名称以确认：',
      'Máy này sẽ ngừng in. Nhập tên máy để xác nhận:'
    ],
    scopeAutostart: [
      'Only stop it starting by itself',
      'ພຽງແຕ່ຢຸດການເປີດເອງ',
      'แค่หยุดการเปิดเอง',
      '仅停止自动启动',
      'Chỉ tắt tự khởi chạy'
    ],
    scopeFiles: ['Remove its files too', 'ລຶບໄຟລ໌ຂອງມັນນຳ', 'ลบไฟล์ของมันด้วย', '同时删除它的文件', 'Xoá cả tệp của nó'],
    scopeEverything: [
      'Remove everything, including printers and pairing',
      'ລຶບທັງໝົດ ລວມທັງເຄື່ອງພິມ ແລະ ການຈັບຄູ່',
      'ลบทั้งหมด รวมถึงเครื่องพิมพ์และการจับคู่',
      '全部删除，包括打印机和配对',
      'Xoá tất cả, kể cả máy in và ghép nối'
    ],

    rebootLabel: [
      'Restart this computer',
      'ເປີດຄອມພິວເຕີນີ້ຄືນໃໝ່',
      'รีสตาร์ตเครื่องนี้',
      '重启这台电脑',
      'Khởi động lại máy tính'
    ],
    rebootNote: [
      'Everything on this computer closes. Finish any open sale first.',
      'ທຸກຢ່າງໃນຄອມພິວເຕີນີ້ຈະປິດ. ຈົບການຂາຍທີ່ຄ້າງຢູ່ກ່ອນ.',
      'ทุกอย่างบนเครื่องนี้จะปิด ปิดการขายที่ค้างอยู่ก่อน',
      '这台电脑上的所有程序都会关闭。请先结束未完成的销售。',
      'Mọi thứ trên máy sẽ đóng. Hãy kết thúc đơn hàng đang mở trước.'
    ],
    rebootBtn: ['Restart computer', 'ເປີດເຄື່ອງຄືນໃໝ່', 'รีสตาร์ตเครื่อง', '重启电脑', 'Khởi động lại máy'],
    rebootAsk: [
      'Everything on this computer will close. Type its name to confirm:',
      'ທຸກຢ່າງໃນຄອມພິວເຕີນີ້ຈະປິດ. ພິມຊື່ຂອງມັນເພື່ອຢືນຢັນ:',
      'ทุกอย่างบนเครื่องนี้จะปิด พิมพ์ชื่อเครื่องเพื่อยืนยัน:',
      '这台电脑上的一切都会关闭。请输入它的名称以确认：',
      'Mọi thứ trên máy sẽ đóng. Nhập tên máy để xác nhận:'
    ],
    rebootQueue: [
      'Jobs are still waiting to print. They will print after the computer restarts.',
      'ຍັງມີວຽກລໍຖ້າພິມຢູ່. ພວກມັນຈະພິມຫຼັງຈາກເປີດເຄື່ອງຄືນໃໝ່.',
      'ยังมีงานรอพิมพ์อยู่ จะพิมพ์หลังเครื่องเริ่มใหม่',
      '仍有打印任务在排队，它们会在重启后打印。',
      'Vẫn còn bản in đang chờ. Chúng sẽ in sau khi máy khởi động lại.'
    ],

    cacheLabel: [
      'Clear stored print data',
      'ລ້າງຂໍ້ມູນການພິມທີ່ເກັບໄວ້',
      'ล้างข้อมูลการพิมพ์ที่เก็บไว้',
      '清除已保存的打印数据',
      'Xoá dữ liệu in đã lưu'
    ],
    cacheNote: [
      'Your printers and this computer\\u2019s pairing are never touched.',
      'ເຄື່ອງພິມ ແລະ ການຈັບຄູ່ຂອງຄອມພິວເຕີນີ້ຈະບໍ່ຖືກແຕະຕ້ອງ.',
      'เครื่องพิมพ์และการจับคู่ของเครื่องนี้จะไม่ถูกแตะต้อง',
      '不会影响您的打印机和这台电脑的配对。',
      'Máy in và ghép nối của máy này không bị ảnh hưởng.'
    ],
    cacheBtn: ['Choose\\u2026', 'ເລືອກ\\u2026', 'เลือก\\u2026', '选择\\u2026', 'Chọn\\u2026'],
    itemSpool: [
      'Print jobs still waiting',
      'ວຽກພິມທີ່ຍັງລໍຖ້າຢູ່',
      'งานพิมพ์ที่ยังรออยู่',
      '仍在排队的打印任务',
      'Bản in vẫn đang chờ'
    ],
    itemHistory: ['Recent job records', 'ບັນທຶກວຽກຫຼ້າສຸດ', 'บันทึกงานล่าสุด', '最近的任务记录', 'Bản ghi công việc gần đây'],
    itemSettled: ['Duplicate protection', 'ການປ້ອງກັນການພິມຊ້ຳ', 'การป้องกันพิมพ์ซ้ำ', '重复打印保护', 'Chống in trùng'],
    itemSettledWarn: [
      'Clearing this can let a repeated job print a second bill.',
      'ການລ້າງອັນນີ້ອາດເຮັດໃຫ້ວຽກທີ່ສົ່ງຊ້ຳພິມໃບບິນທີສອງ.',
      'การล้างนี้อาจทำให้งานที่ส่งซ้ำพิมพ์บิลใบที่สอง',
      '清除后，重复的任务可能会打出第二张单。',
      'Xoá mục này có thể khiến một đơn lặp in ra hoá đơn thứ hai.'
    ],
    itemLogs: ['Log files', 'ໄຟລ໌ບັນທຶກ', 'ไฟล์บันทึก', '日志文件', 'Tệp nhật ký'],
    clearBtn: ['Clear selected', 'ລ້າງທີ່ເລືອກ', 'ล้างที่เลือก', '清除所选', 'Xoá mục đã chọn'],
    cleared: ['Cleared.', 'ລ້າງແລ້ວ.', 'ล้างแล้ว', '已清除。', 'Đã xoá.'],

    cancel: ['Cancel', 'ຍົກເລີກ', 'ยกเลิก', '取消', 'Huỷ'],
    working: ['Working\\u2026', 'ກຳລັງດຳເນີນການ\\u2026', 'กำลังทำงาน\\u2026', '处理中\\u2026', 'Đang xử lý\\u2026'],
    nameWrong: [
      'That is not this computer\\u2019s name.',
      'ນັ້ນບໍ່ແມ່ນຊື່ຂອງຄອມພິວເຕີນີ້.',
      'นั่นไม่ใช่ชื่อของเครื่องนี้',
      '这不是这台电脑的名称。',
      'Đó không phải tên của máy này.'
    ],
    restartingLead: [
      'Restarting\\u2026',
      'ກຳລັງເປີດຄືນໃໝ່\\u2026',
      'กำลังเริ่มใหม่\\u2026',
      '正在重启\\u2026',
      'Đang khởi động lại\\u2026'
    ],
    restartingSub: [
      'This page updates on its own when it is back.',
      'ໜ້ານີ້ຈະອັບເດດເອງເມື່ອມັນກັບມາ.',
      'หน้านี้จะอัปเดตเองเมื่อกลับมา',
      '恢复后此页面会自动更新。',
      'Trang này sẽ tự cập nhật khi nó hoạt động lại.'
    ],
    backLead: ['It is back.', 'ມັນກັບມາແລ້ວ.', 'กลับมาแล้ว', '已恢复。', 'Đã hoạt động lại.'],
    notBackLead: [
      'It has not come back.',
      'ມັນຍັງບໍ່ກັບມາ.',
      'ยังไม่กลับมา',
      '它没有恢复。',
      'Nó chưa hoạt động lại.'
    ],
    notBackSub: [
      'The reason will be in the log file:',
      'ເຫດຜົນຈະຢູ່ໃນໄຟລ໌ບັນທຶກ:',
      'เหตุผลจะอยู่ในไฟล์บันทึก:',
      '原因会记录在日志文件中：',
      'Lý do sẽ có trong tệp nhật ký:'
    ],
    rebootingLead: [
      'This computer restarts in',
      'ຄອມພິວເຕີນີ້ຈະເປີດຄືນໃໝ່ໃນ',
      'เครื่องนี้จะรีสตาร์ตใน',
      '这台电脑将在以下时间后重启',
      'Máy tính sẽ khởi động lại sau'
    ],
    rebootStop: ['Stop the restart', 'ຢຸດການເປີດຄືນໃໝ່', 'หยุดการรีสตาร์ต', '停止重启', 'Dừng khởi động lại'],
    removedLead: ['Removed.', 'ລຶບອອກແລ້ວ.', 'ลบออกแล้ว', '已移除。', 'Đã gỡ bỏ.'],
    removedKept: ['Kept:', 'ເກັບໄວ້:', 'เก็บไว้:', '保留：', 'Giữ lại:'],
    removedManual: [
      'To finish, drag this to the Trash:',
      'ເພື່ອໃຫ້ຈົບ ໃຫ້ລາກອັນນີ້ໄປໃສ່ຖັງຂີ້ເຫຍື້ອ:',
      'เพื่อให้เสร็จ ลากสิ่งนี้ไปที่ถังขยะ:',
      '要完成，请将它拖到废纸篓：',
      'Để hoàn tất, kéo mục này vào Thùng rác:'
    ]
  };

  function svcText(key) {
    var row = SVC_T[key];
    if (!row) return '';
    return row[psIndex()] || row[0];
  }

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
        throw new Error('This bridge did not offer a confirmation.');
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
    if (!body) return 'The bridge answered ' + (res ? res.status : '?') + '.';
    if (body.reason === 'queue-not-empty') return svcText('rebootQueue');
    if (body.reason === 'busy') return 'Something else is already running.';
    if (body.reason === 'confirm-required') return 'That confirmation expired \\u2014 press again.';
    return (body.hint || body.detail || body.reason || 'It did not work.');
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

  function svcRow(key, label, note, capability, buttonText, onClick) {
    var row = h('li', 'svc-row');
    var head = h('div', 'svc-head');
    var text = h('div', 'svc-text');
    text.appendChild(h('span', 'svc-label', label));
    text.appendChild(h('span', 'svc-note', note));
    if (capability && !capability.allowed && capability.hint) {
      text.appendChild(h('span', 'svc-hint', capability.hint));
    }
    head.appendChild(text);

    if (capability && capability.allowed) {
      var button = h('button', 'btn btn-ghost btn-sm', buttonText);
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

  var MANAGER_NAMES = {
    'launchd-daemon': 'launchd (all users)',
    'launchd-agent': 'launchd (this login)',
    'scheduled-task': 'Task Scheduler',
    systemd: 'systemd',
    container: 'a container',
    none: 'nobody \\u2014 started by hand'
  };

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
    svcFact(facts, 'Started by', MANAGER_NAMES[svc.manager] || svc.manager);
    svcFact(facts, 'Starts at boot', svc.autostart ? 'yes' : 'no');
    if (svc.install_dir) svcFact(facts, 'Files', svc.install_dir);
    svcFact(facts, 'Data', svc.state_dir);
    if (svc.log_path) svcFact(facts, 'Log', svc.log_path);

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
