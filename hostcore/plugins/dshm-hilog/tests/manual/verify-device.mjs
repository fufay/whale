#!/usr/bin/env node
// tests/manual/verify-device.mjs —— §6.2 真机验证（**只读**，不做模拟用户操作）。
//
// 为什么要有它：插件装完必须重启 DSH 才会挂载，而重启是用户动作。为了让"代码有没有真的
// 跑通真机"在**安装/重启之前**就有证据，这个脚本用 node:child_process 造一个与
// `ctx.shell` **同形**的接缝（resolve/execute/result/readOutput/kill/status/done），
// 然后把真正的 lib/tools.js 跑起来 —— 也就是说：**跑的是插件本体，只是换了外壳**。
//
// ⚠️ node:child_process 只允许出现在这里（开发/验证工具），插件本体一律走 ctx.shell。
//
// 用法：
//   node tests/manual/verify-device.mjs                # 默认自动挑通道/目标
//   node tests/manual/verify-device.mjs --seconds 10 --tag IMKG
//   node tests/manual/verify-device.mjs --device 5BH0225304025535 --channel via-host
//
// 验收项（对应开发需求文档.md §6.2）：
//   1) hilog_level get ⇒ 返回设备当前级别
//   2) hilog_dump ⇒ 缓冲区有内容
//   3) hilog_capture({seconds, tag}) ⇒ 结束后级别**回到原值**（还原生效的硬证据）
//   4) save:true ⇒ 落盘文件存在，行数与返回摘要一致
//   5) 故意传错 device ⇒ 可读错误 + hdc 原文，不挂死

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { registerTools } from '../../lib/tools.js';
import { normalizeConfig } from '../../lib/ops.js';
import { DEFAULT_VIA_HOST } from '../../lib/hdc.js';

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const seconds = Number(arg('seconds', 10));
const tag = arg('tag', '');
const device = arg('device', '');
const channel = arg('channel', 'auto');
const workspace = arg('workspace', '/storage/Users/currentUser/projects/DSH_Proj');
const outputDir = arg('output', path.join(workspace, 'Build', 'dsh-hilog', 'logs'));

