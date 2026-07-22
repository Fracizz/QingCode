# QingCode Design

QingCode 是一款轻量桌面代码编辑器的设计规范。整体风格参考 **Cursor / VS Code** 深色 IDE 语言，图标体系参考 **OpenCode** 桌面端约定。

---

## 设计原则

1. **深色优先** — 默认深色主题，浅色为可选模式
2. **低干扰** — 界面为代码服务，避免装饰性元素
3. **语义分层** — 背景、边框、文字、强调色有明确层级
4. **小尺寸可读** — 图标、拖拽条、状态栏在 16px 级别仍清晰
5. **填充优于描边** — 应用图标与关键图形优先使用 fill，保证 rasterize 后清晰

---

## 色彩

所有颜色 token 定义于 `src/styles/theme.css`，通过 Tailwind 语义类使用（如 `bg-bg`、`text-fg-muted`、`border-border`）。

### 深色主题（默认）

| Token | 值 | 用途 |
|-------|-----|------|
| `bg` | `#1e1e1e` | 主编辑区、窗口背景 |
| `bg-deep` | `#181818` | 活动栏、终端底 |
| `bg-sidebar` | `#252526` | 侧边栏面板 |
| `bg-elevated` | `#2d2d30` | 浮层、Tooltip、菜单 |
| `bg-hover` | `#2a2d2e` | 悬停态 |
| `bg-active` | `#37373d` | 激活/选中态 |
| `border` | `#2d2d30` | 常规分隔线 |
| `border-strong` | `#3c3c3c` | 强调边框 |
| `fg` | `#d4d4d4` | 主文字 |
| `fg-muted` | `#a8a8a8` | 次要文字、状态栏 |
| `fg-dim` | `#a0a0a0` | 占位、禁用 |
| `brand` | `#4ecdb5` | QingCode 品牌、当前工作上下文、Qing Rail |
| `accent` | `#4d9eff` | 键盘焦点、加载、链接、拖拽高亮 |
| `danger` | `#f48771` | 错误、删除 |
| `warn` | `#e2c08d` | 警告、未保存标记 |
| `ok` | `#89d185` | 成功 |

### 品牌色与功能色

- **Qing Rail（青轨）**：当前活动栏视图、活动编辑器/终端标签、当前项目与设置分类使用 2px `brand` 轨道，来源于应用图标的青台。
- **`brand` 不代替 `accent`**：青色只表达产品身份和当前工作上下文；功能强调色继续表达键盘焦点、加载、拖放、链接和计数等反馈（深色/浅色为蓝，森林为琥珀）。
- 状态栏使用中性 `bg-deep`，当前项目图标使用 `brand`，避免整条功能蓝背景削弱品牌层级。行内可点项用 `text-fg` + `hover:bg-hover`，次级文案用略透明主色（勿用整条 `accent` 底）。

### 浅色主题

通过 `html[data-theme="light"]` 覆盖，见 `src/styles/theme.css`。主题切换逻辑在 `src/lib/themeSettings.ts`。

### 森林主题（IDEA Material Forest）

森林主题以 JetBrains IDEA 的 Material Theme UI「Material Forest」官方色板为骨架，并保留 QingCode 的 Qing Rail。背景、激活态、边框、选择色和语法色遵循 Material Forest；仅对官方过暗的次要文字/代码注释以及现有白字按钮做可读性适配。

| 语义 | 值 | 用途 |
|------|-----|------|
| `bg` / `bg-deep` | `#002626` / `#002020` | 官方 Background / Contrast |
| `bg-sidebar` / `bg-elevated` | `#002e2e` / `#003535` | 官方 Second Background / Buttons |
| `bg-hover` / `bg-active` | `#003f3f` / `#104110` | 官方 Highlight / Active |
| `border` / `border-strong` | `#003838` / `#005454` | 官方 Border / Disabled |
| `fg` / `fg-muted` / `fg-dim` | `#b2c2b0` / `#9caf9d` / `#94a596` | 官方主文字及 AA 可读的次要文字 |
| `brand` | `#4ecdb5` | QingCode 品牌与 Qing Rail |
| `accent` | `#b8894a` | 壳层功能色；由官方 `#ffcc80` 压暗以适配白字按钮 |

