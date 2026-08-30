/*
 * The five languages the served page speaks, in one table.
 *
 * The bridge is installed on a till in a Lao venue and opened by whoever is standing at it. Two
 * screens were already translated — the pairing screen in `page.ts` and the "This computer" card
 * in `page-service.ts` — each with its own private table, and everything else on the page was
 * English. This file is the one table all three read, so a key can be found once and a language
 * added in one place.
 *
 * ⚠ Why the strings live here as a real object rather than inside the page's template literals:
 * those literals are the reason this app has twice failed to start (a backtick ends the string;
 * see the header of `page.ts`), and they force every apostrophe and dash to be written as a
 * `\uXXXX` escape. Here the text is ordinary TypeScript — write the real character — and
 * `embed()` below serialises it into the script safely, escaping the three sequences that could
 * break out of the literal or out of the surrounding `<script>` element. It also makes the table
 * importable, which is what lets `page-i18n.test.ts` check all five columns are filled.
 *
 * Order is EN, LO, TH, ZH, VI and is load-bearing: `psIndex()` turns the chosen language into a
 * column number and every row is read by that number.
 *
 * What is deliberately NOT translated:
 *  - Values that come from the bridge as data: printer names, `detail` and `hint` strings, a
 *    transport kind, `escpos`/`receipt`, an address, a path, a version. They are the same words
 *    in `printers.json`, and a translated copy would not match what the operator has to type.
 *  - The `<noscript>` block, which cannot be reached by a script. It carries all five languages
 *    as markup instead.
 *  - The CLI (`src/index.ts`). It is read by whoever installs the bridge, over SSH, in English.
 */

export const PAGE_LANGS = ['en', 'lo', 'th', 'zh', 'vi'] as const;
export type PageLang = (typeof PAGE_LANGS)[number];

/** Native, self-referential labels — the same list, in the same order, as the POS shows. */
export const PAGE_LANG_NAMES: Record<PageLang, string> = {
  en: 'English',
  lo: 'ລາວ',
  th: 'ไทย',
  zh: '中文',
  vi: 'Tiếng Việt',
};

/**
 * BCP-47 tag fed to `toLocaleTimeString` for each language, so the clock beside a job matches
 * the words around it. Same map, same order, as the POS's own `LOCALE_TAG`.
 */
export const PAGE_LOCALE_TAGS: Record<PageLang, string> = {
  en: 'en-US',
  lo: 'lo-LA',
  th: 'th-TH',
  zh: 'zh-CN',
  vi: 'vi-VN',
};

/** One string per language, in PAGE_LANGS order: en, lo, th, zh, vi. */
export type Row = [string, string, string, string, string];

/**
 * `{name}` placeholders are filled at the call site by `t(key, vars)`. They are named rather
 * than positional because word order moves between these five languages — the count leads the
 * sentence in English and trails it in Lao — and a positional `%s` cannot be reordered.
 */
