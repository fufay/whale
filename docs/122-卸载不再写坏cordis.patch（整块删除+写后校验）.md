# 卸载不再写坏 `cordis.patch.yml`：整块删除 + 写后校验（含启动期加固）

> 2026-10-24 ｜ 规格：`DSHM问题汇总与解决/DSHM-修复方案-插件卸载写坏overlay与启动加固.md`
> 代码：`hostcore/app/dshm-installer.js`、`hostcore/app/dshm-yaml-check.js`（新）、`hostcore/app/main.js`
> 门禁：`tools/check-dshm-uninstall.cjs`（**零网络**，每次必跑）、`tools/check-dshm-boot-check.cjs`（B，需核心树种子）
> 产物：HAP `336,845,413 B` / sha256 `cdbcba32e779cec7db4721a80407ac68a154d96c813045d6693dd7001ec300f8`
> （2026-10-24 13:56 构建；已解包核验 7 个 app 文件与源码逐字节一致、核心 zip sha256 未变）
> 状态：**A（写入器根治）已落地**（A1 `7862abb` / A2 `0ca890f` / A3 `33177b2`）；**B1（检查/修复模块 + 零网络门禁）已落地**；**B2（接进 `ensureProfile`）已落地**；**已出 HAP，装机冒烟通过（2026-10-24 14:24）**，见 §六。

## 一、修什么（三次同形事故）

卸载市场插件后 `profiles/ondevice/cordis.patch.yml` 会留下"无头"子键块——10-08（残留
`disabled: true`）、10-09（残留 `config:` 块）、10-24（残留 `config: profile: ondevice`）。
严格 YAML 解析报 `duplicated mapping key` ⇒ 下次启动 `BOOT_40_PROFILE_BOOT` fatal；而卸载
回执一直是 `ok:true`。

**根因只有一处**：`removeSpecInner` 第 4 步按**文本行**过滤（`patch.split('\n').filter(...)`），
只删 `- id:` / `name:` 两行，把 `config:` / `disabled:` 等子键留在原地。同文件第 3 步反而是
"删整块"的正确语义——第 4 步是漏网的那个。官方 desktop 的 plugin-manager 卸载根本不碰
overlay（`removeBundle` = 取消选择 → `pnpm remove` → reload），所以这是 DSHM/Whale 移植层缺陷。

## 二、A 的落地内容

### A1 `removeRowBlocks(text, {ids, suffixes})`（`7862abb`）

- 命中身份行（`- id:` / `- name:` / 直接子键 `name:`）→ **回溯 row 起点 → 整块删除**
  （含缩进子键、嵌套子行、块内空行/注释）；`config:`/`insert:` 内部更深缩进的
  `id:`/`name:` **不参与匹配**（防误删）。
- 保留原行尾风格（`\n` / `\r\n` 混排按行原样保留）；未命中内容**逐字节不变**；
  无命中返回原文（调用方据此不写盘）。
- `- insert:` 容器**因本次删除**变空才回收（否则 insert 变 null）。
- `&path:` 皮肤后缀匹配沿用旧实现词边界规则（语义不回退；规格 §A2 #7 与它自己的分隔符
  规则互斥，已按旧语义实现并在门禁注明）。

### A2 接线 `removeSpecInner` + 严格校验器（`0ca890f`）

- 第 3 步（`.dshm-plugin-rows.yml`）与第 4 步（`cordis.patch.yml`）统一用 `removeRowBlocks`；
  第 4 步旧的 `split('\n').filter(...)` 整段删除；两个旧 helper（`removeRowBlockById` /
  `…Suffix`）一并删除（"同一语义两份实现"正是事故配方）。
- 写盘三条纪律：**命中才写**；写前 `.bak-uninstall-<ts>` 备份 + 同目录临时文件原子 rename；
  **写后用与 boot 同源的严格解析器校验**，失败立刻回滚并返回 `ok:false`。
- 新增第 5 步：`ensureMarketRows` 清市场托管行（包不在 ⇒ 删 `.dshm-market-rows.yml`）。
- `main.js` 的 `instOpts` 增加 `coreDir: CORE_DIR`。
- 新模块 `hostcore/app/dshm-yaml-check.js`：解析器来源 `coreDir` → `$DSH_HOME/../cores/*`
  扫描 → 内置重复键检测器兜底；**不新增运行时 npm 依赖**（防重演 10-23 依赖覆盖）。
  同模块提供 `writeFileAtomicSync` / `backupFileSync` / `pruneBackupsSync`（保留 10 份）。
- 装配：`tools/place-host-app.mjs` 与 `tools/assert-resfile-sync.mjs` 的文件清单都加入
  `dshm-yaml-check.js`（**漏了它卸载器直接 MODULE_NOT_FOUND**）。

### A3 `package.json` 写盘加固（本批）

