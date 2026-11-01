'use strict';
/**
 * 启动期 profile 检查 + 自动修复（B 阶段，2026-10-24）。
 *
 * 【为什么需要它（规格 §1.3）】
 *   写入器已由 A 阶段根治（`removeRowBlocks` + 写后校验），但 boot 侧现有自愈只能判
 *   "包在不在 / 入口可不可加载"，**不校验最终拼出来的 YAML 语法**；markers 丢失、
 *   sidecar 行内重复键、carried 条目坏等仍会 `BOOT_40_PROFILE_BOOT` fatal。本模块对
 *   "boot 真正要读的东西"做**格式级**检查，坏了按阶梯修复，最坏降级为**纯种子安全模式**，
 *   绝不让 Host 起不来。
 *
 * 【修复阶梯（宁窄勿宽，规格 §B3）】
 *   L0 全部通过            → mode=clean，**不写任何文件**（只允许日志）。
 *   L1 源级修复（先备份）  → sidecar 坏块剔除并写回；carried 坏条目剔除；
 *                            home patch 语法坏 ⇒ 改名隔离；package.json JSON 坏 ⇒ 种子重建；
 *                            bundles 去重；然后重放"种子覆盖 + composeUserRows"并严格 parse。
 *   L2 纯种子安全模式      → 用户行/市场行整体隔离、丢弃 carried，只用种子 compose；
 *                            隔离=改名不删除；写 `.dshm-boot-check.json`（**不写 boot-failed**）。
 *   L3 仍失败              → mode=fatal（main.js 调 fail()，并写清哪个文件哪一行）。
 *
 * 【明确不做（避免预期错位，规格 §B1）】
 *   · 插件**运行期** import 失败（文件层看不出来）；
 *   · 核心种子本身坏 / HAP 资源坏（只能 fail）；
 *   · boot 阶段联网修复依赖；
 *   · 检查之后、下次 boot 之前发生的损坏（每次 boot 都会重查）。
 */

const fs = require('node:fs');
const path = require('node:path');
const yamlCheck = require('./dshm-yaml-check.js');
const userRows = require('./dshm-user-rows.js');

const USER_ROWS_FILENAME = userRows.USER_ROWS_FILENAME;
const MARKET_ROWS_FILENAME = userRows.MARKET_ROWS_FILENAME;
const USER_ROWS_BEGIN = userRows.USER_ROWS_BEGIN;
const USER_ROWS_END = userRows.USER_ROWS_END;
const BOOT_CHECK_FILE = '.dshm-boot-check.json';
const GUARD_DIR = '.profile-guard';

/** 时间戳（文件名安全）。 */
function stamp() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/** 读文本；不存在/读失败返回 null（调用方据此区分"没有这个文件"与"读坏了"）。 */
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

/**
 * 把 per-profile 备份到 `$DSH_HOME/.profile-guard/<ts>/`（保留最近 10 组）。
 * 只复制**本次真的要改的文件**；改名隔离（quarantine）不算备份。
 */
function makeBackupDir(homeDir) {
  const dir = path.join(homeDir, GUARD_DIR, stamp() + '-' + process.pid);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return '';
  }
  return dir;
}
function backupInto(backupDir, srcPath) {
  if (typeof backupDir !== 'string' || backupDir.length === 0) {
    return '';
  }
  try {
    const dest = path.join(backupDir, path.basename(srcPath));
    fs.copyFileSync(srcPath, dest);
    return dest;
  } catch (e) {
    return '';
  }
}
function pruneGuardDirs(homeDir, keep) {
  const limit = Number.isInteger(keep) && keep > 0 ? keep : 10;
  const root = path.join(homeDir, GUARD_DIR);
  let names = [];
  try {
    names = fs.readdirSync(root).filter((n) => n.length > 0 && !n.startsWith('.'));
  } catch (e) {
    return;
  }
  if (names.length <= limit) {
    return;
  }
  const withTime = names.map((n) => {
    let t = 0;
    try {
      t = fs.statSync(path.join(root, n)).mtimeMs;
    } catch (e) {
      t = 0;
    }
    return { n, t };
  }).sort((a, b) => a.t - b.t);
  for (const item of withTime.slice(0, withTime.length - limit)) {
    try {
      fs.rmSync(path.join(root, item.n), { recursive: true, force: true });
    } catch (e) {
      // 删不掉就留着（只占空间，不能因此让启动失败）
    }
  }
}

