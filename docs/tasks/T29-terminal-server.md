# T29 终端（server 端）：协议、daemon 托管、远端 python3 pty、断线接回

范围：
- 新增 `packages/server/src/terminal/**`（含测试）。
- `packages/protocol/src/workspace.ts` 只**追加** `term.*` 的 params/result/事件类型与 `WorkspaceMethods` 条目（编辑前先重新读取：T26 也在追加 `run.*`）。
- `packages/server/src/workspace/index.ts` 合并登记一行（先重新读取）。
- `packages/server/src/daemon.ts`：只做必要的最小改动——空闲退出判定计入活跃终端、`term.data` 只发给订阅了该 termId 的连接、连接关闭时取消订阅（不关终端）。
- 不改桌面端、手机端、网关（**不得**把 `term.*` 加进手机网关白名单）。

依据：`docs/spikes/terminal.md`（**全文**，尤其 §1 结论、§2 原型、§5 断线接回、§6 协议草案、§6.5 安全、§7 风险）、`docs/mvp.md` §4（帧格式、16 MiB 上限）、`docs/roadmap.md` §7.4。现有 workspace 分发模式参考 `packages/server/src/workspace/fs/search.ts`（`ctx.emit`、`ctx.onClose`）。

实现：
1. 协议按 spike §6.1/§6.2 定稿：`term.open/write/resize/close/attach/list` 与事件 `term.data/exit/resized/error`。数据一律 base64。若与 spike 草案有出入，以简单可行为准并在报告中列出。
2. 后端：
   - A（主）：POSIX 上 `spawn('python3', ['-I', '-c', <内联源码>])`，用标准库 `pty.fork`、`TIOCSWINSZ`、`select` 转发；尺寸调整经控制通道（如额外 fd 或带前缀的控制帧，按 spike 原型）。
   - B（兜底）：无 python3 时用 `script -qfc`（不支持 resize，`supportsResize:false`）。
   - Windows：本卡不实现，`term.open` 返回错误码 `pty_unavailable`（T31 用 node-pty 补）；结构上留好后端接口，便于 T31 接入。
   - shell 默认取 `$SHELL`，否则 `/bin/sh`；`cwd` 必须绝对路径；argv 数组传参，不拼 shell 字符串。
3. 托管与接回：终端归 daemon 所有，与连接解耦；每终端保存 seq 环形缓冲（按字节上限，如 2 MiB）+ `truncated` 标记；`term.attach {sinceSeq}` 返回缺失块；输出按 ≤32 KiB 合并、短时间节流后发送。终端退出后保留缓冲一段时间供接回（如 10 分钟），之后清理。
4. 背压：`term.write` 单次上限 1 MiB（`term_input_too_large`）；写队列积压返回 `term_backpressure`。
5. 纯逻辑（环形缓冲、seq/attach 计划、输出合并、参数校验、后端选择）与 IO 分离，写 vitest 单测；pty 集成测试在无 python3 或 Windows 上 `skip`。

验收：`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec tsc -p packages/protocol/tsconfig.json`、`pnpm exec vitest run packages/server/src/terminal packages/server/src/workspace packages/protocol` 通过；`node packages/server/build.mjs` 成功（单文件，不得引入原生模块）。可以用 `ssh root@192.168.10.93`（已授权免密）在 93 上手动跑集成测试或脚本验证 python3 pty（只在 `/tmp` 下操作，不改系统），把结果写进报告。
