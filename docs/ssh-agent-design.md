# SSH Agent 模式设计

状态：设计稿（2026-10-23）。实现前请先评审本文；落地后，把用户可见的行为和限制同步到 [`ssh-workspaces.md`](ssh-workspaces.md)。

## 1. 背景

现有 SSH 工作区走直连：Tauri 后端用 russh 建立 SSH/SFTP，再在远端逐条执行 `git`、`find`、`rg` 和格式化命令；每个远程终端各占一条独立的 SSH 连接（见 `ssh-workspaces.md`「当前边界」）。这条路线不用在远端装任何东西，但有几处硬伤，靠修补无法根除：

| 问题 | 根因 |
|---|---|
| 网络抖动、休眠或远端卡顿时，终端里的进程随之结束 | PTY 由 sshd 持有，连接一断 sshd 就会结束会话；只能请用户自己开 tmux / screen |
| 终端一多就要调大 sshd 的 `MaxSessions` / `MaxStartups` | 每个终端各占一条 SSH 连接，主连接每条命令占一个通道 |
| 远端文件被修改后，文件树和标签页不会自动刷新 | SFTP 没有变更通知，只能轮询，而轮询成本太高 |
| Git 状态刷新慢，状态栏要降频 | 每次刷新都要开新通道并启动 `git` 进程，至少要两三次往返 |
| 搜索依赖远端装了 `rg`；文件名搜索不支持 glob，也不读 ignore 文件 | 远端只能调用现成的 shell 工具，和本地的搜索实现语义不一样 |
| Windows OpenSSH 远端没有搜索、格式化和运行任务 | 依赖 POSIX shell 的命令拼装方式不能用 |
| 关闭终端时无法判断里面是否还有子进程在运行 | 隔着 SSH 拿不到进程树 |
| 和本地相比有一批「部分对齐」项 | 同一个功能写了两套实现（本地 Rust 实现、远程 shell 实现），行为会逐渐走样 |

## 2. 目标与非目标

**目标：一次上线就让 Agent 模式全面达到或超过直连模式**，验收以 §13 的对照表全部达标为准。

1. **对齐**：直连模式现有的所有能力，在 Agent 模式下行为相同或更好；前端调用的命令名和数据结构保持不变。
2. **更优**：
   - 终端在断线和应用重启后都能保住进程，并恢复屏幕内容；
   - 一个工作区只占一条 SSH 连接；
   - 远端变更实时推送，取代轮询；
   - 搜索、Git、格式化、编码检测和本地共用同一份代码；
   - Windows 远端补齐搜索、格式化和运行任务；
   - 传输支持断点续传。
3. **可回退**：远端装不上 Agent 或运行不了时，自动回到直连模式，用户不需要做任何处理。
4. **不降低安全性**：主机指纹、工作区信任、项目根边界、拒绝符号链接逃逸，这些规则全部保留，并在 Agent 内再做一层校验。

非目标：
- 远程扩展；
- 远程 LSP 和调试器（Agent 的协议会为它们预留扩展位，但本期不做）；
- 端口转发；
- WSL 直连；
- 多人共享同一个远端会话。

## 3. 总体架构

```text
QingCode (Windows/macOS)                        远端主机（SSH 用户身份）
┌──────────────────────────────┐   1 条 SSH 连接  ┌────────────────────────────────────┐
│ 前端（命令名不变）              │                 │ sshd                               │
│   ssh_* Tauri 命令             │                 │   └ exec: qingcode-agent connect   │
│     └ RemoteBackend（分派）     │  session 通道   │          --stdio   （代理，随连接生灭） │
│         ├ AgentBackend ───────┼─ 帧协议 ────────┼──────────┐                          │
│         └ DirectBackend（现有） │  +SFTP（仅安装）│          ▼ Unix socket / 命名管道     │
│ 安装器：探测平台 / SFTP 上传     │                 │   qingcode-agent daemon（常驻）      │
└──────────────────────────────┘                 │     ├ PTY 宿主 + 屏幕快照 + 环形缓冲  │
                                                 │     ├ 文件系统 / 监视（notify）       │
                                                 │     ├ 搜索（ignore + grep-searcher）  │
                                                 │     ├ Git / 格式化 / 运行任务         │
                                                 │     └ 传输（分块、校验、续传）         │
                                                 └────────────────────────────────────┘
```

