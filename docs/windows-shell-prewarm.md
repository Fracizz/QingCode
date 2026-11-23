# Shell 预热

空闲普通终端的数量按位置分开设置：本机在「设置 → 终端 → **本机 Shell 预热数量**」（仅 Windows），每条远程连接在「远程连接 → 终端 → **普通 Shell 预热数量**」，互不影响。

- **本机 Windows 项目**：仅 Windows 客户端，需开启“本地终端可接回”；关闭后预热随之停止。不预热 WSL。
- **SSH Server 模式项目**：任意客户端，远端 Windows 与 Linux / macOS 均可，要求 Server 模式（远端 daemon 托管终端），不依赖“本地终端可接回”。
  Windows 远端预热 PowerShell / CMD，POSIX 远端预热 bash / zsh / sh 或「自动」（登录用户的 `$SHELL`）。SSH 直连模式不预热。

本机 Windows 的 PowerShell 配置（例如默认配置 `claude`）与普通终端共用空闲 Shell。点击新建并通过配置命令的信任检查后，才在领取的 PowerShell 中运行启动命令。SSH Server 模式项目同样支持远端 PowerShell 与 POSIX Shell 的配置（见下文“SSH 远端”）。带启动命令的 CMD 配置、多行命令的 POSIX 配置、带额外环境变量的远端配置和运行任务沿用原启动方式。

**本机与远程独立设置**：设置 → 终端 → **本机预热**（仅 Windows）控制本机池；「远程连接 → 终端」中每条连接的 **远端预热** 单独控制该连接。两者默认开启，关闭某处只停止该处的普通 Shell 和 CLI 预热，不影响其他位置。每条连接的「普通 Shell 预热数量」（自动 = 1 个、不预热、1–8）同样保存在本机（localStorage），设为「不预热」只停该连接的普通 Shell，所选 CLI 照常预热。这些连接设置不写入 `default-settings.json`。

本机数量保存在用户 `default-settings.json`（JSON5）；工作区同名键会被忽略：

```json5
// 不得删除注释。仅本机 Windows 池：auto=保留 1 个并在预留后立即补充，0=关闭（同时停止本机 CLI 预热），1–8=手动指定。
"terminal.integrated.shellPrewarmCount": "auto",
```

默认配置可预热时，池使用该配置实际选择的 Shell；默认配置为 WSL 或带启动命令的 CMD 时，池继续使用普通终端的全局 Shell 设置。
默认 `auto` 固定保留 **1 个**空闲 Shell：成功预留就立即开始补充，因此常驻多个只对补充完成前的连续快速新建有帮助。
手动 1–8 用于需要连开多个终端的场景。等待接回期间，每个池最多额外准备 1 个 Shell。诊断中的 `preparing` 表示池为空且正在准备，`all_reserved` 表示池内现有项都已预留。
同一连接上的受信任项目共享该连接的数量。本机和每条已连接的 Server 模式连接按各自的数量独立补充，例如本机设为 2、WinDev 设为 3、另一条连接保持自动，则三处分别保留 2、3、1 个。已打开的终端不计入空闲数量。
最近聚焦的 QingCode 窗口同步这些设置。切换到本机、其他连接或无项目窗口时，符合条件的远程连接继续补充。关闭某处预热只清空该处的池。

每个池在配置或预留后立即开始逐个补充。后台定期复查连接、项目注册与信任状态。
系统可用内存低于 `max(1 GiB, 实际物理总量的 10%)` 时回收空闲项并暂停补充，恢复后继续。
池为空、正在准备、Shell 不匹配或领取失败时正常新建；本机接回的超时为 2 秒。
重启终端（包括「重新打开 Shell」）与新建条件相同，也从池中领取：预留项改用原标签 id，标签身份和输出不变，Shell 内的 `QINGCODE_TERMINAL_ID` 仍是预热时分配的值。运行任务、带额外环境变量的配置走原方式重启；同一标签已有未领取的预留时不再占用第二个空闲项。启动命令交付后若执行确认丢失，返回错误，避免重复运行。

