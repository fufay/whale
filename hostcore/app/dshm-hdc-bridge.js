'use strict';
/*
 * dshm-hdc-bridge.js —— 应用内 hdc 桥的「随包部署 + 启动自愈」（2026-11-04，v3）
 *
 * ════════ 背景：一次把整个应用冻死的事故 ════════
 * Whale 的 hdc 桥（`Common/dsh-hdc-bridge/`）靠 `bridge.sh` 在**应用沙箱内**重建：
 * `shim.so` 把 hdc 的 UDS 路径重写到可写目录、`fakecred.py` 伪造 HUKS 凭据、
 * 再起一个带 LD_PRELOAD 的 `hdc -m` 当"本机 server"。三样东西都住在应用沙箱：
 *   · 构建产物/状态：`$HOME/.hdc-bridge/`（稳定目录）
 *   · socket：`$HOME/tmp/`（会被系统清理）
 *   · 命令包装：`$HOME/bin/hdc`、`$HOME/bin/hdcb`
 *
 * 事故链（2026-11-04 真机取证，详见 docs/133）：
 *   1. 重装 HAP ⇒ 系统把桥的子进程（fakecred / hdc -m）全部杀掉，`$HOME/tmp` 里的 socket
 *      随之消失；
 *   2. 部署在 `$HOME/bin/hdcb` 里的 `@BRIDGE_DIR@` 是**生成时的绝对路径**，源码目录一搬
 *      （`DSHM问题汇总与解决/hdc-bridge` → `Common/dsh-hdc-bridge`）自愈就永久找不到
 *      `bridge.sh`；
 *   3. hdcb 修桥失败后仍 `exec` 真 hdc ⇒ 客户端卡在握手；
 *   4. 旧版 screen-pilot 用 `execFileSync` 同步调用 hdc ⇒ **Host 事件循环冻死**，78s 后
 *      被系统看门狗连整个应用一起杀掉重启。
 *
 * 本模块负责第 2 步的根治：桥脚本**随 HAP 分发**，Host 每次启动把它们同步到稳定目录
 * `$HOME/.hdc-bridge/src/`，只在"桥不健康"时**后台**跑一次 `bridge.sh`（不阻塞启动）。
 * 路径从此与工作区无关；升级/重启/系统清 tmp 之后都能自动恢复。
 *
 * ════════ 判据（needRepair）════════
 *   ① 本次同步有文件内容变化（新 HAP 带了新脚本）；或
 *   ② `$HOME/tmp/hdcshim_hdc_server` 不存在（桥 socket 没了）；或
 *   ③ `$HOME/bin/hdc` / `$HOME/bin/hdcb` 缺失，或 hdcb 里不是 v3 标记（旧版会盲 exec）；
 *   ④ `$HOME/.hdc-bridge/real.path` 不存在（还没探测过真 hdc）。
 * 一个都不满足 ⇒ 桥健康，什么都不做（每次启动零成本）。
 *
 * ════════ 【HOME 口径】════════
 * 桥脚本里的 `$HOME` 是**应用 files 目录**（`USER_DATA`），不是 dsh 的 `$DSH_HOME`
 * （= `$HOME/dsh/home`）。2026-11-04 第一版把 `HOME_DIR`（dsh home）当成了 `homeDir`，
 * 结果资产落到了 `$DSH_HOME/.hdc-bridge/src`、hdcb 也写到了 `$DSH_HOME/bin/`，
 * 真正的 `$HOME/.hdc-bridge` 什么都没变 —— 症状是"日志说部署成功，设备上找不到文件"。
 * 现在由调用方显式传 `homeDir`（= USER_DATA），并把误写的目录放进 `cleanupDirs` 清掉。
 *
 * ════════ 安全边界 ════════
 *   · 只写自己沙箱（`$HOME`）内的文件；`keys/` 私钥**不随包**（已在设备 `.harmony/`）；
 *   · 全程 detach + 超时（默认 180s 后 kill），失败只落 diag/log，绝不影响 Host 启动；
 *   · `DSHM_HDC_BRIDGE=0` 可整体关闭（调试/排查用）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ASSETS = require('./hdc-bridge-assets.js');

/** 桥源码在沙箱里的稳定目录（hdcb 的运行时解析顺序里也有它，见 bridge.sh 的 hdcb 模板）。 */
const SRC_DIRNAME = 'src';
/** bridge.sh 的看护超时：正常完成 1–3 秒（首次编译 shim ~2s），180s 还没结束说明卡死了。 */
const REPAIR_TIMEOUT_MS = 180000;

/** 读小文件，失败返回 null（不抛）。 */
function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 把随包的内嵌资产同步到 `$HOME/.hdc-bridge/src/`。
 * @returns {number} 内容有变化（或新写入）的文件数
 */
function syncAssets(srcDir) {
  fs.mkdirSync(srcDir, { recursive: true });
  let changed = 0;
  for (const name of Object.keys(ASSETS)) {
    const target = path.join(srcDir, name);
    const text = ASSETS[name];
    if (readOrNull(target) !== text) {
      fs.writeFileSync(target, text, { mode: 0o755 });
      changed += 1;
    }
  }
  return changed;
}

/**
 * 部署/自愈 hdc 桥（**同步部分**只做文件同步与判据；真正的重建在后台跑）。
 * @param {{ homeDir: string, log: (m: string) => void, diag: (m: string) => void, cleanupDirs?: string[] }} options
 *   homeDir 必须是**应用 files 目录**（脚本里的 `$HOME`），不是 dsh 的 `$DSH_HOME`。
 * @returns {{ deployed: boolean, changed: number, needRepair: boolean, reason: string, pid?: number }}
 */