编辑器和终端共享 `src/lib/materialForestTheme.ts`：光标使用官方 `#ffcc80`，语法保留 Material Forest 的绿、紫、蓝、珊瑚色体系；默认代码文字柔化为 `#d1e0e0`，注释调整为 `#789b94` 以满足小字可读性。

---

## 字体

| 类型 | 默认 | Token |
|------|------|-------|
| 界面 | 系统 sans + 苹方/微软雅黑 | `--font-sans` |
| 代码/终端 | JetBrains Mono 等 | `--font-mono` |
| 界面字号 | 13px | `--ui-font-size` |
| 界面辅助字号 | 基准 12px（正文 − 1） | `--ui-font-size-sm` / `.text-ui-sm` |
| 等宽字号 | 13px | `--mono-font-size` |

用户可在设置中调整字体与字号（`src/lib/fontSettings.ts`）。侧边栏、活动栏等 UI 区域使用 `.ui-font-scaled` 响应界面字号缩放；编辑器和终端保持独立等宽字号。

### 字号层级

| 层级 | 默认 | 用途 | 实现 |
|------|------|------|------|
| 对话框标题 | 14px | Modal / 确认框标题 | `text-[14px] font-semibold` |
| 正文 | 13px | 主说明、列表主行、按钮文案 | `--ui-font-size` / `text-[13px]` |
| 辅助信息 | 12px | 路径、补充说明、设置项描述、Toast 详情 | `--ui-font-size-sm` / `.text-ui-sm` |
| 分区标签 | 11px | 侧栏分区标题、紧凑工具条控件 | `text-[11px] font-semibold tracking-wide` |

**辅助信息**比正文小一级，并随用户界面字号设置缩放。`.text-ui-sm` 在 `.ui-font-scaled` 内外均可使用：缩放区内用基准 `12px`（由父级 `zoom` 放大），区外用 `12px × --ui-font-scale`，避免双重缩放。典型场景：确认框 detail（路径块 / 警告补充说明）、命令面板相对路径、Toast 次要说明。路径等技术型辅助块用 `font-mono text-ui-sm`（见 `ConfirmDialog`）。

---

## 布局

顶栏窗口控制左侧提供**面板布局**按钮（点击在两模板间切换，见 `src/lib/panelLayoutTemplate.ts`）。

**经典（`classic`，默认）** — 终端在底部：

```
┌ TitleBar ……………………………… [布局] [─ □ ×] ──┐
├ Act │ Sidebar │ Editor                        │
│ Bar │ Panel   │                               │
│     │         ├─ Terminal (可拖拽高度) ──────┤
├ StatusBar ────────────────────────────────────┤
```

**侧栏旁终端（`sideTerminal`）** — 侧栏 | 终端 | 编辑器（终端贴工具区，便于边看输出边改代码）：

```
┌ TitleBar ……………………………… [布局] [─ □ ×] ──┐
├ Act │ Sidebar │ Terminal │ Editor             │
│ Bar │ Panel   │ (可拖宽) │                     │
├ StatusBar ────────────────────────────────────┤
```

| 区域 | 尺寸 | 说明 |
|------|------|------|
| 标题栏 | 32px | 应用图标 + 项目选择器 + 拖拽区 + 布局切换 + 窗口控制 |
| 活动栏 | 48px | 视图切换 + 快捷动作 |
| 侧边栏 | 180–520px，默认 260px | 可拖拽，见 `src/lib/sidebarLayout.ts` |
| 标签栏 | 32px | 文件 Tab |
| 终端（底） | 120px – 80% 窗口高 | 可拖拽高度，见 `src/lib/panelLayout.ts` |
| 终端（侧） | 200px – 约 50% 窗口宽 | 可拖拽宽度；与高度分别持久化于 `qingcode:terminal-panel` |
| 状态栏 | 24px | 项目/文件/终端信息 |

---

## 项目选择器

文件：`src/components/ProjectPicker.tsx`

多项目管理入口在标题栏左侧：项目以 **chip 标签** 横向排列，放不下的折进 `···` 溢出下拉。侧边栏只显示**当前项目**的文件树。命名多项目工作区的主入口在 chips 旁常驻的 **工作区** 下拉（`WorkspaceMenu.tsx`），不依赖溢出菜单。

