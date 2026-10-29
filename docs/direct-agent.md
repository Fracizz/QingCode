# 独立端口 Server 直连

QingCode 可通过独立 HTTPS/WSS 端口直接访问远端 `qingcode-server`。日常通信不经过 SSH；现有 SSH 连接保留兼容。HTTPS 工作区操作与 WSS 终端共用一个端口。客户端必须验证证书指纹并提交配对凭据。

## 启动与配对

在远端当前开发账户下运行（原账户的家目录、Claude 登录及环境继续使用）：

```text
qingcode-server direct --hostname 0.0.0.0 --port 48763 --detach
```

- 默认端口为 `48763`；省略 `--port` 时优先沿用已保存端口，首次使用 `48763`。
- 指定端口被占用时明确失败，不会自动换成随机端口。
- `--detach` 脱离当前终端，Windows 通过精确句柄继承和 breakaway 启动，Unix 使用 `setsid`。它不等于注册开机服务；重启机器后仍需启动命令或由任务计划/服务管理器启动。
- 不带 `--detach` 时前台运行。关闭前台进程会停止直连入口，daemon 中的终端由其独立生命周期管理。
- 默认状态目录为 `~/.qingcode/server/run`；`--state-dir` 可以覆盖。同一状态目录只允许运行一个直连入口。

另开一个远端终端，显式导出配对信息：

```text
qingcode-server direct-info --include-secret
```

此命令输出 JSON，含 `hostname`、`port`、`certificateSha256`、`token`、`previousPorts` 等字段。`hostname: 0.0.0.0` 是监听地址，客户端连接地址应填写远端真实 IP 或域名。将 JSON 导入连接管理中的 Server 直连配对界面，并填写实际连接地址。

客户端入口为「远程连接 → 新建 Server 直连」，无需先创建或测试 SSH 连接。导入配对 JSON 后，核对实际主机与 TCP 端口，依次执行「测试直连」、确认服务器证书指纹和「保存并启用直连」。首次测试仅先读取证书，用户确认身份后才发送认证凭据；编辑主机、端口或凭据会使之前的测试结果失效。已保存的直连可以从「新建项目 → 源文件夹位置 → 远程设备」中选择，并浏览远端目录，不会要求输入占位记录中的 SSH 密码。

点击状态栏连接芯片打开「远程连接」详情后，可直接进入「Server 端口直连」页签，在弹窗内完成准备服务、导入配对、测试、确认指纹和保存启用。启用后刷新连接状态；已有 SSH 连接可在同页恢复 SSH，独立 Server 连接不显示 SSH 安装或恢复入口。

已有 SSH 连接可在该连接的「Server 端口直连」面板中安装或导入服务。「通过 SSH 安装或读取服务」要求已有连接且信任的远程项目；也可使用上述手动启动与配对流程。SSH 配置保留为单独的兼容入口，Server 证书身份变化不会触发自动 SSH 回退。独立创建的 Server 连接不显示无凭据的「恢复 SSH 连接」动作。

`token` 是访问凭据，只在显式 `--include-secret` 时输出。不要发布配对 JSON。正常启动输出、健康检查和网关日志不包含凭据。状态目录中的 `direct/` 在 Unix 使用 `0700` / 文件 `0600`，Windows 使用当前账户专用 DACL；客户端同样应将配对秘密保存在受保护目录。

## 开放端口

必须确保客户端能够访问远端所选 **TCP** 端口。Windows 防火墙、上层防火墙以及 NAT 端口映射均可能影响连接；SSH 端口可用不能证明直连端口已经开放。

Windows 可由管理员按实际客户端来源添加入站规则，例如：

```powershell
New-NetFirewallRule -DisplayName 'QingCode Agent TCP 48763' -Direction Inbound -Protocol TCP -LocalPort 48763 -Action Allow -RemoteAddress <客户端IP>
```

不要直接复制 `<客户端IP>` 占位符。界面展示当前端口及历史端口，便于核对已有规则；应用不会自动放开所有来源或删除旧规则。

面板支持「通过 SSH 授权放行」。选择同一主机已保存且已确认指纹的 SSH 连接，可为本次操作填写密码或私钥口令；本次填写的凭据不会持久保存。即使 Server 已启用，该操作也会独立建立 SSH 管理连接，不改变日常 HTTPS/WSS 通信。