function ensureBridge(options) {
  const { homeDir, log, diag, cleanupDirs = [] } = options;
  const result = { deployed: false, changed: 0, needRepair: false, reason: '' };
  if (String(process.env.DSHM_HDC_BRIDGE || '1') === '0') {
    result.reason = 'disabled-by-env';
    return result;
  }
  try {
    /*
     * 【护栏】homeDir 必须是**绝对路径**：2026-11-04 第二版传进来的 USER_DATA 实际为空
     * （`electron.app.getPath('userData')` 在本环境拿不到）⇒ `path.join('', '.hdc-bridge')`
     * 变成相对路径 ⇒ 在 cwd 里 mkdir 报 EACCES，日志看起来像"部署失败"但真因是参数错。
     * 这类错误必须在入口拒绝，而不是写到一个猜出来的目录。
     */
    if (!homeDir || !path.isAbsolute(homeDir)) {
      diag(`[hdc-bridge] 跳过：homeDir 不是绝对路径（收到 ${JSON.stringify(homeDir)}）`);
      result.reason = 'bad-home-dir';
      return result;
    }
    // 清掉历史误写位置（例如把 dsh home 当成 $HOME 的那一版）
    for (const stray of cleanupDirs) {
      if (!stray || !fs.existsSync(stray)) continue;
      try {
        fs.rmSync(stray, { recursive: true, force: true });
        diag(`[hdc-bridge] 清理误写目录：${stray}`);
      } catch (error) {
        diag(`[hdc-bridge] 清理误写目录失败 ${stray}：${error && error.message ? error.message : error}`);
      }
    }
    const bridgeDir = path.join(homeDir, '.hdc-bridge');
    const srcDir = path.join(bridgeDir, SRC_DIRNAME);
    result.changed = syncAssets(srcDir);
    result.deployed = true;

    const sock = path.join(homeDir, 'tmp', 'hdcshim_hdc_server');
    const hdcbPath = path.join(homeDir, 'bin', 'hdcb');
    const hdcPath = path.join(homeDir, 'bin', 'hdc');
    const realPath = path.join(bridgeDir, 'real.path');
    const hdcbText = readOrNull(hdcbPath) || '';

    const reasons = [];
    if (result.changed > 0) reasons.push(`scripts-updated(${result.changed})`);
    if (!fs.existsSync(sock)) reasons.push('socket-missing');
    if (!fs.existsSync(hdcPath)) reasons.push('hdc-missing');
    if (!fs.existsSync(hdcbPath)) reasons.push('hdcb-missing');
    else if (!hdcbText.includes('hdcb-v3-20261104')) reasons.push('hdcb-outdated');
    if (!fs.existsSync(realPath)) reasons.push('real-hdc-unknown');

    result.reason = reasons.join(',');
    if (reasons.length === 0) {
      log(`[hdc-bridge] 桥健康（socket/包装都在），跳过重建`);
      return result;
    }
    result.needRepair = true;

    // 【2026-11-04 实验】启动阶段默认不再 spawn 桥修复。
    //   症状（真机实测）：宿主的子进程退出通知整体失效 —— bridge.sh 早已退出，宿主 180s 后
    //   仍在"杀"它，子进程一直躺成僵尸；会话里任何命令（echo/python）都永久挂起，连 8s 超时
    //   也不返回。当天唯一新增的 spawn 就是这条 boot 阶段 detached spawn。
    //   默认改为延迟：首次使用 hdc 时由 hdcb 触发修复；DSHM_HDC_BRIDGE_REPAIR=1 恢复启动修复。
    if (String(process.env.DSHM_HDC_BRIDGE_REPAIR || '0') !== '1') {
      diag(`[hdc-bridge] 跳过启动修复（${result.reason}；延迟到首次使用）`);
      log(`[hdc-bridge] 部署完成，跳过启动修复（${result.reason}）；首次用 hdc 时由 hdcb 修复`);
      result.deferred = true;
      return result;
    }

    // 重建：detached + 输出落文件，Host 不等它。
    const logPath = path.join(bridgeDir, 'bridge.log');
    const out = fs.openSync(logPath, 'a');
    fs.writeSync(out, `\n=== ${new Date().toISOString()} ensureBridge: ${result.reason} ===\n`);
    const child = spawn('/system/bin/sh', [path.join(srcDir, 'bridge.sh')], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, HOME: homeDir, HDC_BRIDGE_DIR: srcDir },
      cwd: srcDir,
    });
    child.unref();
    fs.closeSync(out);
    result.pid = child.pid;
    diag(`[hdc-bridge] 部署完成（home=${homeDir}；${result.reason}），后台重建 bridge.sh pid=${child.pid}`);
    log(`[hdc-bridge] 部署完成（${result.reason}），后台重建 bridge.sh pid=${child.pid}（日志 .hdc-bridge/bridge.log）`);

    // 看护：超时就杀（timer unref，不拖住 Host 退出）
    const timer = setTimeout(() => {
      try {
        process.kill(child.pid, 'SIGKILL');
        diag(`[hdc-bridge] bridge.sh 超时 ${REPAIR_TIMEOUT_MS}ms，已 SIGKILL pid=${child.pid}`);
      } catch {
        /* 已经退出：正常 */
      }
    }, REPAIR_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return result;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    diag(`[hdc-bridge] 部署/自愈失败（非致命）：${message}`);
    return result;
  }
}

module.exports = { ensureBridge, ASSETS };
