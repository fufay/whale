#!/usr/bin/env node
/**
 * assert-rg-selfsigned.mjs —— 锁「端侧 rg 可用」的新口径（2026-11-12 起，取代 assert-fs-search-fallback）。
 *
 * 背景：debug 签名域里 execve 第三方 ELF 被拒（真机实证 `rg=Permission denied`）。rc.1 的做法是在
 * `dsh-tool-fs-search` 里注入 34 KB 的 find/grep 降级；rc.2 把 rg 执行迁到
 * `@deepseek-ai/dsh-util-ripgrep`（`resolveRgPath()` → `import('@vscode/ripgrep').rgPath`）后整段失效。
 * 新口径：**构建期用 ohos-selfsign 给 rg 自签名**，并在 `@vscode/ripgrep` 会查找的平台包名下注入
 * （端侧 platform=openharmony ⇒ `@vscode/ripgrep-openharmony-arm64`）。
 *
 * 判据：
 *   A. pack-core 的接线：自签名、verify、openharmony 平台包名、清掉旧 linux-arm64、且注入发生在 pack 之前；
 *   B. 核心树里 rg 在正确路径、且 `ohos-selfsign verify` 通过（= 可直接 execve）；
 *   C. `@vscode/ripgrep` 的包名模板与 B 的目录名一致；
 *   D. fs-search 已改用 dsh-util-ripgrep，且**不再**带旧 find/grep 降级注入；
 *   E. 树里没有残留的 linux-arm64 平台包。
 *
 * 用法：node tools/assert-rg-selfsigned.mjs      （需先 node tools/pack-core.mjs --skip-install）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'hostcore', 'core-recipe.json'), 'utf8'));
const TREE = join(ROOT, 'dist', 'core', 'work', `dsh-core-${RECIPE.coreVersion}`, 'node_modules');
const RG = join(TREE, '@vscode', 'ripgrep-openharmony-arm64', 'bin', 'rg');
const OLD_RG_DIR = join(TREE, '@vscode', 'ripgrep-linux-arm64');
const PACK_CORE = join(ROOT, 'tools', 'pack-core.mjs');

let pass = 0;
let fail = 0;
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${label}`); } };

if (!existsSync(PACK_CORE)) {
  console.error('前置缺失：tools/pack-core.mjs');
  process.exit(2);
}
const core = readFileSync(PACK_CORE, 'utf8');

/* ── A. pack-core 接线 ── */
ok(core.includes('ohos-selfsign'), 'A1 pack-core 引用 ohos-selfsign');
ok(/'sign',\s*rgBin/.test(core) || core.includes("'sign'"), 'A2 调 sign 子命令');
ok(core.includes("'verify'"), 'A3 调 verify 子命令（签名后校验）');
ok(core.includes("'ripgrep-openharmony-arm64'"), 'A4 注入 openharmony 平台包名（@vscode/ripgrep 按 process.platform 查找）');
ok(core.includes("'ripgrep-linux-arm64'") && /rmSync\(join\(STAGE, 'node_modules', '@vscode', 'ripgrep-linux-arm64'/.test(core),
  'A5 显式清理旧 linux-arm64 平台包');
const iInject = core.indexOf('ensureRipgrepPlatformPackage();');
const iPack = core.indexOf('pack();', iInject);
ok(iInject > 0 && iPack > iInject, 'A6 注入发生在 pack() 之前（否则 zip 里没有签名 rg）');

/* ── B. 树里的 rg ── */
ok(existsSync(RG), `B1 存在 ${RG}（先跑 pack-core --skip-install）`);
if (existsSync(RG)) {
  let signed = false;
  let detail = '';
  try {
    const out = execFileSync('ohos-selfsign', ['verify', RG], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    signed = /codesign=yes/.test(out) && /signature_match=yes/.test(out);
    detail = out.trim().split('\n').slice(-3).join(' | ');
  } catch (error) {
    detail = `verify 失败：${error && error.message ? error.message : error}`;
  }
  ok(signed, `B2 rg 自签名完好（ohos-selfsign verify）${signed ? '' : ' —— ' + detail}`);
}

/* ── C. @vscode/ripgrep 的解析模板 ── */
const resolver = join(TREE, '@vscode', 'ripgrep', 'lib', 'index.js');
let resolverText = '';
try { resolverText = readFileSync(resolver, 'utf8'); } catch { /* 缺文件下面断言会红 */ }
ok(resolverText.includes('@vscode/ripgrep-${process.platform}-${arch}'),
  'C1 @vscode/ripgrep 按 `<pkg>-<platform>-<arch>` 解析（与 A4 的目录名必须一致）');

/* ── D. fs-search 走新包、无旧降级 ── */
const fsSearch = join(TREE, '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js');
let fsText = '';
try { fsText = readFileSync(fsSearch, 'utf8'); } catch { /* 下面断言会红 */ }
ok(/from\s+"@deepseek-ai\/dsh-util-ripgrep"/.test(fsText) && fsText.includes('spawnRipgrep'),
  'D1 fs-search 从 @deepseek-ai/dsh-util-ripgrep 取 rg（rc.2 新架构）');
ok(!fsText.includes('buildFallbackArgv') && !fsText.includes('rgExecutable'),
  'D2 fs-search 里没有旧的 find/grep 降级注入（已退役）');
const utilRg = join(TREE, '@deepseek-ai', 'dsh-util-ripgrep', 'lib', 'index.js');
ok(existsSync(utilRg), 'D3 dsh-util-ripgrep 包在树里');

/* ── E. 旧平台包不残留 ── */
ok(!existsSync(OLD_RG_DIR), 'E1 树里没有残留 @vscode/ripgrep-linux-arm64（省 4.6 MB 且避免混淆）');

console.log(fail === 0
  ? `结果：${pass} 项全部通过 —— rg 已自签名并按 openharmony 平台包名注入，fs-search 走 dsh-util-ripgrep（旧 find/grep 降级已退役）`
  : `结果：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