export const PAGE_STRINGS: Record<string, Row> = {
  /* ------------------------------------------------------------------ chrome */

  skip: [
    'Skip to the bridge status',
    'ຂ້າມໄປຫາສະຖານະຂອງໂປຣແກຣມພິມ',
    'ข้ามไปที่สถานะของตัวเชื่อมเครื่องพิมพ์',
    '跳至打印桥状态',
    'Chuyển tới trạng thái cầu nối in',
  ],
  connecting: ['connecting…', 'ກຳລັງເຊື່ອມຕໍ່…', 'กำลังเชื่อมต่อ…', '正在连接…', 'đang kết nối…'],
  forget: ['Forget token', 'ລືມໂທເຄັນ', 'ลืมโทเคน', '忘记令牌', 'Quên mã khoá'],
  refresh: ['Refresh', 'ໂຫຼດຄືນ', 'รีเฟรช', '刷新', 'Làm mới'],
  language: ['Language', 'ພາສາ', 'ภาษา', '语言', 'Ngôn ngữ'],

  gateTitle: [
    'This bridge needs a token',
    'ໂປຣແກຣມພິມນີ້ຕ້ອງການໂທເຄັນ',
    'ตัวเชื่อมนี้ต้องใช้โทเคน',
    '此打印桥需要令牌',
    'Cầu nối này cần mã khoá',
  ],
  tokenAria: [
    'Bridge token',
    'ໂທເຄັນຂອງໂປຣແກຣມພິມ',
    'โทเคนของตัวเชื่อม',
    '打印桥令牌',
    'Mã khoá cầu nối',
  ],
  connect: ['Connect', 'ເຊື່ອມຕໍ່', 'เชื่อมต่อ', '连接', 'Kết nối'],

  cardPrinters: ['Printers', 'ເຄື່ອງພິມ', 'เครื่องพิมพ์', '打印机', 'Máy in'],
  cardSeen: [
    'What this machine can see',
    'ສິ່ງທີ່ຄອມພິວເຕີນີ້ເຫັນ',
    'สิ่งที่เครื่องนี้มองเห็น',
    '这台电脑能看到什么',
    'Những gì máy này nhìn thấy',
  ],
  cardPoint: [
    'Point a terminal here',
    'ຊີ້ເຄື່ອງຂາຍມາທີ່ນີ້',
    'ชี้เครื่องขายมาที่นี่',
    '让收银机指向这里',
    'Trỏ máy bán hàng tới đây',
  ],
  cardQueue: ['Queue', 'ຄິວ', 'คิว', '队列', 'Hàng chờ'],
  cardJobs: ['Recent jobs', 'ວຽກພິມຫຼ້າສຸດ', 'งานพิมพ์ล่าสุด', '最近的打印任务', 'Công việc in gần đây'],
  cardTransports: [
    'Transports on this machine',
    'ຊ່ອງທາງພິມໃນຄອມພິວເຕີນີ້',
    'ช่องทางพิมพ์บนเครื่องนี้',
    '本机的打印通道',
    'Kênh in trên máy này',
  ],
  cardRelay: ['Cloud relay', 'ຕົວກາງຄລາວ', 'ตัวกลางบนคลาวด์', '云中继', 'Trung chuyển đám mây'],

  colPrinter: ['Printer', 'ເຄື່ອງພິມ', 'เครื่องพิมพ์', '打印机', 'Máy in'],
  /*
   * 'Address' rather than 'Where'. The column holds 192.168.1.103:9100, a spooler queue name or
   * a device path — all of them answers to 'what is its address', none of them to a question
   * that reads as a place in the room.
   */
  colWhere: ['Address', 'ທີ່ຢູ່', 'ที่อยู่', '地址', 'Địa chỉ'],
  colState: ['State', 'ສະຖານະ', 'สถานะ', '状态', 'Trạng thái'],
  colLatency: ['Latency', 'ຄວາມຊັກຊ້າ', 'ความหน่วง', '延迟', 'Độ trễ'],
  colActions: ['Actions', 'ການກະທຳ', 'การทำงาน', '操作', 'Thao tác'],
  colTime: ['Time', 'ເວລາ', 'เวลา', '时间', 'Thời gian'],
  colOutcome: ['Outcome', 'ຜົນລັບ', 'ผลลัพธ์', '结果', 'Kết quả'],
  colSize: ['Size', 'ຂະໜາດ', 'ขนาด', '大小', 'Kích thước'],
  loading: ['Loading…', 'ກຳລັງໂຫຼດ…', 'กำลังโหลด…', '加载中…', 'Đang tải…'],

  findBtn: ['Find printers', 'ຄົ້ນຫາເຄື່ອງພິມ', 'ค้นหาเครื่องพิมพ์', '查找打印机', 'Tìm máy in'],
  findIdle: [
    'Checks USB and serial, and sweeps this machine’s own subnets.',
    'ກວດ USB ແລະ serial, ແລະ ສະແກນເຄືອຂ່າຍຂອງຄອມພິວເຕີນີ້.',
    'ตรวจ USB และ serial และสแกนเครือข่ายของเครื่องนี้',
    '检查 USB 和串口，并扫描本机所在的子网。',
    'Kiểm tra USB và cổng nối tiếp, và quét các mạng con của máy này.',
  ],

  pairCodeAria: ['Pairing code', 'ລະຫັດຈັບຄູ່', 'รหัสจับคู่', '配对代码', 'Mã ghép nối'],

  footOne: [
    'Printers are configured in {file} — not here.',
    'ເຄື່ອງພິມຖືກຕັ້ງຄ່າໃນ {file} — ບໍ່ແມ່ນຢູ່ນີ້.',
    'เครื่องพิมพ์ตั้งค่าในไฟล์ {file} ไม่ใช่ที่นี่',
    '打印机在 {file} 中配置，不在这里。',
    'Máy in được cấu hình trong {file} — không phải ở đây.',
  ],
  footTwo: [
    'This page reads the bridge and can test it; it never edits the registry.',
    'ໜ້ານີ້ອ່ານ ແລະ ທົດສອບໂປຣແກຣມພິມໄດ້ ແຕ່ບໍ່ເຄີຍແກ້ໄຂລາຍການເຄື່ອງພິມ.',
    'หน้านี้อ่านและทดสอบตัวเชื่อมได้ แต่ไม่แก้ไขรายการเครื่องพิมพ์',
    '本页只读取和测试打印桥，从不修改配置文件。',
    'Trang này chỉ đọc và thử cầu nối; nó không bao giờ sửa danh sách máy in.',
  ],

  /* ------------------------------------------------------- identity and time */

  up: ['up', 'ເປີດມາ', 'เปิดมา', '运行', 'chạy'],
  never: ['never', 'ບໍ່ເຄີຍ', 'ไม่เคย', '从未', 'chưa bao giờ'],
  justNow: ['just now', 'ຫາກໍ່ນີ້', 'เมื่อครู่นี้', '刚刚', 'vừa xong'],
  ago: ['{d} ago', '{d} ກ່ອນ', '{d} ที่แล้ว', '{d}前', '{d} trước'],
  unitDay: ['d', 'ວ', 'ว', '天', 'ng'],
  unitHour: ['h', 'ຊມ', 'ชม', '小时', 'g'],
  unitMinute: ['m', 'ນທ', 'น', '分', 'p'],
  unitSecond: ['s', 'ວິ', 'วิ', '秒', 'gy'],

  /* --------------------------------------------------------------- the token */

  awaitingToken: [
    'Waiting for the token above.',
    'ກຳລັງລໍຖ້າໂທເຄັນຂ້າງເທິງ.',
    'กำลังรอโทเคนด้านบน',
    '等待上方的令牌。',
    'Đang chờ mã khoá ở trên.',
  ],
  gateNeeded: [
    'This bridge is started with PRINT_BRIDGE_TOKEN set, so everything except its health check needs that token.',
    'ໂປຣແກຣມພິມນີ້ຖືກເປີດພ້ອມກັບ PRINT_BRIDGE_TOKEN, ດັ່ງນັ້ນທຸກຢ່າງ ຍົກເວັ້ນການກວດສະຖານະ ຕ້ອງໃຊ້ໂທເຄັນນັ້ນ.',
    'ตัวเชื่อมนี้เริ่มทำงานพร้อมตั้งค่า PRINT_BRIDGE_TOKEN ทุกอย่างยกเว้นการตรวจสถานะจึงต้องใช้โทเคนนั้น',
    '此打印桥启动时设置了 PRINT_BRIDGE_TOKEN，因此除健康检查外的一切都需要该令牌。',
    'Cầu nối này khởi chạy với PRINT_BRIDGE_TOKEN, nên mọi thứ trừ kiểm tra tình trạng đều cần mã khoá đó.',
  ],
  gateRejected: [
    'That token was not accepted. Check PRINT_BRIDGE_TOKEN on the machine running the bridge.',
    'ໂທເຄັນນັ້ນບໍ່ຖືກຮັບ. ໃຫ້ກວດ PRINT_BRIDGE_TOKEN ຢູ່ຄອມພິວເຕີທີ່ແລ່ນໂປຣແກຣມພິມ.',
    'โทเคนนั้นไม่ถูกยอมรับ ตรวจ PRINT_BRIDGE_TOKEN บนเครื่องที่รันตัวเชื่อม',
    '该令牌未被接受。请检查运行打印桥的电脑上的 PRINT_BRIDGE_TOKEN。',
    'Mã khoá đó không được chấp nhận. Kiểm tra PRINT_BRIDGE_TOKEN trên máy đang chạy cầu nối.',
  ],

  /* ------------------------------------------------------- talking to the bridge */

  timeout: [
    'The bridge did not answer within {s}s.',
    'ໂປຣແກຣມພິມບໍ່ຕອບພາຍໃນ {s} ວິນາທີ.',
    'ตัวเชื่อมไม่ตอบภายใน {s} วินาที',
    '打印桥在 {s} 秒内没有回应。',
    'Cầu nối không trả lời trong {s} giây.',
  ],
  answered: [
    'The bridge answered {status}.',
    'ໂປຣແກຣມພິມຕອບ {status}.',
    'ตัวเชื่อมตอบ {status}',
    '打印桥返回 {status}。',
    'Cầu nối trả về {status}.',
  ],
  answeredOn: [
    'The bridge answered {status} on {path}.',
    'ໂປຣແກຣມພິມຕອບ {status} ຢູ່ {path}.',
    'ตัวเชื่อมตอบ {status} ที่ {path}',
    '打印桥在 {path} 上返回 {status}。',
    'Cầu nối trả về {status} tại {path}.',
  ],
  noAnswer: [
    'The bridge did not answer.',
    'ໂປຣແກຣມພິມບໍ່ຕອບ.',
    'ตัวเชื่อมไม่ตอบ',
    '打印桥没有回应。',
    'Cầu nối không trả lời.',
  ],

  /* -------------------------------------------------------- point a terminal here */

  reachLocal: [
    'What a POS on this machine should use.',
    'ທີ່ຢູ່ທີ່ເຄື່ອງຂາຍໃນຄອມພິວເຕີນີ້ຄວນໃຊ້.',
    'ที่อยู่ที่เครื่องขายบนเครื่องนี้ควรใช้',
    '本机上的收银机应使用的地址。',
    'Địa chỉ mà máy bán hàng trên máy này nên dùng.',
  ],
  reachLocalOnly: [
    'What a POS on this machine should use — and the only address one served over https can reach.',
    'ທີ່ຢູ່ທີ່ເຄື່ອງຂາຍໃນຄອມພິວເຕີນີ້ຄວນໃຊ້ — ແລະ ເປັນທີ່ຢູ່ດຽວທີ່ເຄື່ອງຂາຍຜ່ານ https ຕິດຕໍ່ໄດ້.',
    'ที่อยู่ที่เครื่องขายบนเครื่องนี้ควรใช้ — และเป็นที่อยู่เดียวที่เครื่องขายผ่าน https ติดต่อได้',
    '本机上的收银机应使用的地址 — 也是通过 https 提供的收银机唯一能访问的地址。',
    'Địa chỉ mà máy bán hàng trên máy này nên dùng — và là địa chỉ duy nhất máy chạy qua https có thể tới.',
  ],
  reachLanTls: [
    'This LAN ({cidr}) — reachable by any POS that trusts this bridge’s certificate.',
    'ເຄືອຂ່າຍນີ້ ({cidr}) — ເຄື່ອງຂາຍທີ່ເຊື່ອຖືໃບຮັບຮອງຂອງໂປຣແກຣມພິມນີ້ຕິດຕໍ່ໄດ້.',
    'เครือข่ายนี้ ({cidr}) — เครื่องขายที่เชื่อถือใบรับรองของตัวเชื่อมนี้ติดต่อได้',
    '此局域网（{cidr}）— 任何信任本打印桥证书的收银机都可访问。',
    'Mạng nội bộ này ({cidr}) — mọi máy bán hàng tin cậy chứng chỉ của cầu nối này đều tới được.',
  ],
  reachLanHttp: [
    'This LAN ({cidr}) — reachable only by a POS served over plain http.',
    'ເຄືອຂ່າຍນີ້ ({cidr}) — ມີແຕ່ເຄື່ອງຂາຍທີ່ໃຊ້ http ທຳມະດາເທົ່ານັ້ນທີ່ຕິດຕໍ່ໄດ້.',
    'เครือข่ายนี้ ({cidr}) — มีเพียงเครื่องขายที่ใช้ http ธรรมดาเท่านั้นที่ติดต่อได้',
    '此局域网（{cidr}）— 只有通过普通 http 提供的收银机才能访问。',
    'Mạng nội bộ này ({cidr}) — chỉ máy bán hàng chạy qua http thường mới tới được.',
  ],
  reachNone: [
    'No other network interfaces — this bridge is bound to loopback.',
    'ບໍ່ມີເຄືອຂ່າຍອື່ນ — ໂປຣແກຣມພິມນີ້ຜູກກັບ loopback ເທົ່ານັ້ນ.',
    'ไม่มีเครือข่ายอื่น — ตัวเชื่อมนี้ผูกกับ loopback เท่านั้น',
    '没有其他网络接口 — 此打印桥只绑定在本地回环。',
    'Không có giao diện mạng nào khác — cầu nối này chỉ gắn với loopback.',
  ],
  copy: ['Copy', 'ສຳເນົາ', 'คัดลอก', '复制', 'Sao chép'],
  copied: ['Copied', 'ສຳເນົາແລ້ວ', 'คัดลอกแล้ว', '已复制', 'Đã sao chép'],
  selected: ['Selected', 'ເລືອກແລ້ວ', 'เลือกแล้ว', '已选中', 'Đã chọn'],

  /* ------------------------------------------------------------------ printers */

  configuredOne: ['1 configured', 'ຕັ້ງຄ່າແລ້ວ 1', 'ตั้งค่าแล้ว 1', '已配置 1 台', 'Đã cấu hình 1'],
  configuredMany: [
    '{n} configured',
    'ຕັ້ງຄ່າແລ້ວ {n}',
    'ตั้งค่าแล้ว {n}',
    '已配置 {n} 台',
    'Đã cấu hình {n}',
  ],
  noPrinters: [
    'No printers configured yet. Use Find printers below to see what this machine can see.',
    'ຍັງບໍ່ມີເຄື່ອງພິມທີ່ຕັ້ງຄ່າໄວ້. ໃຊ້ ຄົ້ນຫາເຄື່ອງພິມ ຂ້າງລຸ່ມ ເພື່ອເບິ່ງສິ່ງທີ່ຄອມພິວເຕີນີ້ເຫັນ.',
    'ยังไม่มีเครื่องพิมพ์ที่ตั้งค่าไว้ ใช้ ค้นหาเครื่องพิมพ์ ด้านล่าง เพื่อดูสิ่งที่เครื่องนี้มองเห็น',
    '尚未配置任何打印机。使用下方的 查找打印机 看看这台电脑能看到什么。',
    'Chưa có máy in nào được cấu hình. Dùng Tìm máy in bên dưới để xem máy này thấy gì.',
  ],
  stateDisabled: ['Disabled', 'ປິດໄວ້', 'ปิดอยู่', '已停用', 'Đã tắt'],
  stateOnline: ['Online', 'ອອນລາຍ', 'ออนไลน์', '在线', 'Trực tuyến'],
  stateOffline: ['Offline', 'ອອບລາຍ', 'ออฟไลน์', '离线', 'Ngoại tuyến'],
  notLoaded: ['not loaded', 'ໂຫຼດບໍ່ໄດ້', 'โหลดไม่ได้', '未载入', 'chưa tải được'],

  /*
   * Two printers sharing one name. printers.json is hand-edited and only ids are unique, so this
   * is an ordinary state, not a corrupt one — and it is the one state where the label on a row
   * cannot be trusted to say which machine Test print will reach.
   */
  dupName: ['Same name', 'ຊື່ຊ້ຳກັນ', 'ชื่อซ้ำ', '名称重复', 'Trùng tên'],
  dupTitle: [
    'Another printer is called this too. Check the address before you print to it.',
    'ມີເຄື່ອງພິມອື່ນຊື່ດຽວກັນ. ໃຫ້ກວດທີ່ຢູ່ກ່ອນສັ່ງພິມ.',
    'มีเครื่องพิมพ์อื่นชื่อเดียวกัน ตรวจที่อยู่ก่อนสั่งพิมพ์',
    '另一台打印机也叫这个名字。打印前请先核对地址。',
    'Một máy in khác cũng tên này. Hãy kiểm tra địa chỉ trước khi in.',
  ],

  testPrint: ['Test print', 'ພິມທົດສອບ', 'พิมพ์ทดสอบ', '测试打印', 'In thử'],
  printingBusy: ['Printing…', 'ກຳລັງພິມ…', 'กำลังพิมพ์…', '正在打印…', 'Đang in…'],
  sendingTest: [
    'Sending a test slip…',
    'ກຳລັງສົ່ງໃບທົດສອບ…',
    'กำลังส่งใบทดสอบ…',
    '正在发送测试小票…',
    'Đang gửi phiếu thử…',
  ],
  testSent: [
    'Test slip sent — check the paper.',
    'ສົ່ງໃບທົດສອບແລ້ວ — ໃຫ້ກວດເບິ່ງເຈ້ຍ.',
    'ส่งใบทดสอบแล้ว — ดูที่กระดาษ',
    '测试小票已发送 — 请查看纸张。',
    'Đã gửi phiếu thử — hãy xem giấy.',
  ],

  identify: ['Identify', 'ກວດຊະນິດ', 'ตรวจชนิด', '识别', 'Nhận dạng'],
  identifyTitle: [
    'Asks the printer which language it speaks. Harmless, but it may print a few stray characters.',
    'ຖາມເຄື່ອງພິມວ່າມັນໃຊ້ພາສາໃດ. ບໍ່ເປັນອັນຕະລາຍ ແຕ່ອາດພິມຕົວອັກສອນແປກໆອອກມາສອງສາມຕົວ.',
    'ถามเครื่องพิมพ์ว่าใช้ภาษาใด ไม่เป็นอันตราย แต่อาจพิมพ์อักขระแปลก ๆ ออกมาสองสามตัว',
    '询问打印机使用哪种指令语言。无害，但可能打出几个杂乱字符。',
    'Hỏi máy in dùng ngôn ngữ lệnh nào. Vô hại, nhưng có thể in ra vài ký tự lạ.',
  ],
  asking: ['Asking…', 'ກຳລັງຖາມ…', 'กำลังถาม…', '正在询问…', 'Đang hỏi…'],
  askingWhat: [
    'Asking the printer what it is…',
    'ກຳລັງຖາມເຄື່ອງພິມວ່າມັນແມ່ນຫຍັງ…',
    'กำลังถามเครื่องพิมพ์ว่าเป็นแบบใด…',
    '正在询问打印机的类型…',
    'Đang hỏi máy in là loại gì…',
  ],
  identOneWay: [
    'Only network printers can answer — {transport} is one-way.',
    'ມີແຕ່ເຄື່ອງພິມເຄືອຂ່າຍທີ່ຕອບໄດ້ — {transport} ເປັນທາງດຽວ.',
    'มีเพียงเครื่องพิมพ์เครือข่ายที่ตอบได้ — {transport} เป็นทางเดียว',
    '只有网络打印机能回应 — {transport} 是单向的。',
    'Chỉ máy in mạng mới trả lời được — {transport} là một chiều.',
  ],
  identSilent: [
    'The printer did not answer — many models never do.',
    'ເຄື່ອງພິມບໍ່ຕອບ — ຫຼາຍລຸ້ນບໍ່ຕອບເລີຍ.',
    'เครื่องพิมพ์ไม่ตอบ — หลายรุ่นไม่ตอบเลย',
    '打印机没有回应 — 很多型号从不回应。',
    'Máy in không trả lời — nhiều mẫu không bao giờ trả lời.',
  ],
  identMatch: [
    'Answered as {detected}, which matches printers.json.',
    'ຕອບວ່າ {detected} ຊຶ່ງກົງກັບ printers.json.',
    'ตอบว่า {detected} ซึ่งตรงกับ printers.json',
    '回应为 {detected}，与 printers.json 一致。',
    'Trả lời là {detected}, khớp với printers.json.',
  ],
  identMismatch: [
    'Answered as {detected}, but printers.json says {configured}. Set language to {detected}.',
    'ຕອບວ່າ {detected} ແຕ່ printers.json ບອກວ່າ {configured}. ໃຫ້ຕັ້ງ language ເປັນ {detected}.',
    'ตอบว่า {detected} แต่ printers.json ระบุ {configured} ให้ตั้ง language เป็น {detected}',
    '回应为 {detected}，但 printers.json 写的是 {configured}。请把 language 设为 {detected}。',
    'Trả lời là {detected}, nhưng printers.json ghi {configured}. Hãy đặt language thành {detected}.',
  ],

  /* --------------------------------------------------------- the queue and jobs */

  statusQueued: ['queued', 'ຢູ່ໃນຄິວ', 'อยู่ในคิว', '排队中', 'đang chờ'],
  statusPrinting: ['printing', 'ກຳລັງພິມ', 'กำลังพิมพ์', '打印中', 'đang in'],
  statusDone: ['done', 'ສຳເລັດ', 'เสร็จแล้ว', '已完成', 'xong'],
  statusFailed: ['failed', 'ລົ້ມເຫຼວ', 'ล้มเหลว', '失败', 'thất bại'],
  statusExpired: ['expired', 'ໝົດອາຍຸ', 'หมดอายุ', '已过期', 'hết hạn'],

  inFlight: ['{n} in flight', 'ກຳລັງດຳເນີນ {n}', 'กำลังดำเนินการ {n}', '进行中 {n}', '{n} đang chạy'],
  jobsFailed: [
    'Could not load recent jobs.',
    'ໂຫຼດວຽກພິມຫຼ້າສຸດບໍ່ໄດ້.',
    'โหลดงานพิมพ์ล่าสุดไม่ได้',
    '无法载入最近的任务。',
    'Không tải được công việc gần đây.',
  ],
  jobsNone: [
    'Nothing printed since this bridge started.',
    'ບໍ່ມີການພິມນັບແຕ່ໂປຣແກຣມພິມນີ້ເລີ່ມແລ່ນ.',
    'ยังไม่มีการพิมพ์นับตั้งแต่ตัวเชื่อมเริ่มทำงาน',
    '自打印桥启动以来没有任何打印。',
    'Chưa in gì kể từ khi cầu nối khởi chạy.',
  ],
  jobsNewest: [
    'newest {n} of {total}',
    '{n} ໃໝ່ສຸດ ຈາກ {total}',
    '{n} ล่าสุด จาก {total}',
    '最新 {n} 条，共 {total} 条',
    '{n} mới nhất trong {total}',
  ],
  viaRelay: ['via relay', 'ຜ່ານຕົວກາງ', 'ผ่านตัวกลาง', '经由中继', 'qua trung chuyển'],
  overLan: ['over LAN', 'ຜ່ານເຄືອຂ່າຍພາຍໃນ', 'ผ่านเครือข่ายภายใน', '经由局域网', 'qua mạng nội bộ'],
  printedCertainty: [
    'printed: {value}',
    'ພິມແລ້ວ: {value}',
    'พิมพ์แล้ว: {value}',
    '已打印：{value}',
    'đã in: {value}',
  ],
  certaintyNone: ['no', 'ບໍ່', 'ไม่', '否', 'không'],
  certaintyUnknown: ['unknown', 'ບໍ່ແນ່ໃຈ', 'ไม่แน่ใจ', '不确定', 'không rõ'],
  expiresAt: ['expires {time}', 'ໝົດອາຍຸ {time}', 'หมดอายุ {time}', '{time} 过期', 'hết hạn {time}'],
  attempt: ['attempt {n}', 'ຄັ້ງທີ {n}', 'ครั้งที่ {n}', '第 {n} 次', 'lần {n}'],
  copies: ['{n} copies', '{n} ສະບັບ', '{n} ชุด', '{n} 份', '{n} bản'],

  cancel: ['Cancel', 'ຍົກເລີກ', 'ยกเลิก', '取消', 'Huỷ'],
  cancelling: ['Cancelling…', 'ກຳລັງຍົກເລີກ…', 'กำลังยกเลิก…', '正在取消…', 'Đang huỷ…'],
  withdrawing: [
    'Withdrawing this job…',
    'ກຳລັງຖອນວຽກນີ້…',
    'กำลังถอนงานนี้…',
    '正在撤回该任务…',
    'Đang rút công việc này…',
  ],
  cancelled: [
    'Cancelled before it reached the printer.',
    'ຍົກເລີກກ່ອນທີ່ຈະຮອດເຄື່ອງພິມ.',
    'ยกเลิกก่อนถึงเครื่องพิมพ์แล้ว',
    '在到达打印机之前已取消。',
    'Đã huỷ trước khi tới máy in.',
  ],
  cancelTooLate: [
    'Too late — it had already started printing.',
    'ຊ້າໄປ — ມັນເລີ່ມພິມແລ້ວ.',
    'ช้าไป — เริ่มพิมพ์ไปแล้ว',
    '太晚了 — 它已经开始打印。',
    'Quá muộn — nó đã bắt đầu in.',
  ],
  cancelGone: [
    'That job is no longer in the queue.',
    'ວຽກນັ້ນບໍ່ຢູ່ໃນຄິວແລ້ວ.',
    'งานนั้นไม่อยู่ในคิวแล้ว',
    '该任务已不在队列中。',
    'Công việc đó không còn trong hàng chờ.',
  ],

  /*
   * Why a send failed, as the queue reports it. The wire keeps the machine word
   * (`connect-refused`); only what the operator reads is turned into a sentence.
   */
  reasonConnectRefused: [
    'connection refused',
    'ຖືກປະຕິເສດການເຊື່ອມຕໍ່',
    'การเชื่อมต่อถูกปฏิเสธ',
    '连接被拒绝',
    'kết nối bị từ chối',
  ],
  reasonUnreachable: ['unreachable', 'ຕິດຕໍ່ບໍ່ໄດ້', 'ติดต่อไม่ได้', '无法连通', 'không tới được'],
  reasonConnectTimeout: [
    'connection timed out',
    'ໝົດເວລາເຊື່ອມຕໍ່',
    'หมดเวลาเชื่อมต่อ',
    '连接超时',
    'hết thời gian kết nối',
  ],
  reasonWriteTimeout: [
    'write timed out',
    'ໝົດເວລາສົ່ງຂໍ້ມູນ',
    'หมดเวลาส่งข้อมูล',
    '写入超时',
    'hết thời gian gửi',
  ],
  reasonDeviceMissing: [
    'device missing',
    'ບໍ່ພົບອຸປະກອນ',
    'ไม่พบอุปกรณ์',
    '找不到设备',
    'không thấy thiết bị',
  ],
  reasonDeviceBusy: [
    'device busy',
    'ອຸປະກອນຖືກໃຊ້ຢູ່',
    'อุปกรณ์ถูกใช้งานอยู่',
    '设备被占用',
    'thiết bị đang bận',
  ],
  reasonNotSupported: [
    'not supported here',
    'ບໍ່ຮອງຮັບໃນເຄື່ອງນີ້',
    'ไม่รองรับบนเครื่องนี้',
    '本机不支持',
    'máy này không hỗ trợ',
  ],
  reasonSpoolerError: [
    'the print spooler refused it',
    'ຕົວຈັດຄິວພິມປະຕິເສດ',
    'ตัวจัดคิวพิมพ์ปฏิเสธ',
    '打印后台拒绝了它',
    'bộ xếp hàng in đã từ chối',
  ],
  reasonCancelled: ['cancelled', 'ຍົກເລີກແລ້ວ', 'ยกเลิกแล้ว', '已取消', 'đã huỷ'],

  /* ---------------------------------------------------------------- transports */

  available: ['Available', 'ໃຊ້ໄດ້', 'ใช้ได้', '可用', 'Khả dụng'],
  unavailable: ['Unavailable', 'ໃຊ້ບໍ່ໄດ້', 'ใช้ไม่ได้', '不可用', 'Không khả dụng'],

  /* --------------------------------------------------------------- cloud relay */

  relayEnrolled: ['Enrolled', 'ລົງທະບຽນແລ້ວ', 'ลงทะเบียนแล้ว', '已登记', 'Đã đăng ký'],
  relayBridgeId: ['Bridge id', 'ລະຫັດໂປຣແກຣມພິມ', 'รหัสตัวเชื่อม', '打印桥编号', 'Mã cầu nối'],
  relayConnected: ['Connected', 'ເຊື່ອມຕໍ່ແລ້ວ', 'เชื่อมต่อแล้ว', '已连接', 'Đã kết nối'],
  relayChannel: ['Channel', 'ຊ່ອງທາງ', 'ช่องทาง', '通道', 'Kênh'],
  relayLastContact: ['Last contact', 'ຕິດຕໍ່ຫຼ້າສຸດ', 'ติดต่อล่าสุด', '最后联络', 'Liên lạc gần nhất'],
  relayLastError: ['Last error', 'ຂໍ້ຜິດພາດຫຼ້າສຸດ', 'ข้อผิดพลาดล่าสุด', '最后错误', 'Lỗi gần nhất'],
  yes: ['yes', 'ແມ່ນ', 'ใช่', '是', 'có'],
  no: ['no', 'ບໍ່', 'ไม่', '否', 'không'],
  relayNotEstablished: [
    'not yet established',
    'ຍັງບໍ່ທັນສ້າງ',
    'ยังไม่ได้สร้าง',
    '尚未建立',
    'chưa thiết lập',
  ],
  relayNotEnrolled: ['not enrolled', 'ຍັງບໍ່ລົງທະບຽນ', 'ยังไม่ลงทะเบียน', '未登记', 'chưa đăng ký'],
  relayOnline: ['connected', 'ເຊື່ອມຕໍ່ແລ້ວ', 'เชื่อมต่อแล้ว', '已连接', 'đã kết nối'],
  relayOffline: ['offline', 'ອອບລາຍ', 'ออฟไลน์', '离线', 'ngoại tuyến'],
  repair: ['Re-pair', 'ຈັບຄູ່ໃໝ່', 'จับคู่ใหม่', '重新配对', 'Ghép nối lại'],

  pairLeadNew: [
    'Jobs only arrive over the LAN. To let a phone or tablet print through this bridge, pair it with your venue.',
    'ວຽກພິມມາຮອດຜ່ານເຄືອຂ່າຍພາຍໃນເທົ່ານັ້ນ. ເພື່ອໃຫ້ໂທລະສັບ ຫຼື ແທັບເລັດພິມຜ່ານໂປຣແກຣມນີ້ໄດ້ ໃຫ້ຈັບຄູ່ມັນກັບຮ້ານຂອງທ່ານ.',
    'งานพิมพ์มาถึงผ่านเครือข่ายภายในเท่านั้น หากต้องการให้มือถือหรือแท็บเล็ตพิมพ์ผ่านตัวเชื่อมนี้ ให้จับคู่กับร้านของคุณ',
    '任务只能通过局域网到达。若要让手机或平板通过此打印桥打印，请把它与你的门店配对。',
    'Công việc in chỉ tới qua mạng nội bộ. Để điện thoại hoặc máy tính bảng in qua cầu nối này, hãy ghép nối nó với cửa hàng của bạn.',
  ],
  pairLeadRejected: [
    'This bridge is paired, but the server is not accepting its credential{why}. Pair it again with a fresh code.',
    'ໂປຣແກຣມພິມນີ້ຈັບຄູ່ແລ້ວ ແຕ່ເຊີບເວີບໍ່ຮັບຂໍ້ມູນຢືນຢັນຂອງມັນ{why}. ໃຫ້ຈັບຄູ່ໃໝ່ດ້ວຍລະຫັດໃໝ່.',
    'ตัวเชื่อมนี้จับคู่แล้ว แต่เซิร์ฟเวอร์ไม่รับข้อมูลยืนยันของมัน{why} ให้จับคู่ใหม่ด้วยรหัสใหม่',
    '此打印桥已配对，但服务器不接受它的凭据{why}。请用新代码重新配对。',
    'Cầu nối này đã ghép nối, nhưng máy chủ không chấp nhận thông tin xác thực của nó{why}. Hãy ghép nối lại bằng mã mới.',
  ],
  pairLeadDropped: [
    'This bridge is paired, but it is not reaching the server right now{why}. It usually reconnects on its own — pair it again only if this does not clear.',
    'ໂປຣແກຣມພິມນີ້ຈັບຄູ່ແລ້ວ ແຕ່ຕອນນີ້ຕິດຕໍ່ເຊີບເວີບໍ່ໄດ້{why}. ປົກກະຕິມັນຈະກັບມາເອງ — ໃຫ້ຈັບຄູ່ໃໝ່ສະເພາະເມື່ອອາການນີ້ບໍ່ຫາຍ.',
    'ตัวเชื่อมนี้จับคู่แล้ว แต่ตอนนี้ติดต่อเซิร์ฟเวอร์ไม่ได้{why} ปกติจะกลับมาเอง — จับคู่ใหม่เฉพาะเมื่ออาการนี้ไม่หาย',
    '此打印桥已配对，但目前联系不上服务器{why}。它通常会自行恢复 — 只有在一直不恢复时才重新配对。',
    'Cầu nối này đã ghép nối, nhưng hiện không liên lạc được với máy chủ{why}. Thường nó tự kết nối lại — chỉ ghép nối lại nếu tình trạng này không hết.',
  ],
  pairStepRemove: [
    'In the POS, open Settings > Printing, remove this print bridge, then tap Add bridge.',
    'ໃນເຄື່ອງຂາຍ ໃຫ້ເປີດ ຕັ້ງຄ່າ > ການພິມ, ລຶບໂປຣແກຣມພິມນີ້ອອກ ແລ້ວກົດ ເພີ່ມໂປຣແກຣມພິມ.',
    'ในเครื่องขาย เปิด ตั้งค่า > การพิมพ์ ลบตัวเชื่อมนี้ออก แล้วแตะ เพิ่มตัวเชื่อม',
    '在收银机上打开 设置 > 打印，移除此打印桥，然后点击 添加打印桥。',
    'Trên máy bán hàng, mở Cài đặt > In ấn, gỡ cầu nối này, rồi chạm Thêm cầu nối.',
  ],
  pairStepNewCode: [
    'Type the new pairing code into the box below.',
    'ພິມລະຫັດຈັບຄູ່ໃໝ່ໃສ່ຊ່ອງຂ້າງລຸ່ມ.',
    'พิมพ์รหัสจับคู่ใหม่ลงในช่องด้านล่าง',
    '把新的配对代码输入下面的框中。',
    'Nhập mã ghép nối mới vào ô bên dưới.',
  ],
  pairStepAdd: [
    'In the POS, open Settings > Printing and tap Add bridge.',
    'ໃນເຄື່ອງຂາຍ ໃຫ້ເປີດ ຕັ້ງຄ່າ > ການພິມ ແລ້ວກົດ ເພີ່ມໂປຣແກຣມພິມ.',
    'ในเครื่องขาย เปิด ตั้งค่า > การพิมพ์ แล้วแตะ เพิ่มตัวเชื่อม',
    '在收银机上打开 设置 > 打印，然后点击 添加打印桥。',
    'Trên máy bán hàng, mở Cài đặt > In ấn rồi chạm Thêm cầu nối.',
  ],
  pairStepCode: [
    'Type the pairing code it shows into the box below.',
    'ພິມລະຫັດຈັບຄູ່ທີ່ມັນສະແດງໃສ່ຊ່ອງຂ້າງລຸ່ມ.',
    'พิมพ์รหัสจับคู่ที่แสดงลงในช่องด้านล่าง',
    '把它显示的配对代码输入下面的框中。',
    'Nhập mã ghép nối mà nó hiển thị vào ô bên dưới.',
  ],

  pairCodeShort: [
    'A pairing code is eight characters, like XXXX-XXXX.',
    'ລະຫັດຈັບຄູ່ມີແປດຕົວອັກສອນ ເຊັ່ນ XXXX-XXXX.',
    'รหัสจับคู่มีแปดตัวอักษร เช่น XXXX-XXXX',
    '配对代码是八个字符，例如 XXXX-XXXX。',
    'Mã ghép nối gồm tám ký tự, ví dụ XXXX-XXXX.',
  ],
  pairConnecting: ['Connecting…', 'ກຳລັງເຊື່ອມຕໍ່…', 'กำลังเชื่อมต่อ…', '正在连接…', 'Đang kết nối…'],
  pairedRestart: [
    'Paired as bridge {id}. Restart the Print Bridge service to finish.',
    'ຈັບຄູ່ແລ້ວເປັນໂປຣແກຣມພິມ {id}. ໃຫ້ເປີດບໍລິການ Print Bridge ຄືນໃໝ່ເພື່ອໃຫ້ຈົບ.',
    'จับคู่แล้วเป็นตัวเชื่อม {id} ให้เริ่มบริการ Print Bridge ใหม่เพื่อให้เสร็จ',
    '已配对为打印桥 {id}。请重启 Print Bridge 服务以完成。',
    'Đã ghép nối thành cầu nối {id}. Hãy khởi động lại dịch vụ Print Bridge để hoàn tất.',
  ],
  pairedOk: [
    'Connected. This bridge is now paired — the POS should show it within a few seconds.',
    'ເຊື່ອມຕໍ່ແລ້ວ. ໂປຣແກຣມພິມນີ້ຈັບຄູ່ແລ້ວ — ເຄື່ອງຂາຍຄວນເຫັນມັນພາຍໃນສອງສາມວິນາທີ.',
    'เชื่อมต่อแล้ว ตัวเชื่อมนี้จับคู่เรียบร้อย — เครื่องขายควรเห็นภายในไม่กี่วินาที',
    '已连接。此打印桥现已配对 — 收银机应在几秒内显示它。',
    'Đã kết nối. Cầu nối này đã ghép nối — máy bán hàng sẽ thấy nó trong vài giây.',
  ],
  pairUnreachable: [
    'Could not reach the Print Bridge on this computer.',
    'ຕິດຕໍ່ Print Bridge ໃນຄອມພິວເຕີນີ້ບໍ່ໄດ້.',
    'ติดต่อ Print Bridge บนเครื่องนี้ไม่ได้',
    '无法连接这台电脑上的 Print Bridge。',
    'Không liên lạc được với Print Bridge trên máy tính này.',
  ],
  pairBadFormat: [
    'That does not look like a pairing code. Check it against the POS.',
    'ນັ້ນເບິ່ງບໍ່ຄືລະຫັດຈັບຄູ່. ໃຫ້ກວດກັບເຄື່ອງຂາຍ.',
    'นั่นดูไม่เหมือนรหัสจับคู่ ลองตรวจกับเครื่องขาย',
    '这看起来不像配对代码。请与收银机上的核对。',
    'Đó không giống mã ghép nối. Hãy đối chiếu với máy bán hàng.',
  ],
  pairAlready: [
    'This bridge is already paired with a venue. Remove it in Settings > Printing first.',
    'ໂປຣແກຣມພິມນີ້ຈັບຄູ່ກັບຮ້ານແລ້ວ. ໃຫ້ລຶບມັນອອກໃນ ຕັ້ງຄ່າ > ການພິມ ກ່ອນ.',
    'ตัวเชื่อมนี้จับคู่กับร้านแล้ว ให้ลบออกใน ตั้งค่า > การพิมพ์ ก่อน',
    '此打印桥已与某个门店配对。请先在 设置 > 打印 中移除它。',
    'Cầu nối này đã ghép nối với một cửa hàng. Hãy gỡ nó trong Cài đặt > In ấn trước.',
  ],
  pairNotLoopback: [
    'Pairing has to be done in a browser on this computer, not from another device.',
    'ການຈັບຄູ່ຕ້ອງເຮັດໃນເບຣົາເຊີຂອງຄອມພິວເຕີເຄື່ອງນີ້ ບໍ່ແມ່ນຈາກອຸປະກອນອື່ນ.',
    'การจับคู่ต้องทำในเบราว์เซอร์บนเครื่องนี้ ไม่ใช่จากอุปกรณ์อื่น',
    '配对必须在这台电脑的浏览器中完成，不能从其他设备进行。',
    'Việc ghép nối phải thực hiện trong trình duyệt trên máy tính này, không phải từ thiết bị khác.',
  ],
  pairFailed: [
    'Pairing failed (HTTP {status}). Check this computer is online, then try again.',
    'ຈັບຄູ່ບໍ່ສຳເລັດ (HTTP {status}). ໃຫ້ກວດວ່າຄອມພິວເຕີນີ້ອອນລາຍ ແລ້ວລອງໃໝ່.',
    'จับคู่ไม่สำเร็จ (HTTP {status}) ตรวจว่าเครื่องนี้ออนไลน์ แล้วลองใหม่',
    '配对失败（HTTP {status}）。请确认这台电脑已联网，然后重试。',
    'Ghép nối thất bại (HTTP {status}). Kiểm tra máy này đã trực tuyến rồi thử lại.',
  ],

  /* ----------------------------------------------------------------- discovery */

  looking: ['Looking…', 'ກຳລັງຄົ້ນຫາ…', 'กำลังค้นหา…', '正在查找…', 'Đang tìm…'],
  findBusy: [
    'Checking USB, serial and this machine’s own subnets…',
    'ກຳລັງກວດ USB, serial ແລະ ເຄືອຂ່າຍຂອງຄອມພິວເຕີນີ້…',
    'กำลังตรวจ USB, serial และเครือข่ายของเครื่องนี้…',
    '正在检查 USB、串口和本机所在的子网…',
    'Đang kiểm tra USB, cổng nối tiếp và các mạng con của máy này…',
  ],
  findFailedStatus: [
    'Could not look: the bridge answered {status}.',
    'ຄົ້ນຫາບໍ່ໄດ້: ໂປຣແກຣມພິມຕອບ {status}.',
    'ค้นหาไม่ได้: ตัวเชื่อมตอบ {status}',
    '无法查找：打印桥返回 {status}。',
    'Không tìm được: cầu nối trả về {status}.',
  ],
  findFailed: ['Could not look.', 'ຄົ້ນຫາບໍ່ໄດ້.', 'ค้นหาไม่ได้', '无法查找。', 'Không tìm được.'],
  swept: ['Swept {subnets}.', 'ສະແກນແລ້ວ {subnets}.', 'สแกนแล้ว {subnets}', '已扫描 {subnets}。', 'Đã quét {subnets}.'],
  sweptNone: [
    'No subnets to sweep — this bridge can only see its own machine.',
    'ບໍ່ມີເຄືອຂ່າຍໃຫ້ສະແກນ — ໂປຣແກຣມພິມນີ້ເຫັນແຕ່ຄອມພິວເຕີຂອງມັນເອງ.',
    'ไม่มีเครือข่ายให้สแกน — ตัวเชื่อมนี้เห็นเฉพาะเครื่องของตัวเอง',
    '没有可扫描的子网 — 此打印桥只能看到自己所在的机器。',
    'Không có mạng con nào để quét — cầu nối này chỉ thấy chính máy của nó.',
  ],
  foundOne: [
    '1 device found. {where}',
    'ພົບ 1 ອຸປະກອນ. {where}',
    'พบ 1 อุปกรณ์ {where}',
    '找到 1 台设备。{where}',
    'Tìm thấy 1 thiết bị. {where}',
  ],
  foundMany: [
    '{n} devices found. {where}',
    'ພົບ {n} ອຸປະກອນ. {where}',
    'พบ {n} อุปกรณ์ {where}',
    '找到 {n} 台设备。{where}',
    'Tìm thấy {n} thiết bị. {where}',
  ],
  foundNone: [
    'Nothing found. {where}',
    'ບໍ່ພົບຫຍັງ. {where}',
    'ไม่พบอะไร {where}',
    '没有找到任何设备。{where}',
    'Không tìm thấy gì. {where}',
  ],
  inRegistry: [
    'In printers.json',
    'ຢູ່ໃນ printers.json',
    'อยู่ใน printers.json',
    '已在 printers.json 中',
    'Có trong printers.json',
  ],
  notConfigured: ['Not configured', 'ຍັງບໍ່ຕັ້ງຄ່າ', 'ยังไม่ได้ตั้งค่า', '未配置', 'Chưa cấu hình'],
  copyEntry: ['Copy entry', 'ສຳເນົາລາຍການ', 'คัดลอกรายการ', '复制条目', 'Sao chép mục'],
  copyEntryTitle: [
    'Copies a printers.json entry for this device, ready to paste.',
    'ສຳເນົາລາຍການ printers.json ຂອງອຸປະກອນນີ້ ພ້ອມວາງ.',
    'คัดลอกรายการ printers.json ของอุปกรณ์นี้ พร้อมวาง',
    '复制此设备的 printers.json 条目，可直接粘贴。',
    'Sao chép mục printers.json cho thiết bị này, sẵn sàng để dán.',
  ],
  configuredIn: [
    'Printers are configured in',
    'ເຄື່ອງພິມຖືກຕັ້ງຄ່າໃນ',
    'เครื่องพิมพ์ตั้งค่าในไฟล์',
    '打印机配置在',
    'Máy in được cấu hình trong',
  ],

  /* ------------------------------------------------------------------- banners */

  containerLead: [
    'Running in a container without host networking.',
    'ແລ່ນຢູ່ໃນຄອນເທນເນີທີ່ບໍ່ໄດ້ໃຊ້ເຄືອຂ່າຍຂອງເຄື່ອງແມ່.',
    'ทำงานในคอนเทนเนอร์ที่ไม่ได้ใช้เครือข่ายของเครื่องแม่',
    '运行在没有使用宿主机网络的容器中。',
    'Đang chạy trong container không dùng mạng của máy chủ.',
  ],
  containerRest: [
    'Printing still works, but the addresses above are the container’s own — not this machine’s, and a scan will sweep the wrong network.',
    'ການພິມຍັງໃຊ້ໄດ້ ແຕ່ທີ່ຢູ່ຂ້າງເທິງແມ່ນຂອງຄອນເທນເນີ — ບໍ່ແມ່ນຂອງຄອມພິວເຕີນີ້ ແລະ ການສະແກນຈະສະແກນຜິດເຄືອຂ່າຍ.',
    'การพิมพ์ยังใช้ได้ แต่ที่อยู่ด้านบนเป็นของคอนเทนเนอร์ — ไม่ใช่ของเครื่องนี้ และการสแกนจะสแกนผิดเครือข่าย',
    '打印仍然可用，但上面的地址是容器自己的 — 不是这台机器的，扫描也会扫错网络。',
    'Việc in vẫn chạy, nhưng các địa chỉ ở trên là của container — không phải của máy này, và việc quét sẽ quét nhầm mạng.',
  ],
  offlineOne: [
    '1 printer is not answering.',
    'ມີເຄື່ອງພິມ 1 ເຄື່ອງບໍ່ຕອບ.',
    'มีเครื่องพิมพ์ 1 เครื่องไม่ตอบ',
    '有 1 台打印机没有回应。',
    'Có 1 máy in không trả lời.',
  ],
  offlineMany: [
    '{n} printers are not answering.',
    'ມີເຄື່ອງພິມ {n} ເຄື່ອງບໍ່ຕອບ.',
    'มีเครื่องพิมพ์ {n} เครื่องไม่ตอบ',
    '有 {n} 台打印机没有回应。',
    'Có {n} máy in không trả lời.',
  ],
  offlineRest: [
    'Jobs for them queue until they come back, or until they expire.',
    'ວຽກຂອງພວກມັນຈະຢູ່ໃນຄິວຈົນກວ່າມັນກັບມາ ຫຼື ຈົນໝົດອາຍຸ.',
    'งานของเครื่องเหล่านั้นจะรออยู่ในคิวจนกว่าจะกลับมา หรือจนหมดอายุ',
    '发给它们的任务会排队等待，直到它们恢复或任务过期。',
    'Công việc cho chúng sẽ nằm trong hàng chờ cho tới khi chúng trở lại, hoặc hết hạn.',
  ],
  allAnswering: [
    'All printers are answering.',
    'ເຄື່ອງພິມທັງໝົດຕອບປົກກະຕິ.',
    'เครื่องพิมพ์ทั้งหมดตอบปกติ',
    '所有打印机都有回应。',
    'Tất cả máy in đều trả lời.',
  ],
  checkedAt: ['checked {time}', 'ກວດເມື່ອ {time}', 'ตรวจเมื่อ {time}', '{time} 检查', 'kiểm lúc {time}'],
  unreachableLead: [
    'Cannot reach the bridge.',
    'ຕິດຕໍ່ໂປຣແກຣມພິມບໍ່ໄດ້.',
    'ติดต่อตัวเชื่อมไม่ได้',
    '无法连接打印桥。',
    'Không liên lạc được cầu nối.',
  ],
  unreachableRest: [
    'It may have stopped, or another program may have taken its port.',
    'ມັນອາດຢຸດແລ້ວ ຫຼື ໂປຣແກຣມອື່ນອາດຍຶດພອດຂອງມັນໄປ.',
    'อาจหยุดทำงาน หรือโปรแกรมอื่นอาจยึดพอร์ตของมันไป',
    '它可能已经停止，或者其端口被别的程序占用了。',
    'Có thể nó đã dừng, hoặc chương trình khác đã chiếm cổng của nó.',
  ],
  waitingPrinter: [
    'Waiting for the printer — this will refresh once it answers.',
    'ກຳລັງລໍຖ້າເຄື່ອງພິມ — ໜ້ານີ້ຈະໂຫຼດຄືນເມື່ອມັນຕອບ.',
    'กำลังรอเครื่องพิมพ์ — หน้านี้จะรีเฟรชเมื่อมันตอบ',
    '正在等待打印机 — 它回应后本页会刷新。',
    'Đang chờ máy in — trang sẽ làm mới khi nó trả lời.',
  ],

  /* ---------------------------------------------------------- pairing screen */

  /*
   * The one screen written for a shop owner rather than a technician — the whole viewport
   * whenever this bridge has nobody to print for. It was the first thing here to be translated,
   * and these rows moved out of `page.ts` unchanged.
   */
  'ps.waitLead': [
    'Scan this with your Hankha tablet or phone',
    'ສະແກນອັນນີ້ດ້ວຍແທັບເລັດ ຫຼື ໂທລະສັບ Hankha',
    'สแกนรหัสนี้ด้วยแท็บเล็ตหรือมือถือ Hankha',
    '用你的 Hankha 平板或手机扫描',
    'Quét mã này bằng máy tính bảng hoặc điện thoại Hankha',
  ],
  'ps.waitSub': [
    'Open the Hankha app, then go to Settings, Printing, Connect.',
    'ເປີດແອັບ Hankha, ໄປທີ່ ຕັ້ງຄ່າ, ການພິມ, ເຊື່ອມຕໍ່.',
    'เปิดแอป Hankha ไปที่ ตั้งค่า การพิมพ์ เชื่อมต่อ',
    '打开 Hankha 应用，进入 设置、打印、连接。',
    'Mở ứng dụng Hankha, vào Cài đặt, In ấn, Kết nối.',
  ],
  'ps.orType': ['or type this code', 'ຫຼື ພິມລະຫັດນີ້', 'หรือพิมพ์รหัสนี้', '或输入此代码', 'hoặc nhập mã này'],
  'ps.waiting': ['Waiting', 'ກຳລັງລໍຖ້າ', 'กำลังรอ', '等待中', 'Đang chờ'],
  'ps.requesting': ['Getting a code', 'ກຳລັງຂໍລະຫັດ', 'กำลังขอรหัส', '正在获取代码', 'Đang lấy mã'],
  'ps.connectingLead': [
    'Connecting to',
    'ກຳລັງເຊື່ອມຕໍ່ຫາ',
    'กำลังเชื่อมต่อกับ',
    '正在连接到',
    'Đang kết nối tới',
  ],
  'ps.connectingSub': [
    'Almost done. Do not close this window.',
    'ເກືອບແລ້ວ. ຢ່າປິດປ່ອງຢ້ຽມນີ້.',
    'ใกล้เสร็จแล้ว อย่าปิดหน้าต่างนี้',
    '就快好了。请不要关闭此窗口。',
    'Sắp xong. Đừng đóng cửa sổ này.',
  ],
  'ps.okLead': ['Connected', 'ເຊື່ອມຕໍ່ແລ້ວ', 'เชื่อมต่อแล้ว', '已连接', 'Đã kết nối'],
  'ps.okSub': [
    'Bills sent from your tablets will print here.',
    'ໃບບິນທີ່ສົ່ງຈາກແທັບເລັດຈະພິມອອກຢູ່ນີ້.',
    'ใบเสร็จที่ส่งจากแท็บเล็ตจะพิมพ์ที่นี่',
    '从平板发送的账单将在这里打印。',
    'Hóa đơn gửi từ máy tính bảng sẽ in ở đây.',
  ],
  /*
   * What the pairing screen says about the printers themselves.
   *
   * 'Connected' is about the cloud relay and nothing else, and an owner reading it has every
   * reason to think it covers the printer by the till. These rows are the half it does not say.
   */
  'ps.factsOneReady': [
    '1 printer ready',
    'ເຄື່ອງພິມ 1 ເຄື່ອງພ້ອມແລ້ວ',
    'เครื่องพิมพ์ 1 เครื่องพร้อมแล้ว',
    '1 台打印机就绪',
    '1 máy in sẵn sàng',
  ],
  'ps.factsReady': [
    '{n} printers ready',
    'ເຄື່ອງພິມ {n} ເຄື່ອງພ້ອມແລ້ວ',
    'เครื่องพิมพ์ {n} เครื่องพร้อมแล้ว',
    '{n} 台打印机就绪',
    '{n} máy in sẵn sàng',
  ],
  'ps.factsOffline': [
    '{n} of {total} printers are not answering',
    'ເຄື່ອງພິມ {n} ໃນ {total} ເຄື່ອງບໍ່ຕອບ',
    'เครื่องพิมพ์ {n} จาก {total} เครื่องไม่ตอบ',
    '{total} 台打印机中有 {n} 台没有回应',
    '{n} trong {total} máy in không trả lời',
  ],
  'ps.factsNone': [
    'No printers set up on this computer yet',
    'ຍັງບໍ່ມີເຄື່ອງພິມໃນຄອມພິວເຕີນີ້',
    'ยังไม่มีเครื่องพิมพ์บนเครื่องนี้',
    '这台电脑尚未设置打印机',
    'Máy tính này chưa có máy in nào',
  ],

  'ps.removedLead': [
    'This computer was disconnected',
    'ຄອມພິວເຕີເຄື່ອງນີ້ຖືກຕັດການເຊື່ອມຕໍ່',
    'คอมพิวเตอร์เครื่องนี้ถูกตัดการเชื่อมต่อ',
    '这台电脑已被断开',
    'Máy tính này đã bị ngắt kết nối',
  ],
  'ps.removedSub': [
    'Someone removed it from your shop. Get a new code and connect it again.',
    'ມີຄົນລຶບມັນອອກຈາກຮ້ານຂອງທ່ານ. ຂໍລະຫັດໃໝ່ ແລ້ວເຊື່ອມຕໍ່ອີກຄັ້ງ.',
    'มีคนลบออกจากร้านของคุณ ขอรหัสใหม่แล้วเชื่อมต่ออีกครั้ง',
    '有人把它从你的门店中移除了。获取新代码后重新连接。',
    'Ai đó đã xóa nó khỏi cửa hàng của bạn. Lấy mã mới và kết nối lại.',
  ],
  'ps.removedBtn': ['Get a new code', 'ຂໍລະຫັດໃໝ່', 'ขอรหัสใหม่', '获取新代码', 'Lấy mã mới'],
  'ps.offlineLead': [
    'Cannot reach Hankha right now',
    'ຕິດຕໍ່ Hankha ບໍ່ໄດ້ໃນຕອນນີ້',
    'ติดต่อ Hankha ไม่ได้ตอนนี้',
    '目前无法连接 Hankha',
    'Hiện không kết nối được Hankha',
  ],
  'ps.offlineSub': [
    'Retrying. Printing will start again by itself, there is nothing to do.',
    'ກຳລັງລອງໃໝ່. ການພິມຈະກັບມາເອງ, ບໍ່ຕ້ອງເຮັດຫຍັງ.',
    'กำลังลองใหม่ การพิมพ์จะกลับมาเอง ไม่ต้องทำอะไร',
    '正在重试。打印会自行恢复，无需操作。',
    'Đang thử lại. Việc in sẽ tự khôi phục, không cần làm gì.',
  ],
  'ps.details': ['Details', 'ລາຍລະອຽດ', 'รายละเอียด', '详细信息', 'Chi tiết'],
  'ps.hideDetails': [
    'Hide details',
    'ເຊື່ອງລາຍລະອຽດ',
    'ซ่อนรายละเอียด',
    '隐藏详细信息',
    'Ẩn chi tiết',
  ],

  /* ------------------------------------------------------------ this computer */

  'svc.title': ['This computer', 'ຄອມພິວເຕີເຄື່ອງນີ້', 'คอมพิวเตอร์เครื่องนี้', '这台电脑', 'Máy tính này'],
  'svc.restartLabel': [
    'Restart the print bridge',
    'ເປີດໂປຣແກຣມພິມຄືນໃໝ່',
    'เริ่มตัวเชื่อมเครื่องพิมพ์ใหม่',
    '重启打印桥',
    'Khởi động lại cầu nối in',
  ],
  'svc.restartNote': [
    'Printing pauses for a few seconds, then carries on.',
    'ການພິມຈະຢຸດຊົ່ວຄາວສອງສາມວິນາທີ ແລ້ວສືບຕໍ່.',
    'การพิมพ์จะหยุดชั่วครู่ แล้วทำงานต่อ',
    '打印会暂停几秒，然后继续。',
    'Việc in tạm dừng vài giây rồi tiếp tục.',
  ],
  'svc.restartBtn': ['Restart', 'ເປີດຄືນໃໝ່', 'เริ่มใหม่', '重启', 'Khởi động lại'],
  'svc.restartAsk': [
    'Restart now? Anything waiting to print will print when it is back.',
    'ເປີດຄືນໃໝ່ດຽວນີ້ບໍ? ວຽກທີ່ລໍຖ້າຢູ່ຈະພິມເມື່ອກັບມາ.',
    'เริ่มใหม่ตอนนี้ไหม งานที่รออยู่จะพิมพ์เมื่อกลับมา',
    '现在重启？排队的打印会在恢复后继续。',
    'Khởi động lại ngay? Các bản in đang chờ sẽ in khi hoạt động lại.',
  ],

  'svc.installLabel': [
    'Start automatically',
    'ເລີ່ມເອງອັດຕະໂນມັດ',
    'เริ่มอัตโนมัติ',
    '开机自动启动',
    'Tự động khởi chạy',
  ],
  'svc.installOn': [
    'It comes back on its own every time this computer starts.',
    'ມັນຈະເປີດເອງທຸກຄັ້ງທີ່ຄອມພິວເຕີເປີດ.',
    'จะเปิดเองทุกครั้งที่เปิดเครื่อง',
    '每次开机都会自动运行。',
    'Sẽ tự chạy mỗi lần máy khởi động.',
  ],
  'svc.installOff': [
    'Nothing starts it when this computer boots.',
    'ບໍ່ມີຫຍັງເປີດມັນເມື່ອຄອມພິວເຕີເປີດ.',
    'ไม่มีอะไรเปิดให้เมื่อเปิดเครื่อง',
    '开机时没有任何程序会启动它。',
    'Không có gì khởi chạy nó khi máy bật.',
  ],
  'svc.installBtn': ['Turn on', 'ເປີດໃຊ້', 'เปิดใช้', '开启', 'Bật'],
  'svc.installAsk': [
    'Let this computer start the print bridge on its own? It restarts once to hand over.',
    'ໃຫ້ຄອມພິວເຕີເປີດໂປຣແກຣມນີ້ເອງບໍ? ມັນຈະເປີດຄືນໃໝ່ໜຶ່ງຄັ້ງ.',
    'ให้เครื่องเปิดโปรแกรมนี้เองไหม จะเริ่มใหม่หนึ่งครั้ง',
    '让这台电脑自动启动打印桥？它会重启一次完成交接。',
    'Cho máy tự khởi chạy cầu nối in? Nó sẽ khởi động lại một lần.',
  ],

  'svc.removeLabel': [
    'Remove from this computer',
    'ລຶບອອກຈາກຄອມພິວເຕີນີ້',
    'ลบออกจากเครื่องนี้',
    '从这台电脑移除',
    'Gỡ khỏi máy tính này',
  ],
  'svc.removeNote': [
    'This computer stops printing. The log file is always kept.',
    'ຄອມພິວເຕີນີ້ຈະຢຸດພິມ. ໄຟລ໌ບັນທຶກຈະຖືກເກັບໄວ້ສະເໝີ.',
    'เครื่องนี้จะหยุดพิมพ์ ไฟล์บันทึกจะถูกเก็บไว้เสมอ',
    '这台电脑将停止打印。日志文件始终保留。',
    'Máy này sẽ ngừng in. Tệp nhật ký luôn được giữ lại.',
  ],
  'svc.removeBtn': ['Remove', 'ລຶບອອກ', 'ลบออก', '移除', 'Gỡ bỏ'],
  'svc.removeAsk': [
    'This computer will stop printing. Type its name to confirm:',
    'ຄອມພິວເຕີນີ້ຈະຢຸດພິມ. ພິມຊື່ຂອງມັນເພື່ອຢືນຢັນ:',
    'เครื่องนี้จะหยุดพิมพ์ พิมพ์ชื่อเครื่องเพื่อยืนยัน:',
    '这台电脑将停止打印。请输入它的名称以确认：',
    'Máy này sẽ ngừng in. Nhập tên máy để xác nhận:',
  ],
  'svc.scopeAutostart': [
    'Only stop it starting by itself',
    'ພຽງແຕ່ຢຸດການເປີດເອງ',
    'แค่หยุดการเปิดเอง',
    '仅停止自动启动',
    'Chỉ tắt tự khởi chạy',
  ],
  'svc.scopeFiles': [
    'Remove its files too',
    'ລຶບໄຟລ໌ຂອງມັນນຳ',
    'ลบไฟล์ของมันด้วย',
    '同时删除它的文件',
    'Xoá cả tệp của nó',
  ],
  'svc.scopeEverything': [
    'Remove everything, including printers and pairing',
    'ລຶບທັງໝົດ ລວມທັງເຄື່ອງພິມ ແລະ ການຈັບຄູ່',
    'ลบทั้งหมด รวมถึงเครื่องพิมพ์และการจับคู่',
    '全部删除，包括打印机和配对',
    'Xoá tất cả, kể cả máy in và ghép nối',
  ],

  'svc.rebootLabel': [
    'Restart this computer',
    'ເປີດຄອມພິວເຕີນີ້ຄືນໃໝ່',
    'รีสตาร์ตเครื่องนี้',
    '重启这台电脑',
    'Khởi động lại máy tính',
  ],
  'svc.rebootNote': [
    'Everything on this computer closes. Finish any open sale first.',
    'ທຸກຢ່າງໃນຄອມພິວເຕີນີ້ຈະປິດ. ຈົບການຂາຍທີ່ຄ້າງຢູ່ກ່ອນ.',
    'ทุกอย่างบนเครื่องนี้จะปิด ปิดการขายที่ค้างอยู่ก่อน',
    '这台电脑上的所有程序都会关闭。请先结束未完成的销售。',
    'Mọi thứ trên máy sẽ đóng. Hãy kết thúc đơn hàng đang mở trước.',
  ],
  'svc.rebootBtn': [
    'Restart computer',
    'ເປີດເຄື່ອງຄືນໃໝ່',
    'รีสตาร์ตเครื่อง',
    '重启电脑',
    'Khởi động lại máy',
  ],
  'svc.rebootAsk': [
    'Everything on this computer will close. Type its name to confirm:',
    'ທຸກຢ່າງໃນຄອມພິວເຕີນີ້ຈະປິດ. ພິມຊື່ຂອງມັນເພື່ອຢືນຢັນ:',
    'ทุกอย่างบนเครื่องนี้จะปิด พิมพ์ชื่อเครื่องเพื่อยืนยัน:',
    '这台电脑上的一切都会关闭。请输入它的名称以确认：',
    'Mọi thứ trên máy sẽ đóng. Nhập tên máy để xác nhận:',
  ],
  'svc.rebootQueue': [
    'Jobs are still waiting to print. They will print after the computer restarts.',
    'ຍັງມີວຽກລໍຖ້າພິມຢູ່. ພວກມັນຈະພິມຫຼັງຈາກເປີດເຄື່ອງຄືນໃໝ່.',
    'ยังมีงานรอพิมพ์อยู่ จะพิมพ์หลังเครื่องเริ่มใหม่',
    '仍有打印任务在排队，它们会在重启后打印。',
    'Vẫn còn bản in đang chờ. Chúng sẽ in sau khi máy khởi động lại.',
  ],

  'svc.cacheLabel': [
    'Clear stored print data',
    'ລ້າງຂໍ້ມູນການພິມທີ່ເກັບໄວ້',
    'ล้างข้อมูลการพิมพ์ที่เก็บไว้',
    '清除已保存的打印数据',
    'Xoá dữ liệu in đã lưu',
  ],
  'svc.cacheNote': [
    'Your printers and this computer’s pairing are never touched.',
    'ເຄື່ອງພິມ ແລະ ການຈັບຄູ່ຂອງຄອມພິວເຕີນີ້ຈະບໍ່ຖືກແຕະຕ້ອງ.',
    'เครื่องพิมพ์และการจับคู่ของเครื่องนี้จะไม่ถูกแตะต้อง',
    '不会影响您的打印机和这台电脑的配对。',
    'Máy in và ghép nối của máy này không bị ảnh hưởng.',
  ],
  'svc.cacheBtn': ['Choose…', 'ເລືອກ…', 'เลือก…', '选择…', 'Chọn…'],
  'svc.itemSpool': [
    'Print jobs still waiting',
    'ວຽກພິມທີ່ຍັງລໍຖ້າຢູ່',
    'งานพิมพ์ที่ยังรออยู่',
    '仍在排队的打印任务',
    'Bản in vẫn đang chờ',
  ],
  'svc.itemHistory': [
    'Recent job records',
    'ບັນທຶກວຽກຫຼ້າສຸດ',
    'บันทึกงานล่าสุด',
    '最近的任务记录',
    'Bản ghi công việc gần đây',
  ],
  'svc.itemSettled': [
    'Duplicate protection',
    'ການປ້ອງກັນການພິມຊ້ຳ',
    'การป้องกันพิมพ์ซ้ำ',
    '重复打印保护',
    'Chống in trùng',
  ],
  'svc.itemSettledWarn': [
    'Clearing this can let a repeated job print a second bill.',
    'ການລ້າງອັນນີ້ອາດເຮັດໃຫ້ວຽກທີ່ສົ່ງຊ້ຳພິມໃບບິນທີສອງ.',
    'การล้างนี้อาจทำให้งานที่ส่งซ้ำพิมพ์บิลใบที่สอง',
    '清除后，重复的任务可能会打出第二张单。',
    'Xoá mục này có thể khiến một đơn lặp in ra hoá đơn thứ hai.',
  ],
  'svc.itemLogs': ['Log files', 'ໄຟລ໌ບັນທຶກ', 'ไฟล์บันทึก', '日志文件', 'Tệp nhật ký'],
  'svc.clearBtn': ['Clear selected', 'ລ້າງທີ່ເລືອກ', 'ล้างที่เลือก', '清除所选', 'Xoá mục đã chọn'],
  'svc.cleared': ['Cleared.', 'ລ້າງແລ້ວ.', 'ล้างแล้ว', '已清除。', 'Đã xoá.'],

  'svc.cancel': ['Cancel', 'ຍົກເລີກ', 'ยกเลิก', '取消', 'Huỷ'],
  'svc.working': ['Working…', 'ກຳລັງດຳເນີນການ…', 'กำลังทำงาน…', '处理中…', 'Đang xử lý…'],
  'svc.nameWrong': [
    'That is not this computer’s name.',
    'ນັ້ນບໍ່ແມ່ນຊື່ຂອງຄອມພິວເຕີນີ້.',
    'นั่นไม่ใช่ชื่อของเครื่องนี้',
    '这不是这台电脑的名称。',
    'Đó không phải tên của máy này.',
  ],
  'svc.restartingLead': [
    'Restarting…',
    'ກຳລັງເປີດຄືນໃໝ່…',
    'กำลังเริ่มใหม่…',
    '正在重启…',
    'Đang khởi động lại…',
  ],
  'svc.restartingSub': [
    'This page updates on its own when it is back.',
    'ໜ້ານີ້ຈະອັບເດດເອງເມື່ອມັນກັບມາ.',
    'หน้านี้จะอัปเดตเองเมื่อกลับมา',
    '恢复后此页面会自动更新。',
    'Trang này sẽ tự cập nhật khi nó hoạt động lại.',
  ],
  'svc.backLead': ['It is back.', 'ມັນກັບມາແລ້ວ.', 'กลับมาแล้ว', '已恢复。', 'Đã hoạt động lại.'],
  'svc.notBackLead': [
    'It has not come back.',
    'ມັນຍັງບໍ່ກັບມາ.',
    'ยังไม่กลับมา',
    '它没有恢复。',
    'Nó chưa hoạt động lại.',
  ],
  'svc.notBackSub': [
    'The reason will be in the log file:',
    'ເຫດຜົນຈະຢູ່ໃນໄຟລ໌ບັນທຶກ:',
    'เหตุผลจะอยู่ในไฟล์บันทึก:',
    '原因会记录在日志文件中：',
    'Lý do sẽ có trong tệp nhật ký:',
  ],
  'svc.rebootingLead': [
    'This computer restarts in',
    'ຄອມພິວເຕີນີ້ຈະເປີດຄືນໃໝ່ໃນ',
    'เครื่องนี้จะรีสตาร์ตใน',
    '这台电脑将在以下时间后重启',
    'Máy tính sẽ khởi động lại sau',
  ],
  'svc.rebootStop': [
    'Stop the restart',
    'ຢຸດການເປີດຄືນໃໝ່',
    'หยุดการรีสตาร์ต',
    '停止重启',
    'Dừng khởi động lại',
  ],
  'svc.removedLead': ['Removed.', 'ລຶບອອກແລ້ວ.', 'ลบออกแล้ว', '已移除。', 'Đã gỡ bỏ.'],
  'svc.removedKept': ['Kept:', 'ເກັບໄວ້:', 'เก็บไว้:', '保留：', 'Giữ lại:'],
  'svc.removedManual': [
    'To finish, drag this to the Trash:',
    'ເພື່ອໃຫ້ຈົບ ໃຫ້ລາກອັນນີ້ໄປໃສ່ຖັງຂີ້ເຫຍື້ອ:',
    'เพื่อให้เสร็จ ลากสิ่งนี้ไปที่ถังขยะ:',
    '要完成，请将它拖到废纸篓：',
    'Để hoàn tất, kéo mục này vào Thùng rác:',
  ],

  /*
   * The facts strip. The VALUES stay as the bridge reports them — a path, a hostname, a version
   * read the same in every language and have to match what is on disk — so only the terms move.
   */
  'svc.factStartedBy': ['Started by', 'ເປີດໂດຍ', 'เปิดโดย', '由谁启动', 'Được khởi chạy bởi'],
  'svc.factBoot': ['Starts at boot', 'ເປີດເມື່ອບູດເຄື່ອງ', 'เปิดเมื่อบูตเครื่อง', '开机时启动', 'Chạy khi khởi động'],
  'svc.factFiles': ['Files', 'ໄຟລ໌', 'ไฟล์', '文件', 'Tệp'],
  'svc.factData': ['Data', 'ຂໍ້ມູນ', 'ข้อมูล', '数据', 'Dữ liệu'],
  'svc.factLog': ['Log', 'ບັນທຶກ', 'บันทึก', '日志', 'Nhật ký'],

  /* launchd, systemd and Task Scheduler are the OS's own names for itself; only the aside moves. */
  'svc.mgrLaunchdDaemon': [
    'launchd (all users)',
    'launchd (ທຸກຜູ້ໃຊ້)',
    'launchd (ทุกผู้ใช้)',
    'launchd（所有用户）',
    'launchd (mọi người dùng)',
  ],
  'svc.mgrLaunchdAgent': [
    'launchd (this login)',
    'launchd (ການເຂົ້າສູ່ລະບົບນີ້)',
    'launchd (การเข้าสู่ระบบนี้)',
    'launchd（当前登录）',
    'launchd (phiên đăng nhập này)',
  ],
  'svc.mgrScheduledTask': [
    'Task Scheduler',
    'Task Scheduler',
    'Task Scheduler',
    '任务计划程序',
    'Task Scheduler',
  ],
  'svc.mgrSystemd': ['systemd', 'systemd', 'systemd', 'systemd', 'systemd'],
  'svc.mgrContainer': ['a container', 'ຄອນເທນເນີ', 'คอนเทนเนอร์', '容器', 'một container'],
  'svc.mgrNone': [
    'nobody — started by hand',
    'ບໍ່ມີໃຜ — ເປີດດ້ວຍມື',
    'ไม่มีใคร — เปิดด้วยมือ',
    '无 — 手动启动',
    'không ai — chạy bằng tay',
  ],

  'svc.noConfirm': [
    'This bridge did not offer a confirmation.',
    'ໂປຣແກຣມພິມນີ້ບໍ່ໄດ້ໃຫ້ການຢືນຢັນ.',
    'ตัวเชื่อมนี้ไม่ได้ให้การยืนยัน',
    '此打印桥没有提供确认。',
    'Cầu nối này không đưa ra xác nhận.',
  ],
  'svc.busy': [
    'Something else is already running.',
    'ມີຢ່າງອື່ນກຳລັງແລ່ນຢູ່ແລ້ວ.',
    'มีอย่างอื่นกำลังทำงานอยู่แล้ว',
    '已经有别的操作在运行。',
    'Có việc khác đang chạy.',
  ],
  'svc.confirmExpired': [
    'That confirmation expired — press again.',
    'ການຢືນຢັນນັ້ນໝົດອາຍຸ — ກົດອີກຄັ້ງ.',
    'การยืนยันนั้นหมดอายุ — กดอีกครั้ง',
    '该确认已过期 — 请再按一次。',
    'Xác nhận đó đã hết hạn — hãy bấm lại.',
  ],
  'svc.didNotWork': ['It did not work.', 'ມັນບໍ່ສຳເລັດ.', 'ไม่สำเร็จ', '没有成功。', 'Không thành công.'],

  /*
   * Why a button is not offered. The bridge sends a machine `reason` next to an English `hint`;
   * these are the reason in words, and for the five reasons whose hint is a COMMAND the hint is
   * still shown underneath, because a command is not a thing to translate.
   */
  'svc.capContainer': [
    'This bridge runs in a container. Restart the container instead.',
    'ໂປຣແກຣມພິມນີ້ແລ່ນຢູ່ໃນຄອນເທນເນີ. ໃຫ້ເປີດຄອນເທນເນີຄືນໃໝ່ແທນ.',
    'ตัวเชื่อมนี้ทำงานในคอนเทนเนอร์ ให้เริ่มคอนเทนเนอร์ใหม่แทน',
    '此打印桥运行在容器中。请改为重启该容器。',
    'Cầu nối này chạy trong container. Hãy khởi động lại container thay vì cái này.',
  ],
  'svc.capNotSupervised': [
    'Nothing is supervising this bridge. Stop it and start it again the way you started it.',
    'ບໍ່ມີຫຍັງຄວບຄຸມໂປຣແກຣມພິມນີ້. ໃຫ້ຢຸດ ແລ້ວເປີດມັນຄືນໃໝ່ດ້ວຍວິທີທີ່ທ່ານເປີດມັນ.',
    'ไม่มีอะไรควบคุมตัวเชื่อมนี้ ให้หยุดแล้วเปิดใหม่ด้วยวิธีที่คุณเปิดมัน',
    '没有任何服务在管理此打印桥。请按你启动它的方式停止后再启动。',
    'Không có gì giám sát cầu nối này. Hãy dừng rồi chạy lại theo cách bạn đã khởi chạy nó.',
  ],
  'svc.capAlreadyRegistered': [
    'It is already set to start on its own.',
    'ມັນຖືກຕັ້ງໃຫ້ເປີດເອງຢູ່ແລ້ວ.',
    'ตั้งให้เปิดเองอยู่แล้ว',
    '它已经设置为自动启动。',
    'Nó đã được đặt tự khởi chạy.',
  ],
  'svc.capNotPackaged': [
    'This is a development build. Install a released bridge to register it as a service.',
    'ນີ້ແມ່ນລຸ້ນສຳລັບພັດທະນາ. ໃຫ້ຕິດຕັ້ງລຸ້ນທີ່ອອກແລ້ວເພື່ອລົງທະບຽນເປັນບໍລິການ.',
    'นี่เป็นรุ่นสำหรับพัฒนา ให้ติดตั้งรุ่นที่ปล่อยแล้วเพื่อลงทะเบียนเป็นบริการ',
    '这是开发版本。请安装正式发布的打印桥才能注册为服务。',
    'Đây là bản dựng phát triển. Hãy cài bản phát hành để đăng ký nó thành dịch vụ.',
  ],
  'svc.capRunningFromVolume': [
    'Drag Hankha Print Bridge to your Applications folder and open it from there.',
    'ໃຫ້ລາກ Hankha Print Bridge ໄປໄວ້ໃນໂຟນເດີ Applications ແລ້ວເປີດຈາກບ່ອນນັ້ນ.',
    'ลาก Hankha Print Bridge ไปไว้ในโฟลเดอร์ Applications แล้วเปิดจากที่นั่น',
    '请把 Hankha Print Bridge 拖到应用程序文件夹，再从那里打开。',
    'Hãy kéo Hankha Print Bridge vào thư mục Applications rồi mở từ đó.',
  ],
  'svc.capNotInstalled': [
    'Nothing is installed on this computer to remove.',
    'ບໍ່ມີສິ່ງໃດຕິດຕັ້ງຢູ່ໃນຄອມພິວເຕີນີ້ໃຫ້ລຶບ.',
    'ไม่มีอะไรติดตั้งอยู่บนเครื่องนี้ให้ลบ',
    '这台电脑上没有安装任何东西可移除。',
    'Không có gì được cài trên máy này để gỡ.',
  ],
  'svc.capNeedsRoot': [
    'This needs root. Run this instead:',
    'ອັນນີ້ຕ້ອງໃຊ້ສິດ root. ໃຫ້ແລ່ນອັນນີ້ແທນ:',
    'ต้องใช้สิทธิ์ root ให้รันคำสั่งนี้แทน:',
    '这需要 root 权限。请改为运行：',
    'Việc này cần quyền root. Hãy chạy lệnh sau:',
  ],
  'svc.capNeedsElevation': [
    'This needs an administrator. Use this instead:',
    'ອັນນີ້ຕ້ອງໃຊ້ສິດຜູ້ດູແລລະບົບ. ໃຫ້ໃຊ້ອັນນີ້ແທນ:',
    'ต้องใช้สิทธิ์ผู้ดูแลระบบ ให้ใช้สิ่งนี้แทน:',
    '这需要管理员权限。请改用：',
    'Việc này cần quyền quản trị. Hãy dùng cách sau:',
  ],
  'svc.capInstallerMissing': [
    'The installer script is not next to this program. Run it from the unpacked folder:',
    'ສະຄຣິບຕິດຕັ້ງບໍ່ຢູ່ຂ້າງໂປຣແກຣມນີ້. ໃຫ້ແລ່ນມັນຈາກໂຟນເດີທີ່ແຕກໄຟລ໌ໄວ້:',
    'สคริปต์ติดตั้งไม่ได้อยู่ข้างโปรแกรมนี้ ให้รันจากโฟลเดอร์ที่แตกไฟล์ไว้:',
    '安装脚本不在本程序旁边。请从解压后的文件夹中运行：',
    'Tập lệnh cài đặt không nằm cạnh chương trình này. Hãy chạy nó từ thư mục đã giải nén:',
  ],
  'svc.capUnsupportedPlatform': [
    'This system has no installer. Register it by hand:',
    'ລະບົບນີ້ບໍ່ມີຕົວຕິດຕັ້ງ. ໃຫ້ລົງທະບຽນດ້ວຍມື:',
    'ระบบนี้ไม่มีตัวติดตั้ง ให้ลงทะเบียนด้วยมือ:',
    '此系统没有安装程序。请手动注册：',
    'Hệ thống này không có trình cài đặt. Hãy đăng ký thủ công:',
  ],
  'svc.capNoSession': [
    'This has to be run from a desktop session. Run this instead:',
    'ອັນນີ້ຕ້ອງແລ່ນຈາກເຊດຊັນເດັສທັອບ. ໃຫ້ແລ່ນອັນນີ້ແທນ:',
    'ต้องรันจากเซสชันเดสก์ท็อป ให้รันคำสั่งนี้แทน:',
    '这需要在桌面会话中运行。请改为运行：',
    'Việc này cần chạy từ phiên làm việc trên máy. Hãy chạy lệnh sau:',
  ],
};

