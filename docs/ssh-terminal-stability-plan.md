# SSH 远程终端长时间稳定性：多子代理实施方案

状态：代码已实施（`df05f89`），审查发现的 11 个缺陷已修复；**WP-G 远端验收未完成**，验收通过前保留本文作为验收依据（2026-10-25）。本文是可直接分派给多个子代理执行的任务书，覆盖全部任务和测试。

> **审查修复记录（2026-10-25）**：Windows ConPTY 子进程退出后由等待线程关闭伪控制台，读线程才能收到 EOF 并上报退出；daemon 带序号输入在终端输入闸内检查、写入、推进，写到一半中断的序号续写剩余字节，杜绝重复执行；客户端输入改为单一有序队列，积压超过 2MB 拒绝本次输入而不是静默丢弃；重连握手失败按瞬时故障重试，只有 attach 明确返回终端不存在才结束；接回失败不再 kill 远端进程；shell 正常退出时释放独占连接；撤销信任与移除项目不再被远端清理阻塞（限时 5 秒尽力清理）；接回失败回退直连时不沿用旧 ptyId；孤儿终端按当前项目根（最深匹配）过滤；配置文件终端以标签名登记。用户可见的行为与限制落地后，同步写进 [`ssh-workspaces.md`](ssh-workspaces.md)；架构背景见 [`ssh-agent-design.md`](ssh-agent-design.md) §6、§9。

## 0. 一句话目标

在 SSH 远程终端里跑 opencode、codex CLI 这类长时间运行的 TUI 时，**网络抖动或 SSH 连接断开不再结束远端进程**。重连后接回原会话，画面和输出完整。只有在无法持久化时（远端没有 daemon、能力降级），才退回现在的"重开 shell"，并且明确告知。

## 1. 背景与现状（已核实，实施前不必重新调查）

### 1.1 问题

在 252.107（Windows OpenSSH，WinDev）的远程终端里启动 opencode 或 codex CLI，长时间运行后会偶现断开。断开后：

- 远端进程随 SSH 会话一起结束，TUI 的上下文丢失；
- 前端 `recoverSshTerminalAfterDisconnect`（`src/store/terminalStore.ts:252`）按 1/2/5/10/20 秒重开一个**新的 shell**，并提示"已重新连接，断线前运行的远端进程已结束"；5 次之后就放弃。

### 1.2 现有终端链路（直连 PTY）

| 环节 | 位置 | 说明 |
|---|---|---|
| 独占连接 | `SshManager::open_terminal_transport`（`src-tauri/src/remote_ssh.rs`） | 每个终端一条独立的 SSH 连接，避开 `MaxSessions` 限制；握手并发上限 6 |
| 通道 | `start_terminal_channel` | `request_pty("xterm-256color")` 加 `exec(command)`，命令由 `ssh_interactive_terminal_command` 生成（Windows 用 PowerShell/cmd 进入项目根、不回显启动命令） |
| 输出 | `spawn_ssh_terminal` 里的读循环 | 发 `terminal-data { id, data }` 事件；启动阶段会过滤掉清屏序列之前的内容 |
| 结束 | 同上 | 发 `terminal-exit { id, exitCode, disconnected }`。`disconnected = true` 表示收到 ExitStatus/Close 之前连接就断了 |
| 保活 | `ssh_client_config()` | **所有连接共用**：提交 3098028 之后改为 10 秒一次、约 40 秒判定断开（之前是 15 秒、约 75 秒） |

### 1.3 已经存在但没有接线的能力（本方案的关键）

qingcode-server 的 daemon **已经实现了持久化 PTY 宿主**：

- `src-tauri/qingcode-server/src/pty.rs`：`PtyHost` 用 portable-pty 创建 PTY（Windows 走 ConPTY），每个终端带 `vt100::Parser` 屏幕快照和按 seq 编号的环形缓冲；进程退出后结果再保留 30 分钟。
- `src-tauri/qingcode-server/src/daemon.rs`：能力里有 `pty.persist`、`pty.attach`；方法 `pty.create{cwd?, shell?, cols, rows}`、`pty.input`、`pty.resize`、`pty.attach{id, fromSeq}`、`pty.detach`、`pty.kill`、`pty.list`、`pty.hasChildren`；事件 `PtyData{id, seq, data}`、`PtyExit{id, code}`；没有客户端的终端保留 `DETACHED_TTL = 24h`。
- Windows 下 daemon 用 `CREATE_BREAKAWAY_FROM_JOB` 脱离 sshd 的 Job（`winproc.rs`），所以 SSH 会话结束时 daemon 和它托管的 ConPTY 不会被 sshd 一起结束（需要实测确认，见 §6）。
- 客户端已经能连 daemon：`src-tauri/src/remote_ssh/server/daemon.rs` 里有 `DaemonChannel`、`open_daemon_channel`、`daemon_rpc`（单请求、单 `DAEMON_REQUEST_ID`），目前只用于 `fs.scan`、`search.content`、`watch`。
- **缺口**：客户端从来没有调用过 `pty.*`（`ssh-agent-design.md` §0 "尚未实现：前端终端接入 daemon PTY"）。`client_id` 目前取连接 id（`daemon.rs:255`）。

