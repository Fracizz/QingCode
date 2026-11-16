# Windows Shell 预热

设置 → 终端 → **Shell 预热数量** 控制每条符合条件的远程连接和本机的空闲普通终端数量。

- **本机 Windows 项目**：仅 Windows 客户端，需开启“本地终端可接回”；关闭后预热随之停止。不预热 WSL。
- **远端为 Windows 的 SSH 项目**：任意客户端，要求 Server 模式（远端 daemon 托管终端），不依赖“本地终端可接回”。
  **Linux / POSIX 远端不预热**，SSH 直连模式也不预热。

本机 Windows 的 PowerShell 配置（例如默认配置 `claude`）与普通终端共用空闲 Shell。点击新建并通过配置命令的信任检查后，才在领取的 PowerShell 中运行启动命令。远端 Windows 的 SSH Server 模式项目同样支持 PowerShell 配置（见下文“SSH 远端”）。带启动命令的 CMD 配置、远端 Linux 配置、带额外环境变量的远端配置和运行任务沿用原启动方式。

用户 `default-settings.json` 支持以下 JSON5 设置；工作区同名键会被忽略：

```json5
// 不得删除注释。auto=保留 1 个并在领取后立即补充，0=关闭，1–8=手动指定。
"terminal.integrated.shellPrewarmCount": "auto",
```

默认 `auto` 固定保留 **1 个**空闲 Shell：领取后立即补充，因此常驻多个只对补充完成前的连续快速新建有帮助。
手动 1–8 用于需要连开多个终端的场景。
同一连接上的受信任项目共享这一数量。本机和每条已连接的 Windows Server 模式连接独立补充。例如设置为 2，已有本机、WinDev 和另一条符合条件的连接时，三处可各保留 2 个。已打开的终端不计入空闲数量。
最近聚焦的 QingCode 窗口同步用户设置。切换到本机、其他连接或无项目窗口时，符合条件的远程连接继续补充。关闭预热会清空所有池。

每个池在配置或领取后立即开始逐个补充。后台定期复查连接、项目注册与信任状态。
系统可用内存低于 `max(1 GiB, 实际物理总量的 10%)` 时回收空闲项并暂停补充，恢复后继续。
池为空、正在准备、Shell 不匹配或领取失败时正常新建；本机接回的超时为 2 秒。启动命令交付后若执行确认丢失，返回错误，避免重复运行。

复用按主机：同一主机（本机，或同一条 SSH 连接）上 Shell 可执行文件、启动参数及基础环境变量一致即可领取，工作目录不在复用键里。
优先领取已在目标目录的预热项；在别的项目目录时，经 PowerShell 启动通道先 `Set-Location -LiteralPath` 到目标目录再执行配置命令（配置命令单独解析，语法错误不影响切换），之后才出现提示符。本机 CMD 只能在原目录领取，远端 CMD 可切换目录后作为普通终端领取。
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

诊断事件 `terminal.prewarm_hit` 表示命中。
性能验收应比较同项目/同 Shell/profile 下“点击新建 → 可输入”的 P50/P95，
以及 1 / 4 / 8 个空闲 Shell 的宿主、ConPTY、Shell 和子进程总内存。
本功能不承诺固定内存成本或固定启动时间，用户 profile 会显著影响两者。

## Android 移动连接

手机新建终端与电脑端共用同一个池，条件与电脑端新建一致：本机 Windows 项目（含 PowerShell 配置命令）、远端为 Windows 的 SSH Server 模式项目（含 PowerShell 配置命令）；WSL 和 CMD 配置命令不领取。
手机按目标项目所在的连接领取，也可从本机池领取。
领取前预留项改用手机终端的 `mobile-` id，输出因此路由给手机；Shell 内的 `QINGCODE_TERMINAL_ID` 仍是预热时分配的值。
本机领取后终端由本机 PTY 宿主托管（未命中时仍由 QingCode 进程持有），停止移动连接、撤销设备或关闭应用时与其他手机终端一样被结束。

## SSH 远端（Windows）

同一连接中，后台使用已认证的 daemon 会话创建临时 PTY。每个空闲项占用一个 daemon 通道。
空闲 Shell 在远端用户主目录启动，普通终端和兼容的配置终端共享。PowerShell 完成用户 profile 并发出就绪标记后才入池。CMD 在完成启动设置后报告就绪。

- 领取时沿用终端创建的项目注册、信任、符号链接及根边界检查。PowerShell 读取编码的字面目录并执行 `Set-Location -LiteralPath`，CMD 使用 `cd /d`。CMD 无法安全表达的目录走正常新建。
- Shell 确认进入目录后，客户端用 `pty.claim` 登记已校验的工作目录，供后续断线接回使用。缺少 `pty.claimCwd` 能力的 daemon 沿用正常新建。
- 接回 PowerShell 后，客户端交付配置命令或空行。命令通过不回显的输入传递；交付失败即结束终端并返回错误，避免重复执行。带额外环境变量的配置和带启动命令的 CMD 走正常新建。
- 本机内存压力判断只约束本机项目；远端预热不受本机内存影响。
- 远端目录确认与接回各限 5 秒（本机接回 2 秒），失败回退正常新建，并通过 `kill_detached_terminal` 后台清理已转为 detached 的 PTY。
- 远端旧版 daemon 不认识 `pty.createTransient` 时预热失败并退避重试，终端照常新建。
- 诊断事件 `terminal.prewarm_hit` 的 `remote` 字段区分本机与远端命中。

## 验证

- `pnpm test` / `pnpm build` / `pnpm lint`：设置范围、JSON5、协调器迟到结果和信任/持久化关闭。
- `cargo test` / `cargo clippy --all-targets -- -D warnings`：数量、领取后立即补充、内存压力、启动条件隔离、并发领取、过期和窗口归属；真实 daemon 检查未领取项断线回收及已领取项保留。
- 启动 `pnpm test:web` 后运行 `node scripts/web-tests/shell-prewarm.agent-browser.mjs`；复用真实设置组件，截图和结果在 `.dev/web-tests/shell-prewarm/`，不替代 Windows ConPTY 实机验收。
- Windows `pnpm tauri:dev`：在可丢弃的已信任项目中验证 PowerShell 7、Windows PowerShell、CMD；检查 profile 仅执行一次、目录/终端 ID 正确、连续新建无重复领取、关闭/撤销信任/切项目回收、异常退出回收，以及已领取终端仍可接回。
