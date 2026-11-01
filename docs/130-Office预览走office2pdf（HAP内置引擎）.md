# 130 · Office 预览走 HAP 内置 office2pdf 引擎（2026-10-29）

> 目标：让侧栏 Office 预览**和官方对齐**——点 docx/pptx 直接看到 PDF，与真 PDF 预览同一套 UI；
> 且**转换引擎随 HAP 分发**（别人装了这个 HAP 就能用，插件不必自带引擎）。
>
> 结论：**已实现并在 WhaleX 真机验证通过**（docx/pptx 正常、中文行距正确、xlsx 走官方前端解析不受影响）。
> 唯一没做的是工具栏"用系统打开"按钮（尝试失败，见 §9）。

---

## 1. 一句话架构

```
用户点 docx
  → 官方 dsh-client-ui-sidebar-documentpreview 的 office 实现（OfficeBody，UI 全归它）
  → remote.officeToPdf.render(...)        ← 走官方 Typert Gateway/RPC
  → 【我们顶替的】dshm-office2pdf 宿主插件（注册同名 service `officeToPdf`）
  → POST /dshm-office2pdf/convert         ← main.js 注册的端点（白名单：沙箱/HOME/用户存储）
  → getOffice2pdfBridge()                 ← Host 内 process.dlopen
  → liboffice2pdf_ext.so（CMake 编的 NAPI 外壳）
  → dlopen liboffice2pdf_capi.so（Rust + Typst 引擎）→ 转出 PDF 字节
  → 官方 PDF 子槽渲染（左侧缩略图/翻页/缩放/下载/打印 全来自官方代码）
```

**关键取舍**：不认领后缀、不自己渲染，只**替换宿主服务**。于是客户端一行不改，
UI（含 PDF 渲染器、缓存、取消）全复用官方实现 ⇒ 观感与真 PDF 一致。

## 2. 为什么只能换 service（不能靠认领后缀）

上游 office 预览的实现选择规则（`dsh-client-ui-sidebar-documentpreview/lib/client.js`）：
`matchingDocumentPreviews()` 按 `priority === "builtin" ? 0 : 1` 排序，**非 builtin 一定排前面**。

- 2026-10-29 第一版：我们插件自己在客户端 `documentPreviews.register` + `<object>` 渲染
  ⇒ 顶掉了官方 OfficeBody，结果变成 **ArkWeb 内置 PDF 查看器**（左侧缩略图栏 + 顶部工具栏），
  和真 PDF 预览（内联、无工具栏）观感完全不同，且绕过了官方缓存/取消。
- 第二版：客户端留空壳 ⇒ 认领权回到 `dshm-office-system-preview`（它也是 `priority:"extension"`，
  `loading:"text-pages"`）⇒ 所有 Office 变成「该格式文件暂时无法预览 + 用 WPS 打开」。
- 第三版（**最终**）：**停用 `dshm-office-system-preview`**，让位给官方 builtin 认领；
  官方 OfficeBody 于是被启用，而它唯一的数据源 `remote.officeToPdf` 由我们顶替 ⇒ 全链路打通。

> 代价：暂时失去「用 WPS 打开」按钮（见 §9）。

## 3. 六个必须同时对上的接点（错一个就静默退化）

| # | 接点 | 正确的做法 | 错了会怎样（实测） |
|---|---|---|---|
| ① | profile 停用上游 `office-to-pdf` | `- id: office-to-pdf` + `disabled: true` | 上游也注册 `officeToPdf`，同名服务冲突；且其 LibreOfficeKit 在 openharmony-arm64 不可达 |
| ② | profile 启用 `dshm-office2pdf` | insert 行 + `pack-core` 插件清单登记 | 服务不存在 ⇒ `remote.officeToPdf` 调用失败 |
| ③ | profile 停用 `dshm-office-system-preview` | `disabled: true`（同一 insert 内） | 它以 extension 优先级认领 4 个后缀 ⇒ 官方 OfficeBody 永不运行 |
| ④ | 插件 `render()` **参数名** | 必须逐字 `workspaceFileScope` | `typert gateway: officeToPdf/render: args fields do not match the descriptor: unexpected "workspaceFileScopeId"` |
| ⑤ | 插件**不导出 `apply`** | 只 `export default 服务类` | cordis 见 apply 就不实例化 default 类 ⇒ 服务注册不上（`ctx.get('officeToPdf')` 为 undefined） |
| ⑥ | HAP 侧外壳与引擎 | CMake `add_library(office2pdf_ext …)` + `DT_NEEDED libnode.so.137`；`libs/` 内放 Rust `liboffice2pdf_capi.so`；ArkTS 字体桥 | 手工拷 `.so` 顺带注册 → 模块永不实例化（见 `CMakeLists.txt` 头注）；缺 libnode → `napi_get_cb_info: symbol not found` |

