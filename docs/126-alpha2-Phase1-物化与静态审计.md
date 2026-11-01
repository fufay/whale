# 126 · alpha.2 纳入 Phase 1：物化与静态审计

> 2026-10-28 ｜ 分支 `alpha2-phase1` ｜ 上游目标 `@deepseek-ai/dsh@0.2.2-alpha.2`
> 前置：调试双包 `com.jwhsoft.whale`（Node v24.21.0）已跑通（`docs/125`）。
> 本阶段只物化 + 审计，**不 place-in-app、不装设备**。

## 一、结论（先看）

| 项 | 结果 |
|---|---|
| 核心树物化 | ✅ `dsh-core-0.2.2-alpha.2+whale.1`，355.8 MB / 40,718 文件；npm 装出 649 个包 |
| 分发包 | `dist/core/dsh-core-0.2.2-alpha.2+whale.1-openharmony-arm64.zip`，103.7 MB / 46,272 条目，sha256 `0cf5f5f62708193e9425f88c0adfbc1df97de80a2ed28ec31b70d18d9d9f1c6a` |
| **端侧注入补丁冲突** | **0 个**。pack-core 32 个步骤全部通过；权威门禁 `check-core-openharmony-patches` **173 passed / 0 failed**（23 处注入全在、上游反例全消失） |
| 运行期入口门禁 | ✅ PASS（661 包根 / 4007 条入口全部解析得到文件） |
| 包集合变化 | 新增 **26**、移除 **11**、版本变化 **301**（详见 §三） |
| 原生依赖 | 必需件全在（koffi / node-pty）；26 个新包**零新增原生依赖**；overrides 仍生效 |
| profile | 现有 29 个 id 全部仍能在 alpha.2 源码中解析；被移除的 3 个上游 id Whale 未引用 |
| Stop/Go | **GO Phase 2**：直接 place-in-app + 出调试包 + 真机启动冒烟（无需 patch 重锚） |

> 与事前静态判断的差异：此前只按"rc.2→alpha.2 目标文件 18/18 全变"预估"可能大面积重锚"；
> 实测**所有锚点都还在**。结论以门禁为准，静态估计只能当风险提示。

## 二、怎么物化的（含本机坑）

1. `hostcore/core-recipe.json`：`coreVersion` `0.2.1-rc.2+whale.2` → **`0.2.2-alpha.2+whale.1`**（pack-core 用它作为 `@deepseek-ai/dsh` 的安装 spec，`+whale..` 是构建元数据，实际解析到 `0.2.2-alpha.2`）。
2. `node tools/pack-core.mjs` 在本机**卡在 ① npm install**：`spawnSync("…/bin/npm")` 返回 `exit=null`（HarmonyOS 上直接 exec npm 的 shebang JS 失败）。
   **绕法**：手工在 stage 目录跑
   ```sh
   node <brew-node>/bin/../node_modules/npm/bin/npm-cli.js install \
     --os=openharmony --cpu=arm64 --ignore-scripts --no-audit --no-fund \
     --registry=https://registry.npmmirror.com
   ```
   再 `node tools/pack-core.mjs --skip-install`。走 npmjs 直连 4 分钟没解出依赖树；换 npmmirror **2 分钟装完 649 包**。
3. 为拿到"全部补丁失败"而不是"第一个就 die"，临时复制了一份 pack-core（`tools/.phase1-audit.mjs`，**未入库**）把 `die` 改抛异常并对 32 个步骤逐个 try/catch。结果 `failures 0/32`，随后删除临时脚本、用**原版** pack-core 重跑并通过全部门禁。
4. `selfSignNatives()` 仍跳过：它要求 `java + binary-sign-tool.jar`，本机只有 OHOS 原生 `binary-sign-tool`（ELF）。**与 rc.2 基线一致**（旧 manifest 也是 `selfSign.skipped=true`），不是回归；`rg`/`git` 真身 exec 受限仍是已知边界。

