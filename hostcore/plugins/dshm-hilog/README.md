# dsh-hilog —— 让 agent 一次调用就能抓到鸿蒙 hilog

> 把「抓鸿蒙 hilog」从"给人点的侧边栏面板"变成 **agent 可直接调用的 DSH 工具**（纯 host 侧，无 Web UI）。
> 一句话：**AI 自己控级别、自己防 512KB 缓冲区滚掉、自己把设备状态还原。**

- 需求与实测依据：[开发需求文档.md](./开发需求文档.md)（全机实测过，本实现照它落地）
- 3 个工具：`hilog_level` / `hilog_dump` / `hilog_capture`
- 单测：**58 项，无需设备**（`node --test "tests/*.test.mjs"`）
- 真机验证：**§6.2 五项全通过**（只读，不做模拟用户操作；见下「验收记录」）

---

## 1. 三个工具

| 工具 | 干什么 | 关键保障 |
|---|---|---|
| `hilog_level` | 读 / 设 / 还原设备全局日志级别（`hilog.loggable.global`） | 默认 `set` **设完立即还原**；`keep:true` 才留在设备上，并记下原值供 `action:"restore"` 收尾 |
| `hilog_dump` | **非阻塞**取当前缓冲区（`hilog -x`），支持 tag/level/pid/domain/正则过滤 | 客户端截断（默认最近 200 条 + 32KB）；`save:true` 落盘给 `filePath`；级别比设备更啰嗦时给 `levelHint` |
| `hilog_capture` | 实时抓 N 秒（默认 15s） | **流式边读边收**（对抗 ~20s 就滚掉的 512KB 缓冲）；临时提级别 → 抓 → **try/finally 还原**；默认只留"本次调用之后"的新日志；默认落盘 |

### 典型用法（agent 视角）

```
hilog_level({action:"get"})                       → { level:"W", device:"127.0.0.1:45071", channel:"bridge" }
hilog_capture({seconds:15, tag:"MyAppTag"})        → 抓 15s，结束自动还原 W；返回 entries + filePath
hilog_dump({tag:"MyAppTag", lines:100, save:true}) → 缓冲区里已有的（不含新日志）
hilog_capture({seconds:30, level:"D", regex:"Exception|error"})  → 抓 D 级 + 正则过滤
```

### 为什么需要它（两个会咬人的设备默认值）

| 项 | 实测值 | 后果 |
|---|---|---|
| `hilog.loggable.global` | **`W`** | 应用的 `hilog.info()` 在进缓冲区**之前**就被丢弃 ⇒ 常被误判成"代码没跑" |
| app 日志缓冲区 | **512 KB** | 约 20 秒滚掉 ⇒ 事后翻不到，必须边跑边读/边落盘 |

⇒ `hilog_capture` 会先读旧级别、把设备级别提到 `level`（默认 `I`），抓完**无论成功/异常/被取消都还原**；
返回值里 `levelBefore / levelSet / levelAfter / restored` 可以直接核对（真机验证项 3）。

---

## 2. 安装（本机规矩）

```sh
# 0) 装前体检（本机有两次「profile 被写坏 ⇒ 应用起不来」的前科）
precheck

# 1) 从 profile 目录安装（★ 必须在 profile 目录执行）
cd $DSH_HOME/profiles/ondevice && pnpm add /storage/Users/currentUser/projects/DSH_Proj/Common/dsh-hilog

# 2) 装后复检 + 校验模块能被 profile 解析（起不来之前就能发现）
precheck
cd $DSH_HOME/profiles/ondevice && node -e "import('dsh-hilog').then(m=>console.log(m.name, Object.keys(m)))"

# 3) 重启 DSHM 应用（patchReload: startup ⇒ 不重启不挂载）
```

装完会多出 3 个工具：`hilog_level`、`hilog_dump`、`hilog_capture`。
本插件不依赖 `devecocli`、不注册任何 Web 路由、不改 profile 的其它行。

> **本机实测（2026-10-15）：DSHM 安装通道不接受本地目录。**
> `pnpm add /storage/…/Common/dsh-hilog` 会被宿主安装器拒掉：
> `{"ok":false,"error":"无法识别的插件标识：…（支持 npm 包名或 GitHub 仓库地址）"}`（**干净失败，未改 profile**）。
> 所以本机落地方案是"按安装器同样的落点手工落位"：
> 1. `cp -r` 插件到 `$DSH_HOME/profiles/ondevice/node_modules/dsh-hilog/`（只放 `lib/` + `package.json` + `cordis.patch.yml` + `README.md`）；
> 2. `$DSH_HOME/profiles/ondevice/package.json` 的 `dependencies` 加 `"dsh-hilog": "file:/storage/…/Common/dsh-hilog"`，
>    `dsh.profile.bundles` 末尾加 `"dsh-hilog"`；
> 3. `precheck` + `node -e "import('dsh-hilog')"`（在 profile 目录里）双校验 → 重启应用。
>
> **回滚**：删掉 `node_modules/dsh-hilog/`，把 `package.json` 还原成安装前备份
> （备份在 `Build/dsh-hilog/backup-profile/` 与本目录的 `package.json.bak-dsh-hilog-*`），`precheck` 即可。

