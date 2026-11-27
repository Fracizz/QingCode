# QingCode Next — MVP 之后的需求规划

> 2026-11-25 起草，依据为 `docs/mvp.md` §1 和旧版 `D:\code\qingcode` 功能盘点。当前实现与验收状态见进度总览，任务细节见 `docs/tasks/`。

## 1. 规划起点（2026-11-25）

- server 文件能力只有 `fs.home`、`fs.list`（仅用于添加项目时选目录）；无读写、无 Git、无终端。
- 对话里"点击查看文件"不可用：
  - 文件改动卡片的路径是纯文本（`renderer/src/components/MessageItem.tsx` `FileChangeItem`）。
  - Markdown 里的文件链接（如 `[foo.ts](/abs/foo.ts:12)`）走 `target="_blank"`，`main/index.ts` 的 `setWindowOpenHandler` 只放行 http(s)，点击无反应。
  - 行内代码中的路径（`src/a.ts:42`）不可点。

## 2. 规划起点与旧版的差距（2026-11-25）

| 模块 | 旧版 | Next |
|---|---|---|
| 文件查看 | 编辑器标签、图片/Markdown 预览、大文件分段（`read_file_slice`）、编码检测 | 无 |
| 文件树/操作 | 新建、重命名、删除、移动、复制、属性、冲突对话框、文件监听 | 仅 `fs.list` |
| 搜索 | 文件名搜索、内容搜索（可取消）、替换预览 | 无 |
| Git | status / diff / stage / unstage / discard / commit / branch list / switch / fetch / pull / push / log / 提交文件内容 / 推送同步 | 无 |
| 编辑保存 | 写文件、格式化、外部修改重载 | 无 |
| 终端 | 本机 + SSH PTY、后台托管与接回、手机端终端 | 无 |
| 其他 | 运行配置（RunPanel）、qingcode-cli 子命令、工作区信任、文件上传下载、命令面板、远端 server 管理（日志/重启/更新）、远端系统指标、多窗口、自动更新、Windows 远端 | 无 |

## 进度总览（2026-11-26，`next` @ `c911111e`）

✅ 已实现　🔄 已实现部分功能，仍缺交付条件　⏳ 待验收　⏸ 延后　❌ 已决定不做。验收指在真实目标机或 Android 设备上跑通。

### 第二波（T16–T28）

| 卡 | 内容 | 状态 | 备注 |
|---|---|---|---|
| T16 / T17 | server 文件、Git 协议 | ✅ | 10.87（Windows）经直连实测 `git.status`、`fs.read` |
| T18 / T19 / T20 | 文件查看面板、Git 面板、文件树与搜索 | ✅ | 已接入右侧停靠栏（Ctrl+P、Ctrl+Shift+E/F/G） |
| T21 | 终端技术验证 | ✅ | 结论见 `docs/spikes/terminal.md` |
| 直连 | 服务端直连（TLS + 证书指纹固定） | ✅ | 10.87 跑通 Claude；直连界面、并入 daemon、每客户端授权由 qingcode-next-cc 完成 |
| T22 | pi 适配（`pi --mode rpc`） | ✅ | 模型列表改为只借用运行中的进程（见第三波 A5） |
| T23 | 设置界面 | ✅ | 已接入侧栏与 Ctrl+,。Agent 配置目录已接入进程启动（见 A3） |
| T24 | Windows 目标 server 行为补齐 | ✅ | 路径、编码、监听、搜索、Git 和 Agent 解析已有本机验收记录。直连和远端 SSH 等场景见 [Windows 验收 §7](windows-acceptance.md) |
| T25 | CodeMirror 6 编辑与保存、冲突合并、差异视图 | ✅ | 编码（BOM/UTF-16）保存透传已补；界面待人工过一遍 |
| T26 | 运行配置（兼容旧版 `.qingcode/run.json`） | ✅ | 已接入停靠栏「运行」（Ctrl+Shift+R）与命令面板。界面与 10.87 实测待做 |
| T27 | Claude 模型与推理强度选择 | ✅ | 无会话时返回官方别名静态列表 |
| T28 | 手机端多 Agent、模型选择、只读查看文件 | ✅ | 已打出 Beta APK。手机端使用电脑设置的 Agent 路径。项目文件工具和真机验收见 T39 |
| — | 远程连接记住密码、密码框显示/隐藏 | ✅ | 总管 |

### 第三波（原排期见 [下一波功能清单](next-wave.md)）

