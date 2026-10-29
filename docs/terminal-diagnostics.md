# 终端异常恢复与诊断

SSH + 远端服务模式下，SSH 通道中断后接回原 PTY，保留进程、输入序号和输出补发。握手失败不作为 daemon 已重启的证据。

恢复时握手超时或归属校验失败，只提示暂时无法接回，允许重试原 PTY，不结束或重建进程。收到进程退出事件，或 attach 明确确认 PTY 已不存在后，标签保持已退出并保留输出，不自动创建 shell，不自动执行原配置里的 Claude 或任务命令。退出提示条独立于 xterm 备用屏幕，提供“重新打开终端”和“导出终端诊断”。重新打开创建普通 shell；一次性任务的“按原运行配置重启”仍是明确的任务重跑操作。

确认结束的时间和退出码随工作区保存，重新挂载视图或重启应用不会自动复活该标签。关闭与重启按具体终端实例回收，不影响同一连接里的其他终端。

## 日志位置与保留

- Windows 正式客户端：`%APPDATA%\com.qingcode.app\diagnostics\terminal\`；开发客户端：仓库 `.dev/diagnostics/terminal/`。其他平台使用应用数据目录的相同子目录。
- 远端：用户家目录 `.qingcode/server/run/`。
- `lifecycle.jsonl`：结构化元信息，5 MiB 轮转，保留 3 份归档。
- `incidents/*.jsonl`：异常前 120 秒、后 30 秒的元信息。前窗口最多 4096 条、4 MiB，单份约 5 MiB 上限，保留 20 份。进程被外部强杀后无法继续写后窗口。
- `daemon.stderr.log`：启动失败等 stderr；启动时超过 5 MiB 则保留一份旧日志。Windows 同时记录 daemon PID 和是否使用了 Job breakaway。panic 仅记录源码位置，避免将用户数据作为 panic 内容落盘。

每条事件含 UTC Unix 毫秒时间、单调时钟经过时间、实例 ID、PID、实例内序号。关联字段包括终端标签 ID、PTY ID、shell PID、客户端/连接 ID、请求 ID、操作 ID，以及结束请求来源。`process.started` 记录版本和实际二进制 SHA-256，区分相同版本号下的不同构建。

## 判断结束来源

链路为 `terminal.close_requested` / `terminal.restart_requested` → `terminal.kill_requested` → `pty.kill_requested` → `pty.termination_requested` / `pty.force_kill` → `pty.process_wait_returned` / `pty.exited`。

结束请求在执行前落盘，执行结果和实际进程退出分别记录。来源区分用户关闭、关闭其他/全部、用户重启、会话替换、取消重连、创建取消、遗留终端清理、连接移除和后台清理。daemon 关服与 detached TTL 回收分别记来源。退出码 1 不用于推断崩溃或强杀。

`terminationRequested` 表示宿主观察到结束请求，不证明它与退出有因果关系。没有请求记录时原因保持未知；进程自身日志无法确定外部 TerminateProcess 的调用者，必要时需额外的 Windows 进程跟踪。

## 导出与边界

退出提示条和标签右键菜单可导出 JSON Lines，汇总本机记录、滚动归档及最近两份异常快照，并尝试读取远端相同记录及 stderr 摘要。远端总读取最多等待 15 秒；失败仍可导出本机证据，并标记远端不可用。导出不会启动、升级或重启服务。

诊断不记录终端正文、输入、命令参数、配置环境变量或鉴权 token。stderr/错误摘要过滤敏感字段并限制长度。原有“导出终端内容”是另一项显式操作，不包含在诊断导出中。磁盘错误报告到 stderr，诊断写入失败不会阻止用户结束进程。

## 验证

- `pnpm check`：类型、单测、打包脚本、lint、Rust fmt/clippy/test。
- `cargo test --manifest-path src-tauri/qingcode-server/Cargo.toml --test terminal_lifecycle -- --nocapture`：真实代理断开与接回、单个 PTY 关闭、兄弟 PTY 存活、未知退出、元信息隐私、daemon 重启后实例区分。
- Windows 交叉编译该集成测试后，在一次性目录设置 `QC_TEST_SERVER` 指向该目录的测试 server，执行测试 exe。测试使用临时 `--state-dir`，不连接或停止正在使用的 daemon；覆盖 ConPTY，但不等同于桌面长时间 Claude 会话验收。
- `pnpm test:web` 后运行 `scripts/web-tests/terminal-exit.ego.mjs` 的 `run()`：复用生产提示条，验证保留现场、显式重新打开、导出不重启、未知退出码、中英文及窄屏浅色布局。截图不可用时传 `screenshots: false`，报告明确记录边界。
