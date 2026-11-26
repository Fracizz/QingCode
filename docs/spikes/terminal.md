# T21 终端技术验证（spike）报告

> 状态：完成（2026-11-26）。依据：`docs/tasks/T21-terminal-spike.md`、`docs/roadmap.md` §5 P2 / §7.4、`docs/mvp.md` §2–§4。
> 范围：只新增 `spikes/terminal/**` 与本文件；未改任何产品代码、未安装依赖、未提交。
> 结论用于回写 `docs/roadmap.md` §7.4「终端路线待 T21 结论」（本文不改 roadmap，由总管定稿）。

## 1. 结论与推荐

| 问题 | 结论 |
|---|---|
| 远端 Linux 能否不用原生模块做 PTY？ | **能，且推荐**。`python3` 标准库 `pty.fork` + `fcntl.ioctl(TIOCSWINSZ)` + `select` 转发，Node 只 `spawn` 一个 `python3 -I -c <内联源码>`，无需 `node-pty`、无需额外上传文件，`qn-server.cjs` 单文件约束不受影响。 |
| 兜底 | `script -qfec <shell> /dev/null` 可用但**不支持运行时 resize**（折中：启动时 `stty rows/cols` 设初始尺寸，运行中改尺寸只能重启终端）；其余交互、全屏、中文、Ctrl+C、退出码均正常。 |
| 探测 | 先探 `python3`（`pty.fork` / `TIOCSWINSZ` 可用）→ A；否则探 util-linux `script`（`-q/-f/-e/-c`）→ B；都不可用返回明确错误，并提示 Windows 需 ConPTY。 |
| 本机 Windows | **纯 Node 内置模块确实调不了 ConPTY**（§4）。推荐随安装包分发 `@lydell/node-pty` 一类预编译 N-API 包，由本机 daemon 从 `asarUnpack`/`extraResources` 绝对路径加载；远端不需要它。**需总管安装并实测 ABI/体积/许可证**（§4.4）。 |
| 断线接回 | daemon 持有终端进程；每个终端一份 **seq 环形缓冲**（2 MiB 原始字节 / 4096 块）+ **渲染端屏幕快照**（`@xterm/addon-serialize`）。环形缓冲只能补增量，不能重建屏幕状态；快照优先，缓冲截断且无快照时降级 resync。 |
| 是否要二进制帧 | **首期不需要**。PTY 是任意字节流，用 JSON 帧里的 base64 字段 + 32 KiB 原始字节分块即可（旧版也是 base64，见 §6.4）；16 MiB 帧上限足够。真加二进制帧要改 `packages/protocol/src/frame.ts` 和 SSH/MessagePort/手机 NDJSON 三条链路，代价大。 |
| 实测 | 93 上 **23 项通过 / 0 失败 / 4 项跳过**（`vim`、`htop` 未安装，按任务约束不安装），`demo.mjs` 可交互运行。原始数据 `spikes/terminal/results/93-measurements.json`。 |

推荐路线（落地顺序）：远端 A 为主 + B 兜底 → 协议与 daemon 托管 → 渲染端 xterm UI → 快照接回 → 最后补本机 Windows ConPTY。这样 P2 终端的远端部分不被 Windows 原生依赖阻塞。

## 2. 原型

### 2.1 形态与 API

`spikes/terminal/pty.mjs`：

```js
const pty = spawnPty({ shell, cols, rows, cwd, env })   // 同步返回，内部同步探测后端
pty.onData(chunk => ...)        // Buffer，原始 PTY 字节
pty.onExit(info => ...)         // {code, signal, source}
pty.write('echo hi\n')          // string | Uint8Array
pty.resize(120, 40)             // boolean：方案 B 返回 false
pty.kill()                      // 控制通道 shutdown + 进程信号，2s 后 SIGKILL 兜底
await pty.waitReady()           // {backend, pid, cols, rows}
```

