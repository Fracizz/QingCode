# QingCode Next — MVP 之后的需求规划

> 状态：草案（2026-11-25）。依据：`docs/mvp.md` §1「不做（MVP 之后）」清单、旧版 `D:\code\qingcode` 功能盘点（233 个 Tauri 命令）。
> 本文只定范围、优先级与接口方向；落地时拆成 `docs/tasks/T16+` 任务卡，接口定稿后回填 `docs/mvp.md` §4 / §5。

## 1. 现状

- server 文件能力只有 `fs.home`、`fs.list`（仅用于添加项目时选目录）；无读写、无 Git、无终端。
- 对话里"点击查看文件"不可用：
  - 文件改动卡片的路径是纯文本（`renderer/src/components/MessageItem.tsx` `FileChangeItem`）。
  - Markdown 里的文件链接（如 `[foo.ts](/abs/foo.ts:12)`）走 `target="_blank"`，`main/index.ts` 的 `setWindowOpenHandler` 只放行 http(s)，点击无反应。
  - 行内代码中的路径（`src/a.ts:42`）不可点。

## 2. 与旧版差距

| 模块 | 旧版 | Next |
|---|---|---|
| 文件查看 | 编辑器标签、图片/Markdown 预览、大文件分段（`read_file_slice`）、编码检测 | 无 |
| 文件树/操作 | 新建、重命名、删除、移动、复制、属性、冲突对话框、文件监听 | 仅 `fs.list` |
| 搜索 | 文件名搜索、内容搜索（可取消）、替换预览 | 无 |
| Git | status / diff / stage / unstage / discard / commit / branch list / switch / fetch / pull / push / log / 提交文件内容 / 推送同步 | 无 |
| 编辑保存 | 写文件、格式化、外部修改重载 | 无 |
| 终端 | 本机 + SSH PTY、后台托管与接回、手机端终端 | 无 |
| 其他 | 运行配置（RunPanel）、qingcode-cli 子命令、工作区信任、文件上传下载、命令面板、远端 server 管理（日志/重启/更新）、远端系统指标、多窗口、自动更新、Windows 远端 | 无 |

## 进度总览（2026-11-26 更新）

| 卡 | 内容 | 状态 |
|---|---|---|
| T16 / T17 | server 文件、Git 协议 | 完成，已在 10.87（Windows）经直连实测 `git.status`、`fs.read` |
| T18 / T19 / T20 | 文件查看面板、Git 面板、文件树与搜索 | 完成，已接入右侧停靠栏（Ctrl+P、Ctrl+Shift+E/F/G） |
| T21 | 终端技术验证 | 完成，结论见 `docs/spikes/terminal.md`：远端 python3 pty；本机 Windows 需预编译 node-pty 类包 |
| 直连 | 服务端直连（TLS + 证书指纹固定），已在 10.87 跑通 Claude | 后端完成；直连界面、并入 daemon、每客户端授权由 qingcode-next-cc 负责 |
| T22 | pi 适配（`pi --mode rpc`） | 进行中 |
| T23 | 设置界面 | 进行中 |
| T24 | Windows 目标 server 行为补齐 + 本机验收 | 进行中（**优先**） |
| T25 | CodeMirror 6 编辑与保存、冲突合并、差异视图 | 进行中（**优先**） |
| T26 | 运行配置（兼容旧版 `.qingcode/run.json`，daemon 托管进程） | 进行中（**优先**） |
| T27 | Claude 模型与推理强度选择（pi 的同类功能在 T22 完成后追加） | 进行中（**优先**） |
| — | 远程连接记住密码、密码框显示/隐藏 | 完成（总管） |

下一步（按优先级）：
1. 收尾 T22–T27，统一审查提交；在 10.87（Windows，直连）与 93（Linux，SSH）完整验收。
2. 终端：先远端（python3 pty）+ daemon 托管与接回 + xterm 界面，再本机 Windows ConPTY。
3. 旧版迁移能力：CLI 子命令（`qingcode-cli` 技能依赖）、工作区信任。
4. 对话输入增强：`@` 文件引用、访问模式选择器、命令面板。
5. 其余 P3：文件传输、远端 server 管理、手机端文件/Git、扫码配对、自动更新、多窗口、浅色主题。
6. 发版闸门：Claude 订阅登录的合规确认（`docs/agent-adapters.md` §3.3）。

## 3. 架构原则