关键决策：

- **常驻进程和连接代理分开。** 同一个二进制有两个子命令：
  - `daemon`：常驻进程，持有 PTY 和状态，与 SSH 会话脱离（Linux/macOS 上 `setsid` 并重定向标准输入输出）。
  - `connect --stdio`：连接代理，作为 SSH exec 的进程运行，只把 stdio 和 daemon 的本地 socket 互相转发。

  连接断开时只有代理退出，daemon 和其中的 PTY 都不受影响；重连后启动一个新的代理，重新接上即可。
- **不用 `direct-streamlocal` 直连 socket。** Windows OpenSSH 不支持这种转发，`AllowStreamLocalForwarding` 也经常被关掉，所以统一走 exec + stdio 代理，兼容面最大。
- **一条 SSH 连接里固定两个通道：**
  - 控制通道：跑 `connect --stdio`，所有业务都在这一个通道里多路复用。
  - SFTP 通道：只在安装或升级 Agent 时打开，用完即关。

  `MaxSessions` 从此不再构成限制，`MaxStartups` 也只在建立连接时短暂涉及。
- **daemon 一个用户一个版本一份。** 同一远端用户名下，多个项目、多个 QingCode 窗口乃至多台客户端机器，都连到同一个 daemon，节省内存，PTY 也可以跨应用重启接回。

## 4. 安装、版本与升级

### 4.1 二进制与分发

| 目标三元组 | 说明 |
|---|---|
| `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl` | 静态链接，不依赖 glibc 版本，Alpine/BusyBox 上也能运行 |
| `armv7-unknown-linux-musleabihf` | 可选，用于树莓派等设备 |
| `x86_64-pc-windows-msvc` / `aarch64-pc-windows-msvc` | Windows OpenSSH 远端 |
| `aarch64-apple-darwin` / `x86_64-apple-darwin` | macOS 远端 |

- 各目标的 Agent 二进制压缩成 zstd 后打进安装包资源 `resources/agent/<target>/qingcode-agent[.exe].zst`，并附带 `manifest.json`，内容为版本号、构建号和各文件的 sha256。**默认不从网络下载**，内网和离线主机（包括本仓库常用的 192.168.x 内网）可以直接用。
- 体积预算：每个目标压缩后不超过 3MB，安装包总增量不超过 20MB。超出时可以把较少用的目标改为首次使用时从 Release 下载，并在设置里提供开关。
- CI：在 `release.yml` 中增加 Agent 构建作业。Linux musl 用 `cargo zigbuild`，Windows 和 macOS 用各自原生的 runner。产物先回传给打包作业，再进入安装包。`pnpm check` 增加 Agent crate 的 fmt、clippy 和 test。

### 4.2 首次连接时的安装流程

1. SSH 认证（指纹确认流程不变）。
2. 平台探测（一次 exec）。先试 `uname -sm`；失败或出现 `MINGW`、`MSYS` 等字样时，改用 `powershell -NoProfile -Command "$env:PROCESSOR_ARCHITECTURE"`。由此确定目标三元组；不在支持列表里的平台走直连模式。
3. 确定安装目录。默认用 `~/.qingcode/agent/<version>-<build>/`；家目录不可写时依次尝试 `$XDG_DATA_HOME/qingcode/agent/` 和 `$XDG_RUNTIME_DIR/qingcode/agent/`；都不行则回退直连，并说明原因。运行目录是 `~/.qingcode/agent/run/`，权限 `0700`。
4. 检查是否已安装。用 SFTP `stat` 检查目标二进制：存在、属主是当前用户、权限不宽于 `0700`，且同目录 `.sha256` 文件与 manifest 一致时直接使用。不满足任何一项都重新安装。
5. 上传。客户端先在本机解压 zstd，再经 SFTP 写入同目录临时文件，用 `fsetstat` 设为 `0700`。随后执行一次 `qingcode-agent self-check --sha256`，它会自算哈希并和 manifest 对比，一致后才 `rename` 成正式文件。
6. 检测 noexec 挂载。如果 `self-check` 返回 `EACCES` 或 `ENOEXEC`，说明家目录挂成了 noexec：换下一个候选目录；全部失败则回退直连，并在状态栏提示原因。
7. 启动与接入：exec `<bin> connect --stdio --ensure-daemon`，然后握手（§5.2）。

