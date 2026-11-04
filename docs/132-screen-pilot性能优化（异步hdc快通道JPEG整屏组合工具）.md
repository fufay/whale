# 132 · screen-pilot 性能优化（异步 + hdc 快通道 + JPEG 整屏 + 组合工具）

> 日期：2026-11-04
> 对象：内置插件 `@deepseek-ai/dshm-screen-pilot`（给模型提供 `screen_capture` / `ui_*` 真实屏幕与键鼠工具）
> 源码：`Common/dsh-screen-pilot/`（开发位置）→ 出包副本 `Common/whale/hostcore/plugins/dshm-screen-pilot/`
> 状态：**源码已改 + 只读实测通过 + 已随核心树并入 Whale 出包并装机**（coreVersion `0.2.2-alpha.2+whale.3`）

## 1. 动机与基线

用户反馈 UI 自动化「慢、等待多」。在真机（HarmonyOS PC，3120×2080 单屏，hdc 桥连本机）上用
只读操作（screenCap / dumpLayout / snapshot_display / hidumper / file recv）做 3 轮中位数基线：

| 操作 | 旧实现 |
|---|---|
| `ui_dump` | ~1.78–1.88 s |
| `screen_capture` 整屏 | ~1.61–1.65 s |
| `screen_capture` region 1200×800 | ~1.66–1.68 s |
| `screen_capture` window | ~2.06–2.15 s |
| `screen_windows` | ~333 ms |
| 单次输入注入（click/swipe/key/type） | ~300 ms |

耗时结构（拆解实测）：

1. **hdc 桥壳税**：原实现每次 `hdc` 调用都走 `$HOME/bin/hdc`（hdcb：端口发现/连通性自检/自愈），
   单次 ~280–350 ms；真 hdc 直连（`$HOME/.hdc-bridge/real.path` + `LD_PRELOAD=shim.so`）只要 ~95–110 ms。
   ui_dump 要 3 次 hdc 调用、截图要 3 次、窗口截图 4 次 ⇒ 单次工具 0.6–1.2 s 全耗在桥壳上。
2. **多余往返**：dumpLayout 走到远端文件后，客户端再单独 `hdc file recv`、再单独 `rm`。
3. **纯浪费的整图解码**：截图后为了返回 width/height 调 `decodePng` 整图（3120×2080 RGBA ≈180 ms/次）；
   裁剪又 decode 一次（~200 ms）。
4. **同步阻塞**：`execFileSync` 跑在 Host 进程里，一次 ui_dump 阻塞事件循环 ~1.8 s（GUI/其它会话一起卡）。
5. **设备侧 dumpLayout 本体 ~0.9–1.0 s 无法消掉**，是 ui_dump 的下限。

## 2. 改动清单（7 个 lib 全改，9 → 11 个工具）

| 优化 | 实现要点 | 实测收益 |
|---|---|---|
| 全异步 | `execFileSync` → promisified `execFile`；工具 `execute` 全 async | 不再阻塞 Host 事件循环；并发调用可重叠 |
| hdc 快通道 | 读 `$HOME/.hdc-bridge/real.path` + `shim.so`，直接 exec 真 hdc + LD_PRELOAD；失败回退 `$HOME/bin/hdc` 并熔断（30s 后重试，3 次失败本进程放弃）。`SCREEN_PILOT_HDC=auto\|shim\|fast` | 每次 hdc 调用 −200 ms（−65%） |
| 合并往返 | `ui_dump` = 一次 shell 内 `dump >log; echo status; cat json; rm`；窗口截图把 `hidumper` 并进同一条命令；远端文件由清理队列在下次调用顺带 `rm`（首次调用清上一轮遗留 `dsp_*_*_*`） | ui_dump 3 次 → 1 次往返；窗口截图 4 次 → 2 次 |
| 尺寸直读 | 新增 `readPngSize`（IHDR）/`readJpegSize`（SOF）/`readImageSize`；截图不再整图 decode | 每张截图省 ~180 ms |
| 裁剪加速 | `decodePng` 原地反滤波（不逐行 `Buffer.from`+`prev` 拷贝）；`cropPng` 只反滤波到需要的行/列 | 整图 decode 180→110 ms；region 裁剪 200→50–70 ms |
| 整屏 JPEG 快通道 | `snapshot_display -i <d> -f x.jpeg`（~0.4 s / ~0.35 MB），失败回退 `uitest screenCap` PNG；`format:'png'` 或 `outPath` 为 `.png` 时仍 PNG。窗口/region 固定 PNG | 整屏截图 −200 ms 且文件小 5 倍+ |
| uitest 单例保护 | 设备侧 uitest 并发会 `Wait for subscribe uitest.broadcast.command.reply timeout`；插件内 uitest 命令串行队列 + 撞车重试一次 | 并发不再互相打断 |
| 组合工具 | `ui_tap_text`（找文本→点击中心点，自动复用/刷新 UI 树）、`ui_wait_text`（轮询等文本出现/消失） | 常见流程少 2+ 次模型往返 |
| 落盘整理 | UI 树默认覆盖 `layout_latest.json`（不再每次 280 KB 时间戳文件） | 保存目录不膨胀 |

