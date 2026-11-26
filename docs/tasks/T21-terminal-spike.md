# T21 终端技术验证（spike）

范围：只新增 `spikes/terminal/**` 与 `docs/spikes/terminal.md`。不改任何产品代码。

背景：`docs/roadmap.md` §5 P2。远端 qn-server 是 esbuild 打成的单文件 Node 程序（`packages/server/build.mjs`），经 SFTP 上传到远端运行，无法直接携带 `node-pty` 等原生模块；本机 server 在 Windows 上用 Electron 的 Node 运行（`ELECTRON_RUN_AS_NODE`）。

目标：给出远端（Linux）与本机（Windows）PTY 方案的可行性结论与推荐，产出可运行原型。

1. 远端 Linux 原型（纯 Node，无原生依赖）：
   - 方案 A：`python3` 内联 pty 桥（`pty.fork` + select 转发 stdin/stdout；resize 经额外管道 fd 3 传 JSON 行，Python 端 `fcntl.ioctl(TIOCSWINSZ)` + SIGWINCH）；Node 端封装 `spawnPty({shell, cols, rows, cwd, env})` → `{onData, write, resize, kill, onExit}`。
   - 方案 B：`script -qfec <shell> /dev/null` 兜底（说明无法 resize 的限制，或折中办法）。
   - 探测逻辑：按顺序选择 A/B，均不可用时报明确错误。
   - 在 93 上实测（`ssh root@192.168.10.93`，本机已授权免密；只在 `/tmp/qn-spike-<随机>` 下操作，结束后删除，不安装任何软件、不改系统配置）：vim/htop/less 全屏程序、中文、Ctrl+C、resize、`exit` 退出码、10 MB 输出吞吐与延迟；记录 93 的 python3 与 `script` 版本。
2. 本机 Windows：调研 ConPTY 可选路径（`node-pty` / `@lydell/node-pty` 预编译包的体积、Electron ABI 兼容、随安装包分发方式；"纯 Node 无法直接调 ConPTY"是否成立）。**不要下载安装**，基于已有知识与本机已有 node_modules 判断，列出需总管安装验证的事项。
3. 断线接回：结合 server 现有 seq 缓冲（`packages/server/src/replayBuffer.ts`）给出终端输出缓冲与接回设计（快照 vs 环形缓冲；协议草案 `term.open/term.write/term.resize/term.close/term.attach` 与 `evt term.data`，是否需要二进制帧）。
4. `docs/spikes/terminal.md`：结论、推荐方案、实测数据、风险、协议草案、后续任务拆分建议。

验收：原型可在 93 上用 `node spikes/terminal/demo.mjs`（或等价命令）交互运行；报告完整。