---

## 3. 设备可达性：两条通道（插件自动探测，你不用告诉 AI 走哪条）

app 沙箱里 **USB 不可用**（`libusb: opendir devices failed, errno=13`）且自己起不了 hdc server，
所以插件只能连"**已经在 `hdc list targets` 里处于 Connected 的目标**"。两条通道：

| 通道 | 命令（可配） | 能看到谁 | 前置条件 |
|---|---|---|---|
| `bridge` | `Config.hdcCmd`，默认 `hdc`（本机是自动过桥转发器） | **无线调试**暴露的 TCP 目标（**本机 PC 自测走这条**） | 「设置 → 开发者选项 → 无线调试」开着（端口每次开关都会变，插件自动发现） |
| `via-host` | `Config.hdcCmdViaHost`，默认 `hdc-via-host.sh` | **USB 手机/平板**（借宿主 hdc server `127.0.0.1:18710`） | 宿主在跑 server：<br>`sh …/hdc-bridge/host-server-keepalive.sh --daemon`（或 `hdc kill; hdc -s 127.0.0.1:18710 start`） |

**探测规则**（`channel:"auto"` 默认）：

1. 先试 `bridge`；有**恰好一个** Connected 目标就用它，返回值 `channel:"bridge"`。
2. 没有 Connected、或调用方指定的 `device` 不在该通道里 ⇒ 自动改试 `via-host`。
3. 两条都没有 ⇒ 返回结构化失败：**逐通道 `list targets -v` 原文** + 桥/宿主的提示文案 + 明确指引
   （"请开无线调试" / "请在宿主跑保活脚本"）。**绝不静默空返回。**
4. 一条通道里有**多个** Connected 且没指定 `device` ⇒ **不猜**，列出候选让你指定（防止抓错设备）。

> 别指望插件自己起宿主 server：`sudo` 在沙箱里 `init challenge failed`，且看不到 USB、也起不了 server
> （三道墙，见需求文档 §4.3）。插件的能力上限是**探测通道 + 精确指引**。

---

## 4. 配置（`Config`，也是「设置」页里可改的字段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `hdcCmd` | `hdc` | bridge 通道命令 |
| `hdcCmdViaHost` | `sh …/hdc-bridge/hdc-via-host.sh` | via-host 通道命令（文件不存在时该通道自动跳过并给出原因） |
| `channel` | `auto` | `auto` / `bridge` / `via-host` |
| `device` | 空 | 缺省目标 key；空 = 自动挑唯一的 Connected |
| `level` | `I` | `hilog_capture` 默认抓取的最低级别 |
| `seconds` / `maxSeconds` | 15 / 120 | 默认与最大抓取秒数 |
| `maxLines` / `maxBytes` | 200 / 32768 | 返回值条数与字节上限（谁先到算谁） |
| `maxCaptureLines` | 2000 | `capture` 最多收集多少条**新日志**（抓够提前收手） |
| `pollMs` | 200 | 流式读取轮询间隔 |
| `timeoutMs` / `listTimeoutMs` | 30000 / 45000 | 单条命令超时 / `list targets` 超时（桥首次启动较慢） |
| `stdoutMaxBytes` | 8 MB | 单条命令输出缓冲上限（超出会标 `lossy` 并给 `spillPath`） |
| `outputDir` | 空 | 空 = `<会话工作区>/Build/dsh-hilog/logs` |
| `dumpSave` / `captureSave` | false / true | 默认是否落盘 |
| `sinceNow` | true | `capture` 只保留"本次调用开始之后"的日志（阻塞读会先吐缓冲区历史） |
| `sandboxMode` | `danger-full-access` | 交给 `ctx.shell` 的沙箱模式（hdc 要读写 `/data/...` 与桥缓存） |

---

## 5. 输出纪律（这条决定工具好不好用）

- 返回值**默认只回摘要 + 截断后的条目**（默认 200 条 / 32KB），完整日志落盘：
  `Build/dsh-hilog/logs/<YYYYMMDD-HHMMSS>-<dump|capture>[-<tag>].log`（工作区内，后续会话可读）。
- 返回值一定带 `totalEntries / returned / dropped / truncated / clampedByBytes / filePath / fileLines`，
  AI 一眼知道"还有多少没看、去哪看"。
