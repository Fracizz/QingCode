# SSH 工作区

QingCode 的 SSH 工作区直接在 Tauri 后端建立 SSH/SFTP 连接，默认会尝试在远端部署轻量服务 `qingcode-server`（前称 `qingcode-agent` / 远端代理，已全面改名；可一键关闭，关闭后回到零足迹直连），但不强制要求：服务不可用时所有功能自动回退纯 SSH 路径。

## 使用方式

在项目选择器中点击 `+`，选择 `SSH`，填写主机、端口、用户名和认证方式后先连接（不必预先填写远程路径）。首次连接会展示服务端 SHA-256 主机指纹；确认并认证成功后，会打开远程文件夹选择对话框，从主目录浏览并选定项目根目录后再添加。已保存的 SSH 连接可以复用，继续打开同一主机上的其他项目。

- 连接配置与项目分开保存；私钥路径和确认过的主机指纹写入本机 SQLite。
- 密码与私钥口令只保留在当前进程内，不写入项目、设置文件或数据库。
- 推荐使用无口令私钥；这类项目可在应用重启后自动重连。
- 密码或加密私钥在应用重启后会弹出重新连接窗口，再输入本次会话凭据即可。

## 当前能力

- 通过 SFTP 浏览、读取、编辑、新建、重命名和删除远程文件。
- 文件名搜索兼容常见 GNU/BusyBox `find`；内容搜索由远端 `rg` 执行，并固定按普通文本匹配。
- 远程 PTY 终端。Linux 远端进入登录 shell；Windows OpenSSH 的盘符路径（`/D:/code/app`）支持根据用户配置启动 `powershell.exe -NoLogo`、`pwsh` 或 `cmd.exe`，提示符出现时直接进入项目根目录，不回显切目录命令，无版权横幅；远端 `DefaultShell` 为 cmd、PowerShell 或 Git Bash 时行为一致（启动命令整体加引号，切目录脚本走 `-EncodedCommand`）。设置 `terminal.integrated.sshUploadOnPaste`（默认开启）生效后，在 SSH 终端里粘贴或拖入本机文件会先上传到项目内 `.qingcode/terminal-paste/`，再粘贴远端路径。超过 100MB 的文件或文件夹会被拒绝。设置页和终端右键可清理该目录。
- Git 状态、历史、分支与切换、远程地址、Diff、丢弃、暂存、提交、拉取、推送和获取。
- 使用远端项目工具格式化文件（Prettier、rustfmt、gofmt、shfmt、ruff/black）。
- 在本地与 SSH 项目之间上传或下载文件和目录。资源管理器可右键上传，也可把本机文件或文件夹拖到 SSH 项目的文件树：文件夹接收到该目录，文件上则传到父目录，空白处和项目标题传到项目根。在 SSH 项目里粘贴（Ctrl+V 或右键「粘贴」）时，系统剪贴板中的本机文件或文件夹、以及应用内复制的本地路径都会上传到目标目录；跨域剪切按复制处理，不删除本机源文件。
- 多项目搜索可以混合本地项目和 SSH 项目。

## 远端服务（qingcode-server）

Linux / POSIX SSH 项目（已信任、设置 `ssh.server.enabled` 默认开启）会在连接后自动部署远端服务。**设计稿见 D:/Download/ssh-agent-design.md（外部文档，未入库；文中 agent 即现 qingcode-server）**，当前进度见文末「实施进度与未完成清单」。

命名迁移说明：设置键 `ssh.agent.enabled` / `ssh.agent.autoDownload` / `ssh.agent.offlineDir` 读取时仍回退兼容，保存时自动迁移为 `ssh.server.*` 并清理旧键；远端旧目录 `.qingcode/agent/`（含旧状态文件 `agent.json`）在部署时会被发现并按 pid 尽力清掉旧 serve；离线目录与下载缓存里的旧名二进制 `qingcode-agent-*` 仍可读取；环境变量 `QINGCODE_AGENT_DIR` / `QINGCODE_AGENT_DOWNLOAD_BASE` 作为旧名继续兼容，优先使用 `QINGCODE_SERVER_DIR` / `QINGCODE_SERVER_DOWNLOAD_BASE`。

### 运行形态（两套并存）

| | `serve` 模式 | `daemon` 模式（新） |
|---|---|---|
| 进程 | 每项目根一个进程，随端口暴露给 direct-tcpip | 常驻 daemon（每远端用户 `flock` 单实例，可多工作区共用）+ 每条 SSH exec 一个 `connect --stdio` 代理 |
| 传输 | SSH `direct-tcpip` 通道 + JSON 帧 | SSH exec stdio + 协议 v1 二进制帧（MessagePack、256KB 信用窗口、优先级、CANCEL、PING/PONG） |
| 安全 | token 在项目 `.qingcode/server/server.json`（0600） | token 在 `~/.qingcode/server/run/token`（0600），运行目录 0700，`SO_PEERCRED` 同 uid 校验，`flock` 单实例 |
| 断线 | 只影响当次操作 | 代理死、daemon 与其中的终端继续运行，重连按 seq 补发输出或退化为屏幕快照 |
| 状态 | 已全量启用，是回退的终点 | 后端/协议已就绪并在真机验证；**终端持久化的前端接入尚未做**（见未完成清单） |