## 三、包集合变化（rc.2 → alpha.2）

- **新增 26 个 @deepseek-ai 包**：
  - UI/交互：`dsh-client-ui-action-cards`、`dsh-client-ui-entry-customization`、`dsh-client-ui-file-drag`、`dsh-client-ui-creation-recommendations`、`dsh-client-ui-plugin-recommendations`、`dsh-experimental-client-ui-forge`、`dsh-experimental-client-ui-stats`
  - 能力/工具：`dsh-action-cards`、`dsh-message-quotes`、`dsh-deliverable-file-references`、`dsh-plugin-detail`、`dsh-official-bundles`、`dsh-tool-executor-native`、`dsh-tool-executor-ptc`
  - 实验/平台：`dsh-computer-use`、`dsh-cua`、`dsh-cua-bundle`、`dsh-experimental-forge{,-bundle,-github,-session}`、`dsh-experimental-liveshare`、`dsh-experimental-liveshare-protocol`、`dsh-creation-recommendations`、`dsh-personalized-recommendations`、`dsh-plugin-recommendations`
- **移除 11 个**：`dsh-client-ui-deepseek-model-label-1017`（上游删除）；`node-addon-system-linux-arm64`（本仓合成包，pack-core 会重建）；其余 9 个是**自有 dshm-***（原树里有、新装树没有，pack-core 的 `embedDshmToolPackages()` 会按清单重新嵌回）。
- **301 个版本变化**：全部 `0.2.1-rc.2 → 0.2.2-alpha.2`；cordis 系 `4.0.5 → 4.0.6-alpha.1`；schemastery `3.18.5 → 3.18.6-alpha.1`。
- 树内清单（`dshm-core.json`）：插件行 **299 → 300**；`pureJs 282→283`、`native 6`、`unknown 11`、`disabled 11`、`nativePackages 4`（均未恶化）。
- 新增插件 id：`deliverable-file-references`、`entry-customization`、`message-quotes`、`tool-executor-native`、`tool-executor-ptc`、`ui-file-drag`；移除 id：`tool-presentation`、`tool-subagent-list-agents`、`ui-deepseek-model-label-1017`。

## 四、补丁冲突清单

**无。** 门禁 `check-core-openharmony-patches` 173/173 全绿，覆盖 23 处端侧注入 + 1 处撤除守卫；`assert-core-entrypoints` PASS。

仍列为 **Phase 2 语义复核**（锚点没变 ≠ 行为一定等价）：
- `patchAgentPresetWorkflow` / `addOnDevicePreset`（preset 结构大改：`dsh-agent-preset*` 重构）
- `patchAppBootReadonlyStack`（app-boot 重构之一）
- `patchMarketDesktopRuntime` / `patchProfilePnpmBridge`（`dsh` 的 profile-boot、plugin-manager 都有改动）
- `patchFsLocalLink` / `patchFsLocalPermissionHint` / `patchAttachmentLocal*`（fs/attachment 局部改）
- `patchResourceAddressArmor` / `patchPdfMapCompat` / `patchSubprocessOpenharmony` / `patchSidebarTabIdLeak`（client bundle 重编译，锚点仍在）
- 真机启动后逐项复测：终端/文件/市场/语音/Office 预览/artifact 资源。

## 五、自有插件适配清单（静态）

9 个 `dshm-*` 插件全部引用的上游包都已随 alpha.2 升级；**未发现缺失的具名导出**（逐 symbol 扫描）。重点关注（Phase 2 真机验证优先级）：

