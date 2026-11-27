# T28 手机端补齐：多 Agent、模型选择、只读查看文件

范围：
- `apps/mobile/web/src/**`（含测试）。
- `apps/desktop/src/backend/mobile/gateway.ts` 与 `gateway.test.ts`（网关白名单与转发）。不改 `service.ts` 以外的 backend 文件；如确需改 `service.ts`，只做最小增量并在报告说明。
- 不改桌面渲染进程、不改 server、不改 protocol、不改 Android 原生代码（`apps/mobile/android/**`）。不要运行 `build:apk`（由总管打包）。

依据：`docs/agent-adapters.md`（合规，特别是"不得自动审批"；手机端也一样，审批只能用户点）、`docs/roadmap.md`、`apps/mobile/android/BRIDGE.md`。桌面端参考实现（只读，照着思路移植，不要 import 桌面渲染代码）：
- 多 Agent：`apps/desktop/src/renderer/src/store/codex.ts`（会话按 `targetId + agent` 区分，`sessionKey`、`openParams`、`codex.attach` 带 agent、`defaultFor`）、`components/AgentPicker.tsx`。
- 模型：`apps/desktop/src/renderer/src/components/ModelPicker.tsx`、`store/models.ts`（`model/list` 有数据才显示；结果作为 `turn/start` 的 `model`/`effort` 覆盖项；非 codex Agent 只在用户显式选择时才发）。
- 设置：`apps/desktop/src/renderer/src/features/settings/settingsModel.ts` 的 `agentPrefs(settings, targetId, agent)`（`enabled`、`path`）与 `general.defaultAgent`。
- 路径链接：`apps/desktop/src/renderer/src/components/MessageItem.tsx`（`createMarkdownLink`、`qnUrlTransform`、行内代码里的路径识别）。

## 1. 多 Agent（Codex / Claude / pi）

现状：`apps/mobile/web/src/store.ts` 把 transport 的 agent 写死为 `'codex'`，每个目标只有一个会话。

- 会话改为按 `targetId + agent` 区分（与桌面一致），`codex.open` / `codex.attach` / `codex.send` 都带 agent；`codex.recv` 事件按 `payload.agent`（缺省视为 codex）路由到对应会话。
- 会话列表：分别从已打开的各 Agent 会话拉 `thread/list` 合并显示，每条标注 Agent（小标签：Codex / Claude / pi）。打开某条会话时用它所属的 Agent。只为"已启用"的 Agent 打开会话；某个 Agent 打开失败（未安装等）只在该 Agent 上提示，不影响其他 Agent。
- 新建会话：可选 Agent（只列已启用的），默认取桌面设置的 `defaultAgent`（不可用时退回第一个可用的）。
- 启用状态从网关新接口取（见 §4 `mobile.agents`），取不到时（旧桌面版本）只显示 Codex。

## 2. 模型与推理强度

- 输入框加"模型 · 推理强度"选择，交互参考桌面 `ModelPicker`，做成适合手机的底部弹层。
- 数据来自当前会话 Agent 的 `model/list`（经 `codex.send`）；为空则不显示。
- 发送时作为 `turn/start` 的 `model` / `effort` 覆盖项；非 codex Agent 只在用户显式选过时才带。选择按 `targetId + agent` 记在内存/`localStorage`。
- Codex 的 `serviceTier`（快速）如果桌面有就照搬，Claude/pi 不显示。

## 3. 点击查看文件（只读）

- 消息中的文件路径（Markdown 链接、行内代码里的路径、文件改动卡片里的路径）可点击，点开全屏只读查看页：
  - 文件：经 `server.req` 调 `fs.read`，带行号的等宽文本，超过大小限制时显示"已截断"并可加载更多（按 `FsReadResult` 实际字段实现）；二进制/图片按 `FsReadResult` 给出的类型显示提示或图片预览（有 base64 就显示）。
  - 改动：文件改动卡片上提供"查看差异"，经 `git.diff`（`cwd` 为会话所在项目目录，`path` 为该文件）显示统一差异，增删行着色；不在 Git 仓库或失败时回退为显示 `fileChange` 自带的 diff（如有）。
- 相对路径按会话 cwd 解析；路径后缀 `:行号` 打开后滚动到该行。
- 完全只读，不提供编辑、保存、暂存、提交等任何写操作。

## 4. 网关（`gateway.ts`）

- `SERVER_REQ_METHODS` 追加只读的 `fs.read`、`git.status`、`git.diff`。**不要**加入任何写方法（`fs.write`、`fs.delete`、`git.stage`、`git.commit`、`run.*` 等）。给写方法被拒写单测。
- 新增网关自有 RPC `mobile.agents`（不转发给 backend 方法本身）：内部调用 `router.invoke('settings.get')`，只返回裁剪后的 `{ defaultAgent, agents: { [targetId]: { codex?: { enabled }, claude?: { enabled }, pi?: { enabled } } } }`，**不返回路径、配置目录等其他字段**。settings 不可用时返回 `{ defaultAgent: 'codex', agents: {} }`。
- 手机经 `server.req` 调 `codex.open` 时，网关按设置补上该目标该 Agent 的可执行文件路径（`codexPath`/`claudePath`/`piPath`，与桌面 `openParams` 语义一致：只在设置里有非空 `path` 时补，且手机自己传的同名字段不被覆盖——实际上手机不应传路径，若传入应忽略并以设置为准，二选一在报告说明）。逻辑写成纯函数并单测。

## 验收

- `pnpm --filter @qn/mobile typecheck`、`pnpm --filter @qn/desktop typecheck` 无错误。
- `pnpm exec vitest run apps/mobile apps/desktop/src/backend/mobile` 全部通过；新增纯逻辑（会话路由、会话列表合并、路径识别与解析、diff 行着色、网关白名单/裁剪/路径注入）都有单测。
- `pnpm --filter @qn/mobile build:web` 成功。
- `mock.ts` 同步支持多 Agent 与 `fs.read`/`git.diff`，便于浏览器里 `dev` 预览。
- 报告附 `docs/agent-adapters.md` §8 检查清单中与手机端相关的条目。
