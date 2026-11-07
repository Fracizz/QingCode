# 待做：基于 run.json 的多远程 Git 同步

状态：待做 · 记录于 2026-11-07

## 背景

同一个项目同时挂在多台远程上（例如 A、B 两台 SSH/Server 直连主机），两边各有一份 git 工作副本，背后是同一个 Git 远端仓库。目前文件不会自动保持一致，常规做法是在 A 上开发完、提交并推送，再切到 B 上拉取。步骤繁琐，也容易漏做。

## 目标

在本地装了 QingCode 的电脑（下称 C）上**按需**触发一次同步。C 通过已建立的连接按顺序完成：

```
A（源端）：检查状态 →（可选）提交 → 推送
B（目标端）：检查状态 → fetch → merge --ff-only
C：汇总结果，确认 A、B 的 HEAD 一致
```

有两个入口，走同一套执行逻辑：

- **人**：在运行面板点击 sync 配置的运行按钮。
- **AI**：`qingcode run start <sync配置> --project X`。

**不在范围内**

- 后台自动同步、轮询比对、状态栏提示「落后 N 个提交」、git 钩子触发、事件推送：只在用户或 AI 主动发起时执行。
- A 与 B 之间直连：所有操作都由 C 分别下发，A、B 不需要互通。
- 自动处理分叉历史、强制推送、`reset --hard` 之类的破坏性操作。
- 同步未提交的工作区、经 C 中转 bundle（见「后续」）。

## 术语

- **同步组**：同一项目在不同主机上的工作副本集合，保存在 C 本地。
- **成员别名**：同步组内每个成员的短名，例如 `a`、`gpu`。run.json 只引用别名。
- **源端**：触发同步的当前项目（就是运行面板或 `--project` 指向的那个项目）。
- **目标端**：`targets` 解析出来的其他成员。

## 前提

- A 和 B 都能访问同一个 Git 远端（A 能推送，B 能拉取），且两边的认证已经配好（凭据助手、SSH key 等）。QingCode 不托管 Git 凭据。
- 每个成员都是已信任的项目，同步操作仍受工作区信任、项目根边界和符号链接检查约束。
- 只操作成员当前所在的分支。源端和目标端的分支名不一致时停下来等决策，不自动切换分支。

## 设计

### 1. 同步组（C 本地）

run.json 会随仓库提交，A、B 上的内容一致；但连接 ID 只对某一台 C 有意义，所以别名到项目的映射**不写进 run.json**，存在 C 本地的应用数据库里（与项目列表同处，参照 `src-tauri/src/cli/db.rs`）。

```jsonc
// 概念结构（非文件格式）
{
  "groupId": "g-1",
  "name": "qingcode",
  "members": [
    { "alias": "a",   "projectId": "<C 上项目 ID>" },  // ssh://conn-a/home/u/qingcode
    { "alias": "gpu", "projectId": "<C 上项目 ID>" }   // ssh://conn-b/data/qingcode
  ]
}
```

- 一个项目最多属于一个同步组。
- UI：在项目设置中新增「同步组」区块，可以添加、移除成员，修改别名。可以按 `git remote get-url origin` 一致性推荐候选项目，只做推荐，不自动加入。
- CLI：`qingcode sync group list | add <project> --alias <a> [--group <id|name>] | remove <project>`。

### 2. run.json：新增任务类型 `sync`

```jsonc
{
  "configs": [{
    "id": "sync-peers",
    "name": "同步到其他远程",
    "tasks": [{
      "id": "sync",
      "name": "同步",
      "type": "sync",
      "sync": {
        "targets": ["*"],        // "*" = 同步组内除源端外的全部成员；或别名列表 ["gpu"]
        "commit": "ask",         // ask：有改动时要求提交信息 | skip：有未提交改动就停下来
        "dirtyTarget": "stop",   // 目标端有未提交改动：stop | stash（同步后 stash pop）
        "push": true             // false：只检查源端已推送，不执行推送
      }
    }]
  }]
}
```