- `mergeDependencies` / `appendProfileBundle`：写前 `JSON.parse` 校验 + 原子写（保留权限位）。
- `mergeDependencies` 遇到**已存在的坏 JSON**：先留档 `.bak-invalid-<ts>` 再写，**绝不静默覆盖**
  （旧实现会直接写成 `{}`，等于抹掉依赖/配置）；备份失败则抛错（宁可安装失败，不可毁数据）。
- `appendProfileBundle` 遇坏文件维持"不写、返回 false"（交给 B/卸载器处理，不顺手抹掉）。

## 三、验证（`node tools/check-dshm-uninstall.cjs`，零网络）

**47 断言全过**，覆盖：

1. §1 `removeRowBlocks` 16 条边界（规格 14 条 + 后缀语义 2 条）；
2. §2 历史事故 fixture：10-08 / 10-09 坏文件确实判坏、修复后可解析；**前态重建测试**
   （干净文件 + 还原被删插件那一行 → 整块删除 → **逐字节**回到干净文件）；10-24 现场
   （只剩孤儿块、无身份行）确认只能由 B 修；
3. §3 `removeSpec` 集成（临时 profile）：整块消失、其它行逐字节保留、写后严格解析、备份存在、
   `package.json` 依赖/bundles 摘名、二次卸载幂等且 mtime 不动；
4. §4 注入写坏 ⇒ `ok:false` + 文件逐字节回滚 + 备份存在；
5. §5 **负测试**：自动从 git 历史取改动前版本（`7862abb`）跑同一 fixture ⇒ 旧代码
   `ok:true` 却留下孤儿、严格解析失败（门禁有牙）；
6. §6 `package.json` 写盘加固（原子写无 `.tmp-*`、权限位保留、坏文件留档、bundle 幂等）。

回归：10-23 依赖冲突修复 11/11 PASS（`installSpecInner` 未动）；`assert-resfile-sync` 15 件同步。

## 四、已知边界（如实记录）

1. **已坏的孤儿块修不了**：身份行已被旧逻辑删掉，无法按身份定位 ⇒ 由 B（启动期检查）兜底；
   A 只保证"不再产生"。
2. **`PluginRows.ets` 启停丢字段**：原生插件页启停只写 `id + disabled`，会丢用户行里的
   `config:` 等未知字段。不致命（YAML 仍合法），本轮按规格只记"已知限制"；后续可选修法：
   保留未知原始行。
3. **后缀匹配的口径**：规格 §A2 #7 写"`link` 不命中 `orca-link`"，但它自己给的分隔符规则
   （`-`/`/`/`@`）下必然命中；本实现选"不回退既有语义"（旧 `removeRowBlockByIdSuffix` 行为）。
   真正防误删靠"候选名只来自本次卸载的 spec / 已装 manifest"。
4. A 不负责：插件**运行期 import** 失败、核心种子/HAP 资源损坏、boot 阶段联网修复——那是 B
   的"只报告/降级"或本来就修不了的范围。

## 四之二、装机回归（2026-10-24 14:0x，B 的 carried 判据太窄）

**用户实报**：装完第一版新 HAP 后，**每次启动都回到「欢迎使用 DeepSeek Harness / 开始设置」**。

**日志证据**（`$HOME/dshm-host.log`，每次 boot 一行）：

```text
启动检查：剔除 3 条坏 carried 条目：ui-settings-account(name 不可解析：node_modules/@deepseek-ai/dsh-client-ui-settings-account/package.json 不存在)；…
profile 启动检查：repaired；动作：cordis.patch.yml(carried):drop-bad-carried
```

**根因**：B 的 carried 校验用 `userRowLoadable(profileDir, name)`——只看 **profile** 的
`node_modules`。而设置页写进 patch 的 carried 条目（`agent-default-model` / `ui-settings*` /
`ui-chat` / `llm-deepseek` / `ui-theme`…）的 `name` 指向的是**核心树**里的包
（`CORE_DIR/node_modules/@deepseek-ai/...`），profile 里本来就没有 ⇒ 每次启动都被当"坏条目"
剔掉 ⇒ 模型/界面设置丢失 ⇒ Web UI 退回首次设置向导。

**修法**：`resolveCarriedName()` 按"profile `node_modules` + **核心树 `node_modules`**"两个锚点判可解析
（与启动期 `sanitizeDependencies(anchorDirs=[CORE_DIR/node_modules])` 同源；`coreDir` 未传时扫
`$DSH_HOME/../cores/*` 取最新一份）。门禁新增 **§3b2**：carried 指向核心树包时必须 `mode=clean` 且
条目保留（旧实现会让这条断言红）。用修复前备份 patch 做 boot 模拟：`mode=clean`、6 条设置全在。

**善后**：已从 `$DSH_HOME/.profile-guard/20261024-140304-59240/cordis.patch.yml`（首次 repaired 前的
备份）把丢失的 3 条设置（`agent-default-model` / `llm-deepseek` / `ui-theme`）写回当前 profile patch
（另有 `.bak-restore-settings-*` 备份；其余 3 条本就在）。装修正后的 HAP 重启时，它们会按正常
carried 语义恢复进最终 patch，**不需要重新做设置向导**。

