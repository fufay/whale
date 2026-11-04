// hdc 调用封装（异步）。
//
// 两条通道：
//  · fast：直接 exec 真 hdc（$HOME/.hdc-bridge/real.path），并注入桥壳的 LD_PRELOAD
//    （$HOME/.hdc-bridge/shim.so）。真机实测每次调用 ~95ms，而经 $HOME/bin/hdc
//    桥壳（hdcb）每次 ~300ms——桥壳每次要做端口发现/连通性自检，属于每次调用的固定税。
//  · shim：$HOME/bin/hdc（hdcb，自动起桥/自愈），原路径；fast 不可用时回退。
// 快通道探测失败会熔断一段时间再重试，绝不因为快通道故障让工具不可用。
//
// 另外维护一个「设备侧临时文件清理队列」：每次 hdc shell 调用把上一次遗留的
// 远端临时文件一起 rm 掉，省掉「capture 后单独 rm」的一次 hdc 往返。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOME = process.env.HOME || '';
const BRIDGE_DIR = join(HOME, '.hdc-bridge');
const DEFAULT_TIMEOUT = 90000;
const MAX_BUFFER = 256 * 1024 * 1024;

/** fast 通道熔断：连续探测失败 3 次后本进程内不再尝试。 */
const FAST_MAX_PROBES = 3;
let fastProbes = 0;
let fastProbeBackoff = 0;
let fastDisabled = false;

let transport = null;
let preparing = null;
const cleanupQueue = new Set();
let firstShellDone = false;

function mode() {
  const v = String(process.env.SCREEN_PILOT_HDC || 'auto').toLowerCase();
  return v === 'shim' || v === 'fast' ? v : 'auto';
}

function shimTransport() {
  const shim = join(HOME, 'bin', 'hdc');
  return { kind: 'shim', bin: existsSync(shim) ? shim : 'hdc', env: process.env, target: null };
}

function fastTransport() {
  try {
    const real = readFileSync(join(BRIDGE_DIR, 'real.path'), 'utf8').trim();
    const preload = join(BRIDGE_DIR, 'shim.so');
    if (!real || !existsSync(real) || !existsSync(preload)) return null;
    const env = { ...process.env };
    env.LD_PRELOAD = env.LD_PRELOAD ? `${preload}:${env.LD_PRELOAD}` : preload;
    return { kind: 'fast', bin: real, env, target: null };
  } catch {
    return null;
  }
}

/** 执行一次 hdc；把子进程错误整理成带 stdout/stderr/exitCode 的 Error。 */
async function execOn(tr, args, timeout) {
  const full = tr.target && (args[0] === 'shell' || args[0] === 'file')
    ? ['-t', tr.target, ...args]
    : args;
  try {
    return await execFileAsync(tr.bin, full, { encoding: 'utf8', timeout, maxBuffer: MAX_BUFFER, env: tr.env });
  } catch (e) {
    const err = new Error('hdc 调用失败: ' + (String(e.stderr || '').trim() || e.message || String(e)));
    err.stdout = e.stdout || '';
    err.stderr = e.stderr || '';
    err.exitCode = typeof e.code === 'number' ? e.code : undefined;
    throw err;
  }
}

async function probeFast() {
  const fast = fastTransport();
  if (!fast) throw new Error('没有可用的 fast 通道（缺少 real.path / shim.so）');
  // 只做一次「有没有可连目标」的短探测；不带 -t（此时还不知道目标）。
  const { stdout } = await execFileAsync(fast.bin, ['list', 'targets'], {
    encoding: 'utf8',
    timeout: 2500,
    maxBuffer: 1024 * 1024,
    env: fast.env,
  });
  const target = String(stdout).trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (!target) throw new Error('fast 通道没有可用目标');
  fast.target = target;
  return fast;
}

