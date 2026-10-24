# qingcode-server 实现评估

评估日期：2026-10-24

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

## 问题清单

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
