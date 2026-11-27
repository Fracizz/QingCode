# QingCode Next — Windows MVP 设计

> 状态：定稿 v1（2026-11-25）。旧项目 `D:\code\qingcode`（Tauri + Rust）只作参考与备份，本仓库从零开始，纯 TypeScript。

## 1. MVP 范围

做：

1. **远程连接**：SSH 连接 Linux 或 Windows 主机（密码 / 私钥文件 / ssh-agent），首次连接确认主机指纹、指纹变化拒绝；自动部署并拉起远端常驻 server（参考 qingcode 的 `qingcode-server`：SSH exec 里跑 `connect --stdio` 代理，daemon 常驻，断线不丢会话）。
2. **Codex 对话式**：本机与远端都能用。server 拉起 `codex app-server`（JSON-RPC over stdio），客户端经 server 中继：会话列表、新建/继续会话、流式消息、推理摘要、命令执行与文件改动展示、审批（允许/拒绝）、中断。
3. **项目**：每个目标（本机 / SSH 连接）下保存若干项目目录，Codex 会话按项目目录（cwd）组织。
4. **导入旧版 QingCode 数据**：远程连接（含主机指纹）、项目（本机与 SSH），可选导入已保存的 SSH 密码/口令（§8）。
5. **首期手机版（Android）**：手机经电脑中转使用 Codex 对话；电脑"复制连接信息"，手机粘贴导入并配对，导入时与导入后都可编辑地址/端口（支持 frp 等端口转发场景）（§9）。
6. **Codex 额度显示**（参考 Orca）：每个目标显示其 codex 账号的 5 小时 / 每周用量百分比与重置时间，电脑端与手机端都有（§10）。
7. **Claude Code 适配**：与 Codex 并列的第二个 Agent，同一套对话界面（§11）。验收机 10.87（Windows，Claude Code 2.1.331 已登录，作为"本机"目标）。
8. **对话交互参考 Codex 桌面版**：选中文字浮出"添加到对话 / 在侧边聊天中提问"、行内评论、输入框注释条、消息操作（§12）。
9. Windows x64 安装包（electron-builder NSIS）+ Android APK。

不做（MVP 之后）：终端、文件树/编辑器、Git、手机端终端/文件、扫码配对、Claude/pi 适配、自动更新、多窗口。

验收主机：93（`192.168.10.93`，root，已装 Node v26、codex-cli 0.172.0 并已登录）。

## 2. 进程与目录

```
apps/desktop（Electron 45）
 ├─ main        窗口、原生对话框、safeStorage、拉起 backend；不做业务
 ├─ preload     contextBridge：把 backend 的 MessagePort 交给渲染进程 + dialog
 ├─ backend     utilityProcess（Node）：SSH（ssh2）、部署、本机 daemon、server 客户端、连接/指纹存储
 └─ renderer    React 19 + Tailwind 4 + zustand：连接管理、Codex 对话 UI
packages/protocol      帧编解码 + 消息类型（server 与 backend 共用）
packages/server        远端/本机常驻 server（Node 单文件，esbuild 打包为 qn-server.cjs）
packages/codex-client  codex app-server JSON-RPC 客户端 + 对话状态 reducer（渲染进程用）
vendor/codex-protocol  `codex app-server generate-ts / generate-json-schema` 生成物（codex 0.172.0），只读
```

数据流：

```
renderer ──MessagePort(JSON)──▶ backend ──┬─ 本机：命名管道 \\.\pipe\qingcode-next-<user> ──▶ 本机 daemon ──stdio──▶ codex app-server
                                          ├─ 远端（SSH）：ssh2 streamlocal 转发到 daemon 的 unix socket；被拒/Windows 时退回 exec `node qn-server.cjs connect --stdio` ──▶ 远端 daemon
                                          └─ 远端（直连，可选）：TLS（证书指纹固定）──▶ 远端 daemon 内置直连监听（默认 47390）
```

传输分层（参考 Orca）：SSH 负责安装、启动、修复，以及直连不可用时的数据通道；daemon 是唯一状态中心，三种传输都只搬字节，鉴权在 daemon 的 `hello` 里统一完成（本机 IPC 用主 token，直连用每客户端可撤销授权，见 §3.4）。

