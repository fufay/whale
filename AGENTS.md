# AGENTS.md — Whale 移植工作约束

> 本文件给自动化助手/AI 的**稳定规则**。开工先读：**`HANDOFF.md`（当前状态）→ 本文件（约束）→ `docs/README.md`（细节索引）**。
> 关键决策的来龙去脉在 `DECISIONS.md`；操作细节/完整门禁在 `docs/120-AGENTS操作细节与门禁手册.md`。
> **违反本文件的规则可能造成不可逆损失**。

---

## 🔴 最高优先级：真机数据与签名物料

**一律覆盖安装；绝对禁止删除真机用户数据或签名物料。**

```powershell
hdc install -r <hap>        # ✅ 同签名覆盖：只换 el1 代码/资源，不动 el2 用户数据
hdc uninstall ...           # ⛔ 默认禁止（会删 el2 会话/插件/工作区）
bm uninstall ...            # ⛔ 默认禁止
rm -rf /data/app/el2/...    # ⛔ 禁止
Remove-Item ...\.ohos       # ⛔ 禁止（签名私钥只此一份）
```

- **判断依据**：`/data/app/el1/...` = 代码资源，覆盖安装会换，安全；`/data/app/el2/...` = **用户数据**，删除不可逆。
- **唯一例外**：用户明确说“全部清掉/重新装”；或换签名导致覆盖安装失败时用 `hdc uninstall -k`，且必须**先问用户**、卸完立即验证数据仍在。
- 真实事故与恢复方法：`docs/80-真机更新与数据保全.md` §7；签名备份在仓库外 `D:\DSHM-signing-backup\`。
- **清理环境**只删构建产物（`entry/build/**`、`dist/core/work/**`、日志），**永远不动** `~/.ohos`、`~/.dsh`、el2。

---

## 回归纪律

1. 改动前先跑基线并记录；改动后跑同一批，任何 `ok → fail` 当场修，不许延后。
2. 临时实验必须在**同一次改动内还原**，结论写进代码注释，不留下实验代码。
3. **“CI 绿”不等于“全绿”**：干净克隆没有核心树（`resfile/*.zip` 不入库），需要核心树/真机的门禁会 exit 2/3，**不是通过**。
4. 完整门禁清单、哪些需要核心树/设备、以及负控制要求：见 `docs/120`。
5. 常用入口（完整列表在 docs/120）：
   ```sh
   node tools/check-parity.mjs
   node tools/check-core-openharmony-patches.mjs
   node tools/check-resfile-core-zip.mjs
   node tools/assert-core-entrypoints.mjs
   node tools/assert-cli-shim.mjs
   node tools/assert-resfile-sync.mjs
   node tools/check-fetch-shim.cjs
   ```

---

## 运行时 / 启动路径：实验转正门槛

> 2026-10-27 JIT 误判事故的教训（复盘见 `docs/123`、决策 `DECISIONS.md` D-010）：
> debug 签名包去掉 `--jitless` 后 JIT 能跑、参数/smaps/WASM 都能“自证”，于是被当成能力已获批；
> 但**系统重启后** Host/V8 初始化直接崩溃、白屏闪崩。已回退默认 jitless。

1. **默认值必须安全**：启动/运行时相关默认值（argv、jitless、签名、沙箱等）不为实验收益让步；
   实验一律显式 opt-in，不默认开启。
2. **转正前必须过“系统重启”**：装 → 重启应用 → **系统重启** → 再启动，全链路稳定才算通过；
   只验证“重启应用”不够。
3. **权限/能力类结论必须有权威读数**（如 `checkAccessToken`）**+ 跨重启稳定性**；
   与读数矛盾的“实证”（能跑/有映射/有脏页）不是结论，先解释矛盾再下判断。
4. **与强先验冲突时，先假设自己的观测有边界条件**（大厂安全平台 + 公开 ACL 机制 ⇒ 先怀疑实验缺环节），
   设计证伪实验，而不是堆更多日志说服自己。
5. **出包/装机前先说清后果与回退路径**；用户表达怀疑时把怀疑当证据，先停下来设计验证。

---

## 产物 / 文档归置

| 类型 | 位置 | 说明 |
|---|---|---|
| 构建产物 | `entry/build/default/outputs/default/` | 会被 clean 覆盖，**不要当交付物留档** |
| 交付/侧载包 | `dist/sideload/` | 不会被构建清掉；含 README + SHA256SUMS |
| 文档 | `docs/` | 编号连续；**索引以 `docs/README.md` 为准**；当前最新为 `137` |
| 交接状态 | `HANDOFF.md`（根目录） | 每次开工先读、收尾更新；只放 1–2 页当前状态 |
| 决策记录 | `DECISIONS.md` | 只追加“决定/原因/备选”，不写流水账 |
| 一次性排查脚本 | 用完即删 | 不留在 `tools/` |

- 新增文档：接着 `docs/` 最大编号；更新 `docs/README.md` 索引。
- 不要把“今天改了什么/下一步”写进本文件；那是 `HANDOFF.md` 的职责。

---

## 出包与本机验证（2026-11-12 定案：版本号规则 + 默认授权）

### 版本号规则（不再逐次讨论）

| 产物 | versionName | versionCode | 说明 |
|---|---|---|---|
| **发布件**（GitHub/AtomGit release） | `v1.1.N` | **`10100N`**（N 随版本递增：1.1.7→1010007） | 给用户侧载 / 用户自行从源码构建；**不上架、不 release 签名** |
| **本机验证件** | 跟随发布号（如 `1.1.8`） | **恒等于设备已装 versionCode** | 同一 versionCode 覆盖安装 ⇒ 不走 ACL 权限校验（无 ACL 调试 Profile 的硬限制，见 `docs/125` §八/§九） |

- 发布件版本号按上表**直接递增**，不再询问"用哪个号"；
- 本机验证件由 `tools/build-verify-hap.sh` 自动读设备已装 versionCode 生成，**不手填**。

### 本机验证装机 = 常规步骤，**默认授权**

- 允许：`hdc install -r` 装**本机验证件**（同 versionCode 调试包）、`hdc file recv`、`hdc shell` 只读查询、`hilog` 抓取。
- 仍需先问：**发布件上传**（GitHub/AtomGit release）、卸载/清数据、回滚版本、`rm -rf`/删除 el2 数据或签名物料。
- 一键流程（不再逐次请示）：

```sh
sh tools/build-verify-hap.sh                # 读设备已装号 → 出包 → 覆盖安装
sh tools/build-verify-hap.sh --wait-core 300 # 装完等你在设备上重启应用，脚本自动核对新核心树
```

> 装完**必须重启应用**：核心树在首启时解包（约 2–4 分钟），之后应用内「dsh 版本」才显示新 `coreVersion`。

### 发布件（侧载/自建）

- 发布件是**未签名 HAP**（`whale-unsigned.hap`）：用户用 hokit 自行签名侧载，或按 README §二自行构建；
- 构建机需要 `ohos-selfsign`（rg 自签名，见 `docs/135` §7）与 HarmonyOS SDK/Node 24；
- 本仓**不做 release 签名、不上架应用市场**（用户明确：仅本机自用 + 发布侧载包/源码）。

## 核心树 / 出包铁律

1. **出包必须带 `--place-in-app`**：`node tools/pack-core.mjs --place-in-app` 才会把核心容器放进
   `entry/src/main/resources/resfile/`；裸跑会让 HAP 继续带旧容器，核心树侧改动全部不生效。
   出包后跑 `node tools/check-resfile-core-zip.mjs`（断言只有 1 份容器、sha256 与配方/产出三者一致）。
2. **`dist/core/work/<ver>` 复用会静默跳过补丁**：目录已存在时注入会“已存在（跳过）”。
   改完 `pack-core` 注入后，要么删该目录（构建产物，可清），要么升 `coreVersion`。
3. **resfile 只允许 1 份核心容器**：多份会把 HAP 撑大；`pack-core` 已自动清非当前版本，门禁兜底。
4. **`coreVersion` 命名口径**：`<上游版本>+whale.<n>`，`+whale.<n>` 是 build metadata、纯给人读；
   **核心树内容一变就必须递增 `<n>`**（补丁增删、插件副本、版本号），否则设备不换树。
   **当前值以 `hostcore/core-recipe.json` 为准**（截至 2026-11-14 读数为 `0.2.2-rc.2+whale.2`）。
5. **清 `dist/core` 时保留当前容器**：判据用完整文件名前缀 `dsh-core-<version>-`，不要用“版本号 + 点”。
   误删可从已装 HAP 的 `resources/resfile/dsh-core-*.zip` 逐字节恢复；前后跑 `check-resfile-core-zip.mjs`。

---

## 端侧排障速查

- **`ps` 的 STIME 不可信**：进程启动时间用 `stat -c '%y' /proc/<pid>`。
- **`bm dump` 的 stdout 不能在设备侧重定向**：宿主侧 `spawnSync` 拿 Buffer；持久 hilog 的 tag 首段是进程名。
- **含 NUL 的日志**：设备侧 `grep` 会把 NUL 当行尾，`grep -c` 可能少算 ⇒ 用 `hdc file recv` 取回宿主按字节看；代码侧剔 NUL。
- **插件 `console.log` 落 `node-output.log`**，不是 `dshm-host.log`；宿主 token 取 `node-output.log` 里**最后一条** `dsh web:`（每次启动都换）。
- **读 0700 的 `dsh/home`**：走应用自身 Python 桥，或宿主 RPC（先 `GET /?token=` 拿 `dsh-auth-*` cookie，再 `POST /api/...`）；`mode:'stream'` 的方法走不了网关。
- **改 `hostcore/**` 后**必须跑 `node tools/place-host-app.mjs`，并确认 `assert-resfile-sync` 通过。
- **Windows tar 会破坏 symlink**（bsdtar 丢弃、7z 物化）⇒ 只用 Python `tarfile`。
- **沙箱内 ELF 必须构建期自签名**（execve 受签名域管辖）。
- 更细的读数坑、token 取法、RPC 例子：`docs/120` §3。

---

## 工程约束（简摘）

- 核心树只认 `dist/core/work/dsh-core-<ver>` 与 profile 依赖树；HAP 生成的 `files/bin/*`、
  `profiles/*/cordis.patch.yml` 会被重建 ⇒ 修复落在 `tools/pack-core.mjs`、`tools/place-toolchain.mjs`、
  `hostcore/app/*`、`hostruntime/*`。
- 上游知识只允许出现在 `dshcompat` 模块（由 `tools/arch-check.mjs` 强制）。
- 门禁必须经注入式负测试验证其真的会失败；否则视为没有门禁。
- 统计实测数据前先定口径；不要按通用字段名猜事件类型。
- 新增上游名词（端点/事件/命名空间）时，问一句“门禁认识它吗”。

---

## 会话与交接

- **开工**：读 `HANDOFF.md` + 本文件 + `git status` + `git log --oneline -20`；只做本次明确任务。
- **收尾**：更新 `HANDOFF.md`（完成/未完成/坑/下一步/验证命令），不要只写在聊天里。
- 一个工作单元一个会话；换主题或上下文过大时，先落盘 HANDOFF，再 `/compact` 或新开会话。
- 决策变更写 `DECISIONS.md`（日期/决定/原因/备选），不要只留在对话里。
- 本文件保持稳定；当前状态/下一步/临时结论不要写进来。

---

## 目录速览

| 路径 | 内容 |
|---|---|
| `entry/` | ArkTS 应用：WebView 宿主、桥、启动页、托盘 |
| `platform/` | 系统能力机制层 |
| `hostruntime/` | Node 运行时承载 |
| `hostcore/` | 核心树配方、自带插件、端侧 profile |
| `tools/` | 构建、pack-core、门禁、推送 |
| `docs/` | 文档索引 `docs/README.md`；最新 `137` |
| `hostkit/` | 可选 PC 侧搭桥（手机档远程 Host） |

## 维护

- 改本文件前先确认：这是**每会话都要知道**的稳定约束吗？否则放 `HANDOFF.md`/`DECISIONS.md`/`docs/`。
- 本文件目标 ≤15KB；当前约 8KB。新增内容优先放 `docs/120` 或 `DECISIONS.md`。
- 改完检查：`wc -c AGENTS.md`；与 `docs/README.md` 的链接是否仍有效。