### 4.3 版本与升级

- 协议版本号单独维护（`PROTOCOL_VERSION`），与应用版本分开。握手时由客户端声明自己支持的范围，daemon 回报实际使用的版本。
- 客户端发现 daemon 版本较旧时：
  - daemon 里**没有存活终端**：直接安装新版本，通知旧 daemon 退出，再启动新 daemon。
  - daemon 里**有存活终端**：新旧并存。终端继续留在旧 daemon 中，新终端开在新 daemon 中；等旧 daemon 的终端全部结束，它自然退出（§6.2）。界面上给这些旧终端标注「旧版 Agent」。
- 清理：每次安装后，删除不在使用、且不是最近两个版本的安装目录。

## 5. 协议

### 5.1 帧格式

```text
frame := u32_be length | u8 kind | u32_be stream_id | payload
kind  := HELLO | REQ | RES | ERR | EVENT | STREAM_DATA | STREAM_END | WINDOW | CANCEL | PING | PONG
```

- `payload` 用 MessagePack（`rmp-serde`）编码；文件内容、终端输出等字节数据以 `bin` 类型原样放入，不再做 base64。
- 单帧上限 1MB。大数据拆成每块 64KB 的 `STREAM_DATA` 依次发送。
- **流控**：每个流有独立的信用窗口（默认 256KB），接收方用 `WINDOW` 帧补充信用。这样一个下载很慢、迟迟不消费，也只会卡住它自己的流，不会拖住整个通道。
- **发送优先级**：控制帧和 PING 最高，其次是终端输入输出，再次是普通 RPC，最低是批量数据（传输、读大文件、搜索结果）。发送端按优先级轮转发帧，所以即使下载大文件，终端按键回显的延迟也不超过发送一块数据的时间。
- **取消**：任何请求或流都可以用 `CANCEL{stream_id}` 取消，daemon 收到后会结束对应的子进程或 I/O。
- **心跳**：沿用直连模式的参数，每 15 秒一次 PING，约 45 秒内收不到任何帧就判定断开。SSH 层的保活仍然保留，约 75 秒。

### 5.2 握手

```text
C → HELLO { protocol: [min, max], client_build, client_id, resume_token? }
A → HELLO { protocol, agent_version, build, os, arch, home, shells[], tools{git, prettier, …}, capabilities[], session_token }
```

- `client_id` 是每个 QingCode 安装实例的随机 ID，在本机 SQLite 中持久化，应用重启后不变，用来接回自己留下的终端。
- `capabilities` 列出本次可用的功能，如 `fs.watch`、`search.content`、`git`、`format`、`pty.persist`、`transfer.resume`。前端的功能开关改为按它判断，不再写死「Windows 远端没有搜索」这类规则。

### 5.3 方法一览

命名规则是 `域.动作`。和直连模式的对应关系见 §7。

- `workspace.open{root, trusted}` / `workspace.setTrust` / `workspace.close`
- `fs.stat` / `fs.readDir` / `fs.scan{excludes}` / `fs.read{offset,len}` / `fs.readStream` / `fs.write{expected_mtime?}` / `fs.create` / `fs.mkdir` / `fs.rename` / `fs.move` / `fs.copy` / `fs.delete` / `fs.deleteStats` / `fs.findLineOffset` / `fs.detectEncoding` / `fs.listExtensions` / `fs.checkSymlinkWrite`
- `watch.subscribe{root, excludes}` → 推送 `fs-change` 事件
- `search.files` / `search.content`：流式返回，可取消
- `git.status` / `git.statusLight` / `git.log` / `git.branches` / `git.remotes` / `git.switch` / `git.stage` / `git.unstage` / `git.discard` / `git.commit` / `git.pull` / `git.push` / `git.fetch` / `git.showFile` / `git.commitFiles` / `git.fileContents`
- `format.document`
- `pty.create` / `pty.attach{id, from_seq}` / `pty.detach` / `pty.input` / `pty.resize` / `pty.kill` / `pty.list` / `pty.hasChildren` → 推送 `pty.data{seq}` 和 `pty.exit` 事件
- `task.spawn`：运行配置，和 PTY 共用宿主
- `transfer.upload` / `transfer.download`：分块、校验、续传
- `agent.info` / `agent.shutdown` / `agent.logs{tail}`

