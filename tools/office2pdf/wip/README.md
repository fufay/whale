# wip/ · 未采用的实现（归档，不参与构建）

这里放**试过但没采用**的代码，保留原因是它们记录了大量实测结论；**不会被任何构建读到**
（`pack-core` 只拷 `hostcore/plugins/dshm-office2pdf/lib/` 下的现行文件）。

---

## `client.js.button-attempt` — 工具栏「用其他应用打开」按钮（2026-10-29 撤回）

**想做的事**：在文档预览工具栏（刷新图标旁）加一个图标，调
`__DSHM_BRIDGES__.openWithSystem(path)` 把当前预览的文件交给系统「选择打开方式」。

**怎么做的**：
- 槽位选 `sidebar.right.tab.document.action`（上游 `documentpreview/lib/client.js:959` 的 keyed 槽，
  `entryKey = selected.id`），为 7 种预览实现 id 各注册一条；
- 绝对路径：客户端先调宿主端点 `POST /dshm-office2pdf/resolve`
  （由插件宿主半边用 `workspaceFiles.stat()` 把 `dsh-resource://file/session/<sid>/<path>` 换成绝对路径）。

**为什么撤回**：
1. pdf/excel 上按钮**出现但点击报「拿不到文件路径」**（当时客户端自己解析 remote，失败）；
2. office 上按钮**根本不出现**（与上游自己的 `.action` 条目同 key 冲突）；
3. 最后一版更严重：**documentpreview 插件激活失败**，整个页面报
   `Failed to load plugins: @deepseek-ai/dsh-client-ui-sidebar-documentpreview … web boot: 1 entry did not activate`
   —— 应用起不来。**这是插件类改动最危险的失败模式**，必须零容忍。

**要重做的话（前提条件，别跳过）**：
1. 换**不冲突**的机制：先用 list 槽（如 `sidebar.right.tab.document.actions`）或与上游条目
   不同 key 的 keyed 槽；不要复用上游已占用的 `entryKey`；
2. 槽位注册必须在 `ctx.effect(() => { try { … } catch { return () => {}; } })` 里包住，
   **异常不能逃逸出 effect**（上游插件会因为我们的注册失败而整体激活失败）；
3. **先在离线环境验证**注册不抛错（例如在 `tmp/` 起独立 Host + 该插件，看 boot 日志
   `1 entry did not activate` 是否出现），再出包装机；
4. 出包前跑 `node tools/check-office2pdf-wiring.mjs` + 装机后确认
   `hilog | grep "did not activate"` 为空；
5. 路径解析仍建议走宿主端点（`/dshm-office2pdf/resolve`），不要客户端自己解析 remote。

**现状**：现行 `hostcore/plugins/dshm-office2pdf/lib/client.js` 是**空壳**（不注册任何东西），
正文渲染完全交给官方 office 实现 —— 这条链路已验证可用（见 `docs/130`）。