本机与远端跑**同一份** `qn-server.cjs`：本机用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`）以 detached 方式拉起 daemon，backend 直接连命名管道；远端用远端 `node`（要求 ≥ 18）。

## 3. Server（packages/server）

### 3.1 命令行

| 命令 | 作用 |
|---|---|
| `node qn-server.cjs version` | 输出 `{"version":"<ver>","protocol":1}` |
| `node qn-server.cjs ensure [--state-dir D] [--replace]` | daemon 不在则 detached 拉起并等就绪（≤10s）；输出 `{"token","version","pid","started":bool,"endpoint"}`（endpoint 为本地 IPC 地址）。`--replace`：已运行版本不同且无进行中的 turn 时让旧 daemon 退出后重启 |
| `node qn-server.cjs daemon [--state-dir D]` | 常驻进程（一般由 ensure 拉起） |
| `node qn-server.cjs connect --stdio [--state-dir D]` | 把 stdin/stdout 与 daemon 的本地 IPC 双向对接，**不解析帧**；任一端 EOF 即退出 |
| `node qn-server.cjs direct enable --listen [host:]port [--allow-public]` | 写 `<stateDir>/direct/config.json` 并让 daemon 重读（`direct.reload`）开始 TLS 监听；输出直连状态 |
| `node qn-server.cjs direct disable` | 删除配置，daemon 停止监听并断开所有直连会话 |
| `node qn-server.cjs direct grant [--name N] [--host H]...` | 新建一个客户端授权，输出 `{grantId, code, fingerprint, hosts, port}`；`code` 为连接码 `qn-direct:` + base64url(JSON `{v,hosts,port,token,fingerprint,name}`)，含明文 token，只写 stdout |
| `node qn-server.cjs direct revoke --id ID` | 撤销授权，daemon 立即断开使用该授权的会话 |
| `node qn-server.cjs direct status` | 输出 `{enabled, listening, listen, allowPublic, fingerprint, grants:[{id,name,createdAt}], error?}` |
| `node qn-server.cjs serve --listen [host:]port [--name N] [--host H]...` | 兼容旧用法：= `direct enable` + `direct grant`，连接码另写 `<stateDir>/direct-code.txt`（0600），随后退出（监听由 daemon 常驻） |

### 3.2 运行目录

- 默认 state dir：POSIX `~/.qingcode-next/server`，Windows `%LOCALAPPDATA%\qingcode-next\server`。
- `run/`（POSIX 权限 0700）：`daemon.sock`（POSIX）/ 命名管道 `\\.\pipe\qingcode-next-<username>`（Windows）、`token`（0600，32 字节随机 hex）、`daemon.json`（`{pid,version,startedAt}`）、`daemon.log`（>5MB 滚动 1 份）。
- 单实例：监听 socket 时 `EADDRINUSE` → 尝试连接；连得上说明已有实例，本进程退出 0；连不上（陈旧 socket）则删除后重试。
- 退出：无客户端连接、无进行中的 turn 且持续 30 分钟 → 退出。**客户端断开不影响进行中的 turn**。

### 3.3 Codex 中继

- daemon 内最多一个 `codex app-server` 子进程（懒启动，`codex.open` 触发）。解析顺序：参数 `codexPath` → `PATH` 中的 `codex` → `~/.local/bin/codex`、`/usr/local/bin/codex`、`~/.npm-global/bin/codex`；Windows 处理 `codex.cmd`/`codex.exe`。
- daemon 自己完成 `initialize`（clientInfo `{name:"qingcode-next",version}`）与 `initialized` 通知，缓存 InitializeResponse；**客户端不得再发 initialize**。
- 客户端发来的 JSON-RPC 请求：daemon 换成自己的 id 转发，响应按原 id 回给发起的客户端。
- codex 发来的通知与 server→client 请求：分配递增 `seq`，存入环形缓冲（最多 20000 条或 32MB），并广播给所有已 attach 的客户端。
- server→client 请求（审批等）：广播给所有客户端，**第一个响应生效**并转给 codex；未决请求在新客户端 attach 时随回放下发。codex 本身会发 `serverRequest/resolved` 通知，客户端据此关闭卡片。
- codex 进程退出：广播 `evt codex.exited {code,signal}`，未完成的转发请求全部以错误响应；下次 `codex.open` 重启。

### 3.4 直连（daemon 内置，可选）

- 只有 `direct/config.json` 存在时监听；监听中 daemon **不空闲退出**（它就是对外服务）。证书：EC P-256 自签，10 年，存 `<stateDir>/tls/{cert,key}.pem`，指纹 = 证书 DER 的 SHA-256；删除 `tls/` 即轮换（所有客户端需重新开启/导入）。
- 授权：`direct/grants.json` 只存 token 的 SHA-256（`{id,name,tokenSha256,createdAt}`），比较用常数时间；daemon 主 token **不能**用于直连。
- 来源检查在 TCP accept 阶段：默认只接受 loopback、私网（10/8、172.16/12、192.168/16、fc00::/7）、链路本地与 100.64/10（Tailscale），公网来源直接断开，`--allow-public` 放开；frp/SSH 转发进来的连接在服务端是 127.0.0.1。
- 鉴权失败按来源 IP 计数，连续 5 次锁 60 秒；未完成 `hello` 的直连 10 秒后断开。
- 直连会话禁止调用管理方法（`server.shutdown`、`direct.reload`、`direct.status`），返回 `forbidden`。

## 4. 协议（packages/protocol，protocol = 1）

**帧**：4 字节大端 uint32 长度 N + N 字节 UTF-8 JSON；N ≤ 16 MiB，超限视为协议错误并断开。

**消息**（JSON 对象，`t` 区分类型）：

| t | 方向 | 字段 |
|---|---|---|
| `hello` | C→S | `protocol:1, token, client:{name,version}`；必须是第一帧 |
| `welcome` | S→C | `protocol:1, serverVersion, pid` |
| `req` | C→S | `id:number, method, params?` |
| `res` | S→C | `id, ok:true, result` 或 `id, ok:false, error:{code,message}` |
| `evt` | S→C | `name, payload` |
| `codex.send` | C→S | `msg`（原始 JSON-RPC：请求 / 通知 / 对 server 请求的响应） |
| `codex.recv` | S→C | `seq:number \| null, msg`（原始 JSON-RPC；对客户端请求的响应 seq 为 null） |
| `error` | S→C | `code, message`；随后断开（如 token 错误 `auth`、协议版本不符 `protocol`） |

**req 方法**：

| method | params | result |
|---|---|---|
| `ping` | — | `{serverVersion, protocol}` |
| `fs.home` | — | `{path}` |
| `fs.list` | `{path, dirsOnly?}` | `{path, entries:[{name, kind:"dir"\|"file"\|"symlink"}]}`（按名称排序，最多 2000 条） |
| `codex.open` | `{codexPath?}` | `{initialize: InitializeResponse, lastSeq, codexVersion?}` |
| `codex.attach` | `{sinceSeq}` | 先把 `seq > sinceSeq` 的缓冲消息以 `codex.recv` 依次下发，再返回 `{lastSeq, truncated}`（`truncated` 表示缓冲已丢弃部分旧消息，客户端应用 `thread/read` 重新拉取） |
| `codex.status` | — | `{running, pid?, activeTurns}` |
| `server.shutdown` | — | `{}`（仅供 `ensure --replace` 用） |

## 5. Backend（apps/desktop/src/backend）

渲染进程经 MessagePort 与 backend 通信，消息格式同样是 `req`/`res`/`evt` 三种 JSON（无长度前缀）。

**req 方法**：

| method | params | result / 说明 |
|---|---|---|
| `targets.list` | — | `Target[]`；`{id:"local", kind:"local", name:"本机"}` 永远在首位 |
| `targets.save` | `SshTargetInput`（`id?, name, host, port, username, auth:{kind:"password"}\|{kind:"key",keyPath}\|{kind:"agent"}`） | 保存到 `userData/targets.json`（不含密码） |
| `targets.remove` | `{id}` | — |
| `target.connect` | `{id, password?, passphrase?, remember?}` | 连接 + 部署 + 握手；进度经 `evt target.state` 推送。未传密码/口令时使用已保存的凭据；`remember:true` 且认证成功后加密保存 |
| `target.test` | `SshTargetInput` + `{password?, passphrase?}` | 试连：认证 + 主机指纹 + 远端环境探测，不保存、不部署；返回 `{os, nodeVersion}`。带 `id` 时未传的凭据取已保存的。连接表单的"测试连接"与"保存"都走它 |
| `target.forgetSecret` | `{id}` | 删除已保存的密码/口令 |
| `projects.list` | `{targetId?}` | `Project[]`：`{id, targetId, name, path, lastOpenedAt}`，按 lastOpenedAt 降序 |
| `projects.save` | `{id?, targetId, name?, path}` | 新增或更新（同 targetId+path 去重，name 缺省取目录名）；打开项目时也调用以刷新 lastOpenedAt |
| `projects.remove` | `{id}` | — |
| `legacy.detect` | `{path?}` | `{found, path, counts:{connections, localProjects, sshProjects, secrets}}`；默认路径 `%APPDATA%\com.qingcode.app\qingcode.db` |
| `legacy.import` | `{path?, includeSecrets}` | `{imported:{targets, projects, hostKeys, secrets}, skipped:[{kind, name, reason}]}`；幂等，重复导入跳过已导入项 |
| `target.disconnect` | `{id}` | 只断开 SSH，不停远端 daemon |
| `hostKey.respond` | `{promptId, accept}` | 回应 `evt hostKey.prompt` |
| `server.req` | `{targetId, method, params}` | 透传 §4 的 req |
| `codex.send` | `{targetId, msg}` | 透传 |

**evt**：`target.state {id, state:"idle"|"connecting"|"deploying"|"ready"|"error", detail?}`、`hostKey.prompt {promptId, host, port, fingerprint, kind:"new"|"changed", previous?}`、`codex.recv {targetId, seq, msg}`、`server.evt {targetId, name, payload}`。

**主机指纹**：SHA256（base64，同 OpenSSH 显示格式）存 `userData/known_hosts.json`（键 `host:port`）。新主机 → 弹确认；变化 → 弹红色警告，默认拒绝，用户明确确认才替换。

**部署**（POSIX 远端）：

1. 一次 exec 探测：`uname -s`、`$HOME`、`command -v node`、`node -v`；node 缺失或 < 18 → 报错"远端需要 Node ≥ 18"。
2. 目标路径 `~/.qingcode-next/server/bin/<version>-<sha256 前 12 位>/qn-server.cjs`；`sha256sum` 校验，不符或缺失 → SFTP 上传到 `.tmp` 再 `mv`，权限 0600。
3. exec `node <path> ensure --replace` 取 token。
4. 先用 OpenSSH streamlocal 转发（`direct-streamlocal@openssh.com`）连 ensure 返回的 unix socket；sshd 拒绝转发时开 exec 通道 `node <path> connect --stdio`。发 `hello`，收 `welcome` 即 ready。
   - 远端无 Node 或 < 18 时：若 `resources/node-runtime/manifest.json` 有对应平台（`linux-x64` 等）的内置 Node，经 SFTP 推送到 `~/.qingcode-next/runtimes/node-<sha256 前 16 位>/bin/node`（sha256 校验 + `-e 0` 自检，识别 noexec），之后命令都用它；没有则报"远端需要 Node ≥ 18"。

**直连加速（SSH 目标可选）**：`target.enableDirect {id, listen?, host?, allowPublic?}` 经 SSH 执行 `direct enable` + `direct grant --name "QingCode Next @ <本机名>" --host <拨号地址>`，把 `{host, port, fingerprint, grantId}` 写入目标的 `direct` 字段、token 存 secrets（`directToken`）。之后连接该目标先试 TLS 直连（5 秒超时），失败（含指纹不符）回退 SSH，状态说明里写原因。`target.disableDirect {id}` 经 SSH 撤销本机授权并清除配置（不关远端监听）。独立的直连目标（`kind:'direct'`，粘贴连接码导入）用于没有 SSH 权限的场景。
5. 断线自动重连（指数退避 1s→30s），重连后 `codex.attach {sinceSeq: lastSeq}`。

**部署（Windows 远端）**：POSIX 探测无输出（cmd / PowerShell）或 `uname` 为 `MINGW*` 时改走此分支，流程同上，差异：

- 默认 shell 不确定，文件操作用 `node -e` 执行 base64url 脚本；`node` 须在 SSH 会话的 `PATH` 中（≥ 18）。
- SFTP 路径写作 `/C:/...`；state dir 为 `%LOCALAPPDATA%\qingcode-next\server`。
- sshd 会话结束会结束其子进程：`ensure` 在 SSH 会话内经 WMI（`Win32_Process.Create`）拉起 daemon，WMI 不可用时退回普通拉起（断开后 daemon 不常驻）。

**本机**：`ELECTRON_RUN_AS_NODE=1 <electron.exe> <resources>/server/qn-server.cjs ensure` 后连命名管道。

**凭据**：密码/口令用 Electron `safeStorage`（Windows 下即 DPAPI）加密后存 `userData/secrets.json`（`{[targetId]: base64}`）。`safeStorage` 只在主进程可用，backend 经 `process.parentPort` 向 main 请求 `secret.encrypt` / `secret.decrypt`（main 只做加解密，不做业务）。

## 6. 渲染进程 UI

- 深色主题，左侧：目标列表（本机 + SSH 连接，状态点）、添加/编辑连接表单、底部"导入旧版 QingCode"入口；中间：当前目标的项目列表（`projects.list`，"添加项目"用 `fs.list` 浏览选目录）、选中项目下的会话列表（`thread/list` 按 cwd）、新建会话；右侧主区：对话。
- 首次启动且无 SSH 连接时，若 `legacy.detect` 发现旧数据，顶部显示一次性横幅提示导入。导入对话框：显示来源路径（可另选 .db 文件）、预览数量、"同时导入已保存的密码"复选框（默认不勾选）、结果摘要。
- 对话：用户消息、Agent 消息（Markdown 流式）、推理摘要（折叠）、命令执行（命令 + 输出折叠 + 退出码）、文件改动（路径 + diff）、审批卡片（允许 / 本会话允许 / 拒绝）、turn 状态与中断按钮、输入框（Enter 发送，Shift+Enter 换行）。
- 不做模型切换等设置，沿用远端 `~/.codex/config.toml`。

## 7. 质量门槛

- `pnpm check`（各包 `tsc` + vitest）必须通过。
- 纯逻辑（帧编解码、id 映射、环形缓冲、reducer、指纹比较）必须有单测。
- server 有一个端到端测试：用假的 `codex app-server`（Node 脚本，回放固定 JSON-RPC）跑 daemon + connect 全链路。
- 安全：`contextIsolation`、`sandbox`、`nodeIntegration:false`；外链走 `shell.openExternal`；不在日志里打 token/密码。

## 8. 导入旧版 QingCode

来源：`%APPDATA%\com.qingcode.app\qingcode.db`（旧版发布版 SQLite；开发版在旧仓库 `.dev/`），用户也可另选文件。旧版可能正在运行（WAL），先把 `qingcode.db`、`-wal`、`-shm` 复制到临时目录再**只读**打开；用 Node 内置 `node:sqlite`（Electron 45 不可用时报告总管，改用其他方案）。

| 旧表/文件 | 字段 | 导入为 |
|---|---|---|
| `ssh_connections` | `id, name, host, port, username, auth_kind('password'\|'privateKey'\|其他), private_key_path, host_key_fingerprint('SHA256:…')` | SSH 目标：id 用 `legacy-<旧 id>`（幂等键）；`privateKey`→`{kind:'key', keyPath}`，`password`→`{kind:'password'}`，其他→`agent`；指纹写入 `known_hosts.json`（仅当格式为 `SHA256:` 开头）。跳过 Server 直连条目（`username='Agent'` 且指纹为 64 位十六进制，或 `mode` 列为 `direct`/`agent`），记入 skipped；`mode='server'`（SSH + 远端 server）与 `'ssh'` 都正常导入 |
| `projects`（`kind='local'`） | `name, path, last_opened_at, hidden` | 本机目标的项目；`hidden=1` 也导入 |
| `projects`（`kind!='local'`） | `name, connection_id, root_path, last_opened_at` | 对应 `legacy-<connection_id>` 目标的项目（path=root_path）；连接不存在则跳过 |
| `ssh-secrets.json`（与 db 同目录） | `{[连接 id]: base64 密文}`；Windows DPAPI，entropy 为 ASCII `qingcode-ssh-secret-v1`；明文是 JSON `{password?, passphrase?}` | 仅在 `includeSecrets` 时导入：backend 用 PowerShell `[System.Security.Cryptography.ProtectedData]::Unprotect(bytes, entropy, 'CurrentUser')` 解密（经 stdin 传密文、stdout 读明文，不落临时文件、不进日志），再经 main `safeStorage` 加密存入 `secrets.json` |

时间戳：旧库为毫秒或秒（导入时按数值大小判断），统一存毫秒。

## 9. 首期手机版（Android）

### 9.1 形态

- 手机**只连电脑**（不直连 SSH 主机）：电脑 backend 内置"手机网关"，把目标、项目、Codex 对话转发给手机。电脑需保持运行。
- 手机 App = 原生壳（Java，无 Gradle 构建，参考旧项目 `D:\code\qingcode\mobile\android` 与 `scripts/build-android.ps1`）+ WebView 加载内置的 Web 界面（`apps/mobile/web`，Vite + React，复用 `@qn/codex-client`）。
- 网络请求全部由原生层发出（WebView 无法对自签名证书做指纹固定）：JS 经 `window.QnNative` 桥调用。

### 9.2 手机网关（电脑 backend）

- 设置（`userData/mobile/settings.json`）：`enabled`、`port`（默认 38500）、配对密码（6–20 位，区分大小写，经 safeStorage 加密保存）、`publicAddresses`（用户手动添加的对外地址，如 frp `frp.example.com:7001`）。
- 监听 `0.0.0.0:<port>` HTTPS；自签名证书（RSA 2048 / ECDSA P-256，有效期 10 年）存 `userData/mobile/{cert,key}.pem`，**证书指纹** = 证书 DER 的 SHA-256（64 位小写十六进制）。证书只在用户点"重新生成"时更换。
- 配对：`POST /pair {code, deviceName}` → `{token, desktopName}`；token 32 字节随机，只存 SHA-256；错误密码按来源 IP 计数，连续 5 次锁 60 秒。已配对设备列表可在电脑端撤销。
- 调用：`POST /rpc {method, params}`，头 `Authorization: Bearer <token>`；只放行白名单：`targets.list`、`target.connect`、`target.disconnect`、`projects.list`、`projects.save`、`server.req`（仅 `ping`/`fs.home`/`fs.list`/`codex.open`/`codex.attach`/`codex.status`）、`codex.send`。`hostKey.prompt` 只在电脑上处理（手机连接一个新主机时提示"请在电脑上确认指纹"）。
- 事件：`GET /events` 返回 NDJSON 流（`{name, payload}` 每行一条，含 `target.state`、`codex.recv`、`server.evt`；每 20 秒一行 `{"name":"ping"}` 心跳）。断开后手机重连并对已打开的目标 `codex.attach{sinceSeq}`。
- `GET /probe`（无需认证）→ `{name, version}`，手机借此读取证书指纹并核对。

### 9.3 复制连接信息 → 手机导入

- 电脑端"手机连接"设置页：开关、端口、密码、对外地址列表（可增删）、本机局域网地址（自动列出 IPv4）、已配对设备；"复制连接信息"时先选地址（局域网地址或对外地址）。
- 复制内容：

  ```
  QingCode Next 手机连接
  电脑：<电脑名>
  地址：<host>:<port>
  在 QingCode Next 手机版「添加连接」中粘贴即可导入：
  qingcode-next://pair?v=1&host=<host>&port=<port>&fp=<指纹>&name=<电脑名>&code=<密码>
  ```

  手机从任意文本中提取 `qingcode-next://pair?...` 链接（经聊天软件转发多出的文字不影响）。
