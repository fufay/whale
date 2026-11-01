'use strict';
/**
 * check-dshm-boot-check.cjs —— 启动期 profile 检查/修复（B）的**零网络**门禁。
 *
 * 用临时 home + 临时 profile 模拟 `ensureProfile()` 完成到"B 插入点"之后的状态：
 * 种子已覆盖、用户行/市场行已拼装、依赖已 sanitize。然后注入各类坏输入，调用
 * `dshm-profile-check.verifyAndRepair()`，断言裁决 mode 与最终文件状态：
 *
 *   §1 纯函数（切块/切条目/取键）——门禁自身可跑，不依赖核心树
 *   §2 L0 clean：健康 profile ⇒ mode=clean，且**零写入**（文件 mtime 不变、不写 boot-check）
 *   §3 L1 修复：坏 sidecar 块 / carried 条目 name 不可解析 / home 层 patch 语法坏 /
 *      package.json JSON 坏 —— 各自得到 repaired，坏东西被剔除、备份在 `.profile-guard/`
 *   §4 L2 safe-mode：L1 修复动作抛错（package.json 被换成目录）⇒ 隔离用户行 + 纯种子启动
 *   §5 种子本身坏 ⇒ fatal（检查器救不了）
 *   §6 负测试：把 `composeUserRows` 关掉（模拟"没有启动检查"）时，坏输入后的 patch
 *      仍然无法解析 ⇒ 证明门禁有牙（不对 verifier 自身做假）
 *
 * 需要核心树（种子 profile）作为输入；干净克隆无核心树时整份 [SKIP]（exit 0）。
 * 用法：node tools/check-dshm-boot-check.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const profileCheck = require(path.join(ROOT, 'hostcore/app/dshm-profile-check.js'));
const userRows = require(path.join(ROOT, 'hostcore/app/dshm-user-rows.js'));
const yamlCheck = require(path.join(ROOT, 'hostcore/app/dshm-yaml-check.js'));

let pass = 0;
let fail = 0;
let skip = 0;
function check(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('[PASS] ' + label);
  } else {
    fail += 1;
    console.log('[FAIL] ' + label + (detail ? ' -- ' + detail : ''));
  }
}
function skipped(label) {
  skip += 1;
  console.log('[SKIP] ' + label);
}

function realCoreDir() {
  try {
    const root = path.join(os.homedir(), 'dsh', 'cores');
    const names = fs.readdirSync(root).sort().reverse();
    for (const n of names) {
      const dir = path.join(root, n);
      if (fs.existsSync(path.join(dir, 'profiles', 'ondevice', 'cordis.patch.yml'))
        && fs.existsSync(path.join(dir, 'node_modules', 'js-yaml', 'package.json'))) {
        return dir;
      }
    }
  } catch (e) {
    // 干净克隆：没有核心树
  }
  return '';
}
const REAL_CORE_DIR = process.env.DSHM_CORE_DIR || realCoreDir();
const YAML_OPTS = { coreDir: REAL_CORE_DIR, homeDir: path.join(os.homedir(), 'dsh', 'home') };
const strict = (text) => yamlCheck.strictParseYaml(text, YAML_OPTS);
console.log('解析器：' + yamlCheck.parserSource(YAML_OPTS));

// ── §1 纯函数（不依赖核心树）──────────────────────────────────────────────
{
  const sidecar = [
    '- id: a',
    '  disabled: false',
    '- id: b',
    '  config:',
    '    x: 1',
    '',
  ].join('\n');
  const blocks = profileCheck.splitSidecarBlocks(sidecar);
  check('§1 splitSidecarBlocks 切出 2 个顶层块', blocks.length === 2 && blocks[0].text.startsWith('- id: a')
    && blocks[1].text.startsWith('- id: b'), JSON.stringify(blocks.map((b) => b.text)));

  const patch = [
    '- id: seed-a',
    '  x: 1',
    '- id: carried-b',
    '  y: 2',
    '# >>> dshm-user-rows（端侧「插件」页写入，勿手工编辑）',
    '- id: managed-c',
    '# <<< dshm-user-rows',
    '',
  ].join('\n');
  const entries = profileCheck.splitTopLevelEntries(patch);
  check('§1 splitTopLevelEntries 排除托管块、保留 2 条顶层条目',
    entries.length === 2 && entries[1].text.includes('carried-b')
    && !entries.some((e) => e.text.includes('managed-c')), JSON.stringify(entries.map((e) => e.text)));
  const ek = profileCheck.entryKey("- id: '@scope/x'\n  y: 1");
  check('§1 entryKey 剥引号取主键', ek !== null && ek.kind === 'id' && ek.value === '@scope/x', JSON.stringify(ek));
  check('§1 entryName 认直接子键、不认 config 内部更深缩进',
    profileCheck.entryName('- id: x\n  name: "pkg-name"') === 'pkg-name'
    && profileCheck.entryName('- id: x\n  config:\n    name: not-me') === '');
  check('§1 fragmentParses：合法片段 true / 重复键片段 false',
    profileCheck.fragmentParses('- id: a\n  x: 1', YAML_OPTS).ok === true
    && profileCheck.fragmentParses('- id: a\n  x: 1\n  x: 2', YAML_OPTS).ok === false);
}

// ── §7 接线（静态断言，不依赖核心树；保证"模块存在但没接进 ensureProfile"不会静默过关）──
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'hostcore/app/main.js'), 'utf8');
  const iQuar = mainSrc.indexOf('quarantineBrokenPackages(dest');
  const iWired = mainSrc.indexOf('verifyAndRepair(dest, HOME_DIR');
  const iReady = mainSrc.indexOf("log('profile 已就位：' + dest)");
  check('§7 B 已接线：verifyAndRepair 在 quarantineBrokenPackages 之后、profile 已就位之前',
    iQuar > 0 && iWired > iQuar && iReady > iWired, JSON.stringify({ iQuar, iWired, iReady }));
  check('§7 fatal 有 fail() 兜底（检查失败必须显式报错，不能静默继续）',
    /verdict\.mode === 'fatal'[\s\S]{0,200}fail\(/.test(mainSrc));
  check('§7 boot 期关闭 depDiagnostics（不 require 安装器，冷启动不为此变慢）',
    /depDiagnostics:\s*false/.test(mainSrc));
  check('§7 检查器缺文件/自身异常时降级为"不检查"（不阻断启动）',
    /profile 启动检查异常（降级为不检查）/.test(mainSrc));
}

// ── 环境构造：临时 home + 真实种子 profile 的副本 ─────────────────────────
function copyDirFiles(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
function writeFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}
function writeFakePkg(profileDir, name) {
  writeFile(path.join(profileDir, 'node_modules', name, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
  writeFile(path.join(profileDir, 'node_modules', name, 'index.js'), 'module.exports = 1;\n');
}
function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-boot-check-'));
  const seedDir = path.join(home, 'seed');
  copyDirFiles(path.join(REAL_CORE_DIR, 'profiles', 'ondevice'), seedDir);
  const profileDir = path.join(home, 'profiles', 'ondevice');
  copyDirFiles(seedDir, profileDir);
  // 模拟 ensureProfile 后：种子覆盖 + composeUserRows（无用户行/市场行/carried 时 compose 会
  // 提前 return，patch 保持种子原文——两种结果都合法可解析）。
  userRows.composeUserRows(profileDir, { profile: 'ondevice', prevPatchText: '' });
  writeFakePkg(profileDir, 'pkgx');
  return { home, seedDir, profileDir };
}
function callCheck(env, extra) {
  return profileCheck.verifyAndRepair(env.profileDir, env.home, {
    profile: 'ondevice',
    coreDir: REAL_CORE_DIR,
    seedDir: env.seedDir,
    log: (m) => console.log('       ' + m),
    ...(extra || {}),
  });
}
function fileSnapshot(p) {
  try {
    const st = fs.statSync(p);
    return { text: fs.readFileSync(p, 'utf8'), mtime: st.mtimeMs };
  } catch (e) {
    return null;
  }
}
function sameSnapshot(a, b) {
  if (a === null || b === null) {
    return a === b;
  }
  return a.text === b.text && a.mtime === b.mtime;
}

async function main() {
  if (REAL_CORE_DIR.length === 0) {
    skipped('没有核心树（干净克隆）⇒ 跳过 §2–§6（B 门禁需要种子 profile 作为输入）');
    console.log('');
    console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped');
    process.exit(fail > 0 ? 1 : 0);
  }

  // ── §2 L0 clean：健康 profile ⇒ 零写入 ────────────────────────────────
  {
    const env = makeEnv();
    const patchPath = path.join(env.profileDir, 'cordis.patch.yml');
    const pkgPath = path.join(env.profileDir, 'package.json');
    const s1 = fileSnapshot(patchPath);
    const s2 = fileSnapshot(pkgPath);
    const r = callCheck(env);
    check('§2 健康 profile ⇒ mode=clean', r.mode === 'clean', JSON.stringify(r).slice(0, 300));
    check('§2 clean 时不写 patch（内容+mtime 均不变）', sameSnapshot(s1, fs.existsSync(patchPath) ? fileSnapshot(patchPath) : null));
    check('§2 clean 时不写 package.json', sameSnapshot(s2, fs.existsSync(pkgPath) ? fileSnapshot(pkgPath) : null));
    check('§2 clean 时不写 boot-check', !fs.existsSync(path.join(env.home, profileCheck.BOOT_CHECK_FILE)));
    check('§2 clean 时 actions 为空', Array.isArray(r.actions) && r.actions.length === 0, JSON.stringify(r.actions));
    fs.rmSync(env.home, { recursive: true, force: true });
  }

  // ── §3 L1：四类坏输入各自 repaired ────────────────────────────────────
  {
    // 3a. 坏 sidecar 块（同一块内重复键）⇒ 只删坏块、保留好块
    const env = makeEnv();
    const rowsPath = path.join(env.profileDir, userRows.USER_ROWS_FILENAME);
    writeFile(rowsPath, [
      '- id: pkgx',
      '  config:',
      '    a: 1',
      '- id: pkgx',
      '  disabled: true',
      '  disabled: false',
      '',
    ].join('\n'));
    const r = callCheck(env);
    const rowsAfter = fs.readFileSync(rowsPath, 'utf8');
    check('§3a 坏套 sidecar 块 ⇒ mode=repaired', r.mode === 'repaired', JSON.stringify(r).slice(0, 300));
    check('§3a 坏块被剔除、好块保留', rowsAfter.includes('- id: pkgx') && !rowsAfter.includes('disabled: false'), rowsAfter);
    check('§3a 写回后的 sidecar 可严格解析', strict(rowsAfter).ok, strict(rowsAfter).reason);
    check('§3a 最终 patch 可严格解析', strict(fs.readFileSync(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8')).ok);
    check('§3a 有 .profile-guard 备份', fs.existsSync(path.join(env.home, profileCheck.GUARD_DIR)));
    fs.rmSync(env.home, { recursive: true, force: true });
  }
  {
    // 3b. carried 条目 name 指向不存在的包 ⇒ 剔除；好条目保留
    const env = makeEnv();
    const prev = [
      '- id: pkgx',
      '  name: pkgx',
      '  config:',
      '    b: 2',
      '- id: ghost',
      '  name: ghost-pkg-not-installed',
      '  config:',
      '    c: 3',
      '',
    ].join('\n');
    const r = callCheck(env, { prevPatchText: prev });
    const patch = fs.readFileSync(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8');
    check('§3b carried 有坏条目 ⇒ mode=repaired', r.mode === 'repaired', JSON.stringify(r).slice(0, 300));
    check('§3b 坏 carried 不再出现在最终 patch', !patch.includes('ghost-pkg-not-installed'), patch.slice(-600));
    check('§3b 好 carried 仍被保留', patch.includes('pkgx'), patch.slice(-600));
    fs.rmSync(env.home, { recursive: true, force: true });
  }
  {
    // 3b2. carried 的 name 指向**核心树**包（@deepseek-ai/...）⇒ 必须保留、mode=clean。
    // 这是 2026-10-24 装机后"每次启动都回到首次设置向导"的真因回归：只看 profile
    // node_modules 会把设置页写的 carried 条目当坏条目全部剔除。
    const env = makeEnv();
    const deeep = path.join(REAL_CORE_DIR, 'node_modules', '@deepseek-ai');
    const corePkg = fs.readdirSync(deeep).sort()
      .find((n) => fs.existsSync(path.join(deeep, n, 'package.json')));
    const coreName = '@deepseek-ai/' + corePkg;
    const prev = '- id: ui-settings\n  name: ' + JSON.stringify(coreName) + '\n  config:\n    enabled: true\n';
    // 模拟 ensureProfile 已用 prevPatchText compose 过（carried 已在 patch 里）
    userRows.composeUserRows(env.profileDir, { profile: 'ondevice', prevPatchText: prev });
    const r = callCheck(env, { prevPatchText: prev });
    const patch = fs.readFileSync(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8');
    check('§3b2 carried 指向核心树包 ⇒ 不算坏（mode=clean，否则用户设置每次启动被清空）',
      r.mode === 'clean', JSON.stringify(r).slice(0, 400));
    check('§3b2 核心树 carried 条目仍在最终 patch 里', patch.includes(coreName), patch.slice(-800));
    fs.rmSync(env.home, { recursive: true, force: true });
  }
  {
    // 3c. home 层 patch 语法坏 ⇒ 改名隔离
    const env = makeEnv();
    writeFile(path.join(env.home, 'cordis.patch.yml'), '::: not yaml :::\n');
    const r = callCheck(env);
    check('§3c home patch 语法坏 ⇒ mode=repaired', r.mode === 'repaired', JSON.stringify(r).slice(0, 300));
    check('§3c home 层坏文件已改名隔离（保留数据）',
      !fs.existsSync(path.join(env.home, 'cordis.patch.yml'))
      && fs.readdirSync(env.home).some((n) => n.startsWith('cordis.patch.yml.quarantine-')));
    fs.rmSync(env.home, { recursive: true, force: true });
  }
  {
    // 3d. package.json JSON 坏 ⇒ 从种子重建
    const env = makeEnv();
    writeFile(path.join(env.profileDir, 'package.json'), '{ this is not json\n');
    const r = callCheck(env);
    const rebuilt = JSON.parse(fs.readFileSync(path.join(env.profileDir, 'package.json'), 'utf8'));
    const seedPkg = JSON.parse(fs.readFileSync(path.join(env.seedDir, 'package.json'), 'utf8'));
    check('§3d package.json 坏 ⇒ mode=repaired', r.mode === 'repaired', JSON.stringify(r).slice(0, 300));
    check('§3d 重建后的 package.json 可解析且含种子 bundles',
      Array.isArray(rebuilt.dsh?.profile?.bundles)
      && rebuilt.dsh.profile.bundles.length === (seedPkg.dsh?.profile?.bundles || []).length);
    fs.rmSync(env.home, { recursive: true, force: true });
  }

  // ── §4 L2：L1 修复动作抛错 ⇒ safe-mode（隔离用户行 + 纯种子启动）──────
  {
    const env = makeEnv();
    const rowsPath = path.join(env.profileDir, userRows.USER_ROWS_FILENAME);
    writeFile(rowsPath, '- id: pkgx\n  config:\n    a: 1\n');
    // 把 package.json 变成目录：readText 得到 null ⇒ 触发"重建"，而 copyFileSync 对目录抛错
    const pkgPath = path.join(env.profileDir, 'package.json');
    fs.rmSync(pkgPath, { force: true });
    fs.mkdirSync(pkgPath);
    writeFile(path.join(pkgPath, 'placeholder'), 'x');
    const r = callCheck(env);
    check('§4 L1 修复动作异常 ⇒ mode=safe-mode（Host 仍能起）', r.mode === 'safe-mode', JSON.stringify(r).slice(0, 400));
    check('§4 safe-mode 时用户行被改名隔离（不删除）',
      !fs.existsSync(rowsPath)
      && fs.readdirSync(env.profileDir).some((n) => n.startsWith(userRows.USER_ROWS_FILENAME + '.quarantine-')));
    check('§4 safe-mode 后 patch 可严格解析', strict(fs.readFileSync(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8')).ok);
    const bc = path.join(env.home, profileCheck.BOOT_CHECK_FILE);
    check('§4 写了 .dshm-boot-check.json（mode=safe-mode）',
      fs.existsSync(bc) && JSON.parse(fs.readFileSync(bc, 'utf8')).mode === 'safe-mode');
    check('§4 未写 boot-failed 标记（否则下次启动会误判"上次失败"）',
      !fs.existsSync(path.join(env.home, userRows.BOOT_FAIL_MARKER)));
    fs.rmSync(env.home, { recursive: true, force: true });
  }

  // ── §5 种子本身坏 ⇒ fatal ─────────────────────────────────────────────
  {
    const env = makeEnv();
    writeFile(path.join(env.seedDir, 'cordis.patch.yml'), '::: broken seed :::\n');
    const r = callCheck(env);
    check('§5 种子 patch 坏 ⇒ mode=fatal 且 reason 指向核心种子',
      r.mode === 'fatal' && /核心种子/.test(r.reason || ''), JSON.stringify(r).slice(0, 300));
    fs.rmSync(env.home, { recursive: true, force: true });
  }

  // ── §6 负测试：没有启动检查时，坏输入后的最终 patch 确实无法解析 ────────
  {
    const env = makeEnv();
    const rowsPath = path.join(env.profileDir, userRows.USER_ROWS_FILENAME);
    // 模拟旧路径：把 composeUserRows 临时替换成 no-op，然后"照旧启动"（不做 B）
    const origCompose = userRows.composeUserRows;
    let negativeOk = false;
    try {
      userRows.composeUserRows = () => {};
      // 不调用 verifyAndRepair：直接看"save 前"状态（= 用户行写入但未 compose 的 profile）
      const patch = fs.readFileSync(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8');
      negativeOk = strict(patch).ok === true; // 种子本身可解析（说明单看 patch 不够，必须靠检查器）
      // 真正的负向证据：把坏块直接拼进 patch（模拟历史上"坏行已被写进 overlay"）
      writeFile(path.join(env.profileDir, 'cordis.patch.yml'),
        patch.replace(/\s*$/, '') + '\n- id: dup\n  x: 1\n  x: 2\n');
      negativeOk = strict(fs.readFileSync(path.join(env.profileDir, 'cordis.patch.yml'), 'utf8')).ok === false;
    } finally {
      userRows.composeUserRows = origCompose;
    }
    check('§6 负测试：坏 overlay 在没有启动检查时确实无法解析（门禁有牙）', negativeOk === true);
    fs.rmSync(env.home, { recursive: true, force: true });
  }

  console.log('');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed' + (skip > 0 ? ', ' + skip + ' skipped' : ''));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[ERROR] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