### 1.4 参考：VS Code 和 Zed

| 项 | VS Code Remote | Zed Remote |
|---|---|---|
| 心跳 | 应用层每 5 秒一次，20 秒没有任何数据就判定断开（负载高时不判） | 每 5 秒 ping，超时 5 秒，连续 5 次失败（约 25 秒） |
| 重连 | 0, 5, 5, 10, 10, 10, 10, 10 秒，之后每 30 秒一次，单次 30 秒超时，宽限期 3 小时 | 立即重连，最多 3 次 |
| 终端 | **由远端服务托管，断线不结束**，重连后接回 | 断线即结束 |

本方案对齐 VS Code 的做法。

## 2. 范围

**本期要做：**

- P0：终端连接的保活改回宽松值，避免 40 秒保活误伤长时间运行的终端。
- P1：终端断开时给出原因，并留下可追溯的断开记录。
- P2：交互式远程终端改由 daemon 托管：SSH 断开时进程不结束，重连后按 seq 补发输出或用屏幕快照恢复；终端通道加应用层心跳；重连不设次数上限。
- P3：应用重启后接回终端；汇总孤儿终端，提示用户接回或结束。

**本期不做：**

- 运行配置的一次性任务（`task.spawn`）仍走直连，断线后照旧中止。
- 多个终端复用同一条 exec 通道（`stream_id` 多路复用）。每个持久化终端仍各用一条 SSH 连接加一条 daemon 通道，延续现有"终端独占连接"的模型。
- `remote.server.mode` 等设计文档里的大设置项重构。

## 3. 总体设计

### 3.1 持久化终端链路（P2）

```text
前端 terminalStore ──ssh_create_terminal──▶ 后端分派
                                              │ daemon 可用且有 pty.persist
                                              ▼
              终端独占 SSH 连接 ─exec─▶ qingcode-server connect --stdio ─▶ daemon(PtyHost)
                       ▲                                                   │ ConPTY / openpty
                       │ 断线：会话检测（PING 超时或 SSH 断开）              ▼
                       └─ 重连循环：新连接 → HELLO{clientId} → pty.attach{id, fromSeq}
```

- **一个终端一条 daemon 通道**：在终端独占的 SSH 连接上 exec `connect --stdio`，握手后在这条通道上 `pty.create`，然后持续接收 `PtyData` 和 `PtyExit` 事件，发送 `pty.input` 和 `pty.resize`。
- **断线**：只有代理通道断开，daemon 把终端标记为 detached，进程继续运行、输出继续进缓冲。
- **重连**：后端循环重建 SSH 连接和 daemon 通道，用同一个 `clientId` 握手，发 `pty.attach{id, fromSeq = 已收到的最大 seq + 1}`：
  - 缓冲还在：只补发缺失的那段，无缝衔接；
  - 缓冲已被淘汰：返回 `screen`（`contents_formatted`），前端先清屏再写入快照，然后接上实时流；
  - `exited` 有值：补发退出码，按正常退出处理。
- **回退**：daemon 不可用、没有 `pty.persist` 能力、`pty.create` 失败或设置关闭时，走现有的直连 PTY，行为和现在完全一样。终端标签上提示"此终端断线会结束进程"（仅 tooltip，不打扰）。

### 3.2 接口契约（子代理按此并行开发，改动契约必须先改本文）

**后端 → 前端事件：**

| 事件 | 载荷 | 变化 |
|---|---|---|
| `terminal-data` | `{ id, data }` | 不变 |
| `terminal-exit` | `{ id, exitCode, disconnected, reason? }` | P1 新增可选字段 `reason: string`（断开原因文案），只在 `disconnected = true` 时带 |
| `terminal-connection` | `{ id, state: 'reconnecting' \| 'attached', attempt?, reason?, restore?: 'replay' \| 'snapshot' \| 'none' }` | **P2 新增**，只用于持久化终端。`reconnecting` 表示连接断开、正在重连；`attached` 表示已接回 |
| `terminal-reset` | `{ id }` | **P2 新增**：快照恢复前要求前端清屏（xterm `reset()`），之后紧接着发一条 `terminal-data` 写入快照 |

**`ssh_create_terminal` 的返回（`TerminalSpawnResult`）新增字段：** `persistent: boolean`，表示这个终端是否由 daemon 托管。前端据此决定断线后是等待接回，还是走旧的重开逻辑。

**前端 → 后端命令：** 不新增命令。`ssh_write_terminal`、`ssh_resize_terminal`、`ssh_kill_terminal` 在后端内部按终端类型分派到直连或 daemon。P3 新增 `ssh_list_detached_terminals(connectionId)` 和 `ssh_attach_terminal(id, ptyId, cwd, cols, rows)`。

**daemon 协议（qingcode-server）：**

