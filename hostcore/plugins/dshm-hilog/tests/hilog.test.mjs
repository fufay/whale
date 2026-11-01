// tests/hilog.test.mjs —— 纯解析层单测（无需设备、无需 DSH）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  buildHdcShellCommand, buildHilogCommand, buildListTargetsCommand, connectedTargets,
  entryTimeMs, formatEntry, levelFilterValue, levelsFrom, normalizeLevel, parseEntries,
  parseGlobalLevel, parseTargets, pickTarget, quoteArg, splitStreamDelta, truncateEntries,
} from '../lib/hilog.js';
import { DEFAULT_TARGETS, SAMPLE_LINES, SHIM_NOISE } from './helpers/fake-shell.mjs';

test('normalizeLevel：短名/长名/大小写/非法值', () => {
  assert.equal(normalizeLevel('d'), 'D');
  assert.equal(normalizeLevel(' INFO '), 'I');
  assert.equal(normalizeLevel('WARN'), 'W');
  assert.equal(normalizeLevel('error'), 'E');
  assert.equal(normalizeLevel('FATAL'), 'F');
  assert.equal(normalizeLevel('X'), null);
  assert.equal(normalizeLevel(''), null);
  assert.equal(normalizeLevel(undefined), null);
});

test('levelsFrom：展开成设备认的精确级别集合（-L I 只出 I！）', () => {
  assert.deepEqual(levelsFrom('I'), ['I', 'W', 'E', 'F']);
  assert.deepEqual(levelsFrom('D'), ['D', 'I', 'W', 'E', 'F']);
  assert.deepEqual(levelsFrom('F'), ['F']);
  assert.equal(levelFilterValue(levelsFrom('W')), 'W,E,F');
  assert.equal(levelFilterValue([]), null);
});

