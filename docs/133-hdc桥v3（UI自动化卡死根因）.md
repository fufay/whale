# 133 · 「一调 UI 自动化就把新 Whale 冻死」的根因与修复（hdc 桥 v3）

日期：2026-11-04 · 范围：新 Whale（`com.jwhsoft.whale`）
改动：`Common/dsh-hdc-bridge/`（桥脚本 v3）+ `hostcore/app/dshm-hdc-bridge.js`（随包部署）
+ `hostcore/app/dshm-user-rows.js`（影子插件清理）· 版本 **1.1.3 / 1010003**

## 一、现象

新 Whale 里让 agent 调任意 `ui_*` / `screen_*` 工具，应用立刻"整个卡死"，随后 Host 以新
`boot pid` 重启；不调 UI 自动化就稳定。**旧版插件（9 工具）也一样**。

## 二、证据链（Host 日志 + 沙箱状态）

1. `dshm-host.log`：最后一次活动 `07:48:21.989Z`（`/dsh-whale/*.json` 轮询），之后 **78.5 秒
   零日志**，然后 `07:49:40.535Z --- boot pid=18936`（新进程）。
2. 全日志只有 2 次 `EXIT-SNAPSHOT`，其余重启都没有 ⇒ **被外部杀**，不是优雅退出；
   78s 与系统对"应用无响应"的处置时长吻合（Host 是**进程内** Node，主线程冻住 = 整个应用无响应）。
3. 卡死时刻沙箱文件 mtime（15:48 = 07:48Z）：`$HOME/.hdc-bridge/cred.pid`、`server.pid`、
   `$HOME/tmp/credlog.txt` ⇒ **当时正在现场重建 hdc 桥**。
4. 桥的坏状态：`$HOME/tmp/hdcshim_hdc_server`（服务端 socket）**缺失**，只剩悬空的
   `hdcshim_hdc_credential.socket`；`.hdc-bridge/server.pid`(18324) / `cred.pid`(18282)
   指向的进程**都已不存在**；`credlog.txt` 里有 8 次 `fakecred2 listener up`（反复重建）。
5. 部署的 `$HOME/bin/hdcb` 里 `D="/storage/…/DSHM问题汇总与解决/hdc-bridge"` —— 该目录
   （桥源码旧位置）已不存在 ⇒ 自愈路径 `sh "$D/bridge.sh"` 必失败；而 hdcb 失败后**仍
   `exec` 真 hdc**。
6. 旧版 screen-pilot 的 `hdc.js` 用 **`execFileSync`**（同步、90s 超时）调 `$HOME/bin/hdc`
   ⇒ hdc 卡在握手时 Host 事件循环被完全冻住。

### 因果链

重装 HAP（系统杀桥子进程 + `$HOME/tmp` 被清）→ 桥 socket 丢失 → hdcb 自愈因源码路径失效
**必然失败** → 失败后盲 `exec` 真 hdc → hdc 卡握手 → 同步调用冻死 Host → 系统杀进程重启。

**不是**插件性能优化的锅：旧版插件同样致命；也不是"新核心树"的锅（树内只有 screen-pilot
的 6 个 lib 不同）。

## 三、修复

### 3.1 桥脚本 v3（`Common/dsh-hdc-bridge/bridge.sh`，hdcb 标记 `hdcb-v3-20261104`）

1. **桥目录运行时解析**：`HDC_BRIDGE_DIR` → 生成时 `D` → `$HOME/.hdc-bridge/src` →
   `$HOME/hdc-bridge`，源码目录再搬也不影响自愈。
2. **repair 加锁单飞**：`$T/repair.lock`（mkdir 原子 + 180s 陈旧锁回收），并发调用不再互相
   `pkill`/`rm` 拆桥。
3. **修完必须验证**：`bridge_ok()`（`shim.so` + `hdcshim_hdc_server`）不成立则 `exit 3`，
   **绝不 exec 没有服务端的真 hdc** —— 这是冻死调用方的直接原因。
4. 快路径不再要求"有 Connected 目标"：桥健康就直接用；没目标只做一次端口发现，
   **不触发重建**（原来离线时每次调用都拆桥重建，越修越坏）。
5. 所有真 hdc 探测套 `timeout`（`rto` 包装），探测自身不会挂住；无 `timeout` 时退化。
6. 编译失败但已有可用 `shim.so` 时只告警、不拆桥（原来 `exit 1` 导致自愈永久失败）。
7. 自愈日志 `$HOME/.hdc-bridge/repair.log`（1 MB 截断）。
8. `fakecred.py` 路径从 `$HOME` 推导（不再写死 `/data/storage/el2/base/...`）。
9. `$HOME/bin/hdc` 转发器 v3：hdcb 缺失时明确报错。

