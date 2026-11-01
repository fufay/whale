'use strict';
/**
 * check-dshm-uninstall.cjs —— 卸载不再写坏 `cordis.patch.yml`（2026-10-24 事故根治）的
 * **零网络**回归门禁。
 *
 * 覆盖：
 *   §1 `removeRowBlocks` 的 16 条边界（规格 §A2 表的 14 条 + 后缀语义 2 条）：
 *      整块删除、引号、后缀、`insert:` 容器、空行/注释边界、CRLF…
 *   §2 历史事故 fixture（10-08 / 10-09 / 10-24）：
 *      · 坏文件必须被**与 boot 同源**的严格解析器判坏（证明 fixture 形状对）；
 *      · **前态重建测试**：干净文件 + 还原被删插件那一行 → 整块删除 → **逐字节**回到
 *        干净文件（证明新逻辑不会再留下孤儿子键）；
 *      · 已坏的孤儿块没有身份行、无法按身份定位 ⇒ 由 B（启动期检查）负责，此处只钉边界。
 *   §3 `removeSpec` 集成（临时 profile）：真删一次，断言整块消失、其它行逐字节保留、
 *      写后严格解析通过、备份存在、package.json 依赖/bundles 摘名、二次调用幂等不写盘。
 *   §4 写后校验失败 ⇒ 回滚 + `ok:false`（"写坏了还回 ok:true"的回归保护）。
 *   §5 负测试：从 git 历史里取**改动前**的 installer，跑同一 fixture ⇒ 它必须留下孤儿
 *      子键（旧代码"假成功"被当场抓出，证明门禁有牙）。
 *
 * 不触网、不碰真机 profile；fixture 缺失时对应小节打印 [SKIP]（干净克隆仍可跑）。
 * 用法：node tools/check-dshm-uninstall.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const installer = require(path.join(ROOT, 'hostcore/app/dshm-installer.js'));
const yamlCheck = require(path.join(ROOT, 'hostcore/app/dshm-yaml-check.js'));
const WORKSPACE = path.resolve(ROOT, '..', '..');
const FIXTURE_DIR = path.join(WORKSPACE, 'DSHM问题汇总与解决', '附件-脚本与证据');
const BUILD_DIR = path.join(WORKSPACE, 'Build', 'whale-profile-backup-20261024-1210');

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
const logInstaller = (m) => console.log('       ' + m);

if (typeof installer.removeRowBlocks !== 'function' || typeof yamlCheck.strictParseYaml !== 'function') {
  console.error('[FATAL] 依赖的导出缺失（removeRowBlocks / strictParseYaml）');
  process.exit(1);
}

// ── 严格解析器：直接复用生产模块（与 boot 同源），门禁不再自带第二份实现 ──
function realCoreDir() {
  try {
    const root = path.join(os.homedir(), 'dsh', 'cores');
    const names = fs.readdirSync(root).sort().reverse();
    for (const n of names) {
      const dir = path.join(root, n);
      if (fs.existsSync(path.join(dir, 'node_modules', 'js-yaml', 'package.json'))) {
        return dir;
      }
    }
  } catch (e) {
    // 干净克隆：没有核心树
  }
  return '';
}
const REAL_CORE_DIR = process.env.DSHM_CORE_DIR || realCoreDir();
const YAML_OPTS = {
  coreDir: REAL_CORE_DIR,
  homeDir: path.join(os.homedir(), 'dsh', 'home'),
};
console.log('解析器：' + yamlCheck.parserSource(YAML_OPTS));
const strict = (text) => yamlCheck.strictParseYaml(text, YAML_OPTS);

// ── §1 规格 §A2 的边界（14 条 + 后缀语义 2 条）──────────────────────────
{
  const cases = [
    { name: '1 顶层 row + config 子块 ⇒ 整块删除、config 不残留',
      input: '- id: a\n  name: a\n  config:\n    x: 1\n- id: b\n',
      identity: { ids: ['a'] }, expected: '- id: b\n', removed: 1 },
    { name: '2 顶层 - name: 行（无 id）⇒ 整块删除',
      input: '- name: a\n  disabled: true\n- id: b\n',
      identity: { ids: ['a'] }, expected: '- id: b\n', removed: 1 },
    { name: '3 id 带单/双引号 ⇒ 剥离后命中',
      input: "- id: 'a'\n  x: 1\n- id: \"b\"\n  y: 2\n",
      identity: { ids: ['a', 'b'] }, expected: '', removed: 2 },
    { name: '4 行内注释命中；块前注释保留',
      input: '# top\n- id: a # note\n  x: 1\n# tail\n',
      identity: { ids: ['a'] }, expected: '# top\n# tail\n', removed: 1 },
    { name: '5 - insert: 下嵌套 - id: ⇒ 删子行 + 回收空容器',
      input: '- insert:\n    - id: a\n      x: 1\n',
      identity: { ids: ['a'] }, expected: '', removed: 1 },
    { name: '6 insert 下两个子行，只删命中的；容器保留',
      input: '- insert:\n    - id: a\n    - id: b\n      x: 1\n',
      identity: { ids: ['a'] }, expected: '- insert:\n    - id: b\n      x: 1\n', removed: 1 },
    { name: '7 &path: 后缀匹配（-suffix / /suffix / @suffix 结尾；与旧实现语义一致）',
      input: "- id: '@ext/dsh-client-ui-skin-maid-atelier'\n  x: 1\n- id: '@ext/orca-link'\n  y: 2\n",
      identity: { ids: [], suffixes: ['maid-atelier', 'link'] }, expected: '', removed: 2 },
    { name: '7b 后缀不误伤：skin-maid-ateliere 不匹配 suffix maid-atelier',
      input: "- id: '@ext/dsh-client-ui-skin-maid-ateliere'\n  x: 1\n- id: '@ext/dsh-client-ui-skin-maid-atelier'\n  y: 2\n",
      identity: { ids: [], suffixes: ['maid-atelier'] },
      expected: "- id: '@ext/dsh-client-ui-skin-maid-ateliere'\n  x: 1\n", removed: 1 },
    { name: '8 同一身份出现两次 ⇒ 两处都删',
      input: '- id: a\n  x: 1\n- id: b\n- id: a\n  y: 2\n',
      identity: { ids: ['a'] }, expected: '- id: b\n', removed: 2 },
    { name: '9 块内空行/更深注释属于 row；与相邻 row 之间的空行保留',
      input: '- id: a\n  x: 1\n\n  # deeper note\n  y: 2\n\n- id: b\n',
      identity: { ids: ['a'] }, expected: '\n- id: b\n', removed: 1 },
    { name: '10 干净文件无命中 ⇒ 文本逐字节不变、removed=0',
      input: '- id: a\n  x: 1\n- id: b\n',
      identity: { ids: ['zzz'] }, expected: '- id: a\n  x: 1\n- id: b\n', removed: 0 },
    { name: '11 只有 header 注释 + 该 row ⇒ 删后仅剩 header',
      input: '# header\n- id: a\n',
      identity: { ids: ['a'] }, expected: '# header\n', removed: 1 },
    { name: '12 CRLF 行尾按原样保留',
      input: '- id: a\r\n  x: 1\r\n- id: b\r\n',
      identity: { ids: ['a'] }, expected: '- id: b\r\n', removed: 1 },
    { name: '13 - id: X 的 config: 里出现 name: X ⇒ 不匹配（防误删）',
      input: '- id: a\n  config:\n    name: b\n- id: c\n',
      identity: { ids: ['b'] }, expected: '- id: a\n  config:\n    name: b\n- id: c\n', removed: 0 },
    { name: '14 insert 容器的 config 里出现 id/name ⇒ 不匹配、容器不动',
      input: '- insert:\n    - id: a\n      config:\n        name: b\n',
      identity: { ids: ['b'] }, expected: '- insert:\n    - id: a\n      config:\n        name: b\n', removed: 0 },
  ];
  for (const c of cases) {
    const r = installer.removeRowBlocks(c.input, c.identity);
    check(c.name, r.removed === c.removed && r.text === c.expected,
      JSON.stringify({ removed: r.removed, text: r.text }));
  }
}

// ── §2 历史事故 fixture ────────────────────────────────────────────────────
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}
function insertBeforeMarker(text, rowText) {
  const marker = '# >>> dshm-user-rows';
  const at = text.indexOf(marker);
  return at < 0 ? null : text.slice(0, at) + rowText + text.slice(at);
}
{
  const damagedA = readText(path.join(FIXTURE_DIR, '事故-坏-cordis.patch.yml'));
  const fixedA = readText(path.join(FIXTURE_DIR, '修复后-cordis.patch.yml'));
  const damagedB = readText(path.join(FIXTURE_DIR, '事故2-卸载遗留孤儿config块-坏文件-20261009-1418'));
  const fixedB = readText(path.join(FIXTURE_DIR, '修复后-profile-cordis.patch.yml-20261009-1421'));
  const orig = readText(path.join(FIXTURE_DIR, 'ORIG-profile-cordis.patch.yml'));
  if (damagedA === null || fixedA === null) {
    skipped('fixture 目录不存在（干净克隆）⇒ 跳过 10-08/10-09 历史文件断言');
  } else {
    check('fixture A（10-08 残留 disabled）确实无法严格解析', strict(damagedA).ok === false, strict(damagedA).reason);
    check('fixture B（10-09 残留 config 块）确实无法严格解析', strict(damagedB).ok === false, strict(damagedB).reason);
    check('fixture A/B 的修复后版本都能严格解析', strict(fixedA).ok && strict(fixedB).ok);
    check('干净基线 ORIG 能严格解析', orig !== null && strict(orig).ok);

    const preA = insertBeforeMarker(fixedA, '- id: dsh-proxyagent\n  disabled: true\n');
    const ra = preA === null ? null : installer.removeRowBlocks(preA, { ids: ['dsh-proxyagent'] });
    check('前态重建 A：整块删除后逐字节回到修复后文件（10-08 形状不再产生孤儿 disabled）',
      ra !== null && ra.removed === 1 && ra.text === fixedA,
      ra === null ? 'marker missing' : JSON.stringify({ removed: ra.removed, same: ra.text === fixedA }));

    const preB = insertBeforeMarker(fixedB,
      '- id: dsh-proxyagent\n  config:\n'
      + '    subscriptionUrl: https://em.mesl.cloud/ems/get?token=43469a4a7995f50a5d3f1aa6b892a969\n'
      + '    mixedPort: 17890\n    ctlPort: 19090\n    mihomoVersion: v1.19.32\n');
    const rb = preB === null ? null : installer.removeRowBlocks(preB, { ids: ['dsh-proxyagent'] });
    check('前态重建 B：整块删除后逐字节回到修复后文件（10-09 形状不再产生孤儿 config）',
      rb !== null && rb.removed === 1 && rb.text === fixedB,
      rb === null ? 'marker missing' : JSON.stringify({ removed: rb.removed, same: rb.text === fixedB }));

    const ra2 = installer.removeRowBlocks(damagedA, { ids: ['dsh-proxyagent'] });
    check('已坏文件里的孤儿块不由 A 目标（交 B 的启动期检查）', ra2.removed === 0 && ra2.text === damagedA);
    check('干净文件无命中时逐字节不变（不碰 mtime 的前提）',
      orig !== null && installer.removeRowBlocks(orig, { ids: ['dsh-proxyagent'] }).text === orig);
  }
  const damagedC = readText(path.join(BUILD_DIR, 'cordis.patch.yml.damaged'));
  if (damagedC === null) {
    skipped('10-24 现场备份不存在 ⇒ 跳过该 fixture');
  } else {
    check('fixture C（10-24 孤儿 config: profile: ondevice）确实无法严格解析', strict(damagedC).ok === false, strict(damagedC).reason);
    check('fixture C 不含被卸载插件身份 ⇒ 只能由 B 修复',
      installer.removeRowBlocks(damagedC, { ids: ['dsh-skin-market'], suffixes: ['dsh-skin-market'] }).removed === 0);
  }
}

// ── §3 removeSpec 集成（临时 profile，零网络）──────────────────────────────
function writeFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}
function makeTempProfile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-uninstall-'));
  const profileDir = path.join(home, 'profiles', 'ondevice');
  writeFile(path.join(profileDir, 'node_modules', 'dsh-proxyagent', 'package.json'),
    '{"name":"dsh-proxyagent","version":"1.0.0"}\n');
  writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'ondevice',
    dependencies: { 'dsh-proxyagent': '1.0.0', 'dsh-better-sidebar': '1.0.0' },
    dsh: { profile: { bundles: ['dsh-proxyagent', 'dsh-better-sidebar'] } },
  }, null, 2) + '\n');
  writeFile(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: dsh-better-sidebar',
    '  name: dsh-better-sidebar',
    '  config:',
    '    titleBarScheme: preset',
    '- id: dsh-proxyagent',
    '  name: dsh-proxyagent',
    '  config:',
    '    subscriptionUrl: https://example.invalid/x',
    '  disabled: true',
    '- id: dsh-context',
    '  name: dsh-context',
    '  config:',
    '    defaultPlacement: all',
    '',
  ].join('\n'));
  writeFile(path.join(profileDir, '.dshm-plugin-rows.yml'), [
    '- id: dsh-better-sidebar',
    '  disabled: false',
    '- id: dsh-proxyagent',
    '  config:',
    '    mixedPort: 17890',
    '',
  ].join('\n'));
  return { home, profileDir };
}
async function main() {
  {
    const { home, profileDir } = makeTempProfile();
    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    const rowsPath = path.join(profileDir, '.dshm-plugin-rows.yml');
    const patchBefore = fs.readFileSync(patchPath, 'utf8');
    const r = await installer.removeSpec('dsh-proxyagent', {
      homeDir: home, profile: 'ondevice', coreDir: REAL_CORE_DIR, log: logInstaller,
    });
    check('§3 removeSpec 返回 ok', r.ok === true, JSON.stringify(r).slice(0, 300));
    const patchAfter = fs.readFileSync(patchPath, 'utf8');
    check('§3 被卸插件整块消失（id/name/config/disabled 全无）',
      !patchAfter.includes('dsh-proxyagent') && !patchAfter.includes('subscriptionUrl') && !patchAfter.includes('disabled: true'));
    check('§3 其它行逐字节保留',
      patchAfter.includes('- id: dsh-better-sidebar\n  name: dsh-better-sidebar\n  config:\n    titleBarScheme: preset')
      && patchAfter.includes('- id: dsh-context\n  name: dsh-context\n  config:\n    defaultPlacement: all'));
    check('§3 写后 patch 严格解析通过', strict(patchAfter).ok, strict(patchAfter).reason);
    check('§3 写后用户行严格解析通过', strict(fs.readFileSync(rowsPath, 'utf8')).ok);
    const backups = fs.readdirSync(profileDir);
    check('§3 两个文件都写了 .bak-uninstall-* 备份',
      backups.some((n) => n.startsWith('cordis.patch.yml.bak-uninstall-'))
      && backups.some((n) => n.startsWith('.dshm-plugin-rows.yml.bak-uninstall-')), JSON.stringify(backups));
    check('§3 removed 回报两个文件',
      Array.isArray(r.removed) && r.removed.includes('cordis.patch.yml') && r.removed.includes('.dshm-plugin-rows.yml'),
      JSON.stringify(r.removed));
    const pkgAfter = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    check('§3 package.json 依赖与 bundles 摘名',
      pkgAfter.dependencies['dsh-proxyagent'] === undefined
      && !(pkgAfter.dsh.profile.bundles || []).includes('dsh-proxyagent'));

    const m1 = fs.statSync(patchPath).mtimeMs;
    const m2 = fs.statSync(rowsPath).mtimeMs;
    const r2 = await installer.removeSpec('dsh-proxyagent', { homeDir: home, profile: 'ondevice' });
    check('§3 二次卸载幂等（ok、removed 为空、两文件 mtime 不动）',
      r2.ok === true && Array.isArray(r2.removed) && r2.removed.length === 0
      && fs.statSync(patchPath).mtimeMs === m1 && fs.statSync(rowsPath).mtimeMs === m2,
      JSON.stringify(r2).slice(0, 200));
    check('§3 内容与第一次卸载后逐字节一致', fs.readFileSync(patchPath, 'utf8') === patchAfter && patchBefore !== patchAfter);
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── §4 写后校验失败 ⇒ 回滚 + ok:false ─────────────────────────────────
  {
    const { home, profileDir } = makeTempProfile();
    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    const corrupted = fs.readFileSync(patchPath, 'utf8') + '::: not yaml :::\n';
    fs.writeFileSync(patchPath, corrupted, 'utf8');
    const r = await installer.removeSpec('dsh-proxyagent', {
      homeDir: home, profile: 'ondevice', coreDir: REAL_CORE_DIR, log: logInstaller,
    });
    check('§4 写后解析失败 ⇒ ok:false 且错误含"已回滚"', r.ok === false && /已回滚/.test(r.error || ''), JSON.stringify(r).slice(0, 300));
    check('§4 文件已逐字节回滚到写前', fs.readFileSync(patchPath, 'utf8') === corrupted);
    check('§4 回滚件存在（.bak-uninstall-*）',
      fs.readdirSync(profileDir).some((n) => n.startsWith('cordis.patch.yml.bak-uninstall-')));
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ── §5 负测试：改动前的旧实现必须被同一 fixture 判红 ──────────────────────
  {
    let oldSrc = null;
    try {
      const revs = execFileSync('git', ['rev-list', '--max-count=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
        .trim().split('\n').filter((s) => s.length > 0);
      for (const rev of revs) {
        let src = '';
        try {
          src = execFileSync('git', ['show', rev + ':hostcore/app/dshm-installer.js'],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        } catch (e) {
          continue;
        }
        const buggyFilter = "const next = patch.split('\\n').filter((l) => !isTargetLine(l)).join('\\n');";
        if (src.includes('function removeRowBlockById(') && src.includes(buggyFilter)) {
          oldSrc = src;
          console.log('       （负测试基准版本：' + rev.slice(0, 8) + '）');
          break;
        }
      }
    } catch (e) {
      // 非 git / 浅克隆
    }
    if (oldSrc === null) {
      skipped('git 历史里找不到改动前的 installer ⇒ 跳过负测试');
    } else {
      const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-oldinst-'));
      fs.writeFileSync(path.join(oldDir, 'dshm-installer.js'), oldSrc, 'utf8');
      fs.copyFileSync(path.join(ROOT, 'hostcore/app/dshm-user-rows.js'), path.join(oldDir, 'dshm-user-rows.js'));
      fs.copyFileSync(path.join(ROOT, 'hostcore/app/tar-gz.cjs'), path.join(oldDir, 'tar-gz.cjs'));
      const oldInstaller = require(path.join(oldDir, 'dshm-installer.js'));
      const { home, profileDir } = makeTempProfile();
      const patchPath = path.join(profileDir, 'cordis.patch.yml');
      const r = await oldInstaller.removeSpec('dsh-proxyagent', { homeDir: home, profile: 'ondevice' });
      const after = fs.readFileSync(patchPath, 'utf8');
      check('负测试：旧实现自报成功、却留下孤儿子键且无法严格解析（本断言必须"红"才算有牙）',
        r.ok === true && after.includes('subscriptionUrl') && strict(after).ok === false,
        JSON.stringify({ ok: r.ok, hasOrphan: after.includes('subscriptionUrl'), parse: strict(after).reason }));
      fs.rmSync(oldDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // ── §6 package.json 写盘加固（A3：原子写 + 写前校验 + 坏文件留档）────────────
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-pkgio-'));
    const profileDir = path.join(home, 'profiles', 'ondevice');
    const pkgPath = path.join(profileDir, 'package.json');
    writeFile(pkgPath, JSON.stringify({ name: 'ondevice', dependencies: {} }, null, 2) + '\n');
    installer.mergeDependencies(profileDir, [{ name: 'x', version: '1.0.0', spec: 'x@1.0.0' }]);
    const p1 = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check('§6 合法 package.json：依赖写入且结果可解析', p1.dependencies.x === '1.0.0', JSON.stringify(p1.dependencies));
    check('§6 原子写不留 .tmp-* 临时文件',
      fs.readdirSync(profileDir).every((n) => !n.includes('.tmp-')), JSON.stringify(fs.readdirSync(profileDir)));
    fs.chmodSync(pkgPath, 0o640);
    installer.mergeDependencies(profileDir, [{ name: 'y', version: '2.0.0', spec: 'y@2.0.0' }]);
    check('§6 原子写保留原权限位', (fs.statSync(pkgPath).mode & 0o777) === 0o640,
      (fs.statSync(pkgPath).mode & 0o777).toString(8));
    const broken = '{ this is not json\n';
    fs.writeFileSync(pkgPath, broken, 'utf8');
    installer.mergeDependencies(profileDir, [{ name: 'z', version: '3.0.0', spec: 'z@3.0.0' }]);
    const backups = fs.readdirSync(profileDir).filter((n) => n.startsWith('package.json.bak-invalid-'));
    check('§6 坏 package.json 先留档（.bak-invalid-*），原字节可恢复',
      backups.length === 1 && fs.readFileSync(path.join(profileDir, backups[0]), 'utf8') === broken, JSON.stringify(backups));
    const p2 = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    // 坏 JSON 里已没有可恢复字段（name 等）⇒ 新文件只保证"合法 + 本次依赖"；
    // 旧内容靠 §6 上一问的 .bak-invalid-* 留档，不存在静默丢失。
    check('§6 坏文件场景仍写出一份可解析的新文件（含本次依赖）',
      p2.dependencies.z === '3.0.0', JSON.stringify(p2).slice(0, 200));
    check('§6 appendProfileBundle 首次登记返回 true', installer.appendProfileBundle(profileDir, 'bundle-x') === true);
    check('§6 appendProfileBundle 二次登记返回 false（幂等）', installer.appendProfileBundle(profileDir, 'bundle-x') === false);
    fs.writeFileSync(pkgPath, '{ broken again', 'utf8');
    check('§6 appendProfileBundle 遇坏文件不写、返回 false',
      installer.appendProfileBundle(profileDir, 'bundle-y') === false
      && fs.readFileSync(pkgPath, 'utf8') === '{ broken again');
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log('');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed' + (skip > 0 ? ', ' + skip + ' skipped' : ''));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[ERROR] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
