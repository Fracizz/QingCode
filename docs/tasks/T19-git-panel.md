# T19 Git 面板（源代码管理）

范围：只新增 `apps/desktop/src/renderer/src/features/git/**`（含测试）。**不得修改任何已有文件**（另一会话正在并行重做 UI；接入由总管完成）。T18 正在并行开发 `features/files/**`，不要依赖它的内部实现，打开文件/差异一律调用 `features/workspace/openers.ts` 的 `openFile` / `openDiff`。

依据：`docs/roadmap.md` §5 P1；接口 `packages/protocol/src/workspace.ts`（`git.*`）；调用 `features/workspace/serverCall.ts`。可只读复用：`components/ui.tsx`、`components/primitives.tsx`（Menu、Popover、Tabs、Tip）、`lib/cn.ts`、`lucide-react`、`zustand`、`radix-ui`。主题 token 参考 `styles.css`。

实现：

1. `gitModel.ts`（纯函数 + 单测）：把 `GitStatusResult.files` 分组为 冲突 / 已暂存 / 未暂存（含未跟踪），一个文件可同时出现在已暂存和未暂存；状态字母 → 中文标签与颜色（M 修改、A 新增、D 删除、R 重命名、C 复制、U 冲突、? 未跟踪）；`ahead/behind` 文案；提交信息校验（非空；首行 > 72 字符给提示不阻止）；相对时间格式化（"3 分钟前"、"昨天"、日期）；错误码 → 中文提示（`auth_required`：远端需要认证，请在远端配置 ssh-agent 或凭据助手；`not_repo`、`git_missing`；`git_failed` 显示 stderr 摘要）。
2. `gitStore.ts`（zustand，按 `targetId + cwd` 分仓）：status、branches、log 分页、loading/error、正在执行的操作（防重复点击）。`refresh(targetId, cwd)`；操作后自动刷新；窗口获得焦点时刷新；面板可见时每 5s 轮询（不可见停止）。导出 `refreshGit(targetId, cwd)` 供对话在 turn 结束时调用。
3. 组件：
   - `GitPanel.tsx`（props：`targetId`、`cwd`）：顶部分支按钮（Popover：本地/远端分支列表、搜索、新建分支、切换）+ 同步按钮（fetch / pull / push，显示 ahead/behind；push 无 upstream 时 `setUpstream:true`）+ 刷新；提交框（多行，Ctrl+Enter 提交，"修改上次提交"勾选）；分组变更列表：单击 → `openDiff`（未暂存 mode worktree，已暂存 mode staged；路径为绝对路径 = root + 相对路径）；行内按钮：暂存 / 取消暂存 / 放弃（放弃需二次确认，未跟踪文件明确提示"将删除文件"）；分组标题按钮：全部暂存 / 全部取消暂存；右键菜单：打开文件（`openFile`）、复制路径。
   - `GitHistory.tsx`：提交列表（subject、作者、相对时间、短 hash），滚动到底加载更多；展开某提交显示 `git.commitFiles`，点文件 → `openDiff({mode:'commit', commit})`。
   - 非仓库时空态："当前目录不是 Git 仓库"；git 缺失时提示安装。
   - `GitBranchBadge.tsx`（props：`targetId`、`cwd`）：分支名 + ahead/behind 小徽标，供状态栏/标题栏使用。
4. `index.ts` 导出 `GitPanel`、`GitHistory`、`GitBranchBadge`、`refreshGit`、`useGit`；本目录 `README.md` 写集成方式（3~10 行）。

验收：`pnpm exec vitest run apps/desktop/src/renderer/src/features/git` 通过；`pnpm --filter @qn/desktop typecheck` 中**本目录无错误**（其他文件错误来自并行 UI 改动，忽略并注明）。