/** 隔离一个文件（改名，不删除）；返回新路径或 ''。 */
function quarantine(file) {
  const dest = `${file}.quarantine-${stamp()}`;
  try {
    fs.renameSync(file, dest);
    return dest;
  } catch (e) {
    return '';
  }
}

// ── 文本切分（sidecar 行 / carried 顶层条目）──────────────────────────────

/**
 * 把 sidecar（`.dshm-plugin-rows.yml`）切成"顶层 row 块"：行首 `- ` 开始，
 * 到下一个行首 `- ` 之前（含空行/注释）。返回 [{start,end,text}]（行号式下标）。
 */
function splitSidecarBlocks(text) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) {
      if (cur !== null) {
        blocks.push(cur);
      }
      cur = { start: i, end: i + 1 };
    } else if (cur !== null) {
      cur.end = i + 1;
    }
  }
  if (cur !== null) {
    blocks.push(cur);
  }
  return blocks.map((b) => ({ ...b, text: lines.slice(b.start, b.end).join('\n') }));
}

/**
 * 把 patch 原文切成"顶层条目"（行首无缩进的 `- ` 开始）。与
 * `carryForeignTopLevelEntries` 同口径，托管块（`# >>> dshm-user-rows` … `# <<<`）整段排除。
 */
function splitTopLevelEntries(text) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  const entries = [];
  let cur = null;
  let inManaged = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === USER_ROWS_BEGIN) {
      inManaged = true;
      continue;
    }
    if (line.trim() === USER_ROWS_END) {
      inManaged = false;
      continue;
    }
    if (inManaged) {
      continue;
    }
    if (/^-\s/.test(line)) {
      if (cur !== null) {
        entries.push(cur);
      }
      cur = { start: i, end: i + 1, lines: [line] };
    } else if (cur !== null) {
      cur.end = i + 1;
      cur.lines.push(line);
    }
  }
  if (cur !== null) {
    entries.push(cur);
  }
  return entries.map((e) => ({ ...e, text: e.lines.join('\n') }));
}

/** 从条目文本取主键（`- id:` 优先，退回 `- name:`）。 */
function entryKey(entryText) {
  const lines = String(entryText).split('\n');
  for (const line of lines) {
    const m = /^-\s+(id|name):\s*(.*)$/.exec(line);
    if (m === null) {
      continue;
    }
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    const hash = v.indexOf(' #');
    if (hash >= 0) {
      v = v.slice(0, hash).trim();
    }
    if (v.length > 0) {
      return { kind: m[1], value: v };
    }
  }
  return null;
}

/** 从条目文本取 `name:`（用于 carried 的"可解析"预检）。 */
function entryName(entryText) {
  for (const line of String(entryText).split('\n')) {
    // 只认 row 起点 `- name:` 或**直接子键**（缩进恰好 2）`  name:`；
    // config: 内部更深缩进的 name 不是条目身份（与 removeRowBlocks 同口径）。
    const m = /^(?:-\s+| {2})name:\s*(.*)$/.exec(line);
    if (m === null) {
      continue;
    }
    let v = m[1].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    const hash = v.indexOf(' #');
    if (hash >= 0) {
      v = v.slice(0, hash).trim();
    }
    if (v.length > 0) {
      return v;
    }
  }
  return '';
}

/** 把一个片段（如 `- id: x\n  y: 1`）当 YAML 解析。 */
function fragmentParses(text, yamlOpts) {
  return yamlCheck.strictParseYaml(String(text).replace(/\s+$/, '') + '\n', yamlOpts);
}

