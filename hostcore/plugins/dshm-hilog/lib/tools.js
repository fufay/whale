// lib/tools.js —— 工具定义层：ctx.shell 适配 + 渲染 + 三个工具的注册/执行。
//
// 单独成文件的原因：这一层**不依赖 schemastery / cordis**（只依赖注入进来的 ctx），
// 因此可以用假 ctx + 假 shell 做完整单测（含"设置了级别但中途抛异常，最后仍还原"这类
// 关键路径），无需设备、也无需装进 profile。
//
// 三个工具：hilog_level / hilog_dump / hilog_capture（工具契约见 开发需求文档.md §4.1）。

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { formatEntry } from './hilog.js';
import { normalizeConfig, opCapture, opDump, opLevel } from './ops.js';

export const SHELL_MISSING =
  'ctx.shell 接缝未挂载：本插件一律走 DSH 的 shell 服务执行 hdc（不用 node:child_process）。'
  + '请确认 profile 里 bash/pwsh 执行器与 subprocess 已启用，重启 DSH 后重试。';

/** 从 shell 的 CollectedOutput | string 里取文本。 */
const textOf = (o) => (o && typeof o === 'object' && typeof o.text === 'string' ? o.text : (typeof o === 'string' ? o : ''));

/**
 * 把 `ctx.shell` 接缝包成两个注入给 ops 的执行器：
 *   exec(command, opts)       —— 阻塞到结束（dump / 级别读写）
 *   execStream(command, opts) —— 立刻拿到句柄，边跑边读（capture）
 */
export function shellAdapters(shell, cfg) {
  const buildRequest = (command, opts = {}) => ({
    command,
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : cfg.timeoutMs,
    onExpiry: opts.onExpiry || 'kill',
    stdoutMaxBytes: Number(opts.stdoutMaxBytes) > 0 ? Number(opts.stdoutMaxBytes) : cfg.stdoutMaxBytes,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.workdir ? { workdir: opts.workdir } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    sandboxPolicy: { mode: cfg.sandboxMode, workspaceRoot: opts.workdir || process.cwd() },
  });
  const resolveSpec = (request) => (shell && typeof shell.resolve === 'function' ? shell.resolve(request) : request);
  const needShell = () => {
    if (!shell || typeof shell.execute !== 'function') throw new Error(SHELL_MISSING);
  };

  const exec = async (command, opts = {}) => {
    needShell();
    const handle = await shell.execute(resolveSpec(buildRequest(command, opts)));
    const r = handle && typeof handle.result === 'function' ? await handle.result() : handle;
    return {
      exitCode: r && r.exitCode !== undefined ? r.exitCode : null,
      stdout: textOf(r && r.stdout),
      stderr: textOf(r && r.stderr),
      timedOut: !!(r && r.timedOut),
      aborted: !!(r && r.aborted),
      spillPath: (r && r.stdout && r.stdout.spillPath) || null,
      sandbox: r && r.sandbox,
    };
  };

  const execStream = async (command, opts = {}) => {
    needShell();
    const handle = await shell.execute(resolveSpec(buildRequest(command, opts)));
    const canStream = !!(handle && typeof handle.readOutput === 'function');
    return {
      // ★ 拿不到 readOutput 时**不要**返回一个恒空的 read：那会让 capture 白等到超时才杀进程，
      //   进而丢掉全部输出。返回 null ⇒ ops 走 result() 兜底（等价于阻塞抓取，仍受超时约束）。
      read: canStream
        ? () => {
          const r = handle.readOutput() || {};
          return {
            delta: r.delta || '',
            lossy: !!r.lossy,
            spillPath: r.stdoutSpillPath || null,
          };
        }
        : null,
      streaming: canStream,
      kill: () => { try { return handle && handle.kill ? handle.kill() : false; } catch { return false; } },
      status: () => (handle && handle.status) || 'running',
      done: (handle && handle.done) || Promise.resolve(),
      result: async () => {
        const r = handle && typeof handle.result === 'function' ? await handle.result() : null;
        if (!r) return null;
        return {
          exitCode: r.exitCode,
          timedOut: !!r.timedOut,
          aborted: !!r.aborted,
          stdout: { text: textOf(r.stdout), truncated: !!(r.stdout && r.stdout.truncated), spillPath: (r.stdout && r.stdout.spillPath) || null },
          stderr: { text: textOf(r.stderr), truncated: !!(r.stderr && r.stderr.truncated) },
        };
      },
    };
  };

  return { exec, execStream };
}