- **部署物**：单个静态 musl 二进制（约几 MB），上传到项目 `.qingcode/server/qingcode-server-<arch>`（x86_64 / aarch64）。本地二进制查找顺序：设置里手动选择的离线目录（`ssh.server.offlineDir`）→ `QINGCODE_SERVER_DIR` 环境变量（旧名 `QINGCODE_AGENT_DIR` 兼容）→ exe 目录 `/servers`（旧名 `/agents` 兼容）→ exe 目录上级 `/server`（旧名 `/agent` 兼容）→ 资源目录 `/servers`（旧名 `/agents` 兼容）→ 下载缓存目录（`ssh.server.autoDownload` 开启时）。开发与打包用 `scripts/build-server.ps1` 产出并复制到 `src-tauri/target/server/`。
- **部署幂等与自检**：上传前先在远端计算已存在二进制的 sha256，与本地一致就跳过上传（版本一致必然 sha 一致，避免失败重试时反复全量上传几十 MB）；确需上传时走「临时文件 + 原子替换」，上传后远端执行 `self-check --expect-sha256`，校验成功才启动（同时探测部署目录 noexec）。
- **部署失败分类与退避**：自动下载的网络类失败（断网、GitHub 不可达）按瞬时处理，不缓存为整连接不可用，下次调用自动重试；sha 不符、体积超出 manifest 声明、自检失败是确定性失败，缓存为不可用等待人工介入。同一 (连接, 根) 连续 2 次完整部署都等不到就绪（典型如 sshd 禁了 TCP 转发，ping 永远打不通）也会标记不可用并提示检查 `AllowTcpForwarding`、重启远端服务或断开重连，直到重连才解冻；切换 `ssh.server.autoDownload` 开关或修改离线目录会清空不可用缓存立即重试，无需重连。
- **运行形态（`serve` 模式）**：`setsid + nohup` 守护进程，只监听远端 `127.0.0.1` 随机端口，客户端经 SSH `direct-tcpip` 通道接入，无公网暴露；token 写在项目 `.qingcode/server/server.json`（远端权限 0600），serve 的输出重定向到 `.qingcode/server/serve.log`（启动前超过 1MB 先截断，端口占用、rc=3 退出等启动失败有迹可查）。应用重启后重连时先发现存活服务，免重新部署；版本不一致时校验进程身份后 kill 并重新部署。daemon 模式则常驻 `~/.qingcode/server/run` 下，运行目录 0700、token 0600（由 OS 随机源生成，daemon 每次启动轮换），经 `connect --stdio` 代理接入（见上表）。daemon 传输失败只降级该端点的 daemon 标记（serve 照常可用），5 分钟冷却后自动重新探测，daemon 崩溃不会永久留在 serve 模式。
- **带来的能力**：
  - 远程文件树自动刷新（server 递归 inotify → 后端复用本地 `fs-change` 事件管线：树刷新、脏标签冲突提示、Git 状态刷新全链路生效）；
  - 内嵌内容搜索（ripgrep 引擎编译进服务，**不再要求远端安装 rg**，支持 ignore 文件与 glob 过滤，与远端 rg 结果语义一致）；
  - 目录扫描单往返（替代多次 SFTP round trip，高延迟链路下文件树展开更快），`done.files_scanned` 上报真实条目数；
  - 状态栏芯片只显示简洁状态：`Server`（绿点）/ `Server…`（黄点闪动，连接中）/ `直连`（灰点），版本等细节收进悬停摘要（`Server v版本` 等 + 「点击查看详情」）。**点击直接打开详情弹窗**（标准 modal，头部含重启与日志入口），右键菜单提供查看详情、重启 Server、查看日志（daemon 日志 + 项目 serve 日志两段拼接，各取末尾 200 行）。查询失败时芯片以 `!` 错误态显示「Server 状态未知」，不再伪装成直连；重启成功与失败均有明确 toast。
- **远程终端不受影响（现状）**：终端仍走独立 SSH PTY 通道，与服务完全正交；服务部署/重连不会触碰有活跃终端的连接。daemon 模式的 PTY 宿主（`qingcode-server/src/pty.rs`）已就绪，但前端尚未切过去（未完成项 A）。
- **关闭、停止与清理**：设置里关闭 `ssh.server.enabled` 后完全回退直连（远端零足迹），并对当前激活的 SSH 工作区自动调用 `ssh_server_stop`（serve 按状态文件 pid 结束 + daemon 尽力 `server.shutdown`）。命令 `ssh_server_restart` / `ssh_server_stop` / `ssh_server_logs` 均要求工作区已信任；「重启 Server」会同时重建 serve 与 daemon（此前只重建 serve）。迟授予信任的已连接项目会补启动文件树 watch 监督任务，不必重连。清理：删除项目内 `.qingcode/server/` 目录即可；或按状态文件里的 pid `kill`。断开连接不终止远端服务（保活供快速重连，与 VS Code Server / Zed remote_server 生命周期策略一致）。
- **已知限制（MVP）**：
  - 关闭总开关会停止当前激活 SSH 工作区的远端服务，其他已连接 SSH 工作区的远端进程不会被逐一停止；重新打开后需重新连接项目才会恢复自动刷新。
  - 远端保存文件也会触发一次 `fs-change`（尚未做本地那样的自写抑制），表现为多一次目录树刷新与 Git 刷新。
  - 单行超过 2MB 的内容搜索命中会截断并停止（与未部署服务时的 rg 路径一致）。
  - 远端服务不做自启动注册，注销/重启远端主机后需重新连接项目才会重新部署。
  - **发行渠道**：安装包和便携版 exe 都不内置服务二进制，安装包体积不受影响。在线：`ssh.server.autoDownload`（**默认开**）从 GitHub Release 的 `server-v<版本>` 标签下载，`manifest.json` 含 sha256 与 size，下载边流式校验 sha256、按 manifest 声明的体积设上限（旧清单缺 size 字段时兜底 256MB），校验通过才落位缓存目录；并发下载的临时文件以唯一后缀命名并在失败时清理。需要能访问 GitHub，可用 `QINGCODE_SERVER_DOWNLOAD_BASE`（旧名 `QINGCODE_AGENT_DOWNLOAD_BASE` 兼容）指向内网镜像。离线：设置 → 功能里手动选择解压后的 `servers` 目录（`ssh.server.offlineDir`，优先于自动查找，旧名 `agents` 目录同样兼容）；也可以把 `release/QingCode-servers.zip` 里的 `servers/` 放到 `QingCode.exe` 同目录，或设置 `QINGCODE_SERVER_DIR`。本地文件优先于下载。清单里有 Linux `qingcode-server-x86_64` / `aarch64`，以及 Windows `qingcode-server-windows-x86_64.exe`。

搜索结果会标明是否被截断；远程文件名搜索在匹配后限制结果数量，内容搜索先限制待扫描文件集合，再流式接收匹配结果。文件名搜索和内容搜索分别取消，切换查询会停止旧的后台搜索；单次远程搜索整体最长 45 秒。内容搜索的单文件匹配上限、8MB 文件清单、16MB 输出预算或单条 2MB 的输出记录上限同样会触发截断提示。搜索根目录在执行前通过 SFTP 解析真实路径，不允许从项目内的符号链接目录搜索到项目外。