- **方案 A**：`spawn('python3', ['-I', '-c', PYTHON_BRIDGE_SOURCE, JSON.stringify(config)], {stdio:['pipe','pipe','pipe','pipe']})`。`-I` 隔离 PYTHON* 环境变量；配置走 argv JSON，避免 shell 注入；`pty.fork()` 后子进程 `chdir` + `execvpe(shell, argv, env)`。
- **fd 3 双向控制通道**（实测 Node 侧 `child.stdio[3]` 是 `net.Socket`，可读可写）：
  - C→P：`{"type":"resize","cols":120,"rows":40}`、`{"type":"shutdown"}`、`{"type":"ping","id":n}`；
  - P→C：`ready`、`resized`、`pong`、`exit{code,signal}`、`error`。
  - Python 端 `fcntl.ioctl(master, TIOCSWINSZ, struct.pack('HHHH', ...))` 后 `os.killpg(os.tcgetpgrp(master), SIGWINCH)`（Linux 内核在 TIOCSWINSZ 时也会向前台进程组发 SIGWINCH，双保险）。
- **stdout/stdin 只走原始 PTY 字节**；控制消息与诊断分别走 fd 3 / stderr，互不污染。stdin EOF 时 Python 只把 fd 0 移出 select，**不结束终端**（客户端断开后 daemon 仍持有会话，§5）。
- 退出时 Python 广播真实子进程 `code/signal`（`waitpid` → `WIFEXITED/WIFSIGNALED`），Node 侧 `onExit` 用控制消息而非 python 进程自己的退出码。
- **方案 B**：`script -q -f -e -c "stty rows R cols C 2>/dev/null; exec '<shell>' ..." /dev/null`，`-e` 回传子进程退出码；shell 路径用 `posixQuote` 防止 `-c` 的二次 shell 解析注入；`detached` + 进程组回收避免留下孤儿 shell。

生产化改动（不在本卡范围）：`PYTHON_BRIDGE_SOURCE` 现在以 JS 字符串常量内联，接入 `packages/server` 时用 esbuild `loader: {'.py':'text'}` 或直接保留模板字符串，随 `qn-server.cjs` 一起打包；`spawnPty` 的 IO 与 `control.mjs` / `termBuffer.mjs` 的纯逻辑已分离，后者单测覆盖。

### 2.2 运行方式

```bash
bash spikes/terminal/run-remote.sh measure       # 93 全量实测
bash spikes/terminal/run-remote.sh demo          # 93 交互式（ssh -t）
bash spikes/terminal/run-remote.sh demo-auto     # 非交互验收 demo.mjs（ssh -tt）
bash spikes/terminal/run-remote.sh smoke python # 最小冒烟
QN_SPIKE_ONLY='中文 UTF-8,Ctrl+C' bash spikes/terminal/run-remote.sh measure
```

`run-remote.sh` 用 `mktemp -d /tmp/qn-spike-XXXXXXXX`，经 `tar`/ssh stdin 上传 `.mjs`，退出（含 SIGTERM）时 `rm -rf`。实测结束后 93 上无残留目录与进程（已核对）。

### 2.3 已发现并修正的坑（对落地有价值）

1. **Ctrl+C 的两个时序坑**：bash readline 在 SIGINT 时丢弃 typeahead（Ctrl+C 后立刻写命令会被吞）；而发 ^C 过早会落在命令行尾部而非前台进程组，偶发让 `script` 兜底的 shell 直接结束。原型在 sleep 启动后等 150 ms 再发 ^C，之后按 150 ms 间隔重试标记命令；连跑 3 次稳定通过。
2. **`script` 兜底的进程树**：`script` 里的 shell 是独立会话，`child.kill()` 可能留下孤儿；原型用 `detached` + `process.kill(-pid)` 整组回收。
3. **stdin EOF ≠ 终端结束**：与 `connect --stdio` 的「任一端 EOF 即退出」不同，托管终端必须在 daemon 里活过客户端断线。
4. **`python3 -c` 里的 `pty.fork` 子进程会继承 fd 3**：必须在 exec 前 `os.close(3)`，否则控制通道不关闭、父进程无法感知宿主退出。
5. **`SIGWINCH` 只发给 shell 不够**：全屏程序在前台进程组，必须 `tcgetpgrp(master)`；实测 Python curses 的 `KEY_RESIZE` 能收到。
6. **Windows/无 TTY 场景 `getWindowSize()` 可能返回 0x0**：不能把它当合法尺寸下发（会被 clamp 成 1x1）。

