# Agent 适配规范（Codex / Claude / 后续 Agent）

> 状态：v1（2026-11-26）。适用于 `packages/server` 内所有 Agent host / bridge、`packages/codex-client`、桌面端与手机端涉及 Agent 的界面。
> 与 `docs/mvp.md` 冲突时，**合规条款以本文为准**，功能与接口以 mvp 为准；发现冲突须报告总管，不得自行绕过。
> 依据：各厂商官方文档（见 §9），并参考 t3code（pingdotgg/t3code）`AGENTS.md` 与 `docs/internals/03_providers.md` 的适配约束。本文不是法律意见。

## 0. 一句话

**QingCode Next 只是用户自己已安装、自己已登录的官方 Agent 的界面。** 不碰凭据、不冒充官方客户端、不调用私有接口、不替用户做决定、不帮任何人绕过限额。

## 1. 红线（违反任一条不得合入）

| # | 禁止 | 原因 |
|---|---|---|
| R1 | 读取、复制、上传、缓存、解析任何 Agent 凭据：`~/.codex/auth.json`、`%USERPROFILE%\.claude\.credentials.json`、系统钥匙串、`CLAUDE_CODE_OAUTH_TOKEN` 等 | Anthropic："developers may not collect, store, or intermediate Claude.ai credentials or session tokens"；OpenAI：auth.json 等同密码 |
| R2 | 自己实现或代理厂商登录流程（OAuth、设备码、token 刷新）；在自家界面提供"用 Claude.ai / ChatGPT 账号登录" | Anthropic 不允许第三方提供 Claude.ai 登录；OpenAI："App-server authentication has never been permitted for commercial or hosted services"，SIWC 仅限受邀伙伴 |
| R3 | 直接调用厂商私有 HTTP 接口（ChatGPT backend、claude.ai 内部 API、用量/额度抓取接口等），或解析 Agent 的私有存储来"补功能" | 只允许官方公开协议（§2）；t3code 同样禁止"private vendor RPC or HTTP calls, and readers for a vendor CLI's credentials" |
| R4 | 伪造客户端身份：`clientInfo.name` 用 `codex_vscode`/`codex_cli_rs` 等官方名，伪造 User-Agent、伪造 Claude Code 指纹/请求头 | Codex 用 `clientInfo.name` 归属合规日志；冒充即身份欺骗 |
| R5 | 修改、打补丁、反编译、替换官方可执行文件，或打包分发 `claude`/`codex` 二进制 | Anthropic 仅豁免"unmodified Claude Code binary"；预装/内置 Claude Code 需另签商业条款 |
| R6 | 多账号轮换、自动切号、共享账号池、把一个账号的额度提供给他人（含经手机网关给第三方用） | 双方条款均禁止共享凭据、规避限额；Anthropic AUP 明确禁止"route requests through consumer subscriptions" |
| R7 | 自动应答审批、伪造 Agent 不支持的权限模式、默认 `bypassPermissions`/`--dangerously-*` | t3code："Never emulate missing permission modes… do not fake a mode by auto-answering approvals" |
| R8 | 为绕过沙箱/审批把文件复制进项目目录、改写 Agent 配置文件（`~/.codex/config.toml`、`~/.claude/settings.json`）来放权 | 规避安全措施 |
| R9 | 后台探测（版本、可用性、额度）时开启会话、启动 MCP、触发 hooks 或登录流程 | t3code 同条；后台无意中消耗额度/触发风控 |
| R10 | 产品、功能、图标使用 "Claude Code"、"Codex" 作为自有名称或仿制其视觉 | 商标/品牌规则（§5） |
| R11 | 日志、错误报告、遥测中出现 token、API key、完整 prompt 以外的凭据字段 | 已有 `redact()`，新增日志点必须走它 |

## 2. 允许的接入方式（白名单）

只能通过下表的**官方公开接口**驱动 Agent；新增接口须在 PR 中注明官方文档链接。

