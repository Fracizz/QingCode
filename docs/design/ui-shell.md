# QingCode Next 桌面端 UI 设计规范 v2

> 状态：v2（2026-11-25），替代 v1 外壳骨架方案。协议与业务以 `docs/mvp.md` 为准，本文只管界面结构、视觉语言与组件约定。
> **参考优先级：Codex 桌面版 > Orca > t3code > 旧版 QingCode。**

## 1. 借鉴来源与取舍

| 来源 | 借鉴 | 不照搬 |
|---|---|---|
| **Codex 桌面版（优先）** | 通栏标题栏（侧栏开关 + 右上角额度胶囊）；侧栏顶部工作区切换 + "新会话"；项目下直接缩进列会话、运行中转圈；主区顶栏只放会话标题；居中消息流，用户消息右侧灰色气泡、回复无边框；连续工具步骤折叠成一行；圆角大输入框 + 模型/推理强度/速度选择器 + 上下文占用环；新会话草稿态（发第一条消息才建会话） | 文件/编辑/视图菜单（已去掉系统菜单栏）、语音输入 |
| **Orca** | 输入框下方环境信息行（目标 · 目录）；"已运行 3 条命令 · 1 个失败"式摘要 | 多标签页、右侧文件面板、底部状态栏 |
| **t3code** | 项目 → 会话两级树；空态只给一个主操作 | — |
| **旧版 QingCode** | 品牌青只表达"当前上下文"（青轨）；进场页 | IDE 式活动栏 |

## 2. 原则

1. **对话优先**：侧栏 + 主区两栏；消息与输入框同宽 `max-w-3xl` 居中。
2. **一处一事**：同一错误只在最相关处出现一次（连接失败在目标切换器，Agent 打开失败在主区横幅）。
3. **一个主操作**：每屏只有一个实心主按钮；草稿页只在走不下去时给主操作（未连接 → 连接；无项目 → 添加项目）。
4. **青色克制**：`brand` 青只用于 Logo、青轨、展开的项目图标、运行中；按钮与焦点用 `accent` 蓝；发送键用 Codex 式白色圆钮。

## 3. 布局

```
┌ TitleBar 38px（chrome）─────────────────────────────────────────────────┐
│ [⊟] [Logo QingCode Next]                     [⊙ 本机 · 5h 32% ▾] [─ □ ×]│
├ Sidebar 288（220–460）────┬ Main ──────────────────────────────────────┤
│ ● 本机 ▾      已就绪       │ 💬 会话标题  📁 项目   [运行中]   Codex  ⋯ │ ← MainHeader 44px
│ ✎ 新会话          Ctrl N   │                                            │
│ 项目                  [+]  │   用户消息 ─────────────► [灰色气泡]       │
│ 📂 QingCode         刚刚   │   回复正文（Markdown，代码块 shiki 高亮）   │
│  ┃ 修复登录超时    ◌        │   ☰ 已运行 3 条命令 · 1 个失败  ›           │
│    重构部署脚本   3 小时   │                                            │
│ 📁 work            11/18   │  ╭ 和 Codex 一起工作 ───────────────────╮  │
│ [旧版数据导入卡片]          │  │ [Codex ▾]        ◔ 6.2 Sol High ▾ (↑)│  │
│ [手机连接][导入旧版]  v0.0.1│  ╰──────────────────────────────────────╯  │
│                            │   ● 本机   📁 D:\Code\QingCode             │
└────────────────────────────┴────────────────────────────────────────────┘
```

| 区域 | 尺寸 | 内容 | 组件 |
|---|---|---|---|
| 标题栏 | 38px，`chrome` 底，整条可拖窗 | 侧栏开关、品牌；右侧"目标 · 额度"胶囊（Popover 看详情）；最右系统按钮占位 | `shell/TitleBar.tsx` |
| 侧栏 | 默认 288，220–460，双击手柄复位，`Ctrl+B` 收起 | 目标切换器、新会话、项目→会话树、旧版导入卡片、底部入口 + 版本号 | `shell/Sidebar.tsx` |
| 目标切换器 | — | 大号目标名 + 状态点 + 状态/额度；Popover 内可搜索，行内连接/断开，"…"菜单（编辑、忘记密码、删除），底部"添加 SSH 连接" | `shell/TargetSwitcher.tsx` |
| 项目树 | 行高 32 | 当前项目展开显示会话（默认 8 条）；当前会话青轨 + 选中底；运行中转圈、待审批琥珀标签；非 Codex 会话显示 Agent 图标；悬停换成"新会话 / 移除项目" | `shell/ProjectTree.tsx` |
| 主区顶栏 | 44px | 会话标题、所在项目、运行中徽标、Agent、"…"菜单 | `shell/MainHeader.tsx` |
| 消息流 | `max-w-3xl` 居中 | 草稿页 / 消息；连续 ≥2 个工具步骤折叠成摘要行；错误横幅；"回到底部"居中悬浮 | `ChatPanel.tsx`、`MessageItem.tsx`、`shell/WelcomePane.tsx` |
| 输入框 | 圆角 20px 卡片 | 自动增高（≤40% 视口）；左：Agent 选择（仅草稿态）；右：上下文占用环、模型选择器、发送/停止；下方环境行 | `Composer.tsx`、`AgentPicker.tsx`、`ModelPicker.tsx` |

