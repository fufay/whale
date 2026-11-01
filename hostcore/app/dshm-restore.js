'use strict';
/*
 * dshm-restore.js —— 迁移期一次性恢复引导（2026-10-28，alpha.2 双包迁移用）
 *
 * 背景：用户把「新 Whale（com.jwhsoft.whale）」作为后续主包，需要用 whale-backup
 * 的 2026-10-28 备份把**沙箱层**带过去；dsh-config-*.zip 由用户在新 Whale 的
 * dsh-config-manager 里恢复，本模块只负责它之外的部分：
 *   · whale-env.tar.gz   → $HOME/bin/{agc,whale-backup,new-project}、$HOME/.config/whale、$DSH_HOME/AGENTS.md
 *   · home-config.tar.gz → $HOME/.config/**（AGC 私钥/配置、billion-context 等小配置）
 *   · state.tar.gz       → $DSH_HOME/{vault,skills,proxyagent,dsh-market,llm-deepseek,
 *                          whale-audio,whale-roles,whale-bubble-imgs,speech-to-text,diag-startup-host}
 *                          + 凭据落到 $DSH_HOME/.credentials.yaml（alpha.2 credentials-local 的默认路径）
 *                          + dsh-config-manager/vault/.credentials.yaml（管理器自己的 vault）
 *   · attachments.tar.gz → $DSH_HOME/attachments
 *
 * 明确**不恢复**（避免把旧包状态带进来）：
 *   · state.tar.gz 里 profiles/**（新包 profile 由 Host ensureProfile 管理，混入旧 bundle/行会起不来）
 *   · state.tar.gz 里 storages/workspace.json（旧工作区登记指向旧包认领目录）
 *   · state.tar.gz 里 install-queue/**（旧安装队列，可能在启动时被重放）
 *   · state.tar.gz 里 host-ready.json（旧 host 的 token/端口读数）
 *   · home-bin.tar.gz（新 Host 会重新生成 $HOME/bin 工具垫片；只补 whale-env 里的 3 个用户脚本）
 *
 * 安全边界：
 *   · 只在 dev 包（DSHM_PUBLIC_DOWNLOAD 以 /Download/com.jwhsoft.whale 结尾）自动跑；
 *     `DSHM_RESTORE_ALLOW=1` 仅用于本地独立 Host 复现/测试。
 *   · 只跑一次：完成后写 $DSH_HOME/.dshm-restore-backup-done（内容为报告 JSON）。
 *   · 路径逐条校验（拒绝绝对路径 / `..`），符号链接与设备节点一律跳过（沙箱禁 link）。
 *   · 不打印任何凭据内容；日志只报条目数/字节数/目标路径。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const tarGz = require('./tar-gz.cjs');

const BACKUP_ROOT = '/storage/Users/currentUser/projects/DSH_Proj/Backup/whale-backup';
const MARKER_NAME = '.dshm-restore-backup-done';
const REPORT_NAME = '.dshm-restore-report.json';

/** 从备份根目录挑最新日期目录（要求目录里有 whale-env.tar.gz）。 */
function latestBackupDir() {
  if (!fs.existsSync(BACKUP_ROOT)) return null;
  const dirs = fs.readdirSync(BACKUP_ROOT)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const dir = path.join(BACKUP_ROOT, dirs[i]);
    if (fs.existsSync(path.join(dir, 'whale-env.tar.gz'))) return dir;
  }
  return null;
}

/** 是否符合自动恢复的包（dev bundle）或显式测试开关。 */
function shouldRun() {
  if (process.env.DSHM_RESTORE_ALLOW === '1') return true;
  const pub = process.env.DSHM_PUBLIC_DOWNLOAD || '';
  return pub.replace(/[\\/]+$/, '').endsWith('/Download/com.jwhsoft.whale');
}

/**
 * 解一个 tar.gz，按 decide(strippedSegs) 返回的目标路径落盘。
 * @returns {{written:number,bytes:number,dirs:number,skipped:number}}
 */
