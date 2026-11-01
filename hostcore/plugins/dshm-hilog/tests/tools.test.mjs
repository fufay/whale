// tests/tools.test.mjs —— 端到端（假 ctx + 假 ctx.shell 接缝）：
// 三个工具的注册形状、级别还原（含异常路径）、dump 截断、capture 落盘与还原。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { registerTools, saveLog, shellAdapters } from '../lib/tools.js';
import { normalizeConfig } from '../lib/ops.js';
import { DEFAULT_TARGETS, fakeCtx, fakeDevice, fakeShell, freshLines, SAMPLE_LINES, SHIM_NOISE } from './helpers/fake-shell.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'dsh-hilog-test-'));

/** 建一个装好三个工具的假 ctx，并返回工具表。 */
function setup({ device = fakeDevice(), cfg = {}, shellOpts = {} } = {}) {
  const shell = fakeShell(device, shellOpts);
  const { ctx, tools } = fakeCtx(shell);
  const config = normalizeConfig({ pollMs: 5, timeoutMs: 2000, listTimeoutMs: 2000, ...cfg });
  registerTools(ctx, { getConfig: () => config, getShell: () => shell });
  return { device, shell, tools, config, exec: (name, params, execCtx = {}) => tools.get(name).execute(params, execCtx) };
}

test('注册形状：三个工具 + 必需参数 + 输出 render', () => {
  const { tools } = setup();
  assert.deepEqual([...tools.keys()], ['hilog_level', 'hilog_dump', 'hilog_capture']);
  for (const def of tools.values()) {
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 30);
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.execute, 'function');
    assert.equal(typeof def.output.render, 'function');
    assert.ok(def.timeoutMs > 0);
  }
  assert.deepEqual(tools.get('hilog_capture').parameters.properties.seconds.type, 'number');
  assert.ok(tools.get('hilog_dump').parameters.properties.tag);
});

test('hilog_level get：读设备级别（真机默认 W）', async () => {
  const { exec } = setup();
  const r = await exec('hilog_level', { action: 'get' });
  assert.equal(r.ok, true);
  assert.equal(r.level, 'W');
  assert.equal(r.device, '127.0.0.1:45071');
  assert.equal(r.channel, 'bridge');
});

test('hilog_level set：默认"设完即还原"，设备最终必须回到 W', async () => {
  const { exec, device } = setup();
  const r = await exec('hilog_level', { action: 'set', level: 'D' });
  assert.equal(r.ok, true);
  assert.equal(r.before, 'W');
  assert.equal(r.set, 'D');
  assert.equal(r.after, 'W');
  assert.equal(r.restored, true);
  assert.equal(device.level, 'W', '设备必须已被还原');
  assert.deepEqual(device.levelSets, ['D', 'W']);
});

test('hilog_level set keep:true：保留新级别 + 给出还原指引（设备停在 D）', async () => {
  const { exec, device } = setup();
  const r = await exec('hilog_level', { action: 'set', level: 'D', keep: true });
  assert.equal(r.ok, true);
  assert.equal(r.keep, true);
  assert.equal(device.level, 'D');
  assert.match(r.note, /restore/);
  // 收尾：action:"restore" 不传 level 时用插件记住的原值
  const back = await exec('hilog_level', { action: 'restore' });
  assert.equal(back.ok, true);
  assert.equal(device.level, 'W');
});

test('hilog_level：设置那一步 hdc 报错 ⇒ 仍然把级别还原（try/finally 的硬证据）', async () => {
  const device = fakeDevice();
  const { ctx, tools } = fakeCtx();
  const shell = {
    resolve: (r) => r,
    execute: async (spec) => {
      const c = spec.command;
      if (c.includes('list targets')) return settled(`${DEFAULT_TARGETS}\n`);
      if (c.includes('param get')) return settled(`${device.level} \n`);
      const set = /hilog -b ([DIWEF])/.exec(c);
      if (set) {
        if (set[1] === 'D') throw new Error('hdc 中途断线（测试用）');
        device.level = set[1];
        device.levelSets.push(set[1]);
        return settled(`Set global log level to ${set[1]} successfully\n`);
      }
      return settled('');
    },
  };
  registerTools(ctx, { getConfig: () => normalizeConfig({ pollMs: 5 }), getShell: () => shell });
  const r = await tools.get('hilog_level').execute({ action: 'set', level: 'D' });
  assert.equal(r.ok, false);
  assert.match(r.error, /设置级别失败/);
  assert.equal(device.level, 'W', '异常路径也必须还原');
  assert.deepEqual(device.levelSets, ['W'], '设置失败 ⇒ 只有 finally 里那次还原动作');
});

