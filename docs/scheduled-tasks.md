# QingCode Next — 定时任务方案（草案，待审核）

> 2026-11-26 起草，只读分析结论，尚未拆卡、未实现。旧版 `D:\code\qingcode` 无此功能，需从零实现。审核后拆卡并登记到 `docs/roadmap.md`。

## 1. 结论

定时任务的**调度与执行放在目标机 daemon（qn-server）**，桌面端只负责增删改查、查看运行记录与通知。这样电脑版关闭后，远端服务器上的任务仍能运行，也符合 roadmap §3「能力全部放在 qn-server」。

## 2. 现状依据

| 事实 | 位置 | 影响 |
|---|---|---|
| 会话由 renderer 驱动（`thread/start` / `turn/start`），daemon 只转发 | `apps/desktop/src/renderer/src/store/codex.ts:895` | daemon 需要自己发起会话 |
| 三种 Agent 统一实现 `AgentHost.handleClientMessage(clientId, msg)` | `packages/server/src/codexHost.ts:36` | 可在 daemon 内注册「虚拟客户端」（负数 clientId），复用现有协议 |
| daemon 空闲 30 分钟退出（无客户端、无直连、无活动对话/终端） | `packages/server/src/daemon.ts:296` | 空闲条件需加入「有已启用的任务」 |
| daemon 不开机自启 | — | 目标机重启后需桌面端连接一次才会拉起 |
| 电脑版关窗后在系统托盘常驻，退出才停止 | `apps/desktop/src/main/index.ts` | 方案 A 可行，但电脑关机或退出后仍不能运行 |
| 运行配置 `run.start` 已由 daemon 托管 | `packages/server/src/workspace/run/` | `run` 类型任务可直接复用 |
| 访问模式参数生成 `turnAccessOverride` | `packages/codex-client/src/accessModes.ts` | 可直接生成 Codex 只读 / Claude 计划模式参数 |
| 渲染端调用 server 的通道 `serverCall(targetId, method, params)` | `features/run/runStore.ts` | 桌面调用契约 `backendApi.ts` 无需改动 |
| 手机网关有 server.req 方法白名单 | `apps/desktop/src/backend/mobile/gateway.ts:102` | 手机端开放哪些 `schedule.*` 需逐项登记 |

合规约束（`docs/agent-adapters.md`）：
- §4：定时自动发 prompt 必须用户显式开启，界面标注会消耗其额度；触发限额时停止，禁止重试风暴、禁止换号，重试最多 1 次且需退避。
- §6：审批不得由 server 代答，每个请求都必须能被拒绝。

## 3. 方案对比

| | A：调度放桌面 backend | B：调度放 daemon（推荐） |
|---|---|---|
| 电脑版退出后 | 不能运行（托盘常驻时可运行） | 能运行，只要 daemon 存活 |
| 远端任务 | 依赖本机开机、联网并保持 SSH | 在目标机上独立运行 |
| 改动量 | 不改协议，调度器放主进程或 backend | 新增 `schedule.*` 协议与 daemon 调度器 |
| 手机查看 | 经网关转发 | 天然共享同一份数据 |

## 4. 方案 B 设计

### 4.1 数据

存于目标机 `stateDir/schedules.json`，原子写（临时文件 + rename）。

```ts
type Schedule = {
  id: string
  name: string
  enabled: boolean
  cwd: string // 项目根，绝对路径
  trigger:
    | { type: 'cron'; expr: string } // 5 段，目标机本地时区
    | { type: 'interval'; minutes: number }
    | { type: 'once'; at: number }
  action:
    | {
        type: 'agent'
        agent: 'codex' | 'claude' | 'pi'
        prompt: string
        model?: string
        effort?: string
        accessMode: AccessMode
        thread: 'new' | 'reuse'
        threadId?: string
      }
    | { type: 'run'; task: RunTask } // 复用运行配置的 task 结构
  // 保存时从桌面设置快照，桌面关闭后 daemon 仍能启动 Agent
  agentOpen: { codexPath?: string; claudePath?: string; piPath?: string; configDir?: string }
  overlap: 'skip'
  catchUp: 'none' | 'once'
  createdAt: number
  updatedAt: number
}
```

运行记录写入 `stateDir/schedule-runs.jsonl`，每个任务保留最近 50 条：开始/结束时间、状态（`succeeded` / `failed` / `skipped` / `waitingApproval` / `rateLimited`）、threadId、最后一条回复摘要、用量。