## 6. 终端持久化：核心收益

### 6.1 宿主

- daemon 用 `portable-pty` 创建 PTY，Linux 和 macOS 走 openpty，Windows 走 ConPTY。shell 的选择、cwd 和启动命令的规则，与直连模式现有的规则一致（Linux 默认登录 shell，可选 bash、zsh 或 sh；Windows 可选 powershell、pwsh 或 cmd，启动后位于项目根目录且不回显命令）。这部分规则从 `remote_ssh.rs` 中抽出来复用。
- 每个 PTY 维护两份数据：
  - 一个 `vt100::Parser`，作为无界面的终端模拟器，随时能导出当前屏幕和光标；
  - 一个环形输出缓冲（默认 2MB，可通过 `remote.agent.terminalScrollbackBytes` 配置）。每段输出带递增的 `seq`。

### 6.2 断线与接回

```text
断线：代理退出 → daemon 把该客户端的终端标记为 detached，继续运行、继续缓冲
重连：新代理 → HELLO{client_id} → pty.list → 对本地仍有标签的终端发 pty.attach{id, from_seq}
接回：from_seq 仍在缓冲内 → 只补发缺失的那段输出（无缝）
      已被覆盖 → 先发屏幕快照（contents_formatted，含颜色与光标），再接上实时流
```

- 客户端仍按 1/2/5/10/20 秒退避重连。之后不再放弃，而是每 30 秒重试一次，直到用户关闭标签。终端标签上显示「重连中」，不显示「已退出」。
- 接回后：
  - 重新下发当前的终端尺寸；
  - 断线期间进程如果已经退出，补发 `pty.exit`，带退出码；
  - 不再提示「断线前的进程已结束」，因为进程还活着。
- 应用重启后，前端按持久化的终端标签 ID 接回。不在任何标签里的孤儿终端汇总成一条提示：「远端还有 N 个终端在运行」，可以接回，也可以结束。

### 6.3 生命周期与回收

- daemon 在以下两种情况退出：
  - 没有任何客户端连着，也没有存活的 PTY，持续 10 分钟；
  - 有 PTY 但一直没有客户端，超过 `remote.agent.detachedTerminalTtl`（默认 24 小时）。此时先向所有 PTY 发 SIGHUP，再退出。
- 单实例：`run/daemon.lock` 用 `flock` 加锁（Windows 上用命名 mutex）。两个代理同时执行 `--ensure-daemon` 时只会启动一个 daemon。
- 限额：
  - 每个 daemon 最多 64 个 PTY，超出返回明确错误；
  - 环形缓冲总量最多 256MB，超出时先淘汰 detached 时间最长的终端的缓冲，进程本身保留。

### 6.4 平台注意点

- **systemd `KillUserProcesses=yes`**：用户最后一个会话结束时，logind 会结束该用户的所有进程。daemon 启动时先探测：可用时改用 `systemd-run --user --scope` 托管，并提示用户执行 `loginctl enable-linger`；不可用时，该主机的 `pty.persist` 能力降级，界面提示「此主机断线仍会结束终端」。
- **Windows OpenSSH**：sshd 把会话进程放进 Job Object，会话结束时整组结束。daemon 通过 `CREATE_BREAKAWAY_FROM_JOB` 脱离这个 Job；Job 不允许脱离时，退而用 `schtasks /create /sc once` 的一次性计划任务，在用户上下文里拉起 daemon。两种都失败就关闭 `pty.persist`，其余能力照常。这一点要在 WinDev 上实测（§12）。
- **macOS**：`setsid` 足够。用户注销时进程照样会被结束，这属于预期行为。

## 7. 能力映射：逐项对齐与改进

原则：**本地已有实现的能力，Agent 直接复用同一份代码**，语义因此和本地一致。为此要先把下列模块从 Tauri 中解耦，抽到 workspace crate `qingcode-core`：