规则：

- 一个 sync 配置只能包含一个 sync 任务，不能和 command 等任务混用（混用时保存和启动都会报错）。
- `sync` 字段缺省值：`targets: ["*"]`、`commit: "ask"`、`dirtyTarget: "stop"`、`push: true`。
- 不支持 `os` 覆盖、`cwd`、`env`、`target`；出现时视为配置错误。
- 拉取方式固定为 `--ff-only`，不提供配置项。
- 旧版 QingCode 不认识 `sync` 类型，会把它当成未知类型报错，需要在文档里说明。前端 `RunTaskType`、`runTaskPlatform.ts`、`cliBridge.ts` 和 Rust `cli/run_config.rs` 的类型校验要同步更新。

### 3. 执行器

sync 任务**不创建终端，也不在 shell 中执行**，而是由 C 上的客户端编排。现有的 `run start/status/stop` 已经通过 `src/lib/cliBridge.ts` 转给运行中的前端，所以执行器放在前端（例如 `src/lib/runSync.ts`，纯状态机逻辑配 Vitest），每一步调用后端已有的 git 命令：

| 步骤 | 本地项目 | SSH/直连项目 |
|---|---|---|
| 状态 | `git_status` | `ssh_git_status` |
| 暂存/提交 | `git_stage` / `git_commit` | `ssh_git_stage` / `ssh_git_commit` |
| 推送 | `git_push` | `ssh_git_push` |
| 拉取 | `git_fetch` + 新增 ff-only 合并 | `ssh_git_fetch` + 新增 ff-only 合并 |
| stash | 新增 | 新增 |

需要新增的后端能力（`src-tauri/src/git.rs`、`src-tauri/src/remote_ssh.rs`，并在 `lib.rs` 注册）：

- `merge --ff-only @{u}`（或 `pull --ff-only`）：现有 `ssh_git_pull` 只支持 merge/rebase，需要增加 ff-only 选项，或新增专门的命令。
- `stash push -u` / `stash pop`：仅在 `dirtyTarget: "stash"` 时使用。
- 统计 ahead/behind 和当前 HEAD：`rev-list --left-right --count HEAD...@{u}`、`rev-parse HEAD`（如果现有 status 已经返回就复用）。
- 检查是否处于 merge/rebase/cherry-pick 中间状态（如果现有 status 已经返回就复用）。

执行器只调用以上白名单内的操作，不接受任意 git 参数。

#### 状态机

```
plan ──► source:check ──► source:commit? ──► source:push ──► target[i]:check
                                                             │
     ┌───────────────────────────────────────────────────────┘
     ▼
target[i]:stash? ──► target[i]:fetch ──► target[i]:ff-merge ──► target[i]:stash-pop? ──► verify ──► done
```

多个目标端**按顺序**执行。某个目标端出现停止或等待时，后面的目标端不继续执行；已完成的不回滚。

每一步结束后检查以下情况，命中就进入 `waiting`（等待决策）或 `failed`：

| 情况 | 处理 |
|---|---|
| 源端有未提交改动，`commit: ask` | `waiting: need-commit-message`（选项：提交并继续 / 取消） |
| 源端有未提交改动，`commit: skip` | `failed: source-dirty` |
| 源端处于 merge/rebase 中间状态 | `failed: source-in-progress` |
| 源端没有上游分支，或分支落后于上游（推送会被拒） | `failed: source-behind-upstream`，提示先在源端处理 |
| 推送失败（认证、网络、被拒） | `failed: push-failed`，附带 git 输出 |
| 目标端处于 merge/rebase 中间状态 | `failed: target-in-progress` |
| 目标端有未提交改动，`dirtyTarget: stop` | `waiting: target-dirty`（选项：stash 后继续 / 跳过此目标 / 取消） |
| 目标端分支名与源端不同 | `waiting: branch-mismatch`（选项：跳过此目标 / 取消） |
| 目标端有源端没有的本地提交（无法快进） | `waiting: diverged`（选项：跳过此目标 / 取消；rebase 或 merge 由人或 AI 在目标端自行处理） |
| `stash pop` 冲突 | `failed: stash-pop-conflict`，保留 stash，不自动丢弃 |
| 同步组成员离线或未信任 | `failed: target-unavailable` |
| 最终 HEAD 不一致 | `failed: verify-mismatch` |