/**
 * Serialise a table into the page script.
 *
 * The script is one big template literal inside an inline `<script>`, so three sequences have to
 * be neutralised or they escape the thing they are written into: a backtick ends the literal —
 * the mistake this app has made four times, and the reason `page-source.test.ts` exists — `${`
 * opens an interpolation, and `</` can close the element early. Each is rewritten as the `\u`
 * escape JSON already understands, so it parses back to exactly the same character.
 */
function embed(value: unknown): string {
  return JSON.stringify(value)
    .split('`')
    .join('\\u0060')
    .split('${')
    .join('$\\u007b')
    .split('</')
    .join('<\\/');
}

/** The header's language picker. The pairing screen's own row is styled in `page.ts`. */
export const I18N_CSS = `
/* -------------------------------------------------------------- language picker */
.lang {
  font: 500 13px var(--sans);
  padding: 7px 9px; border-radius: 8px; cursor: pointer;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border-strong);
  max-width: 150px;
}
`;

/*
 * Spliced in at the TOP of the page's IIFE, so the table exists before any other statement runs.
 * Everything it calls back into — $, h, clear, psRender, svcRender, refresh, lastRendered — is a
 * hoisted declaration further down that same function, and is only ever reached from an event
 * handler or from the boot sequence at the very bottom.
 */