## 3. 93 实测数据

### 3.1 环境

| 项 | 值 |
|---|---|
| 主机 | `192.168.10.93`，Ubuntu 26.04 LTS，`Linux 7.0.0-44-generic` |
| Node | v26.13.0 |
| **python3** | **Python 3.14.4**（`/usr/bin/python3`，`pty/fcntl/termios/select` 均可用） |
| **script** | **script from util-linux 2.41.3**（`-q/--quiet -f/--flush -e/--return -c/--command` 齐全） |
| bash / locale / TERM | GNU bash 5.3.9 / `en_US.UTF-8` / `xterm-256color` |
| 全屏程序 | `less`、`vi`（`readlink -f` → `/usr/bin/vim.tiny`，vim 家族）、`nano`、`top` 已装；**`vim`（完整版）、`htop` 未装**（按约束不安装，4 项跳过）；另用 Python `curses` 自写全屏程序验证 KEY_RESIZE |

### 3.2 功能矩阵

| 用例 | 方案 A（python3） | 方案 B（script） |
|---|---|---|
| 中文 UTF-8 | 通过（`中文测试 ✓ Ω` 原始字节无损，输出 245 B） | 通过（275 B） |
| Ctrl+C | 通过：`sleep 30` 被中断、`NOINT` 未出现、shell 存活，回到可输入 152 ms | 通过（151 ms） |
| resize | 通过：`stty size` 24x80 → **40x120**，控制通道回 `resized`、bash `trap WINCH` 触发 | **不支持**：`resize()` 返回 false，尺寸保持 24x80（启动 `stty` 设定的初值） |
| 全屏 + resize | Python curses 收到 `KEY_RESIZE`（132x43）、交替屏转义 `\x1b[?1049h` | 不支持 resize，其余全屏表现一致 |
| `exit 7` 退出码 | 7（控制通道 `source:control`） | 7（`-e`，`source:process`） |
| 10 MB 输出 | 10,485,958 B / 61.49 ms ≈ **170.5 MB/s**（162.6 MiB/s） | 10,485,996 B / 64.00 ms ≈ **163.8 MB/s**（156.3 MiB/s） |
| 往返延迟 | shell P50 **0.16 ms** / P95 0.35 ms；控制通道 ping-pong P50 **0.05 ms** | shell P50 **0.13 ms** / P95 0.22 ms；无控制通道 |
| 探测顺序 | `auto → python`，显式 `script` 时 `resize()===false`，两者缺失报明确错误 | 同左 |

> 口径说明：吞吐/延迟是 **93 本机 Node ↔ Python 桥 ↔ PTY** 的测量，不含 SSH、JSON 帧编码与渲染（端到端会低得多，见 §7）。10 MB 用 `dd | tr '\0' 'x'` 产生不含换行的字节，避免 PTY `ONLCR` 把数据放大。全屏 `quitMs` 含原型 250 ms 重试间隔，不是程序真实退出耗时。

### 3.3 全屏程序逐项

| 程序 | 交替屏/光标控制序列 | 进入耗时 | 退出后回到 shell |
|---|---|---|---|
| `less -R` | 是 | 1.04 ms | 是 |
| `vi -u NONE -n`（vim.tiny） | 是 | 1.58 ms | 是（`:q!`） |
| `nano -w` | 是 | 1.62 ms | 是（Ctrl+X） |
| `top -d 1` | 是 | 211 ms（首次采样间隔） | 是 |
| Python curses（含中文/尺寸） | 是 | 7.69 ms | 是；resize 后收到 `KEY_RESIZE` |
| `vim` / `htop` | — | 93 未安装，按约束跳过 | — |

汇总：`27` 个用例，`23` 通过、`0` 失败、`4` 跳过。原始 JSON：`spikes/terminal/results/93-measurements.json`（随仓库留存）；诊断日志 `spikes/terminal/results/93-measure.log` 只在本地生成，被根 `.gitignore` 的 `*.log` 忽略。

