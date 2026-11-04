// UI 树引擎：uitest dumpLayout + 元素检索（text 子串 → 坐标）。
//
// 性能要点（真机实测 dumpLayout 本体 ~0.85–1.0s，是调用的大头）：
//  · 不再「dump 到远端 → 单独 hdc file recv → 单独 rm」三次往返：一次 hdc shell 里
//    完成 dump + 回读 JSON（cat）+ 清理，客户端只多一次字符串解析（280KB JSON ≈4ms）。
//  · 默认落盘改为覆盖同一个 `layout_latest.json`，避免每次 ui_dump 都在保存目录堆一份
//    ~280KB 的中间 JSON。
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isUitestContention, queueCleanup, uitestShell } from './hdc.js';

let lastDump = null;
let remoteSeq = 0;

const DEFAULT_LAYOUT_NAME = 'layout_latest.json';

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

/** 单次 dump 尝试（内部用；调用方见 dumpLayout）。 */
async function dumpOnce({ merged = true, saveTo, saveDir } = {}) {
  remoteSeq = (remoteSeq + 1) % 1e6;
  const base = `/data/local/tmp/dsp_layout_${process.pid}_${Date.now()}_${remoteSeq}`;
  const remote = base + '.json';
  const log = base + '.log';
  const marker = `SPM${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const args = ['uitest', 'dumpLayout', ...(merged ? [] : ['-i']), '-p', remote];
  // 一次往返：dump（stdout/stderr 落日志）→ 状态码标记 → 回读 JSON → 分隔符 → 失败时回读日志
  const cmd =
    `${args.join(' ')} >${log} 2>&1; echo "${marker}=$?"; cat ${remote} 2>/dev/null; ` +
    `echo; echo "${marker}L"; cat ${log} 2>/dev/null`;
  const out = await uitestShell(cmd);
  try {
    const statusIdx = out.indexOf(marker + '=');
    if (statusIdx < 0) throw new Error('dumpLayout 失败（无状态标记）: ' + String(out).trim().slice(0, 500));
    const statusLineEnd = out.indexOf('\n', statusIdx);
    if (statusLineEnd < 0) throw new Error('dumpLayout 失败（输出被截断）');
    const status = Number(out.slice(statusIdx + marker.length + 1, statusLineEnd));
    const bodyStart = statusLineEnd + 1;
    const sepIdx = out.indexOf('\n' + marker + 'L', bodyStart);
    const body = sepIdx < 0 ? out.slice(bodyStart) : out.slice(bodyStart, sepIdx);
    const logText = sepIdx < 0 ? '' : out.slice(out.indexOf('\n', sepIdx + 1) + 1);
    if (status !== 0 || !body.trim()) {
      throw new Error('dumpLayout 失败: ' + String(logText || body || out).trim().slice(0, 2000));
    }
    let tree;
    try {
      tree = JSON.parse(body);
    } catch (e) {
      throw new Error('dumpLayout 输出不是合法 JSON: ' + e.message + '；头部=' + JSON.stringify(body.slice(0, 200)));
    }
    const local = saveTo || join(saveDir, DEFAULT_LAYOUT_NAME);
    mkdirSync(dirname(local), { recursive: true });
    await writeFile(local, body);
    const windows = [];
    const elements = [];
    collect(tree, windows, elements);
    const result = { path: local, windows, elements, capturedAt: Date.now() };
    lastDump = result;
    return result;
  } finally {
    queueCleanup(remote);
    queueCleanup(log);
  }
}

/** 导出布局树 JSON 并解析；结果缓存在内存供 ui_find / ui_tap_text 使用。
 *  设备侧 uitest 并发撞车（Wait for subscribe … timeout）时自动重试一次。 */
export async function dumpLayout(opts = {}) {
  try {
    return await dumpOnce(opts);
  } catch (e) {
    if (!isUitestContention(e)) throw e;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return dumpOnce(opts);
  }
}

/** 读取最近一次布局缓存（无则 null）。 */
export function cachedDump() {
  return lastDump;
}

/** 在给定 dump 结果里按文本子串（大小写不敏感）检索，返回按匹配文本长度排序的前 limit 个。 */
export function findInDump(dump, text, limit = 10) {
  const q = String(text).toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const el of dump.elements) {
    const hay = (el.text + ' ' + el.description).toLowerCase();
    if (hay.includes(q)) hits.push({ matched: el.text || el.description, element: el });
  }
  hits.sort((a, b) => a.matched.length - b.matched.length);
  return hits.slice(0, limit).map((h) => h.element);
}

/** 按文本子串检索元素，返回按匹配文本长度排序的前 limit 个。无缓存或 refresh=true 时先 dump。 */
export async function findElements(text, { limit = 10, refresh = false, saveDir } = {}) {
  if (refresh || !lastDump) await dumpLayout({ saveDir });
  return findInDump(lastDump, text, limit);
}