function restoreArchive(archivePath, stripPrefixes, decide) {
  const raw = zlib.gunzipSync(fs.readFileSync(archivePath));
  const stats = { written: 0, bytes: 0, dirs: 0, skipped: 0 };
  for (const entry of tarGz.walkTar(raw, { stripPrefixes })) {
    if (entry.type !== '0' && entry.type !== '7' && entry.type !== '5') {
      stats.skipped += 1;
      continue;
    }
    const segs = entry.segs;
    const target = decide(segs, entry);
    if (!target) {
      stats.skipped += 1;
      continue;
    }
    if (entry.type === '5') {
      fs.mkdirSync(target, { recursive: true });
      stats.dirs += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.body.subarray(0, entry.size));
    stats.written += 1;
    stats.bytes += entry.size;

    // 权限：凭据 600、AGC 目录 700、bin 脚本 755、其余 644。
    const base = path.basename(target);
    if (base === '.credentials.yaml' || base === 'agc_private.json' || base.endsWith('.env')) {
      try { fs.chmodSync(target, 0o600); } catch { /* 非致命 */ }
    } else if (path.basename(path.dirname(target)) === 'bin') {
      try { fs.chmodSync(target, 0o755); } catch { /* 非致命 */ }
    } else {
      try { fs.chmodSync(target, 0o644); } catch { /* 非致命 */ }
    }
  }
  return stats;
}

function statOf(p) {
  try { const s = fs.statSync(p); return s.isFile() ? s.size : 0; } catch { return 0; }
}

/**
 * 主入口：执行一次恢复（调用方负责只在 Host 启动早期调用一次）。
 * @param {(msg:string)=>void} log
 * @returns {null|object} 报告；不需要跑返回 null
 */