- `pty.create` 新增可选参数 `args: string[]`、`env: {k: v}`、`name?: string`（终端配置文件需要）。全部 `#[serde(default)]`，旧客户端不受影响。
- 新增或调整能力字符串时，客户端必须按能力判断，不能按版本号判断。
- 改动后提升 `qingcode-server` 的版本号（`SERVER_VERSION` 取 `CARGO_PKG_VERSION`），让客户端重新部署。`PROTOCOL_VERSION` 保持不变（只新增可选字段）。

**`clientId`：** 改为每个 QingCode 安装实例生成一个 UUID，持久化在应用数据目录（`qingcode-client-id`）；发给 daemon 的 `clientId` 取 `"<安装 UUID>:<连接 id>"`。detach 的归属校验依赖它，应用重启后不变，P3 用它接回终端。

### 3.3 心跳与判定参数

| 连接 | 判定方式 | 参数 |
|---|---|---|
| 主连接（SFTP、命令、watch） | SSH 保活 | 10 秒 × 4 个周期，约 40 秒（已提交，不变） |
| 直连终端连接 | SSH 保活 | **改回 15 秒 × 5 个周期，约 75 秒（P0）** |
| 持久化终端连接 | 应用层 PING/PONG 加 SSH 保活 | 每 10 秒向 daemon 通道发一次 `Kind::Ping`，30 秒内没有收到任何帧就判定断开；SSH 保活用 15 秒 × 5 个周期兜底。断开代价很低（进程不结束），所以判定可以快一些 |

持久化终端的重连节奏和 watch 一致：首次立即重连，失败后依次等 5、5、10、10、10、10、10 秒，之后每 30 秒一次，**不设上限**。用户关闭标签、项目被移除，或 `pty.attach` 返回"终端不存在"时停止。

## 4. 子代理分工

### 4.0 执行规范（每个子代理都要遵守）

1. 每个子代理用独立的 git worktree（`isolation: "worktree"`），只改自己工作包列出的文件；需要动契约外的公共代码时，在交付说明里写明原因。
2. 遵守 `AGENTS.md`：中文注释；不得用 HTML `title`，改用 `Tooltip`；新命令在 `src-tauri/src/lib.rs` 注册；远端操作留在已注册根内、保留信任门槛；设置模板逐键写注释，不得删除注释。
3. 子代理**不提交、不推送**，交付 diff 和测试输出，由集成者合并。
4. 每个工作包交付前，至少跑通"本包测试"一栏列出的命令，并贴出结果尾部。
5. 本地测试不能代替远端验收。涉及远端的结论只能写"待 WP-G 验收"。

### 4.1 依赖与并行关系

```text
第 1 波（互不依赖，可同时开）：WP-A  WP-B  WP-C  WP-F(初稿)
第 2 波（依赖契约，不依赖 C 的实现，可与 C 并行）：WP-D  WP-E
第 3 波：集成者合并 A–F → pnpm check → 打包 → WP-G 远端验收
第 4 波（P3，可选，P2 验收通过后）：WP-H
```

WP-D 用协议单元测试和本机 `connect --stdio` 回环自测，不必等 WP-C 合并；如果 WP-C 改了参数，以本文 §3.2 为准。

---

### WP-A：终端连接保活参数拆分（P0，Rust，小）

**目标**：主连接保持 10 秒 × 4 个周期，终端独占连接改回 15 秒 × 5 个周期。

**改动：**

- `src-tauri/src/remote_ssh.rs`：
  - `ssh_client_config()` 改为 `ssh_client_config(purpose: ConnectionPurpose)`，`enum ConnectionPurpose { Main, Terminal }`；常量拆成 `SSH_MAIN_KEEPALIVE_*` 和 `SSH_TERMINAL_KEEPALIVE_*`。
  - `open_transport` 和 `authenticate_session` 透传 purpose；`open_terminal_transport` 传 `Terminal`，其余传 `Main`。
  - `describe_disconnect` 的保活文案按 purpose 计算秒数（例如 `SshClient` 里存 `keepalive_window: Duration`）。
- `docs/ssh-workspaces.md` 第 75 行：分别写明主连接约 40 秒、终端连接约 75 秒，以及这样区分的原因。

**本包测试：**

- 改造 `ssh_client_waits_through_a_slow_keepalive_reply`，两个 purpose 各断言一次。
- `disconnect_reason_explains_keepalive_timeout_and_remote_close`：主连接文案含"40 秒"，终端连接含"75 秒"。
- `cargo fmt --all -- --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test remote_ssh`。

**验收**：两类连接的保活参数和文案各自正确，其余测试不变。

---

### WP-B：终端断开原因与断开记录（P1，Rust + 前端，小）

**目标**：直连终端断开时，终端里的提示带上原因；最近的断开记录可以追溯。

**改动：**

- 后端（`remote_ssh.rs`）：
  - 读循环结束、`disconnected = true` 时，从 `reader_transport.closed_reason()` 取原因（`describe_disconnect` 的文案），放进 `TerminalExitPayload.reason`（`Option<String>`，`skip_serializing_if = "Option::is_none"`）。读循环先于 `Handler::disconnected` 结束时，最多等 500 毫秒让原因落盘，再取一次。
  - 用 `log::warn!` 或现有日志设施记一行：`terminal <id> 连接 <connection_id> 断开：<reason>，存活 <时长>`。
