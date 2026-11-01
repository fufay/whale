// tests/hdc.test.mjs —— 通道探测 / 目标挑选（用假 exec，无需设备）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { channelCommand, channelLabel, DEFAULT_VIA_HOST, resolveTarget } from '../lib/hdc.js';
import { fakeExec } from './helpers/fake-shell.mjs';

const OFFLINE_ONLY = [
  '127.0.0.1:10178\t\tTCP\tOffline\tunknown...',
  '127.0.0.1:33001\t\tTCP\tOffline\tunknown...',
].join('\n');
const PC_CONNECTED = `${OFFLINE_ONLY}\n127.0.0.1:45071\t\tTCP\tConnected\tlocalhost`;
const PHONE_USB = '5BH0225304025535\tUSB\tConnected\tlocalhost';

/** 按通道命令分派 list targets 的输出（最具体的 key 先匹配：'hdc-via-host.sh' 优先于 'hdc'）。 */
function execByChannel(map) {
  const exec = fakeExec();
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  exec.impl = async (command) => {
    for (const needle of keys) {
      if (command.includes(needle)) {
        const out = map[needle];
        return typeof out === 'function' ? out(command) : out;
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return exec;
}

const CFG = { hdcCmd: 'hdc', hdcCmdViaHost: 'sh /tmp/hdc-via-host.sh', listTimeoutMs: 5000 };

test('channelCommand / channelLabel', () => {
  assert.deepEqual(channelCommand(CFG, 'bridge'), { channel: 'bridge', cmd: 'hdc', reason: '' });
  assert.equal(channelCommand(CFG, 'via-host').cmd, 'sh /tmp/hdc-via-host.sh');
  assert.match(channelCommand({}, 'via-host').reason, /未配置/);
  assert.match(channelLabel('via-host'), /宿主 hdc server/);
  assert.match(DEFAULT_VIA_HOST, /hdc-via-host\.sh/);
});

test('auto：桥只有 Offline ⇒ 自动换到 via-host 拿 USB 手机（返回值注明通道）', async () => {
  const exec = execByChannel({
    hdc: { exitCode: 0, stdout: `${OFFLINE_ONLY}\n`, stderr: '[hdcb] 无法连接本机 hdc：请确认「设置→开发者选项→无线调试」已开启' },
    'hdc-via-host': { exitCode: 0, stdout: `${PHONE_USB}\n`, stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'via-host');
  assert.equal(r.target.key, '5BH0225304025535');
  assert.equal(r.tried.length, 2);
  assert.match(r.tried[0].stderr, /无线调试/);
});

test('auto：桥有 Connected（本机 PC）⇒ 就用桥，不再探测 via-host', async () => {
  const exec = execByChannel({
    hdc: { exitCode: 0, stdout: `${PC_CONNECTED}\n`, stderr: '' },
    'hdc-via-host': { exitCode: 0, stdout: '[Empty]\n', stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG });
  assert.equal(r.channel, 'bridge');
  assert.equal(r.target.key, '127.0.0.1:45071');
  assert.equal(exec.calls.length, 1);
});

test('显式 device 只认它：桥里没有该 key ⇒ 继续去 via-host 找', async () => {
  const exec = execByChannel({
    hdc: { exitCode: 0, stdout: `${PC_CONNECTED}\n`, stderr: '' },
    'hdc-via-host': { exitCode: 0, stdout: `${PHONE_USB}\n`, stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG, device: '5BH0225304025535' });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'via-host');
  assert.equal(r.target.key, '5BH0225304025535');
});

test('多个 Connected 且未指定 device ⇒ 不猜，报可读错误', async () => {
  const exec = execByChannel({
    hdc: { exitCode: 0, stdout: `${PC_CONNECTED}\n${PHONE_USB}\n`, stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有可用的 Connected 目标/);
  assert.match(r.details, /请用 device 参数指定/);
  assert.deepEqual(r.tried[0].connected, ['127.0.0.1:45071', '5BH0225304025535']);
});

test('两条通道都没设备 ⇒ 带逐通道 list targets -v 原文 + 明确指引（含 USB server 保活命令）', async () => {
  const exec = execByChannel({
    hdc: { exitCode: 0, stdout: `${OFFLINE_ONLY}\n`, stderr: '[hdcb] 无法连接本机 hdc：请确认「设置→开发者选项→无线调试」已开启' },
    'hdc-via-host': { exitCode: 0, stdout: '[Empty]\n', stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.details, /bridge/);
  assert.match(r.details, /via-host/);
  assert.match(r.details, /127\.0\.0\.1:10178/);          // 原文透传
  assert.match(r.details, /无线调试/);                     // 桥的提示文案原样带出
  assert.match(r.guidance, /无线调试/);
  assert.match(r.guidance, /host-server-keepalive\.sh/);   // 抓 USB 设备的指引
});

test('channel 显式指定时不再探测另一条通道', async () => {
  const exec = execByChannel({
    hdc: { exitCode: 0, stdout: `${OFFLINE_ONLY}\n`, stderr: '' },
    'hdc-via-host': { exitCode: 0, stdout: `${PHONE_USB}\n`, stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG, channel: 'bridge' });
  assert.equal(r.ok, false);
  assert.equal(exec.calls.length, 1);
  assert.match(r.tried[0].error, /没有 Connected 目标/);
});

test('device 存在但 Offline ⇒ 明确说状态，不当成"没找到"', async () => {
  const exec = execByChannel({
    hdc: { exitCode: 0, stdout: `${PC_CONNECTED}\n${OFFLINE_ONLY}\n`, stderr: '' },
    'hdc-via-host': { exitCode: 0, stdout: '', stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG, device: '127.0.0.1:10178' });
  assert.equal(r.ok, false);
  assert.match(r.tried[0].error, /Offline/);
});

test('通道命令执行失败（桥没起来/文件不存在）⇒ 记原因并继续下一条通道', async () => {
  let n = 0;
  const exec = fakeExec();
  exec.impl = async (command) => {
    n += 1;
    if (n === 1) throw new Error('spawn hdc ENOENT');
    return { exitCode: 0, stdout: `${PHONE_USB}\n`, stderr: '' };
  };
  const r = await resolveTarget(exec, { cfg: CFG });
  assert.equal(r.ok, true);
  assert.equal(r.channel, 'via-host');
  assert.match(r.tried[0].error, /spawn hdc ENOENT/);
});

test('两条通道的命令都跑不起来 ⇒ 报"执行通道问题"而不是"设备不在线"（别误导排障方向）', async () => {
  const exec = fakeExec();
  exec.impl = async () => { throw new Error('spawn hdc ENOENT'); };
  const r = await resolveTarget(exec, { cfg: CFG });
  assert.equal(r.ok, false);
  assert.match(r.error, /命令都执行不了/);
  assert.match(r.error, /spawn hdc ENOENT/);
  assert.match(r.guidance, /ctx\.shell 未挂载/);
  assert.ok(!/无线调试/.test(r.guidance), '不该把执行通道问题说成"请开无线调试"');
});

test('时间超限也要如实带出（timedOut）', async () => {
  const exec = execByChannel({
    hdc: { exitCode: null, stdout: '', stderr: '', timedOut: true },
    'hdc-via-host': { exitCode: 0, stdout: `${PHONE_USB}\n`, stderr: '' },
  });
  const r = await resolveTarget(exec, { cfg: CFG });
  assert.equal(r.ok, true);
  assert.equal(r.tried[0].timedOut, true);
});