| 项 | 约定 |
|----|------|
| 布局 | 标题栏左侧：应用图标 + 常驻工作区菜单 + 项目 chips 区（`flex-1`）+ 拖拽 spacer（固定 `w-[140px]`）+ QingCode；右侧：面板布局切换 + 窗口按钮 |
| Chip | 文件夹图标 + 项目名（`max-w-[140px]` 截断）+ hover `×` 从顶栏隐藏；当前项 `bg-bg-active`；不可用项显示 `⚠` + 常驻「重新定位」「移除项目」，点击 chip 体不切换 |
| 工作区菜单 | 紧挨文件菜单右侧常驻；显示当前工作区名（无则「工作区」）；下拉锚定在按钮下方：工作区列表、`保存当前顶栏项目`、`管理多项目工作区` |
| 切换 | 点击可用 chip 调用 `switchProject` 并跳到资源管理器视图；编辑器会话（标签/草稿/光标与折叠等）按项目保留，切走不丢弃未保存缓冲 |
| 溢出 | 默认尽可能多地把项目显示为 chip（宽度测量）；放不下的进 `ChevronDown` 溢出下拉（`createPortal`、`z-[100]`、`max-h-[70vh]`）。窗口缩放时 `ResizeObserver` 实时重算可见数量 |
| 溢出面板行 | 图标 + 项目名（`Tooltip` 完整路径）+ 当前项 `Check`；行内：`在文件管理器中打开` / `移除`（hover），不可用 → `重新定位` + 常驻 `移除项目`；底部 `项目管理` / `多项目工作区` |
| 添加 | chips 末尾常驻 `+` 打开居中 **modal**（`ProjectAddDialog`）：筛选框 + 项目列表（路径副行、已隐藏标记）+ 底部 `打开文件夹` / `新建临时项目` / `项目管理`；无项目时文字按钮「添加项目」打开同一对话框。溢出 chip 仍用下拉 |
| 测量 | 隐藏的 `measureRef` 层渲染全部 chip 取 `offsetWidth`，结合 `ResizeObserver` 在容器宽度变化时重算可见数量 |
| 关闭 | 点击外部、`Escape`、窗口失焦/缩放关闭溢出面板 |
| 拖拽 | chips 区与溢出按钮独立于 `data-tauri-drag-region`，拖拽由右侧 spacer 承担，避免误触发窗口拖动 |

侧边栏（`src/components/Sidebar.tsx`）顶部为当前项目头（项目名 + hover 操作：新建文件/文件夹、新建终端、在文件管理器打开、移除/重新定位），右键仍提供完整项目菜单；其下为当前项目文件树。项目移除、重新定位的共享逻辑在 `src/utils/projectActions.ts`。

---

## 活动栏

文件：`src/components/ActivityBar.tsx`

### 分区

```
[ 视图区 ]
  资源管理器 · 搜索 · 设置
──────────
[ 动作区 ]
  添加项目 · 终端 · 调试
```

- **视图区**：切换左侧面板内容，激活时左侧显示 2px `brand` Qing Rail 指示条
- **动作区**：触发操作，不切换侧边栏视图
- **整栏折叠**：分隔线上的 `‹` 向左收起整条活动栏；收起后左侧留窄轨 `›` 展开（状态写入 `qingcode:activity-bar-hidden`；命令面板「切换活动栏」）
- 图标尺寸 **22px**（lucide-react），按钮 **40×40px**，圆角 `rounded-md`
- **角标**：源代码管理图标右下角显示 git 变更数（`badge`，蓝底白字圆点，>99 显示 `99+`）；数据来自 `gitStatusStore.dirtyCount`（与状态栏共用轻量刷新）

### 图标

- 使用 **lucide-react** 线性图标
- 默认 `text-fg-muted`，激活/悬停 `text-fg`
- 不使用原生 `title`；统一用 `Tooltip` 组件

---

## 源代码管理

文件：`src/components/SourceControlPanel.tsx`、`src/components/ScmInlineDiff.tsx`