上传和下载提供任务进度、取消与剩余项目重试。进度显示已完成文件、字节数以及当前文件字节数，不预估整个目录的百分比。文件按块传输并写到同目录临时文件，全部写入完成后替换目标；覆盖已有文件时保留原目标权限。取消不会截断已有目标文件，已完成的文件会保留，未完成文件的临时文件会尝试清理；断线导致无法清理的远端 `.qingcode-transfer-*.tmp` 可在确认任务结束后清理。重试目录会重新遍历该目录，因此其中已成功传输的文件也可能再次覆盖。

SFTP v3 服务端拒绝覆盖式重命名时，上传使用 Linux `mv -fT` 原子替换同目录临时文件；缺少该能力会提示错误，不回退到截断原文件。取消在最终原子提交阶段等待提交结果；该阶段每次操作最多 15 秒，若连接中断无法确认提交结果，会明确提示先检查目标文件。

所有远程资源使用内部 `ssh://<connection-id>/<absolute-path>` 标识。后端只接受已注册项目根目录内的资源；写入、上传、格式化和命令执行还要求工作区处于信任模式。SFTP 操作会解析真实路径并拒绝通过符号链接越出项目根目录。远端搜索不会跟随符号链接，前端也不暴露任意远程命令入口。

## 当前边界

- 本地和 SSH 工作区均提供文件与文本导航，不提供语义定义跳转、引用查找或工作区符号搜索。
- 内容搜索要求远端安装 `ripgrep`（`rg`），Git 功能要求远端安装 `git`；部署远端服务后内容搜索不再依赖远端 `rg`。
- Linux / POSIX 远端支持远程命令、Git、搜索、格式化和运行任务。Windows OpenSSH 支持 SFTP 文件操作、交互式 PowerShell / CMD 终端和 Git（要求远端 `git.exe` 在 PATH 中，经 `powershell.exe` 直接启动 git，不依赖远端默认 shell 是 cmd 还是 PowerShell）。部署 Windows 版 serve 服务后，目录扫描、内容搜索和文件树刷新可用。文件名搜索、格式化、PowerShell / BAT 运行任务和 daemon 仍不可用。
- 连接每 15 秒保活一次，连续约 75 秒没有任何回包才判定断开，不使用空闲超时。打开通道 15 秒无响应时先发一次 ping（15 秒），只有 ping 也失败才按断线处理，连接只是慢时不会被拆掉。每个远程终端（含运行任务）各用一条独立的 SSH 连接，主连接只承载 SFTP 和远程命令：sshd 每条连接的会话数有上限（`MaxSessions`，默认 10），多个项目共用同一连接配置时终端不会把它占满；主连接重连也不会断开终端，一个终端的连接断了只影响它自己。终端连接同时最多 6 个在握手（避开 `MaxStartups` 默认的 10），握手失败时提示检查该项，终端结束、关闭或被同 id 替换时断开对应连接。主连接共用一个 SFTP 会话，请求发出后 45 秒没有任何回包即视为僵死，下次操作换新会话；远程命令同时最多 6 个（超出排队），普通命令（status / diff / show 等）超过 2 分钟、fetch / pull / push 超过 15 分钟会被中止并释放名额。传输已断开（按 russh 错误类型判断）或打开通道被拒绝（`ConnectFailed`）时重连一次：新连接认证成功前旧连接保留在表里，并发请求排队复用同一次重连；重连失败不会丢掉已保存的连接配置，3 秒内的并发请求直接复用这次失败。
- SSH 终端区分远端正常退出与连接断开。断开后交互式终端按 1/2/5/10/20 秒退避自动重开（随之重连），成功后提示断线前的远端进程已结束；全部失败则停在已退出并提示，可从终端标签重启。运行配置等一次性任务断线后直接停下，不自动重跑。纯 SSH 无法在断线后保住远端进程，需要时请在远端自行使用 tmux / screen。家目录先用登录目录，否则再试 `/home/<用户>`、`/C:/Users/<用户>`、`/root` 和 `/`。
- WSL 直连工作区尚未接入；可先通过 WSL 内的 SSH 服务使用同一 SSH 工作区能力。
- 尚未提供远程扩展、端口转发、SSH Agent 转发和连接配置管理页。
- 与本地工作区尚未对齐的能力、部分对齐项和仅 SSH 才有的能力见下文。

## 本地与 SSH 能力对照

对照日期：2026-10-23。对象是 Linux / POSIX SSH 工作区相对本地工作区；Windows OpenSSH 另见本节末。两侧都没有的能力单独列出，避免误当成 SSH 缺口。

图例：**已对齐** · **部分对齐** · **仅本地** · **仅 SSH** · **两侧都没有**

### 总览

| 能力面 | Linux SSH vs 本地 | 说明 |
|---|---|---|
| 文本读写、新建、重命名、删除 | 已对齐 | 走 SFTP；删除不可作用于项目根；部署服务后目录扫描单往返 |
| 资源管理器剪切 / 复制 / 粘贴 / 移动 | 已对齐 | 走 SFTP `ssh_move_path` / `ssh_copy_path_into`；粘贴本机文件/文件夹到 SSH 目录时自动上传 |
| `files.exclude` / `explorer.excludeGitIgnore` | 部分对齐 | `ssh_scan_directory` 支持 `files.exclude` glob 排除；gitignore 排除仍仅本地 |
| 操作系统文件监视与树自动刷新 | 仅本地 → 服务已补齐 | 部署 `qingcode-server` 的 SSH 项目通过远端 inotify 复用本地 `fs-change` 管线；未部署时维持旧行为 |
| 文件名 glob（如 `*.tsx`） | 仅本地 | 远程按字面子串匹配，`*` 是普通字符 |
| 内容搜索（字面量）与工作区替换 | 部分对齐 | 部署服务后由服务内嵌 ripgrep 引擎执行（不要求远端 rg）；未部署时需远端 `rg`。远程忽略「跟随符号链接」，文件名搜索还忽略 ignore 文件 |
| Git 核心 SCM | 部分对齐 | 状态到推送已对齐；拉取/推送/获取时间戳在 SSH 上始终为空 |
| 终端 PTY | 部分对齐 | 可开多个远程终端。`ssh_create_terminal` 接受传入的 `shell`：Linux 为 `bash`/`zsh`/`sh`，否则远端登录 shell；Windows OpenSSH 为 `powershell`/`pwsh`/`cmd` |
| 运行配置 | 部分对齐 | Linux SSH 仅 `command` / `sh` / `script`；CLI 改远程 `run.json` 必须 GUI 在线 |
| 格式化 | 部分对齐 | 走远端工具；扩展名集合与本地不完全相同，Python 反而 SSH 可用 |
| 工作区信任、项目 JSON5 设置、主题 | 已对齐 | 设置导入导出不含 SSH 项目 |
| 上传 / 下载 / 拖入本机文件 | 仅 SSH | 本地资源管理器不接收操作系统文件拖放导入 |
| 「用……打开」/ 独立文件窗口 / WSL 工作区 | 仅本地 | SSH 不是工作区种类，也不是文件关联目标 |
| 端口转发、Agent 转发、连接管理页 | 两侧都没有 | SSH 域内尚未做 |