| 模块 | 规模 | 依赖 Tauri 的处数 | 解耦方式 |
|---|---|---|---|
| `content_search.rs` | 700 行 | 0 | 直接迁移 |
| `file_encoding.rs` / `exclude.rs` | 465 / 193 行 | 0 | 直接迁移 |
| `git_status.rs` / `git_command.rs` | 614 / 25 行 | 6 / 0 | 把命令包装和纯逻辑分开 |
| `format.rs` | 694 行 | 3 | 同上；同时合并 SSH 端的 ruff/black 支持 |
| `path_guard.rs` | 696 行 | 4 | 同上 |
| `git.rs` | 2025 行 | 35 | 抽出纯函数（参数构造、输出解析、时间戳读取） |
| `file_watcher.rs` | 451 行 | 9 | 把事件发送抽象成 `EventSink` trait |
| `terminal.rs` | 1421 行 | 1 | 抽出 PTY 管理；忙碌探测同时供本地和 Agent 使用 |

下表中，「直连现状」一列摘自 `ssh-workspaces.md`。

| 能力 | 直连现状 | Agent 方案 | 结果 |
|---|---|---|---|
| 读写、新建、重命名、删除、移动、复制 | SFTP | `fs.*` 本机系统调用；写入沿用「临时文件 + 原子 rename」，保留目标权限 | 对齐，往返更少 |
| 写冲突检测 | 先读 mtime 再写，两次往返 | `fs.write{expected_mtime}` 在 daemon 内比较并写入，一次完成 | 更优 |
| 目录扫描、`files.exclude` | 一次扫描要多次 SFTP 往返 | `fs.scan` 一次返回整棵子树（有深度和数量上限）；按 gitignore 隐藏改用 `ignore` crate | 更优：补齐 gitignore 排除 |
| 文件监视与自动刷新 | 没有 | `notify` 递归监听项目根，去抖 200ms 后批量推送 `fs-change`，事件结构和本地 `file_watcher.rs` 相同，前端可直接复用 | 更优：从仅本地变为对齐 |
| 监视上限 | — | inotify 报 `ENOSPC` 时，对该根降级为 daemon 内部 5 秒轮询，并提示调高 `fs.inotify.max_user_watches` | 有兜底 |
| 编码检测 | 下载整个文件再取样 | 只读前 8KB，用 `file_encoding.rs` | 更优，和本地一致 |
| 大文件切片、跳行 | 单片 4MB，跳行要流式扫描 | 本机 `pread`；跳行在 daemon 内扫描，只返回偏移 | 更优 |
| 属性对话框 | 缺创建时间和条目统计 | 提供 `statx` 的 birth time（文件系统支持时）和目录统计 | 更优 |
| 符号链接越界 | 拒绝 | 用 `path_guard.rs` 做 canonicalize 加根前缀校验，与本地相同 | 对齐 |
| 文件名搜索 | `find` 子串匹配，不支持 glob 和 ignore | 用 `ignore` + glob 匹配，复用本地实现 | 更优：补齐 glob 和 ignore |
| 内容搜索 | 需要远端装 `rg` | 内置 `grep-searcher`，不再依赖远端的 `rg`；截断、45 秒超时和取消规则不变 | 更优 |
| Git 全套 | 每条命令一次 exec | daemon 在本机调用 `git`，参数和解析复用 `git.rs`；监视器发现 `.git/index`、`HEAD`、`refs` 变化时主动推送 `git-changed` | 更优：状态栏不必再降频 |
| Git 上次获取、拉取、推送时间 | 始终为空 | 复用 `read_last_fetch_at` 等函数 | 更优 |
| 轻量脏标记 | 用完整 `git status` 近似 | `git.statusLight`，结合监视器只在有变化时重算 | 更优 |
| 格式化 | 远端工具；本地不支持 Python | 合并实现：Prettier、rustfmt、gofmt、shfmt、ruff/black，本地和远端用同一份 | 对齐，Python 两侧都可用 |
| 远程 PTY | 每个终端一条连接，断线后进程结束 | §6：多路复用加持久化 | 更优 |
| 关闭前的子进程探测 | 未映射，总要多一次确认 | `pty.hasChildren`：Linux 读 `/proc`，macOS 用 `proc_listchildpids`，Windows 用 Toolhelp | 更优 |
| 终端配置文件、`default_shell` | 部分支持 | `HELLO.shells[]` 回报可用的 shell，前端据此生成选项 | 对齐 |
| 运行任务 | Linux 只有 `command`/`sh`/`script`；Windows 不可用 | `task.spawn` 复用本地的任务分派；Windows 远端支持 `ps1`/`bat`/`command` | 更优 |
| 上传、下载 | 分块写临时文件后替换；不能续传 | 分块（默认 1MB）加整体 sha256。中断后按「临时文件 + 偏移」续传，校验通过才提交。多个小文件可以合并成流（tar 格式），减少往返 | 更优 |
| SFTP v3 不允许覆盖式 rename 的问题 | 用 `mv -fT` 绕开 | daemon 直接调用 `rename(2)`，Windows 上用 `MoveFileEx(REPLACE_EXISTING)` | 更优，Windows 也可原子替换 |
| 终端粘贴上传 | `.qingcode/terminal-paste/` | 同样的目录，走 `transfer.upload` | 对齐 |
| Markdown 中的远程相对图片 | 不显示 | 前端把 `ssh://` 图片路由到 `fs.read`，转成 blob URL 显示（直连模式也可以顺带补上） | 更优 |
| 多项目混合搜索 | 支持 | 各 SSH 项目各自在自己的 Agent 上流式搜索，前端汇总 | 对齐 |
| CLI `run *` 修改远程 `run.json` | 需要 GUI 在线 | 不变（CLI 不直接持有 SSH 凭据） | 对齐 |
| Windows OpenSSH 远端 | 只有 SFTP、终端和 Git | 能力和 Linux 相同（ConPTY 与平台差异见 §6.4） | 更优 |

