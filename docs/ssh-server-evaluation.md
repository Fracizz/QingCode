# qingcode-server 实现评估

评估日期：2026-10-24

> 修复状态（2026-10-24）：下列 12 项问题均已在 `1f3f4dc` 完成代码修复与回归测试；
> `pnpm check` 通过。本文后续“实现与设计的差距”仍描述修复前的产品状态，
> 客户端接入 PTY、`workspace.open`、能力域迁移等设计目标仍未实现。
>
> 复查（2026-10-24）：复查 `1f3f4dc` 时发现修复引入的 6 个新问题，见文末
> [「复查：新问题与任务卡」](#复查新问题与任务卡)。每张任务卡可独立交给子代理处理。

## 结论

底层基础打得不错，但只完成了 [`ssh-agent-design.md`](ssh-agent-design.md) 目标的一部分：真正带来收益的终端持久化，客户端还没接上。另有 2 个搜索语义 bug 已实测复现，还有 1 个 Windows 上的安全问题。

评估范围：`src-tauri/qingcode-server/`（约 8.5k 行）与客户端 `src-tauri/src/remote_ssh/server/`（约 3.4k 行），含 `test` 分支当时未提交的改动。

## 做得好的地方

- **协议层（`proto.rs`）**：帧格式、单帧上限、半帧处理、信用窗口、优先级队列都清楚，单测齐全。
- **本地 IPC 防线**：Unix 用 `0700` 目录 + `SO_PEERCRED` 校验 uid + `flock` 单实例锁；Windows 命名管道 DACL 只放行当前用户，`FIRST_PIPE_INSTANCE` 当单实例锁，并处理了幽灵连接；token 用 `getrandom` 生成且每次启动轮换。
- **Windows 上的坑处理到位**：`CreateProcessW + HANDLE_LIST` 避免继承 SSH 会话管道；同步管道句柄不能同时读写；accept 不能被 `select!` 取消。
- **PTY 宿主（`pty.rs`）**：环形缓冲 + `vt100` 快照两条恢复路径，总量 256MB 硬上限，淘汰策略合理，`/proc` 查子进程考虑了僵尸进程。
- **降级链完整**：daemon → serve → 直连，降级有冷却、部署有退避，失败原因会显示到状态芯片。
- **测试**：daemon 有回环集成测试（握手、断线后 attach 补发、输入顺序、取消），`pnpm check` 用 `--workspace` 覆盖了这个 crate。

## 实现与设计的差距

设计里的核心收益大多还没落地，下表逐项对照。

| 设计目标 | 现状 |
| --- | --- |
| 终端断线保活、重连接回（设计称「核心收益」） | daemon 侧已实现，**客户端从未调用 `pty.*`**，目前是死代码 |
| 一个工作区只占一条 SSH 连接、请求复用一个通道 | 客户端**每次调用新开一个 exec 通道**、拉起 `connect` 进程并重新握手（`src-tauri/src/remote_ssh/server/daemon.rs:33`），目录扫描开销不比 SFTP 小 |
| `fs.*` / `git.*` / `format` / `task` / `transfer` | 未实现，只有 `fs.scan`、`search.content`、`watch.subscribe` |
| `workspace.open` 注册项目根、daemon 侧校验信任 | 未实现：`canonical_root` 接受任意绝对路径当根（`qingcode-server/src/daemon.rs:1062`），信任只在客户端检查 |
| 安装到 `~/.qingcode/server/<version>/`，保留两个版本 | 实际部署在 `<项目>/.qingcode/server/`，每个项目一份二进制 |
| inotify 不足时降级轮询、`KillUserProcesses` 探测、Windows 子进程探测 | 均未实现（Windows 上 `has_children` 恒为 false） |

现在同时维护**三条传输路径**（serve 的 TCP+JSON、daemon 的协议 v1、直连），复杂度高；daemon 稳定后建议下掉 serve。

## 问题清单（修复前）

共 12 项：高 3、中 6、低 3。中级问题大多在客户端接入 PTY 后才会暴露。

### 高

1. **搜索字面量转义错误**（`qingcode-server/src/lib.rs:189`）。给所有 ASCII 标点加反斜杠，但 regex 1.10 起 `\<`、`\>` 是单词边界。用 lockfile 版本（regex 1.13.1）实测：搜 `<div` 会命中普通 `div`（误报），搜 `a>b` 匹配不到字面量（漏报）。修复：改用 `regex_syntax::escape` 或字面量模式。
2. **搜索不跳过二进制文件**（`qingcode-server/src/ops.rs:216`）。`SearcherBuilder` 默认 `BinaryDetection(None)`（已实测），`.so`、`.png` 会返回乱码行，与 rg 不一致。修复：加 `.binary_detection(BinaryDetection::quit(b'\x00'))`。
3. **Windows 命名管道可被同机其他用户抢注**（`qingcode-server/src/ipc.rs:194`、`:216`）。管道名可由运行目录推算且整机共享。攻击者抢先以宽松 DACL 创建同名管道后，受害者 daemon 误判「已有实例」退出，`connect` 连到攻击者，HELLO 里的 token 与终端按键（可能含密码）都会泄露。修复：client 端用 `GetNamedPipeServerProcessId` 校验对端属主 SID，或在管道名中加入本用户私有的随机数。

### 中

4. **已退出的终端永不移除**（`qingcode-server/src/pty.rs:444`、`:517`）。只有「已脱离且超时」才回收，`pty.kill` 也不删。后果：占着 64 个名额、daemon 无法空闲退出、计入 `pty_count`。
5. **attach 时序缺口**（`qingcode-server/src/daemon.rs:1424`）。`attach()` 取快照与 `set_route()` 非原子，中间的新输出被 `pty_events` 当作「无人持有」丢弃，客户端 seq 会断档。
6. **一条连接上所有终端的输入共用一个串行队列**（`qingcode-server/src/daemon.rs:580`）。一个终端的进程不读 stdin 时写入阻塞，其他终端的按键全部排队直到报 `ptyBusy`。应改为每个终端一个队列。
7. **发送通道无界**（`qingcode-server/src/daemon.rs:770`、`:951`）。writer 阻塞在 `write_frame` 时 8MB 上限不生效；客户端仍回 PING 就不会心跳超时，高速输出的终端会撑爆内存。另外 writer 按批写完才看新帧，优先级只在批内生效。
8. **把项目目录里的二进制直接执行**。本地缺二进制时，发现路径只核对版本号就执行 `<项目>/.qingcode/server/` 下的文件（降级重试传 `None` 时同样）。恶意仓库提交该目录和 `server.json`，即可在用户信任工作区后执行任意代码；且该二进制会成为所有项目共用的 daemon。
9. **文件监视把 `node_modules`、`target` 也注册进 inotify**（`qingcode-server/src/watch.rs:137`，只在发事件时过滤）。大仓库易触发 `ENOSPC`，且无轮询兜底。

### 低

10. **崩溃后读到旧 token**：Unix 上 daemon 崩溃后 socket 与 token 文件残留，`wait_ready` 立刻判定就绪，首次连接失败（`qingcode-server/src/connect.rs:380`）。客户端 10 秒轮询能兜住。
11. **`server.json` 先写后改权限**（`qingcode-server/src/main.rs:581`）：先 `fs::write` 再 `chmod 0600`，中间有短窗口其他用户可读，应用 `OpenOptions::mode` 直接创建。token 比较非常量时间；serve 的 TCP 端口对本机所有用户可连且无连接数上限。
12. **文档与代码不一致**：设计文档仍写「设计稿」和 `qingcode-agent`；`lib.rs` 注释里的安装目录与实际不符；`main.rs` 写着「代理只跑在 Linux」。

## 建议顺序

先修改动小、用户直接能感知的搜索 bug，再补安全问题，接入 PTY 前清掉终端相关隐患。

1. **立即**：修第 1、2 项并补回归测试；然后修第 3 项。
2. **接入 PTY 之前**：修第 4–7 项，并把客户端改为「一条常驻通道 + 按 `stream_id` 分发」。
3. **中期**：安装目录挪到家目录并校验 sha256（第 8 项）；daemon 侧实现 `workspace.open`；收敛掉 serve 路径；同步设计文档，标出已实现与未实现部分。

## 复查：新问题与任务卡

复查对象：`1f3f4dc`（fix: 完成 SSH Server 评估修复与安全加固）。原 12 项均已修复；修复过程引入 6 个新问题（中 2、低 4）。下面每张任务卡都写明了现状、根因、改法、验收和约束，可直接交给子代理执行，不需要额外上下文。

### 原 12 项核对结果

| # | 结论 | 实现要点 |
| --- | --- | --- |
| 1 | 已修 | `escape_regex_literal` 改用 `regex_syntax::escape`，有 `<div` / `a>b` 回归测试 |
| 2 | 已修 | `BinaryDetection::quit(b'\0')`，有二进制文件跳过测试 |
| 3 | 已修 | 客户端连上管道后用 `GetNamedPipeServerProcessId` + SID 比对校验服务端属主；抢注者仍可让 daemon 起不来（仅 DoS） |
| 4 | 已修，但过度 | 退出即移除，见 R1 |
| 5 | 已修 | 路由表锁内完成快照与登记，`Replaying → Draining → Live` 三阶段，按 seq 去重与检测断档 |
| 6 | 已修 | 每个 PTY 独立输入队列；Unix master 置非阻塞，写入可取消 |
| 7 | 已修，但波及监视 | 有界通道 + 写满即断开，见 R2 |
| 8 | 已修 | 二进制只放 0700 的 `~/.qingcode/server/<version>/`，执行前校验 sha256；无校验回退路径已从类型上删除 |
| 9 | 已修 | 逐目录 `NonRecursive` 注册并剪枝高变动目录；`ENOSPC` 降级轮询；引出 R4、R5 |
| 10 | 已修 | `wait_ready` 真实连一次 IPC 端点 |
| 11 | 已修 | 0600 临时文件 + 原子 rename；token 常量时间比较；serve 连接上限 32 |
| 12 | 已修 | 设计文档与使用文档已同步 |

### 子代理通用约定

所有任务卡都遵守以下约定，任务卡里不再重复：

- 先读仓库根目录 `AGENTS.md`；代码注释用中文，风格与周围代码一致。
- 只改任务卡「涉及文件」列出的文件，不顺手重构其他代码；不提交、不推送，由主会话统一提交。
- 完成后必须通过（在 `src-tauri/` 目录执行）：
  - `cargo fmt --all -- --check`
  - `cargo clippy -p qingcode-server --all-targets -- -D warnings`（R6 改为 `cargo clippy --all-targets -- -D warnings`）
  - `cargo test -p qingcode-server`（R6 改为 `cargo test content_search`）
- 标注「Unix」的测试在 Windows 主机上会被跳过，必须在 Linux（WSL 或 CI）上实际跑过并贴出结果；跑不了时在汇报里明确写出「未在 Linux 验证」。
- 汇报内容：改了什么、新增了哪些测试、上述命令的结果。

### 并行分组

R1、R3、R5 都改 `pty.rs`，必须交给同一个子代理按 R1 → R3 → R5 顺序做；其余互不冲突，可并行。

| 子代理 | 任务卡 | 主要文件 | 优先级 |
| --- | --- | --- | --- |
| A | R1 → R3 → R5 | `qingcode-server/src/pty.rs`，少量 `daemon.rs` | R1 中，R3/R5 低 |
| B | R2 | `qingcode-server/src/daemon.rs` | 中（影响已上线的文件监视，最先做） |
| C | R4 | `qingcode-server/src/watch.rs` | 低 |
| D | R6 | `src/content_search.rs` | 低 |

A 与 B 都会动 `daemon.rs`：A 只改 `dispatch_pty_exit` / `finish_attach_replay` 附近，B 只改 `OutboundSender` 与 `watch_subscribe`，合并时注意冲突。

### R1（中）终端退出后立即删除，断线重连拿不到退出码和尾部输出

- **涉及文件**：`src-tauri/qingcode-server/src/pty.rs`、`src-tauri/qingcode-server/src/daemon.rs`
- **现状**：`pty.rs` 的 `read_loop`（约 804–835 行）在进程退出后执行 `remove_term_locked`，终端立即从 registry 移除。断线期间退出的终端没有路由，`PtyEvent::Exit` 被丢弃；客户端重连后 `pty.attach` 只会得到「终端不存在或已回收」。
- **影响**：违背设计 §6.2「断线期间进程如果已经退出，补发 `pty.exit`，带退出码」；最后一屏输出（例如编译失败信息）随之丢失。
- **根因**：修第 4 项（已退出终端永不移除）时，把「退出」等同于「可以删除」，没有区分退出事件是否已送达某个客户端。
- **改法**：
  1. `read_loop` 退出时只设置 `exited` 与新增字段 `exited_at: Option<Instant>`（放在 `TermState`），**不再**调用 `remove_term_locked`；保留 ring 与 parser，照常 `blocking_send(PtyEvent::Exit)`。
  2. `PtyHost` 新增 `pub fn release_exited(&self, id: &str)`：仅当该终端已退出时调用 `remove_term_locked` 移除（未退出时什么也不做）。
  3. daemon 在「退出事件确实交给某个连接」后调用 `release_exited`：
     - `dispatch_pty_exit` 的 `RoutePhase::Live` 分支，在 `send_to_conn` 成功后调用；
     - `finish_attach_replay` 中 pending 排空且 `route.exit_delivered` 为真、移除路由时调用（这同时覆盖「attach 一个已退出终端」：attach 应答带 `exited`，重放结束后释放）。
  4. 未送达的「墓碑」由 `reap` 兜底：新增常量 `EXITED_RETENTION: Duration = 30 分钟`，`reap` 额外移除 `exited_at` 超过该时长的终端（无论是否 attached）。已退出终端不需要再发信号。
  5. `create` 里的限额检查只统计未退出的终端（`exited.is_none()`），墓碑不占 64 个名额；墓碑仍计入总缓冲预算（`total_bytes`），淘汰逻辑不变。
  6. `pty.kill` 对已退出终端的现有行为（直接移除）保持不变。
- **验收（新增测试，Unix）**：
  - `pty.rs`：detached 状态下让 shell 执行 `echo done; exit 7`，等到 Exit 事件后，`attach(id, 0, ..)` 成功，`exited == Some(7)`，replay 中包含 `done`；随后 `release_exited` 后 `list()` 为空。
  - `pty.rs`：墓碑存在时 `create` 不因限额失败（`max_ptys = 1`，先让一个终端退出且不释放，再创建第二个应成功）。
  - `pty.rs`：`reap` 在 `EXITED_RETENTION` 到期后移除墓碑（测试里把保留时长做成可注入参数，或用 `reap_with(now)` 之类的内部函数，不要真等 30 分钟）。
  - `daemon.rs` 回环测试：连接 A 创建终端 → 断开 → 终端执行 `exit 3` → 连接 B `pty.attach` 收到 `exited: 3` 和尾部输出 → 之后 `pty.list` 不再包含该终端。
- **约束**：不得改变 seq 语义和 `AttachResult` 字段；不得让墓碑阻止 daemon 空闲退出超过 `EXITED_RETENTION`。

### R2（中）文件监视的事件突发会断开整条 daemon 连接

- **涉及文件**：`src-tauri/qingcode-server/src/daemon.rs`
- **现状**：`watch_subscribe`（约 1650–1700 行）对每个文件事件调用 `conn.send(Priority::Rpc, …)`；它走 `OutboundSender::try_send`（约 520 行），写进深度 `OUTBOUND_DATA_DEPTH = 64` 的数据通道，写满就 `abort()` 断开整条连接，而且返回值被忽略。
- **影响**：`git checkout` 大分支、解压文件到项目目录等场景，在 SSH 较慢（writer 阻塞在 `write_frame`）时会超出 64 帧，连接被断开，客户端重连期间的事件全部丢失。这是已上线功能（目录树自动刷新）的回归。
- **根因**：第 7 项的「写满即断开」策略本是为 PTY 输出设计的（断开后可以靠 attach 重放恢复），但被统一套用到了没有重放机制的监视事件上。
- **改法**：
  1. `OutboundSender` 新增 `async fn send_async(&self, priority: Priority, frame: Frame) -> bool`：`Priority::Control` 走 `control`，其余走 `data`，用 `Sender::send(...).await`（有背压、不断开）；接收端已关闭时返回 false。连接已在关闭（`closing` 为真）时直接返回 false。
  2. `ConnCtx` 增加对应的 `async fn send_async`。
  3. `watch_subscribe` 改用 `conn.send_async(...).await`；返回 false 时把该订阅的 cancel 标记置位并 `break`。背压会经 64 深度的 `rx` 传回监视线程的 `blocking_send`，再传到 notify 的 debouncer，不会无限堆积。
  4. PTY 输出和搜索仍保持现状（PTY 靠重放兜底，搜索已有信用窗口），不要改。
  5. 可选优化（不强制）：在 `watch_subscribe` 中按 50ms 窗口合并同一路径的重复事件，减少帧数。
- **验收（新增测试）**：
  - `daemon.rs` 回环测试：订阅 `watch.subscribe` 后，客户端暂停读取（不消费帧），在根目录下快速创建 500 个文件；等待 2 秒后恢复读取，必须能读到不少于 64 条 `FsChange` 事件，且连接仍然可用（之后发 `server.info` 能收到 RES）。该测试在 Windows 和 Unix 都应能运行。
  - 现有 `watch_subscribe_streams_fs_change_until_cancelled` 测试保持通过。
- **约束**：不得把数据通道改回无界；不得在持有 `routes` / `conns` 锁时 `.await`。

### R3（低）回收 detached 终端时读线程可能永久卡住、进程不被强杀

- **涉及文件**：`src-tauri/qingcode-server/src/pty.rs`
- **现状**：
  - `push_output`（约 841 行）在 registry 中找不到终端时返回 false，`read_loop` 随即停止读取，转去 `child.wait()`。`kill` 和 `reap` 都会先把终端移出 registry。
  - `kill`（约 495 行）有「SIGHUP 后 1 秒仍未退出就强杀」的看门狗；`reap`（约 574 行）只发 SIGHUP，没有看门狗。
- **影响**：进程忽略 SIGHUP（如 `trap '' HUP`、`nohup`）时，被回收的终端进程永远不退出，读线程永久阻塞在 `wait()`；同时因为不再读 master，进程写终端会被阻塞。
- **改法**：
  1. 抽出 `fn terminate(term: &Arc<PtyTerm>) -> Result<(), String>`：`hangup` + 启动 1 秒看门狗 `force_kill`（即 `kill` 现有逻辑）。`kill` 和 `reap` 都改为调用它；daemon 退出时逐个 kill 的逻辑不变。
  2. `push_output` 在终端已不在 registry 时返回 true 并丢弃数据（不入 ring、不发事件），`read_loop` 继续读到 EOF 为止，保证进程输出不被阻塞。只有 `sink` 已关闭（daemon 正在退出）时才返回 false 结束读取。
- **验收（新增测试，Unix）**：创建终端执行 `trap '' HUP; while :; do echo x; sleep 0.05; done`，detach 后以 `detached_ttl = 0` 调用 `reap`，5 秒内必须收到该终端的 `PtyEvent::Exit`。
- **约束**：R1 完成后再做（两者都改 `read_loop` / `push_output`）。

### R4（低）监视的两处性能问题

- **涉及文件**：`src-tauri/qingcode-server/src/watch.rs`
- **现状与改法**：
  1. **每个文件事件都对已监视目录集合整体 `retain`**（`refresh_watch_tree`，约 205–221 行）。事件突发时开销为 O(目录数 × 事件数)。改法：
     - 非目录分支：仅当 `watched.contains(path)`（即该路径本身是曾注册过的目录，现已删除或变成符号链接）时才执行 `retain`，否则直接返回。
     - 目录分支：`watched.contains(path)` 时直接返回，不再调用 `register_watch_tree` 遍历整棵子树；其子目录新建会产生各自的事件，届时再注册。
  2. **轮询兜底每秒全量遍历项目树**（`WATCH_POLL_INTERVAL = 1s`，约 30 行）。触发降级的恰恰是大仓库。改法：间隔改为 5 秒（与设计文档一致）；把间隔改为 `poll_loop` 的参数，生产代码传常量，测试传 100ms，避免测试变慢。
- **验收（新增测试）**：
  - 构造已注册 2000 个目录的 `watched` 集合，连续调用 1 万次文件路径的 `refresh_watch_tree`，断言 `watched` 不变（可用耗时上限做粗略校验，不要写易抖动的严格阈值）。
  - 目录被删除时其后代仍会被移出 `watched`（保留现有语义）；新建子目录仍会被注册（已有测试保持通过）。
  - 轮询测试改用注入的短间隔后仍然通过。
- **约束**：不得改变事件过滤语义（`EmitFilter`）和对外事件格式。

### R5（低）`wait_readable` 用 `select`，fd ≥ 1024 时退化为固定睡眠

- **涉及文件**：`src-tauri/qingcode-server/src/pty.rs`
- **现状**：`wait_readable`（约 761–797 行）用 `libc::select`；fd ≥ `FD_SETSIZE`（1024）时改为固定 `sleep(250ms)`，终端输出延迟明显变大。daemon 最多 64 个 PTY，加上连接与 inotify，fd 编号超过 1024 的可能性虽低但存在。
- **改法**：改用 `libc::poll`（单个 `pollfd`，`events = POLLIN`，超时 250ms），去掉 `FD_SETSIZE` 分支；`EINTR` 时重试，其余错误直接返回（随后的 `read` 会给出真实错误）。`POLLHUP` / `POLLERR` 也视为可读，交给 `read` 处理 EOF/EIO。
- **验收（新增测试，Unix）**：用 `fcntl(fd, F_DUPFD, 1100)` 把一个 pipe 读端复制到 ≥1024 的编号（失败则跳过测试），向写端写入数据后 `wait_readable` 应在 50ms 内返回。现有 PTY 测试全部通过。
- **约束**：R1、R3 完成后再做。

### R6（低）主程序「搜索进行中取消」测试被弱化

- **涉及文件**：`src-tauri/src/content_search.rs`
- **现状**：原测试 `cancel_stops_in_flight_search` 在搜索进行中置位取消标记；`1f3f4dc` 为避免竞态，改成 `cancel_flag_stops_search_and_marks_cancelled`（约 654 行），在开始前就置好标记。「进行中取消」这一场景已没有测试覆盖。
- **改法**：
  1. 保留现有「预先置位」测试。
  2. 在搜索状态结构中增加仅测试可见的钩子（`#[cfg(test)]` 字段，例如每扫描完一个文件调用一次的 `Option<Arc<dyn Fn(usize) + Send + Sync>>`），生产构建不编译该字段。
  3. 新增测试：准备 200 个含 `needle` 的文件，钩子在扫描完第 1 个文件时置位取消标记；断言 `resp.cancelled == true` 且 `resp.files_scanned < 200`。该测试是确定性的，不依赖 sleep。
- **验收**：`cargo test content_search` 通过，且连续跑 20 次不出现失败。
- **约束**：不得改变 `search_file_contents` 的公开签名与生产行为。

### 后续大项（需要单独设计，不适合直接交给子代理）

以下是设计目标层面的缺口，涉及前后端协议与交互，需先写设计再拆任务：

1. **客户端接入 PTY**：把远程终端改走 daemon 的 `pty.*`，实现断线自动 attach、应用重启后接回、孤儿终端提示（设计 §6.2）。前置条件：R1、R2 完成。
2. **单条常驻通道**：客户端从「每次调用一个 exec 通道」改为「一条常驻通道 + 按 `stream_id` 分发」，并补上请求 id 分配、取消与信用窗口管理。
3. **`workspace.open` 与 daemon 侧信任校验**：daemon 不再接受任意绝对路径作为根（设计 §8.4、§8.5）。
4. **收敛 serve 路径**：daemon 稳定后移除 serve（TCP+JSON），只保留 daemon 与直连两条路径。