- 活动栏进入「源代码管理」后，**主编辑区整页**显示 SCM 工作台（参考 UGit 的变更/历史分区）；不再占用左侧窄侧栏。再点一次 SCM 图标回到资源管理器。
- 顶栏：分支下拉、拉取、推送、刷新。页签：**变更** | **历史**。
- **变更**：左栏为变更/待提交列表与提交区；右栏内嵌 Diff（`git_file_contents` + DiffEditor）。单击查看差异；双击或右键「打开更改」可在编辑器标签中打开并切回资源管理器。左栏宽度可拖拽（`PanelResizer`，持久化 `qingcode:scm-layout`）。
- **历史**：左栏提交列表（`git_log` 分页 + `react-window` 虚拟列表，接近底部预取）；右侧为选中提交摘要、更改文件列表（`git_commit_files`）与单文件 diff（`git_commit_file_contents` + DiffEditor）。左栏与「更改的文件」栏均可左右拖拽调宽。不做回退 / cherry-pick。
- 面板 chrome（顶栏、列表、提交区）用 `.ui-font-scaled` 跟随界面字体/字号；Diff 区用 `.editor-font-independent` 取消 UI zoom，继续走代码字体与 `editor.fontSize`。
- Git 状态保留 porcelain `XY` 双列语义；支持单个/全部暂存与取消暂存、只提交已暂存内容、`git push` / `git pull`（已配置 upstream）。
- 拉取后若存在未合并路径，顶部显示冲突横幅；不提供冲突解决器。
- 不提供隐式暂存、discard、fetch、远程凭据管理、merge/rebase 或内置冲突合并 UI。详见 [`docs/git-basic-commit-workflow.md`](docs/git-basic-commit-workflow.md)。

---

## 应用图标

| 文件 | 用途 |
|------|------|
| `src/assets/app-icon.svg` | **UI / Splash 图标源**（经 `?raw` 导入，供 React 渲染） |
| `public/app-icon.svg` | favicon 与静态 URL（`/app-icon.svg`）；改图标时请与 `src/assets` 保持一致 |
| `src/lib/appIconSvg.ts` | `?raw` 导入 SVG，供 React 与 Splash 渲染 |
| `src/components/AppIcon.tsx` | 标题栏内联图标（自动引用源文件） |
| `src-tauri/icons/*` | 各平台打包图标（由 `icon:sync` 生成） |

### 约定（原创 · 粗体可读）

- 画布 **512×512**，**透明背景**（无底形色块）
- **青台** 上下两层**等高**（各 40px）：上层 `#4ECDB5`、下层 `#2FAF9B`，底边直角长方形
- **厚切括号** `#F3F6F8`，与青台作为整体在画布内几何居中
- **桌面打包**（`app-icon-file.svg`）使用黑色圆角底 + 轻微径向渐变，与 ZCode / OpenCode 等桌面图标风格对齐

修改 `src/assets/app-icon.svg`（并同步 `public/app-icon.svg` 与 `public/app-icon-file.svg`）后，UI / Splash 会跟随；打包 exe 前需同步 Tauri 位图图标：

```bash
pnpm icon:sync
```

`pnpm package`（本机 x64 NSIS 安装包）已自动包含 `icon:sync`；便携版用 `pnpm package:exe`。

---

## 启动画面

桌面端启动时展示 **Logo + Loading**，避免白屏或长时间无反馈。

| 文件 | 职责 |
|------|------|
| `index.html` `#startup-splash` | 内联 Logo（**160px**）、品牌名、青色进度条与「正在启动」；HTML 解析后立即可见 |
| `index.html` 内联脚本 | `DOMContentLoaded` 时立刻 `show()`（不再等待尺寸 IPC） |
| `src-tauri/src/lib.rs` | 窗口 `visible: false` 创建；Windows 在隐藏态修复 ~14×14 尺寸，**不**提前 `show()` |
| `src/lib/startupSplash.ts` | 主界面首帧绘制后淡出并移除 splash |
| `src/lib/appWindow.ts` | 仅作兜底：仍隐藏或尺寸异常时再修复并 `show()` |

### 约定

- Splash Logo 无底色容器（透明 SVG + 图形轻阴影），优先内联于 `index.html`；主包加载后可由 `paintStartupSplashLogo()` 再对齐主题
- Loading 使用品牌青色系（`#4ECDB5` / `#2FAF9B`）细进度条 + 短淡入
- 背景色与 `data-theme` 一致：`#1e1e1e` / `#f0f0f0`
- 最短展示约 **160ms**，淡出约 **140ms**，避免 splash「粘住」或闪一下
- Tauri 窗口 `visible: false` + `backgroundColor: #1e1e1e`；尺寸修复在隐藏态完成，由 splash 脚本尽早 `show()`
- 主界面挂载后调用 `dismissStartupSplash()`，**禁止**在 splash 期间阻塞项目列表等后台加载
- 非关键初始化（右键菜单守卫、开发者模式）延后到首帧之后