module.exports = {
  // 编排
  verifyAndRepair,
  // 纯函数（门禁直接测）
  splitSidecarBlocks,
  splitTopLevelEntries,
  entryKey,
  entryName,
  fragmentParses,
  BOOT_CHECK_FILE,
  GUARD_DIR,
};

// ── 各项检查 ───────────────────────────────────────────────────────────────

/**
 * 检查 + 修复的上下文（一次 verifyAndRepair 内共享）。
 * @typedef {{profileDir:string, homeDir:string, seedDir:string, coreDir:string,
 *            profile:string, prevPatchText:string, yamlOpts:object,
 *            log:Function, diag:Function, actions:Array, diagnostics:Array}} Ctx
 */

function patchPathOf(ctx) {
  return path.join(ctx.profileDir, 'cordis.patch.yml');
}
function seedPatchPathOf(ctx) {
  return path.join(ctx.seedDir, 'cordis.patch.yml');
}

/** 1) 最终 patch 语法（composeUserRows 之后）；返回 '' 或错误原因。 */
function checkProfilePatch(ctx) {
  const p = patchPathOf(ctx);
  const text = readText(p);
  if (text === null) {
    return 'cordis.patch.yml 不存在';
  }
  const r = yamlCheck.strictParseYaml(text, ctx.yamlOpts);
  return r.ok ? '' : r.reason;
}

/**
 * 2) sidecar 逐块检查。返回 {badBlocks: [{text, reason}], total}。
 * 块"坏"的判据：整块作为 YAML 解析失败。纯函数，便于门禁单测。
 */
function scanSidecarBlocks(text, yamlOpts) {
  const blocks = splitSidecarBlocks(text);
  const bad = [];
  for (const b of blocks) {
    const r = fragmentParses(b.text, yamlOpts);
    if (!r.ok) {
      bad.push({ text: b.text, reason: r.reason });
    }
  }
  return { badBlocks: bad, total: blocks.length };
}

/**
 * 【carried 的 name 可解析性：必须同时看 profile 与**核心树**】
 *
 * 设置页写的 carried 条目（agent-default-model / ui-settings / llm-deepseek / ui-theme…）
 * 的 `name` 指向的是**核心树**里的包（`CORE_DIR/node_modules/@deepseek-ai/...`），
 * profile 自己的 node_modules 里根本没有——这正是 2026-10-24 装机后"每次启动都回到
 * 首次设置向导"的真因：只看 profile 会把用户的设置条目当坏条目全部剔除。
 * 判据与启动期 `sanitizeDependencies(anchorDirs=[CORE_DIR/node_modules])` 同源。
 *
 * @returns '' 表示可解析；否则返回人话原因
 */
function resolveCarriedName(name, anchorDirs) {
  const dirs = Array.isArray(anchorDirs) ? anchorDirs : [];
  let sawDir = false;
  for (const base of dirs) {
    const dir = path.join(base, name);
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      continue;
    }
    sawDir = true;
    const reason = userRows.packageDirLoadable(dir, path.basename(base) + '/' + name);
    if (reason.length === 0) {
      return '';
    }
  }
  return sawDir ? '包目录存在但入口不可加载（profile 与核心树都试过）' : '不在 profile/node_modules，也不在核心树 node_modules';
}

/**
 * 3) carried（上一版 patch 里"种子没有的顶层条目"）逐条检查。
 * 判据：条目片段能解析 + （有 name 时）`userRowLoadable` 认为包可加载。
 * 返回 {good: string, bad: [{text, reason}], total}（good 是过滤后可直接 compose 的文本）。
 */
function filterCarriedEntries(prevPatchText, anchorDirs, yamlOpts) {
  const entries = splitTopLevelEntries(prevPatchText);
  const good = [];
  const bad = [];
  for (const e of entries) {
    const pr = fragmentParses(e.text, yamlOpts);
    if (!pr.ok) {
      bad.push({ text: e.text, reason: 'YAML 解析失败：' + pr.reason });
      continue;
    }
    const name = entryName(e.text);
    if (name.length > 0) {
      const reason = resolveCarriedName(name, anchorDirs);
      if (reason.length > 0) {
        bad.push({ text: e.text, reason: 'name 不可解析：' + reason });
        continue;
      }
    }
    good.push(e.text);
  }
  return {
    good: good.join(good.length > 0 ? '\n' : ''),
    bad,
    total: entries.length,
  };
}

