# T22 pi 适配（第三个 Agent）

范围：
- 新增 `packages/server/src/pi/**`（含测试）。
- 小改（先重新读取再改，只做最小增量；另一会话也在改仓库）：`packages/protocol/src/messages.ts`（`AgentKind` 加 `'pi'`、`codex.open` 参数加 `piPath?`）、`packages/server/src/daemon.ts`（`hosts` 加 `pi`，`codex.open` 透传 `piPath`）、`apps/desktop/src/shared/backendApi.ts`（`AgentKind` 加 `'pi'`）、`apps/desktop/src/renderer/src/lib/agents.ts`、`components/AgentIcon.tsx`、`store/rateLimits.ts`、`components/RateLimitBadge.tsx`（pi 无额度接口：不显示额度）、`apps/desktop/src/backend/targets.ts`（`agentOf` 识别 pi）。
- 手机端 `apps/mobile/web/src/types.ts`、`transport.ts` 只在类型需要时加 `'pi'`，不做界面。
- 不改 `packages/server/src/claude/**`、`codexHost.ts` 的行为（可以 import 复用其纯函数/类型）。

依据：**先读 `docs/agent-adapters.md`（合规红线，必须遵守）**、`docs/mvp.md` §11（Claude 适配的做法，pi 照此结构）、`packages/server/src/claude/bridge.ts` / `items.ts` / `v2.ts`（v2 映射与 AgentHost 实现范例）。pi 的官方 RPC 文档在本机：`C:\Users\Administrator\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\`（`rpc.md`、`rpc-commands.md`、`json.md`、`message-types.md`、`sessions.md`、`session-format.md`、`windows.md`）。本机已装 pi 1.6.1（`pi --mode rpc`）。

原则（摘自合规规范，必须满足）：
- 只经 pi 官方 RPC 模式（`pi --mode rpc`，JSONL over stdio）驱动用户已安装的 pi；可执行文件只解析（参数 `piPath` → PATH → 常见目录），不下载、不安装、不升级。
- **不读、不复制、不解析 pi 的凭据/认证文件**（如 `~/.pi/agent/auth.json`、models 里的 key）；不注入用户没配置的环境变量；登录与模型/提供方配置一律由用户在 pi 自己里完成，QingCode 只提示。
- pi 本身没有审批机制：**不得伪造审批**。界面需明确标注"pi 不经审批直接执行工具"（在 agent 能力里返回 `approvals:false`，由前端显示提示；本卡只需在 `codex.open` 结果里给出能力字段 `capabilities: { approvals: false, rateLimits: false }`）。
- 探测只允许 `pi --version`；后台不开会话、不发 prompt。
- 日志不输出 prompt 以外的敏感内容，走已有 redact。

实现：

1. `pi/resolve.ts`：解析 pi 可执行文件（Windows：`pi.cmd` / `pi.ps1` / `pi.exe`，`.cmd` 需按现有 claude/codex 的转义做法 spawn；POSIX：`pi`），`--version` 取版本。
2. `pi/rpc.ts`：一个 pi RPC 进程的封装（spawn `pi --mode rpc`，cwd = 会话 cwd；按 `rpc.md` 的分帧与 id 关联；命令/响应/事件分流；进程退出清理）。纯解析（行分帧、记录分类）写单测。
3. `pi/host.ts`：实现 `AgentHost`（见 `codexHost.ts` 接口与 `claude/bridge.ts` 范例），对客户端说 Codex v2 JSON-RPC（与 Claude 桥一致，renderer 无需特判）：
   - `thread/list`（按 cwd；数据来源优先 pi RPC 能提供的会话信息，必要时按官方公开的 `session-format.md` 只读解析会话文件，**只读会话内容，不碰认证文件**）、`thread/start`（`new_session`）、`thread/resume` / `thread/read`（`switch_session` + `get_messages`）、`turn/start`（`prompt`；支持文本输入，图片按 pi 文档支持情况决定，不支持就忽略并在报告说明）、`turn/interrupt`（`abort`）、`model/list`（`get_available_models`，可选）。
   - pi 事件 → v2 通知：`turn/started`、`item/started` / `item/completed`（agentMessage、reasoning、commandExecution（bash 工具）、fileChange（edit/write 工具，生成统一 diff）、其他工具 → dynamicToolCall）、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`turn/completed`（含失败/中断状态）、`thread/tokenUsage/updated`（若 pi 提供）。映射写成纯函数 `pi/items.ts` 并单测；**用真实 pi 录制一份事件样例**（`pi/fixtures/*.jsonl`，内容不得含凭据；可用简单 prompt 如"列出当前目录"，录制会消耗用户 pi 额度，控制在 1~2 次）做回放测试。
   - 不支持的方法返回 JSON-RPC `-32601`，并在 `pi/README.md` 列出"支持 / 不支持"决定表（合规 §8 第 7 条）。
   - 每个会话一个 pi 进程；空闲 30 分钟关闭；daemon 退出时结束全部子进程。多客户端广播与 seq 缓冲沿用 Claude 桥的 hub 用法。
4. `codex.open {agent:'pi'}` 返回 `{initialize:null, lastSeq, agentVersion, capabilities:{approvals:false, rateLimits:false}}`；pi 未安装时抛 `AgentHostError('agent_unavailable', ...)`，文案提示安装方式但不自动安装。
5. 前端最小接入：agent 列表/图标/名称加入 pi（名称显示 "pi"，图标用中性图形）；新建会话可选 pi；pi 会话不显示额度徽标；`capabilities.approvals === false` 时在输入框上方显示一行灰色提示"pi 不经审批直接执行工具"（若需要改 `Composer.tsx` 只加这一行，先重新读取文件）。
6. 在 `packages/server/src/e2e.test.ts` 同目录新增 `pi/e2e.test.ts`：用假 pi 进程（node 脚本模拟 RPC）跑通 open → thread/start → turn/start → 通知 → turn/completed；真实 pi 的集成测试用环境变量 `QN_PI_E2E=1` 显式开启，默认跳过。

验收：`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec tsc -p packages/protocol/tsconfig.json`、`pnpm --filter @qn/desktop typecheck`、`pnpm exec vitest run packages/server packages/protocol` 通过；`node packages/server/build.mjs` 打包成功；报告附合规检查清单（`docs/agent-adapters.md` §8 八条逐条回答）。
