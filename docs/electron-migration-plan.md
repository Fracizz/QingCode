# QingCode 迁移到 Electron 方案

> 状态：方案草案（2026-11-25）。尚未开工，分支计划为 `electron-migration`（从 `master` 拉出）。

## 1. 目标与动机

- 外壳从 Tauri 2 迁到 Electron：Chromium 渲染一致、成熟的自动更新、可直接使用 TS 生态的官方 Agent SDK。
- 新增**对话模式**：在现有"终端里跑官方 CLI"之外，用结构化协议驱动 Claude Code / Codex / pi，终端与对话共享同一会话 id，可互相 resume（不同时运行）。
- 不丢现有能力：后台托管终端、SSH 远端服务（qingcode-server）、Android 接回、信任机制、Windows ConPTY 经验。

## 2. 参考项目要点

| 项目 | 栈 | 借鉴 |
|---|---|---|
| orca（stablyai/orca） | Electron + node-pty + ssh2 + React 19 + zustand + Radix/shadcn + Monaco + xterm | PTY 优先接任意 CLI；worktree 并行；性能 ratchet / bench 进 CI；原生模块不进主进程 |
| t3code（pingdotgg/t3code） | Node/Effect，server-client 分离，web/desktop/mobile 共用 client-runtime | 服务端拥有一切、客户端瘦；provider 适配器 + 能力声明；`codex app-server` / ACP；隐藏 git ref 做检查点 |
| pi（earendil-works/pi） | TS CLI | `pi --mode rpc`（JSONL，按 id 关联，`agent_settled` 判结束）或 `createAgentSession` SDK |

## 3. 路线选择

| | A：Electron 外壳 + Rust host sidecar（**采用**） | B：Rust 全部重写为 Node |
|---|---|---|
| 做法 | Rust 核心去 Tauri 化，编为独立 `qingcode-host.exe`；前端把 `invoke`/`listen` 换成 RPC 客户端 | 233 个命令、终端、SSH、远端服务、移动端全部 TS 重写 |
| 工期 | 3–6 周 | 数月 |
| 风险 | 低，已踩过的坑全部保留 | 高 |
| 远程/移动 | qingcode-server、Android 协议不变 | 需重做或写兼容层 |

## 4. 现状摸底

| 项 | 数量 / 位置 |
|---|---|
| Tauri 命令 | 233 个（`src-tauri/src/lib.rs` `generate_handler!`） |
| 前端 invoke 收口 | `src/lib/tauri.ts`（含 SSH 命令路由） |
| 前端 `@tauri-apps/*` 引用 | event 21、dialog 19、opener 17、mocks 13、window/webview/path 约 10 |
| 浏览器测试后端 | `src/dev/webTestBackend.ts`、`src/dev/webTestRuntime.ts`（传输层已可替换） |
| Rust 与 Tauri 耦合 | 131 个 .rs 中 72 个使用 `AppHandle` / `State<>` / `emit` |
| Rust 已有网络栈 | hyper + tokio-tungstenite（mobile、remote_ssh/direct） |

## 5. 目标架构

```
Electron
 ├─ main：窗口、托盘、自动更新、原生对话框、外部打开（取代 plugin-dialog/opener）、单实例
 ├─ preload：contextBridge 暴露 rpc / dialog / shell
 ├─ renderer：现有 React 前端
 │    └─ src/lib/tauri.ts → src/lib/backend.ts（RPC 客户端，按环境选择传输）
 ├─ utilityProcess（Node）：对话模式 Agent 适配
 │    Claude Agent SDK / codex app-server（JSON-RPC）/ pi --mode rpc
 └─ 子进程 qingcode-host.exe（Rust，原 src-tauri 核心）
      命名管道；控制消息 JSON，终端数据二进制帧
```

原则：

- 主进程零业务、零同步 I/O；native 模块只在 host / utilityProcess。
- 终端数据不走 base64 JSON；后台标签停渲染，仅维护 vt100 状态；接回先发快照再接流。
- 统一 Agent 事件模型：消息增量、工具调用、审批请求、文件改动、本轮结束、用量；UI 只看能力不看 Agent 名。

## 6. 迁移步骤与工作量

按"专注会话"（约 1–2 小时、做完一个模块）估算。

