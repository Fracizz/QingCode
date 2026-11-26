# T4 常驻 server packages/server

范围：只改 `packages/server/**`（含 `build.mjs`、`test/` 下的假 codex 脚本）。只用 Node 内置模块 + `@qn/protocol`（已实现，先读 `packages/protocol/src/index.ts` 的导出）。目标 Node ≥ 18（远端），本机由 Electron 45 的 Node 运行。

依据：`docs/mvp.md` §3、§4（逐条实现，命令行、运行目录、单实例、退出策略、中继语义都按文档）。参考旧项目设计思路（只读）：`D:\code\qingcode\src-tauri\qingcode-server\src\connect.rs`、`daemon.rs`、`ipc.rs` 的模块注释。

## 结构建议

- `src/main.ts`：CLI 入口（`version` / `ensure` / `daemon` / `connect --stdio`），解析 `--state-dir`、`--replace`。
- `src/paths.ts`：state dir、socket/管道名、token 文件；POSIX 建目录 0700、token 0600。
- `src/daemon.ts`：IPC 监听、单实例、客户端会话（hello 校验 token 与 protocol，错误发 `error` 后断开）、req 分发、空闲退出、日志（不记 token）。
- `src/codexHost.ts`：codex 子进程管理与中继（纯逻辑尽量抽出来单测）：
  - `IdMapper`：客户端请求 id ↔ daemon 侧 id；
  - `ReplayBuffer`：seq 递增、条数/字节双上限、`since(seq)` 返回 `{messages, truncated}`；
  - 未决 server request 表：第一个响应生效，其余忽略；新客户端 attach 时随回放下发；
  - activeTurns 统计（`turn/started` +1、`turn/completed` −1，codex 退出清零）。
  - stdout 按行解析 JSON（codex app-server 是 JSONL），stderr 写日志。
- `src/connect.ts`：stdio ↔ IPC 透明桥接，任一端结束即退出；Windows 命名管道注意读写并发（用 `net.connect` 的异步 socket 即可）。
- `src/ensure.ts`：读 `daemon.json` + 尝试连接 + `ping`；不在则 `spawn(process.execPath, [脚本路径, 'daemon', ...], { detached:true, stdio:'ignore', windowsHide:true }).unref()`，轮询就绪 ≤10s；`--replace` 语义按文档。注意本机由 Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行，spawn 子 daemon 时要保留该环境变量。
- `src/fs.ts`：`fs.home`、`fs.list`。
- `build.mjs`：esbuild 打包 `src/main.ts` → `../../apps/desktop/resources/server/qn-server.cjs`（platform node、target node18、format cjs、单文件、banner 带版本），同时写 `qn-server.json`：`{version, sha256}`。版本取 `packages/server/package.json`。

## 测试

- 单测：IdMapper、ReplayBuffer（含截断）、未决请求、hello 校验、参数解析、paths。
- 端到端 `src/e2e.test.ts`：临时 state dir；`test/fake-codex.mjs`（读 stdin JSONL：回应 initialize、对 `thread/start` 返回固定结果并依次发 `turn/started`、`item/agentMessage/delta`、一个 `item/commandExecution/requestApproval` server request，收到响应后发 `turn/completed`）；用 tsx 不可用的话先 `node build.mjs` 再对打包产物测试（可在测试里调用 esbuild 的 JS API 打包到临时目录）。覆盖：ensure 拉起 → connect --stdio 子进程 → hello/welcome → codex.open（codexPath 指向 `node fake-codex.mjs` 的包装，例如支持 `codexPath` 为 JSON 数组 `[node, script]` 或新增 `codexArgs` 参数，自行选择并写进报告）→ 请求转发与 id 还原 → 通知广播 → 审批第一响应生效 → 断开后重连 `codex.attach{sinceSeq}` 收到漏掉的消息 → token 错误被拒 → 第二个 daemon 实例自动退出。Windows 与 POSIX 路径都要能跑（本机是 Windows，测试在 Windows 上跑命名管道）。

## 验收

`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec vitest run packages/server`、`pnpm build:server` 全部通过；报告里写清 `codex.open` 测试钩子的设计。