- **导入后可编辑**：粘贴后先显示可编辑表单（名称、主机、端口、密码，指纹只读），"测试连接"核对指纹 → 配对 → 保存。已保存连接随时可改名称/主机/端口，**不需要重新配对**（token 与指纹不变）。
- **frp 场景**：frp 是 TCP 转发，TLS 端到端不变，指纹固定照常有效；主机允许 IPv4、IPv6、域名；端口可以与电脑监听端口不同。指纹不一致时拒绝连接并提示"地址指向了另一台电脑或证书已重新生成，请从电脑重新复制连接信息"。

### 9.4 手机界面（首期）

连接列表（添加/编辑/删除，状态）→ 电脑的目标列表（本机 + SSH，状态，连接按钮；密码认证的目标若电脑未保存密码则在手机输入）→ 项目列表 → 会话列表 → 对话（流式消息、推理摘要、命令/文件改动折叠展示、审批、中断、输入框）。深色主题，适配手机竖屏与安全区。

## 10. Codex 额度显示

- 额度属于"目标上的 codex 账号"：本机和每台 SSH 主机可能登录不同账号，按目标分别显示。
- 数据：`codex.open` 后调用 `account/rateLimits/read`（`GetAccountRateLimitsResponse`），并合并 `account/rateLimits/updated` 稀疏更新（只覆盖非 null 字段）；`account/read` 取账号邮箱/套餐。界面可见时每 60 秒刷新一次，turn 完成后也刷新。
- 展示：`rateLimits`（或 `rateLimitsByLimitId.codex`）的 `primary` / `secondary` 窗口 → 按 `windowDurationMins` 命名（300→"5 小时"，10080→"每周"，其他→"N 小时/天"），显示 `usedPercent`、重置时间（`resetsAt` 秒级时间戳 → 本地时间 + 倒计时）。≥80% 琥珀色、≥95% 或 `rateLimitReachedType` 非空红色；`credits` 有余额时显示。
- 电脑端：对话区顶部/状态栏紧凑徽标"5h 32% · 周 12%"，点击展开详情（套餐、账号、各窗口进度条、重置时间、最后更新时间、刷新按钮）。目标列表行内显示最紧张的一个百分比。
- 手机端：电脑首页的目标卡片显示紧凑额度，对话页顶部可展开详情。
- 纯逻辑（合并、窗口命名、阈值、倒计时格式化）放 `packages/codex-client/src/rateLimits.ts`，两端共用并单测。

