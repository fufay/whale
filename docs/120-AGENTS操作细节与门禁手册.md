# 120 · AGENTS 操作细节与门禁手册

> 本文是 `AGENTS.md` 的**操作细节附录**：AGENTS 只留稳定规则，完整门禁、端侧读数细节、出包坑在这里。
> 涉及真机前先读 `AGENTS.md` 的最高优先级；当前状态看 `HANDOFF.md`；决策看 `DECISIONS.md`。
> 最后更新：2026-10-22（与 AGENTS 拆分同轮）

---

## 1. 完整门禁清单

> 干净克隆没有核心树（`entry/src/main/resources/resfile/*.zip` 不入库，见 `.gitignore`），
> 需要核心树/设备的门禁会以 **exit 2/3** 结束，**不是通过**。
> 原先的 GitHub CI 已删除（`DECISIONS.md` D-006），本清单用于本地跑。

```sh
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-parity.mjs
node tools/compat-drift.mjs
node tools/assert-exec-fix.mjs
node tools/assert-python-bridge.mjs
node tools/assert-fs-search-fallback.mjs
node tools/check-web-fetch-jitless.mjs       # jitless 下 web_fetch 真的能抓网页（带对照臂）
node tools/check-worker-jitless.mjs          # 插件自建 worker 线程也要拿到 jitless 补齐（带对照臂）
node tools/check-internal-undici.mjs         # Node 内部 require 的内建 undici 必须被纯 JS 垫片接管（带对照臂）
node tools/check-fetch-shim.cjs              # 垫片自身（含请求方向流式体 + “吞体旧实现必须判红”对照臂）
node tools/check-skill-sync.cjs              # 内置技能同步（判据是内容 sha256，不是字节数）
node tools/check-ptc-ts-strip.mjs            # PTC 的纯 JS erasable-TS 擦除器
node tools/check-ptc-runtime-inproc.mjs      # PTC 同进程运行时契约
node tools/check-ptc-wiring.mjs              # PTC 换实现接线：profile ↔ pack-core ↔ 核心树
node tools/check-core-openharmony-patches.mjs # 核心树端侧注入补丁都在、上游原文已消失
node tools/check-decor-button-mode.mjs       # 顶栏底色 ↔ 窗口三键配色接线
node tools/check-market-bridge.mjs           # 手机档市场进程内包通道
node tools/check-profile-pnpm-bridge.mjs     # 手持档 profile 安装/卸载进程内包通道
node tools/check-dshm-uninstall.cjs           # 卸载不再写坏 overlay（零网络；整块删除/回滚/负测试，47 断言）
node tools/check-dshm-boot-check.cjs          # 启动期 profile 检查/修复（零网络；需核心树种子，无则整份 SKIP，33 断言）
node tools/check-dshm-installer.cjs           # 插件安装器（含 10-23 冲突嵌套；前段需网络，沙箱会卡在 GitHub 段）
node tools/check-denial-hints.mjs            # errno 人话化 + 三个调用点接线
node tools/check-fs-local-permission.mjs     # 核心树 dsh-fs-local 权限分支真跑（需核心树）
node tools/assert-core-entrypoints.mjs       # 裁剪后核心树入口可达性（需核心树）
node tools/check-resfile-core-zip.mjs        # resfile 只 1 份核心容器 / sha256 一致
node tools/check-tar-extract.mjs             # 进程内 tar.gz 解包（含负测试）
node tools/check-workspace-claim.mjs         # 默认工作区登记收窄
node tools/arch-check.mjs                    # 上游知识只允许在 dshcompat
node tools/check-doc-refs.mjs                # 文档引用
node tools/check-dead-code.mjs               # 死代码
node tools/check-plugin-toggle.mjs           # 插件启停（需核心树）
node tools/check-native-closure.mjs          # 原生闭包（需核心树 + entry/libs）
.\tools\device-acceptance.ps1                 # 真机端侧验收（只读，不进 CI）
.\tools\device-code-fingerprint.ps1           # 设备核心树 5 个关键文件 ↔ 本机树逐字节 sha256（只读）
```

### 1.1 门禁的分类

- **只需仓库内文件**（本地随时可跑）：`assert-cli-shim`、`assert-resfile-sync`（先跑 `tools/place-host-app.mjs`）、
  `check-parity`、`assert-exec-fix`、`assert-python-bridge`、`check-doc-refs`、`check-dead-code`、
  `check-decor-button-mode`、`check-skill-sync.cjs`、`check-ptc-ts-strip`、`check-internal-undici`、
  `check-worker-jitless`、`check-market-bridge`、`check-profile-pnpm-bridge`、`check-denial-hints`、
  `check-fetch-shim.cjs`、`check-tar-extract`、`check-resfile-core-zip`（需 resfile 产物）、
  `check-workspace-claim`、`arch-check`。
