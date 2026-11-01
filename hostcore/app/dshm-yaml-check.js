'use strict';
/**
 * 严格 YAML 校验 + 原子写 + 备份（卸载/启动检查共用的"可复用组件"）。
 *
 * 【为什么单独一个模块】
 *   ① 卸载器（`dshm-installer.js`）与启动期检查（`dshm-profile-check.js`）都要用
 *      "与 boot 同源的严格解析"——两处各写一份迟早判据不一致（一边认为能解析、
 *      另一边认为坏），而这类不一致正是本站历史上多次事故的配方；
 *   ② 安装器不能 `require('js-yaml')`：`hostcore/app/*` 是 Host 入口脚本，加运行时
 *      npm 依赖会重演 2026-10-23 的"依赖被扁平覆盖"事故。所以这里**只在运行时从
 *      核心树按绝对路径 require**（boot 用的就是那一份），拿不到才退回内置检测器。
 *
 * 【来源优先级】（规格 §A4）
 *   1. `opts.coreDir`（`main.js` 的 `CORE_DIR`，宿主当前激活的核心树）——最准；
 *   2. `opts.homeDir/../cores/*`（核心版本仓库，取字典序最后一份可加载的）；
 *   3. `opts.profileDir/node_modules/js-yaml`——**兜底**：这份可能正是坏的那份，
 *      仅在前两条都不可用时使用（至少能检出重复键）。
 *
 * 返回约定统一为 `{ok: true}` 或 `{ok: false, reason}`（reason 只取首行，进 UI/日志）。
 */

const fs = require('node:fs');
const path = require('node:path');

let cachedYaml = undefined; // undefined=未探测；null=不可用；否则 {module, source}
let cachedKey = '';

/** 版本仓库目录（$DSH_HOME/../cores）；homeDir 未给时返回空数组。 */
function coreVersionDirs(homeDir) {
  if (typeof homeDir !== 'string' || homeDir.length === 0) {
    return [];
  }
  const coresRoot = path.join(homeDir, '..', 'cores');
  let names = [];
  try {
    names = fs.readdirSync(coresRoot);
  } catch (e) {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((n) => path.join(coresRoot, n, 'node_modules', 'js-yaml'));
}

/** 依次尝试候选目录，返回第一个可 `require` 且带 `load` 的 js-yaml。 */
function probeYaml(opts) {
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  const key = [o.coreDir || '', o.homeDir || '', o.profileDir || ''].join('\u0000');
  if (cachedYaml !== undefined && key === cachedKey) {
    return cachedYaml;
  }
  const candidates = [];
  if (typeof o.coreDir === 'string' && o.coreDir.length > 0) {
    candidates.push({ dir: path.join(o.coreDir, 'node_modules', 'js-yaml'), source: 'coreDir' });
  }
  for (const dir of coreVersionDirs(o.homeDir)) {
    candidates.push({ dir, source: 'cores-scan' });
  }
  if (typeof o.profileDir === 'string' && o.profileDir.length > 0) {
    candidates.push({ dir: path.join(o.profileDir, 'node_modules', 'js-yaml'), source: 'profile-fallback' });
  }
  let found = null;
  for (const c of candidates) {
    if (!fs.existsSync(path.join(c.dir, 'package.json'))) {
      continue;
    }
    try {
      const mod = require(c.dir);
      if (mod !== null && typeof mod === 'object' && typeof mod.load === 'function') {
        found = { module: mod, source: c.source };
        break;
      }
    } catch (e) {
      // 该份不可加载（平台/版本差异）：试下一份
    }
  }
  cachedYaml = found;
  cachedKey = key;
  return found;
}

/** 供日志/门禁显示"这次用的哪份解析器"；不可用时返回 'builtin-dupkey'。 */
function parserSource(opts) {
  const y = probeYaml(opts);
  if (y === null) {
    return 'builtin-dupkey';
  }
  const ver = typeof y.module.VERSION === 'string' ? ':' + y.module.VERSION : '';
  return y.source + ver;
}

/**
 * 内置重复键检测器（核心树不可用时的兜底，移植自 `profile-guard.mjs` 的 findDupKeys）。
 * 只覆盖本问题域的形状：`- id:` 顶层列表 + 2 空格子键；不实现完整 YAML。
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function dupKeyCheck(text) {
  const stack = []; // [{indent, keys: Set}]
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
      stack.pop();
    }
    if (trimmed.startsWith('- ')) {
      // 列表项开启新 mapping：行内 key 不参与"兄弟键"判重（`- id:` 每行都会出现）。
      continue;
    }
    const key = /^([^:#][^:#]*?):(?:\s|$)/.exec(trimmed);
    if (key === null) {
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined && top.indent === indent) {
      if (top.keys.has(key[1])) {
        return { ok: false, reason: `duplicated mapping key "${key[1]}"（第 ${i + 1} 行附近）` };
      }
      top.keys.add(key[1]);
    } else {
      stack.push({ indent, keys: new Set([key[1]]) });
    }
  }
  return { ok: true };
}

/**
 * 严格解析一段 YAML 文本。
 * @param {string} text
 * @param {{coreDir?: string, homeDir?: string, profileDir?: string}} opts
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function strictParseYaml(text, opts) {
  const y = probeYaml(opts);
  if (y === null) {
    return dupKeyCheck(text);
  }
  try {
    y.module.load(text);
    return { ok: true };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    return { ok: false, reason: msg.split('\n')[0] };
  }
}

/**
 * 同目录原子写：写临时文件后 `renameSync`（同一文件系统内 rename 是原子操作）。
 * 保留原文件权限位（profile 下文件可能带组/其它位，写丢会改变真机上的可读性语义）。
 */
function writeFileAtomicSync(file, text) {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (e) {
    // 文件不存在（新建）：用默认 0600
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // rename 失败时清掉临时文件，避免在 profile 里留垃圾
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e2) {
      // 清不掉也只剩一个 .tmp-*，不影响后续（幂等路径会重新覆盖）
    }
    throw e;
  }
}

/** 备份文件到同目录 `<file>.bak-<tag>-<YYYYMMDD-HHmmss>`，返回备份路径。 */
function backupFileSync(file, tag) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const safeTag = String(tag || 'bak').replace(/[^\w.-]/g, '_');
  const dest = `${file}.bak-${safeTag}-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * 只清理**本模块产生的**备份（`<base>.bak-<tag>-*`），按修改时间保留最近 keep 份。
 * 绝不碰用户文件、也不碰别的 tag 的备份。
 */
function pruneBackupsSync(file, tag, keep) {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : 10;
  const dir = path.dirname(file);
  const base = path.basename(file) + '.bak-' + String(tag || 'bak').replace(/[^\w.-]/g, '_') + '-';
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(base));
  } catch (e) {
    return;
  }
  if (names.length <= limit) {
    return;
  }
  const withTime = names.map((n) => {
    let t = 0;
    try {
      t = fs.statSync(path.join(dir, n)).mtimeMs;
    } catch (e) {
      t = 0;
    }
    return { n, t };
  }).sort((a, b) => a.t - b.t);
  for (const item of withTime.slice(0, withTime.length - limit)) {
    try {
      fs.rmSync(path.join(dir, item.n), { force: true });
    } catch (e) {
      // 删不掉就留着（只是多占一点空间，不能因此让卸载失败）
    }
  }
}

module.exports = {
  strictParseYaml,
  parserSource,
  writeFileAtomicSync,
  backupFileSync,
  pruneBackupsSync,
  // 门禁单独验证内置兜底判据用（核心树不可用时它才是实际执行者）
  dupKeyCheck,
};
