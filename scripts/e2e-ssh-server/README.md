# SSH 远端代理（qingcode-server）真机端到端验收

现有 `run.sh` 对 `src-tauri/qingcode-server` 的 **`serve` 子集**（目录扫描 / 内容搜索 /
文件监视 / 单实例 / 权限 / 会话脱离存活）做真机端到端验收。
PTY 持久化与 daemon 架构使用下列长测和 `daemon_smoke.py`。

## 长连接、并发与持久化验收

`stability.py`（Linux）和 `stability_windows.py`（Windows）使用 `sshctl` 清单中的
连接与凭据，经真实 SSH exec 启动 `connect --stdio`，验证 daemon 协议、PTY、扫描、
搜索、监视和断线接回。脚本不在源码或报告中存储密码。每次使用一个**不存在的独立目录**，
二进制、项目夹和 `--state-dir` 都放在其中，不停止用户原有 daemon。

```powershell
python scripts/e2e-ssh-server/stability.py --host HOST `
  --binary src-tauri/target/server/qingcode-server-x86_64 `
  --remote-dir /tmp/qingcode-stability-UNIQUE --duration 1860 `
  --output .dev/server-stability/linux

python scripts/e2e-ssh-server/stability_windows.py --host HOST `
  --binary src-tauri/target/server/qingcode-server-windows-x86_64.exe `
  --remote-dir C:/Users/Administrator/qingcode-stability-UNIQUE `
  --duration 1860 --connections 8 --output .dev/server-stability/windows
```

默认 `sshctl` 为 `%USERPROFILE%/.codex/skills/sshctl/bin/sshctl.exe`，可用 `--sshctl`
覆盖。先通过技能的 `search` / `add` 设置清单；不要把凭据写进命令脚本或项目设置。
Linux 目标需要 bash、top、基本 coreutils，可运行静态 musl 版 server；不要求安装
Python、Git、ripgrep 或 OpenCode。Windows 脚本在 OpenCode 可用时额外启动其真实 TUI。

Linux 长测保留一个完全无用户输入的 shell、一个 shell 和一个持续刷新的 `top`，另开
8 条连接持续并发执行扫描、流式搜索、状态和终端输入。1860 秒后分别检查连接仍开着、
交互仍能执行、shell PID 保持，并收集 daemon RSS、线程数、句柄数与请求延迟。
功能阶段验证 Unicode、根边界与符号链接逃逸、监视、强杀 SSH 代理后接回、历史补发、
输入序号幂等与 resize。`Session` 客户端使用读线程与有截止时间的队列，处理 PING/PONG、
WINDOW 和按 stream id 分发的并发响应，不使用可能永久阻塞的同步 read 充当超时。
测试客户端自身的编解码、超时及代理清理回归可独立运行：

```powershell
python -W error::ResourceWarning -m unittest discover -s scripts/e2e-ssh-server -p 'test_stability*.py'
```

结果写入 `progress.jsonl` 和 `summary.json`，失败退出码为 1。测试目录保留以便诊断，
成功收尾会显式结束本轮 PTY 和 daemon；失败时应先保留日志，再按已确认的专用路径清理。
`--duration` 可缩短用于脚本预检，缩短运行不构成 30 分钟验收。

Windows 的 `--local` 只跑本机命名管道/ConPTY 补充测试，应明确标注为本机结果。
以上脚本验证的是 server + SSH 协议路径，不能替代桌面客户端的 russh 连接池、信任门禁、
SFTP 编辑或界面验收；这些需要另外运行客户端集成测试或真机桌面检查。

客户端后端另有两个默认忽略的真机测试：

- `live_backend_sftp_trust_pool_concurrency_and_reconnect`：产品 `SshManager` 的
  已确认指纹校验、信任门禁、SFTP 读写和边界、16 路 SFTP、24 路命令、16 个
  终端通道连接池及已确认断线后的重连。设置 `QC_LIVE_HOST`、`QC_LIVE_PORT`
  （可选）、`QC_LIVE_USER`、`QC_LIVE_FINGERPRINT` 和 `QC_LIVE_PARENT`。
  密码认证使用 `QC_LIVE_PASSWORD`；已有私钥可设置 `QC_LIVE_PRIVATE_KEY`，
  加密私钥另设 `QC_LIVE_PASSPHRASE`，此时不要求密码。父目录必须已存在；
  只创建/清理其中本轮的 UUID 测试目录。