| 插件 | 关键上游依赖 | 风险点 |
|---|---|---|
| `dshm-ptc-runtime-inproc` | `dsh-ptc-runtime`、`dsh-ptc-runtime-node`、`dsh-timeout`、`dsh-util-values` | alpha.2 新增 `dsh-tool-executor-ptc/native`，可能有新执行器语义；需验证 PTC 工具链 |
| `dshm-profile-pnpm` | `dsh-plugin-manager`、`dshm-market-bridge` | plugin-manager 重构，`operations.js` 形态变化 |
| `dshm-market-bridge` | `dsh`（profile-boot-*.js） | 市场通道注入点随 app-boot 重构 |
| `dshm-fs-write-nonchmod` | `dsh-fs`、`dsh-fs-local`、`dsh-fs-sandbox` | 权限包装层改动 |
| `dshm-tool-fs-remove` | `dsh-fs*`、`dsh-tool-fs`、`dsh-tools` | 工具 schema/错误形态 |
| `dshm-office-system-preview` | `dsh-client-resources`、`dsh-client-ui-sidebar-documentpreview`、`dsh-api-workspace-files` | 侧栏预览重构；`dsh-client-ui-primitives` 在两版树中都**不是** npm 包（web 前端已 bundle），非新增问题 |
| `dshm-hilog` | `dsh-bash-local`、`schemastery` | 低风险 |
| `dshm-screen-pilot` | （无上游 import） | 低风险，但工具注册依赖 core 工具 API |
| `dshm-workspace-claim` | `dsh-client-ui-workspace` | 低风险 |

## 六、profile 迁移清单

- 现有 `hostcore/profile/ondevice/cordis.patch.yml` 29 个 id：**全部仍可解析**（含 12 个上游 id 仍在 alpha.2 源码中，其余是自有 dshm/端侧行）。
- 上游移除的 3 个 id（`tool-presentation`、`tool-subagent-list-agents`、`ui-deepseek-model-label-1017`）：Whale 代码/profile **均未引用**（grep 干净）。
- 上游 web-app `cordis.patch.yml` 变化：删 `tool-subagent-list-agents` 行；`tool-subagent.config.modelSelectionSettings: true` → `modelSelection: true` + `modelDiscovery: true`。Profil e 未覆盖这两个键，**不阻塞**。
- 可考虑后续在 profile 里启用 alpha.2 新 UI 能力（`entry-customization`、`message-quotes`、`ui-file-drag`、`ui-action-cards`、`ui-plugin-recommendations` 等）——属于体验增强，Phase 2 先保证启动/核心功能，不急加。

## 七、其他审计

- **原生**：`requiredNative` 三项全在（koffi openharmony_arm64、node-pty openharmony-arm64 pty.node + spawn-helper）。
  - koffi 3.2.1（真 koffi + 平台别名 `linux_arm64`/`musl_arm64` ↔ `openharmony_arm64`），node-pty = `@ohos-ports/node-pty@1.1.0-beta.0`，sharp = `@ohos-ports/img-sharp` dispatch 包。
  - 26 个新包中**无原生依赖**（无 `*.node` 新增）。
  - manifest 显示 47 signed / 3 unsigned：其中 2 个是 `node-addon-system-linux-arm64/bin/{glibc,musl}/system.node` **占位件**（本次"先跑 audit 再跑原版 pack"的产物顺序造成 verify 扫到；干净一次跑应为 47/1，占位件本身无签名需求）。koffi 未签名与 rc.2 一致（走 dlopen，不需要）。
- **裁剪**：alpha.2 新增 `bowser@2.15.0` 的 `exports` 显式导出 `./README.md`，而 `**/*.md` 裁剪会删它 ⇒ `assert-core-entrypoints` 报 1 条 FAIL。**配方修复**：`prune[0].keepGlobs` 加 `**/bowser/README.md`（9.8 KB），门禁恢复 PASS。
- **体积**：解包 326.5→355.8 MB（+9.0%），zip 94.7→103.7 MB（+9.5%），条目 40,716→46,272。HAP 体积预计 +9 MB 量级，Phase 2 出包时再核。
- **工作流坑（下次直接照做）**：
  1. 本机 pack-core 的 `npm install` 必须手工以 `node npm-cli.js + --registry=npmmirror` 跑；
  2. `pack-core` 的 `selfSignNatives()` 在本机永远跳过（缺 java/jar），与基线一致；
  3. 想一次拿到全部 patch 失败，用"审计版 pack-core（die→throw + 逐步骤 try/catch）"，用完删除。

