// 输入注入引擎：uitest uiInput（绝对坐标点击/滑动/按键/文本）。
import { shellArgs } from './hdc.js';

function run(args) {
  const out = shellArgs(...args);
  const ok = /No Error/i.test(out) && !/^\[\w*Error/i.test(out.trim());
  if (!ok) {
    const err = new Error('输入注入失败: ' + out.trim());
    err.output = out;
    throw err;
  }
  return out.trim();
}

/** 点击：count=2 双击，holdMs>0 长按。 */
export function click(x, y, { count = 1, holdMs = 0, displayId } = {}) {
  const cmd = holdMs > 0 ? 'longClick' : count >= 2 ? 'doubleClick' : 'click';
  const args = ['uitest', 'uiInput', cmd, String(x), String(y)];
  if (displayId != null) args.push(String(displayId));
  return { ok: true, action: cmd, x, y, output: run(args) };
}

/** 滑动/拖拽：durationMs>0 走 drag，否则 swipe。 */
export function swipe(from, to, { velocity, durationMs = 0, displayId } = {}) {
  const cmd = durationMs > 0 ? 'drag' : 'swipe';
  const args = [
    'uitest', 'uiInput', cmd,
    String(from[0]), String(from[1]), String(to[0]), String(to[1]),
  ];
  if (velocity != null && durationMs <= 0) args.push(String(velocity));
  if (displayId != null) args.push(String(displayId));
  return { ok: true, action: cmd, from, to, output: run(args) };
}

/**
 * 按键。key：数字 keyID 或 'Back'/'Home'/'Power'；
 * combo：可选组合键数组（2~3 个 keyID，模拟同时按下，如 Ctrl+A）。
 */
export function key(key, { combo = [], displayId } = {}) {
  const args = ['uitest', 'uiInput', 'keyEvent'];
  if (Array.isArray(combo) && combo.length) {
    args.push(...combo.map(String));
  } else {
    args.push(String(key));
  }
  if (displayId != null) args.push(String(displayId));
  return { ok: true, action: 'keyEvent', key, combo, output: run(args) };
}

/**
 * 文本输入：给 x,y 用 inputText（先点坐标再输入），否则 text（当前焦点处输入）。
 * ⚠ 文本会经过系统输入法：若拼音输入法激活，英文字母可能被转换为中文候选。
 */
export function typeText(text, { x, y, displayId } = {}) {
  const args =
    x != null && y != null
      ? ['uitest', 'uiInput', 'inputText', String(x), String(y), String(text)]
      : ['uitest', 'uiInput', 'text', String(text)];
  if (displayId != null) args.push(String(displayId));
  return { ok: true, action: x != null ? 'inputText' : 'text', text, output: run(args) };
}