| 编号 | 内容 | 状态 | 备注 |
|---|---|---|---|
| A1 | 运行面板接入、T28 补齐与 APK 出包 | ✅ | 当前工作区已有 `0.0.2-beta.1795733207001` 的 Windows x64 NSIS 安装包和 Android APK |
| A2 | 10.87 Windows 直连、93 Linux SSH 完整验收 | ⏳ | 已有 Claude 直连、文件/Git 和 Linux daemon 终端等分项记录。完整验收仍待补齐 |
| A3 | 设置生效：紧凑密度 | ✅ | `styles.css` 按 `html[data-density="compact"]` 收紧间距；界面待人工确认 |
| A3 / T38 | Agent 配置目录生效 | ✅ | 按目标把设置传到 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。Codex 空闲时重启以应用变更，Claude 在新 query 中使用新目录。见 [T36 合卡第二部分](tasks/T36-access-mode.md) |
| A4 | pi 模型/思考强度选择 | ✅ | 选择器本已通用；空列表每 15 秒可重取，pi 会话启动后自动出现 |
| A5 | pi 模型列表不再临时起进程 | ✅ | 只借用运行中的会话进程并缓存（`packages/server/src/pi/host.ts`） |
| T29 | 终端协议、daemon 托管、Python PTY、断线接回 | ✅ | 93 上 daemon 端到端实测 34 项通过，覆盖断线接回及 `script` 兜底。`ensure --replace` 遇到活动终端会保留旧 daemon 并提示稍后重试（`d7d71786`、`55890c09`） |
| T30 | 桌面终端界面（xterm） | ✅ | 已接入底部面板、工具栏、快捷键和命令面板。支持多标签、搜索、复制粘贴及断线接回（`d7d71786`） |
| T31 | 本机 Windows ConPTY | 🔄 | 后端适配和原生资源复制逻辑已实现。打包环境需准备 `@lydell/node-pty` 与同版本的 `@lydell/node-pty-win32-x64`，并在 10.87 验证安装后的加载、输入输出和 resize。见 [T31](tasks/T31-windows-conpty.md) |
| T32 | 手机端终端 | ✅ | 随 T39 实现，由电脑端单独开启。网关只向已订阅的配对设备转发终端输出。待真机验收 |
| T33 / T34 | CLI 子命令、工作区信任（旧版迁移） | ❌ | 用户决定不做 |
| T35 | 输入框 `@` 引用文件、粘贴/拖入图片 | ✅ | 拖入、粘贴和选图共用附件校验。桌面发送多张图片时仍缺合计大小检查，Base64 编码后的请求可能超过 16 MiB 协议帧上限 |
| T36 | 访问模式选择器 | ✅ | 桌面 Codex 和 Claude 可按会话选择访问模式。pi 显示无审批状态（`d7d71786`） |
| T37 | 命令面板（Ctrl+Shift+P / F1） | ✅ | `features/palette/`，已接入 App.tsx；界面待人工确认 |
| D4 | 斜杠命令 | 🔄 | 桌面输入框已有内置命令与技能菜单。Agent 原生命令的通用透传仍是可选项 |
| T39 | 手机端工作台与会话恢复 | ✅ | 已接入双电脑会话隔离、恢复与重新配对、扫码和配对链接、选图、只读文件浏览/搜索/下载，以及从 HTTPS 地址或本地 APK 手动更新。待补双电脑切换、换网、扫码、选图、下载及覆盖安装的真机验收。见 [T39](tasks/T39-mobile-workspace.md) |
| E / F 组 | 远端运维、文件树上传/拖放、桌面自动更新等 | ⏸ | 远端 server 管理和系统指标、安装包发布签名、浅色主题、多窗口、手机 Git 写操作及连接预热延后。见 [原清单 E / F 组](next-wave.md) |

对外发布涉及 Claude 订阅登录时，按 [Agent 适配规范 §3.3](agent-adapters.md) 取得书面确认，或默认只开放 API key 路径。

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

### P2 — 终端

- POSIX 目标使用 Python PTY，缺少 Python 时由 `script` 兜底。Windows 本机的 ConPTY 后端通过桌面包中的原生资源加载，打包验收见 T31。
- 桌面支持多终端标签与断线接回。手机端支持查看和输入，须在电脑端单独开启。

### P3 — 原规划中的其他旧版能力

运行配置、qingcode-cli 子命令兼容、工作区信任、文件上传下载/拖放、命令面板、远端 server 管理（日志/重启/更新）、远端系统指标、Windows 远端、多窗口、自动更新、扫码配对、pi 适配。各项状态见进度总览。

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
5. 手机端支持只读项目文件浏览、搜索、下载，以及在对话中查看文件和差异。文件与 Git 写操作由桌面端提供。

## 8. 实施约定

- 契约先行：协议类型 `packages/protocol/src/workspace.ts`；server 分发 `packages/server/src/workspace/`（`fs/`、`git/` 各自登记处理函数，daemon 不再逐个加 case）；渲染进程 `features/workspace/serverCall.ts`（类型化调用）与 `openers.ts`（打开文件/差异总线）。
- 渲染进程功能放 `features/<名称>/`，只导出集成点；接入布局（App、MessageItem、侧栏）由总管统一完成。
- `fs.watch` 每连接一个集合、全量替换：各功能导出自己的监听路径，由总管合并登记。
