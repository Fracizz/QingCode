# 终端列表 Git 摘要（方案草案）

> 状态：评估中，未实现。2026-11-23 起草。
> 范围：工作台终端列表（`src/components/TerminalSessionList.tsx`）的项目组头，Git 项目显示分支与改动规模。

## 1. 目标

终端列表中的 Git 项目在组头展示：

```
▾ 📁 qingcode  [SSH]   ⎇ test ↑↓  +128 −14     ●  3
```

- 分支名；与 upstream 的 ahead/behind 仅显示箭头，数字进悬停卡。
- 工作区未提交改动的增删行数（相对 `HEAD`）。
- 悬停卡：`test → origin/master`、`↑2 ↓0`、`12 个文件（3 个新文件）`、按需计算的「分支相对 origin/master +44,154 −3,998」、更新时间。
- 非 Git 项目、未信任工作区、不满足模式条件时整块不显示，不留占位。

只读展示，不提供切换对比基准、逐文件 diff 等操作，这些留在 SCM 面板。

## 2. 适用范围：仅 Server 模式

显示条件（全部满足）：

1. SSH 项目且连接模式为 `server`（`resolveSshConnectionMode`），或 Server 端口直连（`agentEndpoint`）。
2. 工作区已信任。
3. daemon HELLO `capabilities` 包含 `git.summary`。
4. 远端为 Git 仓库。

本地、WSL、兼容模式（SSH 直连）不显示。断线时保留最后值并置灰，悬停显示更新时间。

选择 Server 的理由是 daemon 能在远端监听并主动推送，做到实时且不占网络轮询；不是因为成本——本地项目其实最便宜，后续可复用同一份 `git_summary` 实现扩展到本地（`git_push_watch.rs` 已是本地与 daemon 共用实现的先例）。

## 3. 现状与缺口

- `GitStatus`（`src/lib/git/git.ts`）已有 `branch / upstream / ahead / behind / changes`，没有行数统计；前后端均无 `numstat` / `shortstat`。
- Server 模式的远程 Git 经 `remote_git_command`（`src-tauri/src/remote_ssh/git_cmds.rs`）走工作区 HTTPS 通用 `exec`（`qingcode-server/src/workspace.rs`），全局仅 4 个命令名额。
- 文件监听只覆盖当前项目（`src/hooks/useFileWatcher.ts`）；非当前 SSH 项目靠后台轮询，默认 5 分钟 × `SSH_PROJECT_GIT_REFRESH_MULTIPLIER`(4)，实际 20–30 分钟一次，且轻量轮询不带 upstream 元数据。
- 结论：客户端拉取会让非当前 Server 项目的数字长期过期，而这些项目恰是 Agent 在后台改代码的地方。

## 4. 参考实现

### T3 Code（`pingdotgg/t3code`）

- `apps/server/src/vcs/VcsStatusBroadcaster.ts`：按 cwd 缓存、订阅计数、LRU 256；事件分 `snapshot / localUpdated / remoteUpdated`，fingerprint 去重。
- 订阅分层：侧边栏行只订阅 `subscribeVcsBranch`（HEAD watch）；完整 `subscribeVcsStatus`（numstat、ahead/behind、PR）给聊天与 diff 面板。`branchChanges`（相对 merge-base）仅在有显示需求时计算（`branchChangesDemand` 计数）。
- 侧边栏行的 `+/−`（`latestRunDiff`）当前直接返回 `null`，即逐行 diff 已停用，行上只保留分支与 PR。
- 刷新触发：HEAD watch、Agent 每轮结束（turn-end）、窗口回到前台（250ms 去抖）、远端按 fetch 间隔轮询，失败退避 30s→15min。
- 成本上限：未跟踪统计 5000 文件 / 256MB，失败退避 60s→30min；`branchChanges` 以 `(HEAD oid, merge-base)` 为缓存键。

### OpenIDEA（`l0ng-ai/openidea`）

- `crates/ide-vcs/src/status.rs`：所有 status 设 `GIT_OPTIONAL_LOCKS=0`，避免 status 回写 index → watcher 视为外部写 → 再次 status 的循环（#4792）。
- `status_paths`：watcher 批次只对变化路径跑 `git status -- <paths>`，成本与改动量成正比。
- Agent 任务行只显示分支；增删行数在「Show changes」面板。共享 checkout 用任务开始时的快照（大小 + mtime）区分「本任务改了什么」，支持 Whole Task / Last Turn。
- `BranchSync`：标题栏只显示 ↑↓ 箭头（`showCounts=false`），数字进 tooltip。

## 5. 方案设计（daemon 推送）

### 5.1 server 端

新增 daemon 订阅方法 `git.watchSummary`（仿 `daemon/git_push.rs` 的 `git.watchPush`），能力位 `git.summary`。

- 键：规范化后的项目根（必须在已登记根内，拒绝符号链接逃逸）；订阅计数，LRU 上限。
- 订阅分层：

| 层级 | 内容 | 订阅方 | 计算 |
|---|---|---|---|
| `branch` | 分支、upstream、ahead/behind（只读本地 refs，不 fetch） | 终端列表所有 Server 项目 | 监听 `.git/HEAD`、`refs` |
| `totals` | 工作区 `+/−`、文件数、未跟踪数 | 展开且有终端的项目组 | numstat |
| 分支相对主干 | merge-base `+/−` | 悬停时单次请求 | 以 `(HEAD, merge-base)` 缓存 |

