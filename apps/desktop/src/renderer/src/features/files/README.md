# T18 文件查看面板（集成说明）

1. 把 `<FilePane className="..." />` 放进右侧分栏；导入 `./features/files` 即自动订阅 `subscribeOpen` 与 `fs.changed`，无需额外初始化。
2. `useFiles(s => s.open)` 控制面板占位；面板内可收起，重新展开调用 `useFiles.getState().setOpen(true)`，任何 `openFile`/`openDiff` 也会自动把 `open` 置 true。
3. Markdown：`components={{ a: createMarkdownLink(() => ({ targetId, cwd })) }}`，并给 `ReactMarkdown` 加 `urlTransform={qnUrlTransform}`，否则 react-markdown 会把 `file://` 与 `C:\` 形式的 href 清空。
4. 行内代码/命令输出用 `<PathText text={...} targetId={...} cwd={...} />`；文件改动卡片用 `<FileChangeActions targetId={...} cwd={...} path={...} diff={...} />`。
5. `fs.watch` 每连接只登记一份集合：把 `getFileWatchPaths(targetId)` 与 explorer/git 的路径合并后统一调用，本模块不直接发 `fs.watch`。
6. 依赖 T16 的 `fs.read`（`encoding:'base64'` 读图片）与 T17 的 `git.diff`；相对路径按传入的 cwd 解析，`~/` 不展开（渲染进程不知道目标机 home）。