function maybeRestore(log) {
  if (!shouldRun()) return null;

  // 【测试/独立 Host 用】DSHM_RESTORE_HOME 显式覆盖；Host 内正常走 DSHM_SANDBOX_HOME。
  const home = process.env.DSHM_RESTORE_HOME || process.env.DSHM_SANDBOX_HOME || process.env.HOME || '';
  const dshHome = process.env.DSHM_HOME || (home ? path.join(home, 'dsh', 'home') : '');
  if (!home || !dshHome) return null;

  const marker = path.join(dshHome, MARKER_NAME);
  if (fs.existsSync(marker)) return null;

  const backupDir = latestBackupDir();
  if (!backupDir) {
    log('[dshm-restore] 未找到可用备份目录（' + BACKUP_ROOT + '），跳过');
    return null;
  }

  const started = Date.now();
  const report = {
    backupDir,
    startedAt: new Date(started).toISOString(),
    home,
    dshHome,
    archives: {},
    skipped: {
      profiles: '由 Host ensureProfile 管理，不还原',
      workspaceJson: '旧工作区登记，不还原',
      installQueue: '旧安装队列，不还原',
      hostReady: '旧 host-ready，不还原',
      homeBin: '新 Host 会重建 $HOME/bin，不还原',
    },
  };
  log('[dshm-restore] 开始从备份恢复沙箱层：' + backupDir);

  // 1) home-config：$HOME/.config/**（合并覆盖）
  const homeConfig = path.join(backupDir, 'home-config.tar.gz');
  if (fs.existsSync(homeConfig)) {
    report.archives.homeConfig = restoreArchive(homeConfig, ['.'], (segs) => {
      if (segs[0] !== '.config' || segs.length < 2) return null;
      return path.join(home, ...segs);
    });
  }

  // 2) whale-env：bin 三件套 + .config/whale + AGENTS.md
  const whaleEnv = path.join(backupDir, 'whale-env.tar.gz');
  if (fs.existsSync(whaleEnv)) {
    const binNames = new Set(['agc', 'whale-backup', 'new-project']);
    report.archives.whaleEnv = restoreArchive(whaleEnv, ['.'], (segs) => {
      if (segs.length === 2 && segs[0] === 'bin' && binNames.has(segs[1])) {
        return path.join(home, 'bin', segs[1]);
      }
      if (segs.length === 2 && segs[0] === 'config') {
        return path.join(home, '.config', 'whale', segs[1]);
      }
      if (segs.length === 1 && segs[0] === 'AGENTS.md') {
        return path.join(dshHome, 'AGENTS.md');
      }
      return null;
    });
  }
  try { fs.chmodSync(path.join(home, '.config', 'whale'), 0o700); } catch { /* 非致命 */ }

  // 3) state：vault/凭据、skills、proxyagent、插件数据目录、AGENTS.md
  const stateTar = path.join(backupDir, 'state.tar.gz');
  if (fs.existsSync(stateTar)) {
    const dataDirs = new Set([
      'skills', 'proxyagent', 'dsh-market', 'llm-deepseek', 'whale-audio',
      'whale-roles', 'whale-bubble-imgs', 'speech-to-text', 'diag-startup-host',
    ]);
    report.archives.state = restoreArchive(stateTar, ['.'], (segs) => {
      if (segs.length === 1 && segs[0] === 'AGENTS.md') return path.join(dshHome, 'AGENTS.md');
      if (segs[0] === 'vault' && segs.length === 2 && segs[1] === '.credentials.yaml') {
        // 双写：alpha.2 credentials-local 默认读 $DSH_HOME/.credentials.yaml；
        // dsh-config-manager 自己的 vault 也留一份（它导出/导入时用这个路径）。
        return path.join(dshHome, '.credentials.yaml');
      }
      if (segs[0] === 'vault' && segs.length === 2) {
        return path.join(dshHome, 'dsh-config-manager', 'vault', segs[1]);
      }
      if (segs.length >= 1 && dataDirs.has(segs[0])) {
        return path.join(dshHome, ...segs);
      }
      return null; // profiles/ storages/ install-queue/ host-ready.json 等一律跳过
    });

    // state 里只有 vault/.credentials.yaml；再单独给管理器路径放一份（上面 decide 只匹配一次，
    // 这里显式复制，保证两个路径都有）。
    const cred = path.join(dshHome, '.credentials.yaml');
    if (fs.existsSync(cred)) {
      const mgrDir = path.join(dshHome, 'dsh-config-manager', 'vault');
      try {
        fs.mkdirSync(mgrDir, { recursive: true });
        fs.copyFileSync(cred, path.join(mgrDir, '.credentials.yaml'));
        fs.chmodSync(path.join(mgrDir, '.credentials.yaml'), 0o600);
      } catch (e) {
        report.credentialMirrorError = String(e && e.message ? e.message : e);
      }
    }
  }

  // 4) attachments
  const attachments = path.join(backupDir, 'attachments.tar.gz');
  if (fs.existsSync(attachments)) {
    report.archives.attachments = restoreArchive(attachments, ['attachments'], (segs) => {
      return path.join(dshHome, 'attachments', ...segs);
    });
  }

  // 5) 收尾：计时 + 标记 + 报告
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - started;
  report.credentialBytes = statOf(path.join(dshHome, '.credentials.yaml'));
  report.agentsMdBytes = statOf(path.join(dshHome, 'AGENTS.md'));
  report.attachmentFiles = report.archives.attachments ? report.archives.attachments.written : 0;
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(dshHome, REPORT_NAME), JSON.stringify(report, null, 2));
  } catch (e) {
    log('[dshm-restore] 写完成标记失败（下次会重跑）：' + (e && e.message ? e.message : e));
  }
  const parts = Object.entries(report.archives)
    .map(([k, v]) => k + '=' + v.written + '文件/' + v.bytes + 'B')
    .join(' ');
  log('[dshm-restore] 完成（' + report.elapsedMs + 'ms）：' + parts
    + '；AGENTS.md=' + report.agentsMdBytes + 'B；凭据=' + report.credentialBytes + 'B');
  return report;
}


/**
 * 【2026-10-28 补丁】放开 dsh-config-manager 的 ZIP 压缩体积上限。
 *
 * 现象：用户在新 Whale 的 dsh-config-manager 里恢复 `dsh-config-2026-10-28-*.zip`
 * （备份目录 234,111,956 B，其中 sessions 压缩后 225.7 MB）时，进度到 11% 报
 * 「操作失败 ZIP 压缩数据总量超过上限」。
 *
 * 根因：插件 `lib/utils/zip.js` 的 `DEFAULT_ZIP_SAFETY_LIMITS.maxCompressedBytes`
 * 默认 **200 MiB**（209,715,200 B），而备份包压缩总量 223.1 MiB ⇒ parseZip 整体拒绝。
 * 包内其他上限都够（uncompressed 228.2 MiB < maxTotalBytes 500 MiB；
 * 单条最大 25.2 MiB < maxSingleBytes 100 MiB），因此**只放宽 maxCompressedBytes** 到 512 MiB。
 *
 * 只改已安装插件在沙箱里的 `lib/utils/zip.js`（新包每次启动幂等检查），
 * 不改备份包本身；正式上游修复前这是一次性迁移补丁。
 */