复用按主机：同一主机（本机，或同一条 SSH 连接）上 Shell 可执行文件、启动参数及基础环境变量一致即可领取，工作目录不在复用键里。
优先领取已在目标目录的预热项；在别的项目目录时，经 PowerShell 启动通道先 `Set-Location -LiteralPath` 到目标目录再执行配置命令（配置命令单独解析，语法错误不影响切换），之后才出现提示符。本机 CMD 只能在原目录领取，切换本机目标目录后会替换旧目录的空闲 CMD，远端 CMD 可切换目录后作为普通终端领取。
默认 Shell 改变、连接断开或失去所有受信任项目时回收相应的远端项。
本机 PowerShell 在原目录加载用户 profile 后连接仅当前用户可访问的命名管道。领取时通过管道传递 UTF-8 启动命令，完成 PTY 接回后才通知执行；输入历史中不会出现启动命令。CMD 通过私有临时目录中的标记文件报告就绪。
就绪等待上限 20 秒；profile 需要人工交互或初始化失败时丢弃该预热项，失败后延迟重试。
临时标记目录会在成功、失败、取消时清理；进程被强制结束可能留下空的临时目录。

预热时提前分配稳定的终端 ID，领取前和领取后 `QINGCODE_TERMINAL_ID` 一致。
领取互斥，预留 15 秒未使用会回收；创建时再次核对启动条件和原生工作区信任。
未领取项由 daemon 的 `pty.createTransient` 创建，管道断开即结束，不作为孤儿终端恢复。
`pty.claim` 仅允许创建连接执行一次，成功后按正常持久终端接入。
本机协调窗口销毁时清理本机池；异常退出由 daemon 的连接清理兜底。
已领取终端仍遵循原有退出时“保留/结束”选择。
旧宿主不认识新增协议时自动正常新建，不主动结束旧宿主上的用户终端。

`terminal prewarm status --project <项目>` 的 `recent` 从当前窗口最近 100 次成功新建中筛选该项目，关闭标签后仍可查，窗口重载后清零。`hit.count` 和 `miss.count` 分别是命中和正常启动的次数；`missReasons` 包含未启用、不支持、池为空和领取回退等原因。两组的 `p50Ms`、`p95Ms` 从配置通过信任检查计到前端将终端标为可写，空样本返回 null。该统计只覆盖桌面新建（含经桌面 CLI 发起的新建），不含重启、接回、运行任务或手机新建。

通过终端配置启动 Codex、Claude Code 等命令时，若同窗格已有实测尺寸，可在新视图挂载期间启动。首次打开窗格时优先等实际尺寸，100 毫秒后可按估计尺寸启动。预热命中与冷启动都走这条路径。默认在用户新建终端并通过信任检查后启动工具进程。

诊断事件 `terminal.prewarm_hit` 表示命中。
性能验收应比较同项目/同 Shell/profile 下“点击新建 → 可输入”的 P50/P95，
以及 1 / 4 / 8 个空闲 Shell 的宿主、ConPTY、Shell 和子进程总内存。
本功能不承诺固定内存成本或固定启动时间，用户 profile 会显著影响两者。

## 本机 CLI 预热

在 Windows 的「设置 → 终端 → 本机 CLI 预热」中选择一个已信任的 PowerShell 配置。启动命令支持 `claude`、`opencode`、`codex` 和 `pi`，Shell 可选自动、PowerShell 7 或 Windows PowerShell。功能默认关闭，启用时需开启「本地终端可接回」且本机 Shell 预热数量大于零。带参数的命令沿用原有启动方式。

QingCode 在应用数据目录自动创建专用空目录 `codex-prewarm`。打开已信任的项目并新建所选配置后，标签独占该会话。各工具分别按自己的接口绑定目录。

| 工具 | 预热与领取 |
| --- | --- |
| Claude Code | 提前启动交互界面。在确认属于专用空目录后可完成 Claude 对该目录的首次信任提示。领取时用内置 `/cd` 切换，再对同一路径执行一次 `/cd` 核对当前目录。目标项目首次信任仍由用户确认。 |
| OpenCode | 提前启动一个仅监听本机回环地址、使用随机密码的 `opencode serve`。领取时先核对服务端返回的工作目录，再用 `opencode attach --dir` 启动交互界面。需要支持 `serve` 和 `attach --dir` 的版本。 |
| Codex | 提前启动交互界面并核对 `/pwd`。领取时执行 `/cd` 并再次核对 `/pwd`。 |
| pi | pi 没有会话内切换目录的命令，只能提前完成 Shell 和 Node 模块加载：用 Node 在专用空目录预先导入 pi 入口的全部依赖，领取时切到目标项目再运行原始入口，项目配置、扩展和会话仍在目标项目加载。找不到 `node` 或 pi 的 npm 包入口（如 bun 编译版）时只预热 Shell，领取后在目标项目普通启动 `pi`。 |

