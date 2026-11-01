// UI 树引擎：uitest dumpLayout + 元素检索（text 子串 → 坐标）。
import { readFileSync } from 'node:fs';
import { hdcRun, shell, shellArgs } from './hdc.js';

let lastDump = null;

/** 解析 bounds 字符串 "[x0,y0][x1,y1]" → [x0,y0,x1,y1]。 */
export function parseBounds(s) {
  if (s == null) return null;
  const m = String(s).match(/(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3], +m[4]];
}

function collect(node, windows, elements) {
  if (Array.isArray(node)) {
    for (const x of node) collect(x, windows, elements);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const a = node.attributes || {};
  const bounds = parseBounds(a.bounds ?? a.bound);
  if (a.bundleName) {
    windows.push({
      bundleName: a.bundleName,
      abilityName: a.abilityName || '',
      bounds: bounds ? { x0: bounds[0], y0: bounds[1], x1: bounds[2], y1: bounds[3] } : null,
    });
  }
  const text = a.text || '';
  const description = a.description || '';
  if ((text || description) && bounds) {
    elements.push({
      text,
      description,
      accessibilityId: a.accessibilityId || '',
      clickable: a.clickable === 'true',
      bounds: { x0: bounds[0], y0: bounds[1], x1: bounds[2], y1: bounds[3] },
      center: {
        x: Math.round((bounds[0] + bounds[2]) / 2),
        y: Math.round((bounds[1] + bounds[3]) / 2),
      },
    });
  }
  for (const c of node.children || []) collect(c, windows, elements);
}

/** 导出布局树 JSON 并解析；结果缓存在内存供 ui_find 使用。 */
export function dumpLayout({ merged = true, saveTo, saveDir } = {}) {
  const remote = `/data/local/tmp/dsp_layout_${Date.now()}.json`;
  const args = ['uitest', 'dumpLayout', '-p', remote];
  if (!merged) args.push('-i');
  const out = shellArgs(...args);
  if (!/saved/i.test(out) && !/No Error/i.test(out)) {
    throw new Error('dumpLayout 失败: ' + out.trim());
  }
  const local = saveTo || `${saveDir}/layout_${Date.now()}.json`;
  hdcRun(['file', 'recv', remote, local]);
  shell('rm -f ' + remote);
  const tree = JSON.parse(readFileSync(local, 'utf8'));
  const windows = [];
  const elements = [];
  collect(tree, windows, elements);
  const result = { path: local, windows, elements, capturedAt: Date.now() };
  lastDump = result;
  return result;
}

/** 读取最近一次布局缓存（无则空）。 */
export function cachedDump() {
  return lastDump;
}

/** 按文本子串（大小写不敏感）检索元素，返回按匹配文本长度排序的前 limit 个。 */
export function findElements(text, { limit = 10, refresh = false, saveDir } = {}) {
  if (refresh || !lastDump) dumpLayout({ saveDir });
  const q = String(text).toLowerCase();
  const hits = [];
  for (const el of lastDump.elements) {
    const hay = (el.text + ' ' + el.description).toLowerCase();
    if (q && hay.includes(q)) {
      hits.push({ matched: el.text || el.description, element: el });
    }
  }
  hits.sort((a, b) => a.matched.length - b.matched.length);
  return hits.slice(0, limit).map((h) => h.element);
}