### 文件系统与资源管理器

| 能力 | 状态 | 差距 |
|---|---|---|
| 浏览、读、写、新建文件/目录、重命名、删除 | 已对齐 | 写操作要求信任；SSH 拒绝删除项目根 |
| 剪切、复制、粘贴、树内移动 | 已对齐 | 走 SFTP `ssh_move_path` / `ssh_copy_path_into`；本机文件（系统剪贴板或应用内复制）粘贴到 SSH 目录时自动上传；SSH→本地仍需下载 |
| 操作系统文件拖到文件树 | 仅 SSH | 拖入即上传；本地没有对等的导入路径 |
| 上传 / 下载任务（进度、取消、重试、原子替换） | 仅 SSH | 只支持「本机 ↔ 当前 SSH 根」，不能 SSH↔SSH |
| `files.exclude`、按 gitignore 隐藏 | 部分对齐 | `ssh_scan_directory` 支持 `files.exclude` glob 过滤；gitignore 隐藏仍仅本地 |
| 符号链接 | 部分对齐 | 两侧都拒绝越出项目根。本地写越界可弹出确认；SSH 直接报错。远程搜索不跟随链接 |
| 编码检测 / 按编码读写 | 部分对齐 | 本地检测读约 8KB；SSH 会先把整个远程文件下载下来再取样 |
| 大文件切片预览（100–500MB） | 已对齐 | 两侧都限制编辑 ≤100MB。SSH 单次切片上限 4MB，本地 256KB。跳转指定行走 `ssh_find_line_offset` 流式扫描 |
| 属性对话框 | 部分对齐 | 文件/文件夹节点菜单已禁用。项目标题仍可打开属性，但创建时间、目录条目统计未映射到 SFTP |
| 删除文件夹确认（条目统计） | 已对齐 | 映射至 `ssh_directory_delete_stats`，递归统计文件数与总大小 |
| 在操作系统文件管理器中显示 | 仅本地，已全面门控 | SSH 资源无本地文件管理器位置。节点菜单、顶栏芯片、项目管理、编辑器标签/右键、面包屑、状态栏、搜索结果、收藏夹、大文件预览、打开失败页均已禁用或拦截提示 |
| 重新定位项目 | 已对齐 | 侧栏、顶栏芯片、项目管理、添加项目弹窗对 SSH 统一显示为「重新连接」，调用重连流程，避免误改成本地路径 |
| 复制路径 | 已对齐 | 复制远端绝对路径：POSIX 为 `/home/...`，Windows OpenSSH 为 `D:/code/...`，不含内部 `ssh://<connection-id>` |
| 收藏 | 部分对齐 | 相对路径收藏可用；「在文件管理器中显示」已对 SSH 禁用 |
| 状态栏「将所在文件夹作为项目打开」 | 仅本地，已门控 | 对 SSH 资源禁用并提示 |

### 搜索

| 能力 | 状态 | 差距 |
|---|---|---|
| 多项目混合搜索 | 已对齐 | 本地根和 SSH 根可同时搜 |
| 文件名搜索（模糊、后缀、大小写、扩展名、`search.exclude`） | 部分对齐 | 远程 `find` 固定剪掉 `.git` / `node_modules` / `target`，并丢弃 `useIgnoreFiles` / `followSymlinks` |
| 文件名 glob | 仅本地 | 远程把 `*.tsx` 当普通子串 |
| 内容搜索 | 部分对齐 | 两侧都是字面量（无正则开关）。远程固定 `rg --fixed-strings`，需要远端 `rg`；`followSymlinks` 被忽略 |
| 工作区替换 | 部分对齐 | 预览来自内容搜索命中，再走已映射的读写。Windows OpenSSH 上内容搜索要等 serve 服务部署成功；文件名搜索仍不可用 |
| 取消、45 秒超时、截断提示 | 已对齐 | 远程额外返回截断元数据 |

### Git / 源代码管理

Linux SSH 要求远端有 `git`。Windows OpenSSH 要求远端 `git.exe` 在 PATH 中，能力与 Linux SSH 相同。