④⑤ 是这轮最耗时的两处，教训已写进插件注释与门禁。

## 4. Remote 服务怎么注册（不用 TS 装饰器）

官方用 `@Remote` 装饰器，编译后落在原型上一个**普通字符串常量**键：

```js
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
Object.defineProperty(Proto, REMOTE_METHOD_DESCRIPTOR, {
  value: { version: 1, methods: [
    { method: 'render', invocation: { kind: 'direct' } },
    { method: 'getGeneration', exportName: 'generation', invocation: { kind: 'direct' } },
  ] },
});
```

我们手写同样的标记；Gateway 的 source-mode 发现（`dsh-api-gateway` 读 `typertRemote` +
`remoteMethods()`）不区分来源 ⇒ 与官方等价。返回值必须逐字段对齐官方契约：

```js
{ absolutePath, version, offset: 0, eof: true, bytes, data, missingFonts, generation }
```

## 5. 字体：这是"行距挤/叠行"的真正原因

- office2pdf 的 docx 字体替换链是**写死**的（`render/font_subst.rs`）：
  - 宋体 → `["SimSun", "Noto Serif CJK SC", "Songti SC", "STSong"]`
  - 微软雅黑 → `["Microsoft YaHei", "Noto Sans CJK SC", …]`
- 只在链里的字体，行高（`top-edge`/`bottom-edge` 由字体度量算出）才对；名字不在链里 ⇒
  退回通用度量 ⇒ **中文上下行重叠**（第一版用 `HarmonyOS Sans SC` 就是这症状）。
- `UIContext.getFont().getFontByName('Noto Serif CJK SC')` **查不到**（只有 HarmonyOS 系能查到），
  所以字体桥改为**直连系统文件**：`/system/fonts/NotoSerifCJK-Regular.ttc` +
  `/system/fonts/NotoSansCJK-Regular.ttc`，复制进 `filesDir/office2pdf-fonts/`（约 44 MB，
  只增沙箱数据，**不进 HAP**）。
- 顺带解决许可：Noto CJK 是 **OFL-1.1**，可分发；不随包带则连分发问题都没有。

## 6. 路径白名单

`/dshm-office2pdf/convert` 收 `{input: <绝对路径>}`。白名单必须包含**用户存储**
（`/storage/Users/currentUser/`）：工作区就在那儿，只放行沙箱会让每个工作区文档 403
（实测文案：`预览失败：路径越界（只允许沙箱/工作区内的文件）`）。
判据见 `main.js::o2pPathAllowed`（沙箱 ∪ HOME ∪ 用户存储；应用本就有 `ACCESS_USER_FULL_DISK`）。

## 7. 可复现构建

- **Rust 引擎**（`entry/libs/` 被 gitignore，干净克隆里没有）：
  ```sh
  # 前置：克隆 office2pdf 并钉死提交 7ddb65db49211d560878353824f6644a2bddb191
  sh tools/office2pdf/build-capi.sh [office2pdf源码目录]
  ```
  C ABI 源码在 `tools/office2pdf/capi/`（本仓跟踪）；脚本用 rsproxy 源构建，
  产物 `entry/libs/arm64-v8a/liboffice2pdf_capi.so`（约 52 MB）。
- **C++ NAPI 外壳**：`entry/src/main/cpp/office2pdf_ext.cpp`，由 hvigor/CMake 自动编入。
- **核心树**：`coreVersion` 已递增为 **`0.2.2-alpha.2+whale.2`**（插件与 profile 行变了）。

## 8. 真机验证（WhaleX `com.jwhsoft.whale`）

