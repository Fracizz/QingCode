# Agent 能力矩阵与通用层

> 状态：2026-11-27。记录 QingCode 对 Codex、Claude、pi 已经接入的能力。接入方式与红线见 [Agent 适配规范](agent-adapters.md)，冲突时以适配规范为准。

## 1. 通用层

| 内容 | 位置 |
|---|---|
| Agent 标识 `AgentKind` | `packages/protocol/src/messages.ts` |
| 能力声明 `AGENT_CAPABILITIES`、恢复命令 | `packages/protocol/src/agents.ts`（经 `@qn/codex-client` 转出） |
| 桥的公共部分（seq、回放、未决请求、轮次计数） | `packages/server/src/codexHost.ts` 的 `JsonRpcAgentHost` |
| 对话状态、审批与提问、MCP elicitation | `packages/codex-client/src` |

客户端与桥之间统一使用 codex app-server v2 的 JSON-RPC 形状。Codex 由 daemon 原样转发，Claude、pi 由各自的桥翻译。

### 新增或修改能力

1. 先查 Agent 的官方公开接口，没有就保持 `false`，不模拟。
2. 在桥里实现方法；不支持的方法返回 `-32601`。
3. 改 `AGENT_CAPABILITIES`。`packages/server/src/agentCapabilities.test.ts` 会核对 Claude、pi 的声明与实现。
4. 界面按能力决定入口是否可用，不新增 `agent === 'xxx'` 判断。
5. 更新本表。

存量的 agent id 判断还有很多，改到相关代码时顺手换成能力判断。

## 2. 能力矩阵

✓ 支持，◐ 部分支持，✗ 未接入，— Agent 本身没有。

| 能力 | Claude | Codex | pi | 说明 |
|---|---|---|---|---|
| 新建、恢复、列表、历史分页 | ✓ | ✓ | ✓ | |
| 归档 / 恢复 | ✓ | ✓ | ✓ | Claude、pi 由 daemon 记录 |
| 永久删除（仅桌面） | ✓ | ✓ | ✗ | Claude：SDK `deleteSession`；pi RPC 文档没有删除命令 |
| 重命名 | ✓ | ✓ | ✓ | Claude：SDK `renameSession`；pi：`set_session_name`，会启动会话进程 |
| 分支（fork） | ✓ | ✓ | ✓ | 手机端只有整会话分支与排队消息分支 |
| 回退并编辑重发（仅桌面） | ✗ | ✓ | ✗ | |
| 文件 checkpoint 回滚 | ✗ | ✗ | ✗ | |
| 流式正文、思考 | ✓ | ✓ | ✓ | |
| 工具卡片 | ◐ | ◐ | ◐ | 命令、改文件、子代理、压缩有专用展示，其余只显示名称 |
| 文件 diff | ◐ | ✓ | ◐ | Claude、pi 由工具参数合成，没有真实行号 |
| 计划 / TODO | ✗ | ✗ | ✗ | `turn/plan/updated` 未处理 |
| 中断 | ✓ | ✓ | ✓ | |
| 引导（steer） | ◐ | ✓ | ✓ | Claude 可能落到下一轮 |
| 审批 | ✓ | ✓ | — | pi 不经审批直接执行工具，界面如实标注 |
| Agent 提问 | ✓ | ✓ | ✓ | pi：扩展对话框 `select` / `confirm` / `input` / `editor` |
| MCP elicitation | ✓ | ✓ | — | 表单转问答卡片；无字段与网址请求只有允许、拒绝 |
| MCP 状态与管理 | ✗ | ✗ | — | 随 CLI 配置生效 |
| 访问模式 | ✓ | ✓ | — | 请求批准、替我批准、完全访问 |
| plan 模式 | ✗ | ✗ | ✗ | Claude 桥接受该参数，界面没有入口 |
| 模型、推理强度 | ✓ | ✓ | ◐ | pi 没有运行中的进程且无缓存时列表为空 |
| 图片、@ 文件 | ✓ | ✓ | ◐ | pi 不接收 http 图片 |
| 技能 | ✓ | ✓ | ✓ | pi：`get_commands` 的 skill 项，需要运行中的会话进程 |
| 原生斜杠命令列表 | ◐ | ◐ | ◐ | 本地常用命令表，其他命令可手动输入 |
| 子代理 | ◐ | ✓ | ✗ | Claude 子代理内部工具未归组 |
| 后台任务 | ◐ | ✗ | ✗ | Claude 只有完成通知 |
| 手动压缩 | ✓ | ✓ | ✓ | |
| 上下文占用 | ◐ | ✓ | ✓ | Claude 为估算；pi 在轮次结束后读 `get_session_stats` |
| 额度 | ◐ | ✓ | — | 只用官方接口，见适配规范 §4 |

表中结论来自代码与单测，没有逐项实机验证。

## 3. 交互请求的映射

提问类请求统一走两个方法，两端共用一套卡片：

| 来源 | 请求 | 跳过或拒绝时的回复 |
|---|---|---|
| Codex 提问 | `item/tool/requestUserInput` | 空 `answers` |
| Claude `AskUserQuestion` | 同上 | `canUseTool` 拒绝 |
| pi 扩展对话框 | 同上 | `extension_ui_response {cancelled: true}` |
| Codex / Claude 的 MCP elicitation | `mcpServer/elicitation/request` | `{action: 'decline'}`（手机“拒绝并中断”为 `cancel`） |

- pi 对话框带 `timeout` 时，到时撤掉卡片，由 pi 按默认值收场。停止轮次、轮次结束、进程关闭也会撤掉卡片。
- 会话建好之前或分支用临时进程里发生的 pi 对话框没有可展示的会话，直接取消并记日志。
- `editor` 回答首尾的空白会被去掉。

## 4. 兼容旧版 server

目标机上的 server 可能暂时是旧版（有活动会话时不会被替换）。旧版缺少 Claude、pi 重命名时返回 `-32601`，两端退回只在本机记录名称；删除直接显示错误。