| 能力 | 状态 | 差距 |
|---|---|---|
| 状态、暂存、取消暂存、丢弃、提交 | 已对齐 | |
| 项目位于仓库子目录 | 已对齐 | `git status` 限定在项目子树（`-- .`），并按 `rev-parse --show-prefix` 裁掉前缀；前缀按项目缓存，`<rev>:<path>`（Diff / 与 HEAD 比较）同样补回前缀 |
| 拉取（含 rebase）、推送、获取 | 已对齐 | |
| 分支列表与切换、远程地址、历史、提交文件、工作区 vs HEAD Diff | 已对齐 | 两侧都不能在 UI 里新建或删除分支 |
| 上次获取 / 拉取 / 推送时间 | 仅本地 | SSH 的 `last_fetch_at` 等字段始终为 `None`，工具栏同步时间芯片为空 |
| 轻量脏标记（状态栏 / 项目徽章） | 部分对齐 | SSH 用完整 `git_status` 近似，多一次远程往返；徽标数字只归属当前项目，切项目时先归零再取快照 |
| 自动刷新频率 | SSH 专属降频 | SSH 下状态栏分支芯片不轮询（每 15 秒一次全量 `git status` 太贵），分支名跟随 workdir / SCM 快照；窗口聚焦刷新冷却 60 秒；顶栏多项目角标按 `qingcode.git.refreshIntervalStartMinutes` 的 **4 倍**周期轮询、聚焦冷却 60 秒，窗口不可见时不刷新；窗口聚焦不自动 fetch（进入源代码管理时仍会自动 fetch 一次，也可手动「检查更新」）。切项目、保存文件、打开源代码管理、手动刷新仍即时生效 |
| 编辑器自身产物 | 已对齐 | `.qingcode/terminal-paste/` 与 `*.qingcode-*.tmp`、`.qingcode-transfer-*.tmp` 这类**未跟踪**临时文件不计入更改数；`.qingcode/run.json` 等项目配置仍正常显示、可提交 |
| 冲突 | 部分对齐 | 状态里能看到冲突，拉取可返回 `has_conflicts`；两侧都没有三方合并或 accept ours/theirs |
| stash、独立 merge/rebase、blame、amend | 两侧都没有 | |

### 终端与运行配置

| 能力 | 状态 | 差距 |
|---|---|---|
| 远程 PTY、cwd、缩放、多终端、复制粘贴 | 部分对齐 | 写入和开终端要求信任。`terminal.integrated.sshUploadOnPaste` 默认开启；粘贴/拖入本机文件会上传到 `.qingcode/terminal-paste/` 再粘贴远端路径。超过 100MB 的文件或文件夹会被拒绝。设置或终端右键可清理 |
| 终端配置文件 / `default_shell` / 本机 shell 选择 | 部分对齐 | `ssh_create_terminal` 支持传递 `shell`。Linux 支持 `bash`/`zsh`/`sh` 或默认登录 Shell；Windows OpenSSH 支持 `powershell`、`pwsh` 与 `cmd`，提示符出现时直接位于项目根目录，无命令回显 |
| 配置启动命令（`interactive`） | 部分对齐 | Linux SSH 可用 `/bin/sh -lc …; exec 登录 shell`；Windows OpenSSH 拒绝 |
| 关闭前「子进程仍在运行」探测 | 仅本地 | `terminal_has_child_processes` 未映射；失败时按忙碌处理，SSH 终端关闭常会多一次确认 |
| `.qingcode/run.json` | 已对齐 | SSH 经 SFTP 读写；CLI 改远程配置需要正在运行的 GUI 会话 |
| 任务类型 | 部分对齐 | 本地：`command` / `ps1` / `bat` / `sh` / `script`。Linux SSH：仅 `command` / `sh` / `script` |
| `script` 解释器 | 部分对齐 | SSH：py / js / ts / rb / php / pl / bash / zsh / sh / 可执行文件。不支持远端 `.ps1` / `.bat` / `.cmd` |

### 格式化

| 能力 | 状态 | 差距 |
|---|---|---|
| 保存时 / 粘贴时格式化 | 部分对齐 | 均调用 `format_document`；SSH 在远端 stdin 跑工具 |
| Prettier 扩展名 | 已对齐 | 双方均支持 `js`/`jsx`/`mjs`/`cjs`/`ts`/`tsx`/`mts`/`cts`/`json`/`jsonc`/`json5`/`css`/`scss`/`less`/`html`/`htm`/`vue`/`svelte`/`md`/`markdown`/`mdx`/`yaml`/`yml`/`graphql`/`gql`/`astro` |
| Python | 反向差距 | 本地明确返回「暂不支持 Python 格式化」。SSH 优先 `ruff`，否则 `black`（支持 `.py` / `.pyi`） |
| rustfmt / gofmt / shfmt | 已对齐 | 工具来自系统/远端 PATH。shfmt 双方均覆盖 `.sh` / `.bash` / `.zsh` |

### 文件监视与外部更改

本机 `sync_file_watches` 只登记本地路径：活动项目树和已打开标签都会跳过 `ssh://`。SSH 项目根和 SSH 标签不会进入本地操作系统 watcher。

部署 `qingcode-server` 后，远端 inotify（`watch.subscribe`）由后端转成同一条 `fs-change`。文件树会自动刷新，已打开标签走同一套磁盘同步（含脏标签冲突提示），Git 状态刷新也跟着生效。未部署服务时没有这条推送：SSH 仍只在**激活标签或窗口获得焦点**时用 `file_mtime` + `read_file` 对已打开文件做一次同步，脏标签冲突提示可以出现，但远端文件被别人改写时不会自动刷新文件树。

### Markdown、预览与打开方式

| 能力 | 状态 | 差距 |
|---|---|---|
| Markdown 预览与仓库内链接 | 已对齐 | `ssh://` 链接按连接 ID + POSIX 路径解析；跨连接链接不受理 |
| Markdown 本地图片 | 仅本地 | 相对图片路径会把 `ssh://` 文档路径归一化坏；`convertFileSrc` 也只接受本机文件。远程 `https://` 图片仍可显示 |
| 图片 / PDF / 二进制编辑标签 | 两侧都没有 | 同样按扩展名拦截；二进制不能「仍然打开」 |
| Windows「用 QingCode 打开」与独立文件窗口 | 仅本地 | 启动队列按本机路径 canonicalize；没有 `ssh://` 关联 |

### 设置、CLI 与连接管理

| 能力 | 状态 | 差距 |
|---|---|---|
| 用户设置、主题、字体、快捷键、界面语言 | 已对齐 | 机器本地，与项目种类无关 |
| 工作区 `.qingcode/project-settings.json` | 已对齐 | 需 SSH 已连接 |
| 设置里的项目列表导入导出 | 仅本地 | 导出过滤 `kind !== 'ssh'`；导入拒绝 `ssh://` |
| CLI `project list` / `remove` / `switch` | 已对齐 | 列表含 `ssh://` 行 |
| CLI `project add` | 仅本地 | SSH 项目只能从应用内对话框添加（连接、指纹、信任要一起建立） |
| CLI `run *` | 部分对齐 | 本地可离线改文件；SSH 必须通过正在运行的 GUI 走 SFTP。启动/停止两侧都要 GUI |
| CLI `open` | 仅本地 | 第二实例 / 外部窗口按本机路径归并 |
| SSH 连接增删改页 | 已做（SSH 域） | 「远程连接」管理页：新建/编辑/删除连接（删除前检查项目引用）、测试连接并确认指纹、按连接列出远程项目与已注册根（可撤销信任）、聚合远端服务状态（重启/日志）。入口：欢迎页、命令面板、打开 SSH 项目对话框。目标（主机/端口/用户名）变化后必须重新测试连接确认指纹才能保存；密码不落盘，仅会话内存 |