### 4.2 调度器（`packages/server/src/schedule/`，仅用 Node 内置模块）

- cron 解析与下次运行时间计算写成纯函数，配 Vitest 单测；不引入新依赖。
- 只挂一个 `setTimeout` 指向最近的触发点，最长每 60 秒重算一次，应对系统休眠与改时间；唤醒后按 `catchUp` 决定是否补跑。
- 并发：同一目标、同一 Agent 同时只跑 1 个定时会话；上一次未结束则本次记为 `skipped`。

### 4.3 执行（agent 类型）

1. 虚拟客户端依次调用 `host.open(agentOpen)`、`thread/start {cwd}`、`turn/start {threadId, input, ...turnAccessOverride(accessMode), model, effort}`。
2. 等待 `turn/completed` 后写运行记录；超时（默认 2 小时）发 `turn/interrupt`。
3. `hubFor().send` 与 `broadcastRecv` 增加分支：负数 clientId 的消息交给调度器。

配套规则：
- **会话可见**：会话写入 Agent 自身历史，桌面历史列表可直接打开；可加「[定时]」前缀命名。
- **审批**：daemon 不代答。审批请求照常广播给在线的桌面/手机，运行记录标记 `waitingApproval`；无人处理则超时中断。
- **限额**：触发限额即暂停该任务至重置时间，记 `rateLimited`，不重试、不换号。

### 4.4 daemon 改动

- 空闲判断加入 `scheduler.hasEnabled()`。
- `ensure --replace` 升级时依赖持久化数据恢复任务。
- 正在执行的定时会话已计入 `hasActiveWork()`（通过 `activeTurns`）。

### 4.5 协议（`packages/protocol`）

| 方法 / 事件 | 说明 |
|---|---|
| `schedule.list` | 全部任务及下次运行时间、上次状态 |
| `schedule.upsert` / `schedule.delete` | 校验后写入 / 删除 |
| `schedule.setEnabled` | 启用 / 停用 |
| `schedule.runNow` | 立即执行一次（仍受并发限制） |
| `schedule.runs` | 某任务的运行记录 |
| evt `schedule.changed` | 任务列表变更 |
| evt `schedule.run` | `{taskId, runId, status, threadId?}` 运行状态变化 |

直连客户端可调用；手机网关先只开放 `schedule.list`、`schedule.runs`。

### 4.6 桌面界面（`apps/desktop/src/renderer/src/features/schedule/`）

- 停靠栏新增「定时任务」面板，并加入命令面板；列表显示下次运行时间与上次状态。
- 编辑表单：
  - 名称、项目、Agent、模型、访问模式（显式选择，带警告）、prompt
  - 触发方式：预设（每天 / 工作日 / 每周 / 每 N 小时）或自定义 cron，预览接下来 5 次运行时间
  - 每次新开会话 / 续用同一会话
  - 默认权限模式下提示「无人值守时可能卡在审批」，推荐只读或计划模式
- 合规：设置中增加「允许定时任务自动发送 prompt」总开关，默认关闭；界面常驻「会消耗你的额度」提示；agent 类型最小间隔 15 分钟。
- 运行记录点击即打开对应会话；电脑版在线时用 Electron Notification 通知运行结果。

## 5. 拆卡建议

| 卡 | 内容 | 执行 |
|---|---|---|
| S1 | cron 解析与下次运行时间、任务存储与校验（纯逻辑） | pi |
| S2 | daemon 调度器、虚拟客户端执行、空闲判断、协议 | Claude（跨 host，需在 93 与 10.87 实测） |
| S3 | 桌面面板、编辑器、通知、设置开关 | Claude |
| S4（可选） | `run` 类型任务（复用 `run.start`，不涉及 Agent 合规） | pi |
| S5（可选） | 手机端只读查看；daemon 开机自启（systemd user / schtasks，须用户显式开启） | 后续 |

## 6. 待决事项

1. 范围：只做 Agent 定时 prompt，还是同时做定时运行命令（S4）？
2. 无人值守的审批：推荐「只允许只读 / 计划模式」；或「允许任意模式，卡审批即超时中断」；或禁止默认模式。
3. 目标机重启后：推荐先接受「重启后需打开电脑版连接一次才恢复」，开机自启放到 S5。
