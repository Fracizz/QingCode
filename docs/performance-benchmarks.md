# 可重复桌面性能基准

`src/lib/performanceDiagnostics.ts` 保留现有前端长任务、IPC 慢调用及终端/文件事件吞吐诊断；`scripts/perf/benchmark.py` 从操作系统外部采集实际启动的进程树，两者用于不同层面的定位。本脚本不生成性能优劣结论，也不把 Web 模拟测试当作桌面性能。

## 采集

需要 Python 3.9+。当前采集器支持原生 Windows（内置 Windows PowerShell / CIM）和 Linux（`/proc`）；未实现 macOS 采集。应在待测应用所属操作系统运行，不能用 WSL 的 `/proc` 测 Windows WebView2。

先关闭已有 QingCode，避免单实例转发。固定同一硬件、电源模式、显示分辨率、窗口大小、应用设置与测试数据；在专用测试账户准备项目和会话，使用相同的 release 二进制构建方式。不要把 `pnpm dev`、debug 和 release 数据混为一组。脚本记录可执行文件 SHA-256、版本、机器/系统/CPU、场景与采样参数，不记录完整命令参数；目标 stdout/stderr 写入同名 `.process.log`，分享前检查其中是否含业务数据。

Windows 示例（在仓库根目录运行 PowerShell，一条命令）：

```powershell
python scripts/perf/benchmark.py run --scenario idle-empty --cache warm --cache-preparation "同一测试账户，预运行一次并正常退出" --version 0.1.14-beta.12 --ready-window --stop window-close --duration 30 --warmup 5 --interval 1 --output .dev/perf/idle-warm-01.json -- C:/Code/QingCode/release/QingCode.exe
```

Linux 示例（更换为实际 release 路径；默认在采样完成后由操作者关闭应用）：

```sh
python3 scripts/perf/benchmark.py run --scenario idle-empty --cache uncontrolled --cache-preparation none --version local-release --duration 30 --warmup 5 --output .dev/perf/idle-01.json -- /absolute/path/to/QingCode
```

`--cwd` 设置目标工作目录。启动后的项目、终端恢复来自该账户预先准备的真实应用状态。采集器不会创建项目、信任工作区、运行任务或修改应用设置。

- `--ready-window`：Windows 根进程首次出现非零 `MainWindowHandle`；这是窗口存在边界，**不是首帧完成或可交互时间**。
- `--ready-file /absolute/path/ready`：由独立业务驱动在完成指定动作后创建全新标记文件。计时从启动请求到采集器发现标记，包含驱动/采样延迟。采集器不会自行创建标记，也不会读取前端诊断来冒充业务就绪。
- 不提供就绪条件时 `startupMs` 为 `null`。就绪条件始终未满足则该次失败。已有标记文件会被拒绝。
- `--stop window-close`：Windows 调用根进程 `CloseMainWindow()`，记录发出关闭请求到已观察进程树退出的 `exitMs`。有退出确认、后台常驻 daemon/终端或阻塞窗口时可能超时，需记录具体场景。
- `--stop manual`：采样结束后等待人工关闭，`exitMs` 保持 `null`，不把人工反应时间当退出性能。
- `--stop terminate`：发送平台进程终止请求，用于采集器测试；其 `exitMs` 是进程终止耗时，不能当作应用正常关闭耗时。不会递归强杀子进程。
- `--exit-timeout` 默认 20 秒。超时或采集异常会保存失败 JSON；不会强行清理残留进程，操作者按实际 PID 检查并关闭。本脚本不控制原本已在运行的进程。

## 指标和边界

`schemaVersion: 1` JSON 包含逐次 `samples`、采集开销 `collectionMs`、实际单调时钟 `atMs`、PID 列表和汇总。汇总只使用 `--warmup` 之后的样本；CPU 取区间累计 CPU 秒差除以实际墙钟间隔，100% 表示占满一个逻辑 CPU，多线程可超过 100%。整组的 CPU 秒差保留已退出且观察过的后代，避免子进程退出让计数倒退。

RSS 为根进程和后代（含正常作为后代启动的 WebView/WebView2）的工作集/RSS 之和，**共享页可能重复计算**，不能称作独占物理内存。已观察的后代即使重挂到其他父进程也继续跟踪；用创建时间区分 PID 复用。采样之间创建并结束的短进程可能漏计，启动前已存在或由独立系统服务启动的进程不计入。远端 SSH 主机资源不在本机结果内；本机恢复远端连接的开销可以单列场景。

