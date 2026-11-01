// lib/hilog.js —— 纯函数层：hilog 命令拼装 / 输出解析 / 截断 / 时间戳。
//
// 设计纪律（见 开发需求文档.md §5）：
//   · 这一层**不碰任何 Node / DSH API**（没有 fs / 没有 ctx）⇒ 单测无需设备、无需宿主。
//   · 命令一律"命令与参数分离"构造：每个参数先经过 POSIX 单引号转义（quoteArg），
//     绝不把用户输入直接拼进命令行（设备路径/tag/正则都可能含空格、引号、中文）。
//   · hilog 行格式以真机样本为准（开发需求文档.md 附录 C），不靠猜。
//
// 真机实测要点（2026-10-15，PLR-AL50 与本机 PC，API 26）：
//   · 普通行：`MM-DD HH:MM:SS.mmm  pid  tid  L  domain/pkg/tag: msg`（pid 后还有 tid 两列）
//   · `-v long`：`[ MM-DD HH:MM:SS.mmm  pid  tid  L  domain  tag ]` 换行后跟正文（可多行）
//   · `-L` 只接受**单个**级别，多级别必须逗号分隔（`-L D,I,W`）；`^D` 取反会被拒
//     （`Invalid log level ... [CODE: -2]`）——设备 `-h` 里的"可组合/可取反"说明与实际不符
//   · `-L I` 是**精确匹配** I，不是"I 及以上"⇒ "I 及以上"要展开成 `-L I,W,E,F`
//   · `-x` 不能与 `-a`/`-z` 同用（`Mutlti commands can't be used in combination [CODE: -31]`）

/** hilog 级别，从最啰嗦到最严重。 */
export const LEVELS = ['D', 'I', 'W', 'E', 'F'];

/** 级别别名（长名/常见写法 → 短名）。 */
const LEVEL_ALIASES = {
  D: 'D', DEBUG: 'D',
  I: 'I', INFO: 'I',
  W: 'W', WARN: 'W', WARNING: 'W',
  E: 'E', ERROR: 'E',
  F: 'F', FATAL: 'F',
};

/** 走 via-host 通道时，hdc-tcp-shim 会往输出流里插的噪声行前缀（必须过滤）。 */
export const NOISE_PREFIXES = [
  '[hdc-tcp-shim]',
  '[hdcb]',
  '[hdc-via-host]',
  '[keepalive]',
  '[bridge]',
];

/** 把值规整成数组（null/undefined → []）。 */
export function toArray(value) {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined && v !== '') : [value];
}

/**
 * 归一化一个级别字符串。
 * @returns 大写的短级别（D/I/W/E/F）；无法识别时返回 null。
 */
export function normalizeLevel(input) {
  if (input === null || input === undefined) return null;
  const key = String(input).trim().toUpperCase().replace(/^LEVEL_/, '');
  return LEVEL_ALIASES[key] || null;
}

/**
 * 把"最低级别"展开成 `-L` 需要的**精确级别集合**。
 *
 * 为什么必须展开：真机实测 `-L I` 只输出 I，不含 W/E/F（设备 `-h` 说的"可组合"其实要求
 * 逗号分隔），所以"INFO 及以上"在设备侧只能写成 `-L I,W,E,F`。
 * @param min 最低级别（D/I/W/E/F）
 * @returns 级别数组（含 min 及其后所有更严重的级别）
 */
export function levelsFrom(min) {
  const lv = normalizeLevel(min);
  if (!lv) return null;
  return LEVELS.slice(LEVELS.indexOf(lv));
}

/** 单个 hilog 级别的严重度序号（D=0 … F=4）；无法识别返回 -1。 */
export function levelRank(input) {
  const lv = normalizeLevel(input);
  return lv ? LEVELS.indexOf(lv) : -1;
}

/** 级别集合 → `-L` 的参数值（逗号分隔；设备只认这一种多级别写法）。 */
export function levelFilterValue(levels) {
  const list = toArray(levels).map(normalizeLevel).filter(Boolean);
  return list.length ? list.join(',') : null;
}

/**
 * POSIX 单引号转义：把任意字符串变成一个**单个 argv**。
 *
 * 双层引用的关键：ctx.shell 只收一整条命令行（bash -c），hdc 又要把它收到的字符串交给
 * 设备侧 shell ⇒ 内层参数在这里转义一次，外层拼装时再转义一次。
 */