- `live_daemon_backpressure_reconnects_and_accepts_input`：真实 russh/daemon 客户端
  产生 4MB 输出并暂停事件消费，验证 2MB 积压保护、原 daemon 存活、attach 恢复
  和后续输入。还需 `QC_LIVE_SERVER_BIN`、`QC_LIVE_SERVER_RUN`、
  `QC_LIVE_SERVER_TOKEN`、`QC_LIVE_ROOT`，均指向本轮专用 daemon，不能用用户现有实例。

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -p qingcode --lib `
  live_backend_sftp_trust_pool_concurrency_and_reconnect -- --ignored --nocapture
```

这些测试不创建 WebView，也不代替界面交互验收。指纹须先独立核验；不要把密码或
daemon token 保存在报告中。Linux 没有 Git 时后端测试明确记录 `git_available=false`。

## daemon 协议冒烟（daemon_smoke.py）

对 **daemon 架构**（协议 v1 + PTY 持久化）做真机冒烟：HELLO 握手 → server.info →
fs.scan（含绝对路径拒绝）→ pty.create/input 实时回显 → **杀掉 SSH 代理模拟断线** →
重连后 pty.list / pty.attach{fromSeq:0} 验证终端存活与 seq 补发 → server.shutdown。

```bash
wsl -d Ubuntu -- env \
  QC_E2E_HOST=192.0.2.10 QC_E2E_USER=root QC_E2E_PASSWORD='<密码>' \
  QC_E2E_BINARY=/mnt/d/Code/QingCode/src-tauri/target/server/qingcode-server-x86_64 \
  python3 /mnt/d/Code/QingCode/scripts/e2e-ssh-server/daemon_smoke.py
```

只依赖 python3 标准库（手写最小 MessagePack 编解码 + `connect --stdio` 上的协议 v1 帧）。
注意两个 pgrep/pkill 坑：二进制名超 15 字符时 `/proc` comm 截断（必须 `pgrep -f`），
且 `-f` 模式要用 `[x]` 字符类避免匹配到承载命令的 shell 自身。

## 前置条件

1. Windows 宿主已安装 WSL（默认发行版名 `Ubuntu`），WSL 内有 `python3` / `ssh` / `scp`。
   WSL 里**不需要** sshpass：脚本用 `SSH_ASKPASS` + `setsid` 做非交互密码认证。
2. 目标主机：Linux、x86_64、SSH 可密码登录、`/tmp` 可写、存在 `setsid` / `stat` / `ss`。
   **不需要**远端安装 `rg`（搜索是代理内建实现，脚本事先断言这一点）。
3. 本地已构建 server 二进制：
   ```powershell
   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/build-server.ps1 -Targets x86_64
   ```
   产物：`src-tauri/target/server/qingcode-server-x86_64`

## 运行

凭据只通过环境变量传入，仓库内不含任何密码：

```bash
wsl -d Ubuntu -- env \
  QC_E2E_HOST=192.0.2.10 \
  QC_E2E_USER=root \
  QC_E2E_PASSWORD='<远端 SSH 密码>' \
  bash /mnt/d/Code/QingCode/scripts/e2e-ssh-server/run.sh
```

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `QC_E2E_HOST` | 是 | — | 远端主机地址 |
| `QC_E2E_PASSWORD` | 是 | — | 远端 SSH 密码（写入临时 askpass，退出时删除） |
| `QC_E2E_USER` | 否 | `root` | SSH 用户 |
| `QC_E2E_PORT` | 否 | `22` | SSH 端口 |
| `QC_E2E_BINARY` | 否 | `<repo>/src-tauri/target/server/qingcode-server-x86_64` | 本地二进制 |
| `QC_E2E_WORK` | 否 | `/tmp/qc-e2e` | 远端一次性工作目录 |
| `QC_E2E_KEEP` | 否 | 空 | 设为 `1` 保留远端现场便于排查 |

退出码：`0` 全部通过、`1` 存在失败断言、`2` 前置条件不满足。

## 脚本结构与覆盖点

```
scripts/e2e-ssh-server/
├── run.sh      # 编排：预检 → 现场 → 上传 → 启动 → 隧道 → 协议断言 → 断连 → 单实例 → 清理
├── client.py   # 协议客户端（4 字节小端长度 + JSON），逐项断言并输出 [PASS]/[FAIL]
└── README.md
```

`run.sh` 的阶段：