test('quoteArg：安全字符不加引号，其余单引号包裹并可被真 shell 还原', () => {
  assert.equal(quoteArg('abc-1.2_x'), 'abc-1.2_x');
  assert.equal(quoteArg('a b'), "'a b'");
  assert.equal(quoteArg("it's"), "'it'\\''s'");
  assert.equal(quoteArg(''), "''");
  // 真 shell 往返：中文 / 空格 / 单引号 / $ / 反斜杠 / 换行
  const tricky = [
    '带中文 的 tag',
    "it's a 'quoted' arg",
    '$HOME `whoami` $(id)',
    'back\\slash and "double"',
    'line1\nline2',
    '-T ^D',
  ];
  for (const s of tricky) {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${quoteArg(s)}`], { encoding: 'utf8' });
    assert.equal(out, s, `往返失败：${JSON.stringify(s)}`);
  }
});

test('buildHilogCommand：dump / capture / 级别读写', () => {
  const dump = buildHilogCommand({
    mode: 'dump', tags: ['MyTag', 'A01B07/com.demo/IMKG'], levels: ['W', 'E', 'F'], pids: [4051, 123], regex: 'boom.+bang',
  });
  assert.equal(
    dump.command,
    'hilog -x -T MyTag,A01B07/com.demo/IMKG -L W,E,F -P 4051,123 -e boom.+bang',
  );
  // 正则里带 shell 元字符时必须转义（| * ( ) 等）
  assert.equal(
    buildHilogCommand({ mode: 'dump', regex: 'boom|bang.*(x)' }).command,
    "hilog -x -e 'boom|bang.*(x)'",
  );

  const cap = buildHilogCommand({ mode: 'capture', timeoutSec: 18, tags: ['T'], levels: levelsFrom('I') });
  assert.equal(cap.command, 'timeout 18 hilog -T T -L I,W,E,F');

  assert.equal(buildHilogCommand({ mode: 'setLevel', level: 'INFO' }).command, 'hilog -b I');
  assert.equal(buildHilogCommand({ mode: 'getLevel' }).command, 'param get hilog.loggable.global');
  assert.equal(buildHilogCommand({ mode: 'dump', format: 'long' }).command, 'hilog -x -v long');
});

test('buildHilogCommand：超出设备上限要报错（-T 10 / -P 5 / -D 5）', () => {
  assert.throws(() => buildHilogCommand({ mode: 'dump', tags: Array.from({ length: 11 }, (_, i) => `T${i}`) }), /tag 最多 10 个/);
  assert.throws(() => buildHilogCommand({ mode: 'dump', pids: [1, 2, 3, 4, 5, 6] }), /pid 最多 5 个/);
  assert.throws(() => buildHilogCommand({ mode: 'dump', domains: Array.from({ length: 6 }, (_, i) => `D${i}`) }), /domain 最多 5 个/);
});

test('buildHdcShellCommand / buildListTargetsCommand：必须带 -t', () => {
  assert.equal(
    buildHdcShellCommand('hdc', '127.0.0.1:45071', "hilog -x -T 'My Tag'"),
    "hdc -t 127.0.0.1:45071 shell 'hilog -x -T '\\''My Tag'\\'''",
  );
  assert.equal(buildListTargetsCommand('hdc'), 'hdc list targets -v');
});

test('parseTargets：多条 Offline 里挑出 Connected；shim 噪声不算目标', () => {
  const { targets, noise } = parseTargets(`${DEFAULT_TARGETS}\n${SHIM_NOISE}\n`);
  assert.equal(noise.length, 1);
  assert.equal(targets.length, 3);
  assert.deepEqual(connectedTargets(targets).map((t) => t.key), ['127.0.0.1:45071']);
  assert.equal(targets[0].state, 'Offline');
  assert.equal(targets[1].transport, 'TCP');
});

test('parseTargets：USB 目标（多个 Connected）+ [Empty]', () => {
  const usb = '5BH0225304025535\tUSB\tConnected\tlocalhost';
  const { targets } = parseTargets(`${DEFAULT_TARGETS}\n${usb}\n`);
  assert.deepEqual(connectedTargets(targets).map((t) => t.key), ['127.0.0.1:45071', '5BH0225304025535']);
  const empty = parseTargets('[Empty]\n');
  assert.equal(empty.empty, true);
  assert.equal(empty.targets.length, 0);
});

test('pickTarget：唯一 Connected / 显式指定 / 指定了但 Offline / 多个 Connected 不猜', () => {
  const list = parseTargets(DEFAULT_TARGETS).targets;
  assert.equal(pickTarget(list, '').target.key, '127.0.0.1:45071');
  assert.equal(pickTarget(list, '127.0.0.1:45071').target.key, '127.0.0.1:45071');
  assert.match(pickTarget(list, '127.0.0.1:10178').reason, /Offline/);
  assert.match(pickTarget(list, '5BH0').reason, /没有目标/);
  const two = parseTargets(`${DEFAULT_TARGETS}\n5BH0225304025535\tUSB\tConnected\tlocalhost\n`).targets;
  const r = pickTarget(two, '');
  assert.equal(r.target, null);
  assert.match(r.reason, /请用 device 参数指定/);
});

test('parseEntries：真机样本（pid+tid 两列、domain/pkg/tag 三段、正文含冒号与空格）', () => {
  const parsed = parseEntries(`${SAMPLE_LINES.join('\n')}\n`);
  assert.equal(parsed.entries.length, 5);
  const first = parsed.entries[0];
  assert.equal(first.time, '10-15 10:47:36.948');
  assert.equal(first.pid, 4051);
  assert.equal(first.tid, 4051);
  assert.equal(first.level, 'W');
  assert.equal(first.domain, 'A01B07');
  assert.equal(first.pkg, 'com.ohos.sceneboard');
  assert.equal(first.tag, 'IMKG');
  assert.ok(first.msg.startsWith('[a92abe3ec8bd4bd 0 0]ImmersiveDataVm'));
  const twoCol = parsed.entries[4];
  assert.equal(twoCol.pid, 47645);
  assert.equal(twoCol.tid, 47645);
  assert.equal(twoCol.level, 'E');
  assert.equal(twoCol.domain, 'C02C02');
  assert.equal(twoCol.pkg, '');
  assert.equal(twoCol.tag, 'PARAM');
  assert.equal(twoCol.msg, 'Forbid to access parameter hilog.debug.on');
});

test('parseEntries：过滤 shim 噪声行 + 收集 hdc 提示文本', () => {
  const text = `${SHIM_NOISE}\n${SAMPLE_LINES[0]}\n[Fail]Not match target\n${SAMPLE_LINES[1]}\n`;
  const parsed = parseEntries(text);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.noise.length, 1);
  // hdc 自己的提示行（[Fail]...）不能当成"多行消息的续行"污染上一条日志
  assert.equal(parsed.unparsed.length, 1);
  assert.match(parsed.unparsed[0], /\[Fail\]/);
  assert.ok(!parsed.entries[0].msg.includes('[Fail]'));
});

test('parseEntries：多行消息（续行）合并进上一条', () => {
  const text = [
    '10-15 12:00:00.001  100  100 E A00000/com.demo.app/DEMO: java.lang.RuntimeException: boom',
    '\tat com.demo.app.Main.foo(Main.ets:12)',
    '\tat com.demo.app.Main.bar(Main.ets:34)',
    '10-15 12:00:00.002  100  100 I A00000/com.demo.app/DEMO: next ok',
    '',
  ].join('\n');
  const parsed = parseEntries(text);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.stats.continuationLines, 2);
  assert.match(parsed.entries[0].msg, /boom\n\tat com\.demo\.app\.Main\.foo/);
  assert.equal(parsed.entries[1].msg, 'next ok');
});

test('parseEntries：中文/空格/tag 里带斜杠', () => {
  const text = '10-15 12:00:00.500  200  201 I A01B07/com.demo.中文应用/我的TAG: 启动失败：找不到 配置 文件（code=404）\n';
  const parsed = parseEntries(text);
  assert.equal(parsed.entries.length, 1);
  const e = parsed.entries[0];
  assert.equal(e.pkg, 'com.demo.中文应用');
  assert.equal(e.tag, '我的TAG');
  assert.equal(e.msg, '启动失败：找不到 配置 文件（code=404）');
  // tag 字段里带空格也能解（靠"首个 冒号+空白"切分；这也正是 pkg 段含冒号那条的依据）
  const spaced = parseEntries('10-15 12:00:00.501  200  201 I A01B07/com.demo/我的 TAG: 你好 世界\n');
  assert.equal(spaced.entries.length, 1);
  assert.equal(spaced.entries[0].tag, '我的 TAG');
  assert.equal(spaced.entries[0].msg, '你好 世界');
});

test('parseEntries：pkg 段含冒号的真实行（ArkWeb `com.dshm.dshclient:gpu`）', () => {
  const normal = '10-15 11:39:30.885 35307 35374 D A04511/com.dshm.dshclient:gpu/chromium: [../../arkweb/gpu.cc:33] vulkan switch config is: 1, cmd is: None';
  const e = parseEntries(normal).entries[0];
  assert.equal(e.domain, 'A04511');
  assert.equal(e.pkg, 'com.dshm.dshclient:gpu');
  assert.equal(e.tag, 'chromium');
  assert.equal(e.msg, '[../../arkweb/gpu.cc:33] vulkan switch config is: 1, cmd is: None');
  // 同一条的 long 格式必须给出**同样的** pkg/tag（两种格式交叉验证）
  const long = parseEntries('[ 10-15 11:39:33.401 35307 35374 D A04511 com.dshm.dshclient:gpu chromium ]\n[../../arkweb/gpu.cc:33] vulkan switch config is: 1, cmd is: None', { format: 'long' }).entries[0];
  assert.equal(long.pkg, e.pkg);
  assert.equal(long.tag, e.tag);
  assert.equal(long.msg, e.msg);
});

test('parseEntries：-v long 格式（header + 正文行）', () => {
  const text = [
    '[ 10-14 17:25:58.085     0     0 I I00000 HiLog ]',
    '========Zeroth log of type: init',
    '[ 10-14 17:25:59.808  1165  1165 E I04301 light_sensor LIGHT_SENSOR ]',
    'AlsGetDetailInfo: readBytes fail, readBytes 12',
    '',
  ].join('\n');
  const parsed = parseEntries(text, { format: 'long' });
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(
    parsed.entries.map((e) => [e.time, e.pid, e.tid, e.level, e.domain, e.pkg, e.tag]),
    [
      ['10-14 17:25:58.085', 0, 0, 'I', 'I00000', '', 'HiLog'],
      ['10-14 17:25:59.808', 1165, 1165, 'E', 'I04301', 'light_sensor', 'LIGHT_SENSOR'],
    ],
  );
  assert.equal(parsed.entries[0].msg, '========Zeroth log of type: init');
  assert.equal(parsed.entries[1].msg, 'AlsGetDetailInfo: readBytes fail, readBytes 12');
  assert.equal(parsed.entries[1].raw.startsWith('[ 10-14'), true);
});

test('entryTimeMs：补当前年份 + 跨年就近修正', () => {
  const now = new Date(2026, 0, 2, 12, 0, 0).getTime();   // 2026-01-02
  const old = entryTimeMs('12-31', '23:59:59.000', now);   // 应是 2025-12-31
  assert.equal(new Date(old).getFullYear(), 2025);
  const fresh = entryTimeMs('01-02', '11:00:00.000', now);
  assert.equal(new Date(fresh).getFullYear(), 2026);
  assert.equal(new Date(fresh).getHours(), 11);
});

test('truncateEntries：tail 默认（最近 N 条）/ head / 字节上限', () => {
  const entries = parseEntries(SAMPLE_LINES.join('\n')).entries;
  const tail = truncateEntries(entries, { lines: 2 });
  assert.equal(tail.kept.length, 2);
  assert.equal(tail.kept[1].pid, 47645);
  assert.equal(tail.dropped, 3);
  assert.equal(tail.truncated, true);
  const head = truncateEntries(entries, { lines: 2, order: 'head' });
  assert.equal(head.kept[0].pid, 4051);
  const byBytes = truncateEntries(entries, { lines: 10, maxBytes: 160 });
  assert.equal(byBytes.clampedByBytes, true);
  assert.ok(byBytes.kept.length < entries.length);
  assert.ok(byBytes.bytes <= 160 + 200);   // 允许一条的边界误差
});

test('splitStreamDelta：把 ctx.shell 混进 delta 的 stderr 拆出来', () => {
  assert.deepEqual(splitStreamDelta('a\nb\n'), { out: 'a\nb\n', err: '' });
  // 分隔符本身含前导换行 ⇒ out 不保留它（真机样本：stdout 行 + '\n[stderr]\n' + stderr）
  assert.deepEqual(splitStreamDelta('a\n[stderr]\nboom\n'), { out: 'a', err: 'boom\n' });
  assert.deepEqual(splitStreamDelta('[stderr]\nboom'), { out: '', err: 'boom' });
});

test('parseGlobalLevel：真机输出带尾空格', () => {
  assert.equal(parseGlobalLevel('W \n'), 'W');
  assert.equal(parseGlobalLevel('D\n'), 'D');
  assert.equal(parseGlobalLevel('  '), null);
  assert.equal(parseGlobalLevel('X'), 'X');
});

test('formatEntry：有 raw 用 raw，没有就重建', () => {
  assert.equal(formatEntry({ raw: 'X' }), 'X');
  const rebuilt = formatEntry({ time: '10-15 12:00:00.000', pid: 1, tid: 2, level: 'I', domain: 'A00000', pkg: 'com.a', tag: 'T', msg: 'hi\nthere' });
  assert.match(rebuilt, /^10-15 12:00:00\.000\s+1\s+2 I A00000\/com\.a\/T: hi\\nthere$/);
});