- `entries` 是结构化的 `{time, level, pid, tid, domain, pkg, tag, msg}`；模型看到的是渲染后的可读文本。
- 落盘文件是**完整原始输出**（含被 `sinceNow` 过滤掉的历史行），文件头注明本次摘要口径。

---

## 6. 已知限制与坑（都是实测踩出来的）

1. **`-L` 是精确匹配**，`-L I` 只出 I（不含 W/E/F）；多级别必须逗号分隔（`-L D,I,W`）；
   `-L ^D` 取反被设备拒绝（`Invalid log level … [CODE: -2]`），尽管 `hilog -h` 写着支持。
   ⇒ 本插件把"`level` 及以上"展开成 `-L I,W,E,F`。
2. **`-x` 不能与 `-a`/`-z` 同用**（`Mutlti commands can't be used in combination [CODE: -31]`）
   ⇒ `hilog_dump` 取全缓冲区后在客户端截断。
3. **必须带 `-t`**：不带目标 key 的 `hdc shell` 会打到错误目标（实测 `errNum is:1002`）。
4. **`hdc-via-host.sh` 会往同一输出流插一行 `[hdc-tcp-shim] …`** ⇒ 已按前缀过滤，且不计入统计。
5. **默认级别 `W`**：`hilog_dump` 抓不到 I/D 是正常的（它们没进缓冲区），返回值会给 `levelHint` 指路
   ⇒ 要抓那些级别请用 `hilog_capture`。
6. **`capture` 的提前收手只数"新日志"**：阻塞读会先吐整个缓冲区历史（实测一次 2000+ 行），
   若不区分，工具会在第一条新日志出现前就收手（真机抓到过这个 bug，已修 + 有回归单测）。
7. **`sinceNow` 用设备时钟精确校正**（`date +%s` 一次往返）：设备空闲时"最新一条日志离现在多远"
   这种猜测必然误判，会把用户要的新日志过滤掉；读不到设备时钟才退回启发式并明确告知。
8. **级别还原是硬约束**：`finally` 里还原；还原失败会把 `ok` 置 false 并给出**手动还原命令**
   （`hdc -t <key> shell "hilog -b <原级别>"`），绝不假装成功。
9. **设备睡了 ≠ 插件坏了**：熄屏/空闲时后台应用被冻结 ⇒ 日志量趋近于零。`capture` 返回 0 条时会给
   可能原因提示，并可放宽 `seconds`。
10. **不做破坏性操作**：不清缓冲区（`-r`）、不碰 `-G` 持久化配置、不做 kmsg/私有日志、不驱动设备 UI。
11. `tag` 传多个用 `tags`（`-T` 最多 10 个）、`pid` 用 `pids`（最多 5）、`domain` 用 `domains`（最多 5），
    超限直接报错（不静默截断）。

---

## 7. 文件地图与开发

```
Common/dsh-hilog/
  package.json          # name/version/main/exports/dsh.bundle.patch/engines（与 dsh-proxyagent 同构）
  cordis.patch.yml      # 在 profile 加载树里 insert 一行（entry id = dsh-hilog = 设置命名空间）
  lib/
    index.js            # cordis 接线：name/inject/Config(schemastery)/apply + 可选 settings/shell 注入
    tools.js            # ctx.shell 适配（exec / execStream）+ 渲染 + 三个工具的注册与执行
    ops.js              # 业务逻辑：级别读写与还原、dump、capture（流式、时钟校正、落盘）
    hdc.js              # 双通道探测、目标挑选、命令拼装（只挑 Connected）
    hilog.js            # 纯函数：参数转义/命令拼装/行解析/时间戳/截断（无任何 I/O ⇒ 可离线单测）
  tests/
    hilog.test.mjs      # 20 项：解析（普通/long/中文/空格/多行/含冒号 pkg）、转义往返、截断、目标挑选
    hdc.test.mjs        # 11 项：通道探测各种组合（假 exec）
    tools.test.mjs      # 27 项：注册形状、级别还原（含异常/取消路径）、dump、capture、时钟校正、落盘、渲染
    helpers/fake-shell.mjs  # 假设备 + 假 ctx.shell（形状与真实接缝一致）
    manual/verify-device.mjs # §6.2 真机验证（只读；用 node:child_process 造同形接缝，跑的是插件本体）
  README.md             # 本文件
  开发需求文档.md        # 需求与实测依据（来源文档）
```

```sh
cd Common/dsh-hilog
node --test "tests/*.test.mjs"                       # 单测：不需要设备
node tests/manual/verify-device.mjs --seconds 10 --tag <在跑的tag>   # 真机：§6.2 五项
```

**为什么插件本体绝不会用 `node:child_process`**：本机 `process.execPath` 是 `/system/bin/appspawn`，
被运行时直接拒绝（univer 插件即死于此）。所有命令都走 `ctx.shell` 接缝
（`shell.resolve(request)` → `shell.execute(spec)` → `result()` / 流式 `readOutput()`）。
`node:child_process` 只出现在 `tests/manual/verify-device.mjs`（开发/验证工具，不随插件执行）。

