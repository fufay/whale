#!/usr/bin/env node
/*
 * embed-hdc-bridge.mjs —— 把 `Common/dsh-hdc-bridge/` 的桥脚本内嵌成 Host 侧字符串资源
 *
 * 【为什么内嵌】桥脚本必须跟着 HAP 走：
 *   · 部署位置 `$HOME/bin/hdc(b)` 由 `bridge.sh` 生成，而 hdcb 的「自愈」又依赖能找到
 *     `bridge.sh` 本身。2026-11-04 真机事故就是**源码目录一搬走**，已部署的 hdcb 里写死的
 *     `@BRIDGE_DIR@` 指向不存在的旧路径 ⇒ 自愈永久失败 ⇒ 每个 hdc 调用都掉进"重建失败还
 *     硬 exec 真 hdc"的路径 ⇒ 同步调用方（旧版 screen-pilot 的 execFileSync）把 Host 事件
 *     循环冻死 78s，被系统看门狗杀进程重启。
 *   · 所以桥脚本随 HAP 分发，Host 启动时把它们同步到**稳定目录** `$HOME/.hdc-bridge/src/`
 *     再按需跑一次 `bridge.sh`（见 hostcore/app/dshm-hdc-bridge.js）。路径从此不再依赖工作区。
 *
 * 【不内嵌什么】`keys/`（hdc 授权私钥/口令种子）**绝不进仓库、不进 HAP**：它是设备本地的
 * 调试凭据，已授权的那份在 `$HOME/.harmony/` 里跨升级保留；`bridge.sh` 第 1 步只在
 * `$D/keys` 存在时才恢复，缺失是正常路径。
 *
 * 用法：node tools/embed-hdc-bridge.mjs          # 重新生成 hostcore/app/hdc-bridge-assets.js
 *       门禁 `tools/check-hdc-bridge-embed.mjs` 会比对内嵌内容与源码是否一致（改了源码忘重跑会红）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = resolve(ROOT, '..', 'dsh-hdc-bridge');
const OUT = join(ROOT, 'hostcore', 'app', 'hdc-bridge-assets.js');

/** 随 HAP 分发的桥资产（不含 keys/、不含文档、不含 .bak）。 */
const FILES = ['bridge.sh', 'fakecred.py', 'scanports.py', 'shim.c'];

const entries = [];
for (const name of FILES) {
  const text = readFileSync(join(SRC, name), 'utf8');
  entries.push(`  ${JSON.stringify(name)}: ${JSON.stringify(text)}`);
}

const header = `'use strict';
/*
 * hdc-bridge-assets.js —— 生成文件，**勿手改**
 * 由 tools/embed-hdc-bridge.mjs 从 Common/dsh-hdc-bridge/ 读取并内嵌；
 * 改桥脚本后重跑：node tools/embed-hdc-bridge.mjs
 * 一致性门禁：node tools/check-hdc-bridge-embed.mjs
 */
`;

writeFileSync(OUT, header + 'module.exports = {\n' + entries.join(',\n') + '\n};\n', 'utf8');
const bytes = readFileSync(OUT).length;
console.log(`[embed-hdc-bridge] 已生成 ${OUT.slice(ROOT.length + 1)}（${FILES.length} 个资产，${bytes} B）`);
