# T37 命令面板（Ctrl+Shift+P）

范围：新增 `apps/desktop/src/renderer/src/features/palette/**`（含测试）。**不改**任何已有文件（接入 `App.tsx`、快捷键登记由总管完成，你只导出集成点）。

依据：旧版 `D:\code\qingcode\src\components\CommandPalette.tsx`（只读参考交互）；现有快捷键与动作见 `apps/desktop/src/renderer/src/App.tsx`（Ctrl+P 快速打开、Ctrl+Shift+E/F/G 停靠栏工具、Ctrl+, 设置等）、`components/shell/WorkspaceDock.tsx`（`DOCK_TOOLS`）、`store/dock.ts`、`features/settings/index.ts`（`openSettings`）、`features/files`（打开文件）、`store/codex.ts`（新建会话等）。现有 UI 组件风格参考 `features/explorer` 里的 QuickOpen。

实现：
1. 命令注册表（纯逻辑）：`registerCommands(commands): () => void`（返回注销函数）、`useCommands()`；命令 `{ id, title, category?, keywords?, shortcut?, when?: () => boolean, run: () => void | Promise<void> }`。重复 id 后注册覆盖先注册并在开发模式警告。
2. 搜索：标题 + 分类 + 关键字的模糊匹配（支持拼音首字母可选，不强求），匹配字符高亮；空查询时按"最近使用"在前（最近使用记 `localStorage`，最多 20 条），其余按分类排序。
3. 界面：居中浮层，输入框 + 列表，键盘上下/PageUp/PageDown/Enter/Esc，鼠标悬停选中；右侧显示快捷键（Windows 风格 `Ctrl+Shift+P`）；`when()` 为假的命令不显示；命令执行失败用已有的提示方式（如无则在面板内显示错误行）。输入以 `>` 开头时与旧版一致视为命令模式（默认就是命令模式，`>` 仅被忽略）。
4. 内置命令清单函数 `defaultCommands(deps)`：通过依赖注入拿到动作（切换停靠栏工具、打开设置、快速打开、新建会话、切换侧栏等），**不直接 import App.tsx**；在 README 写明总管如何在 App.tsx 中接入与登记 Ctrl+Shift+P / F1。
5. 导出：`CommandPalette`、`openCommandPalette`/`closeCommandPalette`/`useCommandPalette`、`registerCommands`、`defaultCommands`。

验收：`pnpm --filter @qn/desktop typecheck`、`pnpm exec vitest run apps/desktop/src/renderer/src/features/palette` 通过。