### 两侧都没有（不是 SSH 专属缺口）

- 语义智能：定义跳转、引用、工作区符号、LSP、问题面板
- 调试器 / DAP / 断点（活动栏「运行配置」只跑任务）
- Git stash、blame、新建/删除分支、三方冲突编辑器
- 图片、PDF 作为一等编辑标签；chmod 界面

### Windows OpenSSH

路径形如 `ssh://<id>/D:/code/app`。可用：SFTP 文件操作、交互式 PowerShell / CMD 终端、Git、与本机之间的上传下载。部署 Windows 版 `qingcode-server`（serve）后，目录扫描、内容搜索和文件树刷新走服务；daemon、终端持久化和 `ps1`/`bat` 运行任务还没有。不可用：任意远程命令、文件名搜索、格式化、运行任务。这是平台限制，不是 Linux SSH 的对照表所能概括的。

### 补齐进展与后续建议

已于 2026-10-23 补齐：
- **SSH 远端服务（qingcode-server，前身为 qingcode-agent）**：文件树自动刷新、内嵌内容搜索（不依赖远端 rg）、单往返目录扫描、daemon 常驻 + PTY 宿主 + 协议 v1、客户端 daemon 接入、独立 GitHub Release（`server-v*` 标签）与按需下载。状态栏可看服务阶段、重启 Server 和查看日志。
- **改名与部署加固（同日第二轮）**：全面改名 qingcode-agent → qingcode-server，设置键迁移 `ssh.server.*`（读取兼容旧 `ssh.agent.*`，保存时清理）；`ssh.server.autoDownload` 默认开；部署幂等（远端 sha256 一致跳过上传）与连续失败退避（提示 `AllowTcpForwarding`）、失败分类（网络类瞬时）；上传后 `self-check` 成功才启动；新增 `ssh_server_stop`，设置里关闭远端服务时对当前 SSH 工作区自动调用；「重启 Server」同时重建 serve 与 daemon；serve 输出落盘 `.qingcode/server/serve.log`，「查看 Server 日志」返回 daemon 与 serve 两段日志；restart/logs/stop 要求工作区已信任；迟授予信任补启动 watch；daemon 降级 5 分钟冷却重试；token 改 OS 随机源；`files_scanned` 真实计数；状态芯片错误态与重启/保存失败 toast、日志对话框加载态与刷新按钮、设置导入后立即推送后端；并发下载临时文件唯一命名与按 manifest 体积上限。详见下文「远端服务：实施进度与未完成清单」。

此前（2026-10-22）补齐：
- **SSH 终端本机文件粘贴/拖放**：`terminal.integrated.sshUploadOnPaste` 默认开启。资源管理器复制的文件、纯路径文本或拖到终端的本机文件会上传到 `.qingcode/terminal-paste/`，并粘贴远端路径。成功后不保留传输任务条。单个文件，或文件夹内文件合计，超过 100MB 时整次粘贴会被拒绝；设置页和终端右键可清理该目录。
- **门控防护**：全面门控在文件管理器打开、项目重新定位、状态栏「作为项目打开」等入口，避免 `ssh://` 交给本地 API 导致报错或写坏项目配置。
- **资源管理器移动/复制**：新增 `ssh_move_path` 与 `ssh_copy_path_into` 命令，完整支持同连接下的剪切、复制、粘贴与树内移动 DnD。
- **文件排除**：`ssh_scan_directory` 接入 `files.exclude` 配置并按 glob 规则在远端过滤。
- **大文件跳行**：新增 `ssh_find_line_offset`，支持大文件预览时流式查找行字节偏移并跳转。
- **删除统计**：新增 `ssh_directory_delete_stats`，递归统计待删除目录的文件数与总大小。
- **格式化扩展名对齐**：本地与 SSH 远端的 Prettier 与 shfmt 扩展名集合完全对齐。

后续建议：
1. 文件名 glob、ignore 文件，以及 Git 同步时间戳。
2. 远程终端尊重配置文件/默认 shell，并正确探测忙碌状态。
3. Markdown 远程图片、属性对话框。
4. 连接配置管理页；再往后才是端口转发、Agent 转发、WSL 直连工作区。

---

## 远端服务：实施进度与未完成清单

对照设计稿 `D:/Download/ssh-agent-design.md`（§11 分 M0–M5，一次完整发布；文中 agent 即现 qingcode-server）。**整体进度约 60%：架构、传输、发布链路、连接状态界面和部署加固已完成，能力域迁移与终端持久化仍缺。**

### 已完成（验证方式见「真机验收」）

