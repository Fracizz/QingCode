# T21 终端 spike（纯 Node，无原生依赖）

远端 Linux 的 PTY 原型与 93 实测脚本。结论见 `docs/spikes/terminal.md`。

## 文件

| 文件 | 作用 |
|---|---|
| `pythonBridge.mjs` | 方案 A 的 Python 内联桥源码（`pty.fork` + `select` + fd 3 控制通道） |
| `pty.mjs` | `spawnPty({shell, cols, rows, cwd, env})` → `{onData, write, resize, kill, onExit}`，含 A/B 两种后端 |
| `probe.mjs` | python3 / script 能力探测（同步 + 异步） |
| `control.mjs` | 纯逻辑：JSON 控制行编解码、尺寸规整、后端选择、POSIX 引号 |
| `termBuffer.mjs` | 纯逻辑：终端输出 seq 环形缓冲 + 接回决策（快照 / 回放 / resync） |
| `demo.mjs` | 交互式终端（`ssh -t`，raw stdin，窗口变化自动 resize） |
| `smoke.mjs` | 最小冒烟：stdout/控制通道/resize/退出码 |
| `debug.mjs` | 一次性诊断脚本：打印连续命令的 PTY 原始输出 |
| `measure.mjs` | 93 自动实测，结果 JSON 打到 stdout |
| `run-remote.sh` | 上传 → 运行 → 回收；只在 `/tmp/qn-spike-XXXXXXXX` 下操作 |
| `results/` | 实测原始 JSON 与诊断日志 |
| `*.test.ts` / `tsconfig.json` / `vitest.config.mts` | 纯逻辑单测与自检配置 |

## 运行

```bash
# 93 上完整实测（自动创建并删除临时目录）
bash spikes/terminal/run-remote.sh measure
# 只跑部分用例
QN_SPIKE_ONLY='中文 UTF-8,Ctrl+C' bash spikes/terminal/run-remote.sh measure

# 交互式原型（需要本地 TTY）
bash spikes/terminal/run-remote.sh demo

# 非交互验收 demo.mjs（ssh -tt 强制分配 pty）
bash spikes/terminal/run-remote.sh demo-auto

# 冒烟 / 诊断
bash spikes/terminal/run-remote.sh smoke python
bash spikes/terminal/run-remote.sh smoke script
bash spikes/terminal/run-remote.sh debug python
```

`QN_SPIKE_HOST` 可覆盖主机（默认 `root@192.168.10.93`）。所有远端文件经 `tar`/ssh stdin 传入，
不安装软件、不改系统配置，脚本退出（含 SIGTERM）时删除临时目录。

也可直接在 Linux 本机跑：

```bash
node spikes/terminal/demo.mjs --backend=python --shell=/bin/bash --cols=120 --rows=40
node spikes/terminal/measure.mjs > report.json
```

## 自检

```bash
pnpm exec tsc -p spikes/terminal/tsconfig.json
pnpm exec vitest run --config spikes/terminal/vitest.config.mts spikes/terminal
```

根 `vitest.config.ts` 的 include 不覆盖 `spikes/`，必须带 `--config`。