## 12. 对话交互（参考 Codex 桌面版）

- **选中文字浮层**：在任意消息（Agent 消息、用户消息、命令输出）里选中文字，松开鼠标后在选区上方浮出小工具条：「添加到对话」「在侧边聊天中提问」。点击空白或 Esc 关闭。
- **添加到对话**：选区原位高亮，工具条变成单行输入框「添加可选评论…」+ ✓ 按钮（Enter 确认，Esc 取消，评论可空）。确认后在输入框上方出现注释条「💬 N 条注释」，可展开查看/删除每条（引用文字 + 评论）。发送下一条消息时，注释按以下格式拼到用户消息前面，然后清空：

  ```
  > <引用文字，多行逐行加 "> ">
  <评论（可空）>

  <用户输入>
  ```
- **在侧边聊天中提问**：右侧滑出侧边栏，开一个临时会话（Codex `thread/start {ephemeral:true}`；Claude 用不持久化的新会话），同一目标与 cwd，输入框预填引用文字，侧边栏可关闭；侧边会话不进入会话列表。
- **消息操作**：每条 Agent 回复下方一行小图标：复制（复制 Markdown 原文）、「…」菜单（复制为纯文本、从这里开始新会话[MVP 可只做前两项]）。
- **输入框**：圆角大输入框，占位符「和 Codex 一起工作」/「和 Claude 一起工作」；左下角 Agent 标识，右下角发送/中断按钮；Enter 发送、Shift+Enter 换行、IME 组合时 Enter 不发送。
- **链接**：Markdown 链接用强调色，点击走系统浏览器；`{}` 等结构化回执类内容按普通链接/代码块显示即可。
- 手机端只做「添加到对话」（长按选择后的系统菜单不可替换时，用页面内"引用"按钮代替），侧边聊天不做。

