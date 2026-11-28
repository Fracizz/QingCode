# QingCode Next 产品定位与方向

> 2026-11-27 起草，依据 `next` @ `6e1da69e` 的代码，以及 Paseo、Orca 公开 README 和源码对照。竞品功能以其 README 为准，未逐项实测。任务状态见[路线图](roadmap.md)。

## 1. 与 Paseo、Orca 的对比

三者底子相同：一个 daemon 驱动官方 Agent CLI，桌面与手机作为客户端连接。差异在定位上：Paseo、Orca 是并行 Agent 开发环境，QingCode 目前是在任意机器上远程驾驶对话、把对话跑稳。

| 维度 | QingCode Next | Paseo | Orca |
|---|---|---|---|
| Agent | Codex、Claude、pi，接入较深 | 十余种，统一接口 | 任意 CLI 跑在终端里，Claude、Codex 有原生聊天界面 |
| 对话协议 | 统一为 Codex app-server v2，Codex 原样转发 | 自有协议 | 聊天与原生终端可互相切换 |
| 远程 | SSH 一键部署同一份 server、TLS 直连，Windows 目标是一等公民 | 本机 daemon，加可选的端到端加密中继 | 远程 Orca Server、SSH、云 VM |
| 手机 | 经已配对电脑的网关访问，只有 Android | 完整原生 App（iOS、Android），不依赖电脑 | 原生 App，重点是"需要你"时推送与回复 |
| 并行 | 无 worktree 隔离 | 一个 Agent 一个 worktree，可跨 Agent 调度 | 并行 worktree，协调者派发 worker |
| 开发闭环 | 文件、Git、终端、运行配置 | 编辑器、diff、PR、内置浏览器 | diff 行级批注回传、PR 与 CI 失败回传、Design Mode |
| 扩展 | 无插件 | 插件、CLI、语音 | 插件、CLI、Slack/Linear/GitHub 机器人 |
| 合规 | 只用公开接口，见[适配规范](agent-adapters.md) | 未见同等约束 | 未见同等约束 |

**我们的优势**：
- Windows 与内网远程目标的部署和直连。
- 对话控制细：引导、撤回、审批、计划、后台任务（T40 已对齐 Paseo）。
- 合规可审计。

**明显落后**：
- 并行 worktree。
- 从评审到回传给 Agent 的闭环。
- 手机独立性：必须经电脑网关，没有 iOS。

Codex 能力比 Claude 完整，是两家接口本身的差别：Codex app-server 是完整后端协议，Claude 只有 SDK，很多状态要靠桥合成。换用竞品底座也绕不过这一点，所以继续自研，把竞品当参考实现。

## 2. 定位

**在远程和 Windows 机器上，用手机和桌面可靠驾驶 Codex、Claude 的工作台。**

后端能力各家趋同，前端交互才是留住用户的关键：清晰、美观、易用是核心规范，见 [UI 设计规范 · 核心规范](design/ui-shell.md)。Orca 偏信息密集，我们走对话优先、克制的路线，新功能加进来后也要保持清晰。

不追全矩阵：插件、机器人、语音、接入十几种 Agent，暂不做。

## 3. 方向与优先级

| 顺序 | 方向 | 内容 | 依据 |
|---|---|---|---|
| 1 | 可靠性 | T40、T39、T31 的实机验收（10.87、SSH 目标、Android）；断线恢复；daemon 升级不打断活动对话 | 远程场景下"稳"比"多"值钱 |
| 2 | 按对话隔离 worktree | 新建对话可选独立 worktree，合并回主分支、清理 | 两家的核心能力；已有 Git、文件面板，成本最低 |
| 3 | 评审闭环 | diff 行级批注一键发回 Agent，按 diff 起草提交信息 | 复用 Git 面板与引导 |
| 4 | 手机"待处理"收件箱 | 跨机器汇总审批、提问、轮次结束、后台任务完成，配合通知；评估手机不经电脑网关的连接方式 | 最贴合"远程驾驶"的定位 |
| 5 | 之后再看 | 多 Agent 编排、更多 Agent（如 OpenCode）、[定时任务](scheduled-tasks.md)、插件 | 视用户反馈 |

**待定**：目标用户是自用和团队，还是对外发布。内部使用时第 4 项可以提前，第 5 项基本不做；对外发布时，第 2、3 项是门槛，并且要先满足[适配规范 §3.3](agent-adapters.md) 的发版条件。