export function quoteArg(value) {
  const s = String(value);
  if (s === '') return "''";
  // 安全字符集内不加引号，命令更好读（也更好排障）
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.split("'").join("'\\''")}'`;
}

/** 用空格把已转义的参数拼成一条命令行。 */
export function joinCommand(parts) {
  return parts.filter((p) => p !== null && p !== undefined && p !== '').join(' ');
}

/**
 * 构造设备侧 hilog 命令（**不含** `hdc shell` 外壳）。
 *
 * @param opts.mode       'dump'（非阻塞 -x）| 'capture'（阻塞流式）| 'setLevel' | 'getLevel' | 'raw'
 * @param opts.tags       tag 列表（≤10）
 * @param opts.levels     级别集合（精确集合，见 levelsFrom）
 * @param opts.pids       pid 列表（≤5）
 * @param opts.domains    domain 列表（≤5）
 * @param opts.regex      内容正则
 * @param opts.format     'normal' | 'long'
 * @param opts.timeoutSec capture：设备侧 `timeout` 秒数（防本地进程被杀后设备侧留孤儿）
 * @returns {command, warnings}
 */
export function buildHilogCommand(opts = {}) {
  const warnings = [];
  const tags = toArray(opts.tags).map(String);
  const pids = toArray(opts.pids).map(String);
  const domains = toArray(opts.domains).map(String);
  if (tags.length > 10) throw new Error(`tag 最多 10 个（本次 ${tags.length} 个）`);
  if (pids.length > 5) throw new Error(`pid 最多 5 个（本次 ${pids.length} 个）`);
  if (domains.length > 5) throw new Error(`domain 最多 5 个（本次 ${domains.length} 个）`);

  if (opts.mode === 'setLevel') {
    const lv = normalizeLevel(opts.level);
    if (!lv) throw new Error(`无法识别的级别：${opts.level}`);
    return { command: joinCommand(['hilog', '-b', quoteArg(lv)]), warnings };
  }
  if (opts.mode === 'getLevel') {
    return { command: joinCommand(['param', 'get', quoteArg('hilog.loggable.global')]), warnings };
  }
  if (opts.mode === 'raw') return { command: String(opts.command || ''), warnings };

  const parts = [];
  if (opts.mode === 'capture') {
    const sec = Number(opts.timeoutSec);
    if (!Number.isFinite(sec) || sec <= 0) throw new Error('capture 需要正的 timeoutSec');
    // 设备侧自超时：本地进程被取消/异常时，设备上不留孤儿 hilog
    parts.push('timeout', String(Math.ceil(sec)));
    parts.push('hilog');
  } else {
    // -x：非阻塞读完缓冲区即退出。实测不能与 -a/-z 同用，所以行数一律在客户端截断。
    parts.push('hilog', '-x');
  }
  if (tags.length) parts.push('-T', quoteArg(tags.join(',')));
  const lv = levelFilterValue(opts.levels);
  if (lv) parts.push('-L', quoteArg(lv));
  if (pids.length) parts.push('-P', quoteArg(pids.join(',')));
  if (domains.length) parts.push('-D', quoteArg(domains.join(',')));
  if (opts.regex) parts.push('-e', quoteArg(String(opts.regex)));
  if (opts.format === 'long') parts.push('-v', quoteArg('long'));
  return { command: joinCommand(parts), warnings };
}

/**
 * 构造完整的一条本地命令行：`<hdcCmd> -t <target> shell '<设备侧命令>'`。
 *
 * ⚠️ 不带 `-t` 的 `hdc shell` 会打到错误目标（实测报 `errNum is:1002`）⇒ target 必填。
 */
export function buildHdcShellCommand(hdcCmd, target, deviceCommand) {
  return joinCommand([String(hdcCmd), '-t', quoteArg(target), 'shell', quoteArg(deviceCommand)]);
}

/** 构造 `list targets -v` 命令行。 */
export function buildListTargetsCommand(hdcCmd) {
  return joinCommand([String(hdcCmd), 'list', 'targets', '-v']);
}

/**
 * 是否是 hdc/hilog 自己的提示行（不是设备日志）。
 *
 * 这些行若被当成"多行消息的续行"会污染上一条日志的正文（真机上 hdc 报错就长这样），
 * 所以单独收进 `unparsed` 供排障，不并入 entries。
 */
