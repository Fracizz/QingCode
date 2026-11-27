# T35 输入框：`@` 引用文件、粘贴/拖入图片

范围：
- 新增 `apps/desktop/src/renderer/src/features/composer/**`（含测试）；`apps/desktop/src/renderer/src/components/Composer.tsx` 可改（接入点）；`apps/desktop/src/renderer/src/store/codex.ts` 只改发送消息时组装 `turn/start` 输入的那一处（先重新读取）。
- server：`packages/server/src/claude/**`、`packages/server/src/pi/**` 中把 v2 `UserInput` 的图片项映射到各自 Agent 原生输入的部分（含测试）。
- `apps/desktop/src/renderer/src/components/ChatPanel.tsx` 仅用于让拖入、粘贴和选择附件走相同的图片校验入口。
- 不改 protocol、backend、手机端及其余渲染文件。

依据：`docs/agent-adapters.md`（合规：Agent 原生支持什么才发什么，不伪造能力）；Codex v2 输入类型见 `vendor/codex-protocol/ts/v2/UserInput.ts`（`text`/`image`/`localImage`/`mention` 等，以实际文件为准）；Claude SDK `SDKUserMessage` 的 content blocks（`packages/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`，图片为 base64 image block）；pi RPC `prompt` 的 `images` 字段（`C:\Users\Administrator\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\rpc.md`）。文件搜索用已有的 `fs.search`（`apps/desktop/src/renderer/src/features/workspace/serverCall.ts`，参考 `features/explorer` 中 QuickOpen 的用法）。

实现：
1. `@` 引用：输入 `@` 后弹出候选（项目根下按文件名模糊搜索，键盘上下选择、Enter/Tab 确认、Esc 关闭；输入法组合中不触发）。确认后在文本中插入相对路径（如 `@src/a.ts`），发送时：Codex 若 v2 有 `mention`/文件类输入就按其原生形式附带，否则保留为文本；Claude、pi 保留为文本路径（Agent 自己会读）。不在客户端读取文件内容塞进 prompt。
2. 图片：支持粘贴（剪贴板图片）和拖入图片文件；输入框上方显示缩略图，可删除；限制单张 ≤ 10 MiB、最多 8 张，支持 png/jpeg/gif/webp。发送为 v2 `image`（data URL）输入。
3. server 映射：Claude 桥把 v2 图片输入转成 SDK 的 base64 image content block；pi 映射到 `prompt` 的 `images`。某 Agent/模型不支持图片时（如 `model/list` 的模型声明了输入模态且不含图片），前端禁用图片附件并提示，而不是静默丢弃。
4. 纯逻辑（`@` 触发与替换、候选排序、图片校验与 data URL 解析、v2→Claude/pi 映射）写单测。

验收：`pnpm --filter @qn/desktop typecheck`、`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec vitest run apps/desktop/src/renderer/src/features/composer packages/server/src/claude packages/server/src/pi` 通过；`node packages/server/build.mjs` 成功；报告附 `docs/agent-adapters.md` §8 检查清单。