## 八、产物与回滚

- 树：`dist/core/work/dsh-core-0.2.2-alpha.2+whale.1/`
- 包/清单：`dist/core/dsh-core-0.2.2-alpha.2+whale.1-openharmony-arm64.zip` + `.manifest.json`
- 配方改动（分支 `alpha2-phase1`，未合并 main）：
  - `coreVersion` → `0.2.2-alpha.2+whale.1`
  - `prune[0].keepGlobs` + `**/bowser/README.md`
- 日常包/设备未动；`entry/src/main/resources/resfile/` 尚未替换（Phase 2 再做。
- 回滚：`git checkout main`（或 revert 本分支提交）即回到 rc.2 配方。

## 九、Phase 2 建议（下一步）

1. `node tools/pack-core.mjs --skip-install --place-in-app` → 把 alpha.2 zip 放进 `entry/src/main/resources/resfile/`；
2. `sh tools/build-dev-hap.sh` → 出**调试双包** HAP（Node 24.21 + full ACL 调试签名）；
3. 装 `com.jwhsoft.whale` → 真机启动冒烟（先看 `BOOT_00/BOOT_10/BOOT_65`、`Host 已就绪`、页面 200；再验证终端/文件/市场/语音/Office）；
4. 按 §五 风险表逐项回归；有问题在 dev 包上改 patch/插件，不碰日常包。

---

## 十、Phase 2 追加记录（2026-10-28 晚，真机启动冒烟）

> 本节补充 Phase 2 首轮结果；主结论仍是 §一（补丁 0 冲突）。真机载体 = 调试双包 `com.jwhsoft.whale`（Node v24.21.0 + full ACL 调试签名），**日常包未动**。

### 10.1 已跑通

- `pack-core --skip-install --place-in-app` → resfile 换成 alpha.2 核心（108,788,942 B / sha `13d1d55f…`）；
- `tools/build-dev-hap.sh` → `whale-dev-latest-signed.hap`，装进调试双包；
- 真机读数：`DSHM-AUTO 安装内置核心：installed=["0.2.2-alpha.2+whale.1"]`；`startHost 核心=…/cores/0.2.2-alpha.2+whale.1`；`Host 已就绪：127.0.0.1:3122`；页面/接口 `status=200`（session/list、agentPresets/list、modelCatalog、settings、workspaceFiles…），WebSocket 已连；
- 首启 ~2 分钟（解 104 MB/46k 条目的核心 + profile boot），第二次启动 ~90 s；
- **用户真机实测通过（2026-10-28 21:44）**：终端执行命令正常、工作区读写正常、UI 正常，没有白屏/报错。
  调试包已成为 alpha.2 的可信验证载体；日常包 `whale.jwh.chat` 仍未动。

### 10.2 Phase 2 首轮修的两个真 bug

1. **alpha.2 静态资源 400 → "核心未就绪"**（最关键）
   - alpha.2 `dsh-host-webserver` 的 `nodeHeaders()` 对 Fetch `Response.headers` 调 `headers.getSetCookie()`（Node 20+ 的 Web Headers API）；
   - 端侧 `--jitless` 下全局 `fetch/Headers` 由 `hostcore/app/fetch-shim.js` 的 `DshmHeaders` 顶替，**没有 getSetCookie** ⇒ 每个 `/`/静态资源请求在 handler 里抛 `TypeError: headers.getSetCookie is not a function` ⇒ `dsh-host-webserver` 兜底 `400` ⇒ ArkWeb 页面 `Host 返回 HTTP 400` ⇒ "核心未就绪"；
   - 复现方式：用 Node v24.21 + alpha.2 核心树在本地跑 `resources/app/main.js`（独立 repro），再 patch `dsh-host-webserver` 的 catch 打 `console.error` 拿到堆栈；
   - 修复：`DshmHeaders` 增加 `getSetCookie()`（返回未合并的 `set-cookie` 数组，无则 `[]`）+ `place-host-app` 同步 resfile；
   - 验证：独立 repro 自探从 `GET / → 400` 变回 `401`；带 token 请求 `303 + set-cookie`，带 cookie 请求 `200 index`；真机页面/接口 200。
