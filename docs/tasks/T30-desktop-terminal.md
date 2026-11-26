# T30 桌面终端

范围：
- `apps/desktop/src/renderer/src/features/terminal/**`（含样式和测试）。
- `apps/desktop/src/renderer/src/App.tsx`、`components/shell/MainHeader.tsx` 与 `features/palette/**` 仅用于底部面板、工具栏、命令和快捷键接入。
- `apps/desktop/src/backend/mobile/gateway.ts`、`gateway.test.ts` 仅用于阻止终端事件转发到手机。

依据：`docs/next-wave.md` B 组、`docs/spikes/terminal.md` §5–§6、`packages/protocol/src/workspace.ts` 的 T29 终端协议。通过现有 `server.req` / `server.evt` 访问目标；复用依赖声明中的 xterm 和插件。

实现：
1. 项目内从底部面板打开终端，多标签按目标与项目目录组织。折叠面板与切换项目时保留远端会话；关闭标签时调用 `term.close`。
2. 展示输出、转发输入、同步可用的尺寸调整，支持复制粘贴、搜索和 HTTP(S) 链接。
3. 连接恢复后调用 `term.list` / `term.attach`，依序合并回放与实时分块。缓冲截断时在界面提示历史缺失；以 T29 实际协议支持为准。
4. 单测覆盖分块回放、去重和状态恢复。
5. 桌面订阅终端后，手机事件流仍不得收到任何 `term.*` 事件。

验收：`pnpm --filter @qn/desktop typecheck`、`pnpm exec vitest run apps/desktop/src/renderer/src/features/terminal`。
