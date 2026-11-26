# T17 server Git 协议

范围：只改/新增 `packages/server/src/workspace/git/**`（含测试）。**不要改** `daemon.ts`、`workspace/registry.ts`、`workspace/index.ts`、`packages/protocol/**`、`workspace/fs/**`（T16 在并行修改）。

依据：`docs/roadmap.md` §3、§4.2；接口类型以 `packages/protocol/src/workspace.ts` 为准（`WorkspaceMethods` 中 `git.*`）；处理函数签名与 `WorkspaceError` 见 `workspace/registry.ts`；登记到 `workspace/git/index.ts` 的 `gitHandlers`。

实现：

1. 统一执行器 `runGit(cwd, args, opts)`：`child_process.spawn('git', args, {cwd})`，不经 shell；环境变量追加 `GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`（只读命令）、`LC_ALL=C`；若未设置 `GIT_SSH_COMMAND` 则设为 `ssh -o BatchMode=yes`，保证需要交互认证时快速失败而不是挂起。超时：本地命令 30s，fetch/pull/push 120s。stdout 上限 8 MiB（diff 4 MiB 后截断并 `truncated:true`）。
   - git 不存在（ENOENT）→ `git_missing`；`not a git repository` → `not_repo`；认证失败（`Authentication failed`、`Permission denied (publickey`、`could not read Username`、`terminal prompts disabled`）→ `auth_required`；其他非 0 → `git_failed`，message 取 stderr 末尾 20 行，**过滤掉 URL 中的 `user:password@`**。
2. 方法：
   - `git.status`：`rev-parse --show-toplevel` 取 root；`status --porcelain=v2 -z --branch --untracked-files=all`，解析 branch.head/oid/upstream/ab、1/2/u/? 条目；冲突（`u` 条目）`conflict:true`。路径相对 root。
   - `git.diff`：`diff [--cached] [-U<n>] -- <path>`；`commit` 时用 `show --format= <commit> -- <path>`；未跟踪文件（status 为 `?`）且非 staged 时用 `diff --no-index /dev/null <file>`（Windows 用 `NUL`），退出码 1 视为成功。path 可以是绝对路径，内部转为相对 root。
   - `git.show`：`show <ref>:<相对路径>`，ref 默认 `HEAD`；对象不存在 → `exists:false, content:''`；含 NUL → `binary:true, content:''`；上限 2 MiB。
   - `git.stage`（`add -- paths`）、`git.unstage`（`restore --staged -- paths`；仓库无 HEAD 时用 `rm --cached`）、`git.discard`（已跟踪：`restore --worktree --source=HEAD -- paths`；`includeUntracked` 时对未跟踪文件 `clean -f -- paths`，否则跳过未跟踪）。
   - `git.commit`：message 经 `-F -`（stdin）传入；`amend` 时加 `--amend`；空 message → `params`；返回 `rev-parse HEAD`。
   - `git.branches`：`for-each-ref --format=... refs/heads refs/remotes`（排除 `*/HEAD`）。
   - `git.switch`：`switch [-c] <branch>`；远端分支名（如 `origin/x`）且本地不存在时 `switch --track`。
   - `git.fetch`（`fetch --prune [remote]`）、`git.pull`（`pull --ff-only [remote] [branch]`）、`git.push`（`push [-u] [remote] [branch]`）：返回合并后的 stdout+stderr（过滤凭据）。
   - `git.log`：`log --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x1e -n <limit> --skip <skip> [-- path]`，limit 默认 50、上限 500；空仓库返回空数组。
   - `git.commitFiles`：`show --name-status -z --format= -M <commit>`（首个提交也要能用，必要时 `--root`）。
3. 所有 porcelain / log / for-each-ref / name-status 解析与错误分类写成纯函数并单测；另用 `os.tmpdir()` 下 `git init` 的临时仓库做集成测试（本机有 git；测试里设置 `user.name`/`user.email` 局部配置，覆盖 status、stage、commit、diff、show、log、branches、switch、discard、未跟踪 diff）。

验收：`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec vitest run packages/server/src/workspace/git` 通过；`node packages/server/build.mjs` 打包成功；不引入新依赖。
