# dshm-screen-pilot（Whale 内置插件 · 出包副本）

> **真源**：`Common/dsh-screen-pilot/`（唯一真源，改代码只改那里）。
> **本目录**：出包副本。`Common/whale/tools/pack-core.mjs` 会把这个目录**整目录**拷进核心树，
> 所以本目录的内容 = 最终 HAP 里带的插件。

## 2026-11-05 同步记录

- 同步内容：长连会话版本，**9 个文件**（`index.js` / `tools.js` / `screen.js` / `layout.js` /
  `input.js` / `png.js` / `hdc.js` / `session.js` / `relay.py`），与 `Common/dsh-screen-pilot/lib/`
  逐字节一致（`cmp` 核对全 SAME）。
- **不要只拷 `.js`**：漏 `relay.py` ⇒ 长连每次打开都失败并降级（每个 UI 工具调用多等十几秒）；
  漏 `session.js` ⇒ 插件 import 失败、加载不起来。

## 这版与 11-04 的差异（出包会话需要知道的）

1. **执行层**：设备命令改走 DSH 的 `ctx.shell` / 长连会话（不再用 Node `child_process`）。
2. **长连会话**：`lib/session.js` + `lib/relay.py`。
   Host 里 node-pty 子进程不加载 `LD_PRELOAD`（桥 shim 失效），所以长连 = `ctx.shell` 起常驻
   python relay（python 自己 `pty.fork` 跑交互式 `hdc shell`），插件用 unix socket + 换行 JSON 收发命令。
   懒开 / 空闲超时 / 显式 open·close / 失败不重试（只拆会话，下一条命令懒重建）/ 连续打开失败降级。
3. **审计修复**（对应 `Common/dsh-screen-pilot/docs/02-代码审计报告.md`）：
   - P0：命令写进 PTY 后**绝不重试**（不会重复点击/输入）；
   - P1：会话路径补 `[Fail]/[Empty]`/退出码检测；打开失败即降级；BUSY 保护；relay 错误归类；
     `ui_type` 文本 base64 落设备临时文件再传参；OPENING 期间 close 生效；单测/relay 测试补齐。
4. **工具数**：11 个 UI 工具 + 3 个会话工具（`ui_session_open` / `ui_session_close` / `ui_session_status`）= 14。

## 出包前检查清单

- [ ] `lib/` 共 9 个文件，`relay.py`、`session.js` 都在；
- [ ] 与真源 `Common/dsh-screen-pilot/lib/` 逐字节核对（`cmp`）；
- [ ] profile 里 shell/subprocess 执行器可用、`python3` 在 PATH、`$HOME/tmp` 可写；
- [ ] coreVersion 递增（出包流程见 `Common/whale/HANDOFF` / `pack-core.mjs`）；
- [ ] 出包后真机验证：`ui_session_open` → `screen_windows`（应 ~50–100ms）→ `ui_session_close`，
      确认无 relay/hdc 残留进程与 `.sock` 残留。

## 已知限制

- `hdc file recv` 仍是 Host 侧一次性调用（截图总延迟 = 会话抓图 + recv ~200ms）。
- `pack-core.mjs` 目前**没有**“`relay.py` 必须存在”的门禁，靠本清单人工核对；后续可加。
- `sessionStatus.pid` 由 relay 自报（`relayPid`），不是 ctx.shell 句柄的 pid。
