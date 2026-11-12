<div align="center">

<img src="docs/brand/whale-icon.png" alt="Whale" width="112" />

# Whale

**把 DeepSeek Harness 装进 HarmonyOS PC 的一个自足应用**

</div>

Whale 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**运行本体**装进一个 HarmonyOS PC 应用：
HAP 内自带 Node 运行时与 dsh 核心树，核心在本机 `127.0.0.1` 上起 Host，应用内的 ArkWeb 页面加载官方 Web 前端 ——
**装上即用**，不需要在电脑上常驻任何服务，数据只留在本机应用沙箱内。

> 当前核心：**dsh `0.2.2-rc.2`**（口径以 `hostcore/core-recipe.json` 为准，当前 `0.2.2-rc.2+whale.1`）
> · 主包名 `com.jwhsoft.whale`（显示名 **WhaleX**）· Node **v24.21.0 / jitless** · Host 仅监听回环地址
>
> 旧包 `whale.jwh.chat`（显示名 Whale）**仅存档、不再更新**；设备上已装的那份保持原样可用。

## 下载

| 平台 | 仓库 | 未签名 HAP |
|---|---|---|
| GitHub | <https://github.com/fufay/whale> | <https://github.com/fufay/whale/releases/download/v1.1.7/whale-unsigned.hap> |
| AtomGit | <https://atomgit.com/Kevin911/whale> | <https://atomgit.com/Kevin911/whale/releases/download/v1.1.7/whale-unsigned.hap> |

## 功能概览

- **自足运行**：Node 运行时（`libnode.so.137`）+ dsh 核心树随 HAP 分发；Host 只监听 `127.0.0.1`。
- **官方 Web UI**：窗口/启动页/托盘是 ArkTS 原生壳，正文是官方 dsh Web 前端（ArkWeb / Chromium 144）。
- **Office 预览**：docx / pptx 在侧栏直接用**官方 PDF 渲染器**显示 —— 转换引擎是 HAP 内置的 Rust/Typst
  （[office2pdf](https://github.com/developer0hye/office2pdf)），经 CMake NAPI 外壳在 Host 进程内 `dlopen`；
  中文字体运行期从系统 `Noto Serif/Sans CJK` 复制，**不随包带字体**。详见
  [`docs/130`](docs/130-Office预览走office2pdf（HAP内置引擎）.md)。xlsx 走官方前端表格解析；
  pdf / 图片 / 文本 / 代码 / Markdown 为上游内置实现。
- **终端 / 文件 / 工作区**：内嵌 PTY（`node-pty` 鸿蒙移植）、工作区读写与目录选择、剪贴板、系统分享。
- **内嵌 Python 3.12**（进程内桥，不依赖 execve）、系统语音识别桥、托盘常驻。
- **10 个自带插件**随核心树分发：hilog 抓日志、screen-pilot 截图/键鼠、Office 预览、市场桥、profile pnpm 桥、
  PTC 同进程运行时、fs 写入/删除兜底、默认工作区登记等，见 `hostcore/plugins/`。
- **跟进上游**：紧跟 dsh 官方版本；`coreVersion` 的 `+whale.<n>` 是 build metadata，端侧移植补丁由
  `tools/pack-core.mjs` 随版本自动重放。升级记录见 [`docs/40`](docs/40-上游升级手册.md)、
  [`docs/126`](docs/126-alpha2-Phase1-物化与静态审计.md)。

## 一、直接安装（不想编译）

Release 里提供**未签名 HAP**（`whale-unsigned.hap`）。未签名包不能直接装到设备上，需要先用你自己的证书签一次；
Windows 上最省事的是 **hokit**：

1. 在 Windows 装 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)（自带 `hdc` 与签名工具）；
   设备打开「开发者选项 → USB 调试」或「无线调试」。
2. 下载 Release 里的 `whale-unsigned.hap`。
3. 用 hokit 连接设备（USB 或 WiFi），对该 HAP 做**一键签名 + 安装**（hokit 会用你本机的调试证书/Profile 重签）。
4. **首次启动会解包约 104 MB 的核心树**：可能 1–3 分钟，并可能自动重启一次；之后启动正常（约 10–20 秒）。

> 也可以在 HarmonyOS PC 上用 DevEco Studio 打开本工程、点「自动签名」后 Run，效果相同。
> 注意：DevEco 自动签名的 Profile 是空 ACL，`ACCESS_USER_FULL_DISK` 等权限会在运行时被拒（工作区/终端可能不完整），
> 需要完整体验请按 [`docs/125`](docs/125-调试双包（com.jwhsoft.whale）与本地签名流程.md) 申请带 ACL 的调试 Profile。

