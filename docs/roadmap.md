# QingCode Next — 路线图

> 2026-11-27 整理，`next` @ `6e1da69e`。产品定位与后续方向见[产品方向](product-direction.md)，当前能力见 [Agent 能力矩阵](agent-capabilities.md)和[电脑版与手机版能力对齐](client-capabilities.md)。已完成的任务卡已从 `docs/tasks/` 移除，需要时到 Git 历史查看（整理前的最后版本为 `6e1da69e`）。

## 1. 已交付（MVP 之后）

验收指在真实目标机或 Android 设备上跑通；未注明的只经过类型检查与单测。

| 模块 | 内容 | 验收情况 |
|---|---|---|
| 文件、Git | server 协议（`packages/protocol/src/workspace.ts`），文件查看与 CodeMirror 编辑、冲突合并、差异视图，文件树与搜索，Git 面板 | 10.87 直连实测 `git.status`、`fs.read` |
| 终端 | daemon 托管、Python PTY 加 `script` 兜底、断线接回；桌面 xterm 多标签；手机终端需在电脑端单独开启 | 93 上 daemon 端到端 34 项通过；手机终端待真机 |
| 远程 | SSH 部署、TLS 直连（证书指纹固定、每客户端授权）、记住密码 | 10.87 跑通 Claude |
| Windows 目标 | 路径、编码、监听、搜索、Git、Agent 解析 | 本机验收，见 [Windows 验收](windows-acceptance.md) |
| Agent | Claude 桥、pi 适配、模型与推理强度、访问模式（含完全访问）、配置目录生效、引导与轮次对齐 Paseo（T40） | 见能力矩阵；T40 未实机 |
| 输入与命令 | `@` 引用文件、粘贴拖入图片（含合计大小检查）、斜杠命令、命令面板、发送队列编辑与持久化 | |
| 工作台 | 设置、运行配置（兼容 `.qingcode/run.json`）、项目信任确认、中英文界面、系统托盘 | |
| 手机 | 多 Agent、模型选择、只读文件浏览与下载、多电脑会话隔离、扫码配对、应用内更新 | T39 真机项待验 |

## 2. 进行中与待验收

| 卡 | 内容 | 状态 |
|---|---|---|
| A2 | 10.87 Windows 直连、93 Linux SSH 完整验收 | 已有分项记录，完整验收待补，按 [Windows 验收 §7](windows-acceptance.md) |
| [T31](tasks/T31-windows-conpty.md) | 本机 Windows ConPTY | 代码已实现；缺 `@lydell/node-pty` 与同版本 `@lydell/node-pty-win32-x64`，由总管安装后在 10.87 验证 |
| [T39](tasks/T39-mobile-workspace.md) | 手机工作台与会话恢复 | 已实现；待验双电脑切换、换网、扫码、选图、下载、覆盖安装 |
| [T40](tasks/T40-paseo-alignment.md) | 对齐 Paseo：引导、轮次、计划、后台任务 | 已实现，在 `0.0.3-beta.7` 中；待用真实 Claude、Codex、pi 验收 |

## 3. 后续方向

按[产品方向 §3](product-direction.md) 排序：可靠性与实机验收 → 按对话隔离 worktree → 评审闭环 → 手机待处理收件箱。[定时任务方案](scheduled-tasks.md)待审核。

**延后**：远端 server 管理（日志、重启、升级）与系统指标、文件上传和拖放到文件树、桌面自动更新与安装包签名、浅色主题、多窗口、手机 Git 写操作、连接预热。

**不做**：`qingcode-cli` 子命令兼容（项目信任已另行实现为打开项目前确认）。

**发版条件**：对外发布涉及 Claude 订阅登录时，按[适配规范 §3.3](agent-adapters.md) 取得书面确认，或默认只开放 API key 路径。

## 4. 架构原则

- **能力全部放在 qn-server**：本机与远端都是"客户端 → qn-server"，文件、Git、终端只实现一次。
- 纯逻辑（porcelain 解析、路径与链接解析、diff 处理）与 I/O 分离，纯函数配 Vitest 单测。
- 单帧上限 16 MiB（mvp.md §4）：读文件限量加分段，二进制不走文本通道。
- 路径一律绝对路径；相对路径由客户端按会话 cwd 或项目根解析后再请求。
- server 侧只用 Node 内置模块；Git 直接调用 `git` CLI，缺 git 时返回 `git_missing`。

## 5. 已定决策

1. 只读高亮用 shiki，编辑器用 CodeMirror 6。
2. 文件面板实现为右侧停靠栏，与对话并排、可收起。
3. Git 推送、拉取只用目标机已有凭据（ssh-agent、credential helper），`GIT_TERMINAL_PROMPT=0` 加 `BatchMode=yes` 快速失败，返回 `auth_required`。
4. 终端：远端 Python PTY 为主、`script` 兜底；本机 Windows 用预编译 node-pty 类包（见[终端技术验证](spikes/terminal.md)）。
5. 手机只提供只读的文件浏览、搜索、下载及对话内查看；文件与 Git 写操作只在桌面。
6. pi 模型列表只借用运行中的会话进程并缓存，无会话时不启动临时进程。
7. 运行中发送默认引导，可改为排队或打断（T40）。

## 6. 实施约定

- 契约先行：协议类型放 `packages/protocol/src/workspace.ts`；server 处理函数登记在 `packages/server/src/workspace/` 的 `fs/`、`git/`、`run/`、`terminal/`；渲染进程用 `features/workspace/serverCall.ts` 调用，用 `openers.ts` 打开文件和差异。
- 渲染进程功能放 `features/<名称>/`，只导出集成点；接入布局（App、MessageItem、侧栏）由总管统一完成。
- `fs.watch` 每连接一个集合、全量替换：各功能导出自己的监听路径，由总管合并登记。
- 新任务卡从 T41 起编号，完成并验收后从 `docs/tasks/` 移除，并在本页 §1 登记。