---

## 8. 验收记录

### 8.0 重启后的真机复验（2026-10-15 12:00，工具走**真实 `ctx.shell`**）

重启挂载后，三个工具在真实宿主里跑通（不再是验证脚本的同形外壳）：

| 项 | 结果 |
|---|---|
| `hilog_level {get}` | `W` · device=127.0.0.1:45071 · channel=bridge |
| `hilog_dump {lines:15}` | 缓冲区 7668 条，返回 15 条（tail 截断），含带冒号 pkg 的行（`A04511/com.dshm.dshclient:gpu/chromium`） |
| `hilog_capture {seconds:10, tag:"utils_base"}` | **213 条新日志**（过滤 7 条历史）· `W → I → W 已还原` · 落盘 220 行 |
| 复验还原 | 抓完后独立 `hilog_level get` ⇒ `W` ✅ |
| `hilog_level {set D}` | `W → D → W（已还原）` —— 真实 `hilog -b` 路径 |
| `hilog_level {set D, keep:true}` → `{restore}` | `W → D → D`（保留）→ `D → W → W`（显式还原，用了插件记住的原值） |
| 错 device | 可读错误 + **逐通道** `list targets -v` 原文（含桥与 via-host 各自的 Connected 列表）+ 指引 |
| **USB 手机（真机）** | 手机上插着 PLR-AL50 时，`hilog_level {get, channel:"via-host"}` ⇒ `device=5BH0225304025535 channel=via-host level=W`；`hilog_capture {device:"5BH…", seconds:8}` 自动换到 via-host 通道、抓到 **521 条新日志**、过滤 7727 条历史、`W → I → W 已还原` ✅ |

> 复验时又抓到两处只有真机才会暴露的问题（已修 + 加回归单测，**需下次重启生效**）：
> ① via-host 的 `[hdc-tcp-shim] …` 提示行打在 **stderr** 上 ⇒ 会被当成"hdc 报错"，
>    让"0 条命中的成功抓取"被标成失败（原文见 `lib/hilog.js` 的 `filterNoiseLines`）；
> ② `action:"restore"` 的渲染文案误写成"keep:true 保留"。

### 8.1 首轮验收（安装前用同形接缝跑的真机验证，本机 PC + 桥/无线调试 `127.0.0.1:45071`）

### 单测（无设备）

```
node --test "tests/*.test.mjs"   →  ℹ tests 58   ℹ pass 58   ℹ fail 0
```

覆盖：hilog 行解析（普通 / `-v long` / 中文 / 空格 / 多行消息 / **pkg 段含冒号**）、
POSIX 转义与真 shell 往返、设备挑选（多 Connected / 全 Offline / 指定 Offline / 两条通道都没有）、
通道自动切换、级别还原（正常 / 设置抛异常 / 校验失败 / 流式读抛异常 / abort 取消）、
截断（行数 + 字节）、落盘行数一致、渲染文本、命令拼装上限（`-T` 10 / `-P` 5 / `-D` 5）。

### 真机（只读，无模拟用户操作）

```
node tests/manual/verify-device.mjs --seconds 10 --tag utils_base      # 目标=本机 PC，桥/无线调试
✅ [1] hilog_level get        — device=127.0.0.1:45071 channel=bridge level=W
✅ [2] hilog_dump 有内容      — totalEntries=7271 returned=50 globalLevel=W
✅ [3] capture 后级别已还原   — W → I → W（复查 W）；抓到 229 条新日志、过滤掉 246 条缓冲区历史
✅ [4] 落盘存在且行数一致     — 文件 435 行 / 摘要 fileLines=435 / 条目 229
✅ [5] 错误 device 可诊断     — 逐通道 list targets -v 原文 + 指引，3.3s 返回，不挂死
全部真机项通过 ✅
```

（同一脚本不带 `--tag` 跑过一次更密的：10s 抓到 2009 条新日志、文件 4568 行，同样全部通过。）

证据文件：`Build/dsh-hilog/evidence/device-verify-*.json`（每次运行一份），原始日志：`Build/dsh-hilog/logs/*.log`。
安装前的 profile 备份：`Build/dsh-hilog/backup-profile/` + `$DSH_HOME/profiles/ondevice/package.json.bak-dsh-hilog-*`。

真机顺带确认的两条设备事实（已写进 `lib/hilog.js` 注释与上面的限制清单）：
`-L` 精确匹配 + 逗号分隔语法；应用行里 **pkg 段可以含冒号**
（`A04511/com.dshm.dshclient:gpu/chromium: …`，`-v long` 同条为 `A04511 com.dshm.dshclient:gpu chromium`）。
