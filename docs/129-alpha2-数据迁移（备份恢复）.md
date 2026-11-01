# 129 · alpha.2 数据迁移：whale-backup 2026-10-28 → 新 Whale（com.jwhsoft.whale）

> 2026-10-28 ｜ 分支 `alpha2-phase1` ｜ 关联：`docs/126`~`128`
> 目标：把旧 Whale（`whale.jwh.chat`）的**沙箱层数据**迁到新包；**dsh-config ZIP** 由用户在新包
> `dsh-config-manager` 界面恢复（会话/设置/技能/插件清单），其余由 Host 启动时一次性自动恢复。

## 一、顺序（重要）

1. **先 Host 自动恢复（本文档的 `dshm-restore`）** —— 装新 HAP → 新 Whale 启动时执行一次；
2. **后用户 ZIP 恢复** —— 打开新 Whale → dsh-config-manager 导入
   `Backup/whale-backup/2026-10-28/dsh-config-2026-10-28-7b2b1e.zip` → 按提示重启。

理由：先恢复文件层（凭据/附件/环境），再让管理器导入应用配置层，避免管理器导入时同名文件被旧值覆盖；
反过来也能成，但会多一次重启且覆盖关系更绕。

## 二、Host 自动恢复（已实现并在真机执行）

实现：`hostcore/app/dshm-restore.js`，在 `main.js` 的 `ensureProfile()` 之后调用（BOOT_25）。

| 备份 | 恢复到 | 内容 |
|---|---|---|
| `whale-env.tar.gz` | `$HOME/bin/{agc,whale-backup,new-project}`、`$HOME/.config/whale/*`、`$DSH_HOME/AGENTS.md` | AGC 私钥/环境、用户脚本、全局指令 |
| `home-config.tar.gz` | `$HOME/.config/**` | `.config/whale`（含 `agc_private.json`）、billion-context、go telemetry 等小配置 |
| `state.tar.gz` | `$DSH_HOME/{skills,proxyagent,dsh-market,llm-deepseek,whale-audio,whale-roles,whale-bubble-imgs,speech-to-text,diag-startup-host}` + `$DSH_HOME/AGENTS.md` + **凭据双写**：`$DSH_HOME/.credentials.yaml`（alpha.2 `dsh-credentials-local` 默认路径）与 `$DSH_HOME/dsh-config-manager/vault/.credentials.yaml` | vault 凭据、技能、插件配置/数据 |
| `attachments.tar.gz` | `$DSH_HOME/attachments/**` | 聊天附件 |

**明确不恢复**（避免把旧包状态带回）：

- `state.tar.gz` 的 `profiles/**`：新包 profile 由 `ensureProfile` 管理；混入旧 bundle/行会起不来；
- `state.tar.gz` 的 `storages/workspace.json`：旧工作区登记指向旧包认领目录；工作区稍后在设置里重新指定；
- `state.tar.gz` 的 `install-queue/**`：旧安装队列可能被启动时重放；
- `state.tar.gz` 的 `host-ready.json`：旧 host 的 token/端口读数；
- `home-bin.tar.gz`：新 Host 会重建 `$HOME/bin` 工具垫片，只补 `whale-env` 里的 3 个用户脚本。

## 三、真机执行结果（2026-10-28 23:33，新 Whale 启动日志）

```
BOOT_10_ENV_READY ... home=/data/storage/el2/base/haps/entry/files/dsh/home sandbox=/data/storage/el2/base/haps/entry/files
[dshm-restore] 开始从备份恢复沙箱层：/storage/Users/currentUser/projects/DSH_Proj/Backup/whale-backup/2026-10-28
[dshm-restore] 完成（1219ms）：homeConfig=10文件/90685B whaleEnv=7文件/38774B
  state=413文件/12237163B attachments=725文件/138676019B；AGENTS.md=11617B；凭据=540B
BOOT_25_RESTORE_DONE backup=... elapsedMs=1219
BOOT_30_PROFILE_READY ... (+1302ms)
```

- 恢复总耗时约 **1.2 s**，不影响启动（后续正常 BOOT_65/BOOT_70，页面/API 200）；
- 附件 725 文件 / 138.7 MB、技能 405 文件、凭据 540 B、全局 AGENTS.md 11617 B。

## 四、一次性与安全边界

- **只跑一次**：完成后写 `$DSH_HOME/.dshm-restore-backup-done`（报告 JSON）与
  `$DSH_HOME/.dshm-restore-report.json`；删除标记可手动重跑。