| Agent | 接口 | 说明 |
|---|---|---|
| Codex | `codex app-server`（JSON-RPC over **stdio**） | 只用 v2 稳定面；schema 来自 `codex app-server generate-ts / generate-json-schema`，固定在 `vendor/codex-protocol`，升级 codex 版本时重新生成 |
| Claude | `@anthropic-ai/claude-agent-sdk`（固定版本），`pathToClaudeCodeExecutable` 指向目标机**用户自己安装的未修改** `claude` | 不用 SDK 自带二进制（已在构建中排除）；备选为官方 `claude -p --output-format stream-json`，不得逆向其它私有协议 |
| pi | `pi --mode rpc`（官方 RPC 模式，JSONL over stdio；文档见 pi 包内 `docs/rpc.md`、`docs/rpc-commands.md`） | 驱动用户已安装的 pi；会话列表可只读解析其官方公开的会话格式（`docs/session-format.md`），不碰认证文件；pi 无审批机制，界面须如实标注，不得伪造审批 |
| 其他 | ACP（Agent Client Protocol）标准实现 | 严格按规范：不做 agent-id 特判、不加厂商私有扩展 |

禁止：WebSocket 等官方标注 experimental/unsupported 的传输（Codex WebSocket 传输明确 "experimental and unsupported"）；未开启前提下调用 experimental 方法。

## 3. 身份与认证

### 3.1 客户端身份

- Codex `initialize`：`clientInfo = { name: 'qingcode-next', title: 'QingCode Next', version: <应用版本> }`，**名称固定、全局唯一**，不随环境变化，不得使用官方客户端名。每条 stdio 连接只发一次 `initialize` + `initialized`，由 daemon 完成（已实现，客户端不得再发）。
- 默认**不声明** `capabilities.experimentalApi`。确需实验接口时：单独评审、注明方法名与官方说明、在 `codex.open` 结果里暴露开关，默认关。
- 若面向企业分发：先联系 OpenAI 加入 known clients list（官方文档要求）。
- Claude：不设置任何伪装请求头/User-Agent；SDK 与 CLI 自带的标识原样保留。

### 3.2 认证归属

