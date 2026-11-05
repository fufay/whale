// lib/session.js —— UI 自动化长连会话（python relay + 交互式 `hdc shell`）。
//
// 背景（docs/01-长连会话设计.md；审计报告 docs/02-代码审计报告.md）：
//  · 每次 ctx.shell 调 hdc 都要重新起 hdc→hdcb→真 hdc，固定开销 ~200ms；
//  · 长连：ctx.shell 起常驻 python relay（python 自己 pty.fork 跑 `hdc shell`），
//    插件用 unix socket + 换行 JSON 收发命令（Host 里 node-pty 不加载 LD_PRELOAD，不能用 spawnTerminal）；
//  · **命令一旦写进 PTY 就不允许重试**（P0-1）：失败只报错并拆会话，下一条命令再懒重建，
//    绝不把可能已执行的点击/输入再跑一遍；
//  · BUSY 保护（P1-3）：命令执行期间空闲定时器只顺延，不拆会话。
//
// 错误码矩阵：
//   NO_TERMINAL      未注入 relayFactory，命令未发送 → 允许 hdc 层逐次回退
//   OPEN_FAILED      打开会话失败，命令未发送 → 允许逐次回退，并把长连置 degraded
//   SESSION_DEGRADED 已降级，命令未发送 → 允许逐次回退
//   SESSION_CLOSED   显式 close 后/打开期间被 close，命令未发送 → 不回退
//   SESSION_TIMEOUT  命令已写入 PTY 但超时 → 不重试、不回退
//   SESSION_BROKEN   命令已写入 PTY 但链路异常 → 不重试、不回退
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '';
const DEBUG_LOG = join(HOME, 'tmp', 'sp-session.log');
const STATE = Object.freeze({ CLOSED: 'closed', OPENING: 'opening', READY: 'ready', ERROR: 'error' });

const DEFAULT_OPEN_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 60000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;

let relayFactory = null;
let relayPath = '';
let bridgeBin = 'hdc';
let bridgeCheck = null;
let log = null;
let sessionLog = false;

let state = STATE.CLOSED;
let session = null; // { handle, socket, pending, ended, socketPath, pid }
let opening = null;
let queue = Promise.resolve();
let idleTimer = null;
let degraded = false;
let lastError = null;
let lastCommandMs = null;
let openedAt = 0;
let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
let openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS;
let commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
let active = 0; // 在飞/排队中的命令数（BUSY 保护）
let closeGeneration = 0; // 显式 close 代次；排队命令据此判断“close 之后不应再打开”
const stats = { opens: 0, closes: 0, rebuilds: 0, commands: 0 };

const now = () => Date.now();

function debugLog(...args) {
  if (!sessionLog) return;
  try {
    appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  } catch {
    /* ignore */
  }
}

function logEvent(...args) {
  try {
    if (log) log('[screen-pilot/session]', ...args);
  } catch {
    /* ignore */
  }
}

function quoteArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** 注入依赖：relayFactory（经 ctx.shell 起 relay 进程并返回 handle）、relayPath、bridgeCheck。 */
export function configure(options = {}) {
  if (options.relayFactory !== undefined) relayFactory = options.relayFactory || null;
  if (options.relayPath !== undefined) relayPath = options.relayPath || '';
  if (options.bridgeBin !== undefined) bridgeBin = options.bridgeBin || 'hdc';
  if (options.bridgeCheck !== undefined) bridgeCheck = options.bridgeCheck || null;
  if (options.log !== undefined) log = options.log || null;
  if (options.sessionLog !== undefined) sessionLog = !!options.sessionLog;
  if (Number(options.openTimeoutMs) > 0) openTimeoutMs = Number(options.openTimeoutMs);
  if (Number.isFinite(Number(options.idleTimeoutMs)) && Number(options.idleTimeoutMs) >= 0) idleTimeoutMs = Number(options.idleTimeoutMs);
  if (Number(options.commandTimeoutMs) > 0) commandTimeoutMs = Number(options.commandTimeoutMs);
}

/** 长连是否可用（relayFactory 已注入）。 */
export function terminalAvailable() {
  return !!relayFactory;
}

export function isDegraded() {
  return degraded;
}