## 4. 本机 Windows / ConPTY 调研（不下载、不安装）

### 4.1 本机已核实的事实

| 事实 | 数值 / 来源 |
|---|---|
| Electron 版本与 Node ABI | `ELECTRON_RUN_AS_NODE=1 electron.exe -p process.versions` → Electron **45.5.0**、Node **24.22.3**、**NODE_MODULE_VERSION 150**、**napi 10** |
| 本机独立 Node ABI | Node 24.18.0 → `modules 137`（**与 Electron 150 不同**）→ 为普通 Node 编译的 NAN 插件不能直接在 Electron utilityProcess 里加载；N-API（≤10）插件则可以 |
| 本机 Windows | `10.0.28000.1896`，ConPTY（需 ≥ 10.0.17763）可用 |
| `qn-server.cjs` | esbuild 单文件（观测时约 2.9 MB），`external: ['@anthropic-ai/claude-agent-sdk-*']`；原生 `.node` 无法塞进单文件，且要 SFTP 上传到远端 |
| 打包配置 | `apps/desktop/electron-builder.yml`：`npmRebuild:false`、`nodeGypRebuild:false`、`extraResources: resources/server`、`asarUnpack` 已有 ssh2/cpu-features 条目 |
| 现有依赖 | `node_modules/.pnpm` 中**没有** `node-pty` / `@lydell/node-pty` / `winpty` / `conpty`；旧项目 `D:\code\qingcode` 用 Rust `portable-pty 0.8`（Windows 走 ConPTY），并用 base64 传 PTY 字节、32 KiB 合并 |
| 远端 | 93 实测证明远端**完全不需要** Windows 原生模块 |

### 4.2 「纯 Node 无法直接调 ConPTY」是否成立

**成立（限定为：只用 Node 内置模块 + 纯 JS）。** 理由：

- ConPTY 是 Win32 API：`CreatePseudoConsole` / `ResizePseudoConsole` / `ClosePseudoConsole`，并且启动子进程时必须通过 `InitializeProcThreadAttributeList` + `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE)` 把 HPCON 传给 `CreateProcessW`（`EXTENDED_STARTUPINFO_PRESENT`）。
- Node 内置模块没有 FFI，也不暴露进程线程属性；`node:child_process.spawn` 无法传 HPCON。能做的 `conhost.exe`/`OpenConsole.exe --headless` 之类「借用系统二进制」路径，未见可信的本机验证，不作为推荐。
- 因此只有三类可行路径：**(a)** N-API/NAN 原生插件（node-pty 系）；**(b)** 外部 helper 进程（PowerShell `Add-Type` P/Invoke Win32，Windows 自带、无需联网，但要维护一份 C# P/Invoke 与管道协议）；**(c)** 依赖目标机已有 Python + `pywinpty`（不保证存在）。

### 4.3 候选对比（体积为「按已有知识估计」，本机未安装、按约束未下载）

| 路径 | ABI 兼容 | 体积 | 分发 | 判断 |
|---|---|---|---|---|
| `node-pty`（Microsoft） | 原生插件按 V8/Node ABI 编译；Electron 45 ABI 150 与本机 Node 137 不同，需 `electron-rebuild` 或 Electron headers（需要联网/构建链） | 估计 1–3 MB（含 winpty-agent / ConPTY 支持） | 必须 `asarUnpack`，`.node` 不能在 asar 内加载 | 可行但构建链与 `npmRebuild:false` 冲突，风险高 |
| `@lydell/node-pty`（预编译平台包 + 据称基于 N-API） | 若为 N-API 且 `napi ≤ 10`，可跨 Node/Electron ABI；**必须实测** | 估计每平台 1–5 MB（平台包体积**未实测**） | 平台包随 `extraResources`/`asarUnpack` 分发；`npmRebuild:false` 正好适配「不重编译」 | **首选待验证** |
| `@homebridge/node-pty-prebuilt-multiarch` 等预编译 fork | 需核对与 Electron 45 的 ABI 对应关系 | 未实测 | 同上 | 备选 |
| PowerShell `Add-Type` P/Invoke helper | 无 ABI 问题（外部进程） | 0 依赖（Windows 自带） | 随包放一份 `.ps1` | 无原生依赖但需自己实现 ConPTY 管道、resize、退出码，维护成本高；作为兜底方案 |
| `winpty`（旧方案） | 外部二进制 | 未实测 | 同 native | 隐藏控制台轮询屏幕缓冲，Unicode/resize/性能差，不推荐 |