操作先只读检查 Windows 管理员权限、SSH 实际来源 IP、接收地址与网卡网络类型。确认框显示账户、单个 TCP 端口、允许来源、接收地址、网络配置文件及规则名称；Public 网络会明确提示。确认后仅创建该范围内的 QingCode 专属入站规则，不覆盖同名但范围不同的规则。检查后目标、来源或规则状态发生变化时，必须重新检查并确认；取消不会写入规则。

写入后再次探测 Server 端口，分别报告规则已写入和端口是否可达。探测不会发送 Server 凭据，也不会自动信任证书或启用直连；仍需「测试直连」并核对身份。组策略、上层防火墙和 NAT 映射可能仍阻止连接。无管理员权限、不支持 Windows NetSecurity 或无法确定网卡范围时，界面提供手动配置说明。

## 修改端口

客户端连接地址中的端口与远端监听端口必须一致。只修改客户端地址，不会改变远端监听配置。

1. 通过 `direct-info` 核对当前直连入口 PID。
2. 只停止该网关 PID，保留 daemon 和已有终端。
3. 用新的 `--port` 启动直连入口。
4. 更新客户端连接端口，并测试连接。
5. 确认不再需要旧端口后，再调整原防火墙/NAT 规则。

如果旧直连入口仍在运行，更换端口会被拒绝。历史端口记录在 `previousPorts`，最多保留最近 8 个不同旧端口；历史记录不表示这些端口仍在监听。证书和配对凭据在端口变更后保持不变。

界面显示当前端口和历史端口，并按当前有效端口生成可复制的 Windows 防火墙命令。该命令只放行专用与域网络；公共网络、来源 IP 限制和上层网络映射由管理员按实际环境调整。历史端口只供核对，不参与连接失败后的自动尝试；用户确认旧端口不再使用后，自行清理对应规则。

通过 SSH 授权放行则使用接收 SSH 连接网卡的实际网络配置文件，并限制为本次 SSH 来源 IP 和接收地址。修改端口后须为新端口重新授权，旧端口记录及旧规则保留，不自动删除或复用。

## 通信与会话

- `GET /health`：Bearer 认证后的版本、协议和监听信息，无秘密。
- `POST /workspace`：Bearer 认证的 JSON 操作入口，工作区处理器执行根目录边界检查。
- `GET /connect`：Bearer 认证后升级 WebSocket，二进制消息承载现有协议 v1。
- WebSocket 内首帧仍为 HELLO，使用相同配对 token；网关将其转换为本机当前 daemon token，本地 IPC 凭据不返回客户端。
- 网络或网关连接关闭只丢弃对应 IPC 连接，不发 `pty.kill`，daemon 保留 PTY 和输出缓冲。重新连接必须接回原 PTY，而非另建 Shell。
- Server 模式下，管理页的「断开连接」只断开该连接的通信与文件监听，保留远端终端进程和 PTY 标识；重新打开项目后重新授权项目根并接回。明确关闭终端标签、结束进程或删除相关运行资源属于终止操作，不能与网络断开混用。
- 状态栏「重新连接 Server」只重建网络连接，不执行 SSH 服务安装或重建 daemon；连接概览显示 `HTTPS / WSS`，其设置入口打开远程连接管理页。
- 宿主崩溃、机器重启或显式结束终端仍会结束进程。此模式不能恢复已经退出的进程。

现有 stdio/IPC 接口保持可用，旧客户端继续通过 SSH 工作。当前直连协议版本为 1；TLS 指纹确认与业务协议版本协商分别执行，不能因证书身份变化自动回退掩盖错误。

已有项目继续使用原连接 ID 和 `ssh://` 资源标识，以兼容文件标签、项目和终端持久化；资源标识不决定实际网络传输。界面显示当前 Server 的真实地址与端口，不展示占位 SSH 端口。

## 构建依赖

新增 TLS 使用 ring 加密后端，构建服务端需要目标 C 编译器。Linux musl 构建使用 `musl-gcc`，ARM64 使用带 freestanding 配置的 GNU 交叉工具链；CI 同时检查静态链接。Windows 运行 `scripts/build-server.ps1` 交叉构建 Linux 服务时，需要 LLVM 的 `clang`、`llvm-ar`，或配置目标 `CC_<target>` / `AR_<target>`。仅有 `rust-lld` 不足以编译 C 源码。