export function isNoticeLine(line) {
  const s = String(line).trim();
  return /^\[(Fail|Empty|Info|Warn|Warning|Error|ERROR|stderr|hdc)/.test(s);
}

/** 是否是 shim/桥的噪声行。 */
export function isNoiseLine(line) {
  const s = String(line).trim();
  if (NOISE_PREFIXES.some((p) => s.startsWith(p))) return true;
  return false;
}

/**
 * 丢掉文本里的 shim/桥噪声行（stderr 也要过滤）。
 *
 * 真机实测：走 via-host 时 `[hdc-tcp-shim] UDS … -> TCP 127.0.0.1:18710 (fd N)` 是打在
 * **stderr** 上的 ⇒ 不过滤就会被当成"hdc 报错"，让一次成功的抓取被标成失败。
 */
export function filterNoiseLines(text) {
  return splitLines(text).filter((l) => l.trim() !== '' && !isNoiseLine(l)).join('\n');
}

/** 按行切分（统一处理 CRLF，丢掉末尾空行）。 */
export function splitLines(text) {
  return String(text === null || text === undefined ? '' : text)
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * 拆开流式读取的 delta 里的 stderr 段。
 *
 * `ctx.shell` 的 `readOutput()` 会把 stderr 混进同一个 delta（形如 `...\n[stderr]\n...`，
 * 见 @deepseek-ai/dsh-bash-local 的实现）⇒ 不拆开会把 hdc 的错误当成日志行解析。
 */
export function splitStreamDelta(delta) {
  const text = String(delta || '');
  const marker = '\n[stderr]\n';
  const at = text.indexOf(marker);
  if (at >= 0) return { out: text.slice(0, at), err: text.slice(at + marker.length) };
  if (text.startsWith('[stderr]\n')) return { out: '', err: text.slice('[stderr]\n'.length) };
  return { out: text, err: '' };
}

/**
 * 解析 `hdc list targets -v` 的输出。
 *
 * 真机样本（会有多条 Offline 残留，只挑 Connected）：
 *   `127.0.0.1:45071\t\tTCP\tConnected\tlocalhost`
 *   `5BH0225304025535\tUSB\tConnected\tlocalhost`
 * @returns {{targets: Array<{key,transport,state,note,raw}>, noise: string[], empty: boolean}}
 */
export function parseTargets(text) {
  const targets = [];
  const noise = [];
  let empty = false;
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    if (!line) continue;
    if (isNoiseLine(line)) { noise.push(line); continue; }
    if (/^\[empty\]$/i.test(line)) { empty = true; continue; }
    const cols = line.split(/\s+/);
    if (cols.length === 1 && /^\[.*\]$/.test(cols[0])) { noise.push(line); continue; }
    targets.push({
      key: cols[0],
      transport: cols[1] || '',
      state: cols[2] || '',
      note: cols.slice(3).join(' ') || '',
      raw: line,
    });
  }
  return { targets, noise, empty };
}

/** 只要 Connected 的目标。 */
export function connectedTargets(targets) {
  return toArray(targets).filter((t) => /^connected$/i.test(String(t.state || '').trim()));
}

/**
 * 在目标列表里挑一个目标。
 * @param want 调用方显式指定的 device key（可省略）
 * @returns {{target, reason}} —— 挑不出来时 target 为 null，reason 说明原因
 */
export function pickTarget(targets, want) {
  const list = toArray(targets);
  const connected = connectedTargets(list);
  const key = want === null || want === undefined ? '' : String(want).trim();
  if (key) {
    const hit = list.find((t) => t.key === key);
    if (!hit) return { target: null, reason: `该通道里没有目标 "${key}"` };
    if (!/^connected$/i.test(String(hit.state || '').trim())) {
      return { target: null, reason: `目标 "${key}" 当前状态是 ${hit.state || '未知'}（只有 Connected 能用）` };
    }
    return { target: hit, reason: '' };
  }
  if (connected.length === 1) return { target: connected[0], reason: '' };
  if (connected.length === 0) return { target: null, reason: '没有 Connected 目标' };
  return {
    target: null,
    reason: `有 ${connected.length} 个 Connected 目标（${connected.map((t) => t.key).join(', ')}），请用 device 参数指定`,
  };
}

// 普通行有两种切法：
//   ① 字段到第一个「冒号+空白」为止（首选）—— 因为真机里 **pkg 段本身可能含冒号**
//      （实测 ArkWeb：`A04511/com.dshm.dshclient:gpu/chromium: [../../arkweb/...]`，
//        long 格式同一条显示为 `A04511 com.dshm.dshclient:gpu chromium`）。
//   ② 退路：字段不含空白/冒号，冒号后可直接跟正文（老口径，兼容 `TAG:msg`）。
const NORMAL_LINE_RE = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3,9})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(\S.*?):\s([\s\S]*)$/;
const NORMAL_LINE_RE_TIGHT = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3,9})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([^\s:]+):\s?([\s\S]*)$/;
const LONG_HEADER_RE = /^\[\s+(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3,9})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(\S+)\s*(.*?)\s*\]$/;

