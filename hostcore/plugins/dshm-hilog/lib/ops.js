// lib/ops.js —— 三个工具的业务逻辑（hilog_level / hilog_dump / hilog_capture）。
//
// 本层只依赖注入进来的能力（exec / execStream / fs / 时钟 / 日志），因此：
//   · 单测里用假执行器就能覆盖"级别还原""截断""空结果提示"等全部关键路径（无需设备）；
//   · 真机上由 lib/index.js 把 ctx.shell 接缝塞进来（**绝不**用 node:child_process）。
//
// 三条硬纪律（开发需求文档.md §5）：
//   1. 级别改动一律 try/finally 还原（读到旧值 → 设新值 → 干活 → 还原）；
//   2. capture 用常驻子进程**流式**读取（读完即处理，天然不怕 512KB 滚动），
//      不用 `hilog > file &` + `timeout` 那套 shell 权宜写法；
//   3. 输出默认截断 + 落盘，绝不把整个缓冲区灌进对话。

import {
  buildHilogCommand, entryTimeMs, entryView, filterNoiseLines, levelsFrom, normalizeLevel, parseEntries,
  parseGlobalLevel, splitStreamDelta, toArray, truncateEntries,
} from './hilog.js';
import { runOnce, runStream, resolveTarget, channelLabel, HOST_KEEPALIVE } from './hdc.js';