### 4. 计划预览（dry-run）

真正执行前先只读采集所有成员的状态，生成计划：

```json
{
  "source": { "alias": "a", "branch": "main", "head": "a1b2c3d", "dirty": 2, "ahead": 1 },
  "targets": [
    { "alias": "gpu", "branch": "main", "head": "9f8e7d6", "dirty": 0, "behind": 3, "plan": ["fetch", "ff-merge"] }
  ],
  "steps": ["source:commit(2 files)", "source:push", "gpu:fetch", "gpu:ff-merge", "verify"],
  "blockers": []
}
```

- **人**：点击运行按钮后先弹出计划对话框（复用现有对话框组件），确认后才执行；存在 `blockers` 时禁用确认按钮并显示原因。
- **AI**：`qingcode run start sync-peers --project X --dry-run` 返回同样的 JSON，不做任何修改。

### 5. 暂停与继续

进入 `waiting` 后，任务保持挂起，等待当前驱动方决策：

- **人发起**：弹出决策对话框，显示原因、相关文件或提交列表和可选项；需要提交信息时提供输入框。
- **AI 发起**：`run status` 返回挂起信息，AI 用 `run resume` 继续：

```json
{
  "configId": "sync-peers",
  "runId": "sync-20261107-001",
  "status": "waiting",
  "waiting": {
    "reason": "need-commit-message",
    "member": "a",
    "files": ["src/app.ts", "docs/x.md"],
    "options": ["commit", "cancel"]
  },
  "steps": [ { "id": "source:check", "status": "done" } ]
}
```

```text
qingcode run resume <runId> --choice commit --param message="feat: ..."
qingcode run resume <runId> --choice skip-target
qingcode run stop sync-peers --project X        # 取消
```

- 同一个项目同时只能有一个 sync 运行实例；已有实例在运行或挂起时，再次 start 会报错并返回现有 runId。
- 两种入口共用同一个挂起实例：AI 发起的任务，人也可以在运行面板里继续，反之亦然。
- 挂起状态只保存在运行中的 QingCode 内存里。应用退出时任务视为取消，已执行的 git 操作不回滚。

### 6. CLI 变更

| 命令 | 变更 |
|---|---|
| `run start <name> [--project] [--dry-run] [--param k=v ...]` | 新增 `--dry-run`、`--param`。sync 任务支持 `message`；对非 sync 任务传这两个参数时报错 |
| `run status [--project]` | sync 任务额外返回 `runId`、`status`（`running/waiting/done/failed/cancelled`）、`waiting`、`steps`、各成员最终 HEAD |
| `run resume <runId> --choice <opt> [--param k=v ...]` | 新增 |
| `run stop <name>` | 对 sync 任务表示取消；正在执行的单步 git 命令执行完后才停止 |
| `sync group list/add/remove` | 新增 |

需要运行中的 QingCode（与 SSH 运行配置一致）。`args.rs` 的解析测试和 `cliBridge.ts` 的分发都要补充。

### 7. 运行面板 UI

- sync 配置显示为一次性任务：运行按钮、上次结果（成功/失败/挂起）和时间；不显示「运行中」的常驻状态。
- 运行时按成员分组显示步骤进度，每一步可以展开查看 git 输出。
- 挂起时，运行面板里的对应配置高亮，并提供「继续处理」按钮，点击后重新打开决策对话框。
- 新建配置时提供「Git 同步」模板，只在当前项目属于某个同步组时可用。

### 8. 审计日志

每次运行把计划、每一步的命令（不含凭据）、结果和最终 HEAD 写入应用日志，`run status` 也能查看最近一次运行的结果。git 输出写入前要剥离 URL 中的凭据。