- **需要核心树**（`dist/core/work/dsh-core-<ver>/`，由随包 zip 解出）：`compat-drift`（还要 `.research/`）、
  `assert-fs-search-fallback`、`check-web-fetch-jitless`、`check-ptc-runtime-inproc`、`check-ptc-wiring`、
  `check-core-openharmony-patches`、`check-plugin-toggle`、`check-native-closure`（还要 `entry/libs`）、
  `check-fs-local-permission`、`assert-core-entrypoints`。
- **需要真机 / DevEco**：`device-acceptance.ps1`、`device-code-fingerprint.ps1`（都只读、不装不卸）。

> 门禁必须经**注入式负测试**验证真的会失败；否则视为没有门禁。`check-*` 里带 `--self-test` 的按脚本头注释跑。

---

## 2. 出包 / 核心树 / resfile

1. **出包必须带 `--place-in-app`**：
   `node tools/pack-core.mjs --place-in-app` 才会把核心容器拷进 `entry/src/main/resources/resfile/`。
   裸跑 ⇒ 新包留在 `dist/core/`，HAP 继续带旧容器；链上自检只看设备树目录名，会一路绿灯。
   出包后跑 `node tools/check-resfile-core-zip.mjs`：断言 resfile 只有 1 份容器，且文件名/大小/sha256 与配方、产出三者一致。
2. **`dist/core/work/<ver>` 复用会静默跳过补丁**：目录已存在（含上次打过的补丁）时，新注入命中“已存在（跳过）”。
   改完 `pack-core` 注入后，要么删该目录（构建产物，允许清理），要么升 `coreVersion`。
3. **resfile 只允许 1 份核心容器**：`--place-in-app` 只增不删；多份会把 HAP 撑大。
   `pack-core` 已自动清非当前版本，并有 `check-resfile-core-zip` 兜底。
4. **裸跑工具会制造“树/交付物不一致”**（`docs/116` §9）：
   - 裸跑 `tools/pack-core.mjs` 会重盖树内 `dshm-core.json` 的 `builtAt`，导致 `dist/core` 容器 sha 变、resfile 没变；
   - 裸跑 `tools/place-toolchain.mjs` 会把 resfile 的 `.apk`/`.tar.gz` 重新 gzip（只有 gzip 头 MTIME 变）。
   两条都按“从 resfile / 已装 HAP 逐字节还原”复原，并复跑 `check-resfile-core-zip`。
5. **清 `dist/core`**：保留当前容器的判据用完整文件名前缀 `dsh-core-<version>-`，不要用“版本号 + 点”。
   误删可从已装 HAP 的 `resources/resfile/dsh-core-*.zip` 逐字节恢复；清前/清后都跑 `check-resfile-core-zip.mjs`。
6. **清 `dist/core/work/<old>` 后**，`entry/.cxx` 的 ninja 缓存可能引用已删路径 ⇒ 下一次构建首次失败；顺手清 `entry/.cxx`。

### 2.1 `coreVersion` 口径

- 格式：`<上游版本>+whale.<n>`；`+whale.<n>` 是 semver build metadata，不参与优先级比较，纯给人读。
- 端侧目录 `dshm/cores/<version>` 与自检输出 `OK 核心树 <version> 在` 用来判断设备跑哪版。
- **核心树内容一变就必须递增 `<n>`**（补丁增删、插件副本、版本号），否则设备不换树、`pack-core` 不重新物化。
- **当前值以 `hostcore/core-recipe.json` 为准**。截至 2026-10-22 读数 `0.2.1-rc.2+whale.2`；
  `README.md` 顶部 `+whale.1` 与 `docs/117` 的 `+whale.7` 是历史口径，待统一（见 `HANDOFF.md` §3）。
- 历史各 `+whale.n` 的动机分散在 `docs/107`–`docs/116` 等专题，不在 AGENTS 里重复。

---

## 3. 端侧读数 / 日志 / token / RPC

### 3.1 真机读数坑

1. **`ps` 的 STIME 不可信**：本机实测比真实本地时间慢 3h52m45s（同一进程：
   `stat -c %y /proc/<pid>` 得 16:30:41，`ps -ef` 的 STIME 显示 12:37:56）。
   进程何时启动一律用 `stat -c '%y' /proc/<pid>`。
2. **`bm dump` 的 stdout 不能在设备侧重定向**：`bm dump -n X > f` 得 0 字节、stderr 空、退出码 0。
   必须在宿主侧用 Node `spawnSync` 拿 Buffer（避免 PowerShell GBK 往返）。
   持久 hilog（`/data/log/hilog/hilog.*.gz`，shell 可读）里 tag 首段就是进程名，可查“某应用跑过没/跑在哪个进程”。