/** 归一化配置：schema 默认值在这里有第二份（单测/无 schemastery 场景也能跑）。 */
export function normalizeConfig(raw = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    hdcCmd: String(raw.hdcCmd || 'hdc'),
    hdcCmdViaHost: String(raw.hdcCmdViaHost || ''),
    channel: String(raw.channel || 'auto'),
    device: String(raw.device || ''),
    level: normalizeLevel(raw.level) || 'I',
    seconds: num(raw.seconds, 15),
    maxSeconds: num(raw.maxSeconds, 120),
    maxLines: Math.floor(num(raw.maxLines, 200)),
    maxBytes: Math.floor(num(raw.maxBytes, 32768)),
    maxCaptureLines: Math.floor(num(raw.maxCaptureLines, 2000)),
    pollMs: Math.floor(num(raw.pollMs, 200)),
    timeoutMs: Math.floor(num(raw.timeoutMs, 30000)),
    listTimeoutMs: Math.floor(num(raw.listTimeoutMs, 45000)),
    stdoutMaxBytes: Math.floor(num(raw.stdoutMaxBytes, 8 << 20)),
    outputDir: String(raw.outputDir || ''),
    dumpSave: raw.dumpSave === true,
    captureSave: raw.captureSave !== false,
    restoreLevel: raw.restoreLevel !== false,
    sinceNow: raw.sinceNow !== false,
    sinceSkewMs: Math.floor(num(raw.sinceSkewMs, 1500)),
    clockSkewToleranceMs: Math.floor(num(raw.clockSkewToleranceMs, 60000)),
    sandboxMode: String(raw.sandboxMode || 'danger-full-access'),
    maxTagCount: 10,
    maxPidCount: 5,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 设备解析（三个工具共用）。 */
export async function pickDevice(env, params = {}) {
  const cfg = env.cfg;
  const device = String(params.device || cfg.device || '').trim();
  const channel = String(params.channel || cfg.channel || 'auto').trim();
  const r = await resolveTarget(env.exec, {
    cfg,
    device,
    channel,
    timeoutMs: cfg.listTimeoutMs,
    signal: env.signal,
  });
  if (!r.ok) {
    return {
      ok: false,
      error: r.error,
      guidance: r.guidance,
      channels: r.tried.map((t) => ({
        channel: t.channel,
        ok: t.ok,
        error: t.error || '',
        connected: t.connected || [],
        targetsRaw: t.targetsRaw || '',
        stderr: t.stderr || '',
      })),
    };
  }
  const others = (r.targets || []).filter((t) => /^connected$/i.test(String(t.state || '').trim()) && t.key !== r.target.key);
  return {
    ok: true,
    channel: r.channel,
    channelLabel: channelLabel(r.channel),
    cmd: r.cmd,
    key: r.target.key,
    target: r.target,
    otherConnected: others.map((t) => t.key),
    targetsRaw: r.targetsRaw,
    tried: r.tried,
  };
}

/** 读设备全局日志级别（真机 `param get hilog.loggable.global` 输出形如 `W `）。 */
export async function readGlobalLevel(env, dev) {
  const { command } = buildHilogCommand({ mode: 'getLevel' });
  const r = await runOnce(env.exec, {
    cmd: dev.cmd,
    target: dev.key,
    deviceCommand: command,
    timeoutMs: env.cfg.timeoutMs,
    stdoutMaxBytes: 64 * 1024,
    signal: env.signal,
  });
  const level = parseGlobalLevel(r.stdout);
  return { level, raw: r.stdout.trim(), stderr: r.stderr, exitCode: r.exitCode, command: r.command };
}

/**
 * 读设备时钟（`date +%s`），用于给 sinceNow 做精确偏移校正。
 *
 * 为什么值得多花一次往返：不加校正时只能靠"最新一条日志离现在多远"猜时钟偏移，
 * 而**设备空闲时这个猜测必然误判**（最新日志本来就是几分钟前的）⇒ 会把用户要的
 * "只看新日志"关掉。实测本机 PC 与设备时钟完全一致（`date +%s` 相等）。
 */
export async function readDeviceClock(env, dev) {
  const t0 = Date.now();
  try {
    const r = await runOnce(env.exec, {
      cmd: dev.cmd,
      target: dev.key,
      deviceCommand: 'date +%s',
      timeoutMs: Math.min(env.cfg.timeoutMs, 15000),
      stdoutMaxBytes: 4096,
      signal: env.signal,
    });
    const t1 = Date.now();
    const sec = Number(String(r.stdout).trim().split(/\s+/)[0]);
    if (!Number.isFinite(sec) || sec <= 0) return { ok: false, skewMs: 0, raw: r.stdout.trim() };
    // `date +%s` 只有秒级精度 ⇒ 用往返中点估计，量化误差 ≤1s（下面的 sinceSkewMs 余量可吸收）
    const hostMid = (t0 + t1) / 2;
    return { ok: true, epochSec: sec, skewMs: Math.round(sec * 1000 - hostMid), rttMs: t1 - t0 };
  } catch (e) {
    return { ok: false, skewMs: 0, error: String((e && e.message) || e) };
  }
}

/** 设设备全局日志级别（真机 `hilog -b <L>`）。 */
export async function setGlobalLevel(env, dev, level) {
  const lv = normalizeLevel(level);
  if (!lv) throw new Error(`无法识别的级别：${level}`);
  const { command } = buildHilogCommand({ mode: 'setLevel', level: lv });
  const r = await runOnce(env.exec, {
    cmd: dev.cmd,
    target: dev.key,
    deviceCommand: command,
    timeoutMs: env.cfg.timeoutMs,
    stdoutMaxBytes: 64 * 1024,
    signal: env.signal,
  });
  return { level: lv, command, stdout: r.stdout.trim(), stderr: r.stderr, exitCode: r.exitCode };
}

/** 结果里带出来的通道信息块。 */
function devFields(dev) {
  return {
    device: dev.key,
    channel: dev.channel,
    ...(dev.otherConnected && dev.otherConnected.length ? { otherConnected: dev.otherConnected } : {}),
  };
}

/** 从设备 stdout 里捞出可读的错误行（hilog/hdc 的报错都直接透传）。 */
function firstMeaningful(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[0] : '';
}

// ────────────────────────────────────────────────────────────────────────────
// 1. hilog_level
// ────────────────────────────────────────────────────────────────────────────
export async function opLevel(env, params = {}) {
  const action = String(params.action || 'get').trim().toLowerCase();
  const dev = await pickDevice(env, params);
  if (!dev.ok) return { ok: false, tool: 'hilog_level', error: dev.error, guidance: dev.guidance, channels: dev.channels };

  if (action === 'get') {
    const r = await readGlobalLevel(env, dev);
    if (!r.level) {
      return {
        ok: false, tool: 'hilog_level', action, ...devFields(dev),
        error: `读不到 hilog.loggable.global（设备输出：${JSON.stringify(r.raw)}）`,
        stderr: r.stderr, command: r.command,
      };
    }
    return { ok: true, tool: 'hilog_level', action, ...devFields(dev), level: r.level, raw: r.raw };
  }

  if (action === 'set' || action === 'restore') {
    const want = normalizeLevel(params.level || (action === 'restore' ? env.state.lastBefore[dev.key] : null));
    if (!want) {
      return {
        ok: false, tool: 'hilog_level', action, ...devFields(dev),
        error: action === 'restore' && !params.level
          ? 'restore 需要显式 level（或先用一次 set 让插件记住原值）'
          : `无法识别的级别：${params.level}`,
        hint: '可用级别：D / I / W / E / F（也接受 DEBUG/INFO/WARN/ERROR/FATAL）',
      };
    }
    const before = await readGlobalLevel(env, dev);
    if (!before.level) {
      return {
        ok: false, tool: 'hilog_level', action, ...devFields(dev),
        error: `设置前读不到当前级别（设备输出：${JSON.stringify(before.raw)}）`, stderr: before.stderr,
      };
    }
    // keep=true 才把新级别留在设备上；默认按 §5.1 的纪律"设置即还原"（try/finally 兜底）。
    // action:"restore" 的语义本身就是"把级别停在目标值" ⇒ 它不算一次临时改动，不许被 finally 拨回去。
    const keep = action === 'restore' ? true : params.keep === true;
    // 只有"真把设备留下改过"（keep:true 且确实变了）才记原值 —— 否则 action:"restore"
    // 会把 keep 之后的当前值当成"原值"，越还原越偏（2026-10-15 单测抓到）。
    if (keep && before.level !== want && !env.state.lastBefore[dev.key]) {
      env.state.lastBefore[dev.key] = before.level;
    }
    let setInfo = null;
    let afterSet = null;
    let restoreInfo = null;
    let restoreError = null;
    let thrown = null;
    try {
      setInfo = await setGlobalLevel(env, dev, want);
      const check = await readGlobalLevel(env, dev);
      afterSet = check.level;
      if (afterSet !== want) {
        return {
          ok: false, tool: 'hilog_level', action, ...devFields(dev),
          before: before.level, after: afterSet,
          error: `设置级别未生效：想设 ${want}，设备回报 ${afterSet ?? '未知'}`,
          stderr: [setInfo.stderr, check.stderr].filter(Boolean).join('\n'),
          command: setInfo.command,
        };
      }
    } catch (e) {
      thrown = e;
    } finally {
      if (!keep && before.level !== want) {
        try {
          restoreInfo = await setGlobalLevel(env, dev, before.level);
        } catch (e) {
          restoreError = String((e && e.message) || e);
        }
      }
    }
    if (thrown) {
      return {
        ok: false, tool: 'hilog_level', action, ...devFields(dev),
        before: before.level,
        error: `设置级别失败：${(thrown && thrown.message) || thrown}`,
        ...(restoreError ? { restoreError } : {}),
      };
    }
    let checkAfter = { level: null };
    try {
      checkAfter = await readGlobalLevel(env, dev);
    } catch (e) {
      checkAfter = { level: null, error: String((e && e.message) || e) };
    }
    const finalLevel = keep ? afterSet : (checkAfter.level || null);
    const restored = !keep && before.level !== want;
    const out = {
      ok: true, tool: 'hilog_level', action, ...devFields(dev),
      before: before.level,
      set: afterSet,
      after: finalLevel,
      keep,
      restored: restored ? finalLevel === before.level : false,
    };
    if (restoreError) {
      out.ok = false;
      out.restoreError = restoreError;
      out.error = `已设置 ${want}，但还原到 ${before.level} 失败：${restoreError}`;
      out.hint = `设备目前可能停在 ${afterSet ?? want} 级；请手动还原：hdc -t ${dev.key} shell "hilog -b ${before.level}"`;
    } else if (!keep) {
      out.note = `已按纪律还原到 ${before.level}（想长期保持该级别请传 keep:true，收尾再用 action:"restore" 还原）`;
    } else {
      out.note = `keep:true ⇒ 设备级别保持在 ${want}。收尾请调用 hilog_level({action:"restore", level:"${before.level}"})（本插件已记住原值：${env.state.lastBefore[dev.key]}）`;
    }
    if (restoreInfo) out.restoreStdout = restoreInfo.stdout;
    if (setInfo) out.setStdout = setInfo.stdout;
    return out;
  }

  return {
    ok: false, tool: 'hilog_level', action, ...devFields(dev),
    error: `未知 action：${action}（可用：get / set / restore）`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. hilog_dump —— 非阻塞取当前缓冲区（-x）
// ────────────────────────────────────────────────────────────────────────────
export async function opDump(env, params = {}) {
  const cfg = env.cfg;
  const dev = await pickDevice(env, params);
  if (!dev.ok) return { ok: false, tool: 'hilog_dump', error: dev.error, guidance: dev.guidance, channels: dev.channels };

  const tags = [...toArray(params.tag), ...toArray(params.tags)].map(String);
  const pids = [...toArray(params.pid), ...toArray(params.pids)].map(String);
  const domains = [...toArray(params.domain), ...toArray(params.domains)].map(String);
  const wantLevel = normalizeLevel(params.level);
  const format = params.format === 'long' ? 'long' : 'normal';

  let built;
  try {
    built = buildHilogCommand({
      mode: 'dump',
      tags, pids, domains,
      levels: wantLevel ? [wantLevel] : null,   // `-L` 是精确匹配；这里 = "只要这个级别的行"
      regex: params.regex,
      format,
    });
  } catch (e) {
    return { ok: false, tool: 'hilog_dump', ...devFields(dev), error: String((e && e.message) || e) };
  }

  const t0 = Date.now();
  const r = await runOnce(env.exec, {
    cmd: dev.cmd,
    target: dev.key,
    deviceCommand: built.command,
    timeoutMs: Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : cfg.timeoutMs,
    stdoutMaxBytes: cfg.stdoutMaxBytes,
    signal: env.signal,
  });
  const parsed = parseEntries(r.stdout, { format });
  const global = await readGlobalLevel(env, dev).catch(() => ({ level: null }));

  const lines = Number(params.lines) > 0 ? Number(params.lines) : cfg.maxLines;
  const order = params.order === 'head' ? 'head' : 'tail';
  const tr = truncateEntries(parsed.entries, { lines, maxBytes: cfg.maxBytes, order });

  const result = {
    ok: r.exitCode === 0 || parsed.entries.length > 0,
    tool: 'hilog_dump',
    ...devFields(dev),
    order,
    mode: 'dump(-x 非阻塞)',
    entries: tr.kept.map(entryView),
    totalEntries: parsed.entries.length,
    returned: tr.kept.length,
    dropped: tr.dropped,
    truncated: tr.truncated,
    clampedByBytes: tr.clampedByBytes,
    bytes: tr.bytes,
    globalLevel: global.level,
    elapsedMs: Date.now() - t0,
    command: r.command,
    exitCode: r.exitCode,
    ...(r.timedOut ? { timedOut: true } : {}),
  };
  if (parsed.unparsed.length) result.unparsed = parsed.unparsed.slice(0, 5);
  if (parsed.noise.length) result.noiseLines = parsed.noise.length;
  if (r.stderr) result.stderr = r.stderr;

  // 落盘（§4.4：默认只回摘要 + 前 N 条，完整日志写文件）
  if (params.save === true || (params.save === undefined && cfg.dumpSave)) {
    const saved = await env.save({
      prefix: 'dump',
      tag: tags[0] || '',
      header: `# dsh-hilog dump · device=${dev.key} channel=${dev.channel} at=${new Date().toISOString()} · cmd=${r.command}`,
      body: parsed.cleaned.join('\n'),
    });
    if (saved.ok) { result.filePath = saved.filePath; result.fileLines = saved.fileLines; }
    else result.saveError = saved.error;
  } else if (tr.truncated) {
    result.hint = `只返回了 ${tr.kept.length}/${parsed.entries.length} 条（按 order=${order} 截断）。要看完整缓冲区请重跑并传 save:true（会落盘到工作区）。`;
  }

  if (!result.ok) {
    result.error = `hdc 退出码 ${r.exitCode}${r.timedOut ? '（超时）' : ''}，且没有解析到任何日志行`;
    if (r.stderr) result.hint = `hdc stderr：${firstMeaningful(r.stderr)}`;
  } else if (parsed.entries.length === 0) {
    result.hint = '缓冲区里没有匹配的日志。注意：全局级别是 '
      + `${global.level || '未知'} ⇒ 低于该级别的 hilog 调用（如默认 W 下的 hilog.info）根本没进缓冲区；`
      + '要抓 I/D 请用 hilog_capture（它会临时提级别并自动还原）。';
  }
  // 只要"请求的级别比设备全局级别更啰嗦"，无论本次抓没抓到，都要点出来（这是最常见的误判源）
  if (wantLevel && global.level && LEVEL_RANK[wantLevel] < (LEVEL_RANK[global.level] ?? 99)) {
    result.levelHint = `设备全局级别是 ${global.level} ⇒ 低于它的日志（如 ${wantLevel}）在进缓冲区前就被丢弃了`
      + `（本机默认 W，应用的 hilog.info 就是这样被丢的）。要抓这类日志请用 hilog_capture（会临时提级别并还原）。`;
  }
  return result;
}

const LEVEL_RANK = { D: 0, I: 1, W: 2, E: 3, F: 4 };

// ────────────────────────────────────────────────────────────────────────────
// 3. hilog_capture —— 实时抓 N 秒（边读边收）
// ────────────────────────────────────────────────────────────────────────────
export async function opCapture(env, params = {}) {
  const cfg = env.cfg;
  const dev = await pickDevice(env, params);
  if (!dev.ok) return { ok: false, tool: 'hilog_capture', error: dev.error, guidance: dev.guidance, channels: dev.channels };

  const seconds = Math.min(Math.max(Number(params.seconds) > 0 ? Number(params.seconds) : cfg.seconds, 1), cfg.maxSeconds);
  const level = normalizeLevel(params.level || cfg.level) || 'I';
  const doRestore = params.restoreLevel === undefined ? cfg.restoreLevel : params.restoreLevel !== false;
  const tags = [...toArray(params.tag), ...toArray(params.tags)].map(String);
  const pids = [...toArray(params.pid), ...toArray(params.pids)].map(String);
  const domains = [...toArray(params.domain), ...toArray(params.domains)].map(String);
  const format = params.format === 'long' ? 'long' : 'normal';
  const sinceNow = params.sinceNow === undefined ? cfg.sinceNow : params.sinceNow !== false;

  let built;
  try {
    built = buildHilogCommand({
      mode: 'capture',
      tags, pids, domains,
      levels: levelsFrom(level),        // `-L I,W,E,F`：设备侧只认精确集合
      regex: params.regex,
      format,
      timeoutSec: seconds + 3,          // 设备侧兜底超时：本地被杀也不留孤儿 hilog
    });
  } catch (e) {
    return { ok: false, tool: 'hilog_capture', ...devFields(dev), error: String((e && e.message) || e) };
  }

  const startedAt = Date.now();
  const before = await readGlobalLevel(env, dev);
  if (!before.level && doRestore) {
    return {
      ok: false, tool: 'hilog_capture', ...devFields(dev),
      error: `抓取前读不到当前级别（设备输出：${JSON.stringify(before.raw)}）⇒ 无法保证还原，已中止`,
      stderr: before.stderr,
    };
  }
  if (before.level) env.state.lastBefore[dev.key] = before.level;

  const notes = [];
  let handle = null;
  let started = null;
  let buf = '';
  let stderrText = '';
  let lossy = false;
  let spillPath = null;
  let streamError = null;
  let setError = null;
  let restoreError = null;
  let killedEarly = false;
  let levelSet = null;
  let exceededCap = false;
  let readFallback = false;

  const capBytes = cfg.stdoutMaxBytes;
  const deadline = startedAt + seconds * 1000;
  const maxLines = Number(params.maxLines) > 0 ? Number(params.maxLines) : cfg.maxCaptureLines;
  let skewMs = 0;
  let skewKnown = false;

  try {
    // 注意：restoreLevel:false 只表示"不还原"，不代表"不提级别"（要抓 I/D 还是得先把设备级别提上去）
    if (before.level !== level) {
      try {
        await setGlobalLevel(env, dev, level);
        levelSet = level;
      } catch (e) {
        setError = String((e && e.message) || e);
        notes.push(`提级别失败（${setError}）⇒ 继续按设备当前级别抓取`);
      }
    }

    if (sinceNow) {
      const clock = await readDeviceClock(env, dev);
      if (clock.ok) {
        skewKnown = true;
        skewMs = clock.skewMs;   // >0 ⇒ 设备时钟比宿主快
        if (Math.abs(skewMs) > 5000) notes.push(`设备时钟与宿主相差 ${Math.round(skewMs / 1000)}s（已按此校正"只看新日志"的下界）`);
      }
    }

    started = await runStream(env.execStream, {
      cmd: dev.cmd,
      target: dev.key,
      deviceCommand: built.command,
      // 本地兜底超时比设备侧 `timeout` 宽 5s：正常情况下由我们自己在 deadline 处收手
      timeoutMs: (seconds + 5) * 1000,
      stdoutMaxBytes: capBytes,
      signal: env.signal,
      onExpiry: 'kill',
    });
    handle = started.handle;

    const onAbort = () => { try { handle && handle.kill && handle.kill(); } catch { /* ignore */ } };
    if (env.signal && typeof env.signal.addEventListener === 'function') env.signal.addEventListener('abort', onAbort, { once: true });

    if (handle && typeof handle.read === 'function') {
      // 流式：边跑边读（对抗 512KB 滚动；也能在抓够 maxLines 后提前收手）。
      // ★ 提前收手只数"新日志"：阻塞读会先把整个缓冲区历史吐出来（真机实测一次 2000+ 行），
      //   若把历史也算进去，工具会在任何新日志出现之前就收手 ⇒ 调用方拿到 0 条（2026-10-15 真机抓到）。
      const counter = makeLineCounter({ sinceNow, floorMs: startedAt - cfg.sinceSkewMs + skewMs });
      while (true) {
        readChunkMaybe(counter);
        if (buf.length >= capBytes) { exceededCap = true; break; }
        if (counter.fresh() >= maxLines) { killedEarly = true; break; }
        if (env.signal && env.signal.aborted) { killedEarly = true; break; }
        if (Date.now() >= deadline) break;
        if (handle.status && typeof handle.status === 'function' && handle.status() !== 'running') break;
        await sleep(cfg.pollMs);
      }
    } else {
      // 兜底：拿不到 readOutput 的接缝（或测试替身）⇒ 等服务端自己退出（仍受 timeoutMs 约束）
      readFallback = true;
      const rr = typeof handle.result === 'function' ? await handle.result() : null;
      if (rr) {
        buf += (rr.stdout && rr.stdout.text) || '';
        stderrText += (rr.stderr && rr.stderr.text) || '';
        if (rr.stdout && rr.stdout.truncated) lossy = true;
        if (rr.stdout && rr.stdout.spillPath) spillPath = rr.stdout.spillPath;
      }
    }
  } catch (e) {
    streamError = String((e && e.message) || e);
  } finally {
    // 收尾 1：杀干净子进程（不能留孤儿）
    try { if (handle && handle.kill) handle.kill(); } catch { /* ignore */ }
    try { if (handle && handle.done && typeof handle.done.then === 'function') await withTimeout(handle.done, 3000); } catch { /* ignore */ }
    // 收尾 2：把 kill 之后剩余的输出读干净
    try {
      if (handle && typeof handle.read === 'function') {
        for (let i = 0; i < 3; i += 1) { if (!readChunkMaybe()) break; await sleep(60); }
      }
    } catch { /* ignore */ }
    // 收尾 3：**无论如何**还原级别（§5.1 硬约束）
    if (doRestore && before.level && before.level !== level) {
      try {
        await setGlobalLevel(env, dev, before.level);
      } catch (e) {
        restoreError = String((e && e.message) || e);
      }
    }
  }

  function readChunkMaybe(counter) {
    const chunk = handle && typeof handle.read === 'function' ? handle.read() : null;
    if (!chunk) return false;
    const { out, err } = splitStreamDelta(chunk.delta);
    if (out) { buf += out; if (counter) counter.push(out); }
    if (err) stderrText += err;
    if (chunk.lossy) lossy = true;
    if (chunk.spillPath) spillPath = chunk.spillPath;
    return !!(out || err);
  }

  const endedAt = Date.now();
  const parsed = parseEntries(buf, { format });

  // 「只看新日志」：阻塞读会先吐缓冲区历史（实测第一行可能是几天前）
  let entries = parsed.entries;
  let filteredOut = 0;
  let skewDisabled = false;
  let result_skewMs = 0;
  if (sinceNow && entries.length) {
    if (!skewKnown) {
      // 拿不到设备时钟时的退路：用"最新一条日志离现在多远"粗判（设备空闲时会误判 ⇒ 宁可不滤）
      const newest = entries.reduce((m, e) => (Number.isFinite(e.tsMs) && e.tsMs > m ? e.tsMs : m), 0);
      if (newest && Math.abs(newest - endedAt) > cfg.clockSkewToleranceMs) {
        skewDisabled = true;
        notes.push(`读不到设备时钟，且缓冲区最新一条离现在约 ${Math.round((endedAt - newest) / 1000)}s `
          + '⇒ 无法可靠区分"历史"与"新日志"，已关闭 sinceNow 过滤（返回全部）');
      }
    }
    if (!skewDisabled) {
      const floor = startedAt - cfg.sinceSkewMs + skewMs;
      const kept = entries.filter((e) => !Number.isFinite(e.tsMs) || e.tsMs >= floor);
      filteredOut = entries.length - kept.length;
      entries = kept;
      if (Math.abs(skewMs) > 5000) result_skewMs = skewMs;
    }
  }

  const tr = truncateEntries(entries, { lines: maxLines, maxBytes: cfg.maxBytes, order: 'head' });
  const after = await readGlobalLevel(env, dev).catch(() => ({ level: null }));

  const result = {
    ok: !streamError,
    tool: 'hilog_capture',
    ...devFields(dev),
    mode: `capture(${seconds}s 流式)`,
    seconds,
    levelBefore: before.level,
    levelSet,
    levelAfter: after.level,
    restored: doRestore && before.level
      ? (after.level === before.level ? true : false)
      : null,
    entries: tr.kept.map(entryView),
    totalEntries: entries.length,
    returned: tr.kept.length,
    dropped: tr.dropped,
    truncated: tr.truncated,
    clampedByBytes: tr.clampedByBytes,
    bytes: tr.bytes,
    filteredOut,
    elapsedMs: endedAt - startedAt,
    command: started ? started.command : '',
    tags,
    level,
    killedEarly,
    ...(exceededCap ? { exceededCap: true } : {}),
    ...(lossy ? { lossy: true } : {}),
    ...(spillPath ? { spillPath } : {}),
    ...(readFallback ? { readFallback: true } : {}),
    ...(parsed.unparsed.length ? { unparsed: parsed.unparsed.slice(0, 5) } : {}),
  };
  if (parsed.noise.length) result.noiseLines = parsed.noise.length;
  if (skewDisabled) result.clockSkewFilterDisabled = true;
  if (Number.isFinite(result_skewMs) && result_skewMs !== 0) result.deviceClockSkewMs = result_skewMs;
  if (streamError) { result.ok = false; result.error = streamError; }
  if (setError) result.setLevelError = setError;
  // ★ via-host 的 shim 提示行打在 stderr 上 ⇒ 先过滤，再决定"要不要算失败"
  const stderrClean = filterNoiseLines(stderrText);
  if (stderrClean) result.stderr = stderrClean;
  if (!streamError && entries.length === 0 && stderrClean) {
    result.ok = false;
    result.error = `抓取期间 hdc 报错：${stderrClean.split('\n')[0]}`;
  }
  if (env.signal && env.signal.aborted) notes.push('本次调用被取消：已杀进程并还原级别');

  // 落盘（capture 默认 true：这些日志是瞬时的，设备缓冲区 ~20s 就滚掉了）
  const wantSave = params.save === undefined ? cfg.captureSave : params.save === true;
  if (wantSave) {
    const saved = await env.save({
      prefix: 'capture',
      tag: tags[0] || '',
      header: `# dsh-hilog capture · device=${dev.key} channel=${dev.channel} · ${seconds}s · `
        + `level ${before.level}→${levelSet || before.level}→${after.level || '?'} · at=${new Date(startedAt).toISOString()}\n`
        + `# 返回摘要 ${entries.length} 条新日志（sinceNow 过滤掉 ${filteredOut} 条缓冲区历史）；本文件是完整原始输出，含历史行。`,
      body: parsed.cleaned.join('\n'),
    });
    if (saved.ok) { result.filePath = saved.filePath; result.fileLines = saved.fileLines; }
    else result.saveError = saved.error;
  }

  // 还原失败要吵（否则设备被留在 D 级，正是 §5.1 要防的事）
  if (restoreError) {
    result.ok = false;
    result.restoreError = restoreError;
    result.error = `抓取结束，但还原级别失败：${restoreError}`;
    result.hint = `请手动还原：hdc -t ${dev.key} shell "hilog -b ${before.level}"`;
  } else if (doRestore && before.level && after.level && after.level !== before.level) {
    result.ok = false;
    result.error = `级别未还原：期望 ${before.level}，实际 ${after.level}`;
    result.hint = `请手动还原：hdc -t ${dev.key} shell "hilog -b ${before.level}"`;
  } else if (doRestore && before.level) {
    notes.push(`级别已还原：${before.level} → ${levelSet || before.level} → ${after.level || before.level}`);
  }

  // 「设备睡了」≠「插件坏了」（§5.9）
  if (entries.length === 0) {
    notes.push(
      '没抓到任何条目。可能原因：① 设备息屏/空闲、目标应用已被系统冻结（后台日志量趋近于零）；'
      + `② tag/正则在 ${seconds}s 窗口内没有命中；③ 该级别在这段时间确实没有日志。`
      + `（可放宽：seconds 调到 30+，或去掉 tag 过滤；熄屏也照跑属设备侧设置）`,
    );
  } else if (entries.length < 5 && tags.length) {
    notes.push('条目很少 ⇒ 设备可能正在息屏/空闲，或目标应用被冻结；可放宽 seconds 再抓一次。');
  }
  if (filteredOut > 0) notes.push(`按"只看新日志"过滤掉了 ${filteredOut} 条缓冲区历史（sinceNow:false 可关闭该过滤）`);
  if (lossy) notes.push('输出曾被接缝截断（lossy）：完整内容见 spillPath 指向的文件');
  if (killedEarly) notes.push('已抓够 maxLines 提前收手（设备侧 timeout 会自行清理）');
  if (notes.length) result.notes = notes;
  return result;
}

/**
 * 增量统计"新日志行"（提前收手用）。
 *
 * 为什么需要：阻塞式 `hilog` 会**先吐整个缓冲区历史**（真机实测一次 2000+ 行），
 * 如果把历史行也算进 maxLines，工具会在第一条新日志出现之前就收手。
 * 这里按行切分（跨 chunk 的半个行用 tail 兜住），只统计时间戳 ≥ floorMs 的行。
 */
function makeLineCounter({ sinceNow, floorMs }) {
  let tail = '';
  let fresh = 0;
  return {
    push(chunk) {
      if (!chunk) return;
      const combined = tail + chunk;
      const lines = combined.split('\n');
      tail = lines.pop();
      for (const line of lines) {
        const m = /^(\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2}\.\d{3,9})/.exec(line);
        if (!m) continue;
        if (!sinceNow) { fresh += 1; continue; }
        const ts = entryTimeMs(m[1], m[2], Date.now());
        if (ts === null || ts >= floorMs) fresh += 1;
      }
    },
    fresh: () => fresh,
  };
}

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms)]);
}

/** 供 README/工具描述引用的一句指引（保持与 hdc.js 同源）。 */
export const DEVICE_GUIDANCE = HOST_KEEPALIVE;