- 前端：
  - `src/lib/terminal/*` 中解析 `terminal-exit` 的位置接收 `reason`；类型非字符串时忽略。
  - `recoverSshTerminalAfterDisconnect` 的两条提示带上原因：`SSH 连接已断开（{reason}），正在重新连接…`、`SSH 连接已断开（{reason}），任务已中止，可从终端标签重启`。没有原因时保持原文案。
  - `src/locales/en.json` 补对应的英文。

**本包测试：**

- Rust：`terminal_exit_payload_serializes_reason_only_when_present`（序列化断言）。
- Vitest：在 `terminalShellLifecycle.test.ts` 或 terminalStore 的测试里，覆盖带原因和不带原因两种提示文案；非法 `reason` 被忽略。
- `pnpm test`、`pnpm typecheck:legacy`、ESLint，以及 Rust 三件套。

**验收**：本机断开网络后，直连终端提示里出现"保活超时：约 75 秒…"。

---

### WP-C：daemon PTY 协议补齐与 Windows 对齐（P2，qingcode-server，中）

**目标**：daemon 的 `pty.create` 在 shell 选择、启动目录、配置文件参数和环境变量上，与直连终端行为一致，Windows ConPTY 下 TUI 能正常运行。

**改动（`src-tauri/qingcode-server/src/`）：**

- `daemon.rs` 的 `pty.create` 解析 `args`、`env`、`name`，透传给 `PtyCreateOptions`（新增字段）；`pty.rs` 构造 `CommandBuilder` 时用上这些字段。
- shell 默认值和白名单：
  - Linux/macOS：`$SHELL` → `/bin/sh`，以登录 shell 启动（与 `ssh_interactive_terminal_command` 的 Linux 规则一致）；
  - Windows：默认 `powershell.exe`，允许 `pwsh` 和 `cmd`；ConPTY 的 cwd 直接设为项目根，**不再注入 `cd` 命令，也就不需要客户端的清屏过滤**。
  - shell 不在白名单、或者路径不存在时返回明确错误，不静默换成别的 shell。
- 环境变量：固定设置 `TERM=xterm-256color`、`COLORTERM=truecolor`；`env` 只允许追加，不允许覆盖 `PATH` 以外的安全敏感变量（列一个拒绝表：`LD_PRELOAD`、`DYLD_*`）。
- 检查读循环：连接异常断开时（通道 EOF 或读帧失败），这个连接 attach 的所有终端都要走 detach 流程（保留进程，清掉路由）。如果目前只在显式 `pty.detach` 时才清，就补上。
- 心跳：确认 daemon 对 `Kind::Ping` 回 `Kind::Pong`，并且任何帧都会刷新连接活跃时间；没有的话补上。
- 版本：`src-tauri/qingcode-server/Cargo.toml` 的 version 加一。

**本包测试**（在 qingcode-server crate 内，`cargo test -p qingcode-server`）：

- `pty_create_accepts_args_and_env_and_rejects_preload`。
- `pty_create_rejects_unknown_shell_with_clear_error`。
- `connection_drop_detaches_attached_ptys_and_keeps_process`：模拟连接断开 → `pty.list` 显示 detached、进程存活 → 新连接 `attach{fromSeq}` 补齐输出。
- `attach_after_buffer_eviction_returns_screen_snapshot`。
- `ping_frame_gets_pong`。
- 混沌测试 `random_disconnects_never_lose_or_duplicate_output`：子进程持续输出带序号的行，随机断开或接回 50 次，拼接后按序号校验既不丢也不重。
- Windows 专属测试（`#[cfg(windows)]`，本机 Windows 上能跑）：ConPTY 启动 `powershell -NoProfile -Command "Write-Output ok"`，能收到 `ok` 和退出码 0。
- `cargo clippy -p qingcode-server --all-targets -- -D warnings`。

**验收**：上述测试全部通过；协议只新增可选字段，旧客户端的回环测试（现有测试）不变。

---

### WP-D：客户端持久化终端后端（P2，src-tauri，大，核心）

**目标**：`ssh_create_terminal` 在 daemon 可用时创建持久化终端；断线自动重连并接回；写入、尺寸调整、结束按终端类型分派。

**新增模块**：`src-tauri/src/remote_ssh/server/terminal.rs`（客户端侧），在 `server/mod.rs` 中声明。

**数据结构：**

```rust
/// daemon 托管的远程终端：SSH 断开只断代理通道，进程留在 daemon 里。
struct PersistentTerminal {
    id: String,                 // 前端终端 id
    pty_id: String,             // daemon 分配的 id
    connection_id: String,
    root_uri: String,
    /// 已收到的最大 seq + 1；重连时作为 fromSeq。
    next_seq: AtomicU64,
    size: Mutex<(u16, u16)>,
    /// 当前活跃会话的输入发送端；重连期间为 None，输入进有界缓冲。
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    pending_input: Mutex<VecDeque<Vec<u8>>>, // 上限 64KB，超出丢弃最旧的并记日志
    closed: AtomicBool,         // 用户关闭或 kill 后置位，重连循环退出
}
```