/**
 * 4) home 层 patch（`$DSH_HOME/cordis.patch.yml`）语法。返回 '' 或原因。
 * home 层不在 profile 目录里、种子覆盖够不着；坏了只能隔离（保数据）。
 */
function checkHomePatch(ctx) {
  const p = path.join(ctx.homeDir, 'cordis.patch.yml');
  const text = readText(p);
  if (text === null) {
    return '';
  }
  const r = yamlCheck.strictParseYaml(text, ctx.yamlOpts);
  return r.ok ? '' : r.reason;
}

/** 5) package.json：JSON 合法性 + bundles 去重。返回 {jsonError, dedupChanged, bundles}。 */
function checkPackageJson(ctx) {
  const p = path.join(ctx.profileDir, 'package.json');
  const text = readText(p);
  if (text === null) {
    return { jsonError: 'package.json 不存在', dedupChanged: false };
  }
  let pkg = null;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    return { jsonError: String(e && e.message ? e.message : e).split('\n')[0], dedupChanged: false };
  }
  const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles : [];
  const uniq = [];
  const seen = new Set();
  for (const b of bundles) {
    if (typeof b === 'string' && !seen.has(b)) {
      seen.add(b);
      uniq.push(b);
    }
  }
  return { jsonError: '', dedupChanged: uniq.length !== bundles.length, bundles: uniq, pkg };
}

/** 6) cordis.yml：存在则必须是可解析的 YAML；不存在/空列表都算正常。 */
function checkCoreYml(ctx) {
  const p = path.join(ctx.profileDir, 'cordis.yml');
  const text = readText(p);
  if (text === null || text.trim().length === 0) {
    return '';
  }
  const r = yamlCheck.strictParseYaml(text, ctx.yamlOpts);
  return r.ok ? '' : r.reason;
}

/** 7) 种子本身（seed patch / seed package.json）：坏 ⇒ fatal 的判据。 */
function checkCoreSeed(ctx) {
  const seedPatch = readText(seedPatchPathOf(ctx));
  if (seedPatch === null) {
    return '核心种子缺失：' + seedPatchPathOf(ctx);
  }
  const r = yamlCheck.strictParseYaml(seedPatch, ctx.yamlOpts);
  if (!r.ok) {
    return '核心种子 cordis.patch.yml 解析失败：' + r.reason;
  }
  const seedPkg = readText(path.join(ctx.seedDir, 'package.json'));
  if (seedPkg !== null) {
    try {
      JSON.parse(seedPkg);
    } catch (e) {
      return '核心种子 package.json 解析失败：' + String(e && e.message ? e.message : e).split('\n')[0];
    }
  }
  return '';
}

