# T40 对齐 Paseo：引导、轮次与对话能力

目标：以 Paseo 的行为为参照补齐 Claude、Codex、pi 的对话能力。先读 [开发约定](../../AGENTS.md) 与 [Agent 适配规范](../agent-adapters.md)。

## 边界

- 只借鉴行为，不复制 Paseo 源码（许可不同）。参照仓库在 `%TEMP%\paseo-research-26493\paseo`，工作区未检出，用 `git show HEAD:<路径>`、`git grep <模式> HEAD` 读取，不要在里面安装或构建。
- 只用官方公开接口。唯一经用户批准的例外是 Claude 的 `cancelAsyncMessage`（SDK 运行时提供，公开类型未声明）。
- 不读凭据、不调私有接口、不改 `clientInfo`、不开 `experimentalApi`、不自动应答审批。
- 工作区里有其他人未提交的改动。只做定点编辑，不回退、不重排、不格式化无关代码，不执行任何改动 git 状态的命令。
- 不改任何 `package.json`、锁文件、根配置、`docs/mvp.md`、`vendor/`。
- `docs/agent-adapters.md`、`docs/agent-capabilities.md` 由总管统一更新，子任务在报告里给出应写的内容。

## 接口约定

服务端三个桥与两端客户端按下列形状对接。Codex 由 daemon 原样转发，没有的 `qingcode/*` 方法由客户端按能力声明隐藏入口。

| 方向 | 方法 | 形状 |
|---|---|---|
| 通知 | `turn/plan/updated` | `{threadId, turnId, explanation: string \| null, plan: [{step, status: 'pending' \| 'inProgress' \| 'completed'}]}`，与 `vendor/codex-protocol/ts/v2/TurnPlanUpdatedNotification.ts` 一致。每次发完整列表。 |
| 通知 | `qingcode/backgroundTasks/updated` | `{threadId, tasks: [{id, type, description}]}`，全量替换；不含 ambient 任务。 |
| 请求 | `qingcode/backgroundTasks/list` | `{threadId}` → `{tasks}`，供重新打开会话时读取。不得为此启动 Agent。 |
| 请求 | `qingcode/backgroundTasks/stop` | `{threadId, taskId}` → `{}` |
| 请求 | `qingcode/commands/list` | `{threadId}` → `{commands: [{name, description, argumentHint?}]}`。`name` 不带 `/`。只读正在运行的会话进程，没有则返回空列表（R9）。 |
| 请求 | `qingcode/files/rewind` | `{threadId, turnId, dryRun: boolean}` → `{canRewind: boolean, filesChanged: string[], insertions: number, deletions: number, error?: string}`。把文件回到该轮开始前。`dryRun: false` 只能由用户确认后调用；会话有活动轮次时拒绝。 |

`AGENT_CAPABILITIES`（`packages/protocol/src/agents.ts`）新增布尔项：`backgroundTasks`、`commandList`、`rewindFiles`、`planMode`。

| 能力 | codex | claude | pi |
|---|---|---|---|
| `backgroundTasks` | false | true | false |
| `commandList` | false | true | true |
| `rewindFiles` | false | true | false |
| `planMode` | false | true | false |

做不到某项时（官方公开接口不支持），保持 `false`，在报告里写明原因，不模拟。

## A. pi 桥（`packages/server/src/pi/**`）

1. 停止：按 pi 官方 `docs/rpc-commands.md`，先 `clear_queue` 再 `abort`；撤掉未送达的引导。旧版 pi 不认识 `clear_queue` 时仍要能停止。
2. 不是由 prompt 发起的运行（扩展触发、排队消息续跑）要建立轮次并正常结束，不再丢弃事件。空闲期间的非运行事件不能误开轮次。
3. 实现 `qingcode/commands/list`（官方 `get_commands`）。

## B. Claude 桥（`packages/server/src/claude/**`、能力声明、`codex-client` 的子代理视图）

1. 停止：对尚未开始处理的消息先调 `cancelAsyncMessage`，再 `interrupt()`；方法缺失、返回 false 或抛错时沿用现有的二次中断。
2. 自发轮次兜底：若官方文档确认可用 `session_state_changed` 的 `idle` 收尾，则接入且只结束自发轮次；找不到官方依据就不做并说明。
3. 计划 / TODO：解析 `TodoWrite` 与 `TaskCreate`/`TaskUpdate`/`TaskList`，实时与历史重开都发 `turn/plan/updated` 或等价历史数据。
4. 后台任务列表与停止（SDK `background_tasks_changed`、`stopTask`）。
5. 文件回滚（SDK `enableFileCheckpointing`、`rewindFiles`）。
6. 斜杠命令列表（`supportedCommands`）。
7. 子代理内部工具归到对应子代理卡片的活动列表，不再平铺在主对话。

## C. 运行中发送的默认行为（桌面、手机）

1. 新增设置“运行中发送”：引导（默认）、排队、打断后发送。两端各自保存。
2. 引导不可用时不丢消息：轮次刚结束就按普通消息发送；压缩中、斜杠命令、Agent 拒绝时转入排队。
3. 打断后发送：中断当前轮次，等它结束再发送；中断失败时保留在队列。
4. 保留现有的另一种发送快捷键与队列里的“引导”按钮。能力不支持引导时按排队处理。
5. 不自动应答任何审批。

## D. 客户端能力界面（桌面、手机，A–C 完成后）

1. 计划 / TODO 清单展示（三家共用 `turn/plan/updated`）。
2. 后台任务列表与停止按钮。
3. 原生斜杠命令并入命令菜单。
4. 文件回滚：先 `dryRun` 展示将改动的文件，用户确认后执行（仅桌面）。
5. Claude 的 plan 模式入口，输入框区域常驻标识。
6. Claude、pi 的“编辑重发”（仅桌面）：从上一轮分支出新会话再发送，原会话保留；界面说明这是新分支。
7. 手机网关白名单加入手机用到的新方法。

## 验收

各部分带就近单测。运行改动目录的 `vitest`、相关包类型检查；手机 Web 改动运行 `pnpm --filter @qn/mobile build:web`。报告列出改动文件、验证结果、未完成项与假设。
