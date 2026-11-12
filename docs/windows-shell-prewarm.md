# Windows Shell 预热

设置 → 终端 → **Shell 预热数量** 控制当前已信任项目的空闲普通终端池，目标二选一：

- **本机 Windows 项目**：仅 Windows 客户端，需开启“本地终端可接回”；关闭后预热随之停止。不预热 WSL。
- **远端为 Windows 的 SSH 项目**：任意客户端，要求 Server 模式（远端 daemon 托管终端），不依赖“本地终端可接回”。
  **Linux / POSIX 远端不预热**，SSH 直连模式也不预热。

两种目标都不预热自定义启动命令的终端配置或运行任务。

用户 `default-settings.json` 支持以下 JSON5 设置；工作区同名键会被忽略：

```json5
// 不得删除注释。auto=保留 1 个并在领取后立即补充，0=关闭，1–8=手动指定。
"terminal.integrated.shellPrewarmCount": "auto",
```

默认 `auto` 固定保留 **1 个**空闲 Shell：领取后立即补充，因此常驻多个只对补充完成前的连续快速新建有帮助。
手动 1–8 用于需要连开多个终端的场景。
设置数量是空闲预热项的目标，不限制用户已经打开的终端数量，也不会逐项目累加预算。
当前聚焦的项目窗口协调同一个池；切换窗口可移交预算，独立文件窗口没有项目时不预热。

池在后台逐个补充；领取会立即唤醒补充，其余时间每 1.5 秒复查一次内存与信任。
窗口重新获得焦点且条件未变时保留已就绪项，只有项目、信任、设置变化才先失效。
系统可用内存低于 `max(1 GiB, 实际物理总量的 10%)` 时回收空闲项并暂停补充，恢复后继续。
池为空、正在准备、Shell 不匹配或领取失败时正常新建；命中后的接入最多等待 2 秒，失活缓存自动回退并后台清理。

复用要求规范化工作目录、Shell 可执行文件、启动参数及基础环境变量一致。
默认 Shell 改变、用户配置重新加载、项目切换/关闭和信任变化会使旧项失效。
Shell 按原目录加载用户 profile，再通过内部启动参数写入独立临时目录的就绪标记；
标记路径通过临时环境变量传递，用后清除，不往终端输入历史注入探测命令。
就绪等待上限 20 秒；profile 需要人工交互或初始化失败时丢弃该预热项，失败后延迟重试。
临时标记目录会在成功、失败、取消时清理；进程被强制结束可能留下空的临时目录。

预热时提前分配稳定的终端 ID，领取前和领取后 `QINGCODE_TERMINAL_ID` 一致。
领取互斥，预留 15 秒未使用会回收；创建时再次核对启动条件和原生工作区信任。
未领取项由 daemon 的 `pty.createTransient` 创建，管道断开即结束，不作为孤儿终端恢复。
`pty.claim` 仅允许创建连接执行一次，成功后按正常持久终端接入。
窗口销毁会清理池；异常退出由 daemon 的连接清理兜底。
已领取终端仍遵循原有退出时“保留/结束”选择。
旧宿主不认识新增协议时自动正常新建，不主动结束旧宿主上的用户终端。

诊断事件 `terminal.prewarm_hit` 表示命中。
性能验收应比较同项目/同 Shell/profile 下“点击新建 → 可输入”的 P50/P95，
以及 1 / 4 / 8 个空闲 Shell 的宿主、ConPTY、Shell 和子进程总内存。
本功能不承诺固定内存成本或固定启动时间，用户 profile 会显著影响两者。

## SSH 远端（Windows）

远端预热复用同一个池和协议：在远端 daemon 上用 `pty.createTransient` 创建，经 `pty.claim` 领取后按正常持久终端接入。
预热项占用终端连接池的一个 daemon 通道（计入该连接的 `MaxSessions`），回收或领取后随正式终端归还。

- 远端判断：资源路径为 `/C:/...` 形态，且该连接为 Server 模式；否则不预热。
- 配置时校验项目根已注册、已信任，并经 SFTP 解析项目内的工作目录；后台每轮复查信任、根路径和模式，变化即回收。
- 启动参数与 `ssh_create_terminal` 共用 `persistent_shell_launch`，复用键为 `ssh://` 资源原文加启动参数，不会与本机路径互相命中。
- 远端无法观察本机标记文件，PTY 创建成功即入池；profile 在后台继续加载，提前领取时看到的是加载中的 Shell。
- 本机内存压力判断只约束本机项目；远端预热不受本机内存影响。
- 领取上限 5 秒（本机 2 秒），失败回退正常新建，并通过 `kill_detached_terminal` 后台清理已转为 detached 的 PTY。
- 远端旧版 daemon 不认识 `pty.createTransient` 时预热失败并退避重试，终端照常新建。
- 诊断事件 `terminal.prewarm_hit` 的 `remote` 字段区分本机与远端命中。

## 验证

- `pnpm test` / `pnpm build` / `pnpm lint`：设置范围、JSON5、协调器迟到结果和信任/持久化关闭。
- `cargo test` / `cargo clippy --all-targets -- -D warnings`：数量、领取后立即补充、内存压力、启动条件隔离、并发领取、过期和窗口归属；真实 daemon 检查未领取项断线回收及已领取项保留。
- 启动 `pnpm test:web` 后运行 `node scripts/web-tests/shell-prewarm.agent-browser.mjs`；复用真实设置组件，截图和结果在 `.dev/web-tests/shell-prewarm/`，不替代 Windows ConPTY 实机验收。
- Windows `pnpm tauri:dev`：在可丢弃的已信任项目中验证 PowerShell 7、Windows PowerShell、CMD；检查 profile 仅执行一次、目录/终端 ID 正确、连续新建无重复领取、关闭/撤销信任/切项目回收、异常退出回收，以及已领取终端仍可接回。