### 9. Skill 更新

在 `src/lib/qingcodeCliSkill.ts` 中补充同步流程，然后执行 `pnpm skill:sync`，同时更新 `.agents/skills/qingcode-cli/SKILL.md` 和快照测试：

1. 先执行 `run start ... --dry-run`，把计划摘要告诉用户；有 blockers 时停止并说明原因。
2. 执行 `run start`，轮询 `run status`。
3. 遇到 `need-commit-message`：根据 diff 生成提交信息，遵循项目的提交约定。
4. 遇到 `target-dirty`、`diverged`、`branch-mismatch`：**必须先问用户**，不得自行选择 stash 或跳过。
5. 遇到 `diverged` 时，如果用户要求处理，到目标端执行 rebase/merge 并解决冲突，然后重新运行同步；禁止 force push 和 `reset --hard`。
6. 结束时汇报每个成员的分支和 HEAD，以及哪些目标被跳过。

## 实施计划

| 阶段 | 内容 | 估时 |
|---|---|---|
| 1 | 同步组存储、项目设置 UI、`sync group` CLI | 1–1.5 天 |
| 2 | run.json 中 `sync` 类型的解析与校验（前端 + Rust CLI） | 0.5 天 |
| 3 | 后端补齐：ff-only 合并、stash push/pop、ahead/behind/HEAD/中间状态（本地 + SSH + 直连） | 1–1.5 天 |
| 4 | 前端执行器状态机 + dry-run 计划 + Vitest | 1.5–2 天 |
| 5 | CLI：`--dry-run`、`--param`、`run resume`、status 扩展 | 1 天 |
| 6 | 运行面板 UI：计划对话框、决策对话框、步骤进度 | 1.5 天 |
| 7 | Skill 更新与快照测试 | 0.5 天 |
| 8 | 验收 | 1–1.5 天 |

合计约 8–10 天。阶段 1–5 完成后，AI 已经可以端到端使用；阶段 6 补上给人点击的入口。

## 测试

**单元测试（Vitest / cargo test）**

- `sync` 配置校验：缺省值、非法字段、和其他任务混用、多个 sync 任务。
- `targets` 解析：`*`、别名列表、未知别名、源端不在同步组中。
- 状态机：上面表格里的每一种情况都对应一条用例，用 fake git 适配器模拟状态。
- dry-run 不调用任何会修改仓库的操作。
- CLI 参数解析：`--dry-run`、`--param`、`run resume`。

**集成验收（真实远程，用临时仓库）**

- 两台 SSH 主机（参照真机测试机：Windows 45 / Linux 245）共用一个临时 Git 远端：
  - A 有未提交改动 → 填写提交信息 → B 快进成功，两边 HEAD 一致。
  - B 有未提交改动：选择 stop 和 stash 两条路径；stash pop 冲突时 stash 被保留。
  - B 有本地提交（分叉）→ 进入挂起；跳过后其他目标继续执行。
  - 推送被拒（A 落后于上游）→ 失败并给出明确提示。
  - 成员离线、未信任 → 失败，不影响其他成员的状态。
- AI 路径：在 Claude Code 中按 Skill 完成一次「dry-run → 执行 → 提交信息挂起 → resume → 完成」。
- 人工路径：运行面板完成同样的流程；从 AI 发起的挂起任务在 UI 中继续。

## 后续（不在本期）

- `after` 条件命令：例如 `pnpm-lock.yaml` 变化后在目标端执行 `pnpm install --frozen-lockfile`。
- `mode: bundle`：B 访问不了 Git 远端时，C 从 A 生成 git bundle，经 SFTP 中转到 B 后 fetch；同时也可以省去推送。
- `mode: worktree`：传输未提交的工作现场（`git stash create` + 未跟踪文件），用于在另一台机器上接着开发。
- 执行时指定 `--from/--to`，而不是固定以当前项目为源端。