`startupMs` / `exitMs` 都含采集和轮询延迟，不适合解读为精确到毫秒的微基准。Windows 每轮 CIM/PowerShell 的开销可能高于指定间隔，实际时间及 `collectionMs` 已记录；建议从 1 秒采样开始，在所有对比组中保持参数相同。不要同时运行两组基准或在构建/安装依赖时采集。

`status: passed` 仅表示采样与指定边界成功：退出过早、非预期非零退出码、样本不足、就绪未达或退出超时均失败。它不代表产品功能验收。

## 固定场景

使用以下名称和相同数据复测；把仓库提交、目录文件数量、终端命令/输出速率、远端类型与网络条件记录在 `--notes` 或配套场景记录，避免保存凭据。

| 场景 | 前置状态与操作 | 建议观测 |
|---|---|---|
| `idle-empty` | 专用账户无项目/终端；打开窗口后不操作 | 窗口边界、空闲 RSS/CPU、关闭 |
| `projects-10` | 固定的 10 个本地测试仓库已加入项目列表，固定同一活动项目 | 恢复后 RSS/CPU；不是同时递归扫描 10 项目的假设 |
| `terminals-4` | 同一项目保存 4 个普通终端，确保上轮终端处理方式一致 | 恢复后进程数、RSS/CPU；标记是否重接已有 PTY |
| `terminal-output` | 固定一个终端持续输出固定字节率/行长，持续 30 秒；保留相同 scrollback | 稳态 CPU/RSS，并用前端诊断核对真实吞吐 |
| `large-tree` | 固定文件数量、深度、排除规则的目录；按相同路径展开/切换 | 进程采样；业务驱动完成后标记另测动作完成时间 |
| `ssh-reconnect` | 固定临时远端项目、连接模式和 RTT；同一时点断连/恢复 | 客户端开销；真实连接完成由驱动标记，不用窗口信号替代 |

脚本负责采集，不自动完成上述业务操作。需要动作完成时间的场景，应先接入并保存可复用业务驱动；没有驱动时只报告资源曲线与人工操作记录。

`--cache cold/warm/uncontrolled` 是实验条件标签，不会清理系统缓存或应用数据。冷启动需在相同重启条件、恢复配置和网络条件下采集，并在必填 `--cache-preparation` 如实记录准备步骤。没有控制缓存时使用 `uncontrolled`；不能仅因“第一次点开”就称为冷启动。

## 比较和复测

同一场景每个版本至少跑 5 次；暖缓存先预热一次、退出后开始计入。冷缓存每次重新执行相同准备。基线/新版本交替采集以减轻温度和系统后台任务漂移。保留全部 JSON 和异常记录，按各次汇总指标计算中位数及范围，不能只选择最快的一次。

```sh
python3 scripts/perf/benchmark.py compare .dev/perf/before-01.json .dev/perf/after-01.json
```

比较器输出 before/after 与变化百分比，指标越低通常越好，基线为零或未测量时百分比为 `null`。它只比较两份通过的同条件结果，检查场景、缓存及准备方法、机器/系统/架构/逻辑 CPU、采样时长/间隔/预热、就绪边界和停止方式；版本与二进制摘要允许不同。场景数据和人工动作是否相同仍需核对配套记录。单次差异不能当作回归判定。

## Git 读取基线

`scripts/perf/git_reads.py` 单独测量合并引用查询／同步缓存优化前的 Git CLI 子进程序列，
包含进程启动、Git 执行及 stdout 捕获，不包含 Tauri IPC、React 渲染、SSH 传输或 gitoxide。
已有仓库仅执行读取命令，设置 `GIT_OPTIONAL_LOCKS=0` 避免状态查询刷新索引；
测量前后核对 HEAD 和状态输出 SHA-256，发生变化时以非零退出。

```sh
python3 scripts/perf/git_reads.py --repo /absolute/path/to/repo --samples 25 --warmup 3 --output .dev/perf/git-reads.json
```

可指定一个**尚不存在**的 `--fixture-root`，生成 2002 / 12002 个跟踪文件、200 条提交、
25 个本地分支和 25 个远程跟踪分支的确定性样本，各含 100 个修改文件和 100 个未跟踪文件。
生成时会写入该专用目录并执行初始化、fast-import、reset 和 update-ref；不对 `--repo` 执行这些操作。
两平台样本应先核对 HEAD 一致，再比较。重新测试已生成的样本时用多次 `--repo`，不再次指定同一 fixture-root。