- 命令：`git status --porcelain=v2 --branch -z --untracked-files=all -- .` 与 `git diff HEAD --numstat -z -- .`，范围限定项目子树（项目根可能是仓库子目录）。
- **所有 git 调用设 `GIT_OPTIONAL_LOCKS=0`**（必须）：否则监听 `.git/index` 会自触发，并与终端里 Agent 的 `git commit` 争抢 `index.lock`。
- 触发：
  - `.git/HEAD`、`refs/heads`、`index` 与工作区事件（复用 `watch.rs` 忽略规则），去抖 0.5–1s；
  - PTY 静默 N 秒 / 命令结束后补算（对应 T3 Code turn-end，daemon 已托管 PTY）；
  - 客户端窗口聚焦发 `refresh`；
  - 失败退避 30s→15min。
- 增量：批次路径少时 `git diff HEAD --numstat -z -- <paths>` 增量更新每文件计数表；路径多或丢失时全量。
- 未跟踪：只计数；超过约 5000 文件或 256MB 放弃行数，标 `untrackedOmitted`，退避重试。
- 推送 `{branch, upstream, ahead, behind, files, untracked, insertions, deletions, untrackedOmitted, at}`；有变化才推，重连先推 snapshot。
- daemon 直接 `Command` 调 git，不经 shell；远端无 git 时返回不可用，不刷错。

### 5.2 客户端

- Rust：订阅管理（仿 `setPushSyncWatches`），注册到 `src-tauri/src/lib.rs`，经 Tauri 事件转发。
- 前端：`gitStatusStore` 增加摘要字段，或独立 `gitSummaryStore`；同时用推送更新非当前 Server 项目的 branch/upstream/ahead/behind/dirty，替代其 20–30 分钟轮询。
- UI：组头一处，不进终端行；分支名 meta 色可截断，`+/−` 用 `tabular-nums`、大数缩写；悬停复用 `InfoTipCard`。具体位置与样式先出选项再定。
- 旧 daemon 无 `git.summary`：隐藏，不降级为客户端轮询。

## 6. 风险

- 版本耦合：需远端服务更新后才可见。
- 大仓库监听成本：只订阅有终端的项目，事件只触发去抖不做全量扫描。
- Windows 远端、子目录项目、无 git 主机、二进制文件需分别覆盖。
- 远程验收：Linux 与 Windows Server 主机，覆盖重连、旧 daemon 隐藏、子目录项目、Agent 提交时不抢锁、监听 index 不自触发。

## 7. 工作量（粗估）

| 部分 | 估计 |
|---|---|
| server：`git_summary` 模块、两层订阅、PTY 静默触发、增量 numstat、上限与退避、单测 | 1.5–2 天 |
| 客户端 Rust：订阅管理与命令注册 | 0.5 天 |
| 前端：store、组头、悬停卡、模式/能力判定、Web fixture | 0.5–1 天 |
| 真机验收 | 0.5 天 |

## 8. AI 时代是否值得做

### 支持做

- **监督多 Agent 的核心信号**：多个项目/终端里同时跑 Agent 时，「哪个项目在动、动了多大、在哪个分支」是决定先去审哪个的第一信息。`+3,000 −2,800` 这种规模异常比任何日志都更早暴露「Agent 跑偏 / 大面积重写」。
- **分支错位**：Agent 会自行 `git checkout` / 建分支；组头显示分支能立刻发现终端不在预期分支上，T3 Code 专门做了 branch mismatch 检测。
- **同类产品已收敛到这套基础设施**：T3 Code 的服务端状态广播、OpenIDEA 的任务级改动统计，都是为 Agent 工作流建的。
- **顺带收益**：推送替代非当前 Server 项目的慢轮询，项目角标同样变实时。

### 反对或需警惕

- **已有信号部分重叠**：项目 dirty 角标已能回答「有没有改动」，新增价值主要是「规模 + 分支」。
- **数字噪声**：Agent 持续改写时数字频繁跳动；T3 Code 停用了逐行 diff，OpenIDEA 也只在面板显示。
- **语义不精确**：共享 checkout 中多个 Agent 的改动混在一起，工作区 `+/−` 无法回答「这个终端改了什么」（需 OpenIDEA 式快照，复杂度高）。
- **覆盖面受限**：仅 Server 模式，本地项目用户看不到；协议新增长期维护成本。

### 结论：做，但分期

1. **第 0 期（约 0.5 天，零后端改动）**：组头只显示分支名（及已有元数据时的 ↑↓），数据取自现有 `gitStatusStore.snapshots`，全模式可用，先验证组头空间与信息价值。
2. **第 1 期（约 3 天）**：Server 模式 daemon 推送 `branch` + `totals` 两层，组头加 `+/−`，并替代 Server 项目的慢轮询。
3. **第 2 期（视反馈）**：悬停按需计算分支相对主干；本地项目复用同一实现；按终端快照统计「本终端改了什么」。

第 1 期是否启动，以第 0 期上线后是否确实用组头分支信息发现过错位/定位过项目为判断依据。