> 去掉了 v1 的底部状态栏：目标状态在切换器与输入框环境行，额度在标题栏胶囊，Agent 状态在环境行与主区横幅，版本号在侧栏底部。
> 会话列表一次只加载一个 cwd（codex store 现状），同一时间只展开当前项目。

## 4. 交互约定

| 操作 | 方式 |
|---|---|
| 新会话 | 侧栏"新会话"、`Ctrl+N`、项目行悬停按钮、顶栏"…"菜单 → 进入**草稿态**，发第一条消息时才创建会话 |
| 选 Agent | 草稿态输入框左下 Agent 菜单；不可用的 Agent 置灰并显示原因；会话创建后 Agent 固定 |
| 选模型 | 输入框右下模型选择器：搜索模型 → 选模型 → 推理强度分段（Low/Med/High/XHigh/Max/极致，按模型支持项显示）→ 速度 Fast 开关（模型有加速档才显示）。偏好按 Agent 存 `localStorage['qn-model-prefs']`，发送时作为 `turn/start` 的 `model / effort / serviceTier` 覆盖；目标上没有该模型时回落默认。模型列表来自 `model/list`，为空（Claude 桥接）时不显示选择器 |
| 附件 | 粘贴、拖入主区或点输入框左下回形针添加，最多 8 个。图片（png/jpg/gif/webp）读成 data URL 随消息发送，边长 >2048 或 >5 MB 时缩放转 WebP；其他文件 ≤10 MB：本机目标直接引用本机路径，SSH 目标先经 `fs.write` 上传到目标机 `~/.qingcode-next/uploads/<日期>/`，上传中/失败时不能发送。发送为 `turn/start` 的 `image` / `mention` 输入；Claude 桥接转成图片内容块与"附件文件"说明 |
| 斜杠菜单 | 输入框开头输入 `/` 弹出：内置命令（`/new` 新会话、`/stop` 停止、`/refresh` 刷新）+ 技能（`skills/list`，Codex 原生；Claude 桥接扫描 `~/.claude` 与项目 `.claude` 下的 skills/commands）。↑↓ 选择、Enter/Tab 确认、Esc 关闭；选中技能显示为青色标签，空输入时退格移除；发送为 `skill` 输入（Claude 转成 `/name` 前缀） |
| 上下文占用 | `thread/tokenUsage/updated` 的 `last.totalTokens / modelContextWindow`，≥75% 琥珀、≥90% 红；悬停显示具体 token 数 |
| 工具步骤 | 连续 ≥2 个命令/文件改动/思考折叠成"已运行 N 条命令 · M 个失败 · 编辑了 K 个文件"，运行中默认展开 |
| 代码块 | 顶部语言名 + 复制；生成结束后用 shiki 高亮（JS 正则引擎，按需加载语言，>60K 字符不高亮） |
| 回复操作 | 悬停回复显出：复制 Markdown、"…"（复制纯文本、从这里开始新会话） |
| 侧栏 | `Ctrl+B` / 标题栏按钮收起；右缘拖宽，双击复位；存 `localStorage['qn-layout']` |
| 目标 | 本机启动自动连接；SSH 目标点选后按认证方式弹密码框或直接连接 |

## 5. 窗口外观与进场页

- `titleBarStyle: 'hidden'` + `titleBarOverlay`（颜色 `#141414` / 图标 `#a1a1aa` / 高 38，与 `--color-qn-chrome` 和标题栏高度同步）；非 macOS `Menu.setApplicationMenu(null)`；开发态补回 F12 / Ctrl+R。
- 标题栏 `qn-drag`，按钮等自动 `no-drag`；**所有 Radix 浮层与遮罩带 `qn-no-drag`**（它们 Portal 到 body，可能盖在拖动区上）。
- 系统按钮占位用 `env(titlebar-area-*)`，不支持时按 138px；macOS 左侧留 76px。
- 进场页：静态写在 `index.html`，React 只更新状态文字与淡出（`lib/splash.ts`、`hooks/useBootSplash.ts`）；最短 1200ms、最长 8s、`prefers-reduced-motion` 最短 300ms。

## 6. 视觉语言

### 色彩（`styles.css` `@theme`）