- **能力全部放在 qn-server**：本机与远端都是"客户端 → qn-server"，文件与 Git 只实现一次，不再像旧版那样为每个命令维护 `ssh_*` 副本。
- 纯逻辑（porcelain 解析、路径/链接解析、diff 处理）与 IO 分离，纯函数配 vitest 单测。
- 单帧上限 16 MiB（mvp.md §4），读文件必须限量 + 分段，二进制不走文本通道。
- 路径一律绝对路径；相对路径在客户端按会话 cwd / 项目根解析后再请求。
- server 侧只用 Node 内置模块；Git 直接调用 `git` CLI（远端缺 git 时返回明确错误码 `git_missing`）。

## 4. 协议扩展（草案，§4 req 方法）

### 4.1 文件

| method | params | result / 说明 |
|---|---|---|
| `fs.stat` | `{path}` | `{kind, size, mtimeMs, mode?}`；不存在返回错误 `not_found` |
| `fs.read` | `{path, offset?, length?, encoding?}` | `{content, encoding:"utf8"\|"base64", size, mtimeMs, truncated, binary}`；默认上限 2 MiB，超出 `truncated:true` 并可按 offset 续读；检测到二进制时 `binary:true`，图片按 base64 返回（上限 10 MiB） |
| `fs.write` | `{path, content, encoding?, expectedMtimeMs?}` | `{mtimeMs}`；`expectedMtimeMs` 不符返回 `conflict`（外部已修改）；写临时文件再 rename |
| `fs.mkdir` | `{path}` | `{}`（递归） |
| `fs.createFile` | `{path}` | `{}`；已存在返回 `exists` |
| `fs.rename` | `{from, to}` | `{}`；目标存在返回 `exists` |
| `fs.delete` | `{path, recursive?}` | `{}`；目录非空且未传 `recursive` 返回 `not_empty` |
| `fs.search` | `{root, query, mode:"name"\|"content", glob?, caseSensitive?, maxResults?}` | `{searchId}`；结果经 `evt fs.searchResult {searchId, matches, done}` 流式推送；远端有 `rg` 用 `rg --json`，否则 Node 遍历（跳过 `.git`、`node_modules`） |
| `fs.searchCancel` | `{searchId}` | `{}` |
| `fs.watch` | `{paths}` | `{}`；以客户端连接为单位维护监听集合（全量替换），变化经 `evt fs.changed {paths}` 去抖推送（200ms） |

### 4.2 Git

所有方法带 `cwd`（仓库内任意目录），server 先 `git rev-parse --show-toplevel` 取根。

| method | params | result / 说明 |
|---|---|---|
| `git.status` | `{cwd}` | `{root, branch, upstream?, ahead, behind, files:[{path, origPath?, index, worktree, conflict}]}`；基于 `status --porcelain=v2 -z --branch` |
| `git.diff` | `{cwd, path?, staged?, contextLines?}` | `{diff}`（统一 diff 文本，上限 4 MiB） |
| `git.show` | `{cwd, path, ref?}` | `{content, binary}`；默认 `HEAD`，用于"与 HEAD 对比" |
| `git.stage` / `git.unstage` | `{cwd, paths}` | `{}` |
| `git.discard` | `{cwd, paths}` | `{}`；未跟踪文件需显式 `includeUntracked:true` |
| `git.commit` | `{cwd, message, amend?}` | `{commit}` |
| `git.branches` | `{cwd}` | `{current, local:[...], remote:[...]}` |
| `git.switch` | `{cwd, branch, create?}` | `{}` |
| `git.fetch` / `git.pull` / `git.push` | `{cwd, remote?, branch?}` | `{output}`；凭据走远端已有配置（ssh-agent / credential helper），交互式认证失败返回 `auth_required`，不做密码转发 |
| `git.log` | `{cwd, path?, limit?, skip?}` | `{commits:[{hash, parents, author, date, subject}]}` |
| `git.commitFiles` | `{cwd, commit}` | `{files:[{path, status}]}` |

错误码统一：`not_repo`、`git_missing`、`conflict`、`auth_required`、`git_failed`（附 stderr 摘要，不含凭据）。

## 5. 功能规划与优先级

### P0 — 点击查看文件（文件查看面板）

- 右侧主区新增**文件查看面板**：可与对话并排（分栏可拖动），标签页，只读，语法高亮，跳转行号，图片预览，Markdown 预览切换，大文件提示"仅显示前 2 MiB / 加载更多"。
- 可点击入口：
  1. 文件改动卡片：路径可点击打开；增加"打开文件""与 HEAD 对比"按钮。
  2. Markdown 链接：识别本地路径（绝对路径、`file://`、带 `:行` / `#L行` 后缀），拦截后在面板打开；http(s) 仍走系统浏览器。
  3. 行内代码 / 命令输出中的路径：识别 `path:line[:col]` 模式（纯函数 + 单测），悬停下划线、点击打开。
