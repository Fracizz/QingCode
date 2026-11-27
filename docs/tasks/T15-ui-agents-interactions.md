# T15 电脑端：多 Agent + Codex 式交互

范围：`apps/desktop/src/renderer/**`；`apps/desktop/src/backend/**` 中 `codex.send`/`codex.recv` 透传 `agent` 字段的最小改动；`src/shared/backendApi.ts` 新增 `agent` 可选字段。

依据：`docs/mvp.md` §11.2、§11.4、§12；T6 已有的对话界面在此基础上改。

1. 每个目标按 agent 维护各自的 `CodexRpc` 与会话状态（`codex.open {agent}` + `codex.attach {agent, sinceSeq}`）；会话列表合并 Codex 与 Claude（Claude 未安装时只显示 Codex，反之亦然），行内 Agent 图标；新建会话选择 Agent。
2. §12 全部交互：选中文字浮层（添加到对话 / 在侧边聊天中提问）、行内可选评论、输入框注释条与发送时的拼接格式（纯函数 + 单测）、侧边临时会话面板、消息复制与"…"菜单、输入框样式与占位符随 Agent 变化。
3. 额度徽标按 agent 区分（Claude 显示限额事件与费用估算，标注"估算"）。

验收：typecheck、vitest（注释拼接、选区工具函数等）、build、`--smoke` 通过；列出需人工验收的交互。