### 启动慢说明

exe 冷启动耗时主要来自 WebView2 初始化与首包 JS 解析；Editor / Terminal 等重型模块已懒加载，项目目录树在后台加载。Splash 用于改善**感知速度**并掩盖白屏，而非替代原生冷启动开销。

---

## 交互组件

---

### 键盘快捷键

- QingCode 自有快捷键优先于 WebView 原生加速键，且在编辑器、文件树等对应焦点区域保持可用。
- 禁止 WebView 原生刷新快捷键：`F5`、`Ctrl`/`⌘` + `R`（含 `Shift` 组合）；dev / prod 均拦截。
- **生产构建**禁止 WebView 原生开发者工具快捷键：`F12`、`Ctrl+Shift+I/J/C`，以及 macOS 的 `⌘+⌥+I/J/C`。
- **开发构建**（`pnpm tauri:dev` / Vite `import.meta.env.DEV`，与 Rust `is_dev_build` / `.devtools(true)` 对齐）放行上述开发者工具快捷键，以便 F12 打开 WebView 开发者工具。
- **生产构建**由 `contextMenuGuard` 拦截 WebView 原生右键菜单，仅在输入框等控件保留浏览器复制/粘贴菜单；编辑器、文件树等使用应用内 `ContextMenu`。
- **开发构建**默认与生产一致：安装 `contextMenuGuard`、显示 QingCode `ContextMenu`。按 **F12**（或 `Ctrl+Shift+I/J/C`）打开/关闭 WebView 开发者工具时，同步切换右键为 **原生菜单**（含「检查」）；再次按相同快捷键恢复应用菜单。
- 原生快捷键守卫只调用 `preventDefault()` 取消 WebView 默认行为，**不得**调用 `stopPropagation()`；与应用命令重合的按键（如 `Ctrl+Shift+C` 复制路径）必须继续传播给 QingCode 处理。
- 新增或修改快捷键时，需同时验证“不会触发 WebView 原生行为”和“应用命令仍能执行”。

### 对话框（Modal）

**所有模态对话框必须在视口水平、垂直居中（center）。**

| 项 | 约定 |
|----|------|
| 外壳 | 统一使用 `ModalOverlay`（`src/components/ModalOverlay.tsx`） |
| 布局 | `fixed inset-0 flex items-center justify-center p-4` |
| 遮罩 | `bg-black/55` + `backdrop-blur-[1px]` |
| 层级 | `z-[100]` |
| 面板 | `relative` + `rounded-lg` + `border-border-strong` + `shadow-2xl` + `modal-content-enter`；宽度用 `max-w-*`，内容过高时 `max-h-[85vh]` + 内部滚动 |
| 关闭 | 点击遮罩关闭（确认框等同取消）；`Escape` 由各对话框自行处理 |
| 动效 | 遮罩 `modal-overlay-enter`（淡入 140ms），面板 `modal-content-enter`（上浮 + 缩放 160ms） |

**适用：** `ConfirmDialog`、`PromptDialog`、`RunConfigEditor` 及今后所有居中弹窗。

**不适用：** `ContextMenu`（跟随指针）、`Tooltip`（跟随目标）、文件树 `InlineCreateRow`（内联输入）。

### Tooltip

文件：`src/components/Tooltip.tsx`

**原则：所有悬停提示必须在应用内渲染，禁止使用浏览器原生 `title` 属性（白底系统 tip）。**

ESLint 以 `react/forbid-dom-props` 禁止 DOM 节点上的 `title`；新增悬停提示只允许 `Tooltip` / `StatusTip`。

