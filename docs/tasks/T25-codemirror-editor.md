# T25 文件编辑器（CodeMirror 6）

范围：`apps/desktop/src/renderer/src/features/files/**`（T18 已完成，可修改）。不改其他已有文件（接入已由总管完成：`WorkspaceDock` 里渲染 `FilePane`）。依赖已安装：`codemirror`、`@codemirror/{state,view,commands,language,search,autocomplete,language-data,merge}`、`@lezer/highlight`。不要安装新依赖。

依据：`docs/roadmap.md` §5 P2「编辑与保存」、§7 决策 1（CodeMirror 6）；`docs/design/ui-shell.md`（主题 token、代码块配色 `github-dark-default` 风格）；协议 `packages/protocol/src/workspace.ts`（`fs.read` / `fs.write` 的 `expectedMtimeMs` 冲突检测、`git.show`）。

实现：

1. `editor/` 子目录：
   - `theme.ts`：与 `styles.css` token 一致的深色主题（背景、选区、光标、行号、当前行、搜索命中、括号匹配）+ `HighlightStyle`（接近 github-dark-default 的语法配色）。
   - `languages.ts`：用 `@codemirror/language-data` 按文件名懒加载语言（`LanguageDescription.matchFilename`），找不到时纯文本。
   - `CodeEditor.tsx`：React 封装（创建/销毁 EditorView，受控切换文档不丢撤销栈：每个标签保留自己的 `EditorState`），扩展：行号、折叠、括号匹配、自动闭合括号、多光标、缩进（Tab/Shift+Tab）、`search`（Ctrl+F / Ctrl+H 替换，面板样式匹配主题）、跳转行（Ctrl+G）、高亮当前行、只读模式。
2. **编辑与保存**（`filesStore` 扩展）：标签增加 `dirty`、`savedText`、`mtimeMs`、`eol`（`\r\n` / `\n`，读入时检测，CodeMirror 内部用 `\n`，保存时还原原换行）；Ctrl+S 保存 → `fs.write {path, content, expectedMtimeMs}`；成功后更新 mtime、清 dirty；标签名前显示未保存圆点。
   - `conflict` 时弹对话框：「覆盖」（不带 expectedMtimeMs 重写）/「重新加载」（丢弃本地改动）/「对比」（用 `@codemirror/merge` 的 MergeView 左本地右磁盘，可逐块采纳后再保存）。
   - 外部修改（`fs.changed`）：未改动的标签自动重载并保持光标/滚动；有未保存改动的标签只在标签上提示"磁盘已更改"。
   - 关闭有未保存改动的标签、关闭全部时确认（保存 / 不保存 / 取消）。
   - 只读：二进制、图片、`truncated` 的大文件（>2 MiB）、diff 标签；只读时编辑器显示锁标识。
3. **差异视图**升级：`DiffView` 对 worktree / staged / commit 模式改用 MergeView（左：`git.show` 的旧版本，右：当前文件或新版本；`unifiedMergeView` 与左右并排可切换），text 模式（仅有 diff 文本）保留现有统一 diff 渲染。
4. 原 shiki `CodeView` 不再用于文件标签（Markdown 预览仍用现有实现）；删除不再使用的代码前确认无其他引用（`grep`）。
5. 快捷键只在编辑器聚焦时生效，不影响全局 Ctrl+P / Ctrl+Shift+E 等（总管已在 App 里绑定）。
6. 纯逻辑单测：换行检测与还原、dirty 判定、冲突决策、标签状态迁移、语言匹配（mock language-data）。

验收：`pnpm --filter @qn/desktop typecheck` 本目录无错误（他处错误注明即可）；`pnpm exec vitest run apps/desktop/src/renderer/src/features/files` 通过；`pnpm --filter @qn/desktop build` 成功（注意 language-data 应按需拆分 chunk，不要把所有语言打进主包）。
