# 137 — 修复：侧栏 Office 预览全部失效（资源地址 armor 补丁漏 `.hostname`）

> 日期：2026-11-14 · 影响版本：**v1.1.8 / coreVersion `0.2.2-rc.2+whale.1`**（v1.1.7 不受影响）
> 修复版本：**v1.1.9 / coreVersion `0.2.2-rc.2+whale.2`**

## 1. 现象（用户报告）

侧栏点 `doc/docx/ppt/pptx/xlsx` **没有任何反应**（右侧预览面板不出现/不渲染）。
宿主侧完全静默：`/api/workspaceFiles/*`、`/api/officeToPdf|officeKit/*` 一条请求都没有。
用户以为是当天新装的 `dsh-obscura-skill` 插件导致 —— **无关**（该插件在客户端 bundle 列表里 0 条目）。

## 2. 根因

`tools/pack-core.mjs` 的 `patchResourceAddressArmor()` 在给 **rc.2 压缩产物**打补丁时，
压缩形态分支把 host 写成了 `${h}`（URL 对象）而不是 `${h}.hostname`（字符串）：

```js
// 坏形态（v1.1.8 出包时的实际代码，dsh-client-resources/lib/client.js）
function protocolOf(address){
  let parsed; try{parsed=new URL(address)}catch{return}
  if(parsed.protocol!==`${`dsh-resource`}:`)return void 0;
  return (()=>{
    const armor=/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu.exec(address);
    const host=parsed===``?(armor===null?``:armor[1]):parsed;   // ← parsed 是 URL 对象
    return host===``?void 0:host.toLowerCase()                   // ← TypeError
  })()
}
```

任何 `dsh-resource://<authority>/<path>` 地址解析都会抛
`TypeError: host.toLowerCase is not a function` ⇒ 引用资源地址的**文档预览页签**
（`sidebar.right.pane.tab`，由 `dsh-client-ui-sidebar-documentpreview` 注册）渲染崩溃
⇒ 点 Office 文件"没反应"，且 client 侧一个请求都发不出去。

## 3. 证据

| 证据 | 读数 |
|---|---|
| WhaleX 客户端控制台（`<files>/diag-web-console`） | 反复 `L4 ... slot entry crashed in 'sidebar.right.pane.tab': TypeError: host.toLowerCase is not a function` |
| 设备核心树 | `cores/0.2.2-rc.2+whale.1/node_modules/@deepseek-ai/dsh-client-resources/lib/client.js` 即上面坏代码 |
| 发布容器 | `dsh-core-0.2.2-rc.2+whale.1-…zip` 内同文件同形态（⇒ v1.1.8 发布件同样坏） |
| rc.1 核心（v1.1.7） | 补丁是**未压缩源码形态**，`const host = armor===null ? parsed.hostname : armor[1]` ⇒ 正常 |
| 宿主日志时间线 | 最后一次成功预览在 **11-12 11:45（rc.1）**；11-12 19:54 换 rc.2 后 `/api/workspaceFiles/*` **0 次** |
| 今天装的插件 | 客户端 bundle URL 列表里没有它；宿主日志仅 4 条（都是它文档里的 png 路径），无插件行 |

## 4. 为什么 11-12 的门禁全绿没拦住

`tools/check-core-openharmony-patches.mjs` 对三处装甲只有 3 条判据：
**标记在 ×N / patched 片段在 / upstream 原文不在**。坏形态三条全满足
（`host===``?void 0:host.toLowerCase()` 片段仍在、标记仍在、上游原文已消失）
⇒ 属于"**注入形态对了、注入代码语义错了**"这一类盲区，不是上游漂移。

## 5. 修复

1. `tools/pack-core.mjs` 压缩分支：
   ```js
   const host=${h}.hostname===``?(armor===null?``:armor[1]):${h}.hostname;
   ```
2. `tools/check-core-openharmony-patches.mjs`：
   - 新增**语义判据** `mustContain: ['parsed.hostname===``?(armor===null?``:armor[1]):parsed.hostname;']`、
     `forbidden: ['?``:armor[1]):parsed;']`（坏形态一出现即红）；
   - 新增负测试 `M0`：把坏形态塞回去，断言审计必须红（证明语义判据不是摆设）。