| 项 | 约定 |
|----|------|
| 组件 | 通用悬停用 `Tooltip`；**状态栏**用封装好的 `StatusTip`（见下节） |
| 样式 | `bg-bg-elevated` +（无箭头时）`border-border-strong` + 阴影，11px 字号；`whitespace-pre-line`，文案中的 `\n` 换行；长文案 `max-w` 内断行 |
| 箭头 tip | `arrow`：气泡 + `TipArrow`（箭头尖略圆）+ `drop-shadow`（无描边边框）；间距见 `tipArrow.tsx`；**箭头尖 → 状态栏行顶 = 2px**，**不得与状态栏重叠** |
| 延迟 | 默认 **600ms**（`SHOW_DELAY`）；截断文本用 `onlyWhenOverflow` 时默认 **1000ms**（`OVERFLOW_TOOLTIP_DELAY`）；可用 `delay` 覆盖 |
| 焦点 | 默认 **`showOnFocus={false}`**：点击/聚焦不立刻弹出提示；指针按下时立即隐藏 |
| 文案 | 使用 `t()` / `translate()` 的中文 key，英文走 `en.json`；**禁止**硬编码英文（如标题栏 Minimize/Maximize）；多行说明用 `\n` 分段，避免单行过长 |
| 位置 | 活动栏 / 侧边栏图标 → `right`；标题栏窗口按钮 → `bottom`；面板内按钮 / 工具栏 / 空编辑器列表 → `bottom`；状态栏 → `StatusTip`（`top` + 箭头）；拖拽条按方向适配 |
| 截断文本 | 对 `truncate` 元素用 `Tooltip` + `onlyWhenOverflow` 展示完整路径或说明，`wrapperClassName` 保留布局（如空编辑器「最近打开的文件」、面包屑、项目管理路径列） |
| 无障碍 | 纯图标按钮同时设置 `aria-label`（与 tip 文案一致、已 i18n）；`Tooltip` 浮层带 `role="tooltip"` |

**适用范围：**

- 活动栏视图/动作图标
- 标题栏窗口控制（最小化 / 最大化·还原 / 关闭窗口）
- 侧边栏、面板工具栏等同类图标按钮提示
- 截断路径 / 文件名 / 命令行等需展示完整文案的列表与标签

**禁止：**

- HTML `title` 属性（含 JSX 写在 DOM 元素上的 `title={...}`）
- 依赖浏览器默认白底系统 tooltip 的任何交互提示
- 窗口按钮等 chrome 控件硬编码英文 label

**允许例外（非 UI 提示）：**

- React 组件 props 名为 `title` 但仅作展示文案（如面板标题 `Header title="运行配置"`、`EmptyState` / `SettingItem` 的标题 prop）
- SVG `<title>` 元素用于图形语义（若有）

### StatusTip（状态栏 tip）

文件：`src/components/StatusTip.tsx`（内部复用 `Tooltip`：`side="top"` + `arrow`）

| 项 | 约定 |
|----|------|
| 用途 | 状态栏所有悬停说明（分支、终端、编码、内存、版本等） |
| 形态 | 圆角气泡 + **底部略圆三角箭头**（`TipArrow`）指向触发控件；与底栏留白，禁止压住状态栏边线 |
| 间距 | 箭头尖到**状态栏行顶** **2px**（`tipArrow.tsx`）；行顶由 `data-status-bar-row` / `StatusBarRowContext` 解析，布局后 `syncStyleTopToTipArrowClearance` 按 caret 实测校正 |
| 宽度 | 箭头 tip 默认 `max-w-[320px]`；长文案用 `\n` 分成多行（例：内存 tip 分「主进程 / WebView·终端 / 刷新策略」） |
| 编码菜单 | 点击编码打开的菜单用 `ContextMenu` + `preferAbove` + `arrow="bottom-end"`，caret 与 `StatusTip` 同套 `tipArrow` 常量；布局后按路径尖端实测校正 2px 间隙；高度受限时内部滚动且底边不越过锚点 |

**用法示例：**

```tsx
<Tooltip label={t('刷新')} side="bottom">
  <button type="button" aria-label={t('刷新')} onClick={handleRefresh}>
    <RefreshCw size={13} />
  </button>
</Tooltip>
```

截断路径：

```tsx
<Tooltip label={fullPath} side="bottom" onlyWhenOverflow wrapperClassName="truncate min-w-0 flex-1">
  <span className="truncate block">{displayName}</span>
</Tooltip>
```

### 面板拖拽条

文件：`src/components/PanelResizer.tsx`

终端（横向）与侧边栏（纵向）、**编辑器小地图左缘**（纵向）共用同一组件与样式（`.panel-resizer`）。

| 状态 | 表现 |
|------|------|
| 默认 | 分隔线与 grip 隐藏 |
| 悬停 | 1px 分隔线 + 三点 grip 淡入 |
| 拖拽 | 2px `accent` 线 + grip 高亮；`body.panel-resizing` + `data-panel-resize="vertical"` 时全局 `ew-resize` |

提示格式：

```
拖动调整终端高度 · 120–640px · 当前 260px
拖动调整侧边栏宽度 · 180–520px · 当前 260px
左右拖拽调整小地图宽度 · 80–360px · 当前 120px
```