- **只对 dev 包**：`DSHM_PUBLIC_DOWNLOAD` 以 `/Download/com.jwhsoft.whale` 结尾才执行；
  独立 Host 复现可用 `DSHM_RESTORE_ALLOW=1` + `DSHM_RESTORE_HOME=<tmp>` 测试。
- 旧 Whale（`whale.jwh.chat`）代码里没有该模块，不受影响。
- 路径逐条校验（拒绝绝对路径/`..`），符号链接/设备节点跳过；日志不打印凭据内容。
- 迁移完成后如需彻底移除：删 `hostcore/app/dshm-restore.js` + main.js 的调用 + 两处文件清单条目；
  或保留（无害，只对 dev 包且只跑一次）。

## 五、用户后续动作（ZIP）

1. 新 Whale → **dsh-config-manager** → 恢复
   `Backup/whale-backup/2026-10-28/dsh-config-2026-10-28-7b2b1e.zip`；
2. 按提示重启；
3. 验证：会话列表、模型 API key、附件、全局 AGENTS.md、插件页。

## 六、ZIP 恢复失败与修复（2026-10-28 深夜，实测）

### 现象

用户在新 Whale 的 dsh-config-manager 里恢复
`Backup/whale-backup/2026-10-28/dsh-config-2026-10-28-7b2b1e.zip`（234,111,956 B，
sessions 压缩后 225.74 MB）时，进度 11% 报：

```
操作失败：ZIP 压缩数据总量超过上限
```

### 根因

dsh-config-manager 插件 `lib/utils/zip.js` 的
`DEFAULT_ZIP_SAFETY_LIMITS.maxCompressedBytes` 默认 **200 MiB（209,715,200 B）**；
备份包压缩总量 **223.1 MiB** ⇒ `parseZip()` 整体拒绝。

同包其他上限都够：uncompressed 总量 228.2 MiB < `maxTotalBytes` 500 MiB；
单条最大 25.2 MiB < `maxSingleBytes` 100 MiB；上传 `MAX_UPLOAD_BYTES` 256 MiB 也够。
⇒ **只需放宽 `maxCompressedBytes`**。

### 修复（迁移期一次性补丁）

`hostcore/app/dshm-restore.js` 增加 `maybePatchConfigManagerZipLimit()`：
每次 Host 启动（`ensureProfile()` 之后、profile boot 之前）幂等扫描
`$DSH_HOME/profiles/*/node_modules/dsh-config-manager/lib/utils/zip.js`，
把 `maxCompressedBytes: 200 * 1024 * 1024` 改为 **512 MiB**；改前打日志，
未发现/无需改时打一行提示。只随调试 HAP 携带，旧 Whale 不受影响。

真机读数（2026-10-28 23:46）：

```
[dshm-restore] 已放宽 dsh-config-manager ZIP 上限（200 MiB → 512 MiB）：
  .../dsh/home/profiles/ondevice/node_modules/dsh-config-manager/lib/utils/zip.js
BOOT_30_PROFILE_READY ... (+67ms)
```

### 后续

1. 用户重试 manager 恢复即可（上传/解压/会话迁移都走插件原逻辑）；
2. 正式上游修复前，这份补丁保留；若某天 dsh-config-manager 更新，补丁按字符串幂等重打；
3. 长期建议：导出时勾选"不含 sessions"或按分区导出，或推动插件把 `maxCompressedBytes` 提到与
   `MAX_UPLOAD_BYTES` 同量级（256 MiB 仍小于 223 MiB 包？—— 注意 256 MiB > 223.1 MiB，够用；
   当前默认 200 MiB 才是瓶颈）。

> 注：诊断日志里的 `zip 上限补丁检查` 每次启动都会打印（含 home/public 路径），不含敏感值。

## 七、后续迁移的备份策略（用户决定 2026-10-28）

**决定：以后迁移不再备份 sessions，新包从新会话开始。**

理由（2026-10-28 实测数据）：

- `dsh-config-2026-10-28-*.zip` 223.3 MiB 中 **sessions 占 215.3 MiB**（229 个会话）；
- 会话文件是 `session.v4.jsonl.zstd`（**已 zstd 压缩**），再打进 ZIP 几乎不再缩小（压缩比 ≈1:1）；
- 10-25 → 10-28 三天新增 45 个会话 ⇒ ZIP +39 MB，随使用线性增长；
- `attachments.tar.gz` 是另一条增长线（本次 725 文件 / 138.7 MB），与 sessions 相互独立。

### 7.1 后续备份口径

