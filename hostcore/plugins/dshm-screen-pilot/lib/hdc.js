// hdc 调用封装：设备侧命令走「长连会话」（PTY 常驻 hdc shell），
// Host 侧命令（file recv / 起桥 / 桥检查）走 ctx.shell 一次性调用。
//
// 背景（详见 docs/01-长连会话设计.md）：
//  · 每次 ctx.shell 调 hdc 都要重新起 hdc→hdcb→真 hdc，固定开销 ~200ms；
//  · 长连会话（lib/session.js）把后续命令压到 ~40ms；
//  · 长连不可用 / 连续异常时自动降级为逐次调用（工具仍可用，只是慢）。
//
// 插件自己的职责（都不碰桥）：设备侧临时文件清理队列、uitest 单例串行化、
// hdc 失败形态识别（exit 0 + [Fail]/[Empty]）。
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeSession,
  configure as configureSession,
  disposeSession,
  ensureSession,
  invalidateSession,
  isDegraded,
  openSession,
  runInSession,
  sessionStatus,
  terminalAvailable,
} from './session.js';

let shellRef = null;
let sessionConfigured = false;
const RELAY_PATH = join(dirname(fileURLToPath(import.meta.url)), 'relay.py');

const SHELL_MISSING =
  'ctx.shell 未挂载：screen-pilot 一律经 DSH 的 shell 服务执行 hdc（不用 node:child_process）。'
  + '请确认 profile 里 bash/subprocess 执行器已启用，重启 DSH 后重试。';

const HOME = process.env.HOME || '';
const DEFAULT_TIMEOUT = 90000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const cleanupQueue = new Set();
let firstShellDone = false;

/** 桥壳可执行文件：$HOME/bin/hdc（不存在时退回 PATH 上的 hdc）。 */
function bridgeBin() {
  const p = join(HOME, 'bin', 'hdc');
  return existsSync(p) ? p : 'hdc';
}

/** 把单个参数安全拼进 shell 命令行（单引号包裹）。 */
function quoteArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** 从 shell 结果里取文本（CollectedOutput | string 两种形态）。 */
function textOf(output) {
  if (output && typeof output === 'object' && typeof output.text === 'string') return output.text;
  return typeof output === 'string' ? output : '';
}

/** 经 ctx.shell 一次性执行一条 Host 侧命令，返回 { out, err, exitCode }。 */
async function runHostCommand(command, opts = {}) {
  if (!shellRef || typeof shellRef.execute !== 'function') throw new Error(SHELL_MISSING);
  const request = {
    command,
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT,
    onExpiry: 'kill',
    stdoutMaxBytes: DEFAULT_MAX_BYTES,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
  };
  const spec = typeof shellRef.resolve === 'function' ? shellRef.resolve(request) : request;
  const handle = await shellRef.execute(spec);
  const result = handle && typeof handle.result === 'function' ? await handle.result() : handle;
  const out = textOf(result && result.stdout);
  const err = textOf(result && result.stderr);
  const exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : 0;
  if (result && (result.timedOut || result.aborted || exitCode !== 0)) {
    const e = new Error('hdc 调用失败: ' + (err.trim() || (result.timedOut ? '超时' : 'exit=' + exitCode)));
    e.stdout = out;
    e.stderr = err;
    e.exitCode = exitCode;
    throw e;
  }
  if (/^\s*\[(Fail|Empty)\]/i.test(out || '')) {
    const e = new Error('hdc 调用失败: ' + String(out).trim());
    e.stdout = out;
    e.stderr = err;
    e.exitCode = 0;
    throw e;
  }
  return { out, err, exitCode };
}

/** 起桥（只在桥不可用时调一次桥自带脚本；不修改桥文件）。 */
async function ensureBridge() {
  try {
    await runHostCommand([bridgeBin(), 'list', 'targets'].map(quoteArg).join(' '), { timeoutMs: 20000 });
    return;
  } catch {
    /* 继续尝试起桥 */
  }
  const bridgeSh = join(HOME, '.hdc-bridge', 'src', 'bridge.sh');
  if (existsSync(bridgeSh)) {
    try {
      await runHostCommand(`sh ${quoteArg(bridgeSh)}`, { timeoutMs: 120000 });
    } catch {
      /* 起桥失败由下面的检查决定 */
    }
  }
  await runHostCommand([bridgeBin(), 'list', 'targets'].map(quoteArg).join(' '), { timeoutMs: 20000 });
}