## 二、从源码构建（在 HarmonyOS PC 上）

### 2.1 需要装什么

| 工具 | 说明 | 获取方式 |
|---|---|---|
| HarmonyOS SDK（`hvigor` / `hdc` / `hap-sign-tool`） | API 26 / HarmonyOS 7.x | [DevEco Studio 官网](https://developer.huawei.com/consumer/cn/deveco-studio/)（或同页的 **Command Line Tools**）—— 华为许可，**不随本仓库分发** |
| Node.js **24**（跑 `tools/*.mjs`） | ≥ 24 | [nodejs.org](https://nodejs.org/)；本机推荐 [Harmonybrew](https://atomgit.com/Harmonybrew/brew)（`brew install node@24`） |
| Rust（可选，只有重编 Office 引擎才需要） | `1.99+`，host = `aarch64-unknown-linux-ohos` | [Harmonybrew](https://atomgit.com/Harmonybrew/brew)（`brew install rust`） |
| 签名材料 | 调试证书 + Profile | DevEco「自动签名」；或按 [`docs/125`](docs/125-调试双包（com.jwhsoft.whale）与本地签名流程.md) 用 AGC 自行申请 |

### 2.2 需要自备的"大件"（不入库）

仓库只跟踪**源码、配置与文档**；下面这些是生成物或第三方二进制，**不在版本库内**
（`entry/libs/`、`resfile/*.zip`、`node-headers/` 均被 `.gitignore` 排除）：

| 产物 | 放到 | 生成/获取方式 |
|---|---|---|
| `libnode.so.137`（约 116 MB） | `entry/libs/arm64-v8a/` | HarmonyOS 版 Node 运行时。可自编：`NODE_VER=v24.21.0 bash tools/node-runtime/build-node-ohos.sh`（需 WSL2/POSIX，约 30–90 分钟，方法见 [`docs/124`](docs/124-端侧Node升级到v24.21.0（Phase 0）.md)） |
| `libdshhost.so` | `entry/libs/arm64-v8a/` | **hvigor 的 CMake 自动编译**（`entry/src/main/cpp/CMakeLists.txt`），无需手动准备 |
| Node C++ 头文件（约 5 MB） | `entry/src/main/cpp/node-headers/` | `node tools/node-runtime/sync-node-headers.py <node 源码 tar.xz 或解压目录>`（Node 源码，MIT） |
| dsh 核心树 zip（约 104 MB） | `entry/src/main/resources/resfile/` | `node tools/pack-core.mjs --place-in-app` 生成（需 npm 镜像，见 2.3） |
| 入口脚本 | `entry/src/main/resources/resfile/resources/app/` | `node tools/place-host-app.mjs` |
| 第三方运行库 | `entry/libs/arm64-v8a/` | 见 2.4 清单（许可证原因不随仓库分发） |

### 2.3 构建步骤

```sh
# ① 环境：Node 24 与 hvigor 在 PATH 上
#    Harmonybrew 例：export PATH=/storage/Users/currentUser/.harmonybrew/opt/node@24/bin:$PATH

# ② 入口脚本（改过 hostcore/ 就要重跑）
node tools/place-host-app.mjs

# ③ 物化并打包 dsh 核心树（首次 npm install 约 5–15 分钟；已有树可加 --skip-install）
node tools/pack-core.mjs --place-in-app

# ④ 配置签名：复制模板，按注释填本机证书/Profile 路径
cp tools/build-profile.template.json5 build-profile.json5

# ⑤ 构建
devecocli build --build-mode debug
#   产物：entry/build/default/outputs/default/entry-default-unsigned.hap
#        与 entry-default-signed.hap（DevEco 自动签名，Profile ACL 不全）

# ⑥ 安装（覆盖安装，应用数据原地保留）
hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
```

> **`tools/build-dev-hap.sh` 是做什么的**：DevEco 自动签名的 Profile 是空 ACL，装到真机会在 `ACCESS_USER_FULL_DISK`、
> `ALLOW_EXTERNAL_NATIVE_CODE` 等权限上被拒（工作区/终端/原生库全哑）。该脚本做「去签名 → 全条目 STORED 重打包 →
> 用带 ACL 的调试 Profile 重签」。自用请按 [`docs/125`](docs/125-调试双包（com.jwhsoft.whale）与本地签名流程.md) 备好
> `dist/signing/dev-profile/` 下的证书与 Profile，然后 `sh tools/build-dev-hap.sh`。

### 2.4 第三方运行库（许可证非 MIT，请自行获取）

这些 `.so` 既不进仓库、也不随 Release 分发（避免再分发义务），请自行放到 `entry/libs/arm64-v8a/`。
下表是用途 / 许可证 / 上游地址；OpenHarmony 版本需要自行交叉编译（参考 [`docs/106`](docs/106-两份端侧自检报告的分诊与探针读数机器可读化.md)、
[`docs/112`](docs/112-三端代码审核与正式侧载包.md) 的构建记录）：

| 库 | 用途 | 许可证 | 上游 |
|---|---|---|---|
| `busybox` | 端侧 shell 工具集 | **GPL-2.0** | <https://busybox.net/> |
| `libpython3.12.so.1.0` | 内嵌 CPython（进程内桥） | PSF-2.0 | <https://www.python.org/downloads/source/> |
| `libonnxruntime.so` | 语音模型推理 | MIT | <https://github.com/microsoft/onnxruntime/releases> |
| `libsherpa-onnx-c-api.so` | 语音识别前端 | Apache-2.0 | <https://github.com/k2-fsa/sherpa-onnx/releases> |
| `librsvg-2.so` / `libgio-2.0.so` / `libglib-2.0.so` 等 | SVG / 图片处理（sharp 链路） | **LGPL-2.1+** | <https://gitlab.gnome.org/GNOME/librsvg> · <https://gitlab.gnome.org/GNOME/glib> |
| `libvips.so` 及依赖 | 图片缩放/预览 | **LGPL-2.1+** | <https://github.com/libvips/libvips> |
| `libX11` / `libXext` / `libXrender` / `libXau` / `libXdmcp` | 桌面类依赖（部分工具链需要） | MIT/X11 | <https://gitlab.freedesktop.org/xorg/lib/libx11> |

> 缺库的表现：Host 启动日志里 `natives` 段显示 `sharp` / `koffi` / `node-pty` 非 `ok`，或启动直接崩。
> 排查方法见 [`docs/120`](docs/120-AGENTS操作细节与门禁手册.md) §3。

### 2.5 可选：重编 Office 转换引擎

Office 预览的 Rust/Typst 引擎（`liboffice2pdf_capi.so`，约 52 MB）同样被 `gitignore`。重编：

```sh
# ① 取 office2pdf 源码并钉死提交
git clone https://github.com/developer0hye/office2pdf
cd office2pdf && git checkout 7ddb65db49211d560878353824f6644a2bddb191 && cd ..

# ② 用 Harmonybrew 的 cargo 构建（host 已是 aarch64-unknown-linux-ohos，不要加 --target）
export PATH=/storage/Users/currentUser/.harmonybrew/bin:$PATH
sh tools/office2pdf/build-capi.sh /path/to/office2pdf
```

### 2.6 自行构建后：内部 hdc 桥怎么用（UI 自动化 / 装机调试）

Whale 自带一条「应用沙箱内的 hdc 桥」：把系统的 hdc 客户端接到本机，让宿主里的工具
（以及内置的 `screen-pilot` UI 自动化插件）能直接 `hdc shell` / `hdc install`。
**它不是 dsh 插件，也不是本仓库外某个目录的依赖**——桥的 5 个资产（`bridge.sh`、`fakecred.py`、
`scanports.py`、`shim.c`、预编译 `shim.so`）已经内嵌进 HAP（`resources/resfile/resources/app/hdc-bridge-assets.js`），
Host 启动时会把它们同步到应用沙箱 `$HOME/.hdc-bridge/src/`。

**你需要做的只有两件**（不需要 clang，不需要手动拷脚本）：

1. 设备上打开 **设置 → 开发者选项 → 无线调试**（端口每次开机/换网会变，桥会自动读
   `param get persist.hdc.port` 跟上；首次连接设备会弹一次调试授权，确认后免二次）；
2. 用起来。三种方式任选：

```sh
# ① 一次性手动起桥（首次/桥状态不明时）
sh $HOME/.hdc-bridge/src/bridge.sh

# ② 直接用包装脚本（每天用这个；还没起桥时它会自己修）
hdcb list targets      # 期望输出：127.0.0.1:<端口>
hdcb shell id          # 期望：uid=2000(shell)
hdcb install -r xxx.hap

# ③ 什么都不敲：直接用 UI 自动化工具（screen-pilot 在连不上时会自己跑一次 bridge.sh 再重试）
```

**为什么不需要 clang**：从 2026-11-08 起，HAP 内嵌了 **aarch64/musl 的预编译 `shim.so`**
（与设备现场编译的字节相同），`bridge.sh` 优先拷贝它；只有你自己改了 `shim.c` 并想重新编译时，
才需要设备上有 `clang`（此时会回退到现场编译）。

**源码改动后要同步内嵌资产**（只改 `Common/dsh-hdc-bridge/` 不会自动生效）：

```sh
node tools/embed-hdc-bridge.mjs        # 重新生成 hostcore/app/hdc-bridge-assets.js
node tools/check-hdc-bridge-embed.mjs  # 门禁：内嵌内容必须与源码一致（含 shim.so 的 base64）
node tools/place-host-app.mjs          # 把 hostcore/app/*.js 放进 HAP
```

**排查入口**（都在应用沙箱里）：

| 文件 | 看什么 |
|---|---|
| `$HOME/.hdc-bridge/bridge.log` | 桥部署/重建过程 |
| `$HOME/.hdc-bridge/server.log` | `hdc -m` server 的原始输出 |
| `$HOME/tmp/bindlog.txt` | shim 是否真的拦到了 bind/connect |
| `$HOME/tmp/hdcb-err.log` | 每次 `hdcb` 调用的端口探测/连接结果 |
| `$HOME/tmp/credlog.txt` | 凭据握手（fakecred） |

开关：`DSHM_HDC_BRIDGE=0` 整体关桥；`DSHM_HDC_BRIDGE_REPAIR=1` 让 Host 启动时就修复
（默认延迟到首次使用，规避 2026-11-04 的启动冻死事故，见 [`docs/133`](docs/133-hdc桥v3（UI自动化卡死根因）.md)）。

> 说明：`$HOME` 是**应用 files 目录**（沙箱），不是 `$DSH_HOME`；卸载/清数据会丢桥产物，
> 下次启动自动重建。`keys/`（调试授权私钥）**有意不随包**，所以每台新设备首次要确认一次授权。

## 三、目录结构

| 路径 | 内容 |
|---|---|
| `entry/` | ArkTS 应用：ArkWeb 宿主、ArkTS 桥、启动页、托盘、原生外壳（`entry/src/main/cpp/`） |
| `platform/` | 系统能力机制层：文件选择器 / 系统预览 / 权限 / 窗体… |
| `hostruntime/` | Node 运行时承载（libnode + host 进程 + `libdshhost`） |
| `hostcore/` | 核心树配方（`core-recipe.json`）、10 个自带插件、端侧 profile |
| `tools/` | 构建（`pack-core.mjs`、`place-host-app.mjs`）、门禁、Office 引擎构建 |
| `docs/` | 索引见 [`docs/README.md`](docs/README.md)；构建/门禁细则见 [`docs/120`](docs/120-AGENTS操作细节与门禁手册.md) |

## 四、门禁（可选）

```sh
node tools/check-parity.mjs
node tools/assert-cli-shim.mjs
node tools/assert-resfile-sync.mjs
node tools/check-resfile-core-zip.mjs
node tools/check-core-openharmony-patches.mjs
node tools/check-office2pdf-wiring.mjs      # Office 预览接线（22 项静态判据）
```

完整清单与「哪些需要核心树 / 设备」见 [`docs/120`](docs/120-AGENTS操作细节与门禁手册.md) §1。

## 五、已知限制

- **jitless**：Host 的 Node 以 `--jitless` 运行（JIT 在 debug 签名 + 系统重启后会崩，见 `DECISIONS.md` D-010），
  因此 `WebAssembly` 不可用；依赖 wasm 的组件（如 libreoffice-kit 的 wasm 引擎）不可用。
- **execve 受限**：随包可执行文件在应用域一律 `EACCES`（[`docs/104`](docs/104-手机档终端与bash能力判据.md)），
  所以工具链走进程内桥（Python / PTC）而不是子进程。
- 首次启动慢（解包核心树）；大 PPT 首次转换约 3 秒（之后有缓存）。
- 目前只维护 `com.jwhsoft.whale`（WhaleX）一个包；旧包仅存档。

## 六、许可与来源

本仓库以 **MIT** 发布；第三方组件各自遵循其许可证（Node.js: MIT；Typst / office2pdf: Apache-2.0；
Noto 字体 OFL-1.1，运行期从系统复制、不随包分发；其余见 §2.4 与各 `NOTICE`）。

本项目衍生自 [DSHM](https://github.com/sol5766/dshm)（作者 sol，MIT License）—— 原始 MIT 许可与版权声明完整保留在
[`LICENSE`](LICENSE)（Copyright (c) 2026 sol）。Whale 在其基础上做上游版本跟进、品牌与端侧形态的独立演进。