### 4.4 建议的分发方式（需总管验证）

1. 只给**本机 Windows daemon** 加原生能力，远端 `qn-server.cjs` 保持纯 JS；Python 桥源码内联，Windows 分支通过 `process.platform` 选择 ConPTY 后端。
2. 依赖加入 `@qn/desktop`（不是 `@qn/server`），esbuild 对该包 `external`；打包时把 `.node` 与平台包放到 `resources/`，`asarUnpack` 增加对应 glob，**不要**塞进 `qn-server.cjs`。
3. daemon 用 `createRequire(path.join(process.resourcesPath, 'app.asar.unpacked', ...))` 按绝对路径加载，backend 通过 env/启动参数把该路径传给 daemon（本机 daemon 由 `ELECTRON_RUN_AS_NODE=1 electron.exe qn-server.cjs ensure` 拉起）。
4. 验收机 10.87（Windows，Claude Code 已登录）上验证：插件能否在 Electron 45 utilityProcess 加载、`cmd`/PowerShell/`claude` 交互、中文、resize、Ctrl+C、退出码、安装包 NSIS 后路径是否仍可解析。

**需总管安装/验证清单**（本卡不下载、不装）：

- 安装 `@lydell/node-pty`（或其替代）并给出：实际包体积/平台包清单、使用的 N-API 版本、许可证、是否含需联网下载的 `prebuild-install` 步骤。
- 在 Electron 45.5.0 的 `ELECTRON_RUN_AS_NODE=1` 下 `require()` 一次，确认 ABI 150 / napi 10 可用；若失败，退到 PowerShell P/Invoke helper 方案。
- 渲染端还需 `xterm`/`@xterm/*`（旧项目已用过；本仓库目前没有），以及 `@xterm/addon-serialize` 用于快照——同样需总管安装。

## 5. 断线接回设计

### 5.1 与现有 `ReplayBuffer` 的关系

`packages/server/src/replayBuffer.ts` 是**每个 agent 一份**的 JSON 消息环形缓冲（20000 条 / 32 MiB，`since(sinceSeq)` 返回 `truncated`），配合 `codex.attach {sinceSeq}`。终端不能照搬：

- 终端输出是**任意字节**（含非法 UTF-8、ANSI 转义），不能当 JSON 文本存；
- 每个终端要有**独立 seq**（多标签），缓冲按**原始字节**限额，而不是 JSON 序列化后的字节；
- 终端只需要「补发断开期间的输出」，不需要把历史消息永久广播给所有客户端。

因此用 `spikes/terminal/termBuffer.mjs` 的模型：`TermOutputBuffer`（默认 2 MiB 原始字节 / 4096 块，`append(bytes) → {seq, data:base64}`，`since(seq) → {chunks, lastSeq, truncated, bytes}`），`truncated` 语义与 `ReplayBuffer` 一致；纯逻辑已有 21 个 vitest 用例覆盖（含非法 UTF-8 还原、淘汰、断点判定）。

### 5.2 快照 vs 环形缓冲

| 方案 | 能重建屏幕？ | 代价 |
|---|---|---|
| 仅环形缓冲回放 | **不能**：光标位置、SGR、滚动区、交替屏、滚动历史都是有状态解析，断线时客户端可能已无状态；缓冲截断后更不行 | 最省事，但 `cat` 大输出或长时间运行后接回必然错屏 |
| 仅屏幕快照 | 能恢复当前画面，快照之后的增量仍需要 | 需要渲染端序列化（`@xterm/addon-serialize`），快照 ≤ 512 KiB，daemon 常驻内存 |
| **混合（推荐）** | 能 | daemon 存每终端「最近快照 + seq 环形缓冲」，客户端 attach 时先按 `planAttach` 决策 |