export const I18N_SCRIPT = `
  /* ================================================================== languages */

  var PS_LANGS = ${embed(PAGE_LANGS)};
  var PS_LANG_NAMES = ${embed(PAGE_LANG_NAMES)};
  var PS_LOCALE_TAGS = ${embed(PAGE_LOCALE_TAGS)};
  /* Frozen: the pairing screen has stored a choice under this key since it shipped. */
  var PS_LANG_KEY = 'hankha-bridge-lang';
  var T = ${embed(PAGE_STRINGS)};

  var psLang = 'en';

  /* Which column of the table to read. Every row is [en, lo, th, zh, vi], in that order. */
  function psIndex() {
    var at = PS_LANGS.indexOf(psLang);
    return at < 0 ? 0 : at;
  }

  /*
   * Falls back to English rather than rendering undefined, exactly as i18next does in the POS.
   * Placeholders are named, not positional, because the count leads the sentence in English and
   * trails it in Lao.
   */
  function t(key, vars) {
    var row = T[key];
    if (!row) return '';
    var text = row[psIndex()] || row[0];
    if (!vars) return text;
    for (var name in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      }
    }
    return text;
  }

  /* For keys that may legitimately be absent — a code from the bridge we have no wording for. */
  function tOr(key, fallback) {
    return Object.prototype.hasOwnProperty.call(T, key) ? t(key) : fallback;
  }

  /*
   * A machine word from the bridge, in words: 'connect-refused' -> reasonConnectRefused.
   *
   * The wire keeps the code — server.ts puts it on the wire and the POS shows it verbatim — and
   * only what is read on this page is turned into a sentence. An unknown code returns '' so the
   * caller can fall back to printing the code itself, which is what a bridge newer than this
   * page will send.
   */
  function tCode(prefix, code) {
    if (!code) return '';
    var parts = String(code).split('-');
    var key = prefix;
    for (var i = 0; i < parts.length; i++) {
      key += parts[i].charAt(0).toUpperCase() + parts[i].slice(1);
    }
    return tOr(key, '');
  }

  /* For the one thing on this page the browser formats rather than us: the clock on a job. */
  function psLocale() { return PS_LOCALE_TAGS[psLang] || 'en-US'; }

  function psText(key) { return t('ps.' + key); }
  function svcText(key) { return t('svc.' + key); }

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

  /*
   * Everything baked into the markup, rewritten in one pass.
   *
   * Elements carry data-t (their own text) or data-t-label (an aria-label); nothing else in the
   * document holds a translatable string. A section that has already been rendered has had its
   * data-t nodes replaced by built ones, so this pass simply does not find them — which is why
   * it is safe to call on every language change and not only at boot.
   */
  function applyChrome() {
    document.documentElement.lang = psLang;

    var text = document.querySelectorAll('[data-t]');
    for (var i = 0; i < text.length; i++) {
      text[i].textContent = t(text[i].getAttribute('data-t'));
    }
    var labelled = document.querySelectorAll('[data-t-label]');
    for (var j = 0; j < labelled.length; j++) {
      labelled[j].setAttribute('aria-label', t(labelled[j].getAttribute('data-t-label')));
    }

    /* The one sentence with a filename inside it: the words move around it, it does not move. */
    var foot = $('foot-one');
    if (foot) {
      clear(foot);
      var parts = t('footOne').split('{file}');
      foot.appendChild(document.createTextNode(parts[0]));
      foot.appendChild(h('code', null, 'printers.json'));
      if (parts.length > 1) foot.appendChild(document.createTextNode(parts[1]));
    }
  }

  function langButton(code) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = PS_LANG_NAMES[code];
    button.setAttribute('aria-pressed', String(code === psLang));
    button.addEventListener('click', function () { switchLang(code); });
    return button;
  }

  /*
   * Two pickers, one choice: a row of names on the pairing screen, where there is room for it and
   * nothing else to look at, and a select in the header for the diagnostics behind it. Both are
   * rebuilt together so neither can show a language the page is not in.
   */
  function buildLangs() {
    var row = $('ps-langs');
    if (row) {
      clear(row);
      for (var i = 0; i < PS_LANGS.length; i++) row.appendChild(langButton(PS_LANGS[i]));
    }

    var select = $('lang');
    if (!select) return;
    if (!select.options.length) {
      for (var j = 0; j < PS_LANGS.length; j++) {
        var option = document.createElement('option');
        option.value = PS_LANGS[j];
        option.textContent = PS_LANG_NAMES[PS_LANGS[j]];
        select.appendChild(option);
      }
      select.addEventListener('change', function () { switchLang(select.value); });
    }
    select.value = psLang;
  }

  function switchLang(code) {
    if (PS_LANGS.indexOf(code) === -1 || code === psLang) return;
    psLang = code;
    psWriteLang(code);
    buildLangs();
    applyChrome();
    /*
     * Every section caches a signature of what it last drew and redraws only when that changes.
     * None of those signatures contains the language, so without this the tables, banners and
     * job rows keep the old words until their DATA happens to move — which on a healthy bridge
     * with a settled screen is never.
     */
    lastRendered = {};
    lastAnnounced = '';
    psRender();
    svcRender();
    refresh(false);
  }
`;