## 11. Claude Code 适配

### 11.1 原则

- **与 Codex 走同一条链路、同一套界面**：server 内新增"Claude 桥"，把 Claude Agent SDK 的会话**翻译成 codex app-server v2 的 JSON-RPC 形状**（thread / turn / item 通知、审批 server request），客户端继续用 `@qn/codex-client` 的 RPC 与 reducer，界面零分叉。
- Claude 桥运行在目标上的 qn-server（Node）里：本机与 SSH 远端都可用。SDK（`@anthropic-ai/claude-agent-sdk@0.3.332`，固定版本）的 JS 由 esbuild 打进 `qn-server.cjs`；**不打包** SDK 自带的原生二进制，始终通过 `pathToClaudeCodeExecutable` 使用目标机已安装并登录的 `claude`（解析顺序：参数 `claudePath` → PATH 中 `claude`/`claude.exe` → `~/.local/bin/claude(.exe)`；Windows 优先 `.exe`，不用 `.cmd`）。
- 验收：10.87（Windows，`C:\Users\91295\.local\bin\claude.exe`，Claude Code 2.1.331，已登录），以"本机"目标运行 QingCode Next。

### 11.2 协议扩展（向后兼容）

- `codex.open` / `codex.attach` / `codex.status` 的 params 增加可选 `agent: 'codex' | 'claude'`（默认 `codex`）；`codex.send` 与 `codex.recv` 增加可选 `agent` 字段。每个 agent 各自一套 seq / 回放缓冲 / 未决请求。
- backend：`codex.send {targetId, agent?, msg}`，事件 `codex.recv {targetId, agent, seq, msg}`；手机网关透传。

