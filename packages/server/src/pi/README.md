# pi 适配（T22）

第三个 Agent。QingCode Next 只是**用户自己已安装并登录的 pi** 的界面：server 内的 pi 桥把
`pi --mode rpc`（官方 RPC 模式，JSONL over stdio）翻译成 codex app-server v2 的 JSON-RPC 形状，
渲染进程继续用 `@qn/codex-client` 的 RPC 与 reducer，界面不分叉。

## 官方协议依据

- 本机 `C:\Users\Administrator\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\`
  `rpc.md`、`rpc-commands.md`、`json.md`、`message-types.md`、`session-format.md`、`sessions.md`、`windows.md`
- 上游：<https://github.com/earendil-works/pi> （`packages/coding-agent/src/modes/rpc/`）
- 白名单见 `docs/agent-adapters.md` §2；只用 `pi --mode rpc`，不碰任何私有接口/私有存储。

## 支持 / 不支持决定表

| v2 方法 | 决定 | 实现 |
|---|---|---|
| `initialize` | 支持（仅桥内部） | 返回 `pi-rpc/<version>`；`codex.open` 结果的 `initialize` 为 `null`，客户端不得再发 initialize |
| `thread/list` | 支持 | 只读解析官方 `session-format.md` 的 `.jsonl` 会话头部（默认 `~/.pi/agent/sessions/`，尊重 `PI_CODING_AGENT_SESSION_DIR`），按 header 的 cwd 过滤 |
| `thread/start` | 支持 | `new_session` + `get_state`；会话 id 用 pi 自己的 `sessionId` |
| `thread/unsubscribe` | 支持临时会话 | 空闲时释放进程并通知 `thread/closed` |
| `thread/resume` / `thread/read` | 支持 | 元数据请求直接返回会话信息。完整历史经 `switch_session {sessionPath}` + `get_messages` 读取 |
| `thread/turns/list` / `thread/items/list` | 支持 | `get_messages` 历史按用户消息切分，按游标返回轮次或条目，连续分页短期复用同一快照 |
| `turn/start` | 支持**纯文本与 base64 图片** | `prompt {message, images?}`；`disposition=handled` 时不启动 run，桥自行收尾 |
| `turn/interrupt` | 支持 | `abort`；以 `agent_settled {aborted:true}` 映射 `turn/completed {status:'interrupted'}`，另设 1.5s 兜底 |
| `model/list` | 借用运行中的会话进程调用 `get_available_models` / `get_state` / `get_available_thinking_levels`，结果缓存；无运行中进程时返回缓存或空列表 | R9：不为列模型额外拉起 pi 进程；`turn/start` 的 `model`/`effort` 经 `set_model` / `set_thinking_level` 切换 |
| `skills/list` | **不支持** → `-32601` | pi 的 `/skill:name`、提示模板仍可直接在文本里输入，QingCode 不枚举私有资源目录 |
| `account/read`、`account/rateLimits/read` | **不支持** → `-32601` | pi 没有官方额度接口；`capabilities.rateLimits=false`，前端不显示额度徽标 |
| `thread/name/set`、`thread/archive`、`thread/delete`、`thread/fork` | **不支持** → `-32601` | pi RPC 没有等价的官方命令 |
| 审批（`item/*/requestApproval`） | **不实现、不伪造** | pi 没有审批机制；`capabilities.approvals=false`，输入框上方提示「pi 不经审批直接执行工具」 |
| `extension_ui_request` | **忽略，不代答** | 扩展对话框必须由用户本人决定；pi 自带 timeout 会自行兜底 |
| 其它未知 v2 方法 | **不支持** → `-32601` | 统一由 `handleRequest` 默认分支处理 |

`codex.open {agent:'pi'}` →
`{ initialize:null, lastSeq, agentVersion, capabilities:{ approvals:false, rateLimits:false, ephemeralNoTools:true } }`。
pi 未安装时抛 `AgentHostError('agent_unavailable', …)`，文案只提示用户用其原有方式安装/登录，
**不自动下载、安装或升级**。

## 进程与事件

- 临时侧聊使用 `--no-session --no-tools --no-extensions`，不写入会话历史。依赖扩展提供的模型在侧聊中不可用。侧栏收起后仍可追问，显式结束会释放进程。
- 每个会话一个 `pi --mode rpc` 进程；`cwd` = 会话目录；持久会话空闲 30 分钟关闭 stdin 并结束子进程；
  daemon 退出时结束全部子进程。进程退出且本轮未结束时补 `turn/completed {status:'failed'}`。
- 事件映射是纯函数 `items.ts`，单测回放 `fixtures/real-prompt.jsonl`（真实 pi 1.6.1 录的一次
  「列出当前目录」prompt；已去掉签名、路径与用户名，不含任何凭据）。
- `bash`/`powershell` → `commandExecution`；`edit`/`write` → `fileChange`（统一 diff）；
  其它工具 → `dynamicToolCall`。`thread/tokenUsage/updated` 来自 assistant 消息的 `usage`（估算）。
- `fixtures/fake-pi.mjs` 是测试用假 pi 进程，回放同一份 fixture，`e2e.test.ts` 用它跑 daemon 全链路。
  真实 pi 的集成测试默认跳过，需 `QN_PI_E2E=1` 显式开启（会消耗用户账号额度）。
- 图片：pi 的 `prompt` 只接受 `ImageContent`（base64 + mimeType）；v2 `image` 的 data URL 去掉头部后放进
  `images`，`localImage` 会读取用户指定的本地文件。`http(s):` 图片 URL 无法转换，返回 `-32602`
  （不自动下载、不外链，也不静默丢弃）。`model/list` 把 pi 模型的 `input` 映射为 `inputModalities`，
  模型声明不含 `image` 时桌面端禁用图片附件并提示。

## 合规检查清单（`docs/agent-adapters.md` §8）

1. 协议：`pi --mode rpc` 官方 JSONL over stdio，命令/事件形状取自上列 pi 包内文档；会话列表只读解析官方公开的
   `session-format.md`。无私有 HTTP / 私有 RPC。
2. 凭据与私有存储：**否**。不读 `auth.json`、models 配置、钥匙串；不改 `settings.json` / `config.toml`；
   会话文件只读且只取 header / 首条用户消息 / 会话名；子进程原样继承 `process.env`，不注入任何变量。
3. 身份：不新增 `clientInfo`（pi 桥没有 app-server 握手）；v2 线程归属写 `pi-rpc` / `qingcode-next`，
   不冒充 codex/claude 官方客户端；未声明 experimental 能力。
4. 审批：pi 原生没有审批 → 不生成任何 server→client 请求，`capabilities.approvals=false` 并如实提示；
   扩展 UI 对话框不代答（没有"自动允许"路径）。
5. 自动行为：无自动发送 prompt、无自动重试、无自动审批。`--version` 是唯一后台探测；不发心跳 prompt；
   不为探测/列模型/额度额外开 pi 会话。
6. 日志：所有 stderr / 错误信息经 `redact()`；日志不输出 prompt 内容与凭据；
   `items.ts` / `sessions.ts` / `turnInput.ts` 的纯函数都有 vitest 单测，并用真实 pi 录制的样例回放。
7. 不支持的方法：统一返回 JSON-RPC `-32601`，并在上表逐条写明决定。
8. 界面文案：Agent 名称显示小写字面量「pi」，图标用中性 `Cpu` 图形；不含 "Codex"/"Claude"/
   "OpenAI"/"Anthropic" 作为自有名称，也不暗示官方背书；额度徽标对 pi 隐藏。

## 已知限制 / 需总管处理

- `apps/desktop/src/backend/registerTargets.ts`、`serverClient.ts`、`mobile/gateway.ts` 里仍有
  `agent === 'claude' ? 'claude' : 'codex'` 形式的硬编码，桌面端/手机网关要把 `'pi'` 透传到
  `codex.send` 与 `codex.recv` 才能端到端工作（T22 范围外，未改）。
- `codex.open` 的 `capabilities` 尚未从 `store/codex.ts` 透传到 `Composer`；当前提示按
  `agent === 'pi'` 兜底显示，语义与 `capabilities.approvals===false` 等价。
- `turn/start` 的 `model`/`effort` 覆盖项被忽略（模型选择留在 pi 自己里）。
