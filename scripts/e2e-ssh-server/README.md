# SSH 远端代理（qingcode-server）真机端到端验收

对 `src-tauri/qingcode-server` 的 **`serve` 子集**（目录扫描 / 内容搜索 / 文件监视 / 单实例 / 权限 / 会话脱离存活）做真机端到端验收。

**不覆盖**：PTY 持久化、daemon 架构 —— 见下节 `daemon_smoke.py`。

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