## 8. 安全模型

Agent 以 SSH 登录用户的身份运行，能做的事不会超过这个用户自己用 SSH 能做的事。要防的是三类问题：被同机的其他用户劫持、客户端出错导致越权操作，以及二进制被篡改。

1. **身份与传输**：SSH 层不变，主机指纹首次需要确认，变化时必须重新确认；Agent 自己不监听任何 TCP 端口。
2. **本地 socket**：
   - socket 放在 `0700` 的 `run/` 目录下。Linux 上接受连接时用 `SO_PEERCRED` 校验对端 uid，macOS 上用 `getpeereid`。Windows 命名管道的 DACL 只允许当前用户的 SID。
   - daemon 启动时生成随机 `session_token`，写入 `run/token`（权限 `0600`）。代理读取后在 HELLO 中携带，校验不通过的连接直接拒绝。
3. **二进制完整性**：安装时做 sha256 校验，并检查属主和权限（§4.2）。每次连接前用 SFTP `stat` 检查属主、权限和 mtime，任何一项不符就重新安装，不会执行来历不明的文件。
4. **根边界（客户端和 Agent 各校验一次）**：
   - `workspace.open` 注册项目根。所有 `fs.*`、`search.*`、`git.*`、`format.*`、`task.*` 请求都必须带工作区 ID，路径经 `path_guard` canonicalize 后必须落在根内，否则拒绝。
   - 搜索和扫描默认不跟随符号链接。
   - 传输和写入的临时文件只放在目标所在目录。
5. **工作区信任**：
   - 信任状态由客户端决定，和现在一样。Agent 按 `workspace.open{trusted}` 和 `workspace.setTrust` 同样执行检查：未受信任时拒绝写入、格式化、Git 修改类命令、运行任务和新建终端。
   - 客户端撤销信任时，Agent 立即拒绝新请求；已经在运行的终端不受影响，与本地行为一致。
6. **没有通用命令执行接口**：
   - 协议里只有带类型的方法，没有 `exec(cmd)`。Git 的参数由 Agent 端组装，客户端不能直接传参数串；
   - 能执行任意命令的入口只有 `pty.create` 和 `task.spawn`，这两者本来就需要工作区受信任。
7. **日志**：`run/agent.log` 按 5MB 滚动，保留 3 份。日志不记录文件内容、终端数据和环境变量的值，可以通过 `agent.logs` 在应用内查看。

## 9. 客户端改造