`planAttach(replay, {hasSnapshot, sinceSeq})` 三态（已在 spike 实现并单测）：

- `replay`：缓冲未截断 → 只补发 `seq > sinceSeq` 的分块；
- `snapshot`：缓冲已截断但有快照 → 下发快照 + 断点后增量；
- `resync`：都没有 → 清屏后从最新输出继续，UI 明确提示「历史输出已丢失」。

### 5.3 生命周期（与 daemon 现状的冲突点）

- 终端进程由 **daemon** 持有（与「客户端断开不影响进行中的 turn」同构），`clientId` 只管理订阅集合；`std::` 的 stdin EOF 不结束终端（§2.1）。
- daemon 的 30 分钟空闲退出判定目前只看 `clients.size === 0 && activeTurns === 0`；**必须把「活跃终端」计入**，否则有终端时 daemon 也会被回收。建议 `term.open` 维持引用计数，`term.close`/进程退出才释放；或给有终端的 daemon 单独设更长 TTL。
- `server.shutdown`（`ensure --replace` 升级用）会杀掉所有终端，破坏「升级后接回」。旧版用**按构建版本分目录的 PTY 宿主**（`hosts/<stamp>`，旧宿主只接回自己的终端、全部结束后空闲退出）解决；Next 可沿用：版本切换时保留旧 daemon 的终端，新终端进新 daemon，或升级前要求 `term.close` 并提示用户。
- `term.attach` 只对**订阅了该 termId 的连接**下发 `evt term.data`（daemon 现有 `ClientSession.attached: Set<AgentKind>` 可扩一个 `Set<string>`），避免多标签互相灌数据。

## 6. 协议草案（`docs/mvp.md` §4 扩展，待总管定稿）

### 6.1 req 方法

| method | params | result / 说明 |
|---|---|---|
| `term.open` | `{termId?, cwd, shell?, args?, cols, rows, env?, backend?}` | `{termId, pid, lastSeq, backend, supportsResize, created}`；同 termId 已存在则 `created:false`（接回而非新建）；`cwd` 必须绝对路径 |
| `term.write` | `{termId, data /* base64 */}` | `{acceptedBytes}`；单次上限 1 MiB，超限 `term_input_too_large`；写入队列积压返回 `term_backpressure` |
| `term.resize` | `{termId, cols, rows}` | `{applied:boolean}`；方案 B 返回 `false` 并广播原因，UI 显示「当前后端不支持改变窗口大小」 |
| `term.close` | `{termId}` | `{}`；终止会话并释放缓冲；已退出时幂等 |
| `term.attach` | `{termId, sinceSeq}` | `{lastSeq, truncated, chunks:[{seq, data /* base64 */}], snapshot?, cols, rows, alive, exit?}`；`snapshot` 为序列化终端状态（base64），无则省略 |
| `term.list` | — | `[{termId, cwd, shell, pid, alive, lastSeq, cols, rows, startedAt, backend}]`；客户端重连后据此恢复标签 |

### 6.2 evt

| name | payload |
|---|---|
| `term.data` | `{termId, seq, data /* base64 */}`；只广播给订阅该 termId 的连接；每块原始字节 ≤ 32 KiB 后合并发送 |
| `term.exit` | `{termId, code, signal}` |
| `term.resized` | `{termId, cols, rows, by}`（另一个客户端改尺寸时同步） |
| `term.error` | `{termId, code, message}`（如 `pty_unavailable`） |

错误码：`pty_unavailable`、`term_not_found`、`term_exists`、`term_backpressure`、`term_input_too_large`、`term_resize_unsupported`、`term_spawn_failed`。

### 6.3 消息示例

```json
{"t":"req","id":12,"method":"term.write","params":{"termId":"t1","data":"ZWNobyBoaQo="}}
{"t":"evt","name":"term.data","payload":{"termId":"t1","seq":41,"data":"..."}}
{"t":"req","id":13,"method":"term.attach","params":{"termId":"t1","sinceSeq":38}}
{"t":"res","id":13,"ok":true,"result":{"lastSeq":41,"truncated":false,"chunks":[],"snapshot":null,"cols":120,"rows":40,"alive":true}}
```