1. dsh-config-manager 导出时**不勾 sessions** ⇒ ZIP 约 **8 MB**（config/skills/plugins/mcp/ai 等）；
2. 只恢复这个"小 ZIP"到新包；**旧会话全部留在旧 Whale 沙箱**（旧包不卸载即可保留）；
3. 新包里的会话从零开始；
4. 迁移期 `dshm-restore` 仍负责 vault/skills/AGENTS/attachments/bin/.config 等沙箱层（与 ZIP 大小无关）；
5. 附件是否随迁移，按下次需要单独决定（若不带旧会话，旧附件通常也不必带；只带仍要用的文件即可）。

> 注意：本附件备份目录里 2026-10-28 这份仍含 sessions（这次迁移继续用已放宽的上限恢复）；
> 从下一份备份开始按 7.1 执行即可。

## 八、本次迁移不恢复附件（2026-10-29 用户决定）

sessions 不迁移 ⇒ 旧附件在新 Whale 无任何会话引用。因此：

- `dshm-restore` 增加 `dropMigrationAttachmentsOnce()`：新包启动时**一次性删除**
  `$DSH_HOME/attachments`（本次 725 文件 / 138.7 MB），并写
  `$DSH_HOME/.dshm-restore-attachments-dropped`；之后新会话自己产生的附件不会被碰；
- 旧 Whale 沙箱与 `Backup/whale-backup/2026-10-28/attachments.tar.gz` 仍是原件；
- 真机日志（2026-10-29 00:02）：

```
[dshm-restore] 已删除本次迁移恢复的旧附件（sessions 不迁移，附件无引用）：
  .../dsh/home/attachments（旧 Whale / 备份 tar 仍保留原件）
BOOT_30_PROFILE_READY ... (+334ms)
```

> 该函数只随调试 HAP、只对 dev 包、只删一次；若以后某次迁移需要附件，删掉 marker 并
> 重新解 `attachments.tar.gz` 即可。

## 九、迁移完成状态（2026-10-29 00:15）

- 用户在新 Whale 的 dsh-config-manager 导入 **`dsh-config-2026-10-29-113d30.zip`（7.8 MB，不含 sessions）**成功；
- 本次只导入配置层；**sessions 不迁移**（旧会话保留在旧 Whale），**附件已按决定删除**（新包无引用）；
- 导入冲突按建议选择（见 §九.1）；`DEEPSEEK_API_KEY` 提示属信息级，模型调用待用户明日验证。

### 9.1 冲突选择口径（本次实际采用）

| 分区/键 | 选择 |
|---|---|
| `providers` / `settings` → `llm-deepseek` | **保留当前**（alpha.2 新默认：V4.1-Flash、1M 上下文） |
| `settings` → `agent-loop` | **使用备份**（`maxParallelToolCalls: 8`，保留旧包手动调优） |
| `settings` → `ui-chat` | **保留当前**（含 alpha.2 新 UI 配置项） |
| `self/sync/ui-prefs.json` | **保留当前**（旧同步通道/发布提示状态不带入） |
| `custom`（skills/prompts/agent-instructions） | **使用备份**（补回 `prompts.json`/`agent-instructions`；skills 重复覆盖无害） |
| `plugins/plugins.json` | **保留当前**（旧插件代码未随备份迁移，避免写入指向不存在包的 profile 行） |
| `workspaces/workspaces.json` | **保留当前**（备份工作区绑定旧 session id；工作区稍后手动指到 `DSH_Proj`） |
| `mcp/servers.json` | 无冲突（空） |

### 9.2 旧插件待重装

清单已落盘：`Backup/whale-backup/2026-10-28/插件清单-待新包装回.txt`
（`dsh-whale-widget` / `@goodandready/dsh-context-lens` / `@tt-a1i/archify-dsh` /
`dsh-proxyagent` / `dsh-context` / `dsh-better-sidebar` / `dshmarket`；
另有 4 个官方 experimental bundle 已由 profile 自带，无需重装。）

### 9.3 明日（2026-10-29）验证清单

1. 模型对话：确认 `DEEPSEEK_API_KEY`/凭据生效、`deepseek-flash` 可正常调用；
2. 工作区：把新 Whale 工作区指到 `/storage/Users/currentUser/projects/DSH_Proj`，确认读写；
3. 插件：按 9.2 清单逐个重装，装完对照版本/启用状态（装/卸后按规则先跑 profile-guard）；
4. 全局 `AGENTS.md`、skills、插件页、Agent Teams 正常；
5. 重启一次确认导入后的启动/会话正常；必要时继续 Phase 5 长稳定。