每组显式预热后随机交错运行各操作，输出原始样本、中位数、P95、stdout 大小及子进程数量。
旧版完整桌面状态包含 status、FETCH_HEAD 路径解析和相关 reflog；旧版分支列表包含两次 for-each-ref；
SCM 组为完整状态、分支和 40 条提交历史的串行无缓存总和，不能解释为实际 UI 刷新延迟。
`refs_combined_diagnostic` 在一个 for-each-ref 中枚举两类引用，仅测减少一次调用的潜力，
没有验证产品的排序、过滤、错误回退或展示语义，不能据此直接替换现有实现。

此工具提供 CLI 优化基线，不能证明 gitoxide 的性能或兼容性。不同硬件、Git 版本、
文件系统和仓库快照的结果不能作为单一变量的 Windows/Linux 性能对照。

### 当前读取逻辑与优化前对比

当前本地和 SSH 分支查询共用解析器：一次 `for-each-ref` 同时枚举本地和远程跟踪引用，
保留 Git 短名消歧、各组原排序、当前分支和上游信息，继续隐藏远程 `*/HEAD`。
合并查询失败时重试本地引用，保留仅本地分支的回退能力。

本地完整状态查询缓存同步时间；普通文件变化刷新沿用已有的轻量工作区接口。
缓存以规范项目路径和上游隔离，命中前检查 `.git`、HEAD、commondir、config、
packed-refs、FETCH_HEAD 及相关 reflog 的文件指纹。首次或变化后仍由 Git 解析真实路径与 reflog。
worktree 的 Git 目录与公共目录分别检查；外部 fetch/pull/push、分支切换、删除元文件、
重新初始化都会触发重新读取。缓存最多 128 项、30 秒保守有效期，不持有全局锁执行 Git。
特殊 Git 环境覆盖、reftable、符号引用链、缺失 HEAD 日志或读取失败时回退原查询。
Git 仍负责解释 reflog；SSH 同步时间字段沿用原行为，不在客户端缓存远端文件属性。

`scripts/perf/git_reads_compare.py` 从当前 Rust 源码提取分支和同步时间函数，
原样复制 `sync_cache.rs`、`git_command.rs`，生成仅依赖标准库的独立驱动：

```sh
python3 scripts/perf/git_reads_compare.py --source-dir .dev/perf/git-compare-source
.dev/perf/git-compare-source/git-reads-compare /absolute/path/to/repo 25 > .dev/perf/git-compare.jsonl
```

驱动在同一进程内比较旧版两次分支查询／不缓存同步时间与当前实现，
验证分支与同步字段一致，记录每项 25 次预热后耗时以及实际 Git 子进程数量。
命中时预期分支 `2 → 1`、有上游的完整状态 `4 → 1`；冷启动、失效和兼容回退不作此保证。
生成目录含源文件 SHA-256。可用 `--emit-only` 仅生成源文件，再在 Windows 原生用
`rustc --edition=2021 -O main.rs -o git-reads-compare.exe` 编译（按机器配置 MSVC linker）。
`rustc --edition=2021 --test main.rs -o cache-tests.exe` 可运行模块的真实临时仓库测试。

驱动测试生产查询及缓存逻辑，分支文本按 UTF-8 解码，不包含 GUI、Tauri、自动编码探测或 SSH 传输。
状态部分包含实际 status 命令，但不计 UI 数据解析；使用测试期间不变的上游。
它的 Windows 进程策略与应用一致，不应将绝对耗时直接与先前 Python CLI 采集值相减。
真实桌面交互和产品 SSH 连接仍需各自验收。

## 采集器验证

在 Linux 可运行：

```sh
python3 -m unittest discover -s scripts/perf -p 'test_*.py'
python3 scripts/perf/smoke.py
```

smoke 启动真实 Python 父子进程，子进程分配 32 MiB 并消耗 CPU，验证后代资源计入、就绪标记、终止与 JSON 比较，并拒绝不同缓存条件。临时产物测试后删除。纯逻辑测试另外覆盖后代重新挂载、退出后累计 CPU、PID 复用和不规则采样间隔。以上验证不代表已运行 QingCode 桌面基准；原生 Windows 的 CIM、WebView2 计入、窗口边界和正常关闭仍需在 Windows 实测。