| 阶段 | 内容 | 会话数 | 可机械化 | 中途停下价值 |
|---|---|---|---|---|
| 0 设计 | HostContext、事件总线、RPC 协议、本计划细化 | 1–2 | 否 | 高 |
| 1 Rust 去 Tauri 化 | `AppHandle`→`HostContext`，`State<>`→`Arc<T>`，`emit`→事件总线，命令→分发表；保留 Tauri 适配层过渡 | 8–15 | 大部分（ast-grep / 脚本） | **高**：Tauri 版照样可用 |
| 2 host 独立进程 | 命名管道 + 二进制帧 + 233 个命令接分发表 | 3–5 | 部分 | 中 |
| 3 前端传输层 | `invoke`→`rpc.call`，`listen`→`rpc.on`；dialog/opener/window 走 preload | 3–5 | 大部分 | 中 |
| 4 Electron 外壳 | electron-vite（main/preload/renderer）、窗口、托盘、单实例、Open with | 3–5 | 否 | 低 |
| 5 打包与 CI | electron-builder + NSIS、附带 host.exe、release 流程、Tauri→Electron 过渡更新版本 | 3–6 | 否 | 低 |
| 6 回归 | 终端、SSH、移动端、文件功能对等验证 | 5–10 | 否 | — |
| **小计** | | **约 26–48** | | |
| 7 对话模式 | 三个 Agent 适配器 + 对话 UI | 10–20 | 否 | — |

### 省额度做法

1. 机械改动先让 AI 写 ast-grep 规则 / codemod，一次跑完，AI 只处理编译错误与特例。
2. 批量修错、补测试用便宜模型；架构与疑难问题用强模型。
3. 每个模块新开会话，用本文档交接进度。
4. 先 grep 定位再读片段，避免通读大文件。
5. 优先完成阶段 0–1：即使不迁移也是净收益。

### 备选：先不迁移

若主要诉求是对话模式，可在现有 Tauri 版加一个 Node sidecar 跑 Agent 适配（约 10–20 个会话），Electron 迁移延后。

## 7. Agent 接入

| Agent | 对话模式 | 终端模式 | 续接 |
|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk`（`canUseTool` 审批、`resume`、流式消息） | PTY 跑 `claude` | session_id，`~/.claude/projects/*.jsonl` |
| Codex | 子进程 `codex app-server`（JSON-RPC，thread/turn/item，审批事件）；类型从其 schema 生成 | PTY 跑 `codex` | thread id，`~/.codex/sessions` |
| pi | 子进程 `pi --mode rpc` + `RpcClient`（隔离崩溃） | PTY 跑 `pi` | JSONL 会话 |
| 其他 | ACP TS SDK 通用适配 | 任意 CLI | — |

Windows 注意：npm 安装的 CLI 是 `.cmd` shim，需单独解析；pi 依赖 Node ≥ 22；ConPTY 的 resize / 宽字符 / 子进程残留沿用现有处理。

## 8. 前端组件

- 迁移期间**不换组件库**，避免两种改动混在一起。
- 之后底层交互换为 Radix 原语（或 Base UI，二选一），按 shadcn 方式复制源码进项目，样式继续用 `src/styles/theme.css` token 与 `DESIGN.md` 规范。
- 配套：`cmdk`（命令面板）、`sonner`（提示）、`react-resizable-panels`（分栏）、`@dnd-kit`（拖拽排序）、`lucide-react`（图标）。
- 替换优先级：ContextMenu → Dialog → Select → Tooltip（焦点、层级、键盘问题最多）。
- 对话 UI：`react-markdown` + `shiki`（worker 内高亮），消息列表虚拟滚动；工具调用 / 审批 / diff 卡片自研。
- 编辑器与终端不变：CodeMirror 6 + `@codemirror/merge`、xterm。
- 不选 Ant Design / Arco / Semi / MUI / Mantine / Fluent：自带视觉与 IDE 深色风格冲突、体积大或与 Tailwind 4 混用别扭。

## 9. 分支与发布

- 从 `master` 拉 `electron-migration`，定期合入 master；迁移期间 master 冻结大规模 Rust 重构。
- 对等验收通过后删除 Tauri 适配层并切换发布渠道；现有用户需一个 Tauri 过渡版本引导下载 Electron 安装包。
- 迁移完成后可删除 `src-tauri/vendor/tao` 补丁。

## 10. 风险与影响

- 安装包约 16MB → 约 100MB，空闲内存明显上升；README "不打包 Chromium"等表述需修改。
- 构建链变为 pnpm + electron-builder + cargo（host）。
- Claude stream-json / 控制协议文档不全，需版本探测与兼容测试；Codex app-server 协议演进中，类型必须从 schema 生成。
- Android 端与 qingcode-server 协议不变，不受影响。