`SshManager` 里的 `terminals` 改为 `enum TerminalEntry { Direct(Arc<RemoteTerminalSession>), Persistent(Arc<PersistentTerminal>) }`，或者新增一张并列的表。选并列表时，`terminal_is_open` 和 `forget_terminal` 要同时查两张。

**流程：**

1. **创建**：
   - `ssh_create_terminal` 先检查：项目已信任、`ssh.server.enabled`、`ssh.server.persistentTerminals`（WP-F 新增，默认 `true`）、slot 里有 daemon 端点（`endpoint.daemon.is_some()`），并且 HELLO 的能力包含 `pty.persist`。任一条件不满足就走现有的直连路径。
   - 满足时：`open_terminal_transport` 建独占连接 → `open_daemon_channel` → `pty.create{cwd: 项目根, shell, args, env, cols, rows}` → 得到 `pty_id` 和 `seq`，返回 `persistent: true`。
   - 创建失败时**回退直连并记录原因**，不让用户开不了终端。
2. **会话循环**（每个终端一个 tokio 任务）：
   - 读帧：`PtyData` → 更新 `next_seq = seq + 1` → 发 `terminal-data`；`PtyExit` → 发 `terminal-exit{disconnected:false}` → 清理，退出循环。
   - seq 去重：`seq < next_seq` 的数据块直接丢弃（接回时 replay 和实时流可能有重叠）。
   - 写入：从 input 通道取数据 → `pty.input`（必须按序，沿用 daemon 要求的读循环入队语义）。
   - 心跳：每 10 秒发 `Kind::Ping`；30 秒没有收到任何帧就判定断开。
   - `DaemonChannel` 现在是"一请求一应答"（`daemon_rpc`）。这里需要**事件流加请求复用**的读写模型：为每个请求分配递增的 stream_id，用 `HashMap<u32, oneshot::Sender>` 匹配应答，事件帧单独分发。在 `daemon.rs` 里抽一个 `DaemonSession`，不要改坏现有的 `daemon_rpc` 调用方。
3. **断线与重连**：
   - 判定断开（心跳超时、通道 EOF、SSH 连接关闭）后：发 `terminal-connection{state:'reconnecting', attempt, reason}`。原因取 `closed_reason()`，心跳超时时写"约 30 秒未收到远端回包"。
   - 按 §3.3 的节奏重试：`open_terminal_transport`（主连接也断了时，先走 `ensure_connection_alive`）→ daemon 通道 → HELLO（同一个 `clientId`）→ `pty.attach{id: pty_id, fromSeq: next_seq}`。
   - daemon 本身不在了（比如远端重启），HELLO 失败或 attach 返回"不存在"：发 `terminal-exit{disconnected:true, reason:'远端 daemon 已重启，终端进程已结束'}` 并停止，前端按旧逻辑重开 shell。
   - attach 成功后：
     - 有 `screen`：先发 `terminal-reset`，再把 screen 当 `terminal-data` 发出，`restore='snapshot'`；
     - 有 replay：按序发 `terminal-data`，`restore='replay'`；
     - 两者都没有：`restore='none'`。
     - 然后发 `terminal-connection{state:'attached'}`，下发当前尺寸（`pty.resize`），冲刷 `pending_input`。
     - `exited` 有值时，直接发 `terminal-exit{exitCode, disconnected:false}`。
4. **写入、尺寸、结束**：
   - `ssh_write_terminal`：持久化终端写进 input；重连期间进 `pending_input`。
   - `ssh_resize_terminal`：更新 `size`，在线时发 `pty.resize`。
   - `ssh_kill_terminal`：置 `closed`，在线时发 `pty.kill`；离线时最多等 5 秒重连去 kill，超时就放弃（daemon 24 小时后自动回收），并记日志。
   - 关闭标签和"结束终端"语义一致，都调用 `pty.kill`。**不存在**"关闭标签但保留进程"的入口（P3 才有接回）。
5. **项目移除、断开连接、取消信任**：遍历该连接或根下的持久化终端，置 `closed` 并尽力 `pty.kill`。取消信任时必须 kill，不能保留在后台继续运行。
6. **`clientId`**：在 `lib.rs` 初始化时读取或生成安装 UUID（应用数据目录下的 `qingcode-client-id`），`daemon_hello` 用 `"<uuid>:<connection_id>"`。

**本包测试**（Rust，就近放在 `terminal.rs` 和 `daemon.rs` 的 tests 里）：

- 纯函数和状态机：
  - `reconnect_delay_schedule_matches_watch`；
  - `seq_dedup_drops_overlapping_replay`；
  - `pending_input_is_bounded_and_flushed_in_order`；
  - `attach_result_maps_to_restore_kind`（screen → snapshot，replay → replay，都没有 → none，exited → exit）；
  - `persistent_terminal_falls_back_when_capability_missing`。