/** `domain/pkg/tag` 三段 → 结构化字段（`/` 数量不定，别假定只有三段）。 */
export function splitTagField(field) {
  const parts = String(field || '').split('/').filter((p) => p !== '');
  if (parts.length === 0) return { domain: '', pkg: '', tag: '' };
  if (parts.length === 1) return { domain: parts[0], pkg: '', tag: '' };
  if (parts.length === 2) return { domain: parts[0], pkg: '', tag: parts[1] };
  return { domain: parts[0], pkg: parts.slice(1, -1).join('/'), tag: parts[parts.length - 1] };
}

/**
 * `MM-DD HH:MM:SS.mmm` → epoch ms（补当前年份；跨年时按 ±180 天就近修正）。
 * 设备与宿主同机同区（本机 PC 场景）⇒ 本地时间直接可比。
 */
export function entryTimeMs(mmdd, hhmmss, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const md = String(mmdd).split('-');
  const hms = String(hhmmss).split(':');
  const month = Number(md[0]);
  const day = Number(md[1]);
  const hour = Number(hms[0]);
  const minute = Number(hms[1]);
  const second = Number(hms[2]);
  if (![month, day, hour, minute, second].every((n) => Number.isFinite(n))) return null;
  const d = new Date(now);
  const build = (year) => new Date(year, month - 1, day, hour, minute, Math.floor(second), Math.round((second % 1) * 1000)).getTime();
  let ms = build(d.getFullYear());
  const HALF_YEAR = 180 * 86400 * 1000;
  if (ms - now > HALF_YEAR) ms = build(d.getFullYear() - 1);
  else if (now - ms > HALF_YEAR) ms = build(d.getFullYear() + 1);
  return ms;
}

/**
 * 解析 hilog 输出文本。
 *
 * @param text   原始输出（可含多行消息、shim 噪声行）
 * @param opts.format 'normal'（默认）| 'long'；'auto' 时自动判断
 * @param opts.nowMs  用于时间戳补年份（可注入，便于单测）
 * @returns {{entries, unparsed, noise, cleaned, stats}}
 */
export function parseEntries(text, opts = {}) {
  const format = opts.format || 'normal';
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const entries = [];
  const unparsed = [];
  const noise = [];
  const cleaned = [];
  let continuationLines = 0;
  let sawLongHeader = false;

  const pushEntry = (e) => { entries.push(e); };

  const lines = splitLines(text);
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    if (isNoiseLine(raw)) { noise.push(raw); continue; }
    cleaned.push(raw);

    const isLongMode = format === 'long' || (format === 'auto' && sawLongHeader);
    if (isLongMode) {
      const h = LONG_HEADER_RE.exec(raw);
      if (h) {
        sawLongHeader = true;
        // 真机 long 格式在 domain 之后还有 0~2 段（实测 `I00000 HiLog` 与
        // `I02C01 hmos_cust_carrier_mount CustCarrierMount`）⇒ 末段是 tag，前面的是 pkg
        const rest = String(h[7] || '').trim().split(/\s+/).filter(Boolean);
        pushEntry({
          time: `${h[1]} ${h[2]}`,
          tsMs: entryTimeMs(h[1], h[2], nowMs),
          level: h[5],
          pid: Number(h[3]),
          tid: Number(h[4]),
          domain: h[6],
          pkg: rest.length >= 2 ? rest.slice(0, -1).join(' ') : '',
          tag: rest.length ? rest[rest.length - 1] : '',
          msg: '',
          lines: [],
          raw,
        });
        continue;
      }
      // long 格式下，header 之后的任意行都是正文（可多行）
      if (entries.length > 0) {
        entries[entries.length - 1].lines.push(raw);
        continuationLines += 1;
        continue;
      }
      // header 之前的零星文本 → 落到下面按普通行处理（多半进 unparsed）
    }

    const m = NORMAL_LINE_RE.exec(raw) || NORMAL_LINE_RE_TIGHT.exec(raw);
    if (m) {
      const tf = splitTagField(m[6]);
      pushEntry({
        time: `${m[1]} ${m[2]}`,
        tsMs: entryTimeMs(m[1], m[2], nowMs),
        level: m[5],
        pid: Number(m[3]),
        tid: Number(m[4]),
        domain: tf.domain,
        pkg: tf.pkg,
        tag: tf.tag,
        msg: m[7],
        lines: [],
        raw,
      });
      continue;
    }

    // 未匹配：hdc/hilog 自己的提示行单独收集（别污染上一条日志的正文）
    if (isNoticeLine(raw)) {
      unparsed.push(raw);
      continue;
    }
    // 其余未匹配行：可能是多行消息的续行（无前缀）
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      last.lines.push(raw);
      continuationLines += 1;
    } else {
      unparsed.push(raw);
    }
  }

  // 多行消息合并回 msg（保留 raw 供 file/渲染用）
  for (const e of entries) {
    if (e.lines.length) e.msg = e.msg ? [e.msg, ...e.lines].join('\n') : e.lines.join('\n');
    delete e.lines;
  }

  return {
    entries,
    unparsed,
    noise,
    cleaned,
    stats: { lines: cleaned.length, continuationLines, entries: entries.length },
  };
}

