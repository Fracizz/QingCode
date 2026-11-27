# T26 运行配置（兼容旧版 `.qingcode/run.json`）

范围：
- 新增 `packages/server/src/workspace/run/**`（含测试），在 `packages/server/src/workspace/index.ts` 合并登记一行（先重新读取）；`packages/protocol/src/workspace.ts` 只追加 `run.*` 类型（先重新读取，T24 也可能追加字段）。
- 新增 `apps/desktop/src/renderer/src/features/run/**`（含测试）。不改其他已有渲染文件（接入停靠栏由总管完成，你只导出 `RunPanel`）。

依据：旧版实现（只读参考，不得修改）：`D:\code\qingcode\src\store\runConfigStore.ts`（数据格式与读写规则）、`src\lib\runConfigDiscovery.ts`（自动发现）、`src\lib\runTaskPlatform.ts`（`os` 字段与平台判断）、`src\components\RunPanel.tsx` / `RunConfigEditor.tsx`（交互）、`src-tauri\src\remote_ssh\terminal_cmds.rs` 中 `windows_task_script` / `remote_script_invocation`（各任务类型如何执行）。`docs/roadmap.md`、`docs/agent-adapters.md`（运行配置是用户自己的命令，不是 Agent，不涉及合规条款，但**不得**自动执行任何命令：只有用户点击才启动）。

文件格式（与旧版完全兼容，旧版 CLI `qingcode run upsert` 写出的文件必须能直接读）：
```json
{ "configs": [ { "id": "uuid", "name": "dev", "restoreWithProjectSession": false,
  "tasks": [ { "id": "uuid", "name": "dev", "type": "command", "target": "pnpm dev", "cwd": "可选，相对项目根", "env": {"K": "V"}, "os": "可选 windows|linux|macos" } ] } ] }
```
`type`：`command`（Windows：`cmd.exe /d /s /c`；POSIX：`sh -lc`）、`ps1`（`powershell -NoProfile -ExecutionPolicy Bypass -File`，优先 `pwsh`）、`bat`（`cmd /c`）、`sh`（`sh <file>`）、`script`（按扩展名选择上述方式）。读：`<project>/.qingcode/run.json`，不存在时回退只读 `<project>/.nestcode/run.json`；写：原子写 `.qingcode/run.json`（经 `fs.write`），保留未知字段。

server（`run.*`，进程由 daemon 托管，客户端断开不停止）：
- `run.start {cwd, task:{type,target,cwd?,env?}, label?}` → `{runId, pid}`；`run.stop {runId}`（Windows `taskkill /T /F /PID`，POSIX 杀进程组：先 SIGTERM，3s 后 SIGKILL）；`run.list` → 当前 daemon 内全部运行记录 `{runId, label, cwd, command, pid, startedAt, exitCode?, endedAt?}`（结束的保留最近 20 条）；`run.output {runId, sinceSeq}` → 缓冲内 `seq > sinceSeq` 的输出块（每个 run 环形缓冲 1 MiB，超出丢最旧并标 `truncated`）。
- evt `run.data {runId, seq, stream:'stdout'|'stderr', data}`（广播给所有客户端，前端按 runId 过滤）、`run.exit {runId, exitCode, signal}`。
- 子进程 stdio 用管道（终端/PTY 是后续 P2，不在本卡）；环境变量 = daemon 环境 + task.env；`FORCE_COLOR=1`，输出保留 ANSI 转义交给前端处理。
- 纯逻辑（命令行构造、各平台转义、环形缓冲、配置文件解析/合并/校验）单测；集成测试在本机（Windows）跑 `command` 与 `bat`/`ps1`，POSIX 分支用纯函数测试。

renderer（`features/run/`）：
- `runConfigModel.ts`：解析/序列化（兼容旧格式、保留未知字段）、按 `os` 过滤、新建/复制/删除配置与任务、自动发现（`package.json` scripts、`Makefile` 目标、`Cargo.toml` → `cargo run`/`cargo test`、`pyproject`/`manage.py` 常见入口；只生成建议，用户确认后才写入）。
- `RunPanel.tsx`（props：`targetId`、`cwd`）：配置列表（运行状态点、启动 / 停止 / 重启、编辑、删除需确认）、"从项目中发现"建议列表；输出区（按任务分标签，ANSI 颜色转成 span（自写最小解析：SGR 颜色/粗体/重置，其余转义去掉），自动滚动可暂停，清空，复制全部，最多保留 5000 行）。
- `RunConfigEditor.tsx`：表单编辑一个配置（名称、任务列表：名称/类型/命令或脚本路径/工作目录/环境变量键值表/系统限制），校验后经 `fs.write` 写回。
- 启动时 `run.list` + 订阅 `run.data` / `run.exit` 恢复正在运行的任务输出（`run.output` 补齐）。
- `index.ts` 导出 `RunPanel`、`useRun`；`README.md` 写接入方式。

验收：`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm --filter @qn/desktop typecheck`（本卡文件无错误）、`pnpm exec vitest run packages/server/src/workspace/run apps/desktop/src/renderer/src/features/run` 通过；`node packages/server/build.mjs` 成功。