- **`RemoteBackend` trait**：把 `remote_ssh.rs` 现有的实现封装成 `DirectBackend`，新增 `AgentBackend`。每个 `ssh_*` Tauri 命令只负责按连接的状态分派到其中一个。前端的命令表（`src/lib/tauri.ts` 中的 `remoteCommand` 映射）**不改**。
- **连接状态机**：

  ```text
  Disconnected → Authenticating → Probing → Installing → Handshaking → Ready(Agent)
                                     └──── 任一步失败（可回退原因）────→ Ready(Direct)
  Ready(Agent) → Lost → Reconnecting（退避）→ Ready(Agent)，并接回终端
  ```

- **新增事件和命令**：
  - 事件 `ssh-agent-state`（模式、版本、降级原因）；
  - 命令 `ssh_agent_info`、`ssh_agent_restart`、`ssh_agent_logs`。
- **状态栏芯片**：显示「Agent v1.2」或「直连：<原因>」，点击打开详情，可以重启 Agent 或查看日志。
- **事件复用**：Agent 推来的 `fs-change` 和 `git-changed` 事件，转换成本地已有的事件结构后再发给前端；SSH 项目从此进入 `sync_file_watches` 的同一条处理路径。
- **直连模式继续维护**：回退依赖它。§7 中「直连模式也可以顺带补上」的项目可以先做。

## 10. 设置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `remote.agent.mode` | `"auto"` | `auto` 先尝试 Agent，失败则用直连；`always` 只用 Agent，失败就报错；`never` 只用直连。连接级别的设置可以覆盖全局设置 |
| `remote.agent.installDir` | `""` | 为空时按 §4.2 的顺序自动选择 |
| `remote.agent.detachedTerminalTtl` | `"24h"` | 没有客户端连着时，终端最多保留多久 |
| `remote.agent.terminalScrollbackBytes` | `2097152` | 每个终端的环形缓冲大小 |
| `remote.agent.watch` | `true` | 关闭后回到「聚焦时同步」 |

默认模板必须为每个键写注释（遵守 `projectSettings.ts` 的要求，不得删除注释）。

## 11. 实施拆分（一次发布，内部分段把关）

整个功能作为一次发布，`remote.agent.mode` 在开发期间默认为 `never`，§13 全部达标后再切换为 `auto` 正式发布。

| 段 | 内容 | 关卡 |
|---|---|---|
| M0 | 抽出 `qingcode-core`（§7 的模块），本地行为不变 | 本地全量测试和 `pnpm check` 通过 |
| M1 | `qingcode-agent-proto`（帧格式、流控、优先级）加上 daemon 骨架、单实例锁、socket 鉴权 | 用本机 stdio 管道跑协议测试和压力测试 |
| M2 | 安装器、版本管理、回退状态机，`RemoteBackend` 分派 | Linux x64、Alpine、WinDev 三台主机都能完成安装，也能正确回退 |
| M3 | `fs` / `watch` / `search` / `git` / `format` / `transfer` | 对照表中除终端以外全部达标 |
| M4 | PTY 宿主、屏幕快照、接回和生命周期，`task.spawn` | §12 中终端相关场景全部通过 |
| M5 | 状态芯片、设置、文档、CI 多目标构建与安装包体积 | 发布检查清单 |

## 12. 测试与验收

**自动化：**
- 协议单元测试：帧的编解码、窗口补充、优先级、取消，以及半帧和超长帧的错误处理。
- 回环集成测试：不经过 SSH，直接在 CI 中启动 `qingcode-agent connect --stdio`，对每个方法跑一遍与本地实现结果相同的测试（尽量复用 `qingcode-core` 的测试数据）。
- 安全测试：
  - 根边界：`..`、指向根外的符号链接、硬链接；
  - token 错误、对端 uid 不符；
  - 未受信任时写入或执行被拒绝。
- 混沌测试：随机断开 stdio，验证接回后终端输出没有丢失也没有重复（按 seq 校验）。

**SSH 端到端**（按 AGENTS.md 要求，使用一次性远端项目）：

| 主机 | 重点 |
|---|---|
| Ubuntu x64（glibc） | 完整对照表；systemd `KillUserProcesses` 两种取值 |
| Alpine / BusyBox（musl） | 安装、搜索不依赖 rg、监视功能 |
| arm64 Linux | 目标三元组选择 |
| WinDev（Windows OpenSSH） | ConPTY、Job 脱离或计划任务、命名管道 ACL、PowerShell/BAT 运行任务 |
| macOS | 安装、监视（FSEvents）、终端 |
| 受限主机 | 家目录只读、家目录 noexec、磁盘满：都能回退直连，并给出原因 |

