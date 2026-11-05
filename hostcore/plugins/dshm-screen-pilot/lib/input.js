// 输入注入引擎：uitest uiInput（绝对坐标点击/滑动/按键/文本）。
// 全部改为异步 hdc 调用：等待注入结果期间不阻塞 Host 事件循环（GUI/其它会话不受影响）。
//
// 2026-11-05（审计 P1-5）：长连走 PTY 后，命令里的裸换行/控制字符会被设备终端行规程解释
// （截断命令、SIGINT、VEOF…），所以文本输入改为 base64 落设备临时文件再传参，
// 让 PTY 只看到单行 ASCII；其余注入命令本来就是单行可打印文本。
import { randomBytes } from 'node:crypto';
import { deviceCommand, shellArgs, shellArgsWith } from './hdc.js';

function assertNoControlChars(args) {
  for (const a of args) {
    if (/[\x00-\x1f\x7f]/.test(String(a))) {
      throw new Error('输入注入参数含控制字符（换行/制表等），已拒绝；文本请用 ui_type 的 base64 通道');
    }
  }
}

async function run(args) {
  assertNoControlChars(args);
  const out = await shellArgsWith(args, {});
  const ok = /No Error/i.test(out) && !/^\[\w*Error/i.test(out.trim());
  if (!ok) {
    const err = new Error('输入注入失败: ' + out.trim());
    err.output = out;
    throw err;
  }
  return out.trim();
}

/** 点击：count=2 双击，holdMs>0 长按。 */
export async function click(x, y, { count = 1, holdMs = 0, displayId } = {}) {
  const cmd = holdMs > 0 ? 'longClick' : count >= 2 ? 'doubleClick' : 'click';
  const args = ['uitest', 'uiInput', cmd, String(x), String(y)];
  if (displayId != null) args.push(String(displayId));
  return { ok: true, action: cmd, x, y, output: await run(args) };
}

/** 滑动/拖拽：durationMs>0 走 drag，否则 swipe。 */
export async function swipe(from, to, { velocity, durationMs = 0, displayId } = {}) {
  const cmd = durationMs > 0 ? 'drag' : 'swipe';
  const args = [
    'uitest', 'uiInput', cmd,
    String(from[0]), String(from[1]), String(to[0]), String(to[1]),
  ];
  if (velocity != null && durationMs <= 0) args.push(String(velocity));
  if (displayId != null) args.push(String(displayId));
  return { ok: true, action: cmd, from, to, output: await run(args) };
}

/**
 * 按键。key：数字 keyID 或 'Back'/'Home'/'Power'；
 * combo：可选组合键数组（2~3 个 keyID，模拟同时按下，如 Ctrl+A）。
 */
export async function key(key, { combo = [], displayId } = {}) {
  const args = ['uitest', 'uiInput', 'keyEvent'];
  if (Array.isArray(combo) && combo.length) {
    args.push(...combo.map(String));
  } else {
    args.push(String(key));
  }
  if (displayId != null) args.push(String(displayId));
  return { ok: true, action: 'keyEvent', key, combo, output: await run(args) };
}

/**
 * 文本输入：给 x,y 用 inputText（先点坐标再输入），否则 text（当前焦点处输入）。
 * 文本先 base64 写到设备临时文件，再把文件内容作为参数传给 uitest，
 * 避免 \n/\r/\x03/\x04 等字节被 PTY 行规程解释（审计 P1-5）。
 * ⚠ 文本会经过系统输入法：若拼音输入法激活，英文字母可能被转换为中文候选。
 */
export async function typeText(text, { x, y, displayId } = {}) {
  const value = String(text);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error('ui_type 文本含不可注入的控制字符（仅支持普通文本/换行）');
  }
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const remote = '/data/local/tmp/sp_type_' + randomBytes(4).toString('hex') + '.txt';
  const prefix = `printf %s '${b64}' | base64 -d > ${remote};`;
  const sub =
    x != null && y != null
      ? `uitest uiInput inputText ${Number(x)} ${Number(y)} "$(cat ${remote})"`
      : `uitest uiInput text "$(cat ${remote})"`;
  const suffix = displayId != null ? ` ${Number(displayId)}` : '';
  const cmd = `${prefix} ${sub}${suffix}; rm -f ${remote}`;
  const out = await deviceCommand(cmd);
  const ok = /No Error/i.test(out) && !/^\[\w*Error/i.test(out.trim());
  if (!ok) {
    const err = new Error('输入注入失败: ' + out.trim());
    err.output = out;
    throw err;
  }
  return { ok: true, action: x != null ? 'inputText' : 'text', text: value, output: out.trim() };
}

export { shellArgs };
