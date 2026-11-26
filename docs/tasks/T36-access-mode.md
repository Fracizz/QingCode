# T36 访问模式选择器 + T38 Agent 配置目录生效（同一 Agent 顺序完成）

两部分都改 server 的 Agent 启动/会话参数，放在同一张卡里顺序做，避免并行冲突。

范围：
- 渲染：新增 `apps/desktop/src/renderer/src/features/access/**`（含测试）；`components/Composer.tsx`（接入点，先重新读取：T35 刚改过）；`store/codex.ts` 中 `openParams` 与组装 `turn/start` 的位置（先重新读取）。
- server：`packages/server/src/codexHost.ts`、`packages/server/src/claude/**`、`packages/server/src/pi/**`（只在需要标注能力时）（含测试）。
- protocol：`packages/protocol/src/messages.ts` 中 `codex.open` 的 params 只追加字段。
- `apps/desktop/src/backend/mobile/gateway.ts`、`gateway.test.ts` 仅用于沿用电脑端配置目录并过滤手机请求中的配置目录与本任务新增的权限字段。
- 其他 backend（`server.req` 原样透传）、手机端与 `packages/server/src/terminal/**` 不在本卡范围。仅在 `daemon.ts` 的 `codex.open` 中透传配置目录。

依据：**`docs/agent-adapters.md` §6 审批与权限**（核心：默认用 Agent 自身默认；提升到 `acceptEdits`/`bypassPermissions`/Codex `danger-full-access` 必须用户在会话内显式选择，且在输入框区域常驻标识；不得伪造 Agent 不支持的模式，R7/R8）。Codex v2 类型见 `vendor/codex-protocol/ts/v2/`（`TurnStartParams`、`SandboxPolicy`、`AskForApproval` 等，以实际文件为准）；Claude SDK 见 `packages/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`Options.permissionMode`、`Query.setPermissionMode()`、`PermissionMode`）。设置模型见 `apps/desktop/src/renderer/src/features/settings/settingsModel.ts`（`agentPrefs` 的 `configDir`）。

## 第一部分：T36 访问模式选择器

1. 输入框工具行加"访问模式"选择（与模型选择器并列，风格一致）：
   - Codex：映射到 v2 `turn/start` 的审批策略 + 沙箱策略覆盖项，提供 Codex 自身支持的档位（如：只读 / 默认（工作区可写，按需审批）/ 完全访问）。默认＝不发覆盖项（用 Codex 自身配置）。
   - Claude：`default` / `acceptEdits` / `plan` / `bypassPermissions`（以 SDK 类型为准）。新会话放进 `query()` 的 `options.permissionMode`；已有会话下一轮前用 `setPermissionMode()`。桥接从 `turn/start` 的覆盖项读取（字段名在报告说明；尽量复用 v2 已有字段，例如把 Claude 模式表达为 v2 的审批/沙箱组合，表达不了时加一个明确的扩展字段）。
   - pi：没有审批机制，不显示选择器，只显示常驻标签"无审批：工具直接执行"。
2. 选择按"会话"记（草稿态的选择随第一条消息带入新会话）；切换会话恢复各自选择；不跨会话、不跨目标继承提升的权限，新会话总是从默认开始。
3. 非默认档位在输入框区域**常驻醒目标识**（如"完全访问"用警示色）；选择 `bypassPermissions` / 完全访问时弹一次确认说明风险。
4. 产品代码不得出现任何自动应答审批的逻辑；审批卡片照旧由用户点。
5. 纯逻辑（档位定义与映射、会话记忆）写单测；server 侧 overrides 应用到 options / `setPermissionMode` 用假 Query 单测；Codex 侧确认覆盖项按 v2 字段原样转发。

## 第二部分：T38 配置目录生效

1. `codex.open` params 追加 `codexHome?: string`、`claudeConfigDir?: string`。渲染进程 `openParams` 从 `agentPrefs(settings, targetId, agent).configDir` 取值（非空才传；只传给对应 Agent）。
2. server：Codex app-server 子进程以 `CODEX_HOME=<codexHome>` 启动；Claude 的 SDK `query()` 通过 `options.env`（在 `process.env` 基础上）设置 `CLAUDE_CONFIG_DIR`。**只设置环境变量，不读取、不复制、不修改该目录内任何文件**（R1/R8）。
3. 值与当前运行中的进程不一致时：Codex 若无活动 turn 则重启 app-server 生效，有活动 turn 则返回明确错误（如 `config_dir_busy`）提示稍后再试；Claude 新 query 自然生效。不同目标互不影响（每个目标一个 daemon）。
4. 单测：参数校验（只接受非空字符串、绝对路径）、环境拼装、重启判定。

验收：`pnpm --filter @qn/desktop typecheck`（若仍因 T28 的 `gateway.test.ts` 失败，单独跑 `cd apps/desktop && pnpm exec tsc -p tsconfig.web.json` 并在报告说明）、`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec tsc -p packages/protocol/tsconfig.json`、`pnpm exec vitest run apps/desktop/src/renderer/src/features/access packages/server/src/claude packages/server/src/pi packages/server/src/codexHost` 通过（codexHost 测试文件名以实际为准）；`node packages/server/build.mjs` 成功；报告附 `docs/agent-adapters.md` §8 检查清单。
