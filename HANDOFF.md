# Whale 移植 · 工作交接（HANDOFF）

> **这是当前状态，不是规则。** 规则看 `AGENTS.md`；决策看 `DECISIONS.md`；细节看 `docs/README.md`。
> 每次开工先读本文件，收尾必须更新本文件。目标 1–2 页，不写过程流水账。

**最后更新**：2026-10-28
**仓库**：`Common/whale` · 分支 `main` · 本轮 HEAD `747a629`（A+B 六个提交，见 §2）
**工作树**：本轮以 `git log` 为准；`hostcore/**` 改动均已 `place-host-app` 同步
**核心树口径**：以 `hostcore/core-recipe.json` 为准，当前读数 `0.2.1-rc.2+whale.2`（本轮未动核心树）

---

## 1. 当前目标

- 当前阶段：**Node 升级 Phase 0 已完成**（v24.21.0 已接进 Whale，HAP 已出、**待用户装机冒烟 + 冷启动验证**，见 `docs/124`）。
- 下一阶段：alpha.2（0.2.2-alpha.2）纳入（Phase 1 物化/审计 → 2 patch 适配 → 3 插件/profile → 4 打包门禁 → 5 真机）。
- 收尾文档：`docs/122`（A1–A3 + B1–B2 的设计/验证/已知边界/回退）。

## 2. 上次做到哪（2026-10-24）

- 本轮提交：
  - `7862abb` A1：`removeRowBlocks` 整块删除纯函数 + 零网络门禁 `check-dshm-uninstall.cjs`
  - `0ca890f` A2：`removeSpecInner` 接线（备份/原子写/写后严格解析/失败回滚 `ok:false`、市场行清理、`coreDir`）
  - `33177b2` A3：`package.json` 写盘加固（原子写、写前校验、坏文件 `.bak-invalid-*` 留档）
  - `71a3a77` B1：`dshm-profile-check.js`（`verifyAndRepair` L0/L1/L2/L3）+ 门禁 `check-dshm-boot-check.cjs`
  - `747a629` B2：接进 `ensureProfile()`（`fatal` 才 `fail()`、异常降级不阻断、boot 期关 `depDiagnostics`）
- 同日更早（10-23 收尾）：`70017ba` 依赖冲突嵌套 + `depWarnings`（`docs/121`）；`524030d`/`02d6c0c` D-008 决策与 `agc-cli` 定位
- 验证读数（本机、离线）：
  - `check-dshm-uninstall.cjs` **47 断言全过**（16 边界 / 3 历史 fixture 前态重建 / `removeSpec` 集成 / 回滚 / 旧代码负测试 / package.json 加固）
  - `check-dshm-boot-check.cjs` **33 断言全过**（L0 零写入 / L1 四类坏输入 / L2 safe-mode / 种子坏 fatal / 负测试 / §7 接线静态断言）
  - `assert-resfile-sync` 16 件同步；10-23 依赖冲突回归 11/11；`check-resfile-core-zip`/`assert-core-entrypoints`/`assert-cli-shim` 通过
- **装机冒烟（2026-10-24 14:24，已通过）**：修正版 HAP `584267f2…` 已装（设备侧
  `dshm-profile-check.js` 与源码逐字节一致）；最近一次 boot 日志只有
  `启动检查：诊断 2 条（不影响启动）`（`entry id 重复`，属合法覆盖语义），**无 `repaired`**；
  `profile-guard --check` 绿；6 条设置 carried 条目均在。装机回归（B 把核心树设置条目
  误判为坏条目 → 每次启动回设置向导）的修复与门禁 §3b2 见 `docs/122` §四之二；丢失设置已从
  `.profile-guard` 备份恢复。
- **未验证/未做**：
  - 小尾巴（非阻塞）：`clean` 启动不写 `.dshm-boot-check.json`，旧的非 clean 记录会残留；
    本次已手工清掉，代码侧"clean 时删除陈旧 boot-check"留作下一批。
  - `check-dshm-installer.cjs` 的 GitHub 集成段在本机沙箱会卡在 codeload 下载（环境网络），建议代理环境重跑一次。

### 2026-10-27：JIT 实验已回退（D-010），默认恢复 jitless + 保留 ACL 自证探针