/**
 * 截断条目列表。
 *
 * @param entries 全部条目（时间序）
 * @param opts.lines    最多保留多少条（0/负 → 不限）
 * @param opts.maxBytes 最多多少字节（按渲染后的 raw 计；0/负 → 不限）
 * @param opts.order    'tail'（默认，保留最近 N 条）| 'head'
 * @returns {{kept, dropped, truncated, clampedByBytes, bytes}}
 */
export function truncateEntries(entries, opts = {}) {
  const all = toArray(entries);
  const limit = Number(opts.lines) > 0 ? Math.floor(Number(opts.lines)) : 0;
  const maxBytes = Number(opts.maxBytes) > 0 ? Math.floor(Number(opts.maxBytes)) : 0;
  const order = opts.order === 'head' ? 'head' : 'tail';

  let kept = all;
  let dropped = 0;
  if (limit > 0 && all.length > limit) {
    kept = order === 'head' ? all.slice(0, limit) : all.slice(all.length - limit);
    dropped = all.length - kept.length;
  }

  let clampedByBytes = false;
  if (maxBytes > 0) {
    const size = (e) => Buffer.byteLength(formatEntry(e), 'utf8') + 1;
    let total = kept.reduce((n, e) => n + size(e), 0);
    if (total > maxBytes) {
      clampedByBytes = true;
      // tail：从最旧的开始丢；head：从最新的开始丢
      const out = kept.slice();
      while (out.length > 0 && total > maxBytes) {
        const victim = order === 'head' ? out.pop() : out.shift();
        total -= size(victim);
        dropped += 1;
      }
      kept = out;
    }
  }

  const bytes = kept.reduce((n, e) => n + Buffer.byteLength(formatEntry(e), 'utf8') + 1, 0);
  return { kept, dropped, truncated: dropped > 0, clampedByBytes, bytes };
}

/** 条目 → 单行文本（原始行优先，保证逐字还原设备输出）。 */
export function formatEntry(e) {
  if (!e) return '';
  if (e.raw) return e.raw;
  const tagField = [e.domain, e.pkg, e.tag].filter(Boolean).join('/');
  const head = `${e.time} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${e.level} ${tagField}`;
  return `${head}: ${String(e.msg || '').replace(/\n/g, '\\n')}`;
}

/** 条目 → 结构化视图（工具返回值用；不含 raw，避免体积翻倍）。 */
export function entryView(e) {
  return {
    time: e.time,
    level: e.level,
    pid: e.pid,
    tid: e.tid,
    domain: e.domain,
    ...(e.pkg ? { pkg: e.pkg } : {}),
    tag: e.tag,
    msg: e.msg,
  };
}

/** 从 `param get hilog.loggable.global` 的输出里取级别（真机输出形如 `W `，带尾空格）。 */
export function parseGlobalLevel(stdout) {
  const s = String(stdout === null || stdout === undefined ? '' : stdout).trim();
  if (!s) return null;
  const first = s.split(/\s+/)[0].toUpperCase();
  return normalizeLevel(first) || (first === 'X' ? 'X' : null);
}