/** 经 ctx.shell 起 relay 进程（python 自开 PTY），返回常驻 handle；不等待命令结束。 */
async function startRelay(command) {
  if (!shellRef || typeof shellRef.execute !== 'function') throw new Error(SHELL_MISSING);
  const request = {
    command,
    onExpiry: 'none',
    stdoutMaxBytes: 4 * 1024 * 1024,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
  };
  const spec = typeof shellRef.resolve === 'function' ? shellRef.resolve(request) : request;
  return shellRef.execute(spec);
}

/** 懒配置长连会话（依赖注入后第一次使用时）。 */
function ensureSessionConfigured() {
  if (sessionConfigured) return;
  sessionConfigured = true;
  configureSession({
    relayFactory: process.env.SP_DISABLE_RELAY === '1' ? null : startRelay,
    relayPath: RELAY_PATH,
    bridgeBin: bridgeBin(),
    bridgeCheck: ensureBridge,
    log: (...args) => {
      try {
        console.log(...args);
      } catch {
        /* ignore */
      }
    },
  });
}

/** 设置会话参数（空闲/命令/打开超时、会话日志）；可在注入后任意时刻调用。 */
export function setSessionOptions(options = {}) {
  ensureSessionConfigured();
  configureSession({
    idleTimeoutMs: options.idleTimeoutMs,
    commandTimeoutMs: options.commandTimeoutMs,
    openTimeoutMs: options.openTimeoutMs,
    sessionLog: options.sessionLog,
  });
}

/** 注入 ctx.shell（插件入口调用）。 */
export function setShell(shell) {
  shellRef = shell || null;
  ensureSessionConfigured();
}

/** 执行 hdc 子命令（Host 侧一次性），返回 stdout。保留给需要 host 侧 hdc 的场景。 */
export async function hdcRun(args, opts = {}) {
  const command = [bridgeBin(), ...args.map(String)].map(quoteArg).join(' ');
  const { out } = await runHostCommand(command, { timeoutMs: opts.timeoutMs });
  return out;
}

/** 取出清理队列的前缀命令（调用即清空；失败时由调用方决定是否重放）。 */
function takeCleanupPrefix() {
  let prefix = '';
  // 本进程第一次 shell 调用：顺手清掉上一次 Host 运行遗留的临时文件。
  // 只匹配新命名（dsp_<pid>_<ts>_<seq>.<ext>，含 >=3 段），不会误删旧版本
  // dsp_<ts>_<rand>.png / dsp_layout_<ts>.json 这类其它进程可能正在用的文件。
  if (!firstShellDone) {
    firstShellDone = true;
    prefix = 'rm -f /data/local/tmp/dsp_*_*_*; ';
  }
  if (!cleanupQueue.size) return prefix;
  const paths = [...cleanupQueue];
  cleanupQueue.clear();
  return prefix + 'rm -f ' + paths.join(' ') + '; ';
}

/** 登记一个设备侧临时文件，等下一次设备命令时顺带删掉。 */
export function queueCleanup(remotePath) {
  if (remotePath) cleanupQueue.add(remotePath);
}

/** 统一失败判定：非 0 退出 / [Fail] / [Empty] / 桥掉线文本 → 抛错（会话路径与逐次路径一致）。 */
function checkDeviceFailure(out, code) {
  const text = String(out || '');
  const failMatch = /^\s*\[(Fail|Empty)\]/i.test(text);
  const bridgeLost = /Connect failed|Not support|Error opening|没有可连目标/i.test(text);
  if (typeof code === 'number' && code !== 0) {
    const err = new Error('hdc 调用失败: ' + (text.trim() || 'exit=' + code));
    err.stdout = text;
    err.exitCode = code;
    throw err;
  }
  if (failMatch || bridgeLost) {
    const err = new Error('hdc 调用失败: ' + text.trim().slice(0, 300));
    err.stdout = text;
    err.code = 'SESSION_BRIDGE_LOST';
    throw err;
  }
}

