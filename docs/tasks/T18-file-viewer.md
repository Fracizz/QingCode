# T18 文件查看面板 + 对话中点击打开文件

范围：只新增 `apps/desktop/src/renderer/src/features/files/**`（含测试）。**不得修改任何已有文件**：另一个会话正在并行重做渲染进程 UI（`App.tsx`、`MessageItem.tsx`、`ChatPanel.tsx`、`components/*` 等都在变）。接入（把面板放进布局、替换 Markdown 链接、给文件改动卡片加按钮）由总管完成，你只需按下文导出集成点。

依据：`docs/roadmap.md` §5 P0；接口 `packages/protocol/src/workspace.ts`；调用封装 `features/workspace/serverCall.ts`（`serverCall`、`onServerEvt`）；打开请求总线 `features/workspace/openers.ts`（`subscribeOpen`、`OpenRequest`）。可只读复用：`components/ui.tsx`、`components/primitives.tsx`、`lib/cn.ts`、`lib/highlight.ts`（语言归一）、`lib/diff.ts`（`classifyDiffLine`）、`shiki`、`react-markdown`、`remark-gfm`、`lucide-react`、`zustand`（均已安装）。样式沿用现有 Tailwind 主题 token（`text-qn-muted`、`border-qn-border`、`bg-qn-*` 等，参考 `styles.css`）。

实现：

1. `fileLinks.ts`（纯函数 + 单测，重点）：
   - `parseFileHref(href, cwd)`：识别本地文件链接并返回 `{path, line?, column?}`，否则 `null`。支持 POSIX 绝对路径、Windows 盘符路径（`C:\a\b.ts`、`C:/a/b.ts`、`/C:/a`）、`file://`（含 `file:///C:/`）、URL 编码、后缀 `:12`、`:12:3`、`#L12`、`#L12C3`、`#L12-L20`；相对路径（`src/a.ts`、`./a.ts`、`../a.ts`）按 cwd 解析并规范化（处理 `.`/`..`）；`http(s):`、`mailto:` 等其他协议返回 null。
   - `findPathsInText(text)`：在行内代码/普通文本中找出像文件路径的片段（含 `/` 或 `\` 且有扩展名，或以 `./`、`../`、`~/` 开头；可带 `:line[:col]`），返回 `{start, end, raw, path, line?, column?}[]`；避免误判 URL、版本号（`1.2.3`）、纯数字比例（`3/4`）。
   - `joinPath` / `normalizePath` / `isAbsolutePath` / `dirname` / `basename` / `extname`：POSIX 与 Windows 两种风格（按 cwd 风格判断）。
   - `fileKind(path)`：`image`（png/jpg/jpeg/gif/webp/svg/bmp/ico）、`markdown`、`text`。
2. `filesStore.ts`（zustand）：标签列表（`{id, kind:'file'|'diff', targetId, path, cwd?, line?, column?, mode?, commit?, status:'loading'|'ready'|'error', ...内容字段}`）、`activeId`、面板 `open`。订阅 `subscribeOpen`：同 targetId+path+kind（diff 再加 mode/commit）复用已有标签并更新行号；新开时调 `fs.read`（图片用 `encoding:'base64'`）或取 diff 数据。监听 `fs.changed`：已打开的文件变化则重新读取（保持滚动位置）。`truncated` 时提供 `loadMore(id)` 续读。错误码转中文提示（`not_found` → 文件不存在 等）。纯逻辑（标签去重/替换、错误文案）抽成纯函数并单测。
   - `fs.watch` 是"每连接一个监听集合、全量替换"，文件树（T20）也需要监听，所以本卡**不直接调用 `fs.watch`**：导出 `getFileWatchPaths(targetId)`（已打开文件标签的路径），由总管合并后统一登记。
3. 组件：
   - `FilePane.tsx`：标签栏（文件名 + 父目录提示 + 关闭，中键关闭，悬停显示完整路径）、操作（复制路径、刷新、关闭全部、Markdown 预览/源码切换）、内容区。导出 `FilePane`（props：`className?`；无标签时显示空态）。
   - `CodeView.tsx`：行号 + shiki 高亮（按扩展名取语言，`shouldHighlight` 超限退化纯文本，懒加载 shiki 并缓存 highlighter）；跳转并高亮目标行（滚动居中）；大文件"仅显示前 2 MiB · 加载更多"。
   - `ImageView.tsx`（base64 data URL，svg 也按图片显示）、二进制文件提示。
   - `DiffView.tsx`：统一 diff 渲染（行号两栏、增删着色，复用 `classifyDiffLine`）；mode：worktree → `git.diff {cwd, path}`；staged → `git.diff {cwd, path, staged:true}`；commit → `git.diff {cwd, path, commit}`；text → 直接用请求里的 diff；`not_repo` / `git_missing` 时提示并提供"打开文件"。
4. 集成点（`index.ts` 导出，供总管接入）：
   - `FilePane`、`useFiles`、`getFileWatchPaths`。
   - `createMarkdownLink(getContext: () => {targetId: string; cwd: string} | null)`：返回 react-markdown 的 `a` 组件；本地文件链接 `preventDefault` 后 `openFile`，否则保持原样（新窗口打开外链）。
   - `PathText({text, targetId, cwd})`：把文本中的路径渲染为可点击（用于行内代码、命令输出）。
   - `FileChangeActions({targetId, cwd, path, diff?})`：文件改动卡片上的「打开文件」「与 HEAD 对比」两个小按钮（无 cwd 时只显示打开）。
5. 本目录写 `README.md`（3~10 行）说明集成方式。

验收：`pnpm exec vitest run apps/desktop/src/renderer/src/features/files` 通过；`pnpm --filter @qn/desktop typecheck` 中**本目录无错误**（其他文件的错误来自并行的 UI 改动，忽略并在报告中注明）。