| Token | 值 | 用途 |
|---|---|---|
| `qn-chrome` | `#141414` | 标题栏、进场页、窗口底色、系统按钮区 |
| `qn-bg` | `#181818` | 主区 |
| `qn-sidebar` | `#1b1b1b` | 侧栏 |
| `qn-panel` | `#1f1f1f` | 输入框、卡片、弹窗 |
| `qn-elevated` | `#242424` | 菜单、Popover、Tooltip、Toast、用户消息气泡 |
| `qn-hover` / `qn-active` | `#262626` / `#2c2c2c` | 悬停 / 选中 |
| `qn-border` / `qn-border-strong` | `#2a2a2a` / `#3a3a3a` | 分隔线 / 控件与浮层边界 |
| `qn-text` / `qn-muted` / `qn-dim` | `#e6e6e6` / `#939393` / `#6b6b6b` | 正文 / 次要 / 辅助 |
| `qn-brand` | `#4ecdb5` | 青轨、Logo、当前上下文、运行中 |
| `qn-accent` | `#4f8cff` | 主按钮、焦点环、链接 |
| `qn-ok` / `qn-warn` / `qn-danger` | `#6fcf8f` / `#e2b55d` / `#ff6b63` | 已就绪 / 连接中·待审批·Fast / 错误 |

代码块与输出底色 `#141414`，主题 `github-dark-default`。

### 字号（根字号保持 16px）

Tailwind 尺寸全是 rem，**根字号不得改小**（v1 用 14px 导致 `text-xs` 只有 10.5px，整体偏小）。

| 档位 | 用途 |
|---|---|
| 26px semibold | 草稿页大标题 |
| 16px semibold | 目标切换器名称 |
| 15px semibold | 弹窗标题 |
| 14px | 消息正文（行高 1.7）、侧栏项目、输入框、主区标题 |
| 13px | 侧栏会话、按钮、菜单项、表单、工具步骤、弹窗正文 |
| 12px | 辅助说明、时间、徽标、环境行、代码（12–12.5px 等宽） |
| 11px | 最小档：Badge、kbd、版本号 |

### 尺寸

- 圆角：6px 输入框；8px 按钮、列表行、菜单项（`rounded-lg`）；12px 浮层、代码块（`rounded-xl`）；16px 弹窗；20px 输入框卡片；圆形只用于状态点与圆形图标按钮。
- 控件高度：图标按钮 32（紧凑 28）；列表行 32；菜单项 ≥32。
- 图标：12–13（徽标/环境行）、14–15（列表/工具条/菜单）、16（标题与主按钮）。

### 状态语义（`lib/targetStatus.ts` 统一）

未连接 灰点 · 连接中/部署中 琥珀点闪烁 · 已就绪 绿点 · 连接失败 红点。

## 7. 组件库与技术栈

**不使用成套组件库**，采用"无样式原语 + 自有 token"：

| 层 | 选型 | 说明 |
|---|---|---|
| 原语 | **Radix Primitives**（`radix-ui` 统一包） | Dialog / DropdownMenu / Popover / Tooltip / Tabs；焦点锁定、键盘导航、Esc/外点关闭、读屏语义由 Radix 负责 |
| 封装 | `components/primitives.tsx`、`components/ui.tsx` | `Menu*`、`Popover*`、`Tip`、`Tabs*`；`Modal`（Radix Dialog，高度封顶 `min(680px, 100vh-80px)`，只滚正文）、`IconButton`（自带 Tooltip）、`Badge`、`ErrorNote`、`Checkbox` |
| 样式 | Tailwind 4 + `@theme` token；`cn()` = `clsx` + `tailwind-merge` | `.qn-input / .qn-button / .qn-button-subtle` 在 `@layer components`，调用处工具类可覆盖 |
| 高亮 | **shiki**（`shiki/core` + JS 正则引擎） | 不需要 WASM，CSP 不放开 `wasm-unsafe-eval` |
| 图标 / 状态 | lucide-react / zustand | — |

新增浮层一律用 `primitives.tsx` 的封装，不再手写 `absolute` 弹层 + document 监听。

## 8. 代码结构

```
renderer/src/App.tsx                    外壳装配、TooltipProvider、全局快捷键、对话框
renderer/src/components/primitives.tsx  Radix 封装
renderer/src/components/ui.tsx          Modal / IconButton / Badge / ErrorNote / Checkbox …
renderer/src/components/shell/          TitleBar / Sidebar / TargetSwitcher / ProjectTree / MainHeader / WelcomePane / Logo
renderer/src/components/                ChatPanel / Composer / AgentPicker / ModelPicker / MessageItem / CodeBlock / …
renderer/src/store/models.ts            模型列表（按 agent+目标缓存）与模型偏好
renderer/src/lib/                       models / turnGroups / highlight / shiki / cn / splash / layout / targetStatus / time（纯逻辑均有单测）
```

## 9. 后续

- 多项目同时展开（需要 codex store 按 cwd 缓存会话列表），实现后侧栏与 Codex 一致地列出所有项目的最近会话。
- 长会话虚拟列表（`@tanstack/react-virtual`），需处理流式输出时的贴底滚动。
- `@` 文件引用（`fs.search`）、访问模式（审批/沙箱）选择器、命令面板（`Ctrl+K`）、设置页、浅色主题（token 已集中，按 `html[data-theme]` 覆盖）。
- Claude 会话里的 `<command-message>`、ANSI 转义等原始标记应在 conversation 层清洗。