| 设计章节 | 内容 | 提交 |
|---|---|---|
| §3/§5 协议 | 协议 v1：`u32_be len + kind + stream_id` 帧、MessagePack 负载、1MB 上限、64KB 分片、256KB 信用窗口、优先级（8:1 防饿死）、CANCEL、15s PING/45s 断链 | `33d6eed` |
| §3 daemon | 常驻进程 + `connect --stdio` 代理：`~/.qingcode/server/run`（0700）、token 0600、`SO_PEERCRED` 同 uid、`flock` 单实例、10 分钟空转退出、24h detached TTL、64 PTY/256MB 限额、`server.log` 5MB 滚动留 3 份 | `33d6eed` |
| §6 PTY 宿主 | `portable-pty` + `vt100` 屏幕快照 + 环形缓冲（块级 seq）、`attach{fromSeq}` 补发或快照降级、总量硬上限淘汰（先 detached 最久）、SIGHUP/SIGKILL 生命周期、`hasChildren`（读 `/proc`） | `33d6eed` |
| §3/§7 传输接入 | 客户端 scan/search/watch 优先走 daemon（`fs.scan` / `search.content` 流式 / `watch.subscribe`），回退链 daemon → serve → 直连；token 轮换自愈 | `4f91c6b` |
| §4.2/§8.3 完整性 | `self-check --expect-sha256`；构建脚本生成 `manifest.json`（version + sha256 + size）；noexec 以 exec 失败暴露 | `4f91c6b` |
| §4.1 发布 | `.github/workflows/server-release.yml`（原 `agent-release.yml`）：独立流水线（push `server-v*` 标签或手动触发），ubuntu runner 双架构 musl + rust-lld，发布到 `server-v<版本>` 标签 Release，资产 `qingcode-server-<arch>` / `qingcode-server-windows-x86_64.exe` / `manifest.json` | `9c4081f` |
| §4.1 下载 | `ssh.server.autoDownload`（**默认开**）：缺失时从 Release 下载，流式算 sha256 对 manifest 后才落位缓存目录；`QINGCODE_SERVER_DOWNLOAD_BASE` 可指内网镜像（旧名 `QINGCODE_AGENT_DOWNLOAD_BASE` 兼容） | `9c4081f` |
| §7 子集 | 文件监视、内嵌内容搜索（无需远端 rg）、单往返目录扫描、gitignore/ignore 过滤 | `a214803` |
| 打包 | 安装包不内置服务。离线为 `release/QingCode-servers.zip`，在线为 `server-v*` Release；`bump-version.ps1` 同步 server 版本 | `a214803` |
| §9 状态机/界面 | 事件 `ssh-server-state` 与命令 `ssh_server_info` / `ssh_server_restart` / `ssh_server_logs`；状态栏芯片 `Server vX` / 「直连：原因」，可查看详情、重启、看日志 | `c6b8212` |
| §4.1 Windows serve | 安装包不内置二进制；Windows OpenSSH 可部署 serve 子集（目录扫描、内容搜索、文件树刷新） | `2a887b8` |
| §4.1 离线目录 | `ssh.server.offlineDir` 手动选择离线 `servers` 目录（校验含 `qingcode-server` 文件） | `65b43a8` |
| 改名与设置迁移 | qingcode-agent → qingcode-server 全面改名：设置键 `ssh.server.*`（读取兼容旧 `ssh.agent.*`，保存时迁移清理）、命令 `ssh_server_*`、事件 `ssh-server-state`、远端目录 `.qingcode/server/` 与 `$HOME/.qingcode/server/`、daemon 能力 `server.shutdown`、Release 标签 `server-v*` 与资产名、工作流 `server-release.yml`、脚本 `build-server.ps1` / `e2e-ssh-server/`、环境变量 `QINGCODE_SERVER_*`（旧名兼容）、本地目录 `servers/`（旧 `agents/` 与旧二进制名兼容读取）、离线包 `QingCode-servers.zip` | 本轮 |
| 部署加固 | 幂等部署（上传前比对远端 sha256，一致跳过）；上传后 `self-check --expect-sha256` 成功才启动；失败分类（网络类瞬时不占缓存，sha 不符/超体积/自检失败 permanent）；连续 2 次完整部署失败退避为不可用并提示 `AllowTcpForwarding`，重连解冻；切换 autoDownload / 离线目录清不可用缓存立即重试 | 本轮 |
| 停止、重启与日志 | 新命令 `ssh_server_stop`（serve 按状态文件 pid 结束 + daemon `server.shutdown`）；设置关闭总开关时对当前 SSH 工作区自动调用；「重启 Server」同时重建 serve 与 daemon；serve 输出重定向 `.qingcode/server/serve.log`（>1MB 启动前截断）；「查看 Server 日志」拼接 daemon 日志与项目 serve 日志两段（各 tail 200 行） | 本轮 |
| 信任与降级重试 | `ssh_server_restart` / `ssh_server_stop` / `ssh_server_logs` 要求工作区已信任；迟授予信任补启动文件树 watch 监督；daemon 传输降级后 5 分钟冷却重试（不再一次失败永久走 serve） | 本轮 |
| 其他修复 | token 改 OS 随机源生成（getrandom，此前 Windows 用时间 + pid）；scan `done.files_scanned` 真实计数；并发下载临时文件唯一命名 + 失败清理 + 按 manifest size 设上限；状态芯片错误态（`!`，不伪装直连）、重启成功 toast、日志对话框加载态与刷新按钮、设置导入后立即推送后端、保存/推送失败明确 toast | 本轮 |

本轮改动尚未提交，提交列为「本轮」。

### 未完成清单

**A. 终端持久化（设计最大收益点，M4）** — daemon 与 PTY 宿主（`qingcode-server/src/pty.rs`）已就绪，缺客户端：
1. `pty.create/attach/detach/input/resize/kill/list` 的前端接线：SSH 终端改为走 daemon PTY 而非独立 PTY 通道；
2. 断线接回：标签显示「重连中」（不是「已退出」）、重连后重下尺寸、`pty.attach` 补发或屏幕快照还原；
3. 应用重启后按持久化的标签 ID 接回；孤儿终端提示「远端还有 N 个终端在运行」并可接回/结束；
4. 有存活终端时升级服务：新旧 daemon 并存，旧终端标「旧版 Server」；
5. 同一连接的 PTY 数据、输入与 RPC 在同一条 exec 通道上多路复用（当前每方法一条通道）。

**B. 连接状态机与界面（§9/M2）**
6. `RemoteBackend` trait（`DirectBackend` / `ServerBackend`）分派。文件与 Git 仍走现有回退链，分派标签只体现在状态的 `transport`（daemon / serve / direct）；
7. ~~状态机 Disconnected → Authenticating → Probing → Installing → Handshaking → Ready(Server)/Ready(Direct)~~ 已落地。`Authenticating` 只在新建 SSH 会话握手时发出；已有会话从 `Probing` 或 `Ready(Direct)` 开始；
8. ~~事件 `ssh-server-state`（模式、版本、降级原因）与命令 `ssh_server_info` / `ssh_server_restart` / `ssh_server_logs`~~ 已落地；本轮起「查看 Server 日志」返回 daemon 日志与项目 serve 日志两段拼接（各 200 行），文件不存在时返回说明，不报错；
9. ~~状态栏芯片「Server vX」或「直连：原因」，点击可查看详情、重启 Server、查看日志~~ 已落地。查询失败时有独立 `!` 错误态。

