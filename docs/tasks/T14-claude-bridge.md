# T14 Claude 桥（server）+ 协议 agent 字段

范围：`packages/server/src/claude/**`（新增）、`packages/server/src/codexHost.ts`/`daemon.ts`（按 agent 分发的最小改动）、`packages/server/build.mjs`（SDK 打包配置）、`packages/protocol/src/**`（新增可选 `agent` 字段）。依赖：`@anthropic-ai/claude-agent-sdk@0.3.332`（已装在 packages/server）。

依据：`docs/mvp.md` §11（逐条实现，映射表为准）；类型参考 `vendor/codex-protocol/ts/v2/*`（Thread、Turn、ThreadItem、各 Notification、CommandExecutionRequestApprovalParams 等），SDK 类型读 `node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts`（以实际 .d.ts 为准，与 mvp 描述不符时按 .d.ts 并在报告说明）。

## 要做

1. 协议：`codex.open/attach/status` params 与 `codex.send/recv` 增加可选 `agent`（`'codex'|'claude'`），解析与类型同步、单测补充；缺省等同 `codex`，旧客户端不受影响。
2. daemon：按 agent 持有各自的 host（现有 codexHost 抽象为通用"JSON-RPC agent host"接口，Codex 实现保持不变）；seq、ReplayBuffer、未决请求按 agent 隔离；`codex.status` 返回对应 agent 的状态；`codex.open {agent:'claude', claudePath?}` 返回 `{initialize, lastSeq, agentVersion}`，找不到 claude 时返回清晰错误码 `agent_unavailable`。
3. `claude/bridge.ts`：实现 mvp §11.3 的翻译（会话表、异步输入队列、turn 生命周期、中断、空闲关闭、错误恢复）；`claude/items.ts`：SDK 消息 → v2 item/通知的**纯函数**映射（重点单测）；`claude/history.ts`：`getSessionMessages` → v2 Thread/turns/items；`claude/approval.ts`：canUseTool ↔ server request 的转换（纯函数单测）；`claude/resolve.ts`：claude 可执行文件解析。
4. 构建：esbuild 打包 SDK 的 JS，排除 `@anthropic-ai/claude-agent-sdk-*` 原生包（external 或 stub），确认产物里没有几十 MB 的二进制；`qn-server.cjs` 体积变化写进报告。
5. 测试：
   - 单测覆盖 items/history/approval 映射（用手写的 SDK 消息样例，贴近 .d.ts）。
   - e2e：用一个假的 claude 可执行（Node 脚本，模拟 stream-json CLI 协议**不现实**时，改为在 bridge 层注入假的 `query` 工厂）跑 open → thread/start → turn/start → delta → approval → turn/completed → interrupt。
   - 真机：总管会在 10.87 上用真实 claude 验收，你提供 `packages/server/test/claude-probe.mjs`（参数 server 路径与 cwd；ensure → connect → `codex.open{agent:'claude'}` → attach → thread/start → turn/start"只回复两个字：你好" → 打印通知统计 → 再发一轮"用 Bash 运行 echo qn-ok"并对审批自动 accept → 打印结果）。

## 验收

`pnpm exec tsc -p packages/protocol/tsconfig.json`、`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec vitest run packages/protocol packages/server`、`pnpm build:server` 全部通过；Codex 原有 e2e 不回归。