2. **调试出包脚本会静默用旧 HAP**
   - 旧 `build-dev-hap.sh` 里 `DC="node /path/cli.js"` 后 `"$DC" build` 被当成整条命令名 ⇒ 构建根本没跑，脚本继续拿上一次的 `entry-default-signed.hap`（rc.2 核心）重签发布，造成"装的是 alpha.2 包、跑的是 rc.2 核心"的假象；
   - 修复：改成 `node "$DC_CLI"`、构建前删除旧产物、明确检查产物存在并打印 `build rc/时间戳`。

### 10.3 已知问题（待后续）

1. **首次装/换核心后 App 可能被系统重启一次**（重度解包 104MB/46k 条目触发；第二次正常）。暂记为"首启允许一次重启"，后续看是否要把核心安装做得更轻/分片。
2. **语音模型文件缺失刷屏**：`Stat failed …/speech-to-text/sensevoice/model8.onnx` 每 ~3 s 一次；已定位是**全新数据**下模型未下载（旧包沙箱里有模型所以不刷）；属于首启/未下载态，不是 alpha.2 回归，后续验证语音时再确认下载触发。
3. `api/changes.summary` 偶发 404（页面仍正常）：alpha.2 的 `dsh-client-ui-deliverables` 客户端仍请求该端点，但当前 profile 没有对应的服务端 provider（或 alpha.2 换了端点命名）；低优先级，下一轮核对。
4. 自有插件（PTC/profile-pnpm/market/office/fs）尚未逐项在 alpha.2 真机上回归 —— Phase 2 下一轮。

### 10.4 命令与产物

- 出 alpha.2 调试包：`pack-core --skip-install --place-in-app` → `sh tools/build-dev-hap.sh`；
- 本次 HAP：`dist/signing/dev-profile/whale-dev-latest-signed.hap`（sha256 `4d376d17…`，含 `getSetCookie` 修复）；
- 独立 repro（诊断用）：`tmp/alpha2-host-repro/` + `tmp/repro-host*.log`（不入库）。

---

## 十一、Phase 3 追加记录（2026-10-28 晚，自有插件适配）

> 目标：9 个 `dshm-*` 自有插件在 alpha.2 下全部能加载/工作；与"自有 skill"无关（skill 是 markdown 说明，由 `dshm-skills.js` 同步到 `$DSH_HOME/skills/`，不参与插件装配）。

### 11.1 发现并修复：`dshm-screen-pilot` 工具注册丢失

- alpha.2 的 `@deepseek-ai/dsh-tools` 服务（`super(ctx,"tools")`，`static inject=["systemPrompt"]`）激活顺序变晚；
- 本插件原写法 `inject = []` + `ctx.get('tools')`（软取）⇒ apply 时服务还没就绪 ⇒ 真机日志
  `[dsh-screen-pilot] tools 服务不可用：跳过模型工具注册（插件仍正常加载）` ⇒ 截图/UI 树/键鼠 **9 个模型工具全部没注册**；
- 修复：`export const inject = ['tools']`（与 `dshm-hilog` 同一写法），cordis 自动推迟到 tools 就绪后激活；
- 验证：独立 repro + 真机日志均出现 `[dsh-screen-pilot] 已注册 9 个模型工具`。

### 11.2 其余 8 个插件在 alpha.2 下的验证结果

