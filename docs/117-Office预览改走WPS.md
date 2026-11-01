# 117 · Office 预览改走本机 WPS（PDF 保持内置内嵌）

> 状态：**已实施并真机验证**（2026-10-17）· 核心树 `0.2.1-alpha.4+whale.7`
> 版本说明：本文的 `+whale.7` 是**当时**的口径；当前 `coreVersion` 以 `hostcore/core-recipe.json` 为准
> （2026-10-22 为 `0.2.1-rc.2+whale.2`）。
> 一句话：侧栏对 Office 全族只给一个入口 —— **「用 WPS 打开」**；PDF/图片/HTML/文本仍走上游内置内嵌预览。

---

## 1. 决策（用户 2026-10-17 拍板）

| 格式 | 行为 |
|---|---|
| **doc / docx / xls / xlsx / ppt / pptx / odt / ods / odp** | 侧栏预览面板显示 **「用 WPS 打开」** → 点击把文件交给本机 `cn.wps.office.hap` 打开（WPS 窗口） |
| **pdf** | 保持上游内置内嵌预览（不认领） |
| 图片 / HTML / 文本 / markdown | 保持上游内置（不认领） |

**背景**：此前 docx 由本插件自渲染（ZIP + XML，文本/表格/粗斜下划线可读，但图片、颜色、字号、页面版式、列表序号全丢）；用户认为**保真度**不值得继续投入，且本机装有 WPS ⇒ 改为"全部交给 WPS"。

---

## 2. 为什么不是"把 WPS 嵌进侧栏"（这条要留证，别再重复调研）

1. **官方两篇「浏览器应用集成嵌入 WPS」文档 = NPAPI 插件方案**
   （`<object type="application/x-wps">` + `Application.createDocument(...)`）。
   NPAPI 已被 Chrome 45+ / Firefox 52+ 移除；本机 Web GUI 是 **ArkWeb（Chromium M144）**
   ⇒ **根本不会加载 NPAPI 插件** ❌。文档示例还是 Linux/UOS 时代的老 OA 场景。
2. **WPS 鸿蒙客户端不暴露可嵌入的 UI 扩展**：设备实测 `bm dump -n cn.wps.office.hap`
   （12.1.3.29176，6 个模块：`jsapisvr` / `ksolaunch` / `prome` / `wpscloudsvr` / `wpsdoccenter` / `xlibrary`）
   ⇒ 对外**只有 `statusBarView` 扩展**，没有 `UIExtensionAbility` ⇒ ArkTS 的
   `EmbeddedComponent` 嵌不了 ❌。
3. **WPS Open SDK 鸿蒙统一版**（2026-07 发布，`WPSApi.registerApp/sendRequest` + `OpenFileRequest`，
   个人版免序列号）：需要**厂商注册/申请 HAR**，官方对接文档面向**移动鸿蒙**，且它仍是"**拉起 WPS 打开**"
   （回调回传 URI/FD），不是页面内渲染 ⇒ 只作为将来的备选，不是本期方案。

⇒ 结论：**"不弹窗 + 用 WPS 渲染"在本机做不到**（技术形态问题，不是移植缺陷）。
用户据此定：**Office 一律用 WPS 打开**（可编辑、保真），接受"切到 WPS 窗口"。

---

## 3. 实现（三处，缺一不可）

### 3.1 客户端插件（`hostcore/plugins/dshm-office-system-preview/lib/client.js`）

- 认领后缀（`priority:"extension"` ⇒ 稳赢内置 `builtin` 的 office 桩实现）：
  `doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp`（**xls/xlsx/docx 重新认领**；PDF 不认领）。
- 文案：`viewer.label`/`open.action` = **WPS**，「用 WPS 打开」。
- 桥调用改为 `globalThis.__DSHM_BRIDGES__.openFileWithWps(absolutePath)`；
  状态映射：`ok`→成功、`empty`→空路径、`nowps`→未装 WPS、其它→错误（带原文）。

### 3.2 ArkTS 桥（`entry/src/main/ets/pages/WebApp.ets` → `openFileWithWps`）