- **结论**：debug 签名包在"安装后、系统重启前"可短暂启用 JIT（`jitless=false`、WASM 可用、
  ACL 探针 `granted=false`、进程有 ~12MB `rwxp` 脏页）；但**系统重启后 ArkTS 能起、Host/libnode
  在 V8 初始化阶段崩溃**（无 `runProfile`/无页面加载，白屏闪崩）；同签名 jitless 包正常。
  ⇒ 调试域的 JIT 放行只是安装/调试会话的临时态，重启即失效；ACL/调试 Profile 流程是必要的。
- **代码已回退**：`RuntimePort.buildHostArgv` 恒带 `--jitless`；`NodeRuntime` 恢复；
  `tools/check-store-readiness.mjs` 恢复"必须保留 --jitless"断言（`RESULT: PASS`）。
- **保留**：ACL 自证探针（`entry/.../AclProbe.ets` → `acl-jit-probe.json` →
  `host-ready.json.runtime.aclJitExecMem`）；`hostcore/app/main.js` 的读取逻辑。
- **产物**：`whale-rc.2-jitless-aclprobe-signed.hap`（336,917,827 B / sha256 `d96d586c…`）
  ——默认 jitless + 探针；JIT 实验包已归档（勿日常使用）。
- **文档**：`docs/123`（实验复盘，已改名）、`DECISIONS` D-010、`docs/50` §4.4、README、本文件。

### 2026-10-28：Node 升级 Phase 0（v24.21.0）已接入，待装机冒烟

- 产物来自 `Common/node-ohos-build`（本机原生构建）：`libnode.so.137.stripped-resigned` 121,510,116 B / sha256 `6e66171b…`；
- 已替换 `entry/libs/arm64-v8a/libnode.so.137`（旧版备份 `dist/rollback/libnode.so.137.node24.2.0`，sha256 `09984895…`）；
- 头文件用 **brew 真 bash** 同步到 `entry/src/main/cpp/node-headers`（24.21.0），**清 native 缓存**后重编 `libdshhost.so`；
- 新 HAP：`331,506,058 B` / sha256 `bb4cb106…`；HAP 内 libnode 121,501,784 B（打包去 `.codesign`），dynsym/`node::Start`/`--jitless`/版本串核验通过；核心树未动；
- 门禁：store-readiness PASS、resfile-sync 16 件、core-zip 通过、dshm 46/35 全过；
- **未装机**；待用户 `hdc install -r` 后看 `host-ready.json.runtime.nodeVersion=v24.21.0`、`jitless=true`、natives ok，并**系统重启一次**。
- 文档：`docs/124`、D-011、README/docs-50 同步。

### 2026-10-28：调试双包 `com.jwhsoft.whale` + 本地调试签名

- 为了在不影响日常包 `whale.jwh.chat` 的前提下调试 Node 24.21/alpha.2，已把工程包名改为
  **`com.jwhsoft.whale`**（`AppScope/app.json5`、`build-profile.json5`、托盘 Want、相关门禁脚本同步）。
- 旧调试 Profile 绑定旧包名，hvigor SignHap 直接拒绝；已通过 AGC 建**调试**应用+Profile（无审核）：
  appId `<AGC_APP_ID>`、Profile `whale-dev-debug`（绑本机设备）、复用调试证书 `whale`。
- 构建产物是 unsigned HAP（hvigor 在 SignHap 停下属预期），用 `tools/sign-dev-hap.sh` 本地签：
  **`whale-dev-node2421-signed.hap`**（331,508,729 B / sha256 `bd598d12…`，包名 `com.jwhsoft.whale`，内含 Node 24.21）。
- 新增 `docs/125`（流程/材料/回滚）；旧包与数据未动。**未自动装机**（等用户手动 `hdc install -r`）。
- hdc bridge 已恢复可用（`hdcb` 直连成功），可用于抓新包 hilog。

### 2026-10-28（晚）：调试双包跑通，Node v24.21.0 在真机验证通过

- 新包 `com.jwhsoft.whale`（与日常包并存）已用 **带 ACL 的调试 Profile**（`whale-dev-debug-full`）装成**全功能调试包**；
- 端口：日常包 3121、调试包 **3122**（`NodeRuntime.hostPort()` 按包名分流）；
- 用户真机实测通过（21:00）：登录、工作区、对话、**终端执行命令**、`Download/com.jwhsoft.whale` 读写；
- Host 读数：`BOOT_00 node=v24.21.0 / jitless=true`、`LISTEN 127.0.0.1:3122`、无 `uncaughtException`；
- 出包一条龙：`sh tools/build-dev-hap.sh`（构建→去签名→全 STORED 重打包→whale 证书+ACL Profile 重签）；
  坑：HAP 条目必须 STORED（DEFLATE 会丢图标）、自动签名 Profile 空 ACL、首次启动慢（~1–2 分钟）；
