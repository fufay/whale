# 127 · alpha.2 官方可选 bundle 对齐（启用 / 暂缓 / 冲突清单）

> 2026-10-28 ｜ 分支 `alpha2-phase1` ｜ 关联：`docs/126`（Phase 1–3）
> 原则：**官方默认能力尽量全量对齐**；与 Whale 端侧自有替代实现冲突的暂不启用，列在此文档末尾逐个决策；语音输入按用户要求跳过。

## 一、已启用的官方可选 bundle（2026-10-28）

| bundle | 提供的插件行 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-personalized-recommendations` | action-cards / creation-recommendations / plugin-recommendations（+ 3 个 client） | 新 UI：回答操作卡、创建推荐卡、插件推荐卡 |
| `@deepseek-ai/dsh-experimental-session-search` | optional-session-search / optional-session-query-sqlite / optional-tool-session-query | 会话全文搜索 |
| `@deepseek-ai/dsh-experimental-ralph-bundle` | optional-ralph / optional-ralph-workflow / tool-ralph | Ralph 实验工作流 |
| `@deepseek-ai/dsh-experimental-badge-skill-bundle` | skill-badge | 技能徽章 |
| `@deepseek-ai/dsh-experimental-session-titles-bundle` | session-title-llm / optional-session-title-all-prompts | 会话标题（LLM 生成，会消耗 token） |
| `@deepseek-ai/dsh-experimental-cot-translation-bundle` | translator / cot-translation | CoT 翻译 |
| `@deepseek-ai/dsh-experimental-auto-review` | auto-review | 自动 review（会消耗 token） |
| `@deepseek-ai/dsh-experimental-tool-worktree` | worktree / tool-worktree | git worktree 工具 |
| `@deepseek-ai/dsh-experimental-liveshare` | liveshare-viewer-declarations / liveshare-share-host | Live Share |
| `@deepseek-ai/dsh-experimental-forge-bundle` | forge / forge-github / forge-session / optional-forge-panel / forge-worktree / forge-panel | Forge 实验面板 |

另：`dsh-experimental-client-ui-stats` 以单行方式挂在 profile（见 `docs/126 §11.5`）；新 UI 的 `entry-customization` / `message-quotes` / `file-drag` / `deliverable-file-references` 已随 `dsh-web-app` 默认启用。

**真机验证（2026-10-28 22:21）**：`/plugins/…` 下发清单已包含
`dsh-client-ui-action-cards`、`dsh-client-ui-creation-recommendations`、`dsh-client-ui-plugin-recommendations`、
`dsh-experimental-client-ui-agent-team`、`dsh-client-ui-plugin-market`、`dsh-experimental-client-ui-stats`、
`dsh-experimental-client-ui-cot-translation`、`dsh-experimental-liveshare`、`dsh-experimental-client-ui-forge`；
全部 `status=200`，Host 页/API 200，无致命错误。

## 二、暂缓/冲突清单（按用户要求"暂保留现状，最后逐个看"）

| bundle | 为什么暂不启用 | 现状 |
|---|---|---|
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | 用户明确跳过；且其 4 行（`speech-to-text` / `speech-to-text-sensevoice` / `api-speech-to-text` / `ui-voice-input`）与 Whale profile 自有行**id 重复** | 保持 Whale 自有语音实现 |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | 与 Whale 终端定制冲突：profile 现有 `terminal-bash`（shellPath=zsh 等端侧适配）、`tool-pwsh`、`terminal-pwsh` 行；该 bundle 另起 `optional-terminal-*` 体系，需人工比对是否重复/覆盖 | 保持现有终端 |
| `@deepseek-ai/dsh-experimental-plugin-market-bundle` | 与 Whale 自有市场链路（`dshm-market-bridge` + `dshm-profile-pnpm` + 假壳 pnpm 安装队列）语义重叠；官方 bundle 的 `plugin-market`/`ui-plugin-market` 是否接管 UI 未评估 | 保持 Whale 市场链路 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 其行 `tool-subagent` / `tool-subagent-control` / `tool-subagent-fork` 与 `dsh-web-app` 默认行**id 重复**，直接挂可能重复注册 | 保持现状（但 client `experimental-client-ui-agent-team` 已随其它包下发） |
| `@deepseek-ai/dsh-experimental-inspector-profile` | 含 DevTools inspector（端侧不需要），且 `client-ui-stats` 与我们已单挂重复 | 只挂 stats，不挂 inspector |
| `@deepseek-ai/dsh-cua-bundle` | `platforms: ["darwin"]`（macOS Computer Use） | 平台不适用 |
| `@deepseek-ai/dsh-subagent-codex` / `dsh-subagent-claude-code` | 需要宿主侧 codex / claude CLI 与登录态，端侧无 | 暂缓 |

## 三、实现方式

- `hostcore/profile/ondevice/package.json` 的 `dsh.profile.bundles` 追加上述 9 个 bundle；
- Host `ensureProfile()` 每次启动按"种子顺序 + 用户新增 − removeBundles"合并，**无需清数据**；
- 新核心树已 `pack-core --skip-install --place-in-app` 并重出调试 HAP（`e65ae8ac…`），真机已装。

## 四、注意

1. `session-titles` / `auto-review` 会**实际消耗 token**（用户成本敏感，可随时在插件页关）；
2. Forge/LiveShare/Worktree 属实验能力，真机功能待用户点验；
3. 冲突项决策时逐条对照 Whale 自有实现（语音、终端、市场、subagent 团队），不一次性全开。

## 五、Forge / gh 端侧配置（2026-10-28 实测修正）

- 端侧 gh（brew `gh 2.103.3`，静态 aarch64 + `.codesign`）可用；profile 里已给
  `forge-github` 配 `ghCommand: /storage/Users/currentUser/.harmonybrew/bin/gh`；
- gh 在本机把凭据放在 **`$HOME/gh/hosts.yml`**（不是 `~/.config/gh`；宿主机 zsh 的 HOME 也可能落在某个应用沙箱里）；
- **可用的做法**：直接在**新 Whale 的终端**里重新 `gh auth login`（或 `gh auth login --with-token`），
  凭据会写进 Whale 沙箱的 `$HOME/gh/hosts.yml`，Forge 的 gh 子进程（HOME=沙箱）即可直接读取；
- **不可靠的做法**：从宿主机复制 `hosts.yml` 到 Whale 沙箱——实测即使复制过去，
  gh 仍可能因 token/状态校验失败（用户实测需在 Whale 终端重新 auth 才生效），不要作为标准流程；
- 验证：在新 Whale 终端 `gh auth status` 显示 `Logged in to github.com account <user>`；随后打开 Git 仓库会话看右侧 Forge 面板。

## 六、冲突项决策（2026-10-28 用户逐条确认）

| 项 | 决策 | 说明 |
|---|---|---|
| `voice-input-bundle` | **跳过** | 用户明确跳过；与 Whale 自有语音行 id 重复 |
| `terminal-bundle` | **保持现状** | 保留 Whale 现有终端设置（zsh/shellPath 等）；除非将来开放 PTY 再改 |
| `plugin-market-bundle` | **保持现有路线** | 继续用 `dshm-market-bridge` + profile-pnpm 假壳通道 |
| `agent-team-profile` | **已启用（2026-10-28 用户决定）** | 实验性 **Agent Teams** bundle：挂 `agent-team`（maxMembers 8/maxTasks 256）+ `tool-agent-team` + `ui-agent-team`，并**禁用**现有 `tool-subagent`/`-control`/`-fork`，用团队工具取代直接子代理工具；真机已验证 client.js 下发 200、pluginManager listBundles/listPlugins 200 |
| `inspector-profile` | **略过** | 含 DevTools inspector；stats 已单独挂 |
| `cua-bundle` | **不适用** | 仅 macOS（darwin） |
| `subagent-codex` / `subagent-claude-code` | **不做（2026-10-28 用户决定）** | 两者是官方 npm 包（0.2.2-alpha.2）但**不在 dsh meta 依赖里**，需额外安装；`subagent-codex` 依赖 `@openai/codex` 的 linux-arm64 平台二进制，`subagent-claude-code` 依赖 `@anthropic-ai/claude-agent-sdk` 的平台二进制 optionalDependencies；OHOS 无对应平台包。brew 的 `codex` formula 虽存在（0.163.0），但 caveat 明确**禁用 app-server daemon**（hmdfs 不支持 UDS），而 provider 需要 `codex app-server --stdio`；`claude-code` 无 brew formula。⇒ 需要单独做"平台二进制移植 + 签名 + 登录"实验，暂缓 |

### 6.1 Agent Teams 是什么

`@deepseek-ai/dsh-experimental-agent-team-profile` = 上游实验性的 **Agent Teams 协作** 组合：

- `agent-team`：一个会话内可有多名成员（`maxMembers: 8`）、任务板（`maxTasks: 256`）、成员间消息；
- `tool-agent-team`：给模型的团队工具（`freshProvider: spawn` / `forkProvider: fork`）；
- `ui-agent-team`：Web UI 的团队视图（client 已随其它包下发）；
- 关键：该 bundle 会 `disabled: true` 掉现有 `tool-subagent-control` / `tool-subagent` / `tool-subagent-fork` 三行，**用团队工具替代直接子代理工具**——属于交互方式变更，不是纯增量。

### 6.2 2026-10-28 追加

- `agent-team-profile` 已加入 `hostcore/profile/ondevice/package.json` 的 bundles（放最后，确保其 `disabled: true` 的 tool-subagent* 补丁在 web-app 之后生效）；
- 真机验证：`dsh-experimental-client-ui-agent-team/client.js` 已下发 200；`pluginManager/listBundles` 200；
- 调试 HAP：`7799096435…`；Agent Teams 的团队视图/团队工具待用户点验；
- `subagent-codex` / `subagent-claude-code` 按用户决定**不做**（平台二进制/brew app-server 限制见 §六）。
