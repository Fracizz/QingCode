# 文件查看 / 编辑面板（T18 + T25 集成说明）

1. `<FilePane className="..." />` 放进右侧分栏；导入 `./features/files` 即自动订阅 `subscribeOpen` 与 `fs.changed`，无需额外初始化。标签页现在可编辑、可保存。
2. `useFiles(s => s.open)` 控制面板占位；`setOpen(true)` 展开，`openFile`/`openDiff` 也会自动展开。关闭脏标签/关闭全部会弹「保存 / 不保存 / 取消」对话框。
3. 编辑态由 `filesStore` 管理：`edit(id, text)`、`save(id)`（Ctrl+S）、`refresh` 会确认丢弃、`requestClose*` 会确认；`fs.write` 带 `expectedMtimeMs`，`conflict` 弹「覆盖 / 重新加载 / 对比」。
4. 保存格式：`fs.read` 时按多数换行检测 `eol`（`\r\n`/`\n`），编辑器内部统一 `\n`，写盘时还原；外部 `fs.changed` 对干净标签自动重载并保持光标/滚动，脏标签只在标签上标「磁盘已更改」。
5. 只读：二进制、图片、未完整加载的大文件（truncated，可「加载更多」后转可编辑）、diff 标签；编辑器显示锁标识。Markdown 预览仍用 ReactMarkdown，源码用 CodeMirror。
6. 差异视图：worktree / staged / commit 用 `@codemirror/merge`（并排 / unifiedMergeView 可切换，左旧版本取 `git.show`，右当前文件或由 diff 还原的新版本）；text 模式沿用统一 diff 文本。
7. 快捷键（Ctrl+S 保存、Ctrl+F 搜索、Ctrl+H 替换、Ctrl+G 跳行、Tab/Shift+Tab 缩进）只在编辑器聚焦时生效，不抢全局 Ctrl+P / Ctrl+Shift+E/F/G。语言包经 `@codemirror/language-data` 动态 import 按需拆 chunk。
8. `fs.watch` 仍由总管合并登记：把 `getFileWatchPaths(targetId)` 与 T20 的 `getExplorerWatchPaths(targetId)` 合并去重后统一调用；订阅 `subscribeFileWatch(cb)`，本模块不直接发 `fs.watch`。
9. Markdown：`components={{ a: createMarkdownLink(() => ({ targetId, cwd })) }}` 并给 ReactMarkdown 加 `urlTransform={qnUrlTransform}`；行内代码/命令输出用 `<PathText .../>`；文件改动卡片用 `<FileChangeActions .../>`。