退出 CLI 后，PowerShell 停留在目标项目。若遇到登录、升级、目标项目信任提示或无法确认目录，QingCode 在目标项目走普通启动。可用 `terminal prewarm status --project <项目>` 查看 `profile.ready` 和暂停原因，命中后在 `terminal diagnostics` 查看 `prewarm.kind=profile`。终端列表「按主机分组」时，主机标题在终端数量左侧显示 `⚡就绪/目标`：设了 CLI 预热的显示 CLI 池，否则显示普通 Shell 池；补满为灰色，补充中为常规色，暂停为琥珀色，悬停可看两个池的详情、暂停原因和最近的命中/未命中次数。预热未开启的主机不显示。

## 同一远程连接的跨项目 CLI 预热

在「远程连接 → 远端 CLI 预热」选择已信任的裸命令 `claude`、`opencode`、`codex` 或 `pi` 即可，不需要选目录。逻辑与本机相同：CLI 在 QingCode 专用的空目录启动，远端为 `~/.qingcode/cli-prewarm`（Windows 为 `%USERPROFILE%\.qingcode\cli-prewarm`），不在任何用户项目里。启动脚本首次使用时创建该目录，每次启动前确认它不是链接且为空，否则拒绝启动。Codex 带 `-c projects={"<该目录>"={trust_level="trusted"}}` 只对本进程临时信任它，不写 `config.toml`；Claude 只在该目录出现首次信任提示时自动确认；OpenCode 和 pi 没有目录信任。当前项目所在连接用当前项目、其他连接用最近打开的已信任项目授权建立连接，这个项目只决定能否连接，不是 CLI 的工作目录。
要切换的目标项目也须已注册并受信任。每条已认证的 Server 连接按该连接的「同时预热的 CLI 数量」（1–4，默认 1）保留所选 CLI，连续新建多个同配置终端时每个都能领取已就绪的 CLI；领取后立即补充，切换标签或项目后仍可领取。只改数量时保留已就绪的 CLI，调小时裁掉多出的空闲项。CLI 池与该连接的普通 Shell 池是两个独立的池（终端列表主机标题悬停时的「Shell 预热 / CLI 预热」分别对应它们），各按自己的数量补充；普通 Shell 设为「不预热」不影响 CLI，只有关闭该连接的「远端预热」才两者都停。

远端沿用 SSH 终端的 Shell 解析规则。Windows 需要实际解析到 Windows PowerShell 或 PowerShell 7。POSIX 使用 `/bin/sh` 运行启动脚本，退出 CLI 后接回用户的登录 Shell。OpenCode 的 POSIX 目录校验还会调用远端 Python；pi 的模块预加载需要远端 `node`。Claude Code 和 Codex 通过远端服务的 `pty.claimCwdFile` 能力，把领取时验证过的目录交给退出后的 Shell；旧服务走普通启动。OpenCode 服务只监听终端所在主机的回环地址。首次登录或目标项目信任确认在正常交互终端中完成。连接断开、身份变化、撤销项目信任或停用配置后，空闲会话失效。预热的 CLI 自行退出后暂停补充（`profile_exited`），直到配置变化；仅因 daemon 连接断开（Server 重启、网络中断）失效时照常按退避重新预热。

同一连接切换项目时，只要原登记项目仍受信任且 CLI 配置相同，已准备和正在准备的会话都可继续使用。识别到 CLI 升级、登录、目录信任提示或 PowerShell 脚本拦截时，预热暂停并在所属窗口显示原因。使用 `terminal prewarm status` 可查看对应的 `profile.reason`。Windows PowerShell 5.1 拦截 npm 启动脚本时，可在终端配置中选择已安装的 PowerShell 7。CLI 目录切换和二次验证分别记录耗时。

## Android 移动连接