### 装机验证（2026-10-24 14:24，用户冒烟通过）

- 实际安装版本：`584267f2…`（设备侧 `dshm-profile-check.js` 与源码**逐字节一致**）；
- 最近一次 boot：`启动检查：诊断 2 条（不影响启动）`——`entry id 重复`（profile 与 bundle
  同名覆盖，属合法语义，只报告不修），**没有 `repaired`**；
- `profile-guard.mjs --check`（在应用内、用正确 `DSH_HOME` 跑）：解析通过、全部健康；
- 6 条设置 carried 条目（`agent-default-model` / `llm-deepseek` / `ui-theme` / `ui-chat` /
  `ui-settings` / `ui-settings-account`）均在。
- 遗留小尾巴：`clean` 启动不写 `.dshm-boot-check.json`，旧的非 clean 记录会残留（本次手工清理）；
  代码侧可选改进：`clean` 时删除陈旧 boot-check。

## 五、回退

- 代码：按提交 `git revert` A1/A2/A3 任一阶段即可（门禁会跟着回退）。
- 产物：旧 HAP 回退件 `dist/rollback/whale-rc.2-before-uninstallfix-signed.hap`（本轮构建前的已装版本，
  `336,800,119 B` / sha256 `facde72d…`）；再旧一份 `dist/sideload/whale-rc.2-installer-nested-signed.hap`。
- 新 HAP 另存 `dist/sideload/whale-rc.2-uninstallfix-signed.hap`（含 `SHA256SUMS`）。
- 数据：卸载备份 `.bak-uninstall-*`（保留 10 份）、损坏文件留档 `.bak-invalid-*`，都可手工恢复；
  B 落地后另有 `$DSH_HOME/.profile-guard/<ts>/` 全量备份。

## 六、B（启动期检查 + 自动修复）

### B1 已落地（本批）

- 新模块 `hostcore/app/dshm-profile-check.js`：`verifyAndRepair(profileDir, homeDir, opts)`
  → `{mode: clean|repaired|safe-mode|fatal, reason?, actions, diagnostics}`。
  - 检查面：最终 `cordis.patch.yml`、`.dshm-plugin-rows.yml`（逐块）、carried 条目（逐条 +
    `name` 可解析）、home 层 patch、`package.json`（JSON + bundles 去重）、`cordis.yml`（存在才查）、
    核心种子；诊断面：跨 bundle 重复 entry id、依赖版本告警（只报告不修）。
  - 修复阶梯：L0 全绿**零写入**；L1 源级修复（sidecar 坏块剔除并写回 / carried 剔除 /
    home patch 改名隔离 / package.json 种子重建 / bundles 去重，先备份到
    `$DSH_HOME/.profile-guard/<ts>/`，然后**从核心种子重放 composeUserRows** 并严格 parse）；
    L2 纯种子 safe-mode（隔离用户行/市场行、丢弃 carried、写 `.dshm-boot-check.json`，
    **不写 boot-failed**）；L3 才 `fatal`。检查器自身异常也走 L2（同样隔离行文件）。
- 新门禁 `tools/check-dshm-boot-check.cjs`（零网络，需要核心树种子；干净克隆整份 SKIP）：
  **29 断言**——§1 纯函数（切块/切条目/取键/片段解析）、§2 L0 clean 零写入（内容+mtime+不写 boot-check）、
  §3 L1 四类坏输入（sidecar 重复键 / carried name 不存在 / home patch 语法坏 / package.json JSON 坏）、
  §4 L1 修复动作异常 ⇒ safe-mode（隔离用户行、patch 可解析、写 boot-check、不写 boot-failed）、
  §5 种子坏 ⇒ fatal、§6 负测试（坏 overlay 没有检查器时确实无法解析）。

### B2 已落地（本批）

`main.js` 的 `ensureProfile()` 在 `quarantineBrokenPackages`/`cleanupQuarantineResidue` 之后、
`log('profile 已就位')` 之前调用 `verifyAndRepair`：

- `fatal` ⇒ `fail()`（检查器失败必须显式报错，不静默继续）；
- `repaired`/`safe-mode` ⇒ 一行日志（含 mode/reason/actions），并已写 `.dshm-boot-check.json`；
- 健康路径**零写入**；
- **延迟 require + try/catch**：检查器自身缺文件/异常降级为"不检查"，绝不反过来把启动搞挂；
- `depDiagnostics: false`：唯一要 `require` 安装器的检查项在 boot 期关闭（冷启动不为此变慢），
  依赖体检仍由每次安装后的 `depWarnings` 负责。
- 门禁 §7 用静态断言钉住接线位置与兜底语义（模块存在但没接进 ensureProfile 不能静默过关）。