/** 8) 诊断（只报告不修）：跨 bundle 重复 entry id。 */
function collectBundleDupIds(ctx, diagnostics) {
  const ids = new Map(); // id -> Set(来源)
  const addPatch = (file, kind) => {
    const text = readText(file);
    if (text === null) {
      return;
    }
    for (const line of text.split('\n')) {
      const m = /^\s*-\s+id:\s*(.*)$/.exec(line);
      if (m === null) {
        continue;
      }
      let v = m[1].trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      if (v.length === 0) {
        continue;
      }
      if (!ids.has(v)) {
        ids.set(v, new Set());
      }
      ids.get(v).add(kind);
    }
  };
  addPatch(patchPathOf(ctx), 'profile');
  const pkg = readText(path.join(ctx.profileDir, 'package.json'));
  if (pkg !== null) {
    try {
      const j = JSON.parse(pkg);
      const bundles = j && j.dsh && j.dsh.profile && Array.isArray(j.dsh.profile.bundles)
        ? j.dsh.profile.bundles : [];
      for (const b of bundles) {
        const dir = path.join(ctx.profileDir, 'node_modules', b);
        const meta = readText(path.join(dir, 'package.json'));
        if (meta === null) {
          continue;
        }
        try {
          const mj = JSON.parse(meta);
          const rel = mj && mj.dsh && mj.dsh.bundle && mj.dsh.bundle.patch;
          if (typeof rel === 'string' && rel.length > 0) {
            addPatch(path.join(dir, rel), 'bundle:' + b);
          }
        } catch (e) {
          // bundle manifest 读不了：另一类问题（sanitizeDependencies 负责）
        }
      }
    } catch (e) {
      // package.json 坏：L1 会重建，这里不重复报
    }
  }
  for (const [id, sources] of ids) {
    if (sources.size > 1) {
      diagnostics.push(`entry id 重复：${JSON.stringify(id)} 出现在 ${Array.from(sources).join(' 与 ')}（后者覆盖前者，属合法语义，未自动删）`);
    }
  }
}

/** 9) 诊断（只报告不修）：依赖版本不满足（复用安装器的 10-23 体检函数）。 */
function collectDepDiagnostics(ctx, diagnostics) {
  try {
    const installer = require('./dshm-installer.js');
    if (typeof installer.collectDependencyWarnings !== 'function') {
      return;
    }
    const warnings = installer.collectDependencyWarnings(ctx.profileDir);
    for (const w of warnings) {
      diagnostics.push(`依赖版本告警：${w.pkg} 需要 ${w.dep}@${w.range}，实际 `
        + (w.found.length > 0 ? `${w.found}（来自 ${w.from}）` : '未安装'));
    }
  } catch (e) {
    diagnostics.push('依赖体检不可用（忽略）：' + (e && e.message ? e.message : e));
  }
}

// ── 修复动作（L1/L2）──────────────────────────────────────────────────────

/** 把过滤后的 sidecar 写回（原子写 + 备份）；返回是否写回。 */
function rewriteSidecar(ctx, keptRowsText, backupDir) {
  const p = path.join(ctx.profileDir, USER_ROWS_FILENAME);
  const before = readText(p);
  if (before === null || keptRowsText === before) {
    return false;
  }
  backupInto(backupDir, p);
  yamlCheck.writeFileAtomicSync(p, keptRowsText.endsWith('\n') ? keptRowsText : keptRowsText + '\n');
  return true;
}

/**
 * 【L1 的核心】重放 ensureProfile 的"种子覆盖 + composeUserRows"：
 * 先把**核心种子** patch 复制回 profile（与 ensureProfile 同源同序），再带上
 * （已过滤的）prevPatchText 调用 composeUserRows。
 *
 * 为什么必须先从种子重放：composeUserRows 把**当前** patch 当种子；而当前 patch 里
 * 已经混入了上一轮的 carried（可能正是坏条目）。只有从种子重放才能保证"坏 carried
 * 不再被带回来"，同时用户行/市场行仍按既有语义重新拼装。
 */
function recomposeFromSeed(ctx, prevPatchText, backupDir) {
  const seedPatch = seedPatchPathOf(ctx);
  const destPatch = patchPathOf(ctx);
  backupInto(backupDir, destPatch);
  fs.copyFileSync(seedPatch, destPatch);
  userRows.composeUserRows(ctx.profileDir, {
    log: ctx.log,
    diag: ctx.diag,
    profile: ctx.profile,
    prevPatchText,
  });
}

/** package.json 坏 ⇒ 用种子重建（保留可读字段不可能时宁可从种子起）。 */
function rebuildPackageJson(ctx, backupDir) {
  const destPkg = path.join(ctx.profileDir, 'package.json');
  backupInto(backupDir, destPkg);
  fs.copyFileSync(path.join(ctx.seedDir, 'package.json'), destPkg);
  return true;
}