test('hilog_level：读回校验失败（设备回的不是我要的级别）⇒ 报"未生效"并还原', async () => {
  const device = fakeDevice();
  const { ctx, tools } = fakeCtx();
  let reads = 0;
  const shell = {
    resolve: (r) => r,
    execute: async (spec) => {
      const c = spec.command;
      if (c.includes('list targets')) return settled(`${DEFAULT_TARGETS}\n`);
      if (c.includes('param get')) {
        reads += 1;
        // 第 2 次读（设置后的校验）故意回一个不同的值
        if (reads === 2) return settled('W \n');
        return settled(`${device.level} \n`);
      }
      const set = /hilog -b ([DIWEF])/.exec(c);
      if (set) { device.level = set[1]; device.levelSets.push(set[1]); return settled(`Set global log level to ${set[1]} successfully\n`); }
      return settled('');
    },
  };
  registerTools(ctx, { getConfig: () => normalizeConfig({ pollMs: 5 }), getShell: () => shell });
  const r = await tools.get('hilog_level').execute({ action: 'set', level: 'D' });
  assert.equal(r.ok, false);
  assert.match(r.error, /设置级别未生效/);
  assert.equal(device.level, 'W', '校验失败也要还原');
});

test('hilog_dump：默认 tail 截断 + 结构化字段 + 设备级别提示', async () => {
  const { exec } = setup();
  const r = await exec('hilog_dump', { lines: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.totalEntries, SAMPLE_LINES.length);
  assert.equal(r.returned, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.order, 'tail');
  // tail ⇒ 最后两条（保序）
  assert.equal(r.entries[0].tag, 'call_reporter');
  assert.equal(r.entries[1].pid, 47645);
  assert.equal(r.entries[1].level, 'E');
  assert.equal(r.globalLevel, 'W');
  assert.match(r.hint, /save:true/);
  assert.equal(r.filePath, undefined, '默认不落盘');
});

test('hilog_dump：order=head / tag 过滤 / save 落盘行数一致', async () => {
  const dir = tmp();
  try {
    const { exec } = setup({ cfg: { outputDir: dir } });
    const head = await exec('hilog_dump', { lines: 2, order: 'head' });
    assert.deepEqual(head.entries.map((e) => e.pid), [4051, 13646]);

    const tagged = await exec('hilog_dump', { tag: 'PARAM' });
    assert.equal(tagged.totalEntries, 1);
    assert.equal(tagged.entries[0].msg, 'Forbid to access parameter hilog.debug.on');

    const saved = await exec('hilog_dump', { save: true, lines: 100 });
    assert.ok(saved.filePath, 'save:true 必须给出 filePath');
    assert.ok(existsSync(saved.filePath));
    const text = readFileSync(saved.filePath, 'utf8');
    assert.equal(saved.fileLines, SAMPLE_LINES.length);
    assert.equal(text.split('\n').filter((l, i) => i > 0 && l !== '').length, SAMPLE_LINES.length);
    assert.match(text.split('\n')[0], /^# dsh-hilog dump/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hilog_dump：级别过滤比设备级别更低时给出 levelHint（"W 时 I/D 根本没进缓冲区"）', async () => {
  const { exec } = setup({ shellOpts: { dumpStdout: '' } });
  const r = await exec('hilog_dump', { level: 'I' });
  assert.equal(r.globalLevel, 'W');
  assert.match(r.levelHint, /hilog_capture/);
  assert.match(r.hint, /缓冲区/);
});

test('hilog_capture：流式抓取 + 提级别 + 结束后还原（设备状态可断言）', async () => {
  const dir = tmp();
  try {
    const { exec, device } = setup({
      device: fakeDevice({ captureLines: freshLines(3, { tag: 'IMKG' }) }),   // sinceNow 只留"当下"的行
      cfg: { outputDir: dir, seconds: 1, pollMs: 5 },
    });
    const r = await exec('hilog_capture', { seconds: 1, tag: 'IMKG' });
    assert.equal(r.ok, true);
    assert.equal(r.levelBefore, 'W');
    assert.equal(r.levelSet, 'I');
    assert.equal(r.levelAfter, 'W');
    assert.equal(r.restored, true);
    assert.equal(device.level, 'W', '设备级别必须已还原');
    assert.deepEqual(device.levelSets, ['I', 'W']);
    assert.ok(r.totalEntries >= 1);
    assert.ok(r.entries.some((e) => e.tag === 'IMKG'));
    // 设备侧命令带 timeout（本地被杀也不留孤儿）+ 在目标上执行
    const cap = device.calls.find((c) => c.includes('timeout') && c.includes('hilog'));
    assert.ok(cap, '应当有 timeout N hilog 命令');
    assert.match(cap, /-t 127\.0\.0\.1:45071 shell /);
    assert.match(cap, /-L I,W,E,F/);
    // 落盘（capture 默认 true）
    assert.ok(r.filePath);
    assert.ok(existsSync(r.filePath));
    assert.ok(r.fileLines >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hilog_capture：抓够 maxLines 提前收手 + 落盘内容与 totalEntries 一致', async () => {
  const dir = tmp();
  try {
    const { exec } = setup({
      device: fakeDevice({ captureLines: freshLines(5) }),   // 提前收手只数"新日志" ⇒ 时间戳必须是当下
      cfg: { outputDir: dir, seconds: 5, pollMs: 5 },
      shellOpts: { clockSkewMs: 0 },
    });
    const r = await exec('hilog_capture', { seconds: 5, maxLines: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.killedEarly, true);
    // 收尾会把 kill 之后残留在管道里的输出读干净 ⇒ 收集数可能略超 maxLines，但返回条数被截住
    assert.ok(r.totalEntries >= 2, `totalEntries=${r.totalEntries}`);
    assert.equal(r.returned, 2);
    assert.equal(device_line_count(r.filePath), r.totalEntries, '落盘行数必须与摘要一致');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function device_line_count(file) {
  // 文件头是 '#' 注释行（可能多行），正文才是日志
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).length;
}

test('hilog_capture：接缝没有 readOutput（老实现）⇒ 退化为阻塞抓取，不空等到超时', async () => {
  const device = fakeDevice({ captureLines: freshLines(3) });
  const { ctx, tools } = fakeCtx();
  const shell = {
    resolve: (r) => r,
    execute: async (spec) => {
      const c = spec.command;
      if (c.includes('list targets')) return settled(`${DEFAULT_TARGETS}\n`);
      if (c.includes('date +%s')) return settled(`${Math.floor(Date.now() / 1000)}\n`);
      if (c.includes('param get')) return settled(`${device.level} \n`);
      const set = /hilog -b ([DIWEF])/.exec(c);
      if (set) { device.level = set[1]; device.levelSets.push(set[1]); return settled(`ok\n`); }
      // 没有 readOutput 的句柄：只能 result()
      return {
        status: 'completed',
        exitCode: 0,
        done: Promise.resolve(),
        kill: () => false,
        result: async () => ({
          exitCode: 0, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: `${device.captureLines.join('\n')}\n`, truncated: false },
          stderr: { text: '', truncated: false },
        }),
      };
    },
  };
  registerTools(ctx, { getConfig: () => normalizeConfig({ pollMs: 5, seconds: 1, captureSave: false }), getShell: () => shell });
  const r = await tools.get('hilog_capture').execute({ seconds: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.readFallback, true);
  assert.equal(r.totalEntries, 3);
  assert.equal(device.level, 'W', '兜底路径也必须还原级别');
});

test('hilog_capture：流式读取抛异常也要还原级别 + 如实报错', async () => {
  const device = fakeDevice();
  const { ctx, tools } = fakeCtx();
  const shell = fakeShell(device, { readThrowsOnCall: 2 });
  registerTools(ctx, {
    getConfig: () => normalizeConfig({ pollMs: 5, seconds: 1, captureSave: false }),
    getShell: () => shell,
  });
  const r = await tools.get('hilog_capture').execute({ seconds: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /readOutput 爆炸/);
  assert.equal(device.level, 'W', '异常路径也必须还原级别');
  assert.deepEqual(device.levelSets, ['I', 'W']);
});

test('hilog_capture：信号取消（abort）⇒ 杀进程 + 还原级别', async () => {
  const device = fakeDevice();
  const { ctx, tools } = fakeCtx();
  const shell = fakeShell(device);
  registerTools(ctx, {
    getConfig: () => normalizeConfig({ pollMs: 5, seconds: 5, captureSave: false }),
    getShell: () => shell,
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const r = await tools.get('hilog_capture').execute({ seconds: 5 }, { signal: ac.signal });
  assert.equal(device.level, 'W', '取消也要还原级别');
  assert.ok(r.notes.some((n) => n.includes('被取消')));
});

test('hilog_capture：via-host 的 shim 提示行（打在 stderr 上）不算失败、也不进 stderr 字段', async () => {
  const dir = tmp();
  try {
    const device = fakeDevice({ captureLines: freshLines(2) });
    const { ctx, tools } = fakeCtx();
    // 只给 shim 噪声（打在 stderr 上），不给"真 stderr" ⇒ 后者才是失败判据
    const shell = fakeShell(device, { shimStderr: SHIM_NOISE });
    registerTools(ctx, { getConfig: () => normalizeConfig({ pollMs: 5, seconds: 1, outputDir: dir }), getShell: () => shell });
    const r = await tools.get('hilog_capture').execute({ seconds: 1 });
    assert.equal(r.ok, true, `不该因为 shim 噪声把成功抓取标成失败：${r.error || ''}`);
    assert.equal(r.totalEntries, 2);
    assert.equal(r.stderr, undefined, 'shim 行必须被过滤掉');
    assert.equal(r.levelAfter, 'W');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hilog_capture：真的 hdc 报错（非噪声）仍然算失败并带原文', async () => {
  const { ctx, tools } = fakeCtx();
  const device = fakeDevice({ captureLines: [] });
  const shell = fakeShell(device, { stderrMarker: true, stderrText: 'hilog: Invalid log level [CODE: -2]' });
  registerTools(ctx, { getConfig: () => normalizeConfig({ pollMs: 5, seconds: 1, captureSave: false }), getShell: () => shell });
  const r = await tools.get('hilog_capture').execute({ seconds: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid log level/);
  assert.equal(device.level, 'W');
});

test('hilog_capture：设备时钟快 1 小时 ⇒ 按精确偏移校正，新日志仍然留得住（不靠"猜"）', async () => {
  const OFFSET = 3600 * 1000;
  const dir = tmp();
  try {
    const { exec } = setup({
      device: fakeDevice({ captureLines: freshLines(3, { nowMs: Date.now() + OFFSET }) }),
      shellOpts: { clockSkewMs: OFFSET },
      cfg: { outputDir: dir, seconds: 1, pollMs: 5 },
    });
    const r = await exec('hilog_capture', { seconds: 1 });
    assert.equal(r.totalEntries, 3, '时钟偏移必须被校正，否则会把新日志误判成历史');
    assert.equal(r.filteredOut, 0);
    assert.ok(Math.abs(r.deviceClockSkewMs - 3600000) < 5000, `deviceClockSkewMs=${r.deviceClockSkewMs}`); // 秒级精度，允许 5s 内误差
    assert.ok(r.notes.some((n) => n.includes('设备时钟与宿主相差')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hilog_capture：restoreLevel:false 时不还原（但仍然记录 before/after）', async () => {
  const { exec, device } = setup({ cfg: { captureSave: false, seconds: 1, pollMs: 5 } });
  const r = await exec('hilog_capture', { seconds: 1, restoreLevel: false });
  assert.equal(r.ok, true);
  assert.equal(device.level, 'I');
  assert.equal(r.restored, null);
  assert.equal(r.levelAfter, 'I');
});

test('hilog_capture：没抓到日志时给出"设备可能息屏/冻结"的提示（而不是假装成功）', async () => {
  const dir = tmp();
  try {
    const { exec } = setup({
      device: fakeDevice({ captureLines: [] }),
      cfg: { outputDir: dir, seconds: 1, pollMs: 5 },
    });
    const r = await exec('hilog_capture', { seconds: 1, tag: 'NoSuchTag' });
    assert.equal(r.totalEntries, 0);
    assert.ok(r.notes.some((n) => n.includes('息屏') || n.includes('冻结')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hilog_capture：stderr 段不会污染日志解析（ctx.shell 会把 stderr 混进 delta）', async () => {
  const dir = tmp();
  try {
    const { exec } = setup({
      device: fakeDevice({ captureLines: freshLines(2) }),
      shellOpts: { stderrMarker: true },
      cfg: { outputDir: dir, seconds: 1, pollMs: 5 },
    });
    const r = await exec('hilog_capture', { seconds: 1 });
    assert.equal(r.totalEntries, 2);
    assert.match(r.stderr, /测试用 stderr/);
    assert.ok(!r.entries.some((e) => String(e.msg).includes('测试用 stderr')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('设备挑不出来时：返回可读错误 + 逐通道原文 + 指引（不挂死、不抛异常）', async () => {
  const { exec } = setup({ device: fakeDevice({ targets: '127.0.0.1:10178\t\tTCP\tOffline\tunknown...' }) });
  const r = await exec('hilog_dump', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /Connected/);
  assert.match(r.guidance, /无线调试/);
  assert.ok(r.channels.length >= 1);
  assert.match(r.channels[0].targetsRaw, /Offline/);
});

test('指定了不存在的 device：错误信息里带上它 + hdc stderr 原样透传', async () => {
  const { exec } = setup();
  const r = await exec('hilog_level', { action: 'get', device: 'no-such-device' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no-such-device/);
});

test('render：模型看到的是可读文本（含通栏头、级别行、日志行、提示）', async () => {
  const { exec, tools } = setup();
  const r = await exec('hilog_dump', { lines: 1 });
  const text = tools.get('hilog_dump').output.render({}, r)[0].text;
  assert.match(text, /^\[dsh-hilog\] hilog_dump · ok · device=127\.0\.0\.1:45071 · channel=bridge/);
  assert.match(text, /条目: 共 5 条，返回 1 条（已截断，丢弃 4）/);
  assert.match(text, /^10-15 10:53:39\.771 47645 47645 E C02C02\/PARAM: Forbid/m);
  assert.match(text, /提示: /);

  const bad = await exec('hilog_level', { action: 'get', device: 'nope' });
  const badText = tools.get('hilog_level').output.render({}, bad)[0].text;
  assert.match(badText, /hilog_level · 失败/);
  assert.match(badText, /指引: /);
});

test('shellAdapters：请求形状符合 ctx.shell 契约（stdoutMaxBytes/onExpiry/sandboxPolicy）', async () => {
  let seen = null;
  const shell = {
    resolve: (r) => ({ ...r, resolved: true }),
    execute: async (spec) => {
      seen = spec;
      return { result: async () => ({ exitCode: 0, stdout: { text: 'ok' }, stderr: { text: '' }, timedOut: false }) };
    },
  };
  const cfg = normalizeConfig({ timeoutMs: 1234, stdoutMaxBytes: 4096 });
  const { exec } = shellAdapters(shell, cfg);
  const r = await exec('echo hi', {});
  assert.equal(r.stdout, 'ok');
  assert.equal(r.exitCode, 0);
  assert.equal(seen.resolved, true);
  assert.equal(seen.timeoutMs, 1234);
  assert.equal(seen.onExpiry, 'kill');
  assert.equal(seen.stdoutMaxBytes, 4096);
  assert.equal(seen.sandboxPolicy.mode, 'danger-full-access');
});

test('shellAdapters：ctx.shell 未挂载 ⇒ 明确报错（指向 shell 服务，而不是静默失败）', async () => {
  const { exec } = shellAdapters(null, normalizeConfig({}));
  await assert.rejects(() => exec('hdc -v', {}), /ctx\.shell 接缝未挂载/);
});

test('saveLog：落盘到默认目录（<cwd>/Build/dsh-hilog/logs）并可读回', async () => {
  const dir = tmp();
  try {
    const cfg = normalizeConfig({});
    const r = await saveLog({ cfg, cwd: dir }, { prefix: 'capture', tag: 'My Tag/x', header: '# h', body: 'l1\nl2' });
    assert.equal(r.ok, true);
    assert.equal(r.fileLines, 2);
    assert.ok(r.filePath.startsWith(path.join(dir, 'Build', 'dsh-hilog', 'logs')));
    assert.ok(!r.filePath.includes('/My Tag/x'), '文件名要消毒');
    assert.equal(readFileSync(r.filePath, 'utf8'), '# h\nl1\nl2\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** 造一个"一次成型"的句柄（给自定义 shell 用）。 */
function settled(stdout) {
  return {
    status: 'completed',
    exitCode: 0,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => false,
    done: Promise.resolve(),
    result: async () => ({ exitCode: 0, stdout: { text: stdout }, stderr: { text: '' }, timedOut: false, aborted: false, timeoutMs: 0 }),
  };
}

test('噪声行（shim）不会被解析成日志、也不会进落盘文件', async () => {
  const dir = tmp();
  try {
    const { exec } = setup({ device: fakeDevice({ shimNoise: true }), cfg: { outputDir: dir } });
    const r = await exec('hilog_dump', { save: true, lines: 100 });
    assert.equal(r.totalEntries, SAMPLE_LINES.length);
    assert.equal(r.noiseLines, 1);
    const text = readFileSync(r.filePath, 'utf8');
    assert.ok(!text.includes(SHIM_NOISE), '文件里不该有 shim 噪声');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