手机新建终端与电脑端共用同一个池，条件与电脑端新建一致：本机 Windows 项目（含 PowerShell 配置命令）、SSH Server 模式项目（含 PowerShell / POSIX Shell 配置命令）；WSL 和 CMD 配置命令不领取。
手机按目标项目所在的连接领取，也可从本机池领取。
领取前预留项改用手机终端的 `mobile-` id，输出因此路由给手机；Shell 内的 `QINGCODE_TERMINAL_ID` 仍是预热时分配的值。
本机领取后终端由本机 PTY 宿主托管（未命中时仍由 QingCode 进程持有），停止移动连接、撤销设备或关闭应用时与其他手机终端一样被结束。

## SSH 远端

同一连接中，后台使用已认证的 daemon 会话创建临时 PTY。每个空闲项占用一个 daemon 通道。
空闲 Shell 在远端用户主目录启动，普通终端和兼容的配置终端共享。PowerShell 完成用户 profile 并发出就绪标记后才入池。CMD 在完成启动设置后报告就绪。

- 领取时沿用终端创建的项目注册、信任、符号链接及根边界检查。PowerShell 读取编码的字面目录并执行 `Set-Location -LiteralPath`，CMD 使用 `cd /d`。CMD 无法安全表达的目录走正常新建。
- Shell 确认进入目录后，客户端用 `pty.claim` 登记已校验的工作目录，供后续断线接回使用。缺少 `pty.claimCwd` 能力的 daemon 沿用正常新建。
- 接回 PowerShell 后，客户端交付配置命令或空行。命令通过不回显的输入传递；交付失败即结束终端并返回错误，避免重复执行。带额外环境变量的配置和带启动命令的 CMD 走正常新建。
- 本机内存压力判断只约束本机项目；远端预热不受本机内存影响。
- 远端目录确认与接回各限 5 秒（本机接回 2 秒），失败回退正常新建，并通过 `kill_detached_terminal` 后台清理已转为 detached 的 PTY。
- 远端旧版 daemon 不认识 `pty.createTransient` 时预热失败并退避重试，终端照常新建。
- Windows daemon 为每个 PTY 建立独立的 Job Object，终端结束时一并回收其子进程。若系统拒绝分配 Job，沿用原有关闭流程，并写入 `pty.job_assignment_failed` 诊断。

### Linux / macOS 远端

- 适用 bash、zsh、sh 及「自动」（daemon 以登录 Shell 启动用户的 `$SHELL`）；启动参数不变，rc 照常加载。其他 Shell 名称不预热。
- 创建后向 PTY 输入一行 ` printf 'QC-%s-ready!\n' '<nonce>'`，Shell 加载完 rc 进入提示符才会执行，输出标记即入池。格式串与 nonce 分开写，回显的命令行不会误命中；nonce 不进环境变量。
- 领取时输入 ` cd '<目录>' && printf …cwd… || printf …error…`（单引号转义，bash / zsh 用 `builtin cd` / `builtin printf` 绕开同名函数）。目录含控制字符时走正常新建。
- 输入行以空格开头，开启 `ignorespace`（bash 的 `HISTCONTROL`、zsh 的 `HIST_IGNORE_SPACE`）时不记入历史。接回从标记之后回放，用户只看到项目目录下的新提示符；配置命令作为普通输入交付，多行命令走正常新建。
- 诊断事件 `terminal.prewarm_hit` 的 `remote` 字段区分本机与远端命中。

## 验证

- `pnpm test` / `pnpm build` / `pnpm lint`：设置范围、JSON5、协调器迟到结果和信任/持久化关闭。
- `cargo test` / `cargo clippy --all-targets -- -D warnings`：数量、预留后立即补充、内存压力、启动条件隔离、并发领取、过期和窗口归属；真实 daemon 检查未领取项断线回收及已领取项保留。
- 启动 `pnpm test:web` 后运行 `node scripts/web-tests/shell-prewarm.agent-browser.mjs`；复用真实设置组件，截图和结果在 `.dev/web-tests/shell-prewarm/`，不替代 Windows ConPTY 实机验收。
- Windows `pnpm tauri:dev`：在可丢弃的已信任项目中验证 PowerShell 7、Windows PowerShell、CMD；检查 profile 仅执行一次、目录/终端 ID 正确、连续新建无重复领取、关闭/撤销信任/切项目回收、异常退出回收，以及已领取终端仍可接回。
