# T23 设置界面

范围：
- 新增 `apps/desktop/src/renderer/src/features/settings/**`（含测试）。
- 新增 `apps/desktop/src/backend/settings/**`（含测试）与 `apps/desktop/src/backend/registerSettings.ts`；`apps/desktop/src/backend/index.ts` 只加一行 `registerSettingsMethods(router)`（先重新读取再改）。
- `apps/desktop/src/shared/backendApi.ts` 只追加本卡的类型与方法（先重新读取，追加到对应位置，不改已有定义）。
- 新增 `packages/server/src/workspace/agents/**`（`agent.probe` 处理函数）并在 `packages/server/src/workspace/index.ts` 合并登记一行；`packages/protocol/src/workspace.ts` 追加 `agent.probe` 的类型。
- **不得修改**其他已有文件（另一会话在并行改 `App.tsx`、`TargetForm.tsx`、侧栏等）。接入（侧栏/标题栏放齿轮入口、Ctrl+, 快捷键）由总管完成，你只导出集成点。

依据：`docs/design/ui-shell.md`（视觉与组件规范：Radix 浮层经 `components/primitives.tsx`，拖动用 `ResizeHandle`，主题 token 见 `styles.css`）、`docs/agent-adapters.md`（合规：§3.2 认证归属、§3.3 Claude 订阅灰区与推荐 API key 路径、§5 品牌文案、§7 只允许 `--version` 探测）。可只读复用 `components/ui.tsx`、`components/primitives.tsx`、`lib/cn.ts`、`components/MobileSettings.tsx`（手机连接设置的现有内容，可直接嵌入其内部组件；若它只导出对话框形态，就新建一个只读包装，不改原文件）。

功能（参考 Codex 桌面版 / VS Code 设置的形态：全窗口模态，左侧分类导航 + 右侧表单，带搜索框过滤设置项）：

1. **通用**：发送快捷键（Enter 发送 / Ctrl+Enter 发送）、启动时自动连接上次使用的目标、新会话默认 Agent（codex / claude / pi）、界面密度（舒适 / 紧凑，写入 `html[data-density]`，只提供 token 钩子）、主题（目前仅深色，浅色置灰标"即将支持"）。
2. **Agent**（按目标分组：本机 + 每个已保存的远端目标；目标未连接时显示"连接后检测"）：
   - 每个 Agent（Codex / Claude / pi）一行：启用开关（关闭后不在新建会话里出现）、可执行文件路径（留空=自动解析）、"检测"按钮 → server `agent.probe {agent, path?}`（只运行 `<exe> --version`，返回 `{found, path, version?, error?}`），显示版本或未找到。
   - Codex / Claude 可为该目标设置 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`（合规 §3.2 允许的官方多配置方式；只保存路径字符串，不读取其中内容；**不提供**自动切换/轮换）。本卡只负责保存设置；传给 server 的部分由总管接入时处理，在 README 说明数据形状。
   - 登录说明（静态文案，不检测凭据）：Codex"在终端运行 `codex login`"；Claude"在终端运行 `claude` 后输入 `/login`，或在 Claude 自身配置 API key / Bedrock / Vertex"，并按 §3.3 提示"订阅登录仅限本人自用，推荐 API key"；pi"在终端运行 `pi` 完成提供方配置"。
   - pi 行显示能力说明"pi 不经审批直接执行工具"。
3. **连接**：只读列出已保存目标（名称、类型、地址），提供"编辑""删除"按钮——通过 props 回调交给宿主（`onEditTarget(target)`、`onRemoveTarget(id)`），本卡不实现表单。
4. **手机连接**：嵌入现有手机连接设置内容。
5. **关于**：应用名称与版本（`backendConfig.appVersion` 经 `settings.get` 带回或新方法 `app.info`）、第三方声明（§5：QingCode Next 是第三方客户端，与 OpenAI、Anthropic 无隶属关系，用量计入用户自己的账号）、开源组件说明占位。

数据：
- backend `settings.get` → `AppSettings`，`settings.save(partial)` → `AppSettings`（深合并、白名单字段、未知字段丢弃）；文件 `userData/settings.json`，原子写入；损坏时回退默认值。纯函数（默认值、合并、校验）单测。
- `AppSettings` 形如 `{ general: {sendKey, autoConnectLast, defaultAgent, density}, agents: { [targetId]: { codex?: AgentPrefs, claude?: AgentPrefs, pi?: AgentPrefs } } }`，`AgentPrefs = { enabled: boolean; path?: string; configDir?: string }`。
- renderer `settingsStore.ts`（zustand）：加载、乐观更新 + 保存失败回滚、`useSetting(selector)`。

集成点（`features/settings/index.ts` 导出）：`SettingsDialog`（props：`open`、`onClose`、`initialSection?`、`onEditTarget`、`onRemoveTarget`）、`useSettings`、`openSettings(section?)` / `useSettingsDialog`（全局开关状态，供侧栏按钮和快捷键调用）。本目录 `README.md` 写接入方式与数据形状。

验收：`pnpm --filter @qn/desktop typecheck` 中本卡文件无错误（其他文件错误来自并行改动，忽略并注明）；`pnpm exec tsc -p packages/server/tsconfig.json` 通过；`pnpm exec vitest run apps/desktop/src/renderer/src/features/settings apps/desktop/src/backend/settings packages/server/src/workspace/agents` 通过。