/** 时间戳（本地时间，文件名友好）。 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeName(s, max = 40) {
  return String(s || '').replace(/[^\w.@-]+/g, '_').slice(0, max);
}

/** 落盘：`<outputDir 或 cwd/Build/dsh-hilog/logs>/<时间戳>-<prefix>-<tag>.log`。 */
export async function saveLog({ cfg, cwd }, { prefix, tag, header, body }) {
  try {
    const dir = cfg.outputDir
      ? cfg.outputDir
      : path.join(cwd || process.cwd(), 'Build', 'dsh-hilog', 'logs');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${stamp()}-${prefix}${tag ? `-${safeName(tag)}` : ''}.log`);
    await writeFile(filePath, `${header}\n${body || ''}\n`, 'utf8');
    return { ok: true, filePath, fileLines: body ? body.split('\n').length : 0 };
  } catch (e) {
    return { ok: false, error: `落盘失败：${(e && e.message) || e}` };
  }
}

/** 会话工作目录（落盘默认位置用）。 */
function sessionCwd(execCtx) {
  try {
    const h = execCtx && execCtx.agent && execCtx.agent.session && execCtx.agent.session.header;
    if (h && typeof h.cwd === 'string' && h.cwd) return h.cwd;
  } catch { /* ignore */ }
  return process.cwd();
}

// ── 渲染：模型/用户看到的是这里产出的文本（value 里仍是结构化 JSON）─────────
const OUT_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true };

function head(result) {
  const bits = [result.tool, result.ok ? 'ok' : '失败'];
  if (result.device) bits.push(`device=${result.device}`);
  if (result.channel) bits.push(`channel=${result.channel}`);
  if (result.mode) bits.push(result.mode);
  return `[dsh-hilog] ${bits.join(' · ')}`;
}

function tail(result) {
  const lines = [];
  for (const k of ['error', 'restoreError', 'saveError', 'lossy']) {
    if (result[k]) lines.push(`${k}: ${result[k] === true ? '输出被接缝截断（见 spillPath）' : result[k]}`);
  }
  if (result.guidance) lines.push(`指引: ${result.guidance}`);
  if (result.hint) lines.push(`提示: ${result.hint}`);
  if (result.levelHint) lines.push(`级别提示: ${result.levelHint}`);
  if (Array.isArray(result.notes)) for (const n of result.notes) lines.push(`· ${n}`);
  if (result.filePath) lines.push(`文件: ${result.filePath}${result.fileLines !== undefined ? `（${result.fileLines} 行）` : ''}`);
  if (Array.isArray(result.channels) && result.channels.length) {
    lines.push('逐通道探测结果:');
    for (const c of result.channels) {
      lines.push(`  - ${c.channel}: ${c.ok ? 'ok' : c.error || '不可用'}${c.connected && c.connected.length ? `（Connected: ${c.connected.join(', ')}）` : ''}`);
      if (c.targetsRaw) lines.push(`    list targets -v:\n${String(c.targetsRaw).split('\n').map((l) => `      ${l}`).join('\n')}`);
      if (c.stderr) lines.push(`    stderr: ${c.stderr}`);
    }
  }
  return lines;
}

/** 通用 render：头部一行 + 正文（截断后的日志）+ 尾部提示。 */
export function renderResult(result) {
  const out = [head(result)];
  const entries = Array.isArray(result.entries) ? result.entries : [];

  if (result.tool === 'hilog_level') {
    if (result.ok || result.before || result.level) {
      out.push(`级别: ${result.action === 'get' ? result.level : `${result.before} → ${result.set || result.level} → ${result.after}`}`
        + `${result.restored ? '（已还原）' : ''}`
        + `${result.action === 'set' && result.keep ? '（keep:true 保留）' : ''}`
        + `${result.action === 'restore' ? '（本次就是显式还原）' : ''}`);
    }
  } else {
    out.push(`条目: 共 ${result.totalEntries ?? entries.length} 条，返回 ${result.returned ?? entries.length} 条`
      + `${result.truncated ? `（已截断${result.dropped ? `，丢弃 ${result.dropped}` : ''}${result.clampedByBytes ? '，按字节上限截断' : ''}）` : ''}`
      + `${result.order ? ` · order=${result.order}` : ''}${result.seconds ? ` · ${result.seconds}s` : ''}`
      + `${result.globalLevel ? ` · 设备级别=${result.globalLevel}` : ''}`);
    if (result.tool === 'hilog_capture') {
      out.push(`级别: ${result.levelBefore} → ${result.levelSet || result.levelBefore} → ${result.levelAfter ?? '?'}`
        + `${result.restored === true ? '（已还原 ✅）' : result.restored === false ? '（未还原 ❌）' : ''}`);
    }
    if (result.filteredOut) out.push(`过滤掉 ${result.filteredOut} 条缓冲区历史（sinceNow）`);
    if (entries.length) {
      out.push(`--- 日志（${entries.length} 条）---`);
      for (const e of entries) out.push(formatEntry(e));
    }
  }

  const t = tail(result);
  if (t.length) out.push('---', ...t);
  return out.join('\n');
}

function renderContent(_args, result) {
  try {
    return [{ type: 'text', text: renderResult(result) }];
  } catch (e) {
    return [{ type: 'text', text: `[dsh-hilog] 渲染失败：${(e && e.message) || e}\n${JSON.stringify(result).slice(0, 2000)}` }];
  }
}

const OUT = { schema: OUT_SCHEMA, render: renderContent };

const DEVICE_DOC = 'device?: 目标 key（hdc list targets 的第一列）。缺省 = 自动挑唯一的 Connected 目标；'
  + '目标在别的通道时会自动换通道探测。';
const CHANNEL_DOC = 'channel?: auto（默认）| bridge（桥/无线调试）| via-host（借宿主 hdc server，USB 设备走这条）。';

export function registerTools(ctx, { getConfig, getShell, logger } = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn?.('dsh-hilog: ctx.tools 不可用，工具未注册');
    return;
  }
  const cfgOf = () => {
    let raw = {};
    try { raw = (typeof getConfig === 'function' ? getConfig() : null) || {}; } catch { raw = {}; }
    return normalizeConfig(raw);
  };
  const shellOf = () => {
    try { return (typeof getShell === 'function' ? getShell() : null) || null; } catch { return null; }
  };
  const state = { lastBefore: Object.create(null) };   // 记住"设之前"的级别，供 action:"restore" 收尾

  const makeEnv = (execCtx) => {
    const cfg = cfgOf();
    const { exec, execStream } = shellAdapters(shellOf(), cfg);
    const cwd = sessionCwd(execCtx);
    return {
      cfg,
      exec,
      execStream,
      signal: execCtx && execCtx.signal,
      state,
      save: (opts) => saveLog({ cfg, cwd }, opts),
      logger,
    };
  };

  const run = async (tool, execCtx, params, fn) => {
    const env = makeEnv(execCtx);
    const t0 = Date.now();
    try {
      const r = await fn(env, params || {});
      return { elapsedMsTotal: Date.now() - t0, ...r };
    } catch (e) {
      return {
        ok: false,
        tool,
        error: `插件内部异常：${(e && e.message) || e}`,
        hint: '若反复出现请把本段文本交给用户（含 stack）：' + String((e && e.stack) || '').split('\n').slice(0, 3).join(' | '),
      };
    }
  };

  // ── 1. hilog_level ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'hilog_level',
    description:
      '读 / 设 / 还原设备的 hilog 全局日志级别（hilog.loggable.global）。'
      + '默认只读（action:"get"）。action:"set" 会先读旧值——**默认设置完立刻还原**（本机默认是 W，'
      + '把设备留在 D 级会持续产生噪声且影响别人）；确实要长期保持请传 keep:true，'
      + '收尾用 action:"restore" 还原（不传 level 时用插件记住的原值）。'
      + `已知坑：默认级别 W ⇒ 应用的 hilog.info() 在进缓冲区前就被丢弃（常被误判成"代码没跑"）。${DEVICE_DOC} ${CHANNEL_DOC}`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'restore'], description: 'get（默认，只读）/ set / restore' },
        level: { type: 'string', description: 'action=set/restore 时的目标级别：D/I/W/E/F（也接受 DEBUG/INFO/WARN/ERROR/FATAL）' },
        keep: { type: 'boolean', description: 'set 时是否把新级别留在设备上（默认 false ⇒ 设完立即还原）' },
        device: { type: 'string', description: DEVICE_DOC },
        channel: { type: 'string', description: CHANNEL_DOC },
      },
    },
    output: OUT,
    timeoutMs: 120000,
    execute: async (params, execCtx) => run('hilog_level', execCtx, params, (env, p) => opLevel(env, p)),
  });

  // ── 2. hilog_dump ─────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'hilog_dump',
    description:
      '**非阻塞**取设备当前 hilog 缓冲区（hilog -x，读完即退出），支持 tag/level/pid/domain/正则过滤。'
      + '默认只回最近 200 条（tail）+ 32KB，不落盘（需要完整缓冲区请传 save:true，会写文件并给 filePath）。'
      + '注意：`-L` 只看指定级别本身；设备全局级别是 W 时，I/D 级日志根本没进缓冲区 ⇒ 那种情况请用 hilog_capture。'
      + ` ${DEVICE_DOC} ${CHANNEL_DOC}`,
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'tag 过滤（多个用 tags；-T 最多 10 个）' },
        tags: { type: 'array', items: { type: 'string' }, description: 'tag 列表（最多 10 个）' },
        level: { type: 'string', description: '只保留该级别的行：D/I/W/E/F（-L 是精确匹配）' },
        pid: { type: 'number', description: 'pid 过滤（多个用 pids；-P 最多 5 个）' },
        pids: { type: 'array', items: { type: 'number' }, description: 'pid 列表（最多 5 个）' },
        domain: { type: 'string', description: 'domain 过滤（多个用 domains；-D 最多 5 个）' },
        domains: { type: 'array', items: { type: 'string' }, description: 'domain 列表（最多 5 个）' },
        regex: { type: 'string', description: '正文正则（hilog -e）' },
        lines: { type: 'number', description: '最多返回多少条（默认 200；-x 不能与 -a/-z 同用 ⇒ 行数在客户端截断）' },
        order: { type: 'string', enum: ['tail', 'head'], description: '取尾巴（默认，最近 N 条）还是开头 N 条' },
        save: { type: 'boolean', description: 'true = 完整日志落盘并返回 filePath（默认 false）' },
        format: { type: 'string', enum: ['normal', 'long'], description: '日志格式（默认 normal；long = hilog -v long）' },
        device: { type: 'string', description: DEVICE_DOC },
        channel: { type: 'string', description: CHANNEL_DOC },
      },
    },
    output: OUT,
    timeoutMs: 90000,
    execute: async (params, execCtx) => run('hilog_dump', execCtx, params, (env, p) => opDump(env, p)),
  });

  // ── 3. hilog_capture ──────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'hilog_capture',
    description:
      '实时抓 N 秒日志（默认 15s）：**流式边读边收**（对抗 512KB 缓冲区约 20 秒就滚掉），'
      + '临时把设备全局级别提到 level（默认 I）以便 hilog.info 之类能进缓冲区，'
      + '**结束后 try/finally 还原原级别**（返回值里 levelBefore/levelAfter 可直接核对）。'
      + '默认只保留"本次调用开始之后"的日志（阻塞读会先吐缓冲区历史；sinceNow:false 可关）。'
      + '默认落盘（save:false 可关）。抓够 maxLines 会提前收手。'
      + ` ${DEVICE_DOC} ${CHANNEL_DOC}`,
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '抓取秒数（默认 15，上限见配置 maxSeconds=120）' },
        level: { type: 'string', description: '抓取的最低级别（默认 I）：会临时把设备级别提到它，并按"该级别及以上"过滤' },
        tag: { type: 'string', description: 'tag 过滤（多个用 tags；-T 最多 10 个）' },
        tags: { type: 'array', items: { type: 'string' }, description: 'tag 列表（最多 10 个）' },
        pid: { type: 'number', description: 'pid 过滤（多个用 pids；-P 最多 5 个）' },
        pids: { type: 'array', items: { type: 'number' }, description: 'pid 列表（最多 5 个）' },
        regex: { type: 'string', description: '正文正则（hilog -e）' },
        maxLines: { type: 'number', description: '最多收集多少条（默认 2000；抓够提前收手）' },
        save: { type: 'boolean', description: '是否落盘（默认 true）' },
        restoreLevel: { type: 'boolean', description: '是否还原级别（默认 true；除非你在做专门的级别实验，否则别关）' },
        sinceNow: { type: 'boolean', description: '只保留本次调用开始之后的日志（默认 true）' },
        format: { type: 'string', enum: ['normal', 'long'], description: '日志格式（默认 normal）' },
        device: { type: 'string', description: DEVICE_DOC },
        channel: { type: 'string', description: CHANNEL_DOC },
      },
    },
    output: OUT,
    timeoutMs: 180000,
    execute: async (params, execCtx) => run('hilog_capture', execCtx, params, (env, p) => opCapture(env, p)),
  });

  logger?.info?.('dsh-hilog: 已注册 hilog_level / hilog_dump / hilog_capture');
}