- ~~日常包 `whale.jwh.chat` 保持不动（Node 24.2.0）~~ → **2026-10-29 起：旧包仅存档、不再更新**；
  主包为 `com.jwhsoft.whale`（显示名 **WhaleX**），`main` 已快进到 alpha.2。

### 2026-10-28（晚）：alpha.2 Phase 1 完成（物化 + 静态审计，0 补丁冲突）

- 分支 `alpha2-phase1`；`coreVersion` → **`0.2.2-alpha.2+whale.1`**（未合并 main）；
- 物化树 `dist/core/work/dsh-core-0.2.2-alpha.2+whale.1`：355.8 MB / 40,718 文件；分发包 `dist/core/dsh-core-0.2.2-alpha.2+whale.1-openharmony-arm64.zip` 103.7 MB / 46,272 条目 / sha256 `0cf5f5f6…`；
- **补丁 0 冲突**：pack-core 32 步全过；`check-core-openharmony-patches` **173/173**；`assert-core-entrypoints` PASS（配方 keepGlobs 补 `**/bowser/README.md`）；
- 包集合：新增 26 / 移除 11 / 版本变化 301；新增包无原生依赖；profile 29 id 全可解析，上游移除 id Whale 未引用；
- 本机 workflow 坑：pack-core 的 npm spawn 失败 ⇒ 手工 `node npm-cli.js install --registry=npmmirror`，再 `--skip-install`；selfSign 仍跳过（同 rc.2 基线）；
- 文档：`docs/126`。**未 place-in-app、未装设备、日常包未动**。

### 2026-10-28（深夜）：alpha.2 官方可选 bundle 对齐（Phase 3 续）

- 按"跟上官方"原则启用 9 个官方 optional bundle：session-search / ralph / badge-skill / session-titles /
  cot-translation / auto-review / tool-worktree / liveshare / forge-bundle；新 UI bundle
  `dsh-personalized-recommendations` + `client-ui-stats` 单行；
- 真机验证：client 插件清单含 action-cards/creation-recommendations/plugin-recommendations/agent-team/
  plugin-market/stats/cot-translation/liveshare/forge，全部 200；页/API 200；
- 暂缓冲突项：voice-input（用户跳过，id 重叠）、terminal-bundle、plugin-market-bundle、agent-team-profile、
  inspector-profile、cua（darwin）、subagent-codex/claude-code —— 清单见 `docs/127`，逐个决策；
- 调试包：`whale-dev-latest-signed.hap` sha `e65ae8ac…`；profile 合并自动生效，无需清数据；
- 文档：`docs/127`；分支 `alpha2-phase1`。

### 2026-10-28（深夜）：alpha.2 Phase 4 完成（门禁+产物核验）

- 全量门禁：**34 PASS / 1 BLOCKED / 1 SKIP**；修了 2 个陈旧门禁（`check-profile-pnpm-bridge` H5 字面锚点→正则语义、`docs/90` 行号引用）；
- BLOCKED：`compat-drift` —— `tools/protocol-contract.mjs` 对 alpha.2 生成 0 endpoint（生成器未适配），不影响运行，列后续；
- HAP：341,046,818 B / sha `7799096435…`；HAP 内 core zip = resfile（`d0068f24…`）；libnode 121,501,784（打包去 codesign）；设备安装成功；
- 体积：rc.2 331.5 MB → alpha.2 341.0 MB（+2.9%，与 core zip +9 MB 一致）；
- 文档：`docs/128`；分支 `alpha2-phase1`。

### 2026-10-28（深夜）：新 Whale 数据迁移恢复（沙箱层已完成，待用户 ZIP）

- 新增 `hostcore/app/dshm-restore.js`（迁移期一次性恢复引导，dev 包 + 完成标记门控），main.js `ensureProfile()` 后调用（BOOT_25）；
- 真机（新 Whale）执行：**1219 ms** 恢复 `bin/agc` 等 3 脚本、`.config` 10 文件、`state` 413 文件（skills/vault/插件数据）、
  attachments **725 文件 / 138.7 MB**、`AGENTS.md` 11617 B、凭据 540 B；BOOT_25_RESTORE_DONE，页/API 200；
