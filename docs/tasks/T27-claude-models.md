# T27 Claude 模型与推理强度选择

范围：`packages/server/src/claude/**`（含测试）。不改渲染进程（`ModelPicker` 已是通用实现：`model/list` 有数据就显示，选择结果作为 `turn/start` 的 `model` / `effort` 覆盖项发出）。

背景：Codex 会话的输入框有"模型 · 推理强度"选择器（参见 `apps/desktop/src/renderer/src/components/ModelPicker.tsx`、`store/models.ts`、`packages/codex-client/src/api.ts` 的 `listModels`），Claude 会话因为桥接的 `model/list` 返回空列表而不显示。需要让 Claude 也有同样的选择。

依据：**`docs/agent-adapters.md`（合规）**——特别是 R9：后台探测不得开启会话、不得发 prompt。SDK 类型见 `packages/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`Options.model`、`Options.effort: EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'`、`Query.setModel()`、`Query.supportedModels(): ModelInfo[]`、flag settings 中的 `effortLevel`）。Codex v2 的 `Model` 结构见 `vendor/codex-protocol/ts/v2/Model.ts` 等。

实现：

1. `model/list`：返回 Codex v2 `ModelListResponse` 形状（`data: Model[]`，含 `id`、`model`、`displayName`、`description`、`isDefault`、`supportedReasoningEfforts`（`low/medium/high/xhigh/max` 映射到 v2 的 effort 选项与中文说明由前端已有逻辑决定，按 v2 字段原样给出）、`defaultReasoningEffort`）。
   - 数据来源：有活动会话（已存在的 SDK Query）时调用 `supportedModels()` 并缓存（按 daemon 生命周期）；**没有活动会话时不为了取列表而启动查询**，返回 Claude Code 官方文档列出的模型别名静态列表：`default`（"账号默认"）、`sonnet`、`opus`、`haiku`、`sonnet[1m]`、`opusplan`（说明文案写清用途，标注"别名，由 Claude 自身配置解析"）。拿到真实列表后下次 `model/list` 返回真实列表。
   - 注意用户可能通过 `ANTHROPIC_BASE_URL` 等把 Claude 接到别的模型服务（例如 10.87 上的配置），别名的实际映射以 Claude 自身配置为准，QingCode 不改写、不读取这些配置。
2. `turn/start` 支持 `model`、`effort` 覆盖项：新会话把它们放进 `query()` 的 `options.model` / `options.effort`；已有会话在下一轮前用 `setModel()` 切换模型，推理强度用 SDK 支持的方式切换（flag settings 的 `effortLevel` 或重建 query 时传 `effort`——以 SDK 类型声明为准，选最直接的官方方式，在报告中说明）。`serviceTier`（Codex 的"快速"）Claude 不支持：忽略，并在 `model/list` 的模型上不声明该能力。
3. 当前生效的模型/强度在 `thread/started` / `turn/started` 等通知里按 v2 字段带上（若 v2 有对应字段），`thread/read` 返回的会话信息也带上，便于前端显示。
4. 单测：静态列表形状、`supportedModels()` 结果映射、overrides 应用到 options / setModel 的调用（用假 Query）。

验收：`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec vitest run packages/server/src/claude` 通过；`node packages/server/build.mjs` 成功；报告附 `docs/agent-adapters.md` §8 检查清单。
