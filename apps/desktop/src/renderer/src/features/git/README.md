# Git 面板（T19）

1. 侧栏「源代码管理」渲染 `<GitPanel targetId={...} cwd={...} />`，cwd 为当前项目的绝对路径；挂载即刷新，可见时每 5s 轮询、窗口获得焦点时刷新，隐藏/卸载后停止。
2. 状态栏/标题栏渲染 `<GitBranchBadge targetId cwd />`；历史可单独用 `<GitHistory targetId cwd />`。
3. 对话 turn 结束时调用 `refreshGit(targetId, cwd)`；也可通过 `useGit` 读取分仓状态。
4. 差异与文件只经 `features/workspace/openers.ts` 的 `openDiff` / `openFile` 发给 T18 文件面板，路径由 `git.status.root` + 相对路径拼成绝对路径。
5. 依赖 `packages/protocol/src/workspace.ts` 的 `git.*` 与 `features/workspace/serverCall.ts`；`not_repo` / `git_missing` 显示空态，其余错误走中文提示。
6. 假设：冲突文件只出现在「冲突」分组（不再重复进已暂存/未暂存）；远端分支 `origin/foo` 切换时去掉 remote 前缀；push 无 upstream 时自动 `setUpstream:true`。