- 相对路径按当前会话 cwd 解析；文件不存在时提示，不报错崩溃。
- 依赖：`fs.stat`、`fs.read`、`git.show`；高亮库待选（见 §7）。

### P1 — Git 面板

- 侧栏新增"源代码管理"：变更列表（暂存 / 未暂存 / 冲突分组）→ 点击在面板查看 diff → 暂存/取消暂存/放弃（放弃需确认）→ 提交框（Ctrl+Enter 提交）→ 推送/拉取。
- 标题栏或状态栏显示当前分支、ahead/behind；分支菜单切换/新建分支。
- 提交历史列表，点击查看提交内文件与 diff。
- 对话联动：turn 结束后自动刷新 status；会话内"本轮改动"可跳 Git 面板。

### P1 — 文件树与搜索

- 项目下展开文件树（懒加载 `fs.list`），右键：新建文件/文件夹、重命名、删除（确认）、复制路径、在系统中显示（仅本机）、添加到对话。
- `fs.watch` 驱动刷新；Git 状态着色。
- 搜索面板：按文件名（Ctrl+P 快速打开）与按内容，结果点击跳转行。

### P2 — 编辑与保存

- 查看面板升级为可编辑，Ctrl+S 保存，`expectedMtimeMs` 冲突时提示"外部已修改：覆盖 / 重新加载 / 对比"。
- 外部修改（含 Agent 改动）自动重载未修改的标签。

### P2 — 终端（需先做技术验证）

- 风险：远端 qn-server 为 esbuild 单文件，无法直接携带 `node-pty` 等原生模块。
- 候选：按平台分发 node-pty 预编译包随 server 上传；或远端用 `python3 -c 'import pty'` / `script` 兜底；本机 Windows 用 ConPTY（node-pty）。
- 需求：多终端标签、断线接回（沿用 server 常驻 + seq 缓冲思路）、手机端查看。

### P3 — 其他旧版能力

运行配置、qingcode-cli 子命令兼容、工作区信任、文件上传下载/拖放、命令面板、远端 server 管理（日志/重启/更新）、远端系统指标、Windows 远端、多窗口、自动更新、扫码配对、pi 适配。按用户反馈再排。

## 6. 任务拆分建议

| 卡 | 内容 | 范围 | 依赖 |
|---|---|---|---|
| T16 | server 文件协议（§4.1）+ protocol 类型 + 单测 | `packages/server`、`packages/protocol` | — |
| T17 | server Git 协议（§4.2）+ porcelain 解析单测 | `packages/server`、`packages/protocol` | — |
| T18 | 文件查看面板 + 三类点击入口 + 路径识别纯函数 | `apps/desktop/src/renderer`、`main`（链接拦截） | T16（可先 mock） |
| T19 | Git 面板 | `apps/desktop/src/renderer` | T17、T18 |
| T20 | 文件树 + 搜索 | `apps/desktop/src/renderer` | T16 |
| T21 | 终端技术验证（spike，出报告不出功能） | 独立目录 | — |

T16/T17/T21 可并行；T18 可与 T16 并行（先用 mock 后端）。backend 层 `server.req` 已透传，原则上无需改 backend。

## 7. 决策（2026-11-25 按推荐定）

1. P0/P1 只读查看用 shiki 高亮；编辑器定为 CodeMirror 6（T25，2026-11-26 用户确认）。
2. 文件查看面板与对话并排分栏，可收起（实现为右侧停靠栏：文件面板 + 工具列）。
3. Git 推送/拉取只依赖远端已有凭据（ssh-agent / credential helper），`GIT_TERMINAL_PROMPT=0` + `BatchMode=yes` 快速失败，返回 `auth_required`。
4. 终端路线：远端 python3 pty 为主、`script` 兜底；本机 Windows 用预编译 node-pty 类包（T21 结论）。
5. 手机端暂不提供文件 / Git，后续按需只读开放（网关白名单另加）。

## 8. 实施约定

- 契约先行：协议类型 `packages/protocol/src/workspace.ts`；server 分发 `packages/server/src/workspace/`（`fs/`、`git/` 各自登记处理函数，daemon 不再逐个加 case）；渲染进程 `features/workspace/serverCall.ts`（类型化调用）与 `openers.ts`（打开文件/差异总线）。
- 渲染进程功能放 `features/<名称>/`，只导出集成点；接入布局（App、MessageItem、侧栏）由总管统一完成。
- `fs.watch` 每连接一个集合、全量替换：各功能导出自己的监听路径，由总管合并登记。