- 不恢复：旧 `profiles/**`、`storages/workspace.json`、`install-queue/**`、`host-ready.json`、`home-bin`（原因见 `docs/129`）；
- 旧 Whale 不受影响（旧 HAP 无此模块；只对 `com.jwhsoft.whale` 生效）；
- **用户下一步**：在新 Whale 的 dsh-config-manager 恢复 `Backup/whale-backup/2026-10-28/dsh-config-2026-10-28-7b2b1e.zip` → 重启；
- 文档：`docs/129`。

### 2026-10-28（深夜，续）：config-manager ZIP 恢复失败修复

- 现象：新 Whale 恢复 234 MB 备份 ZIP 报「ZIP 压缩数据总量超过上限」（进度 11%）；
- 根因：`dsh-config-manager` 的 `DEFAULT_ZIP_SAFETY_LIMITS.maxCompressedBytes = 200 MiB`，
  而备份包压缩总量 223.1 MiB；其它上限都够（uncompressed 228.2 MiB / 单条 25.2 MiB）；
- 修复：`dshm-restore.js` 增加幂等 `maybePatchConfigManagerZipLimit()`，启动时把已装插件的
  `lib/utils/zip.js` 上限改为 512 MiB；真机日志已见 `已放宽 ... 200 MiB → 512 MiB`；
- 最新调试 HAP `ae02cc91…`；用户下一步重试 manager 恢复；
- 注意：clean 构建（删 `entry/build`）才能确保 resfile 新文件进 HAP——此前增量构建出现过 HAP 里 main.js 未更新。

### 2026-10-28（深夜，续2）：迁移备份策略调整（用户决定）

- 决定：**后续迁移不备份 sessions**；dsh-config-manager 导出不勾 sessions（ZIP ~8 MB），新包从新会话开始；
- 旧会话留在旧 Whale 沙箱（不卸载旧包即可保留）；本次 223 MB ZIP 仍按已放宽上限恢复；
- 附件是否随迁按下一次需要单独决定；`dshm-restore` 照旧负责沙箱层；
- 决策 `D-019`，细节 `docs/129 §七`。

### 2026-10-29（凌晨）：本次迁移不恢复附件（用户决定）

- `dshm-restore` 新增 `dropMigrationAttachmentsOnce()`：新包启动一次性删除已恢复的旧附件（138.7 MB），
  写 `$DSH_HOME/.dshm-restore-attachments-dropped` 防误删以后新会话附件；旧 Whale/备份 tar 保留原件；
- 真机日志已见 `已删除本次迁移恢复的旧附件`；HAP `99d0b991…`；
- 下一步：旧 Whale 重新导出**不含 sessions** 的 ZIP（~8 MB）→ 新 Whale 导入；附件不用管。

### 2026-10-29（00:16）：迁移收口（数据层已落盘，其余明日验证）

**已完成**
- alpha.2 Phase 1–4（门禁 34 PASS / 1 BLOCKED compat-drift / 1 SKIP；HAP `99d0b991…`，core zip `d0068f24…`）；
- 新 Whale 数据迁移：Host 一次性恢复沙箱层（vault/skills/AGENTS/bin/.config；附件按决定删除）；
- dsh-config-manager ZIP 上限补丁（200→512 MiB）+ 小 ZIP（7.8 MB，不含 sessions）导入成功；
- 迁移冲突选择口径、旧插件待重装清单：`docs/129 §九`，清单在
  `Backup/whale-backup/2026-10-28/插件清单-待新包装回.txt`。

**明日验证（用户）**
1. 模型对话/凭据；2. 工作区指到 `DSH_Proj`；3. 按清单重装 7 个旧插件（装卸前跑 profile-guard）；
4. AGENTS/skills/插件页/Agent Teams；5. 重启一次确认导入后稳定。

**之后（Phase 5/6）**
- Phase 5：长会话/多子代理/多插件稳定性，token/缓存观察；
- Phase 6：`alpha2-phase1` → `main` 合并、文档/HANDOFF/DECISIONS 收尾、旧插件回归、
  决定 `com.jwhsoft.whale` 作为主包与旧包数据保留策略；`dshm-restore` 迁移引导可择机移除。

### 2026-10-29（10:35）：调试包显示名改为 WhaleX（包名不变）

