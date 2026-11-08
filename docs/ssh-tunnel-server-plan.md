# SSH 隧道承载 Server（合并「SSH + 远端服务」与「端口直连」）

## 目标

远程连接收敛为两种：

| 模式 | 通道 | 远端组件 |
|---|---|---|
| SSH（兼容模式） | SSH 会话、SFTP、SSH PTY | 不部署 |
| Server | HTTPS/WSS 直连网关，网关经 IPC 访问用户级 daemon | `qingcode-server direct` + daemon |

Server 模式到达网关有两种方式，上层代码完全相同：

- **端口直连**：TCP 直连远端网关端口（现有实现）。
- **SSH 隧道**：经已认证 SSH 会话的 `direct-tcpip` 通道连到远端网关的回环地址。只开放 22 端口的主机也能使用持久终端与 daemon 加速。

原「SSH + 远端服务」的 `connect --stdio` 代理、按项目 serve、终端专用 SSH 通道池与借用逻辑在迁移完成后删除，只保留一条服务通道与一套版本/兼容规则。

## 关键设计

- `DirectConnectionConfig.tunnel = Some(connection_id)` 表示经 SSH 隧道拨号；`direct.rs` 的 TLS、HTTPS 连接池、WSS 均改为在通用字节流上运行，拨号步骤按 `tunnel` 选择 TCP 或 SSH 通道。连接池身份包含 `tunnel`，避免不同主机的 `127.0.0.1:<端口>` 混用。
- 隧道 SSH 会话由独立的会话表（`remote_ssh/tunnel.rs`）持有，不挂在主 `SshManager` 的会话表上：主管理器看到 `direct_config` 后一律走 Server 路径，不会把隧道会话误当成 SSH 模式。断线时按已确认的指纹与本次会话凭据重连（复用现有 `reconnect_after_channel_failure`）。
- `direct-tcpip` 通道不计入 OpenSSH `MaxSessions`，比现有的「每终端一个 exec 通道」更不容易被会话上限卡住；远端 `AllowTcpForwarding no` 时明确报错，提示改用 SSH 兼容模式或端口直连。
- 隧道配对信息不落盘：每次连接经 SSH 执行 `direct-info --include-secret` 读取端口、证书指纹与 token。SSH 主机指纹已由用户确认，证书指纹来自同一可信通道，无需再次人工确认。
- 网关选择：远端已有运行中的网关（含端口直连启动的 `0.0.0.0`）则复用，隧道目标取其监听地址（`0.0.0.0`→`127.0.0.1`，`::`→`::1`）；没有则暂存与客户端同版本的服务程序，以 `direct --hostname 127.0.0.1 --detach` 启动仅回环可达的网关，不需要防火墙放行。
- 版本：网关健康检查须与客户端同版本；旧网关经同一 SSH 会话替换（复用直连更新的停网关 → `ensure_remote_daemon(DeferWhileBusy)` → 启新网关流程），daemon 仍按 `PTY_COMPAT_LEVEL` 兼容契约沿用或替换。
- 信任：部署与启动网关只在项目已信任后进行。未信任项目且该连接尚无隧道时，走 SSH 只读 SFTP 浏览（即 SSH 模式代码）；隧道建立后同一连接下的项目统一走 Server 路径，与端口直连一致。
- 旧连接迁移：`ssh_connections.mode = server` 的连接下次连接时自动改走隧道，连接 ID、`ssh://` 资源标识与终端标签不变；daemon 是用户级共享的，原有持久终端照常接回。

## 进度（2026-11-07）

- 第 1、2 阶段已实现并通过本机测试（含经测试隧道路由的健康检查、HTTPS 复用与 WSS HELLO）；隧道连接已接管 Server 模式的部署入口，按项目 serve 回退停用。
- 真机验收（`live_ssh_tunnel_acceptance`，2026-11-08）：
  - Windows 45，使用当前代码构建的 0.1.17-beta.12：首次部署、文件与远程命令、daemon 终端、SSH 断线后接回同一终端、第二个客户端复用网关与 daemon、网关被杀后在原端口重启且终端仍在，全部通过。已有网关时接入 40–150ms；需要暂存程序时约 25 秒（Windows 上校验程序摘要较慢）。
  - Linux 245，**部分验证**：客户端版本临时改为 0.1.14-beta.17，配合远端已有的同版本旧程序，覆盖相同流程及替换 0.1.14-beta.9 旧网关（保留 `0.0.0.0:48763`）。这不含本次服务端 token 竞态修复，当前版本的 Linux 服务包仍待验收。
  - 验收发现并已修复：网关拉起 daemon 时读到上一个 daemon 的旧 token；隧道重连后连接池复用旧通道上的空闲连接；每次接入都重新校验程序导致的 15 秒延迟（改为先经 SFTP 读取网关描述）。
- 第 3 阶段（删除旧通道代码）待当前版本的 Linux 服务包验收后进行，保留回退余地。
- 已知差异：隧道连接主动断开时保留 daemon 终端（原 Server 模式会结束本连接的终端）；在隧道已建立的连接上「通过 SSH 安装或读取服务」配置端口直连会被拒绝，需先断开。

## 分阶段

1. **隧道拨号**（纯新增，不改变现有行为）：通用字节流 TLS、`tunnel` 字段、隧道会话表与 `direct-tcpip` 拨号、`AllowTcpForwarding` 报错映射；回环网关测试覆盖经「隧道」路径的健康检查、HTTPS 复用与 WSS。
2. **Server 模式切到隧道**：`ssh_connect` 的 Server 模式在信任后建立隧道、读取或启动网关、按版本更新，再注册为 `direct_config(tunnel)` 并走 `direct_settings::connect_root`；断开时关闭隧道。审计所有 `direct_config(..).is_some()` 分支，区分「端口直连专属」（配对面板、防火墙放行、手动恢复 SSH）与「Server 通用」；状态栏显示「SSH 隧道 · HTTPS/WSS」。
3. **删除旧通道**：客户端的 `connect --stdio` daemon 传输、按项目 serve、终端传输池与通道借用、SSH 模式下的 server 恢复与更新弹窗等；服务端暂保留 `connect --stdio` 以兼容旧客户端。同步更新 `ssh-workspaces.md`、`direct-agent.md`、`ssh-agent-design.md`。
4. **真机验收**：Linux（245）与 Windows（45）各覆盖首次部署、复用已有网关、旧网关更新、断网重连接回终端、`AllowTcpForwarding no` 报错、只开 22 端口的主机。

## 已知风险

- 隧道下 HTTPS 请求在 SSH 之上再加一层 TLS，CPU 与延迟略增；连接池复用可以摊薄握手。
- 每个 TLS 连接占一条 `direct-tcpip` 通道；网关上限 96 条连接，客户端池上限不变。
- 远端只允许 SSH 而禁止转发的主机只能用 SSH 兼容模式。