行为变化（对模型/调用方）：
- `screen_capture` 整屏**默认 JPEG**（返回体新增 `format`，默认文件名 `capture_<ts>.jpeg`）；
  要 PNG 传 `format:'png'` 或 outPath 用 `.png`。
- `ui_dump` 的 `path` 默认指向 `layout_latest.json`（`saveTo` 仍可指定）。
- 新增 2 个工具（11 个），旧 9 个工具参数/返回兼容。

## 3. 优化后实测（3 轮中位数，只读）

独立复测（teammate `sp-verifier`，3 轮中位；旧/新相近时点同内容对照）：

| 操作 | 旧 | 新 | 降幅 |
|---|---|---|---|
| 单次 hdc（归一化地板） | ~268 ms | ~64 ms | −76% |
| `screen_windows` | ~333 ms | ~155 ms | −54% |
| `ui_dump`（设备侧 dumpLayout ~0.9–1.1s 是大头，随界面内容浮动） | ~1.78–1.85 s | ~1.09–1.35 s | −27%~−45%（同内容折算 ≈−40%） |
| `screen_capture` 整屏默认 JPEG | ~1.55–1.65 s | ~0.44 s | −72% |
| `screen_capture` 整屏显式 PNG | ~1.56 s | ~0.66 s | −58% |
| `screen_capture` region | ~1.61–1.68 s | ~0.82 s | −49% |
| `screen_capture` window | ~2.16–2.26 s | ~1.04–1.10 s | −52% |
| 并发 `ui_dump` + `screen_capture` | ~3.51 s | ~1.21 s | −66%（截图躲进 dump） |
| 输入注入单次 | ~300 ms | ~95–110 ms | −65% |

`SCREEN_PILOT_HDC=shim` 回退通道同样全过，且仍全面优于旧版：整屏 −38.9%、region −25.5%、
window −30.3%、`ui_dump` −29.8%、并发 −62.8%——收益来自「调用数减少 + 去解码 + 异步」，不依赖快通道。
`ui_find` 缓存命中仍是 ~0 ms；`ui_dump` 剩余 ~1 s 主要是设备侧 dumpLayout 本体。

### 3.1 独立验证结论

- 新版 auto / shim 两条通道：**54/54 断言全 PASS**，功能等价（UI 树结构、分辨率、默认 JPEG 魔数/
  `format`、显式 PNG、region/window 尺寸=窗口∩屏幕、bytes==磁盘大小），全程 0 次重试、无 `file recv` ENOENT。
- 异常路径：无效 window / 越界 region 抛错正确，且新版在 `file recv` 前就抛（608.7 ms vs 旧 1736.6 ms）。
- 并发：`Promise.all(dump+capture)` 3 轮全成功，1209 ms ≈ max(1354, 439) ⇒ 截图与 dump 真并行；
  设备侧 uitest 单例命令经进程内互斥队列串行，未观测撞车。