/** bundles 去重写回（原子写 + 备份）。 */
function dedupeBundles(ctx, backupDir) {
  const p = path.join(ctx.profileDir, 'package.json');
  const text = readText(p);
  if (text === null) {
    return false;
  }
  let pkg = null;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    return false;
  }
  if (!(pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles))) {
    return false;
  }
  const seen = new Set();
  const uniq = [];
  for (const b of pkg.dsh.profile.bundles) {
    if (typeof b === 'string' && !seen.has(b)) {
      seen.add(b);
      uniq.push(b);
    }
  }
  if (uniq.length === pkg.dsh.profile.bundles.length) {
    return false;
  }
  pkg.dsh.profile.bundles = uniq;
  backupInto(backupDir, p);
  yamlCheck.writeFileAtomicSync(p, JSON.stringify(pkg, null, 2) + '\n');
  return true;
}

/** 写 `.dshm-boot-check.json`（非 clean 才写；供 UI/下次启动展示；不阻塞启动）。 */
function writeBootCheck(ctx, mode, reason) {
  const payload = {
    at: new Date().toISOString(),
    mode,
    reason: reason || '',
    actions: ctx.actions,
    diagnostics: ctx.diagnostics,
  };
  try {
    yamlCheck.writeFileAtomicSync(path.join(ctx.homeDir, BOOT_CHECK_FILE),
      JSON.stringify(payload, null, 2) + '\n');
  } catch (e) {
    ctx.log('写 boot-check 失败（忽略）：' + (e && e.message ? e.message : e));
  }
}

// ── 编排 ───────────────────────────────────────────────────────────────────

/**
 * 检查并（必要时）修复 profile，返回裁决：
 * `{mode: 'clean'|'repaired'|'safe-mode'|'fatal', reason?, actions, diagnostics}`。
 *
 * **必须全程不抛**：检查器自身异常时尝试 L2（纯种子），仍失败才 fatal。
 *
 * @param {string} profileDir 例如 `$DSH_HOME/profiles/ondevice`
 * @param {string} homeDir   `$DSH_HOME`
 * @param {object} opts      `{profile, coreDir, seedDir, prevPatchText, log, diag}`
 */
