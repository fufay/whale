#!/usr/bin/env node
/*
 * 门禁：hdc 桥内嵌资源与源码一致（2026-11-04）
 *
 * 背景：桥脚本随 HAP 分发靠 `hostcore/app/hdc-bridge-assets.js`（由 tools/embed-hdc-bridge.mjs
 * 从 `Common/dsh-hdc-bridge/` 生成）。生成物一旦与源码漂移，就会出现「改了桥脚本、装了新 HAP、
 * 桥行为却没变」的静默失效 —— 与 2026-09-23 的 dshm-installer 缺口同一类事故（工具清单漏文件 ⇒
 * 修复不生效、全程零报错）。所以这里逐字节比对：
 *   ① 每个内嵌资产的文本 === 源码文件文本；
 *   ② 源码里不该出现「未内嵌」的新脚本（白名单外的 *.sh/*.py/*.c 变化要显式过一遍）。
 *
 * 退出码：0 通过 / 1 不一致（重跑 node tools/embed-hdc-bridge.mjs） / 2 前置缺失
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = process.env.DSH_HDC_BRIDGE_SRC
  ? resolve(process.env.DSH_HDC_BRIDGE_SRC)
  : resolve(ROOT, '..', 'dsh-hdc-bridge');
const ASSETS_JS = join(ROOT, 'hostcore', 'app', 'hdc-bridge-assets.js');
/** 必须内嵌的资产（与 tools/embed-hdc-bridge.mjs 的 FILES 一致）。 */
const FILES = ['bridge.sh', 'fakecred.py', 'scanports.py', 'shim.c', 'shim.so'];
/** 二进制资产：base64 内嵌（与 tools/embed-hdc-bridge.mjs 的 BINARY 一致）。 */
const BINARY = new Set(['shim.so']);

if (!existsSync(SRC)) {
  console.error(`前置缺失：找不到桥源码目录 ${SRC}（可用 DSH_HDC_BRIDGE_SRC 覆盖）`);
  process.exit(2);
}
if (!existsSync(ASSETS_JS)) {
  console.error(`前置缺失：${ASSETS_JS}（先跑 node tools/embed-hdc-bridge.mjs）`);
  process.exit(2);
}

/** 从生成文件里取 assets（该文件是 `module.exports = {...}`，用 Function 求值避免误解析）。 */
function loadAssets() {
  const text = readFileSync(ASSETS_JS, 'utf8');
  const idx = text.indexOf('module.exports = ');
  if (idx < 0) throw new Error('hdc-bridge-assets.js 里没有 module.exports');
  const body = text.slice(idx + 'module.exports = '.length).trim().replace(/;\s*$/, '');
  // eslint-disable-next-line no-new-func
  return Function(`return (${body});`)();
}

const fails = [];
let assets;
try {
  assets = loadAssets();
} catch (error) {
  console.error(`✗ 解析 hdc-bridge-assets.js 失败：${error.message}`);
  process.exit(1);
}

const embeddedNames = Object.keys(assets).sort();
const wantNames = [...FILES].sort();
if (embeddedNames.join(',') !== wantNames.join(',')) {
  fails.push(`内嵌资产集合 ${embeddedNames.join('、')} ≠ 期望 ${wantNames.join('、')}`);
}
for (const name of FILES) {
  const srcPath = join(SRC, name);
  if (!existsSync(srcPath)) {
    fails.push(`源码缺文件：${srcPath}`);
    continue;
  }
  if (BINARY.has(name)) {
    const srcBuf = readFileSync(srcPath);
    const value = assets[name];
    if (value === null || typeof value !== 'object' || value.encoding !== 'base64') {
      fails.push(`未内嵌（二进制应按 base64 形式）：${name}`);
    } else {
      const embedded = Buffer.from(value.data, 'base64');
      if (!embedded.equals(srcBuf)) {
        fails.push(`内容漂移：${name}（源码 ${srcBuf.length} B ≠ 内嵌 ${embedded.length} B）`);
      }
    }
  } else {
    const srcText = readFileSync(srcPath, 'utf8');
    if (typeof assets[name] !== 'string') {
      fails.push(`未内嵌：${name}`);
    } else if (assets[name] !== srcText) {
      fails.push(`内容漂移：${name}（源码 ${srcText.length} B ≠ 内嵌 ${assets[name].length} B）`);
    }
  }
}

// 源码目录里白名单外的脚本提醒（只提示，不算失败 —— keys/、*.bak 等不属于随包资产）
const EXTRA_WHITELIST = new Set([
  ...FILES,
  'bridge.sh.bak-1791356609',
  'bridge.sh.bak-20261028-before-fix',
  'ensure-host-server.sh',
  'hdc-via-host.sh',
  'host-server-keepalive.sh',
]);
let extra = [];
try {
  extra = readdirSync(SRC).filter(
    (n) => /\.(sh|py|c)$/.test(n) && !EXTRA_WHITELIST.has(n),
  );
} catch {
  /* 读不到就算了 */
}

if (fails.length > 0) {
  console.error('✗ hdc 桥内嵌资源与源码不一致：');
  for (const f of fails) console.error('  · ' + f);
  console.error('\n修复：node tools/embed-hdc-bridge.mjs（并同步 place-host-app）');
  process.exit(1);
}

console.log(`✓ hdc 桥内嵌资源一致（${FILES.length} 个资产，源 ${SRC}）`);
if (extra.length > 0) {
  console.log(`  提示：源码目录里有未内嵌的脚本（确认是否该随包）：${extra.join('、')}`);
}