- 设备残留：各进程自身 `dsp_<pid>_*` 遗留 0；首调用 sweep 验证有效。
- **未覆盖**：真实 Host 激活链路（受约束不能装包/重启）——留待用户真机冒烟。

## 4. 验证

- 项目自测：`Common/dsh-screen-pilot` 下 `node test/engine.test.mjs`（默认只读、不做输入注入；
  `SP_TEST_INPUT=1` 才做一次真实点击）。覆盖：11 工具注册 + 真实 JSON-Schema 校验器
  （`@deepseek-ai/dsh-tools`）+ 窗口/尺寸/UI 树/整屏 JPEG/PNG/region/window/异常路径/组合工具分支。
- 独立复测：teammate 基线快照 + A/B + `SCREEN_PILOT_HDC=shim` 回退 + 并发 + 异常 + 设备残留
  （报告 `/tmp/sp-verify/REPORT.md`，会话临时）。
- 全程只读设备操作；未做真实点击/输入，未改设备数据。

## 5. 风险与边界

- **utest 单例是设备侧限制**：跨进程（多 Host/多工具进程）并发仍可能撞车；插件内重试一次，
  但无法保证跨进程。生产单 Host 场景基本不触发。
- **JPEG 整屏**：适合「看一眼/验证界面」，需要原图保真（如导出截图交付）时用 `format:'png'`。
  验证过 350 KB JPEG 在 read_image 降采样后文字仍可读。
- **fast 通道探测**依赖 `$HOME/.hdc-bridge/{real.path,shim.so}`（Whale 的 hdc 桥自愈脚本会维护）；
  文件缺失/真 hdc 不可注入时自动回退桥壳，功能不受影响，只是变慢。
- 新增 2 个工具会占一点系统提示 token（工具定义）；如不需要可只保留旧的 9 个。

## 6. 出包 / 回滚

出包（本会话**未执行**，需要时按 whale AGENTS.md）：
1. `hostcore/core-recipe.json`：coreVersion `0.2.2-alpha.2+whale.2` → `+whale.3`（核心树内容已变）。
2. `node tools/pack-core.mjs --place-in-app` → `node tools/check-resfile-core-zip.mjs` 等门禁。
3. 出 HAP → `hdc install -r`（覆盖安装，不动 el2 数据）→ 用户冒烟：重启后让 agent 调一次
   `ui_dump` / `screen_capture` / `ui_tap_text`（点击为真实操作，需用户在场确认落点）。

回滚：
- `git -C Common/whale checkout -- hostcore/plugins/dshm-screen-pilot`（vendored 副本在 git 里）。
- 不改代码的降速回退：`SCREEN_PILOT_HDC=shim`（回到原 hdc 桥路径，但合并往返/去解码仍有收益）。

## 6. 并入 Whale 出包（2026-11-04，本会话完成）

按 `Common/dsh-screen-pilot/HANDOFF.md` §3 执行：

1. `Common/dsh-screen-pilot/lib/*.js`（7 个）**逐字节**覆盖到 `hostcore/plugins/dshm-screen-pilot/lib/`
   （包名保持 `@deepseek-ai/dshm-screen-pilot`，见 §7 命名说明）；
2. `hostcore/core-recipe.json`：`coreVersion` `0.2.2-alpha.2+whale.2` → **`+whale.3`**；
3. `node tools/pack-core.mjs --skip-install --place-in-app`。

### 6.1 依赖树零漂移（关键）

`dist/core/work/dsh-core-0.2.2-alpha.2+whale.3` 的 `node_modules` **不能**用裸 `npm install` 物化：
2026-11-04 实测它会拉到 31 个更新的上游预发布版（`@deepseek-ai/cordis 4.0.6-alpha.1 → alpha.2`、
`typebox → @earendil-works/pi-schema` 等），即核心树行为会跟已验证的 `+whale.2` 不一致。
做法：把 `+whale.2` 的 `package-lock.json` 复制到新 stage、只把根依赖版本串改成 `+whale.3`，
再 `npm ci --os=openharmony --cpu=arm64 --ignore-scripts`（实测 29s / 649 包）。
复核：两份 lock 的 636 个包**版本差异 0**，`@deepseek-ai/cordis` 两边都是 `4.0.6-alpha.1`。