3. `hostcore/core-recipe.json`：`coreVersion` → `0.2.2-rc.2+whale.2`；
   `AppScope/app.json5` → `1.1.9 / 1010009`。

## 6. 产物与门禁（2026-11-14 实测）

- 核心容器：`dsh-core-0.2.2-rc.2+whale.2-openharmony-arm64.zip`
  **152,790,798 B / 57,885 条目 / sha256 `80ee08c106f243d8e13725aecad2850a5c6807ffb675960b1ae0bc7b5dccd102`**，已 place 进 resfile（旧容器自动清除）。
- **与旧容器逐条目比对只变 3 项**：`client-resources/lib/client.js`（+18 B，两处 `.hostname`）、`package.json`（版本依赖）、`dshm-core.json`（版本元数据）⇒ 最小 diff，其余 57,882 条目逐字节一致。
- 门禁：补丁 **163 通过 / 0 失败**（+2 语义判据）；`resfile-core-zip` / `entrypoints` / `resfile-sync` / `office2pdf-wiring` / `rg-selfsigned` / `exec-fix` 全过。
- 本机验证件：`whale-verify-1.1.9-vc1010001.hap` **440,166,234 B** sha256 `9d4c2770202cad57cb8d90788343812d834b50366539fd33f1138bb4af624384`（versionCode 1010001，已 `install -r`）。
- 发布件（未签名）：`dist/release/whale-unsigned.hap` **437,791,078 B** sha256 `b0dbe0bd047a80dd12d36b36748e75ae19e13e190ab2fc89f1b4eb639dcc70c0`（124 条目全 STORED、无签名条目、内嵌新容器 sha 与上一致）。

## 6.1 真机验证（2026-11-14 15:30，用户重启 WhaleX 后）✅

- 设备核心树切到 **`0.2.2-rc.2+whale.2`**（`dshm-core.json` 读数）；旧树 `+whale.1` 仍在 `cores/` 下（可另行清理）。
- 宿主日志出现修复后的完整链路（此前一条都没有）：
  `/api/officeKit/generation` → 200、**`/api/officeKit/render` → 200（248 ms / 11,771 ms）**、
  `/api/workspaceFiles/{readBytes,stat}` → 200；`POST /dshm-office2pdf/convert` 命中数 **8 → 12**。
- 用户确认：侧栏 **docx / pptx / xlsx 恢复渲染**。

## 7. 经验

- **"注入片段在" ≠ "注入代码语义正确"**：门禁对"注入型补丁"至少要有一条语义断言（此处是 `.hostname`），
  否则补丁自己写错时全部门禁都会绿着放行并发出 Release。
- 负测试要覆盖**同一类**失败：`M0` 专门覆盖"标记与片段都在、只有语义错"的形态。
- 客户端崩溃不一定进宿主日志：端侧要先用 `<files>/diag-web-console` 看 JS 控制台，再看宿主日志。

## 8. 顺手修掉的既有红：门禁 `--self-test` 的 M10（2026-11-14）

rc.2 换核时留下的既有红（**不是**本次 Office 事故引入，v1.1.8 时已如此）：
`DEDUP_UPSTREAM_RESTORED` 那 4 条"上游原文"是**可读源码形态**的字符串，rc.2 压缩产物里已不存在；
审计侧当时用"文件是压缩产物 ⇒ 跳过逐字判据"绕开，于是 M10（把上游原文逐条改写、要求 4 条各自红）
的变异**一条都改不到** ⇒ `positives=0/4` ⇒ self-test 红。

修法：判据表改成**双形态**（每条给「源码形态 + 压缩形态」两种写法，任一命中即算已恢复），
审计不再按"是否压缩"跳过；M10 与 M10 复核改为调用 `mutateDedupRestored()`（只改树里实际存在的形态，
且"一条都没命中"直接抛错 ⇒ 判据表与树脱节时会立刻暴露）。

读数：审计 **166 通过 / 0 失败**（原 163，+3 = 撤除守卫 4 条正向判据替代原来的 1 条"压缩产物跳过"）；
`--self-test` **155 用例 / 0 不合格**（PASS）。