### 6.4 二进制帧：不需要（首期）

- 现有帧是「4 字节大端长度 + UTF-8 JSON」，上限 16 MiB（`packages/protocol/src/frame.ts`）。PTY 字节可能非法 UTF-8，**不能直接放进 JSON 字符串**；base64 是最小改动，开销 4/3。
- 10 MiB 原始字节 → 约 13.3 MiB base64，理论上仍能塞进一帧，但**必须按 32 KiB 原始字节分块**（旧版 `TERMINAL_EMIT_COALESCE_MAX = 32 KiB`），否则大输出会队头阻塞 resize/输入，并逼近帧上限；分块后用 `seq` 保证顺序与接回。
- backend → renderer 的 MessagePort 本来就能传 `ArrayBuffer`（结构化克隆），但 server → backend 这一段是 JSON 帧，手机网关是 NDJSON，统一 base64 最省事，也避免三套编解码。
- 若将来实测带宽成为瓶颈，再考虑在 4 字节长度头的高位加类型位表示二进制帧；那时 `packages/protocol` 的 `FrameDecoder`、`connect --stdio`、backend MessagePort、手机网关 NDJSON 都要改，属于单独任务。

### 6.5 安全

- `term.open` 等价于**在目标上执行任意命令**：只允许通过已鉴权的本地 IPC（token）+ 目标连接访问；`cwd`/`shell`/`args` 用 argv 数组传，绝不用字符串拼 shell（`posixQuote` 仅用于 `script -c` 兜底）。
- **首期不把 `term.*` 放进手机网关白名单**（`docs/mvp.md` §9.2 白名单、`docs/roadmap.md` §7.5）；后续若开放手机端终端，先只放 `term.list`/`term.attach` 只读接回，写入需桌面端显式授权。
- 终端输出/输入可能含密码、token：**不写 daemon 日志、不进错误 message**；stderr 只保留桥自身的诊断；回放缓冲只存内存，不落盘。
- `env` 由客户端传入时不得覆盖 daemon 自己的安全相关变量（如 token 路径），生产实现应做白名单。

## 7. 风险与未验证项

| 风险 | 影响 / 缓解 |
|---|---|
| 远端 python3 缺失或 `pty` 模块被裁剪（极简容器、Alpine） | 探测失败 → B 兜底；B 也缺 → `pty_unavailable`，UI 明确提示「远端需要 python3 或 util-linux script」，不静默失败 |
| `script` 是 BSD 版（macOS）缺 `-e/-f` | 探测 `--help` 里的 `--return/--flush/--command/--quiet`，缺则判不可用 |
| 方案 B 无法运行时 resize | UI 置灰尺寸变化提示；折中：`stty` 设初始尺寸，或关闭并重启终端（会丢会话） |
| 每个终端多一个 python 进程 + fd 3 socket | 单机几十个标签可控；必须做进程组回收与空闲超时，避免孤儿（原型已验证 `kill` 后无残留） |
| 实测吞吐/延迟不含 SSH + JSON/base64 + 渲染 | 约 164–171 MB/s 是本机 PTY 上限，不代表端到端；落地前应在「93 → backend → renderer」链路上再测一次，尤其是大输出时 `term.write` 输入的背压 |
| 缓冲截断后的接回 | 依赖快照；快照序列化插件需总管安装，未做端到端验证 |
| Windows ConPTY | 本卡**未实测**（不下载不安装）：ABI、包体积、许可证、NSIS 分发、10.87 上的实际交互均待 §4.4 清单验证 |
| `vim`/`htop` 未在 93 安装 | 4 项跳过；已用 `vi`(vim.tiny)/`nano`/`top`/`less`/Python curses 覆盖全屏与 resize，结论不受影响 |
| `screen` 等自带 pty 的程序 | 未测（嵌套 pty 会自己再分配会话）；落地时需补测 |
| daemon 升级 / 空闲退出 | 见 §5.3，需产品代码改动，本卡未动 |