- **认证永远发生在官方程序里，由用户本人完成**：Codex 用 `codex login`（或 app-server 官方 `account/login/start` 由用户在官方页面完成——仅限非商业/自用分发，见 §3.3）；Claude 用 `claude` 内的 `/login`（或用户自行配置 API key / Bedrock / Vertex / Foundry）。
- QingCode 只做两件事：**检测**是否已登录（Codex `account/read`；Claude 以 SDK 初始化结果/报错判定），以及**提示**用户去终端运行官方登录命令。不在 QingCode 内输入、展示、保存任何 Agent 凭据。
- 进程环境：原样继承用户环境即可；**不得注入**用户未配置的凭据变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`CODEX_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_BASE_URL` 等），也不得把一个目标的环境变量带到另一个目标。
- 多账号只支持官方方式：用户自行设置 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`（不要改 `HOME`，否则钥匙串路径失效）。QingCode 可以让用户为某目标指定这两个变量，但**不提供自动切换/轮换**（R6）。

### 3.3 分发形态与认证（发版闸门）

| 分发形态 | Codex（ChatGPT 登录） | Claude（订阅登录 Free/Pro/Max） | Claude（API key / 云厂商） |
|---|---|---|---|
| 个人/团队内部自用，驱动本人已登录的官方程序 | 可（OpenAI：本地/开源应用可继续使用） | **灰区**，见下 | 可 |
| 对外发布（开源下载） | 可，但官方建议迁移 SIWC | **需先获 Anthropic 确认** | 可 |
| 商业产品 / 托管服务 / 帮他人使用 | **不允许**，须走 SIWC 伙伴计划 | **不允许**（"unless previously approved"） | 可（每个终端用户用自己的 key） |

Claude 订阅登录的灰区说明：Anthropic 允许"end user signing in to the unmodified Claude Code binary with their own Claude subscription"，但 Agent SDK 文档写明"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK"。我们当前（mvp §11）用 Agent SDK 驱动用户已登录的 `claude`，属于该灰区。要求：

1. 现阶段仅限**用户本人**在**自己的机器/自己的服务器**上使用自己的账号；手机网关只服务同一用户的设备（配对 token 不可转给他人）。
2. 设置中提供并推荐"使用 API key / Bedrock / Vertex / Foundry"路径（由用户在 `claude` 自身配置，QingCode 不保存）。
3. 对外发布或商业化前，必须取得 Anthropic 书面确认，否则 Claude 默认只开放 API key 路径。此条为发版闸门。

## 4. 用量、限额与并发

- 引导从桌面或手机对活动轮次发 `turn/steer`。pi 使用官方 `steer` RPC（安装包 `docs/rpc-commands.md`），收到原生用户消息事件后回显。Claude 使用 [Agent SDK 流式输入](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage) 的 `priority: 'next'`，根据 SDK 回显的用户消息 UUID 确认归属。本轮先结束时，Claude 可以在下一轮处理这条补充。
- 持久会话的引导归属保存在 QingCode daemon 状态目录的 `steering/`，只记录消息标识及轮次归属。临时会话只在内存记录。

- 手动压缩只在用户确认后执行。Codex 用公开的 [`thread/compact/start`](https://developers.openai.com/codex/app-server)，Claude 用 [Agent SDK 的 `/compact`](https://code.claude.com/docs/en/agent-sdk/agent-loop) 且须由 `supportedCommands()` 声明，pi 用官方 RPC `compact`（随安装包提供的 `docs/rpc-commands.md`）。压缩减少上下文占用，已用账号额度不会恢复。

- 额度只读官方接口：Codex `account/rateLimits/read` + `account/rateLimits/updated`。Claude 默认使用 SDK 的 `rate_limit_event`：新版 CLI 每轮在该事件的 `unifiedWindows.five_hour/seven_day` 带利用率（SDK 公开类型尚未声明，缺失时退回顶层 `utilization`），按 5 小时和每周窗口显示；费用使用 `result.total_cost_usd`（标注"估算"）。个人自用可以主动配置官方 CLI 的 [`statusLine`](https://code.claude.com/docs/en/statusline#rate-limit-usage) 转发两个订阅窗口；对外分发仍遵守 §3.3。不抓取网页、不调用私有用量接口。
- Codex `account/rateLimitResetCredit/consume`、`account/sendAddCreditsNudgeEmail` 等有副作用的账户方法：只能由用户显式点击触发，带确认框，禁止自动调用。
- 刷新频率：界面可见时 ≥60 秒一次；不可见时停止。禁止为"保持在线""预热"发送空 turn 或心跳 prompt。
- 触发限额（`usage_limit` / `rateLimitReachedType` 非空 / Claude 限额错误）时：**停止**、清晰告知重置时间；禁止自动重试风暴、禁止换号续跑。重试最多 1 次且需退避（≥ 官方给出的重置/`retry-after`）。
- 并发：同一目标同一 Agent 的并发 turn 数由用户操作产生，不做后台批量派发；任何"批量/定时自动发 prompt"功能都必须用户显式开启，并在 UI 标注会消耗其额度。注意 Anthropic："Advertised usage limits… assume ordinary, individual usage"。

### Claude CLI 状态栏（个人自用）

在运行 Claude CLI 的同一台目标机上，将官方状态栏传给脚本的 stdin JSON 交给 `node "/目标机上的/qn-server.cjs" claude-statusline`。自定义 daemon 目录加 `--state-dir <目录>`。已有状态栏时，在自己的脚本内将同一份 JSON 分别传给原脚本和此命令。

命令只通过已有本机 IPC 发送 5 小时和每周窗口的百分比、重置时间及配置目录。daemon 按配置目录隔离，每 15 秒最多推送一次有变化的读数，保留期间最新值，窗口过期后移除。互动终端执行正常请求后才可能有读数；SDK 的限额事件仍可独立使用。QingCode 不自动安装状态栏或启动 Claude 来刷新额度。

## 5. 品牌与界面文案

- 允许：在 Agent 选择器/菜单中显示 "Codex"、"Claude"；"由 Claude 驱动"、"运行本机的 Claude Code"、"使用 Codex CLI" 这类**说明性**文字。
- 禁止：产品名、功能名、Logo 中含 "Claude Code"/"Anthropic"/"OpenAI"/"Codex"；仿制 Claude Code 的 ASCII Logo 或终端视觉；暗示官方合作或背书。
- Agent 图标用中性图形或厂商允许的标识方式，不直接使用厂商 Logo 作为自家按钮主视觉。
- 关于页需写明：QingCode Next 是第三方客户端，与 OpenAI、Anthropic 无隶属关系；所有用量计入用户自己的账号。

## 6. 审批与权限

- 审批请求原样透传：Codex 的 server request 与 decision 选项、Claude `canUseTool` 的 `suggestions`/`toolUseID` 不改写含义；每个请求都必须能被拒绝。
- 只能映射**Agent 原生支持**的决策（Claude：allow / allow+`updatedPermissions`(session) / deny / deny+interrupt）；不支持的模式在界面置灰并说明，不在 QingCode 里模拟。
- 默认权限：Codex 用其自身默认；Claude `permissionMode: 'default'`。提升到 `acceptEdits`/`bypassPermissions`/Codex `danger-full-access` 必须用户在会话内显式选择，且在输入框区域常驻标识。
- 多客户端（桌面+手机）同时在线时，"第一个响应生效"，不得由 server 代答。测试脚本（如 `test/claude-probe.mjs`）里的自动 accept 只允许存在于 `test/`，不得进入产品代码路径。

## 7. 进程、安装与探测

- 可执行文件只做**解析**（参数 → PATH → 常见安装目录），不自动下载、不自动安装、不自动升级。升级只提示用户用其原安装方式（npm / 官方安装器 / brew 等）执行。
- 可用性探测只允许：`codex --version`、`claude --version`、文件存在性检查。不得为探测而打开会话或发送 prompt（R9）。
- 子进程：stdio 管道、不经 shell（Windows `.cmd` 例外需转义，已实现）；daemon 退出时结束子进程；空闲会话按 mvp 规则关闭（Claude 30 分钟 `close()`）。
- 版本固定：Agent SDK 版本、vendor schema 对应的 codex 版本写在 mvp 与本文 §8；升级时同步更新 schema 生成物与映射表并回归 e2e。

## 8. 新增或修改适配器检查清单（PR 必填）

1. 使用的协议/方法及官方文档链接（§2 白名单内）。
2. 是否触碰凭据、配置文件、私有存储？（必须为"否"）
3. `clientInfo` / 标识是否未变？是否新增 experimental 能力？
4. 审批：新工具/新请求类型如何映射，是否可拒绝？
5. 是否有自动发送 prompt、自动重试、自动审批？（默认必须为"否"）
6. 日志是否经 `redact()`；单测覆盖映射纯函数；用真实 Agent 录制的样例回放（t3code 同要求）。
7. 不支持的方法：返回 JSON-RPC `-32601`，并在适配器文档中写明"不支持"的决定（t3code："Every provider adapter needs a decision, even if the decision is 'not supported here'"）。
8. 界面文案过一遍 §5。

当前固定版本：codex-cli 0.172.0（vendor schema）、`@anthropic-ai/claude-agent-sdk@0.3.332`、验收用 Claude Code 2.1.331。

## 9. 现状核查（2026-11-26）

| 项 | 结论 |
|---|---|
| Codex `clientInfo.name = 'qingcode-next'`（`packages/server/src/codexHost.ts:374`） | 合规；建议补 `title` |
| 未声明 `experimentalApi` | 合规 |
| 代码中无读取 `auth.json` / `.credentials.json` / 钥匙串 | 合规 |
| Claude 使用目标机已装 `claude`，构建排除 SDK 原生二进制 | 合规（R5） |
| Claude `permissionMode: 'default'`，产品代码无自动审批 / bypass | 合规 |
| 额度来源 `account/rateLimits/read`、`rate_limit_event` | 合规 |
| 界面无 "Claude Code" 品牌字样 | 合规 |
| Claude 走订阅登录 + Agent SDK | **灰区**，按 §3.3 闸门处理 |
| 手机网关可被他人配对使用 | 需在配对流程与文案中限定为本人设备（R6） |

## 10. 官方依据

- Anthropic Agent SDK 概览（认证、品牌）：https://code.claude.com/docs/en/agent-sdk/overview
- Anthropic Claude Code 法务与合规（凭据使用、内置 Claude Code）：https://code.claude.com/docs/en/legal-and-compliance
- Anthropic 认证：https://code.claude.com/docs/en/iam ；Headless：https://code.claude.com/docs/en/headless
- Anthropic Consumer Terms / AUP：https://www.anthropic.com/legal/consumer-terms ，https://www.anthropic.com/legal/aup
- Codex app-server（initialize、clientInfo、认证、限额、schema）：https://developers.openai.com/codex/app-server ；README：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Sign in with ChatGPT：https://developers.openai.com/siwc/request-client-id
- OpenAI Terms of Use / Usage Policies：https://openai.com/policies/terms-of-use ，https://openai.com/policies/usage-policies
- t3code：https://github.com/pingdotgg/t3code （`AGENTS.md`、`docs/internals/03_providers.md`）