**验收场景：**
- 首次连接确认指纹；主机指纹变化时被拦截。
- 开 12 个以上终端加并发 Git 操作，全程只占用 1 条 SSH 连接（用 `ss -tnp` 确认）。
- 拔网线或禁用网卡 2 分钟后恢复：终端里的 `top`、`vim` 和长时间编译仍在运行，画面能恢复。
- 关闭应用再打开：可以接回终端。
- 有存活终端时升级 Agent：旧终端保留，新终端使用新版本。
- 远端另一个会话修改文件：文件树和已打开的标签页在 1 秒内刷新，脏标签提示冲突。
- 撤销工作区信任后，写入、新建终端和运行任务都被拒绝。
- 运行中的上传被中断后续传完成，sha256 一致。
- 设置 `remote.agent.mode = "never"` 后，行为和现在的直连模式完全一样（回归测试）。

## 13. 发布门槛：目标对照表

在 Agent 模式下逐项重新审视 `ssh-workspaces.md`「本地与 SSH 能力对照」中的每一行。门槛是**原来的「已对齐」不能变差，「部分对齐」和「仅本地」要按下表达到目标**。

| 能力面 | 直连 | Agent 目标 |
|---|---|---|
| 文件监视与自动刷新 | 仅本地 | 已对齐 |
| 文件名 glob、ignore 文件 | 仅本地 / 部分对齐 | 已对齐 |
| 内容搜索 | 部分对齐（需要 rg） | 已对齐（内置） |
| gitignore 隐藏 | 部分对齐 | 已对齐 |
| Git 同步时间戳、轻量脏标记 | 仅本地 / 部分对齐 | 已对齐 |
| 终端（多个、配置文件、子进程探测） | 部分对齐 | 已对齐，并且断线后终端不结束（仅 SSH 才有的优势） |
| 运行配置任务类型 | 部分对齐 | 已对齐（Windows 远端支持 ps1/bat） |
| 编码检测、属性对话框 | 部分对齐 | 已对齐 |
| Markdown 远程图片 | 仅本地 | 已对齐 |
| Windows OpenSSH 远端 | SFTP、终端、Git | 与 Linux 相同 |
| 传输 | 仅 SSH | 支持续传（仅 SSH 才有的优势） |
| CLI `project add`、「用……打开」、WSL 等 | 仅本地 | 不在本期范围，保持不变 |

## 14. 风险与未决问题

| 风险 | 缓解 |
|---|---|
| Windows Job Object 不允许脱离，终端无法持久化 | 先在 WinDev 上实测计划任务方案；仍不行就关闭这台主机的 `pty.persist`，其余能力不受影响 |
| 安装包体积增长 | 用 zstd 压缩；较少用的目标改为首次使用时下载（可配置） |
| 企业主机禁止在家目录放可执行文件，或有审计限制 | 回退直连；支持通过 `installDir` 指定管理员预装的路径 |
| 屏幕快照不能完整还原所有 TUI 状态（如鼠标模式、备用屏幕） | 用 `vt100` 的格式化输出，并在 attach 后发送一次 resize 让 TUI 重绘；实测 vim、htop、less 和 Claude Code |
| 协议演进导致新旧不兼容 | 握手协商协议版本；新功能只按 capabilities 判断是否开启 |
| 多个 QingCode 实例同时操作同一个终端 | 同一时刻只有一个客户端能写入，其他客户端只读并收到「已在其他窗口打开」的提示 |
| `git` 凭据提示 | 和本地一样设置 `GIT_TERMINAL_PROMPT=0`；需要交互时提示用户去终端里执行 |

未决问题：
1. Agent 版本是否严格绑定应用版本？建议协议向后兼容 2 个次版本。
2. 是否要给 Agent 做代码签名？macOS 远端在 Gatekeeper 下执行未签名二进制，可能需要先 `xattr -d com.apple.quarantine`；通过 SFTP 写入的文件通常不带隔离属性，需要实测。
3. 远程 LSP 是否复用同一条协议（建议预留 `lsp.*` 方法域）？