- 回环集成测试（不经 SSH，本机起 `qingcode-server daemon` 加 `connect --stdio`，复用 qingcode-server 测试里的启动工具）：
  - `loopback_persistent_terminal_survives_channel_drop`：创建 → 输出 → 杀掉代理进程 → 重连 → 输出连续；
  - `loopback_kill_while_offline_eventually_kills`；
  - `loopback_daemon_restart_reports_terminated`。
- `DaemonSession` 的请求与事件复用：并发 10 个请求，中间穿插事件帧，应答全部匹配。
- Rust 三件套，加上 `cargo test -p qingcode-server`。

**验收**：回环测试中断开 50 次，输出不丢不重；直连回退路径的现有测试全部不变。

---

### WP-E：前端持久化终端交互（P2，React/Zustand，中）

**目标**：持久化终端断线时显示"重连中"，而不是"已退出"；接回后正确恢复画面；不再提示"进程已结束"。

**改动：**

- `src/lib/terminal/terminalShellLifecycle.ts`：
  - 终端状态新增 `reconnecting`（或复用 `starting`，但需要能区分；建议新增，并检查所有 `status` 的 switch）。
  - 新增纯函数 `planTerminalConnectionEvent(tab, payload)`，返回要设置的状态和要输出的提示。
- `src/store/terminalStore.ts`：
  - 保存 spawn 结果里的 `persistent`。
  - 监听 `terminal-connection`：
    - `reconnecting`：状态设为 `reconnecting`，在终端里写一行灰色提示"SSH 连接已断开（{reason}），正在重新连接，远端进程仍在运行…"。同一轮断线只提示一次，`attempt` 递增时不重复刷屏。
    - `attached`：状态恢复为 `running`，按 `restore` 提示"已重新连接"或"已重新连接（已从屏幕快照恢复，部分历史输出不可用）"。
  - 监听 `terminal-reset`：调用该终端 xterm 实例的 `reset()`（通过 `terminalViewBridge`），并清掉渲染屏障的残留状态。
  - `terminal-exit` 里 `persistent` 终端的 `disconnected: true`（daemon 重启）：沿用旧的重开逻辑，提示文案用后端给的 reason。
  - `recoverSshTerminalAfterDisconnect` 只对非持久化终端生效。
- 终端标签：
  - `reconnecting` 显示转圈或琥珀色点，配 `Tooltip`："正在重新连接，远端进程仍在运行"；
  - 非持久化的 SSH 终端，tooltip 补一句"此终端断线会结束远端进程"，并附原因（daemon 不可用、设置已关闭等）。
- 重连期间的输入：允许输入，由后端缓冲，界面不禁用。
- `src/locales/en.json` 补齐所有新文案。

**本包测试（Vitest）：**

- `terminalShellLifecycle.test.ts`：`planTerminalConnectionEvent` 覆盖 reconnecting（首次和重复 attempt）、attached 的三种 restore，以及非法载荷被忽略。
- terminalStore 测试：
  - 持久化终端收到 `terminal-connection` 后状态正确流转，并且**不会调用** `createTerminal` 重开 shell；
  - 非持久化终端仍走旧的 1/2/5/10/20 秒重开；
  - `terminal-reset` 调用桥接的 reset。
- 组件测试：重连中的标签有 Tooltip、没有 `title` 属性（ESLint 也会检查）。
- `pnpm test`、`pnpm typecheck:legacy`、ESLint。

**验收**：模拟事件序列 `reconnecting → attached(snapshot)`，画面先 reset 再写入快照，标签状态从"重连中"回到"运行中"，全程没有"已退出"。

---

### WP-F：设置项与文档（P2，小）

**改动：**

- `src/lib/projectSettings.ts` 的默认模板，在 `ssh.server.*` 一组新增：

  ```json5
  // SSH 远程终端由远端 qingcode-server daemon 托管：断网或 SSH 断开时终端进程继续运行，
  // 重连后接回原会话。关闭后终端直连 SSH，断线即结束远端进程。需要 ssh.server.enabled。
  "ssh.server.persistentTerminals": true,
  ```

  按 `AGENTS.md`，逐键写注释，不得删除注释；同步设置解析、类型和后端读取（参照 `ssh.server.enabled` 的链路）。
- `docs/ssh-workspaces.md`：
  - 终端一节：写明持久化终端的行为、回退条件、重连节奏、24 小时回收、"重连期间输入会被缓冲"；
  - 限制：一次性任务不持久化；daemon 重启（远端重启机器）后进程会结束；Windows 远端依赖 Job 脱离；
  - 保活参数按 WP-A 更新。
- `docs/ssh-agent-design.md` §0：把"前端终端接入 daemon PTY"从"尚未实现"移到"已实现"（合并时再改），并注明应用重启后接回属于 P3。

**本包测试**：`projectSettings` 现有的模板注释测试和快照测试通过；新增"解析时缺省为 true、非布尔值回退为默认值"的测试。