| 阶段 | 内容 |
| --- | --- |
| 0 | WSL/Linux 检查、二进制存在性、远端架构 / 发行版 / init / SELinux 记录、断言远端**无 rg** |
| 1 | 远端一次性项目：`src/main.rs`、`src/deep/nested.txt`、中文名文件、3MB 单行文件、指向 `/etc` 的符号链接 `escape` |
| 2 | `scp` 上传到临时名后 `mv` 原子落位 + `chmod 755`（同客户端 SFTP 部署语义），校验大小 / sha256 / 版本 |
| 3 | 用与 `deploy_server_command` 完全同形的 `nohup setsid ... serve --root ... --state ...` 启动，轮询状态文件；校验 0600、仅监听 127.0.0.1 |
| 4 | `ssh -L` 隧道 + `client.py --phase core`：ping / 错误 token / scan / 中文搜索 / glob / 忽略大小写 / 3MB 单行 / 越界拒绝 |
| 5 | `client.py --phase watch`：新建文件事件时效、`escape` 逃逸路径不泄露、断连后 inotify 释放 |
| 6 | 关闭隧道与全部 SSH 会话 → 远端进程仍存活 → 重连隧道 → ping 仍通 |
| 7 | 同 root 第二实例：退出码 `3` 且状态文件 sha256 不变 |
| 8 | 清理 `/tmp/qc-e2e`、`/etc` 探测文件，校验无残留进程 / 端口 / 目录 |

`client.py` 也可单独调试（需要已有可用隧道与 token）：

```bash
python3 client.py --host 127.0.0.1 --port <隧道端口> --token <server.json 的 token> \
  --phase core --expect-version 0.1.13-beta.3
```

## 已知前提与限制

- 搜索语义对齐 `rg --fixed-strings`，但由代理内建的 `grep-regex` / `grep-searcher` / `ignore` 实现，
  因此**远端无需 rg**；与客户端直连模式（走远端 rg）的差异是脚本关注点之一。
- 3MB 单行文件只验证「记录被裁剪到 ≤2MB + `done.truncated=true` + 连接正常收尾」，
  不验证裁剪内容的前端展示。
- `escape -> /etc` 的监视过滤测试会在 `/etc` 下临时 `touch` 一个
  `qc-e2e-probe-<pid>.txt` 并立即删除（用于验证「经符号链接逃逸的变更不得出现在事件流中」）。

## 常见问题

### 1. 每次 ssh 卡 20 秒

某些远端（如 AlmaLinux 默认配置）的 sshd 会广告 `gssapi-with-mic`，WSL 客户端在没有
Kerberos 的环境下会先等约 20s 才回退到密码认证，导致整轮验收被拖到超时。
脚本已统一加 `-o GSSAPIAuthentication=no`（单次连接降到约 0.2s）。
主程序走 russh，本身不做 GSSAPI，因此这只是**验收脚本的环境适配**，不是产品缺陷。

### 2. 验收结果可能被别人的构建产物污染

`src-tauri/target/server/qingcode-server-x86_64` 是多个开发任务共用的产物路径，
`scripts/build-server.ps1` 会原地覆盖。若同时有人在改 `qingcode-server`，直接用它验收
会测到未提交的 WIP 代码。验收「已提交版本」时请从 HEAD 导出到临时目录、用独立
target 目录构建，再用 `QC_E2E_BINARY` 指过去：

```bash
# WSL 内导出纯净 HEAD（不触碰工作树）
rm -rf /mnt/d/Code/_e2e_head && mkdir -p /mnt/d/Code/_e2e_head
git -C /mnt/d/Code/QingCode archive HEAD | tar -x -C /mnt/d/Code/_e2e_head
```

```powershell
# Windows 侧隔离构建
$env:CARGO_TARGET_DIR='D:\Code\_e2e_head\target'
$env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe"
Set-Location 'D:\Code\_e2e_head\src-tauri'
cargo build -p qingcode-server --release --target x86_64-unknown-linux-musl
```

```bash
QC_E2E_BINARY=/mnt/d/Code/_e2e_head/target/x86_64-unknown-linux-musl/release/qingcode-server \
  wsl -d Ubuntu -- env QC_E2E_HOST=... QC_E2E_USER=root QC_E2E_PASSWORD='...' \
  bash /mnt/d/Code/QingCode/scripts/e2e-ssh-server/run.sh
```

### 3. 从 Git Bash 调用时路径被改写

Git Bash 会把 `/mnt/d/...` 当 Windows 路径做转换，需加 `MSYS_NO_PATHCONV=1`：

```bash
MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- env QC_E2E_HOST=... QC_E2E_PASSWORD='...' \
  bash /mnt/d/Code/QingCode/scripts/e2e-ssh-server/run.sh
```

### 4. 部署后先跑 self-check 再信任安装

SFTP 上传二进制后先在远端执行 `./qingcode-server self-check`（打印 `sha256 <hex>`，
可加 `--expect-sha256 <hex>` 对照 manifest.json，不一致退出 1）；noexec 挂载点
在 exec 阶段就会直接失败，能跑起来即证明该目录可执行。