### 6.2 产物读数与逐项核验

| 项 | 值 |
|---|---|
| 核心分发包 | `dist/core/dsh-core-0.2.2-alpha.2+whale.3-openharmony-arm64.zip` · **109,170,367 B** · sha256 `404d478eba3a4029d46b69868ec44425adf22245dffc18aeecb8ddd5d02ed907` |
| 条目数 | 46,269（与 `+whale.2` **相同**） |
| 与 `+whale.2` 产物的逐项 diff | **只有 7 个文件**：`dshm-screen-pilot/lib/{hdc,input,layout,png,screen,tools}.js` + `package-lock.json`（+1 B，根依赖版本串） |
| HAP（正式版本号 1.1.2 / 1010002） | **396,457,103 B** · sha256 `61bac66009454e71d1c8d8ecf5d72f78918afeca9a9b22915519dbbd01a9ff6b` |
| HAP（本机自测版，versionCode 覆盖为已装的 1010000） | **396,457,107 B** · sha256 `278448774d044bfe11ee97d96d606f1487806285b55bbf40b93ee940b14e3829` |

- HAP 内 `resources/resfile/dsh-core-…+whale.3…zip` 的 sha256 与 `dist/core` 产出**一致**（404d478e…）；
- HAP 核心 zip 内 `dshm-screen-pilot/lib/` 7 个文件与 `Common/dsh-screen-pilot/lib/` **逐字节相同**；
- 门禁：`check-resfile-core-zip`（1 份容器/三方一致）、`assert-resfile-sync`（17 件）、
  `assert-core-entrypoints`（662 包根 / 4013 条入口全解析）全 PASS。

### 6.3 装配与「装不上」的处理

本机调试 Profile 无 ACL ⇒ **versionCode 升级安装**会被受限权限校验挡住（`docs/125` §九）。
本次设备侧验证用「同 versionCode 覆盖安装」：`tools/build-dev-hap.sh` 新增

```sh
WHALE_DEV_VERSIONCODE=1010000 sh tools/build-dev-hap.sh <out.hap>
```

（临时改 `AppScope/app.json5`，构建结束自动还原；仓库里保持 `1.1.2 / 1010002`）。
本机已用该口径装机成功，设备将按新核心树目录 `dshm/cores/0.2.2-alpha.2+whale.3` 解包。

## 7. 附：为什么它在包内叫 `@deepseek-ai/dshm-screen-pilot`

- 源码包名是 `dsh-screen-pilot`（`Common/dsh-screen-pilot/package.json`）；随核心树自带的副本
  包名是 `@deepseek-ai/dshm-screen-pilot`，profile 里 `id: screen-pilot`、`name:` 指向后者。
- 原因不是它"变成了别人家的插件"，而是 `tools/pack-core.mjs` 的 **`DSHM_PLUGIN_PACKAGES` 清单机制**
  硬编码了 scope 与目录前缀（`@deepseek-ai/` + `dshm-`），用于：① 把 `hostcore/plugins/dshm-*`
  拷进核心树 `node_modules/@deepseek-ai/`；② 往 decl arer（`@deepseek-ai/dsh-web-app`）的
  `dependencies` 里写同名键，否则 cordis loader 解析不到（`routeScoped` 查不到 ⇒ 回退 Node 原生解析 ⇒
  failed to import）；③ 用前缀做「先清后写 + 集合断言」的对称清理，防止暂存树残留旧插件被打进产物。
  见 `tools/pack-core.mjs:874-1060`。改名前须同时动：10 个插件目录名、`package.json` 的 `name`、
  profile 的 `name:`、pack-core 的三个前缀常量、相关门禁，以及**已装机上的旧 profile 行**
  （老 id 会解析失败 ⇒ 必须在升级时清理），属独立课题，见 HANDOFF 待办。