/** 设备侧命令：优先长连会话；只有“命令确定没发出去”的错误才允许逐次回退（P0-1）。 */
async function runDeviceCommand(cmd, opts = {}) {
  ensureSessionConfigured();
  if (terminalAvailable() && !isDegraded()) {
    try {
      const r = await runInSession(cmd, { timeoutMs: opts.timeoutMs });
      try {
        checkDeviceFailure(r.out, r.code);
      } catch (e) {
        // 桥掉线/输出失败：拆掉可能已损坏的会话，下一次调用重建；命令本身不重跑。
        await invalidateSession(String(e.message || e)).catch(() => {});
        throw e;
      }
      return r.out;
    } catch (e) {
      const safeToFallback = e && !e.commandSent && !e.sessionBroken
        && (e.code === 'SESSION_DEGRADED' || e.code === 'NO_TERMINAL' || e.code === 'OPEN_FAILED');
      if (!safeToFallback) throw e;
      // 命令尚未发送：退化为逐次调用。
      return (await runHostCommand([bridgeBin(), 'shell', cmd].map(quoteArg).join(' '), opts)).out;
    }
  }
  return (await runHostCommand([bridgeBin(), 'shell', cmd].map(quoteArg).join(' '), opts)).out;
}

/** 长命令（dumpLayout / screenCap / snapshot_display）默认给更长的超时。 */
function timeoutForCommand(cmd) {
  return /dumpLayout|screenCap|snapshot_display/.test(String(cmd)) ? 30000 : undefined;
}

/** hdc shell "<cmd>"（单条字符串命令）；顺带清理已登记的远端临时文件。 */
export async function shell(cmd, opts = {}) {
  const prefix = takeCleanupPrefix();
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : timeoutForCommand(cmd);
  const runOpts = timeoutMs ? { timeoutMs } : {};
  try {
    return await runDeviceCommand(prefix + cmd, runOpts);
  } catch (e) {
    // 命令没跑成，把清理项放回队列，下次再删（prefix 只由本模块生成：rm -f A B; ...）。
    for (const seg of prefix.split(';')) {
      const m = seg.trim().match(/^rm -f (.+)$/);
      if (m) for (const p of m[1].split(/\s+/)) cleanupQueue.add(p);
    }
    throw e;
  }
}

/** hdc shell <arg1> <arg2> ...（参数拼接成一条设备 shell 命令，避免二次转义）。 */
export async function shellArgs(...args) {
  const cmd = args.map((a) => quoteArg(a)).join(' ');
  return runDeviceCommand(cmd);
}

/** 同 shellArgs，但可传 opts（例如输入注入用 retryable:false / 自定义超时）。 */
export async function shellArgsWith(args, opts = {}) {
  const cmd = args.map((a) => quoteArg(a)).join(' ');
  return runDeviceCommand(cmd, opts);
}

/** 执行一条原样的设备 shell 命令（供需要 shell 语法/管道的场景；不重试）。 */
export async function deviceCommand(cmd, opts = {}) {
  return runDeviceCommand(cmd, opts);
}

/** hdc file recv <remote> <local>（Host 侧命令，不能进设备会话）。 */
export async function fileRecv(remote, local) {
  const { out } = await runHostCommand([bridgeBin(), 'file', 'recv', remote, local].map(quoteArg).join(' '));
  if (/\[Fail\]/i.test(out) || !existsSync(local)) {
    throw new Error('file recv 失败: ' + String(out).trim());
  }
  return out;
}

// ── uitest 单例串行化（设备侧 uitest 是单例服务；长连队列本身串行，这里再兜一层）──
let uitestChain = Promise.resolve();

/** 串行执行一条走设备 uitest 服务的 shell 命令。 */
export function uitestShell(cmd) {
  const run = uitestChain.then(() => shell(cmd), () => shell(cmd));
  uitestChain = run.catch(() => {});
  return run;
}

/** 设备侧 uitest 并发撞车的典型报错（可安全重试）。 */
export function isUitestContention(err) {
  return /Wait for subscribe|uitest\.broadcast|reply timeout/i.test(String((err && err.message) || err));
}

/** 临时调试：经 ctx.shell 跑一条 Host 命令，返回 {out, err, exitCode}。 */
export async function debugHost(command, opts = {}) {
  return runHostCommand(command, opts);
}

// ── 长连会话的生命周期入口（供工具层/插件入口使用）──
export {
  closeSession,
  disposeSession,
  ensureSession,
  openSession,
  sessionStatus,
};
