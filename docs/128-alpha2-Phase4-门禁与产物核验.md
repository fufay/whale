# 128 · alpha.2 Phase 4：全量门禁与产物核验

> 2026-10-28 ｜ 分支 `alpha2-phase1` ｜ 载体：调试双包 `com.jwhsoft.whale`（alpha.2 core + Node v24.21.0）
> 关联：`docs/126`（Phase 1–3）、`docs/127`（可选 bundle/冲突清单）

## 一、结论

| 项 | 结果 |
|---|---|
| 门禁 | **34 PASS / 1 BLOCKED / 1 SKIP**（原 3 个 fail 中已修 2 个；剩下 compat-drift 是工具侧阻塞） |
| HAP 产物 | 341,046,818 B / sha256 `7799096435…`；core zip 与 resfile **逐字节一致**（`d0068f24…`） |
| 体积 | 调试 HAP 331.5 MB（rc.2）→ **341.0 MB**（alpha.2，+9.5 MB，主要是 core zip +9 MB） |
| 设备侧安装 | `hdc install -r` 成功（系统已完成签名校验）；页面/API 正常 |

**结论：Phase 4 通过（compat-drift 列为单独跟进项），可以进入 Phase 5 冷启动/稳定性验证。**

## 二、门禁结果

运行脚本：`/tmp/phase4-run-gates.sh`（每项 `timeout 240`，日志 `/tmp/phase4-gates.log`）。

### 2.1 通过（34）

- 仓库/构建：`assert-cli-shim`、`assert-resfile-sync`、`check-parity`、`assert-exec-fix`、`assert-python-bridge`、`assert-fs-search-fallback`、`arch-check`、`check-dead-code`、`check-tar-extract`、`check-resfile-core-zip`、`check-plugin-toggle`
- jitless/垫片：`check-web-fetch-jitless`、`check-worker-jitless`、`check-internal-undici`、`check-fetch-shim.cjs`
- 技能/PTC：`check-skill-sync.cjs`、`check-ptc-ts-strip`、`check-ptc-runtime-inproc`、`check-ptc-wiring`
- 核心树：`check-core-openharmony-patches`（173/173）、`assert-core-entrypoints`、`check-fs-local-permission`、`check-native-closure`、`check-node-headers`（Node 24.21 源码树）、`check-store-readiness`（jitless 默认仍在）
- 端侧/插件：`check-market-bridge`、`check-profile-pnpm-bridge`（45/45）、`check-denial-hints`、`check-workspace-claim`、`check-dshm-uninstall.cjs`、`check-dshm-boot-check.cjs`、`check-hap-native-signing`

### 2.2 修复后通过（2）

1. `check-profile-pnpm-bridge` H5：断言还按旧的字面串查找 `return rejected(preflight, 'nothing was installed');`，
   而 pack-core 为兼容 alpha.4 已改成**正则锚点** ⇒ 门禁陈旧。改为断言锚点的两个语义片段（`preflight.length > 0` + `nothing was installed`）。
2. `check-doc-refs`：`docs/90-…:4055` 引用 `docs/50` §12.0 的旧行号（`:889-897`），
   而 docs/50 因新增版本口径提示整体下移；改为当前 `:907-917`。

### 2.3 BLOCKED（1）

- `compat-drift`：要求 `.research/protocol/contracts.json`。用 alpha.2 树（含完整 `tmp/…/alpha-tree` 一份）跑
  `node tools/protocol-contract.mjs --json …` 生成结果是 **0 个 endpoint**（alpha.2 的端点声明/扫描形态变化，生成器未适配）
  ⇒ 无法做漂移比对。**不影响运行**，列为后续工具任务（修 generator → 重新生成 → 更新 compat 能力矩阵）。

### 2.4 SKIP（1）

- `check-dshm-installer.cjs`：中段要访问 GitHub（本机沙箱会卡 codeload），按 docs/120 约定跳过；安装器主逻辑已由
  `check-dshm-uninstall`（47 断言）/`check-dshm-boot-check`（35 断言）/真机实测覆盖。

## 三、HAP 产物核验

| 项 | 读数 |
|---|---|
| HAP | 341,046,818 B，sha256 `7799096435992af1a46a8d3c68e5c60a6fe39fdf61aed31640395817315585d0` |
| HAP 内 core | `resources/resfile/dsh-core-0.2.2-alpha.2+whale.1-openharmony-arm64.zip` 108,789,837 B，sha256 `d0068f24…`（与 `entry/src/main/resources/resfile/` 逐字节一致） |
| libnode | HAP 内 121,501,784 B（源 `entry/libs/.../libnode.so.137` 121,510,116 B；打包会去掉 `.codesign`，dynsym 数量一致 44598） |
| libdshhost | 135,592 B（CMake 用 Node 24.21 头文件重编） |
| 安装 | `hdc install -r` 成功；系统验签通过（`hap-sign-tool verify-app` 的 CLI 参数形态怪异，未作为判定依据，设备安装是更强证据） |
| 核心树 | 解包 355.8 MB / 40,718 文件；分发包 103.8 MB / 46,272 条目 |

体积对比：rc.2 调试 HAP 331,508,315 B → alpha.2 341,046,818 B（**+9,538,503 B / +2.9%**），与 core zip 增大（99.2→108.8 MB）一致。

## 四、遗留（Phase 4 之后）

1. **修 `tools/protocol-contract.mjs`**：适配 alpha.2 的端点声明形态，生成 contracts 后重跑 `compat-drift`，再更新 `tools/gen-compat-endpoints.mjs` 的能力映射与 `CompatIndex.ets` 支持矩阵（若确有漂移）。
2. HAP 签名校验可补一条本地命令（或直接用设备安装结果）。
3. `check-dshm-installer` 网络段留待有代理环境时补跑。

## 五、Phase 5 待做

- **系统重启一次**后再启动新 Whale（alpha.2 + Node 24.21 的冷启动门槛）；
- 长会话、多子代理（Agent Teams）、插件市场/终端/文件等真实使用稳定性；
- 观察 token/缓存命中（stats 视图）与启动耗时。