---

### WP-G：远端验收（测试代理，P2 合并并打包之后）

按 `AGENTS.md`，必须在**一次性远端项目**上做（例如在远端新建 `~/qingcode-accept-<日期>/`，验收后删除），不能用本地测试代替。

**主机：**

| 主机 | 必测 | 说明 |
|---|---|---|
| 192.168.252.107（WinDev，Windows OpenSSH） | 是 | 问题发生的主机；重点是 ConPTY、Job 脱离、PowerShell |
| 一台 Linux x64（Ubuntu） | 是 | 检查 systemd `KillUserProcesses` 的取值 |
| macOS | 否 | 有条件时再测 |

> 252.107 目前不在 sshctl 清单里。验收前由用户提供凭据，或者由用户在 QingCode 里手动连接；**测试代理不得自行把它加入清单**。

**准备：**

- 打包：`pnpm package`，安装 `release/QingCode-setup.exe`。
- 远端确认：`qingcode-server` 已部署到新版本；状态芯片为"Server"，传输方式是"常驻 daemon"；HELLO 的能力里有 `pty.persist`（Server 详情或日志里可以看到）。

**用例（每条记录：步骤、预期、实际、截图）：**

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| G1 | 首次连接和指纹 | 新连接的一次性项目，确认指纹 | 指纹确认弹窗出现；指纹变化时被拦截 |
| G2 | 持久化终端创建 | 打开终端，运行 `echo ok` | 终端正常，`persistent=true`（日志），启动目录是项目根，没有残留的启动命令回显 |
| G3 | 短断线 | 运行 `ping -t 127.0.0.1`（Windows）或 `top`（Linux），禁用本机网卡 20 秒后恢复 | 标签显示"重连中"；恢复后输出连续，**进程还是同一个**（PID 不变）；没有出现"进程已结束" |
| G4 | 长断线 | 同 G3，断开 5 分钟 | 进程存活；接回时 replay 或快照恢复，画面正确 |
| G5 | opencode 长跑 | 在终端里启动 opencode，让它执行一个耗时任务；中途断网 2 分钟 | 恢复后 opencode 界面完整，任务继续，上下文没有丢 |
| G6 | codex CLI 长跑 | 同 G5，换成 codex CLI | 同上 |
| G7 | 8 小时浸泡 | opencode 和 codex 各开一个终端，空闲加间歇使用 8 小时，期间允许本机睡眠一次 | 两个终端都在原进程上；记录期间每次断开的原因（WP-B 的日志） |
| G8 | 重连期间输入 | 断网时在终端里敲几个字符，再恢复网络 | 恢复后字符按序送达 |
| G9 | 调整尺寸 | 断网期间调整窗口大小，然后恢复 | 接回后 TUI 按新尺寸重绘 |
| G10 | 关闭终端 | 关闭标签；另开一个 SSH 会话查看远端进程 | 远端对应的 shell 和子进程被结束 |
| G11 | 断网时关闭 | 断网后关闭标签，5 秒内恢复网络 | 恢复后进程被 kill；超时则在 24 小时内回收（记录 `pty.list`） |
| G12 | daemon 重启 | 在 Server 菜单里重启 Server，或远端结束 daemon 进程 | 终端提示"远端 daemon 已重启，终端进程已结束"，并自动开出新的 shell |
| G13 | 回退 | 关闭 `ssh.server.persistentTerminals`，重开终端后断网 | 行为与现在一致：重开 shell，提示里带原因；标签 tooltip 写明"断线会结束远端进程" |
| G14 | 信任 | 撤销工作区信任 | 持久化终端被结束；不能新建终端 |
| G15 | 根边界 | 持久化终端的 cwd 只能是已注册根；尝试通过符号链接把 cwd 指向根外 | 被拒绝 |
| G16 | 多终端 | 同时开 8 个持久化终端，断网后恢复 | 全部接回；握手并发不超过 6；没有 `MaxStartups` 报错 |
| G17 | Windows Job 脱离 | 在 252.107 上，远端用 `Get-Process` 和 `Get-CimInstance Win32_Process` 查看 daemon 的父进程和 Job；结束客户端那条 SSH 连接 | daemon 和 ConPTY 子进程存活。如果 Job 不允许脱离，要记录下来，作为 `pty.persist` 降级的依据 |
| G18 | Linux logind | 在 `KillUserProcesses=yes` 的主机上，断开所有 SSH 会话后重连 | 记录是否存活；不存活时要能看到降级提示（如果尚未实现，作为风险记录下来） |
| G19 | 主连接断线 | 只断主连接（重启远端 sshd） | 文件树和 watch 自动恢复（上一轮的改动）；终端按 G3 恢复 |
| G20 | 混合 Git 与 SFTP | 终端长跑期间做文件保存、Git 提交、上传 | 互不影响 |

**断开根因记录**：G7 期间每次断开，都要摘录 WP-B 写的日志原因，归类成"保活超时"、"远端主动断开"、"本机休眠"、"网络错误"。如果远端主动断开占多数，就检查远端 sshd 的 `ClientAliveInterval`/`ClientAliveCountMax`、`MaxSessions`、Windows 电源策略和网卡节能设置。这部分是配置建议，不要改远端系统配置，除非用户明确要求。