## 8. 后续任务拆分建议

| 卡 | 内容 | 范围 | 依赖 |
|---|---|---|---|
| T22 | `term.*` 协议类型 + server `workspace/term/` 处理函数 + PTY 宿主抽象（A/B/ConPTY 三后端接口）+ daemon 生命周期（引用计数、订阅集合） | `packages/protocol`、`packages/server` | 本报告；把 spike 的 `termBuffer.mjs` / `control.mjs` 迁为 TS 并保留单测 |
| T23 | 远端 A/B 落地：内联 Python 源码进 `qn-server.cjs`（esbuild text loader）、探测与错误码、端到端 e2e（假 PTY + 真 shell） | `packages/server` | T22 |
| T24 | 本机 Windows ConPTY：`@lydell/node-pty` 安装与 Electron 45 ABI 实测、NSIS `asarUnpack/extraResources`、10.87 验收；失败则 PowerShell P/Invoke helper | `apps/desktop`、`packages/server`（Windows 分支） | 总管装依赖（§4.4） |
| T25 | 渲染端终端 UI：xterm + 多标签、resize/复制粘贴/链接、32 KiB 合并、审批无关、手机只读视图（可选） | `apps/desktop/src/renderer`、`apps/mobile/web` | T22/T23、总管装 `@xterm/*` |
| T26 | 接回：快照序列化、断线重连 `term.attach`、缓冲截断提示、daemon 版本化宿主 / 升级不丢终端 | `packages/server`、渲染端、手机网关白名单 | T22/T25 |

建议 T23 与 T24 并行（远端不被 Windows 依赖阻塞），T25 可先用 mock server 起步。

## 9. 假设与约束

1. 远端目标都是 POSIX Linux（Windows 远端在 MVP 之后），具备 `python3` 或 util-linux `script`；本机是 Windows 10/11 + Electron 45。
2. `qn-server.cjs` 继续作为单文件经 SFTP 上传，Python 桥以字符串内联，不新增远端文件；`script`/`python3`/`stty` 都来自目标机已有软件，不安装任何东西。
3. 首期终端只在桌面端可写；手机端按 `docs/roadmap.md` §7.5 暂不开放文件/Git，终端写能力也默认不放行。
4. 协议草案是**建议**，未写入 `docs/mvp.md`；`term.*` 与 `evt term.*` 需总管定稿后回填 §4/§5，backend 的 `server.req` 已透传、原则上无需改。
5. 一个 termId = 一个 PTY 会话；多标签由多个 termId 实现；同一终端的多个客户端订阅都收到 `term.data`，输入不做仲裁（首个写入生效）。
6. 体积/ABI 相关数字中，Electron/Node/打包配置是本机实测，第三方包体积与 N-API 版本是「已有知识估计」，明确标注为待验证。
7. 实测数据来自 93 的两次全量运行（数值略有波动，本报告取最后一次），原始 JSON 已留存；远程临时目录与进程已清理。

## 10. 自检

| 命令 | 结果 |
|---|---|
| `pnpm exec tsc -p spikes/terminal/tsconfig.json` | 通过（0 错误） |
| `pnpm exec vitest run --config spikes/terminal/vitest.config.mts spikes/terminal` | 2 个测试文件 / 21 个用例全部通过 |
| `bash spikes/terminal/run-remote.sh measure` | 23 通过 / 0 失败 / 4 跳过（vim、htop 未安装） |
| `bash spikes/terminal/run-remote.sh smoke python` / `smoke script` | 均 `ok:true`，退出码 5、resize 分别 true/false |
| `bash spikes/terminal/run-remote.sh demo-auto` | `QN_DEMO_42` 输出、PID/后端诊断、`exit 0`，ssh 会话正常关闭 |
| 93 清理检查 | `/tmp/qn-spike-*` 无残留、无遗留进程 |

> 注：根 `vitest.config.ts` 的 `include` 只覆盖 `packages/*/src` 与 `apps/*/src`，所以 spike 的测试必须带 `--config spikes/terminal/vitest.config.mts`；未改根配置（本卡范围外）。