export function sessionStatus() {
  return {
    state,
    degraded,
    terminalAvailable: terminalAvailable(),
    pid: session ? (session.pid ?? (session.handle ? session.handle.pid ?? null : null)) : null,
    openedAt: openedAt || null,
    idleTimeoutMs,
    lastCommandMs,
    active,
    stats: { ...stats },
    lastError: lastError ? String(lastError.message || lastError) : null,
  };
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function touchIdle() {
  clearIdleTimer();
  if (idleTimeoutMs <= 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // BUSY 保护：命令执行中只顺延，不拆会话。
    if (active > 0) {
      touchIdle();
      return;
    }
    if (state === STATE.READY) closeSession('idle-timeout').catch(() => {});
  }, idleTimeoutMs);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

function markBroken(reason) {
  lastError = reason;
  const s = session;
  session = null;
  if (state === STATE.READY || state === STATE.OPENING) state = STATE.ERROR;
  openedAt = 0;
  if (!s) return;
  s.ended = true;
  for (const w of s.pending) w.reject(reason);
  s.pending.length = 0;
  try {
    s.socket.destroy();
  } catch {
    /* ignore */
  }
}

async function terminateHandle(handle) {
  if (!handle) return;
  try {
    if (typeof handle.kill === 'function') handle.kill();
    else if (typeof handle.terminate === 'function') await handle.terminate();
  } catch {
    /* ignore */
  }
}

/** 确认进程已退出；kill 句柄不可靠时按 pid 补 SIGTERM→SIGKILL（relay 自报 pid）。 */
async function forceKillPid(pid, waitMs = 1200) {
  if (!pid) return;
  const alive = () => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  if (!alive()) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  const deadline = now() + waitMs / 2;
  while (alive() && now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!alive()) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  const hard = now() + waitMs / 2;
  while (alive() && now() < hard) await new Promise((r) => setTimeout(r, 50));
}

/** 清掉上次运行遗留的 relay socket 文件（超过 60s 未清理的）。 */
function cleanupStaleSockets() {
  try {
    const dir = join(HOME, 'tmp');
    for (const name of readdirSync(dir)) {
      if (!/^sp_relay_\d+_[0-9a-f]+\.sock$/.test(name)) continue;
      const p = join(dir, name);
      try {
        if (now() - statSync(p).mtimeMs > 60000) unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 连接 relay 的 unix socket（重试到超时；重试定时器可取消）。 */
function connectSocket(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = now() + timeoutMs;
    let timer = null;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const attempt = () => {
      if (done) return;
      if (now() > deadline) {
        finish(reject, new Error('连接 relay socket 超时'));
        return;
      }
      const socket = net.connect(path);
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        // 保留一个 error 监听，避免 attachReader 之前出现未捕获 error。
        socket.on('error', () => {});
        finish(resolve, socket);
      });
      socket.once('error', () => {
        socket.destroy();
        if (done) return;
        timer = setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function attachReader(s) {
  let buf = '';
  s.socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = s.pending.shift();
      if (waiter) waiter.resolve(msg);
      else logEvent('unexpected message', line.slice(0, 120));
    }
  });
  s.socket.on('error', (e) => {
    markBroken(new Error('会话 socket 错误: ' + (e && e.message ? e.message : e)));
  });
  s.socket.on('close', () => {
    if (!s.ended) markBroken(new Error('会话 socket 关闭'));
  });
}

/** 等一条 JSON 消息（串行队列保证同一时刻只有一个 waiter）。 */
function waitMessage(s, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = s.pending.indexOf(waiter);
      if (i >= 0) s.pending.splice(i, 1);
      reject(new Error('等待超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
    const waiter = {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    if (s.ended) {
      clearTimeout(timer);
      reject(new Error('会话不可用'));
      return;
    }
    s.pending.push(waiter);
  });
}

/** 打开长连：起 relay（ctx.shell）+ 连 socket + 等 ready。失败一律置 degraded（P1-2）。 */
async function openSessionOnce() {
  if (state === STATE.READY && session) return session;
  if (opening) return opening;
  opening = (async () => {
    clearIdleTimer();
    state = STATE.OPENING;
    const gen = closeGeneration;
    try {
      if (!terminalAvailable()) {
        const err = new Error('长连不可用：relayFactory 未注入');
        err.code = 'NO_TERMINAL';
        throw err;
      }
      if (bridgeCheck) await bridgeCheck();
      mkdirSync(join(HOME, 'tmp'), { recursive: true });
      cleanupStaleSockets();
      const socketPath = join(HOME, 'tmp', 'sp_relay_' + process.pid + '_' + randomBytes(4).toString('hex') + '.sock');
      const command = 'python3 -u ' + [relayPath, socketPath, bridgeBin].map(quoteArg).join(' ');
      debugLog('relay start', socketPath);
      const handle = await relayFactory(command);
      const s = { handle, socket: null, pending: [], ended: false, socketPath, pid: null };
      session = s;
      const socket = await connectSocket(socketPath, openTimeoutMs);
      s.socket = socket;
      attachReader(s);
      const ready = await waitMessage(s, openTimeoutMs);
      if (ready.op !== 'ready') throw new Error('relay 未就绪: ' + JSON.stringify(ready).slice(0, 120));
      s.pid = typeof ready.relayPid === 'number' ? ready.relayPid : null;
      // 打开期间被显式 close：立刻收掉，不“复活”。
      if (closeGeneration !== gen) {
        const err = new Error('会话在打开期间被关闭');
        err.code = 'SESSION_CLOSED';
        throw err;
      }
      if (lastError) stats.rebuilds += 1;
      state = STATE.READY;
      openedAt = now();
      stats.opens += 1;
      lastError = null;
      touchIdle();
      debugLog('relay ready');
      return s;
    } catch (e) {
      const err = e || new Error('打开失败');
      if (!err.code) err.code = 'OPEN_FAILED';
      // P1-2：打开失败直接降级，后续命令不再反复重试（显式 ui_session_open 可恢复）。
      if (err.code !== 'SESSION_CLOSED') degraded = true;
      state = STATE.ERROR;
      lastError = err;
      const s = session;
      session = null;
      if (s) {
        try { s.socket && s.socket.destroy(); } catch { /* ignore */ }
        try { await terminateHandle(s.handle); } catch { /* ignore */ }
        await forceKillPid(s.pid);
        try { unlinkSync(s.socketPath); } catch { /* ignore */ }
      }
      throw err;
    } finally {
      opening = null;
    }
  })();
  return opening;
}

export async function ensureSession() {
  if (degraded) {
    const err = new Error('长连已降级为逐次调用');
    err.code = 'SESSION_DEGRADED';
    throw err;
  }
  if (state === STATE.READY && session) return;
  await openSessionOnce();
}

/** 关闭会话（幂等；OPENING 期间也会生效，不会复活）。 */
export async function closeSession(reason = 'manual') {
  closeGeneration += 1;
  clearIdleTimer();
  const s = session;
  session = null;
  if (s) {
    s.ended = true;
    for (const w of s.pending) w.reject(Object.assign(new Error('会话已关闭'), { code: 'SESSION_CLOSED' }));
    s.pending.length = 0;
    try {
      if (s.socket) s.socket.write(JSON.stringify({ op: 'close' }) + '\n');
    } catch { /* ignore */ }
    try {
      if (s.socket) {
        s.socket.end();
        s.socket.destroy();
      }
    } catch { /* ignore */ }
    try { await terminateHandle(s.handle); } catch { /* ignore */ }
    await forceKillPid(s.pid);
    try { unlinkSync(s.socketPath); } catch { /* ignore */ }
    stats.closes += 1;
    logEvent('closed', reason);
  }
  state = STATE.CLOSED;
  openedAt = 0;
}

/** 会话链路失效（供 hdc.js 在检测到 [Fail]/Empty 等桥掉线时调用）。 */
export async function invalidateSession(reason = 'invalidated') {
  markBroken(new Error('会话链路失效: ' + reason));
  const s = session;
  session = null;
  if (s) {
    try { await terminateHandle(s.handle); } catch { /* ignore */ }
    await forceKillPid(s.pid);
    try { unlinkSync(s.socketPath); } catch { /* ignore */ }
  }
}

/** 在会话里执行一条设备命令，返回 { out, code }。命令已写出后不再重试（P0-1）。 */
async function runOnce(cmd, timeoutMs) {
  const s = session;
  if (!s || state !== STATE.READY) {
    const err = new Error('会话未就绪');
    err.code = 'SESSION_BROKEN';
    throw err;
  }
  const id = randomBytes(6).toString('hex');
  s.socket.write(JSON.stringify({ op: 'run', id, cmd: String(cmd), timeoutMs }) + '\n');
  let msg;
  try {
    msg = await waitMessage(s, timeoutMs + 1000);
  } catch (e) {
    const err = new Error('命令超时（可能已在设备侧执行）: ' + String((e && e.message) || e));
    err.code = 'SESSION_TIMEOUT';
    err.commandSent = true;
    throw err;
  }
  if (msg.op === 'error') {
    const err = new Error('设备命令失败: ' + (msg.message || 'unknown'));
    err.code = /timeout/i.test(msg.message || '') ? 'SESSION_TIMEOUT' : 'SESSION_BROKEN';
    err.commandSent = true;
    throw err;
  }
  if (msg.op !== 'result') {
    const err = new Error('relay 协议异常: ' + JSON.stringify(msg).slice(0, 120));
    err.code = 'SESSION_BROKEN';
    err.commandSent = true;
    throw err;
  }
  return { out: msg.out || '', code: typeof msg.code === 'number' ? msg.code : 0 };
}

const SENT_CODES = new Set(['SESSION_TIMEOUT', 'SESSION_BROKEN', 'SESSION_BRIDGE_LOST']);

/** 长连执行入口：串行排队；失败拆会话但不重跑命令（下一条命令懒重建）。 */
export function runInSession(cmd, opts = {}) {
  if (degraded) {
    const err = new Error('长连已降级为逐次调用');
    err.code = 'SESSION_DEGRADED';
    return Promise.reject(err);
  }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : commandTimeoutMs;
  const gen = closeGeneration;
  active += 1;
  const p = queue.then(async () => {
    try {
      if (closeGeneration !== gen) {
        const err = new Error('会话已被显式关闭');
        err.code = 'SESSION_CLOSED';
        throw err;
      }
      await ensureSession();
      if (closeGeneration !== gen) {
        const err = new Error('会话已被显式关闭');
        err.code = 'SESSION_CLOSED';
        throw err;
      }
      const t0 = now();
      const r = await runOnce(cmd, timeoutMs);
      lastCommandMs = now() - t0;
      stats.commands += 1;
      touchIdle();
      return r;
    } catch (e) {
      // 命令是否已写出决定后续动作：已写出 → 拆会话、绝不重跑；未写出 → 交给 hdc.js 决定是否逐次回退。
      const sent = !!(e && (e.commandSent || SENT_CODES.has(e.code)));
      if (sent) {
        await closeSession('broken').catch(() => {});
        e.sessionBroken = true;
      }
      throw e;
    } finally {
      active -= 1;
      if (active === 0 && state === STATE.READY && !degraded) touchIdle();
    }
  });
  queue = p.catch(() => {});
  return p;
}

/** 显式打开（供 ui_session_open）；会清掉 degraded 并重新尝试长连。 */
export async function openSession(options = {}) {
  if (Number.isFinite(Number(options.idleTimeoutMs)) && Number(options.idleTimeoutMs) >= 0) {
    idleTimeoutMs = Number(options.idleTimeoutMs);
  }
  degraded = false;
  state = STATE.CLOSED;
  lastError = null;
  await ensureSession();
  touchIdle();
  return sessionStatus();
}

export async function disposeSession() {
  clearIdleTimer();
  await closeSession('dispose');
}

/** 仅供单测：重置模块状态。 */
export function __resetForTests() {
  clearIdleTimer();
  session = null;
  state = STATE.CLOSED;
  opening = null;
  queue = Promise.resolve();
  degraded = false;
  lastError = null;
  lastCommandMs = null;
  openedAt = 0;
  active = 0;
  closeGeneration = 0;
  for (const k of Object.keys(stats)) stats[k] = 0;
  relayFactory = null;
  relayPath = '';
  bridgeBin = 'hdc';
  bridgeCheck = null;
  log = null;
  sessionLog = false;
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS;
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
}