function verifyAndRepair(profileDir, homeDir, opts) {
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  const ctx = {
    profileDir,
    homeDir,
    seedDir: typeof o.seedDir === 'string' ? o.seedDir : '',
    coreDir: typeof o.coreDir === 'string' ? o.coreDir : '',
    profile: typeof o.profile === 'string' && o.profile.length > 0 ? o.profile : 'ondevice',
    prevPatchText: typeof o.prevPatchText === 'string' ? o.prevPatchText : '',
    // 依赖体检是唯一会 require 安装器（~95KB）的检查项；boot 期默认关（主查在每次
    // 安装后的 depWarnings），门禁/诊断场景可显式打开。
    depDiagnostics: o.depDiagnostics === true,
    log: typeof o.log === 'function' ? o.log : () => {},
    diag: typeof o.diag === 'function' ? o.diag : () => {},
    actions: [],
    diagnostics: [],
  };
  ctx.yamlOpts = { coreDir: ctx.coreDir, homeDir: ctx.homeDir, profileDir: ctx.profileDir };
  /*
   * carried 的 name 解析锚点：profile 自己的 node_modules + **核心树** node_modules。
   * coreDir 没传时（罕见）扫一遍 `$DSH_HOME/../cores/*` 取最新一份带 node_modules 的树，
   * 与 dshm-yaml-check 的解析器优先级同思路——否则设置条目会被误判为坏条目。
   */
  ctx.anchorDirs = [path.join(profileDir, 'node_modules')];
  if (ctx.coreDir.length > 0) {
    ctx.anchorDirs.push(path.join(ctx.coreDir, 'node_modules'));
  } else {
    try {
      const coresRoot = path.join(homeDir, '..', 'cores');
      const latest = fs.readdirSync(coresRoot).sort().reverse()
        .map((n) => path.join(coresRoot, n, 'node_modules'))
        .find((d) => fs.existsSync(d));
      if (latest !== undefined) {
        ctx.anchorDirs.push(latest);
      }
    } catch (e) {
      // 没有核心树：只有 profile 锚点（干净克隆场景）
    }
  }
  const done = (mode, reason) => {
    if (mode !== 'clean') {
      writeBootCheck(ctx, mode, reason);
    }
    return { mode, reason: reason || '', actions: ctx.actions, diagnostics: ctx.diagnostics };
  };

  // ── L3 前置：种子都没有/坏了，检查器救不了（只能 fail）────────────────
  const seedError = checkCoreSeed(ctx);
  if (seedError.length > 0) {
    return done('fatal', seedError);
  }

  try {
    // ── L0：全部检查通过 ⇒ clean（零写入）──────────────────────────────
    const patchErr = checkProfilePatch(ctx);
    const rowsText = readText(path.join(profileDir, USER_ROWS_FILENAME)) || '';
    const rowsScan = rowsText.length > 0
      ? scanSidecarBlocks(rowsText, ctx.yamlOpts) : { badBlocks: [], total: 0 };
    const carried = filterCarriedEntries(ctx.prevPatchText, ctx.anchorDirs, ctx.yamlOpts);
    const homeErr = checkHomePatch(ctx);
    const pkgChk = checkPackageJson(ctx);
    const coreYmlErr = checkCoreYml(ctx);
    const clean = patchErr.length === 0 && rowsScan.badBlocks.length === 0
      && carried.bad.length === 0 && homeErr.length === 0
      && pkgChk.jsonError.length === 0 && !pkgChk.dedupChanged && coreYmlErr.length === 0;
    if (clean) {
      // 诊断只报告不修（不阻止 clean）
      collectBundleDupIds(ctx, ctx.diagnostics);
      if (ctx.depDiagnostics) {
        collectDepDiagnostics(ctx, ctx.diagnostics);
      }
      if (ctx.diagnostics.length > 0) {
        ctx.log(`启动检查：诊断 ${ctx.diagnostics.length} 条（不影响启动）`);
      }
      return done('clean');
    }

    // ── L1：源级修复（每步先备份到 $DSH_HOME/.profile-guard/<ts>/）────────
    const backupDir = makeBackupDir(homeDir);
    let repairFailed = false;

    if (rowsScan.badBlocks.length > 0) {
      // 只删坏块、保留其它行；写回后再重放 compose。
      const badTexts = new Set(rowsScan.badBlocks.map((b) => b.text));
      const keptBlocks = [];
      for (const b of splitSidecarBlocks(rowsText)) {
        if (!badTexts.has(b.text)) {
          keptBlocks.push(b.text);
        }
      }
      const kept = keptBlocks.join('\n');
      if (rewriteSidecar(ctx, kept, backupDir)) {
        ctx.actions.push({ file: USER_ROWS_FILENAME, kind: 'drop-bad-rows', detail: `${rowsScan.badBlocks.length}/${rowsScan.total} 块` });
        ctx.log(`启动检查：剔除 ${rowsScan.badBlocks.length} 个坏用户行块（已备份）`);
      } else {
        repairFailed = true;
      }
    }
    if (carried.bad.length > 0) {
      ctx.actions.push({ file: 'cordis.patch.yml(carried)', kind: 'drop-bad-carried', detail: `${carried.bad.length}/${carried.total} 条` });
      ctx.log(`启动检查：剔除 ${carried.bad.length} 条坏 carried 条目：`
        + carried.bad.map((b) => (entryKey(b.text) || { value: '?' }).value + '(' + b.reason + ')').join('；'));
    }
    if (homeErr.length > 0) {
      const hp = path.join(homeDir, 'cordis.patch.yml');
      const moved = quarantine(hp);
      if (moved.length > 0) {
        ctx.actions.push({ file: 'cordis.patch.yml(home)', kind: 'quarantine', detail: `→ ${path.basename(moved)}` });
        ctx.log('启动检查：home 层 patch 语法坏，已改名隔离：' + moved);
      } else {
        repairFailed = true;
      }
    }
    if (pkgChk.jsonError.length > 0) {
      if (rebuildPackageJson(ctx, backupDir)) {
        ctx.actions.push({ file: 'package.json', kind: 'rebuild-from-seed', detail: pkgChk.jsonError });
        ctx.log('启动检查：package.json 损坏（' + pkgChk.jsonError + '），已从种子重建（旧文件已备份）');
      } else {
        repairFailed = true;
      }
    } else if (pkgChk.dedupChanged) {
      if (dedupeBundles(ctx, backupDir)) {
        ctx.actions.push({ file: 'package.json', kind: 'dedupe-bundles', detail: '' });
      }
    }
    if (coreYmlErr.length > 0) {
      const moved = quarantine(path.join(profileDir, 'cordis.yml'));
      if (moved.length > 0) {
        ctx.actions.push({ file: 'cordis.yml', kind: 'quarantine', detail: coreYmlErr });
      }
    }

    if (!repairFailed) {
      // 重放"种子覆盖 + composeUserRows"（carried 用过滤后的文本），再严格 parse。
      recomposeFromSeed(ctx, carried.good, backupDir);
      const after = checkProfilePatch(ctx);
      if (after.length === 0) {
        collectBundleDupIds(ctx, ctx.diagnostics);
        if (ctx.depDiagnostics) {
          collectDepDiagnostics(ctx, ctx.diagnostics);
        }
        pruneGuardDirs(homeDir, 10);
        return done('repaired');
      }
      ctx.log('启动检查：L1 修复后仍无法解析（' + after + '），降级到纯种子安全模式');
    } else {
      ctx.log('启动检查：L1 修复动作失败，降级到纯种子安全模式');
    }

    // ── L2：纯种子安全模式（隔离用户行/市场行，丢弃 carried）────────────
    const qRows = quarantine(path.join(profileDir, USER_ROWS_FILENAME));
    const qMarket = quarantine(path.join(profileDir, MARKET_ROWS_FILENAME));
    if (qRows.length > 0) {
      ctx.actions.push({ file: USER_ROWS_FILENAME, kind: 'quarantine', detail: `→ ${path.basename(qRows)}` });
    }
    if (qMarket.length > 0) {
      ctx.actions.push({ file: MARKET_ROWS_FILENAME, kind: 'quarantine', detail: `→ ${path.basename(qMarket)}` });
    }
    recomposeFromSeed(ctx, '', backupDir);
    const safe = checkProfilePatch(ctx);
    if (safe.length === 0) {
      ctx.log('启动检查：已降级为纯种子安全模式（用户插件本次不加载；原文件已改名保留）');
      return done('safe-mode');
    }
    // ── L3：连纯种子都拼不出可解析 patch ⇒ fatal ─────────────────────────
    return done('fatal', '纯种子安全模式仍无法生成可解析的 cordis.patch.yml：' + safe);
  } catch (e) {
    // 检查器自身异常：不能让启动被它带崩。尽力尝试 L2（纯种子），失败才 fatal。
    const reason = '启动检查器异常：' + (e && e.message ? e.message : String(e));
    ctx.log(reason);
    try {
      // 与 L2 同语义：先隔离用户行/市场行（改名不删除），再从纯种子重放。
      const qRows = quarantine(path.join(profileDir, USER_ROWS_FILENAME));
      const qMarket = quarantine(path.join(profileDir, MARKET_ROWS_FILENAME));
      if (qRows.length > 0) {
        ctx.actions.push({ file: USER_ROWS_FILENAME, kind: 'quarantine', detail: `→ ${path.basename(qRows)}` });
      }
      if (qMarket.length > 0) {
        ctx.actions.push({ file: MARKET_ROWS_FILENAME, kind: 'quarantine', detail: `→ ${path.basename(qMarket)}` });
      }
      recomposeFromSeed(ctx, '', '');
      if (checkProfilePatch(ctx).length === 0) {
        return done('safe-mode', reason);
      }
    } catch (e2) {
      // 落到 fatal
    }
    return done('fatal', reason);
  }
}