### 11.3 映射

| Codex v2 | Claude 桥实现 |
|---|---|
| `initialize`（server 内部） | 返回 `{userAgent:"claude-bridge/<claude 版本>"}` |
| `thread/list {cwd}` | SDK `listSessions({dir: cwd})` → `{data:[{id, preview: summary/firstPrompt, updatedAt: lastModified/1000, createdAt, cwd, name: customTitle}]}`（字段名按 vendor `Thread` 类型补齐必填项） |
| `thread/start {cwd, ephemeral?}` | 预先生成 UUID 作为 sessionId（SDK `sessionId` 选项），返回 thread；`ephemeral` → `persistSession:false`；真正的 query 在首个 `turn/start` 时创建 |
| `thread/resume` / `thread/read {threadId}` | `getSessionMessages(sessionId, {dir})` → 按用户消息切分 turns，转换为 items（同下表） |
| `turn/start {threadId, input}` | 会话无活动 query 时创建：`query({prompt: AsyncIterable<SDKUserMessage>, options:{cwd, resume|sessionId, includePartialMessages:true, permissionMode:'default', canUseTool, pathToClaudeCodeExecutable, env:{...process.env}, stderr}})`，之后每轮把用户消息推入同一个异步队列；返回 `{turn:{id, status:'inProgress'}}` 并发 `turn/started` |
| `turn/interrupt` | `query.interrupt()`；该轮以 `result.subtype=error_during_execution` 结束 → `turn/completed {status:'interrupted'}`；循环需 try/catch 后继续 |
| `stream_event` 文本增量 | `item/agentMessage/delta`；thinking 增量 → `item/reasoning/summaryTextDelta` |
| assistant 内容块 text / thinking | `item/started` + `item/completed`（`agentMessage` / `reasoning`） |
| assistant `tool_use` | Bash → `commandExecution {command, cwd}`；Edit/MultiEdit/Write/NotebookEdit → `fileChange {changes:[{path, kind, diff}]}`（diff 由 input 生成统一 diff 文本）；其他工具 → `dynamicToolCall`/`mcpToolCall` 等最接近的 v2 item 类型，至少带工具名与参数摘要 |
| user `tool_result` | 对应 item 的 `item/completed`（输出、退出状态、`is_error`→failed） |
| `result` | `turn/completed {status: success→completed, 中断→interrupted, 其他→failed + error}`；`thread/tokenUsage/updated`（usage + `total_cost_usd` 估算） |
| `canUseTool` | server request：Bash → `item/commandExecution/requestApproval`；编辑类 → `item/fileChange/requestApproval`；其他 → `item/commandExecution/requestApproval`（command 写 `工具名 参数摘要`）。响应：accept → allow；acceptForSession → allow + `updatedPermissions` = suggestions（destination 改为 `session`）；decline → deny（message "用户拒绝"）；cancel → deny + `interrupt:true` |
| `rate_limit_event` | `account/rateLimits/updated`（`primary.usedPercent = utilization×100`、`resetsAt`），并标注"Claude 只在接近/触发限额时上报"；`account/rateLimits/read` 返回最近一次缓存（无则全 null） |

- 会话 id 即 Claude sessionId；daemon 内存里维护 `sessionId → {query, 输入队列, 当前 turnId, items}`，空闲 30 分钟关闭 query（`close()`），下次 `turn/start` 用 `resume` 重新创建。
- 不支持的 v2 方法返回 JSON-RPC 错误 `-32601`。

### 11.4 界面

- 新建会话时选择 Agent（Codex / Claude，按目标上实际可用的显示；不可用的置灰并提示原因，如"未找到 claude"）。会话列表合并两种来源，行内显示 Agent 图标；占位符随 Agent 变化。
- 额度：Claude 显示最近一次限额事件（状态、利用率、重置时间）与本会话累计费用估算（标注"估算"）。