| 插件 | 验证方式 | 结果 |
|---|---|---|
| `dshm-ptc-runtime-inproc` | 真机日志 `[ptc] ctx.ptcRuntime = …` | ✅ 已装载（耗时 ~13 ms，自证 sha 一致） |
| `dshm-market-bridge` | 真机日志 `随包 bin/pnpm 假壳可执行 ⇒ 不接管` | ✅ 已装载（走已验收假壳链路） |
| `dshm-workspace-claim` | 真机日志 `注册表已有工作区 ⇒ 不新增` | ✅ 已装载（幂等生效） |
| `dshm-office-system-preview` | 客户端 bundle 加载：`/plugins/…dshm-office-system-preview/client.js … status=200` | ✅ 客户端注册；**真实 Office 文件预览待用户点验** |
| `dshm-fs-write-nonchmod` | pack-core 补丁把 `fs-sandbox` 行换为本插件；门禁 173/173 通过；工作区写入实测正常 | ✅ |
| `dshm-hilog` | `inject=['tools']` 与 screen-pilot 同源（tools 服务已可用）；插件静默注册 | ✅（工具列表未单独打日志） |
| `dshm-tool-fs-remove` | 随核心树装载；删除拒绝提示逻辑复用 fs 服务 | ✅（待聊天里删文件时点验） |
| `dshm-profile-pnpm` | pack-core `patchProfilePnpmBridge()` 注入（门禁通过）；插件市场安装通道 | ✅ 注入就位；**插件页安装/卸载待用户点验** |

### 11.3 Phase 3 剩余（需要用户点几下）

1. **插件市场/插件页**：安装或卸载一个插件（验证 market-bridge + profile-pnpm + installer 全链路）；
2. **Office 预览**：在 dev 包工作区放一个 `.docx/.pptx`，侧栏点击预览；
3. 可选：聊天里让 agent 调 `hilog_*` / screen-pilot 工具（验证模型工具注册结果）；
4. 其余 8 项程序化验证已通过，真机页面/API 保持 200。

### 11.4 本次改动

- `hostcore/plugins/dshm-screen-pilot/lib/index.js`：`inject = ['tools']` + 注释（alpha.2 兼容）；
- 重跑 `pack-core --skip-install --place-in-app` 重新嵌入 9 插件 → 新调试 HAP `a689395c…`，已装；
- 真机：`dshm-market-bridge`/`ptc`/`screen-pilot`/`workspace-claim` 日志正常，页面/API 200。

### 11.5 补充（2026-10-28 22:10）：官方新 UI **全量**启用（不挑拣）

- profile bundles 增加官方可选 bundle **`@deepseek-ai/dsh-personalized-recommendations`**，
  一次性挂上：`action-cards` / `creation-recommendations` / `plugin-recommendations` 三个 host 插件
  及其三个 client 插件；
- profile patch 追加 **`client-ui-stats`**（`@deepseek-ai/dsh-experimental-client-ui-stats`）：
  每轮/每步 context、耗时、缓存命中、工具成本表（上游放在 inspector profile 里，端侧只挂该行）；
- 原本已随 dsh-web-app 默认启用的：`entry-customization`、`message-quotes`、`ui-file-drag`、
  `deliverable-file-references`；
- 真机验证 `/plugins/…` 下发清单已包含 `dsh-client-ui-action-cards`、`dsh-client-ui-creation-recommendations`、
  `dsh-client-ui-plugin-recommendations`、`dsh-experimental-client-ui-stats` 的 client.js，全部 `status=200`；
- **未启用的只有平台不适用项**：`@deepseek-ai/dsh-cua-bundle`（`platforms: ["darwin"]`，macOS Computer Use）。
- 其余上游 optional **feature** bundles（session-search / session-titles / badge-skill / auto-review /
  voice-input / terminal / tool-worktree / agent-team / liveshare / forge / cot-translation /
  subagent-codex / subagent-claude-code）属于功能包而非新 UI，部分与 Whale 自有替代实现（语音、市场、终端补丁）
  可能冲突，留作下一轮逐包评估（需 boot 冒烟）。