**交付**：一份验收记录（建议 `docs/release-notes/` 下按日期命名），逐条写通过、不通过或阻塞，附截图路径和日志摘录。

---

### WP-H：应用重启后接回与孤儿终端（P3，可选）

**目标**：关闭并重新打开 QingCode 后，按持久化的终端标签接回远端终端；不在任何标签里的远端终端汇总提示。

**改动要点：**

- 会话持久化（`terminalSessionPersist.ts`）里给持久化终端额外保存 `ptyId` 和 `connectionId`。
- 恢复会话时，先调用 `ssh_attach_terminal(id, ptyId, …)`，成功就直接接回，失败（不存在或已退出）再按普通方式新建。
- 后端 `ssh_list_detached_terminals(connectionId)` 调用 `pty.list`，过滤出 detached 且属于本安装 `clientId` 前缀的终端。
- 连接就绪后，如果有本地标签没有对应上的 detached 终端，弹一次 Toast："远端还有 N 个终端在运行"，提供"接回"（为每个开一个标签）和"全部结束"两个操作。
- 测试：
  - Vitest：恢复计划的纯函数（有 ptyId 的先 attach，失败再新建）；
  - Rust：`clientId` 前缀过滤；
  - 远端：G21 关闭应用 10 分钟后重开，接回 opencode 会话；G22 手动制造孤儿终端，测"接回"和"全部结束"。

## 5. 集成与发布

集成者（主会话）按以下顺序执行：

1. 合并 WP-A、WP-B（可以先单独发一个 `fix:` 提交，尽早拿到断开原因）。
2. 合并 WP-C、WP-D、WP-E、WP-F，解决冲突，按 §3.2 核对契约。
3. 跑全量检查：`pnpm check`（前端 typecheck、Vitest 覆盖率、打包测试、ESLint，以及 Rust fmt、clippy、test）。另外跑 `cargo test -p qingcode-server`。系统剪贴板被占用导致的剪贴板测试偶发失败，用 `--test-threads=1` 单独复跑确认。
4. `pnpm tauri build --no-bundle` 验证生产构建，然后 `pnpm package`。
5. 交给 WP-G 验收。G1–G6、G10、G12–G15、G17 必须通过；G7 浸泡期间不得出现"进程已结束"。
6. 提交：按工作包拆成聚焦的提交（`fix:` 或 `feat:` 加中文摘要，结尾加 Co-Authored-By）。只有用户要求时才推送。

**回滚开关**：`ssh.server.persistentTerminals = false` 时完全回到直连终端；或者 `ssh.server.enabled = false`。出问题时先让用户关这个开关，再排查。

## 6. 风险与未决问题

| 风险 | 影响 | 应对 |
|---|---|---|
| Windows sshd 的 Job 不允许 breakaway | daemon 随 SSH 会话一起结束，持久化无效 | G17 实测。不行就按设计文档 §6.4 改用 `schtasks` 一次性任务拉起 daemon（单独一个工作包）；在那之前，HELLO 不报 `pty.persist`，客户端自动回退 |
| Linux `KillUserProcesses=yes` | 用户最后一个会话结束时 daemon 被结束 | G18 实测并记录；探测加降级提示，按设计 §6.4 后续实施 |
| ConPTY 下某些 TUI 渲染异常 | opencode 或 codex 画面错乱 | G5、G6 对比直连终端；快照恢复后有问题时，让 TUI 主动重绘（resize 抖动一次：cols−1 再 +1） |
| 快照恢复丢失历史滚动内容 | 用户看不到断线期间较早的输出 | 环形缓冲默认 2MB，长断线高输出时才会触发；提示文案说明原因 |
| 持久化后进程被遗忘、占用资源 | 远端残留大量进程 | 24 小时 TTL 回收；P3 汇总孤儿终端；关闭标签即 kill |
| 终端独占连接 × N 撞上 `MaxStartups` | 断线后多个终端同时重连失败 | 握手信号量（6）沿用；重连循环加 0–1 秒随机抖动，错开同时重连 |
| 应用层心跳 30 秒判定过于敏感 | 远端很忙时误判断开 | 误判的代价只是一次接回，进程不受影响；如果 G7 期间重连频繁，再调到 45 秒 |
| 252.107 没有凭据 | WP-G 无法执行 | 用户提供凭据或手动连接；测试代理不得自行加入 sshctl 清单 |

## 7. 完成定义

- P0、P1：断开的终端能看到原因；直连终端的保活回到约 75 秒；测试通过并已提交。
- P2：G1–G20 中的必测项在 252.107 和 Linux 上全部通过；opencode 和 codex CLI 断网 2 分钟后都在原进程上继续；`pnpm check` 全绿；`ssh-workspaces.md` 和 `ssh-agent-design.md` 已更新。
- P3（可选）：G21、G22 通过。