小地图宽度拖拽：`EditorMinimap` 左缘挂载 `PanelResizer`（`orientation="vertical"`），拖拽逻辑与 `ResizableSidebar` 一致（`beginPanelResize` / `endPanelResize`），**禁止**单独实现 `col-resize` 或自定义 grip 样式。

#### 终端拖动防闪烁约束

终端面板拖动使用“真实 canvas 快照 → 最终网格单次提交 → `xterm.onRender` 确认 → WebView2 再合成一帧”的交接流程。拖动期间不得从 `ResizeObserver` 调用 `term.resize()`，不得把快照设置成 `width/height: 100%` 拉伸字符，也不得在松手时立即 flush PTY resize。完整原理、关键文件、禁止改动项和验收方法见 [`docs/terminal-resize.md`](docs/terminal-resize.md)。

### 编辑器标签（EditorTabs）

文件：`src/components/EditorTabs.tsx`

| 项 | 约定 |
|----|------|
| 激活标识 | 背景 `bg-tab-active` + **底部 2px `brand` Qing Rail 指示线** |
| 关闭 | 点击 `×`；**中键点击标签直接关闭**（拦截 `auxclick`，禁止中键自动滚动） |
| 未保存 | `warn` 色圆点 + `.dirty-pulse` 呼吸动画，hover 时切换为 `×` |
| 溢出 | 标签区右侧常驻 `ChevronDown` 按钮（`border-l` 分隔），点击弹出全部已打开文件菜单，当前项名称后标 `●` |

### 终端标签（TerminalTabs）

文件：`src/components/TerminalTabs.tsx`

| 项 | 约定 |
|----|------|
| 高度 / 底部分隔 | `--tab-height`；栏底 `border-b border-border`（与终端内容区分） |
| 激活标识 | 与编辑器一致：`bg-tab-active` + **底部 2px `brand` Qing Rail 指示线**；未激活 `bg-tab-inactive` |
| 标签间隔 | 轻量竖向 divider（`border-strong`），不用整段 `border-r` 切栏 |
| 左侧标题 | 「终端」图标+文案，`border-r` 与标签区分区 |

### 状态栏（StatusBar）

文件：`src/components/StatusBar.tsx`

- **可点击项**：Git 分支 → 打开源代码管理视图；终端计数 → 切换终端面板（`uiStore.toggleTerminalPanel`）；均带 hover 背景与 `StatusTip`
- **悬停说明**：统一 `StatusTip`（见上节），禁止直接用无箭头的 `Tooltip` 以免贴住底栏
- **内存 tip**：多行展示分项占用；悬停时约每 **5** 秒强制刷新，平时约每 **10** 秒后台轮询（可见窗口）
- **光标位置**：有活动标签时显示 `行 X, 列 Y`（`editorStore.cursor`，由 Editor 的 `updateListener` 上报，英文界面为 `Ln X, Col Y`）

### 文件树交互（IntelliJ IDEA 风格）

文件：`src/components/Sidebar.tsx`、`src/utils/fileTreeView.ts`、`src/components/InlineCreateRow.tsx`

| 操作 | 文件 | 文件夹 |
|------|------|--------|
| 单击 | 选中并打开 | 选中并展开 / 折叠 |
| `Ctrl`/`⌘`+单击 | 切换多选（不打开） | 切换多选（不展开） |
| `Shift`+单击 / `Shift`+方向键 | 范围多选（不打开） | 范围多选（不展开） |
| Chevron | 选中并展开 / 折叠 | 同左 |
| `Enter`（树聚焦时） | 打开 | 展开 / 折叠 |
| `renameInExplorer`（默认 `F2`，可在快捷键设置中改绑或清空）/ 右键「重命名」 | 行内重命名（`InlineCreateRow`） | 同左 |
| 按住拖放到文件夹 / 项目根 | 移动（指针 DnD + `move_path`；浮层提示「移动到 xxx」） | 同左 |
| `Ctrl+X` / `C` / `V` | 剪切 / 复制 / 粘贴；同名冲突弹 IDEA 式对话框（输入新名称重命名 / 覆盖 / 跳过，可全部应用） | 同左 |

- 多选时所有选中行显示 `bg-bg-active`；剪切项半透明。`revealFileInTree` 仅滚动定位并替换为单选，不再高亮祖先路径。
- 切换标签或「在侧边栏定位当前文件」时，选中项随 `treeRevealPath` 同步。