- 应用列表/任务卡/托盘显示名：新 Whale（`com.jwhsoft.whale`）→ **WhaleX**；日常包仍 Whale；
- 改动：`AppScope` 的 `app_name` + `entry` 的 `module_desc`/`EntryAbility_desc`/`EntryAbility_label`/`BackgroundAbility_label`/`tray_hover_tips`；
- clean 构建后 HAP `e9185506…`，已 `hdc install -r` 覆盖安装（数据未动）；
- 文档：`docs/125` 一·补。

### 2026-10-29（11:10）：主线收拢为单一主包 WhaleX（Phase 6 收尾第一步）

- `main` **快进合并** `alpha2-phase1`（`d093207`，无冲突；两分支现等价）；
- 旧包相关脚本改到新包名：`tools/device-acceptance.ps1`、`device-code-fingerprint.ps1`、
  `update-device.ps1`（共 6 处 `whale.jwh.chat` → `com.jwhsoft.whale`）；
- `tools/dshtest.py`：`APP` 改为 `com.jwhsoft.whale`，支持 `DSHM_APP` 覆盖；
- 门禁注释口径更新：`check-store-readiness.mjs`（`BUNDLE_NAME` 本就是新包名）、`check-workspace-claim.mjs`；
- `README.md`：核心版本 → `0.2.2-alpha.2+whale.1`、主包 `com.jwhsoft.whale`（WhaleX）、Node v24.21.0、
  旧包"仅存档不再更新"；
- **旧包 Whale（设备已装）不受影响**，仍可用；只是不再作为发版目标。

### 2026-10-29（晚）：Office 预览与官方对齐 —— 走 HAP 内置 office2pdf ✅

- **做法**：不认领后缀、不自己渲染；**顶替上游 `officeToPdf` 服务**（同名 service）⇒ 官方
  `OfficeBody` + 官方 PDF 渲染器全复用，转换走 HAP 内置引擎（Rust/Typst 经 CMake NAPI 外壳 dlopen）。
- **必须同时成立的 6 个接点**（错一个就静默退化，已全部收进门禁）：
  ① profile 停用上游 `office-to-pdf`；② 启用 `dshm-office2pdf`；③ 停用 `dshm-office-system-preview`
  （让出认领）；④ `render()` 参数名逐字 `workspaceFileScope`（Gateway 按参数名查 wire 映射）；
  ⑤ 插件**不导出 apply**（否则 cordis 不实例化服务类）；⑥ 外壳必须 CMake 构建 + `DT_NEEDED libnode`，
  `libs/` 内有 Rust `liboffice2pdf_capi.so`，ArkTS 字体桥就位。
- **字体（行距叠行的真因）**：office2pdf 的替换链只认 `Noto Serif/Sans CJK SC`；`getFontByName`
  查不到它们 ⇒ 字体桥改**直连** `/system/fonts/NotoSerifCJK-Regular.ttc` + `NotoSansCJK-Regular.ttc`
  复制进 `filesDir/office2pdf-fonts/`（OFL，不进 HAP）。
- **门禁**：新增 `tools/check-office2pdf-wiring.mjs`（22 项静态接线判据）；`coreVersion` → `0.2.2-alpha.2+whale.2`。
- **真机**：docx/pptx 正常、中文行距正确、xlsx 走官方前端解析不受影响、pdf 正常；
  HAP 396,445,868 B / sha `ce3f91e2…`；core zip `455eb733…`（109,160,835 B）。
- **未做**：工具栏「用系统打开」按钮 —— 尝试时触发 documentpreview 激活失败（页面起不来），
  **已整块撤回**，备份 `/tmp/o2p-button-wip/`，重做需换不冲突机制并先离线验证（见 `docs/130` §9）。
- 文档：`docs/130`；引擎构建脚本 `tools/office2pdf/build-capi.sh`；C ABI 源码 `tools/office2pdf/capi/`。

### 2026-11-01：仓库公开 + 双平台发布（GitHub / AtomGit）

- 仓库公开：<https://github.com/fufay/whale>（原 private 已置 public，admin 权限已核）；
  AtomGit 镜像：<https://atomgit.com/Kevin911/whale>；