/** 选定通道（只在首次以及 fast 熔断恢复后执行一次）。 */
function ensureTransport() {
  if (transport) {
    // fast 曾经熔断：到点后重新探测一次，成功就换回快通道。
    if (!fastDisabled && mode() !== 'shim' && transport.kind === 'shim' && fastProbeBackoff > 0 && Date.now() >= fastProbeBackoff) {
      transport = null;
    } else {
      return transport;
    }
  }
  if (preparing) return preparing;
  preparing = (async () => {
    if (mode() === 'shim' || fastDisabled) {
      transport = shimTransport();
      return transport;
    }
    if (transport && transport.kind === 'fast') return transport;
    try {
      transport = await probeFast();
    } catch {
      fastProbes += 1;
      if (fastProbes >= FAST_MAX_PROBES) {
        fastDisabled = true;
        fastProbeBackoff = 0;
      } else {
        fastProbeBackoff = Date.now() + 15000 * fastProbes; // 15s / 30s 后重试
      }
      transport = shimTransport();
    }
    return transport;
  })().finally(() => { preparing = null; });
  return preparing;
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

/** 登记一个设备侧临时文件，等下一次 hdc shell 调用时顺带删掉。 */
export function queueCleanup(remotePath) {
  if (remotePath) cleanupQueue.add(remotePath);
}

/** 执行 hdc 子命令，返回 stdout（utf8）。失败抛错并携带 stdout/stderr。 */
export async function hdcRun(args, opts = {}) {
  const tr = await ensureTransport();
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  try {
    const r = await execOn(tr, args, timeout);
    return r.stdout;
  } catch (e) {
    if (tr.kind === 'fast') {
      // 快通道单次失败：降级到桥壳并让后续调用冷却后重新探测；本命令不重试，
      // 避免对输入注入等有副作用的命令造成重复执行。
      fastProbeBackoff = Date.now() + 30000;
      transport = shimTransport();
      e.message += '（快通道失败，后续调用改用桥壳：' + tr.bin + '）';
    }
    throw e;
  }
}

/** hdc shell "<cmd>"（单条字符串命令）；顺带清理已登记的远端临时文件。 */
export async function shell(cmd) {
  const prefix = takeCleanupPrefix();
  try {
    return await hdcRun(['shell', prefix + cmd]);
  } catch (e) {
    // 命令没跑成，把清理项放回队列，下次再删（prefix 只由本模块生成：rm -f A B; ...）。
    for (const seg of prefix.split(';')) {
      const m = seg.trim().match(/^rm -f (.+)$/);
      if (m) for (const p of m[1].split(/\s+/)) cleanupQueue.add(p);
    }
    throw e;
  }
}

/** hdc shell <arg1> <arg2> ...（参数自动拼接，避免二次转义）。 */
export async function shellArgs(...args) {
  return hdcRun(['shell', ...args.map(String)]);
}

// ── uitest 单例串行化 ──
// 设备侧 uitest 是单例服务（内部走 broadcast 等 reply）：两个 uitest 命令同时发会撞车，
// 实测表现为 `DumpLayout failed:Wait for subscribe uitest.broadcast.command.reply timeout`。
// 插件内部所有 uitest 命令（dumpLayout / screenCap）都经这个互斥队列串行发出；
// 异步化带来的并行只保留在「非 uitest」操作之间（snapshot_display / hidumper / file recv 等）。
let uitestChain = Promise.resolve();

/** 串行执行一条会走设备 uitest 服务的 shell 命令。 */
export function uitestShell(cmd) {
  const run = uitestChain.then(() => shell(cmd), () => shell(cmd));
  uitestChain = run.catch(() => {});
  return run;
}

/** 设备侧 uitest 并发撞车的典型报错（可安全重试一次）。 */
export function isUitestContention(err) {
  return /Wait for subscribe|uitest\.broadcast|reply timeout/i.test(String((err && err.message) || err));
}

/** hdc file recv <remote> <local>。注意：hdc 对不存在的远端文件也返回 0，故双重校验。 */
export async function fileRecv(remote, local) {
  const out = await hdcRun(['file', 'recv', remote, local]);
  if (/\[Fail\]/i.test(out) || !existsSync(local)) {
    throw new Error('file recv 失败: ' + String(out).trim());
  }
  return out;
}