function patchConfigManagerZipLimit(log) {
  // 不在这里做 dev 包门控：本模块目前只随调试 HAP 携带；门控留给 maybeRestore。
  // 每次启动先打一行诊断（不含敏感值），便于确认补丁代码真的跑到了。
  const home = process.env.DSHM_RESTORE_HOME || process.env.DSHM_SANDBOX_HOME || process.env.HOME || '';
  log('[dshm-restore] zip 上限补丁检查：home=' + home
    + ' public=' + (process.env.DSHM_PUBLIC_DOWNLOAD || '<unset>'));
  if (!home) return 0;
  // 【路径口径】profiles 在 $DSH_HOME 下（= $HOME/dsh/home），不是 $HOME 直下。
  const dshHome = process.env.DSHM_HOME || path.join(home, 'dsh', 'home');
  const profilesDir = path.join(dshHome, 'profiles');
  let patched = 0;
  let profiles = [];
  try { profiles = fs.readdirSync(profilesDir); } catch { return 0; }
  for (const name of profiles) {
    const file = path.join(profilesDir, name, 'node_modules', 'dsh-config-manager', 'lib', 'utils', 'zip.js');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const old = 'maxCompressedBytes: 200 * 1024 * 1024,';
    if (!text.includes(old)) continue;
    try {
      fs.writeFileSync(file, text.replace(old, 'maxCompressedBytes: 512 * 1024 * 1024,'));
      patched += 1;
      log('[dshm-restore] 已放宽 dsh-config-manager ZIP 上限（200 MiB → 512 MiB）：' + file);
    } catch (e) {
      log('[dshm-restore] 放宽 config-manager ZIP 上限失败：' + file + '：' + (e && e.message ? e.message : e));
    }
  }
  if (patched === 0) log('[dshm-restore] 未发现需要放宽上限的 dsh-config-manager（可能未安装或已打过补丁）');
  return patched;
}


/**
 * 【本次迁移专用（2026-10-28，用户决定）】删除新 Whale 沙箱里刚恢复的旧附件。
 *
 * 背景：用户决定本次迁移**不迁 sessions**（新包新会话），旧附件因此没有任何会话引用；
 * 已由 restore 把 attachments.tar.gz（725 文件/138.7 MB）恢复进 `$DSH_HOME/attachments`，
 * 这里在新包首次启动时一次性删掉，省 138.7 MB。
 *
 * 安全边界：
 *   · 只对 dev 包执行（shouldRun 同样的包门控）；
 *   · **只删一次**：完成后写 `$DSH_HOME/.dshm-restore-attachments-dropped`；
 *     之后新会话自己产生的附件不会再被这条逻辑碰到；
 *   · 旧 Whale 沙箱与 `Backup/whale-backup/2026-10-28/attachments.tar.gz` 仍是原件，不会丢。
 */
function dropMigrationAttachmentsOnce(log) {
  if (!shouldRun()) return 0;
  const home = process.env.DSHM_RESTORE_HOME || process.env.DSHM_SANDBOX_HOME || process.env.HOME || '';
  if (!home) return 0;
  const dshHome = process.env.DSHM_HOME || path.join(home, 'dsh', 'home');
  const marker = path.join(dshHome, '.dshm-restore-attachments-dropped');
  if (fs.existsSync(marker)) return 0;
  const dir = path.join(dshHome, 'attachments');
  let removed = 0;
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed = 1;
      log('[dshm-restore] 已删除本次迁移恢复的旧附件（sessions 不迁移，附件无引用）：' + dir + '（旧 Whale / 备份 tar 仍保留原件）');
    }
  } catch (e) {
    log('[dshm-restore] 删除旧附件失败（非致命）：' + (e && e.message ? e.message : e));
    return 0;
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), reason: 'migration: sessions not carried; attachments dropped once' }));
  } catch { /* 非致命 */ }
  return removed;
}

module.exports = { maybeRestore, maybePatchConfigManagerZipLimit: patchConfigManagerZipLimit, dropMigrationAttachmentsOnce, latestBackupDir, shouldRun };