| 项 | 读数 |
|---|---|
| HAP | 396,445,868 B / sha256 `ce3f91e2…` |
| core zip | 109,160,835 B / sha256 `455eb733…`（`+whale.2`） |
| 服务注册 | `[dshm-office2pdf] +5s: typertRemote=true, remoteMethodsOk=true` |
| 转换 | `[office2pdf] 转换完成：…docx → 31323 字节 / 26ms`；pptx 83,287,555 B / ~3.1s（大文件） |
| 字体桥 | `直连字体命中 2 个`→ 复制 `NotoSerifCJK-Regular.ttc`(26 MB) + `NotoSansCJK-Regular.ttc`(19 MB) |
| 用户验收 | docx/pptx 正常渲染、中文行距正确；**xlsx 仍是官方前端表格预览**（不受影响）；pdf 正常 |
| HAP 体积增量 | Office 相关 +52.0 MB（Rust 引擎）/ +0.06 MB（外壳）；字体 0（系统字体） |

## 9. 未做：工具栏「用系统打开」按钮（已撤回）

尝试在 `sidebar.right.tab.document.action`（keyed 槽，按预览实现 id 匹配）为 7 种实现注册按钮，
点击时经宿主 `/dshm-office2pdf/resolve` 把 `dsh-resource://…` 换成绝对路径后调
`__DSHM_BRIDGES__.openWithSystem`。

- 现象：pdf/excel 上按钮**出现但点击报"拿不到文件路径"**；office 上不出现；
- 更严重：最新一版直接让 **documentpreview 插件激活失败**，页面报
  `Failed to load plugins: @deepseek-ai/dsh-client-ui-sidebar-documentpreview … web boot: 1 entry did not activate`；
- 处置：**整块撤回**（客户端半边恢复为空壳），**失败实现与重做前提已归档**：`tools/office2pdf/wip/client.js.button-attempt` + 同目录 `README.md`；
- 重做前提：换不冲突的机制（list 槽 + 唯一 key，或与上游条目共存的方式），且必须
  **先在离线环境验证槽位注册不抛错**再装机。

## 10. 回退

| 想回到 | 做法 |
|---|---|
| WPS-only（旧方案） | profile 里 `dshm-office2pdf` 行 `disabled: true`，并去掉 `dshm-office-system-preview` 的 `disabled` |
| 完全回上游 | 上述 + 去掉 `- id: office-to-pdf disabled: true`（会回到"Office 预览不可用"，因为上游引擎在端侧不可达） |
| 卸掉引擎减小体积 | 删 `entry/libs/arm64-v8a/liboffice2pdf_capi.so`（52 MB）+ 把 `office2pdf_ext.cpp` 从 CMake 移除 |

## 11. 门禁

新增 `tools/check-office2pdf-wiring.mjs`（**22 项**，纯静态、无需核心树/设备）：
把 §3 的 6 个接点逐条钉死，另含返回契约字段、`no-transform`、白名单、字体直连路径等。
本轮跑的完整门禁见 `docs/128`（Phase 4）同类清单，关键几项读数：

```
check-office2pdf-wiring       22/22 通过
check-core-openharmony-patches 173 passed, 0 failed
assert-resfile-sync           17 件快照全部同步
check-resfile-core-zip        resfile 1 个容器，sha 与配方一致
```

## 12. 证据索引

| 内容 | 位置 |
|---|---|
| C ABI 源码 | `tools/office2pdf/capi/src/lib.rs` |
| 引擎构建脚本 | `tools/office2pdf/build-capi.sh` |
| NAPI 外壳 | `entry/src/main/cpp/office2pdf_ext.cpp`（文件头有完整踩坑史） |
| Host 桥 + 端点 | `hostcore/app/main.js`（`getOffice2pdfBridge` / `registerOffice2pdfEndpoint` / `o2pPathAllowed`） |
| 顶替服务 | `hostcore/plugins/dshm-office2pdf/lib/index.js` |
| 字体桥 | `entry/src/main/ets/runtime/Office2pdfFont.ets` |
| 接线门禁 | `tools/check-office2pdf-wiring.mjs` |
| 引擎可行性评估 | `Eva-Research/2026-10-29-office2pdf-rust评估/docs/REPORT.md` |
| LOK-WASM 旧方案结论 | `tmp/office/REPORT.md` |