- 已推送 `main`（含合并远端 2 个快照提交：用 `git commit-tree` 造合并提交，绕开本机 `git merge` SIGABRT）；
- **Release `v1.1.0`** 双平台均含未签名 HAP（394,069,274 B，sha256 `f071e7d7…`）：
  GitHub <https://github.com/fufay/whale/releases/tag/v1.1.0> ·
  AtomGit <https://atomgit.com/Kevin911/whale/releases/tag/v1.1.0>
- README 重写为公开版：下载表、安装（hokit）、从源码构建（工具/大件清单/步骤）、
  第三方非 MIT 运行库清单（GPL/LGPL/PSF 等只给上游链接，不随包分发）、Office 预览说明；
  DSHM 来源按用户要求移到文末一句；
- 注意：AtomGit 的 release 附件不是 `attach_files`，而是
  `GET /releases/:tag/upload_url` → 拿 `{url, headers}` → **PUT** 上传（OBS 直传，`success` 即完成）。

## 3. 下一步（按优先级）

1. **Phase 0 装机冒烟（用户执行）**：装 `whale-node2421-phase0-signed.hap` → 看 `host-ready.json.runtime.nodeVersion=v24.21.0`/`jitless=true`/natives → 会话/工具 → **系统重启一次**；失败用旧 HAP/libnode 回滚。
2. 冒烟通过 ⇒ 启动 **alpha.2 Phase 1**（物化 + 审计，见 `docs/README`/本文件计划）。
3. 上游稳定版（0.2.2）发布后重新评估是否直接跟稳定版。

## 4. 已知坑 / 约束（别重复踩）

- 真机数据/签名物料不可删；一律 `hdc install -r` 覆盖安装。详见 `AGENTS.md` §最高优先级。
- 出包必须 `node tools/pack-core.mjs --place-in-app`；本轮只改 HAP resfile（`hostcore/app/*`），**未动核心树**，故 `coreVersion` 不变。
- 改 `hostcore/app/*` 后必须 `node tools/place-host-app.mjs` + `assert-resfile-sync.mjs`；**新增模块要同时加进 `place-host-app.mjs` 与 `assert-resfile-sync.mjs` 的清单**（漏了 = 端侧 MODULE_NOT_FOUND）。
- `hostcore/app/*` 禁止新增运行时 npm 依赖（严格 YAML 从核心树按绝对路径 require，见 `dshm-yaml-check.js`）。
- 裸跑 `pack-core`/`place-toolchain` 会改树内 `builtAt` 或重 gzip resfile，导致与已出 HAP 失同步（`docs/116` §9）。
- 完整门禁/端侧读数坑：`docs/120`。
- **Node 升级相关（2026-10-28）**：`bash` 是垫片，跑 `tools/node-runtime/*.sh` 要用 brew 真 bash（`/storage/Users/currentUser/.harmonybrew/bin/bash`）；改 `node-headers/` 后 hvigor **不会**自动重编 native，必须删 `entry/build/default/intermediates/cmake` 与 `entry/.cxx` 再 build；HAP 打包会去掉内嵌 .so 的 `.codesign`（dlopen 不需要，属正常）。详见 `docs/124`。

## 5. 本次改动（2026-10-24）

- 新增 `hostcore/app/dshm-yaml-check.js`（严格解析/原子写/备份）、`hostcore/app/dshm-profile-check.js`（B 检查/修复）。
- 改 `hostcore/app/dshm-installer.js`（卸载整块删除 + 写后校验回滚 + 市场行清理 + `package.json` 加固）、`hostcore/app/main.js`（`instOpts.coreDir` + B 接线）。
- 新增门禁 `tools/check-dshm-uninstall.cjs`、`tools/check-dshm-boot-check.cjs`；`place-host-app`/`assert-resfile-sync` 清单扩到 16 件。
- 文档：`docs/122`、`docs/README` 索引、`docs/120` 门禁清单、`DSHM问题汇总与解决/issue-端侧插件卸载写坏profile-overlay导致无法启动.md` 的"已修复"更新。

## 6. 开工/收尾模板

开工：

```text
项目 Common/whale。先读 HANDOFF.md、AGENTS.md、DECISIONS.md，再看 git status / git log --oneline -20。
本次只做：<一个明确任务>。
结束前更新 HANDOFF.md（完成/未完成/坑/下一步/验证命令）。
```

收尾：

```text
收尾：更新 Common/whale/HANDOFF.md：
1) 改了什么（文件/commit）2) 验证结果 3) 没做完的 4) 新发现的坑 5) 下一步。
```