**C. 能力域迁移（§7/M3 大头，文件 / Git / 格式化 / 传输目前仍走直连）**
10. `workspace.open` / `workspace.setTrust`：受信任的工作区注册 + 撤销信任后即时拒绝（写入、Git 修改类、运行任务、新建终端）；
11. `fs.*` 全套：`fs.read` 偏移读取（替 4MB 单片）、`fs.write{expectedMtime}` 一次往返的写冲突检测、`fs.detectEncoding`（只读前 8KB）、属性对话框（birth time、目录统计）、`fs.readStream` 大文件跳行；
12. `git.*` 走 server + 监视 `.git/index|HEAD|refs` 主动推送 `git-changed`（状态栏可不降频）、`git.statusLight` 轻量脏标记、上次 fetch/pull/push 时间不再为空；
13. `format.*`：Prettier/rustfmt/gofmt/shfmt/ruff-black 合并实现，本地与远端同一份（含 Python）；
14. `task.spawn`：Windows 远端支持 `ps1`/`bat`/`command`；
15. `transfer.*`：分块（1MB）+ 整体 sha256、按「临时文件 + 偏移」断点续传、小文件合并成 tar 流；
16. 文件名搜索走 `ignore` + glob（当前仍是远端 `find` 子串匹配）；
17. Markdown 远程相对图片：`ssh://` 路由到 `fs.read` 转 blob URL。

**D. 安装与版本管理（§4.2/§4.3）**
18. 共享版本化安装目录：`~/.qingcode/server/<version>-<build>/`（`$XDG_DATA_HOME`、`$XDG_RUNTIME_DIR` 兜底），多项目共用同一安装与清理策略。当前 daemon 已按远端用户 `flock` 单实例、可多工作区共用，但仍无版本化安装目录；serve 仍是每项目 `.qingcode/server/` 目录各部署一份；
19. ~~上传前校验 + `self-check` 比对 manifest，任一不符才重装~~ 已按 sha256 幂等实现：上传前比对远端已存在二进制 sha256（一致跳过上传），上传后 `self-check --expect-sha256` 成功才启动。stat 属性校验（属主/权限 ≤0700/mtime）未做，sha 一致即视为有效；
20. 清理策略：删除未使用且非最近两个版本的安装目录；
21. 版本共存：有存活终端时新旧 daemon 并存（依赖 A-5）；
22. `PROTOCOL_VERSION` 向后兼容策略与 capabilities 分流（当前只声明 [1,1]）；
23. zstd 压缩 + 目标清单管理（当前是裸二进制；不内置安装包、按需下载/离线包分发，安装包体积不受影响）；armv7 / macOS 目标未提供（Windows serve 目标已提供）。

**E. 平台（§6.4）**
24. Windows daemon：命名管道 + DACL、命名 mutex、ConPTY Job Object 脱离（或 `schtasks` 兜底），失败则关闭 `pty.persist`；macOS：`setsid` + FSEvents 验证；
25. systemd `KillUserProcesses=yes` 探测与 `systemd-run --user --scope` 托管 + `loginctl enable-linger` 提示。

**F. `qingcode-core` 抽取（M0）**
26. 把 `content_search`、`file_encoding`/`exclude`、`git_status`/`git_command`、`format`、`path_guard`、`git`、`file_watcher`、`terminal` 与 Tauri 解耦为共用 crate，使本地与远端语义天然一致。

**G. 设置（§10）**
27. `remote.server.mode`（auto/always/never 及连接级覆盖）、`remote.server.installDir`、`remote.server.detachedTerminalTtl`、`remote.server.terminalScrollbackBytes`、`remote.server.watch`（当前有 `ssh.server.enabled`、`ssh.server.autoDownload`，以及手动离线目录 `ssh.server.offlineDir`；旧 `ssh.agent.*` 读取兼容、保存时迁移清理）。

### 已知问题与瑕疵

- Windows 全量的 `clipboard_files::tests::reads_png_clipboard_as_stable_temp_file` 会因沙箱拒绝 `OpenClipboard` 失败。这是环境限制，不是断言错误。
- watch 建立的前 500ms 会丢弃事件（用来滤掉 notify 注册期的枚举噪声），该窗口内的真实修改同样丢失。
- 内容搜索遇到单行 >2MB 的文件会截断并停止整次搜索（与直连 rg 路径行为一致，minified 产物后的文件命中会漏）。
- 关闭 `ssh.server.enabled` 会停止当前激活 SSH 工作区的远端服务，其他已连接 SSH 工作区的远端进程不会被逐一停止；重新开启需重连项目才恢复自动刷新。
- 远端保存文件仍会触发一次 `fs-change`（未做本地那样的自写抑制）。
- daemon 按 `flock` 每远端用户单实例，多工作区共用同一 daemon；每项目各自隔离的是 serve 进程。共享版本化安装目录与跨项目清理见未完成项 18。

### 真机验收

- 目标主机 AlmaLinux 10.2 x86_64（SELinux Enforcing、**未安装 rg**）：`serve` 子集 56/56 断言通过（含符号链接逃逸双向拦截、3MB 单行截断、断会话存活、单实例 rc=3、状态文件 0600）；`daemon` 协议冒烟 15/15 通过（HELLO 协商、`fs.scan`、绝对路径拒绝、`pty.create/input` 实时回显、**SIGKILL 代理后 daemon 存活并重连补发历史输出**、`server.shutdown` 零残留）。本轮改名与部署加固另附 Rust / 前端单测（部署退避、下载临时文件命名、`files_scanned` 计数、旧设置键迁移等）。
- 脚本：`scripts/e2e-ssh-server/`（`run.sh` + `client.py` + `daemon_smoke.py` + README），凭据一律走环境变量，仓库内无密码/主机。
- 未做：Windows / macOS / Alpine / arm64 主机验收；CI 上 `server-release.yml` 的首次实跑。