```
path ──(空?)──> 'empty'
   ├─ bundleManager.getBundleInfo('cn.wps.office.hap')  // 仅 17700001 才判 'nowps'
   ├─ copyFileSync(path → ${filesDir}/cache/wps-open/<name>)   // 只拷贝，不动原文件
   ├─ uriFromPath(copy) → file://whale.jwh.chat/...
   └─ startAbility(Want{
        bundleName:'cn.wps.office.hap', abilityName:'PromeAbility',
        action:'ohos.want.action.viewData', entities:['entity.system.browsable'],
        uri, type: mimeTypeForName(name),
        flags: FLAG_AUTH_READ_URI_PERMISSION | FLAG_AUTH_WRITE_URI_PERMISSION })
```

**为什么先拷进沙箱**：WPS 是另一个应用，传给它的 URI 必须「可委托读取」。
工作区文件（`/storage/Users/...`）本应用读得到，但不保证能托付给第三方应用 ——
之前的**系统预览**窗就是在这里报「预览失败 / 该文件可能已移动或重命名」
（`diag-file-preview` 里桥侧全是 `ok`，失败发生在系统预览应用读 URI 那一步）。
拷进本应用沙箱 + 委托授权后 WPS 就能读。

**为什么是 `PromeAbility` + `viewData`**：设备实测其 skills 声明了
`ohos.want.action.viewData` / `editData` 与 `linkFeature:"FileOpen"` ⇒ WPS 认的打开入口。

### 3.3 版本（`hostcore/core-recipe.json`）

`coreVersion: 0.2.1-alpha.4+whale.7` —— **核心树内容变化必须升 `+whale.N`**，
否则设备目录名不变 ⇒ 不重新解压 ⇒ 插件还是旧的（`pack-core` 也不会重新物化）。

---

## 4. 真机证据（2026-10-17）

`diag-file-wps`（应用 files 目录）：

```
02:44:43 request …/App电子版权认证证书介绍和办理流程.docx → ok file://whale.jwh.chat/…/cache/wps-open/…
02:44:55 request …/tmp/24年五中录取线.xls                 → ok …
02:45:02 request …/tmp/大东关店纪要.docx                   → ok …
02:45:11 request …/全国现代设施农业建设规划.pdf           → ok …
```

用户实测：**doc/docx/xls/xlsx 点「用 WPS 打开」均正常拉起 WPS**；PDF 仍用内置内嵌预览。

---

## 5. 已知边界（写清楚，别当成 bug）

| 边界 | 说明 |
|---|---|
| **改的是副本** | WPS 打开的是 `cache/wps-open/` 里的副本；在 WPS 里编辑/另存**不会回写原文件**（预览定位） |
| 副本累积 | 同名覆盖；不同名的历史副本会留在 `cache/wps-open/`，可按需加清理 |
| PDF 页签的入口 | 本插件还会在 `.actions` 槽注册入口；如需"PDF 页签不显示 WPS 按钮"要按当前预览实现 id 收窄 |
| 未装 WPS | 明确返回 `nowps` → 「没找到可用的 WPS 客户端（cn.wps.office.hap）」 |
| 大文件 | 每次打开都会整拷贝一次（Office 文档通常 < 20 MB，可接受） |

---

## 6. 出包注意（本轮踩实）

1. **升 `coreVersion`**（见 §3.3）；2. 换 stage 目录名后 **`rm -rf entry/.cxx`**（ninja 引用旧路径，AGENTS.md 已记）；
3. 门禁 `node tools/check-resfile-core-zip.mjs` 必须"resfile 只有 1 份容器且与产出一致"；
4. 装机后**必须重启应用**才会解压新核心树。

## 7. 文件清单

| 文件 | 改动 |
|---|---|
| `hostcore/plugins/dshm-office-system-preview/lib/client.js` | 认领 9 后缀、文案 WPS、桥改 `openFileWithWps` |
| `entry/src/main/ets/pages/WebApp.ets` | 新桥 `openFileWithWps`（沙箱拷贝 + want + 委托授权 + 诊断）+ 导入 `wantConstant`/`bundleManager`/`Want` |
| `hostcore/core-recipe.json` | `coreVersion` → `0.2.1-alpha.4+whale.7` |