x86_64、ARM64 musl release 静态产物已完成版本、摘要和认证 HTTPS 冒烟（ARM 使用 QEMU）。PowerShell 脚本的 Windows LLVM 回退路径仍需对应环境验证。

## 验证

```text
cargo test --manifest-path src-tauri/qingcode-server/Cargo.toml direct::tests
cargo test --manifest-path src-tauri/qingcode-server/Cargo.toml --test direct_transport
```

集成测试在临时目录启动真实 daemon、通过 TLS/WebSocket 创建 PTY，关闭 WebSocket、重启网关后确认原 daemon PID 和 PTY 仍然存活。测试可在 Windows 上执行以覆盖 ConPTY；Linux 通过不替代 Windows 真机验收。

本轮还在 252.107 的独立临时目录中执行了 Windows GNU 目标的 `direct_transport` 测试，通过 `QC_TEST_SERVER` 指向暂存服务器程序，创建真实 cmd/ConPTY 会话并验证 WebSocket 断开、网关重启后原 daemon PID 和 PTY 保留。另以独立临时状态目录验证脱离启动、TLS 1.2 证书固定、错误凭据/证书拒绝，以及端口 `48763 → 61295` 后的历史记录与 HTTPS 健康检查。测试进程和暂存文件已清理，原 daemon 与用户 PowerShell 未被替换或重启。此验证使用远端回环连接，没有修改防火墙，不代表客户端到远端新端口的局域网入站路径或 Windows 桌面 UI 已验收。

前端 Web 场景位于 `/web-tests/direct-agent.html`，复用真实连接面板、确认对话框与生产样式，后端仅在该页面使用内存适配器。`scripts/web-tests/direct-agent.ego.mjs` 可用于 ego 验收。本轮 ego Windows 桥接不可用时，用临时安装于仓库外的 Playwright 和现有 Linux Chromium 验证固定可编辑端口、历史与防火墙提示、取消身份确认不发送凭据、认证后启用、编辑后重新验证、端口不可达与认证错误分类，以及英文浅色窄窗布局。截图与结果保存在 `.dev/web-tests/direct-agent-playwright/`；这些 UI 结果不替代原生凭据持久化和真实网络/终端验收。

SSH 防火墙授权另有 7 项真实 Chromium 检查，覆盖 Public 范围确认、取消不写入、编辑使检查失效、无管理员权限、写入成功但 Server 不可达，以及英文窄窗布局；结果与截图在 `.dev/web-tests/direct-agent-firewall/`。252.107 已完成真实 SSH 只读预检，确认来源、接收地址、管理员身份及 Public 网络类型；PowerShell 写入、重复操作、状态变化和冲突分支通过该主机上的隔离函数模拟检查。本轮未写入真实 Windows 防火墙规则，原生桌面端到端授权写入仍待验收。


### Windows SSH 安装路径回归（2026-10-28）

Windows SFTP 返回的 `/C:/...` 不能直接交给 PowerShell 执行。准备服务时，启动与配对读取两条命令都转换为 Windows 原生绝对路径，并保留空格、单引号转义。准备按钮显示旋转 loading，完成或失败后恢复。

252.107（Windows）与 252.245（Linux）已使用实际暂存程序、生产启动命令构造器和原生直连客户端完成验证：48763 启动/读取配对、TLS 指纹、认证健康检查、错误凭据拒绝、错误证书拒绝、WSS HELLO 及断开后重新连接。此次未修改防火墙规则；这项验证不覆盖新桌面安装包、桌面凭据持久化或完整 PTY 业务操作。

可通过以下显式启用的测试复验。`QC_DIRECT_BIN` 是预先通过 SSH/SFTP 暂存并校验摘要的远端程序路径；Windows 应传入 SFTP `/C:/...` 形式以覆盖回归。测试会在目标默认状态目录启动或复用 48763 Server，配对凭据仅保留在测试进程内，不写日志。

```bash
QC_SSHCTL=/path/to/sshctl QC_DIRECT_HOST=<authorized-host> QC_DIRECT_BIN=<staged-server> \
  cargo test --manifest-path src-tauri/Cargo.toml --lib live_provision_and_native_direct_connection -- --ignored --nocapture
```