### Prompt（文本输入）

文件：`src/components/PromptDialog.tsx`、`src/store/promptStore.ts`

**原则：需要用户输入名称等文本时，必须使用 `promptDialog`，禁止使用 `window.prompt`。**

| 项 | 约定 |
|----|------|
| API | `promptDialog({ title, message?, defaultValue?, validate? })` → `Promise<string \| null>` |
| 样式 | 与 `ConfirmDialog` 一致的居中浮层（`ModalOverlay`）+ 单行输入框 |
| 校验 | 新建/重命名文件与文件夹使用 `validateEntryName` |
| 快捷键 | `Enter` 确认，`Escape` 取消；打开时自动聚焦并选中默认值 |

**资源管理器新建/重命名（与 VS Code / IDEA 一致）：** 使用 `InlineCreateRow` 在文件树目标行内联输入；`Enter` 确认、`Escape`/失焦取消；新建时自动展开父文件夹。新建与树内重命名**不使用** `promptDialog`。

### Toast

- 从底部滑入，160ms 动画（`.toast-enter`）
- 类型：`info` / `success` / `error`

### 动效一览

| 类 | 用途 | 时长 |
|----|------|------|
| `.toast-enter` | Toast 滑入 | 160ms |
| `.modal-overlay-enter` | 对话框遮罩淡入 | 140ms |
| `.modal-content-enter` | 对话框面板上浮 + 缩放 | 160ms |
| `.menu-enter` | 右键/下拉菜单淡入 + 轻微缩放 | 120ms |
| `.tooltip-enter` | Tooltip 淡入（配合默认 600ms 悬停延迟） | 120ms |
| `.dirty-pulse` | 未保存圆点 / 运行中终端圆点呼吸 | 2.2s 循环 |
| `html.theme-transition` | 主题切换时由 `applyTheme` 临时挂载 260ms，全局颜色 200ms 过渡 | 200ms |

### 滚动条

- 宽 10px，细圆角，track 透明
- 深色：`#3c3c3c`；浅色：`#c4c4c4`

### 编辑器小地图

- 挂在 `.editor-pane` 内 absolute overlay（右侧），不占 flex 兄弟以免塌高；正文只读共享 `EditorView` 的 `doc`
- 观感对齐 CodeGlance：语法色采样、光标行、视口框、可选隐藏 CM 竖滚动条、悬停 Quick View
- **宽度拖拽**：左缘复用 `PanelResizer`（与侧边栏同款竖向分隔线 + 三点 grip、`ew-resize`），宽度限制见 `minimapPolicy`
- 详细需求与性能约束见 [`docs/minimap.md`](./docs/minimap.md)

---

## 文案

- 界面文案默认 **简体中文**
- 活动栏 / 标题栏 / 设置面板等 Tooltip、状态栏 `StatusTip` 与界面语言一致（中文 key + `en.json`）
- 占位功能（如调试）使用 toast 明确告知「开发中」

---

## 新增 UI 检查清单

- [ ] 颜色使用 `@theme` token，不写死 hex（图标 SVG 除外）
- [ ] 悬停提示用 `Tooltip`（默认约 600ms；截断用 `onlyWhenOverflow`）；**状态栏**用 `StatusTip`（上开 + 箭头，勿贴底栏），长文案 `\n` 换行；文案走 i18n，**禁止** DOM `title` / 原生 tip
- [ ] 文本输入用 `promptDialog`，**禁止** `window.prompt` / 浏览器原生 `window.alert` / `window.confirm`
- [ ] 模态对话框使用 `ModalOverlay` 居中，不手写偏移定位
- [ ] 图标来自 lucide-react，尺寸与活动栏协调
- [ ] 可调整面板复用 `PanelResizer` + `panelLayout` / `sidebarLayout` / `minimapPolicy` 限制（含小地图左缘拖宽）
- [ ] 深色/浅色主题下均验证对比度
- [ ] 修改 `app-icon.svg` 后运行 `pnpm icon:sync`（打 exe 时自动执行）

---

## 参考

- 布局与配色：Cursor / VS Code Dark+
- 应用图标：原版青台（底部长方形）+ 厚切括号
- 技术栈：Tauri 2 · React · Tailwind CSS v4 · CodeMirror 6
