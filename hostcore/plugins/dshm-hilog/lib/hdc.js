// lib/hdc.js —— hdc 调用层：双通道自动探测 + 只挑 Connected 目标 + 命令执行接缝。
//
// 本层**不做 I/O 决策**：所有执行都通过注入的 `exec` / `execStream` 进行（真机上由
// ctx.shell 接缝提供，单测里由假执行器提供）⇒ 可离线单测，也保证"一律走 ctx.shell、
// 绝不用 node:child_process"这条硬约束落在唯一一处。
//
// 双通道的由来（开发需求文档.md §4.3，2026-10-15 实测把结论钉死）：
//   · bridge   = `Config.hdcCmd`（默认 `hdc`，本机是自动过桥转发器）⇒ 只能看到**无线调试**
//                暴露的 TCP 目标（本机 PC 自测走这条）。
//   · via-host = `Config.hdcCmdViaHost`（默认 hdc-via-host.sh）⇒ 借宿主 hdc server
//                （127.0.0.1:18710），这是抓 **USB 手机/平板** 的唯一现实通路。
//   · 两条通道互相看不见对方的目标 ⇒ 插件必须自己探测，并把"走的哪条"写进返回值。

import {
  buildHdcShellCommand, buildListTargetsCommand, connectedTargets, filterNoiseLines, parseTargets, pickTarget, toArray,
} from './hilog.js';

/** 通道名。 */
export const CHANNELS = ['bridge', 'via-host'];

/** 默认的 via-host 命令（本机实测可用路径；不存在时该通道会被跳过并给出原因）。 */
export const DEFAULT_VIA_HOST =
  'sh /storage/Users/currentUser/projects/DSH_Proj/DSHM问题汇总与解决/hdc-bridge/hdc-via-host.sh';

/** 宿主 hdc server 保活脚本（指引文案用）。 */
export const HOST_KEEPALIVE =
  'sh /storage/Users/currentUser/projects/DSH_Proj/DSHM问题汇总与解决/hdc-bridge/host-server-keepalive.sh --daemon';

/**
 * 取某条通道要执行的命令。
 *
 * @param cfg 已归一化的配置
 * @param channel 'bridge' | 'via-host'
 * @returns {{channel, cmd, reason}} —— cmd 为 null 时 reason 说明该通道为什么不可用
 */
export function channelCommand(cfg = {}, channel) {
  if (channel === 'bridge') {
    const cmd = String(cfg.hdcCmd || 'hdc').trim();
    return cmd ? { channel, cmd, reason: '' } : { channel, cmd: null, reason: '未配置 hdcCmd' };
  }
  if (channel === 'via-host') {
    const cmd = String(cfg.hdcCmdViaHost || '').trim();
    return cmd ? { channel, cmd, reason: '' } : { channel, cmd: null, reason: '未配置 hdcCmdViaHost' };
  }
  return { channel, cmd: null, reason: `未知通道：${channel}` };
}

/** 通道 → 可读标签（返回值里给用户看）。 */
export function channelLabel(channel) {
  if (channel === 'bridge') return 'bridge（桥/无线调试）';
  if (channel === 'via-host') return 'via-host（借宿主 hdc server）';
  return String(channel);
}

/** 在某条通道上跑 `list targets -v`。 */
export async function listTargetsOn(exec, { cmd, timeoutMs, signal }) {
  const command = buildListTargetsCommand(cmd);
  const r = await exec(command, { timeoutMs, signal });
  const parsed = parseTargets(r.stdout);
  return {
    command,
    raw: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    exitCode: r.exitCode,
    timedOut: !!r.timedOut,
    aborted: !!r.aborted,
    ...parsed,
  };
}

/**
 * 解析目标：按通道顺序探测，返回第一个能给出**唯一可判定目标**的通道。
 *
 * 规则（与 §4.3 的三条硬要求一致）：
 *   1. 调用方给了 `device` ⇒ 只认这个 key，且状态必须是 Connected；
 *      当前通道里没有它就换下一条通道（USB 手机在桥里根本不可见）。
 *   2. 没给 `device` ⇒ 该通道里恰好 1 个 Connected 就用它；0 个换通道；>1 个报错（不猜）。
 *   3. 两条通道都没有 ⇒ 返回结构化失败 + 逐通道 `list targets -v` 原文 + 明确指引。
 *
 * @returns {{ok, channel, cmd, target, tried, stderr, guidance, error}}
 */