// ── child_process 版 ctx.shell（同形接缝）────────────────────────────────────
function childProcessShell() {
  return {
    resolve: (request) => ({ ...request }),
    async execute(spec) {
      const env = { ...process.env, ...(spec.env || {}) };
      const child = spawn('/bin/sh', ['-c', spec.command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let readOut = 0;
      let readErr = 0;
      let settled = false;
      let status = 'running';
      let exitCode = null;
      let signal = null;
      let timer = null;
      const done = new Promise((res) => {
        const finish = () => { if (!settled) { settled = true; res(); } };
        child.on('error', (e) => { err += `spawn error: ${e.message}`; status = 'killed'; finish(); });
        child.on('close', (code, sig) => {
          exitCode = code; signal = sig;
          status = status === 'killed' ? 'killed' : 'completed';
          if (timer) clearTimeout(timer);
          finish();
        });
        child.stdout.on('data', (d) => { out += d.toString('utf8'); });
        child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      });
      if (spec.onExpiry !== 'none' && Number(spec.timeoutMs) > 0) {
        timer = setTimeout(() => {
          status = 'killed';
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, Number(spec.timeoutMs));
      }
      return {
        get status() { return status; },
        get exitCode() { return exitCode; },
        done,
        readOutput: () => {
          const o = out.slice(readOut); readOut = out.length;
          const e = err.slice(readErr); readErr = err.length;
          const sep = o.length > 0 && !o.endsWith('\n') ? '\n' : '';
          return { delta: o + (e ? `${sep}[stderr]\n${e}` : ''), lossy: false };
        },
        kill: () => { status = 'killed'; try { child.kill('SIGKILL'); } catch { /* ignore */ } return true; },
        result: async () => {
          await done;
          return {
            exitCode, signal, timedOut: !!timer && status === 'killed' && exitCode === null, aborted: false,
            timeoutMs: spec.timeoutMs,
            stdout: { text: out, truncated: false },
            stderr: { text: err, truncated: false },
            sandbox: { mode: 'danger-full-access', denied: false },
          };
        },
      };
    },
  };
}

// ── 装好三个工具（用真插件代码）──────────────────────────────────────────────
const config = normalizeConfig({
  hdcCmd: 'hdc',
  hdcCmdViaHost: DEFAULT_VIA_HOST,
  channel,
  device,
  outputDir,
  seconds,
});
const shell = childProcessShell();
const tools = new Map();
const ctx = {
  logger: { info: (m) => console.log(`  [plugin] ${m}`), warn: (m) => console.log(`  [plugin:warn] ${m}`), debug() {} },
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  inject: (deps, cb) => { if (deps.includes('shell')) cb({ shell }); return () => {}; },
};
registerTools(ctx, { getConfig: () => config, getShell: () => shell });

const run = (name, params, execCtx = {}) => tools.get(name).execute(params, execCtx);
const render = (name, params, r) => tools.get(name).output.render(params, r);
const line = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

const results = [];
const record = (id, name, ok, detail, extra = {}) => {
  results.push({ id, name, ok, detail, ...extra });
  console.log(`${ok ? '✅' : '❌'} [${id}] ${name} — ${detail}`);
};

// ── §6.2-1：读级别 ───────────────────────────────────────────────────────────
line('§6.2-1 hilog_level {action:"get"}');
const level0 = await run('hilog_level', { action: 'get' });
console.log(render('hilog_level', {}, level0));
record('1', 'hilog_level get', level0.ok === true && !!level0.level,
  `device=${level0.device} channel=${level0.channel} level=${level0.level}`,
  { level0 });

if (!level0.ok) {
  console.log('\n设备不可达 ⇒ 后续真机项无法进行（这不是插件缺陷，请按上面的指引开无线调试或起宿主 server）。');
  process.exitCode = 2;
} else {
  // ── §6.2-2：dump ───────────────────────────────────────────────────────────
  line('§6.2-2 hilog_dump（非阻塞取缓冲区，默认 tail 200）');
  const dump = await run('hilog_dump', { lines: 50 });
  console.log(render('hilog_dump', {}, dump));
  record('2', 'hilog_dump 有内容', dump.ok === true && dump.totalEntries > 0,
    `totalEntries=${dump.totalEntries} returned=${dump.returned} globalLevel=${dump.globalLevel}`, { dump });

  // ── §6.2-3：capture + 还原 ────────────────────────────────────────────────
  line(`§6.2-3 hilog_capture {seconds:${seconds}${tag ? `, tag:"${tag}"` : ''}} → 结束必须还原级别`);
  const cap = await run('hilog_capture', { seconds, ...(tag ? { tag } : {}) });
  console.log(render('hilog_capture', {}, cap));
  const levelAfter = await run('hilog_level', { action: 'get' });
  console.log(`（复查）hilog_level get ⇒ ${levelAfter.level}`);
  record('3', 'capture 后级别已还原',
    cap.ok === true && cap.levelAfter === level0.level && levelAfter.level === level0.level,
    `${level0.level} → ${cap.levelSet || level0.level} → ${cap.levelAfter}（复查 ${levelAfter.level}）`,
    { cap, levelAfter });

  // ── §6.2-4：落盘 ───────────────────────────────────────────────────────────
  line('§6.2-4 save:true 落盘文件与摘要一致');
  let fileOk = false;
  let fileDetail = 'no filePath';
  if (cap.filePath) {
    const text = readFileSync(cap.filePath, 'utf8');
    // 文件头是 '#' 注释行（可能多行）⇒ 统计正文行时跳过
    const bodyLines = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).length;
    fileOk = bodyLines === cap.fileLines;
    fileDetail = `${cap.filePath} · 文件 ${bodyLines} 行 / 摘要 fileLines=${cap.fileLines} / 条目 ${cap.totalEntries}`;
  }
  record('4', '落盘存在且行数一致', fileOk, fileDetail);

  // ── §6.2-5：错误 device ───────────────────────────────────────────────────
  line('§6.2-5 故意传错 device ⇒ 可读错误 + hdc 原文（不挂死）');
  const t0 = Date.now();
  const bad = await run('hilog_dump', { device: 'no-such-device-0000' });
  const elapsed = Date.now() - t0;
  console.log(render('hilog_dump', {}, bad));
  record('5', '错误 device 可诊断', bad.ok === false && elapsed < 60000,
    `耗时 ${elapsed}ms · error=${bad.error}`, { bad });
}

// ── 证据落盘 ────────────────────────────────────────────────────────────────
const evidenceDir = path.join(workspace, 'Build', 'dsh-hilog', 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidencePath = path.join(evidenceDir, `device-verify-${stamp}.json`);
writeFileSync(evidencePath, `${JSON.stringify({ at: new Date().toISOString(), config: { ...config, outputDir }, results }, null, 2)}\n`, 'utf8');
console.log(`\n证据：${evidencePath}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\n全部真机项通过 ✅' : `\n有 ${failed.length} 项未通过 ❌`);
process.exitCode = failed.length === 0 ? 0 : 1;