3. **含 NUL 的日志行**：`/proc/self/attr/current` 尾部带 `\0`；JS 的 `\s` 不匹配 `\u0000`。
   设备侧 grep 把 NUL 当行尾 ⇒ 行看起来被截断、`grep -c` 静默少算。
   ⇒ 日志用 `hdc file recv` 取回宿主按字节看；代码侧对读到的字段 `.split('\u0000').join('')`。
4. **el2 的 `home` 是 0700** ⇒ shell 读不到 `host-ready.json`；要读走应用自身 Python 桥或宿主 RPC。

### 3.2 日志 / token

- **插件 `console.log` 落 `node-output.log`，不是 `dshm-host.log`**。后者只收 `main.js` 的 `diag()`；
  `node-output.log` 是进程 stdout 转写（每次启动轮转、权限 `-rw-rw-rw-`，`hdc file recv` 可读）。
- **宿主 token 在 `node-output.log`**：`dsh web: http://127.0.0.1:3120/?token=…` 那一行。
  `dshm-host.log` 里的 `token=` 全是探针自己发出去的请求 ⇒ 会拿到上一次进程的陈旧 token（桥回 401）。
  token 每次进程启动都换，取 `node-output.log` 里**最后一条** `dsh web:`。
- **读 0700 的 `dsh/home`**（含 `storages/workspace.json`）：只能经应用自身 Python 桥：
  `hdc fport tcp:<宿主端口> tcp:3120`，再
  `GET /dshm-python/run-get?token=<上式取的>&code=<urlencoded python>`（≤64KB）。
  先 `hdc fport ls` 看实际映射；端口被占时 `hdc fport` 会失败而旧转发仍在。
- **读宿主状态首选宿主 RPC（不过 Python 桥，手持档也能用）**：
  先 `GET /?token=<宿主 token>` 拿 `dsh-auth-*` cookie（303 的 `Set-Cookie`；不带 cookie 的 `/api/*` 一律 401），
  再 `POST /api/<namespace>/<method>`，body =
  `{"type":"client-request","rpcId":"…","method":"<namespace>/<method>","payload":{"args":{…}}}`。
  例：`POST /api/session/list`、args `{"_request":{}}` ⇒ `items[].cwd`。
  注意 `mode:'stream'` 的方法（如 `workspace/follow`）走不了网关，会回
  `stream Remote methods must be opened through the stream carrier`。

### 3.3 其它已踩坑

- **Node 读 git 历史不要用 `execSync('git show HEAD^:…')`**：Windows 经 `cmd.exe`，`^` 被吃成 `HEAD:`
  （索引版），会静默返回暂存后内容。用 `execFileSync('git', ['show','HEAD~1:path'])` 或 `spawnSync`。
- **代理通/不通是动态的**：同一天可能“绕代理成功/走代理成功”两种相反结果；失败时两种都试一次并贴原始报错，
  不要把临时结论写进 git 配置。
- **提交卫生**：等长替换可能因文件 size 不变被 git stat 缓存当成“未改”；
  提交前用 `git status` + `git diff --cached --stat` 核对暂存内容。
- **调试 HAP 的 `module.json` 天生 `buildMode=debug`**；上架看 `09` 的 `.app`（`release/false`）。

---

## 4. 工程约束补充

- 核心树只认 `dist/core/work/dsh-core-<ver>` 与 profile 依赖树；HAP 生成的 `files/bin/*`、
  `profiles/*/cordis.patch.yml` 会被重建 ⇒ 修复落在 `tools/pack-core.mjs`、`tools/place-toolchain.mjs`、
  `hostcore/app/*`、`hostruntime/*`。
- Windows tar 会破坏 symlink（`bsdtar` 丢弃、`7z` 物化）⇒ 只允许 Python `tarfile`。
- 所有沙箱内 ELF 必须**构建期自签名**（execve 受签名域管辖）。
- 改 `hostcore/**` 后必须跑 `node tools/place-host-app.mjs`，并确认 `assert-resfile-sync` 通过。
- 上游知识只允许出现在 `dshcompat` 模块（`tools/arch-check.mjs` 强制）。
- 统计实测数据前先定口径；不要按通用字段名猜事件类型（曾虚增 4 种事件类型）。
- 门禁“通过”不等于“覆盖到了”；新增上游名词（端点/事件/命名空间）时问一句“门禁认识它吗”。

---

## 5. 维护

- 本文件只放**操作细节/门禁/读数坑**；稳定规则回 `AGENTS.md`，当前状态回 `HANDOFF.md`，决策回 `DECISIONS.md`。
- 新增门禁时同步 §1 清单与分类（是否需要核心树/设备）。
- 新增端侧读数坑时，先写“判据/命令”，再写“症状”，避免只留故事。