export async function resolveTarget(exec, { cfg = {}, device = '', channel = 'auto', timeoutMs, signal } = {}) {
  const explicit = String(channel || 'auto').trim();
  const order = explicit && explicit !== 'auto' ? [explicit] : CHANNELS.slice();
  const tried = [];
  const wantsDevice = String(device || '').trim();

  for (const ch of order) {
    const { cmd, reason } = channelCommand(cfg, ch);
    if (!cmd) {
      tried.push({ channel: ch, ok: false, error: reason, connected: [], targetsRaw: '' });
      continue;
    }
    let r;
    try {
      r = await listTargetsOn(exec, { cmd, timeoutMs, signal });
    } catch (e) {
      tried.push({
        channel: ch,
        ok: false,
        error: `执行 ${cmd} 失败：${(e && e.message) || e}`,
        spawnFailed: true,
        connected: [],
        targetsRaw: '',
      });
      continue;
    }
    const connected = connectedTargets(r.targets);
    const entry = {
      channel: ch,
      cmd,
      ok: false,
      error: '',
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      connected: connected.map((t) => t.key),
      targets: r.targets.map((t) => t.raw),
      targetsRaw: r.raw,
      stderr: (r.stderr || '').trim(),
      noise: r.noise,
    };
    const { target, reason: pickReason } = pickTarget(r.targets, wantsDevice);
    if (target) {
      entry.ok = true;
      tried.push(entry);
      return { ok: true, channel: ch, cmd, target, targets: r.targets, targetsRaw: r.raw, tried };
    }
    entry.error = pickReason;
    tried.push(entry);
  }

  const parts = [];
  for (const t of tried) {
    const head = `${channelLabel(t.channel)}：${t.error || '不可用'}`;
    const detail = t.targetsRaw ? `\n  list targets -v:\n${indent(t.targetsRaw, '    ')}` : '';
    const noise = toArray(t.noise).length ? `\n  提示：${t.noise.join(' / ')}` : '';
    const err = t.stderr ? `\n  stderr: ${t.stderr}` : '';
    parts.push(head + detail + noise + err);
  }
  // 全部通道都"命令都跑不起来"（ctx.shell 未挂载 / hdc 不在 PATH / 桥脚本缺失）⇒ 别误报成"设备不在线"
  const allExecFailed = tried.length > 0 && tried.every((t) => t.spawnFailed);
  const guidance = allExecFailed
    ? '两条通道的命令都执行不了 ⇒ 这通常不是设备问题，而是执行通道问题：'
      + '① ctx.shell 未挂载（profile 里 bash/pwsh 执行器或 subprocess 被禁）；'
      + '② `hdc` 不在 PATH（本机应在 /data/storage/el2/base/haps/entry/files/bin）；'
      + '③ via-host 脚本不存在（检查 Config.hdcCmdViaHost）。'
    : wantsDevice
    ? `指定目标 "${wantsDevice}" 在两条通道里都不是 Connected。请确认：① 本机 PC：无线调试已开；② USB 手机/平板：宿主在跑 hdc server（${HOST_KEEPALIVE}）。`
    : `没有可用的 Connected 目标。本机 PC 自测请打开「设置 → 开发者选项 → 无线调试」；抓 USB 手机/平板请先在宿主跑 ${HOST_KEEPALIVE}（或 hdc kill; hdc -s 127.0.0.1:18710 start）。`;
  return {
    ok: false,
    channel: null,
    cmd: null,
    target: null,
    tried,
    error: allExecFailed
      ? `两条通道的命令都执行不了：${tried.map((t) => t.error).join(' | ')}`
      : `两条通道都没有可用的 Connected 目标${wantsDevice ? `（device="${wantsDevice}"）` : ''}`,
    details: parts.join('\n'),
    guidance,
  };
}

function indent(text, pad) {
  return String(text || '').split('\n').map((l) => pad + l).join('\n');
}

/** 构造"在目标设备上执行某条命令"的完整命令行。 */
export function deviceCommandLine(cmd, target, deviceCommand) {
  return buildHdcShellCommand(cmd, target, deviceCommand);
}

/**
 * 一次性执行（阻塞到结束）：dump / 级别读写 / 目标列举都走它。
 * @returns {{stdout, stderr, exitCode, timedOut, aborted, command, spillPath}}
 */
export async function runOnce(exec, { cmd, target, deviceCommand, timeoutMs, stdoutMaxBytes, signal, env }) {
  const command = deviceCommandLine(cmd, target, deviceCommand);
  const r = await exec(command, { timeoutMs, stdoutMaxBytes, signal, env, onExpiry: 'kill' });
  return {
    command,
    stdout: String(r.stdout || ''),
    // stderr 也过一遍噪声过滤：via-host 的 shim 提示行不该被当成 hdc 报错
    stderr: filterNoiseLines(String(r.stderr || '')),
    exitCode: r.exitCode === undefined ? null : r.exitCode,
    timedOut: !!r.timedOut,
    aborted: !!r.aborted || !!(signal && signal.aborted),
    spillPath: r.spillPath || null,
  };
}

/**
 * 流式执行：capture 用它（边跑边读，天然不怕 512KB 缓冲区滚动）。
 *
 * `execStream(command, opts)` 返回一个句柄：
 *   `{read(): {delta, lossy, spillPath}, kill(), status(), done: Promise, result(): Promise}`
 * 缺 `read` 时调用方退化为 `await result()`（等价于阻塞式抓取，仍受超时约束）。
 */
export async function runStream(execStream, { cmd, target, deviceCommand, timeoutMs, stdoutMaxBytes, signal, env, onExpiry = 'kill' }) {
  const command = deviceCommandLine(cmd, target, deviceCommand);
  const handle = await execStream(command, { timeoutMs, stdoutMaxBytes, signal, env, onExpiry });
  return { command, handle };
}