### 3.2 随包部署 + 启动自愈（whale 侧）

- `tools/embed-hdc-bridge.mjs`：把 `bridge.sh / fakecred.py / scanports.py / shim.c` 内嵌成
  `hostcore/app/hdc-bridge-assets.js`（**`keys/` 私钥不进仓库、不进 HAP**；已授权的密钥在
  设备 `$HOME/.harmony/` 里跨升级保留）。
- `hostcore/app/dshm-hdc-bridge.js`：Host 每次启动同步资产到 `$HOME/.hdc-bridge/src/`，
  仅当「脚本内容变化 / socket 缺 / hdcb 不是 v3 / real.path 缺」时**后台**跑一次
  `bridge.sh`（detach + 180s 超时看护；失败只落 diag，绝不阻塞启动）。
- 门禁：`tools/check-hdc-bridge-embed.mjs`（内嵌 vs 源码逐字节一致，已做负控：改一字节即红）。
- `tools/lib/host-app-files.mjs`：Host 入口脚本清单抽成**唯一真源**（原来 `place-host-app` 与
  `assert-resfile-sync` 各抄一份，新增文件两边容易漏改 —— 本次加文件正好验证该隐患）。

### 3.3 顺带修掉：自带插件被 profile 影子副本顶掉

`dshm-hilog` / `dshm-screen-pilot` 最初是"profile 独立安装插件"，迁移/重装后
`$DSH_HOME/profiles/<p>/node_modules/@deepseek-ai/dshm-*` 里还留着旧副本；dsh loader
**profile 优先于核心树** ⇒ 核心树里新的 11 工具 screen-pilot 永远不生效（真机实证：日志
显示 Host 从 `+whale.3` 树启动，实际加载 9 工具旧副本）。

`dshm-user-rows.js` 新增 `purgeShadowSeedPackages()`，`ensureProfile()` 里在拼用户行之前
删除 profile 侧的 `@deepseek-ai/dshm-*` 目录（这些包一律由核心树提供）；清理会写 diag：
`[插件卫生] 清理 profile 里的自带插件影子副本：…`。

## 四、产物与验证

| 项 | 值 |
|---|---|
| 版本 | `1.1.3 / 1010003`（本机装机版用 `WHALE_DEV_VERSIONCODE=1010000` 覆盖，同版本号覆盖安装） |
| 发行候选 HAP | `dist/release/whale-signed-1.1.3.hap` · **396,494,163 B** · sha256 `c2e8739a…` |
| 本机装机 HAP | `dist/signing/dev-profile/whale-dev-local-bridge.hap` · **396,494,167 B** · sha256 `c7473b14…` |
| 核心树 | 未变（`0.2.2-alpha.2+whale.3`，sha `404d478e…`） |
| 新 HAP 内含 | `resources/resfile/resources/app/dshm-hdc-bridge.js` + `hdc-bridge-assets.js` |
| 门禁 | `check-hdc-bridge-embed` ✓（含负控）、`assert-resfile-sync` 19 件 ✓、`check-resfile-core-zip` ✓ |

**设备侧验收（重启应用后）**：

1. `$HOME/.hdc-bridge/src/bridge.sh` 存在、`$HOME/.hdc-bridge/bridge.log` 有本次部署记录；
2. `$HOME/.hdc-bridge/repair.log` 里 `repair done rc=0`；`$HOME/tmp/hdcshim_hdc_server` 存在；
3. `$HOME/bin/hdcb` 里是 `hdcb-v3-20261104`；
4. Host 日志出现 `[插件卫生] 清理 profile 里的自带插件影子副本：…`（若确有影子副本）；
5. 让 agent 调 `ui_dump` / `screen_capture`：**应用不再卡死**，工具正常返回；
   工具数应为 **11**（`ui_tap_text` / `ui_wait_text` 存在），即新插件生效。

## 五、回滚

- 桥：把 `$HOME/bin/hdcb` 的标记改回 `hdcb-v2-20261028` 会触发重新生成（不推荐）；或删
  `$HOME/.hdc-bridge/src` 恢复旧部署。
- 插件影子清理：`git revert` 该提交（清理只删 profile 里的副本，不删用户数据；被删的包由
  核心树提供，回滚后下次启动会从旧位置再装回来——若真需要）。
- HAP：同 versionCode 覆盖安装回 `whale-dev-local-sp.hap`（上一版）。
