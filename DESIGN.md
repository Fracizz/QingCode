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

所有颜色 token 定义于 `src/App.css` 的 `@theme`，通过 Tailwind 语义类使用（如 `bg-bg`、`text-fg-muted`、`border-border`）。

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
| `fg-muted` | `#858585` | 次要文字、状态栏 |
| `fg-dim` | `#6b6b6b` | 占位、禁用 |
| `accent` | `#4d9eff` | 强调、激活指示条、拖拽高亮 |
| `accent-soft` | `#244a66` | 状态栏背景 |
| `danger` | `#f48771` | 错误、删除 |
| `warn` | `#e2c08d` | 警告、未保存标记 |
| `ok` | `#89d185` | 成功 |

### 浅色主题

通过 `html[data-theme="light"]` 覆盖，见 `src/App.css`。主题切换逻辑在 `src/lib/themeSettings.ts`。

---

## 字体

| 类型 | 默认 | Token |
|------|------|-------|
| 界面 | 系统 sans + 苹方/微软雅黑 | `--font-sans` |
| 代码/终端 | JetBrains Mono 等 | `--font-mono` |
| 界面字号 | 13px | `--ui-font-size` |
| 等宽字号 | 13px | `--mono-font-size` |

用户可在设置中调整字体与字号（`src/lib/fontSettings.ts`）。侧边栏、活动栏等 UI 区域使用 `.ui-font-scaled` 响应界面字号缩放；编辑器和终端保持独立等宽字号。

---

## 布局

```
┌ TitleBar ─────────────────────────────────────┐
├ Act │ Sidebar │ Editor                        │
│ Bar │ Panel   │                               │
│     │         ├─ Terminal (可拖拽高度) ──────┤
├ StatusBar ────────────────────────────────────┤
```

| 区域 | 尺寸 | 说明 |
|------|------|------|
| 标题栏 | 32px | 应用图标 + 项目选择器 + 拖拽区 + 窗口控制 |
| 活动栏 | 48px | 视图切换 + 快捷动作 |
| 侧边栏 | 180–520px，默认 260px | 可拖拽，见 `src/lib/sidebarLayout.ts` |
| 标签栏 | 35px | 文件 Tab |
| 终端 | 120px – 80% 窗口高 | 可拖拽，见 `src/lib/panelLayout.ts` |
| 状态栏 | 24px | 项目/文件/终端信息 |

---

## 项目选择器

文件：`src/components/ProjectPicker.tsx`

多项目管理入口在标题栏左侧：项目以 **chip 标签** 横向排列，放不下的折进 `···` 溢出下拉。侧边栏只显示**当前项目**的文件树。

| 项 | 约定 |
|----|------|
| 布局 | 标题栏左侧：应用图标 + 项目 chips 区（`flex-1`，填满除拖拽条外的剩余宽度）+ 拖拽 spacer（固定 `w-[140px]`）+ QingCode + 窗口按钮 |
| Chip | 文件夹图标 + 项目名（`max-w-[140px]` 截断）+ hover `×` 移除；当前项 `bg-bg-active`；不可用项显示 `⚠`（点击重新定位），点击 chip 体不切换 |
| 切换 | 点击可用 chip 调用 `switchProject` 并跳到资源管理器视图 |
| 溢出 | 默认尽可能多地把项目显示为 chip（宽度测量）；放不下的进 `ChevronDown` 溢出下拉（`createPortal`、`z-[100]`、`max-h-[70vh]`）。窗口缩放时 `ResizeObserver` 实时重算可见数量 |
| 溢出面板行 | 图标 + 项目名（`Tooltip` 完整路径）+ 当前项 `Check`；行内：`在文件管理器中打开` / `移除`（hover），不可用 → `重新定位`；底部 `添加项目` |
| 添加 | chips 末尾常驻 `+` 按钮；溢出面板底部也有 `添加项目`；均调用 `addProjectFromDialog` |
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

- **视图区**：切换左侧面板内容，激活时左侧显示 2px `accent` 指示条
- **动作区**：触发操作，不切换侧边栏视图
- 图标尺寸 **22px**（lucide-react），按钮 **40×40px**，圆角 `rounded-md`

### 图标

- 使用 **lucide-react** 线性图标
- 默认 `text-fg-muted`，激活/悬停 `text-fg`
- 不使用原生 `title`；统一用 `Tooltip` 组件

---

## 应用图标

| 文件 | 用途 |
|------|------|
| `public/app-icon.svg` | **唯一图标源**（favicon、Splash、UI、Tauri 生成） |
| `src/lib/appIconSvg.ts` | `?raw` 导入 SVG，供 React 与 Splash 渲染 |
| `src/components/AppIcon.tsx` | 标题栏内联图标（自动引用源文件） |
| `src-tauri/icons/*` | 各平台打包图标（由 `icon:sync` 生成） |

### 约定（原创 · 粗体可读）

- 画布 **512×512**，**透明背景**（无底形色块）
- **青台** 上下两层**等高**（各 92px）：上层 `#4ECDB5`、下层 `#2FAF9B`，底边直角长方形
- **厚切括号** `#F3F6F8`

修改 `public/app-icon.svg` 后，UI / favicon / Splash 会自动跟随；打包 exe 前需同步 Tauri 位图图标：

```bash
pnpm icon:sync
```

`pnpm package:exe` 已自动包含 `icon:sync`。

---

## 启动画面

桌面端启动时展示 **Logo + Loading**，避免白屏或长时间无反馈。

| 文件 | 职责 |
|------|------|
| `index.html` `#startup-splash` | 透明 Logo、品牌名、青色进度条与「正在启动」；HTML 解析后立即可见 |
| `index.html` 内联脚本 | `DOMContentLoaded` 时调用 `__TAURI__.window.getCurrentWindow().show()` |
| `src/lib/startupSplash.ts` | 主界面首帧绘制后淡出并移除 splash |
| `src/lib/appWindow.ts` | Tauri `show()` 兜底（内联脚本未执行时） |

### 约定

- Splash Logo 无底色容器（透明 SVG + 图形轻阴影），从 `/app-icon.svg` 拉取；主包加载后由 `paintStartupSplashLogo()` 再刷一次
- Loading 使用品牌青色系（`#4ECDB5` / `#2FAF9B`）细进度条 + 淡入动效，替代旧旋转圈
- 背景色与 `data-theme` 一致：`#1e1e1e` / `#ffffff`
- 最短展示 **520ms**，防止一闪而过
- Tauri 窗口 `visible: false` + `backgroundColor: #1e1e1e`，由 splash 脚本尽早 `show()`
- 主界面挂载后调用 `dismissStartupSplash()`，**禁止**在 splash 期间阻塞项目列表等后台加载

### 启动慢说明

exe 冷启动耗时主要来自 WebView2 初始化与首包 JS 解析；Editor / Terminal 等重型模块已懒加载，项目目录树在后台加载。Splash 用于改善**感知速度**，非缩短实际加载时间。

---

## 交互组件

---

### 对话框（Modal）

**所有模态对话框必须在视口水平、垂直居中（center）。**

| 项 | 约定 |
|----|------|
| 外壳 | 统一使用 `ModalOverlay`（`src/components/ModalOverlay.tsx`） |
| 布局 | `fixed inset-0 flex items-center justify-center p-4` |
| 遮罩 | `bg-black/55` + `backdrop-blur-[1px]` |
| 层级 | `z-[100]` |
| 面板 | `relative` + `rounded-lg` + `border-border-strong` + `shadow-2xl`；宽度用 `max-w-*`，内容过高时 `max-h-[85vh]` + 内部滚动 |
| 关闭 | 点击遮罩关闭（确认框等同取消）；`Escape` 由各对话框自行处理 |

**适用：** `ConfirmDialog`、`PromptDialog`、`RunConfigEditor` 及今后所有居中弹窗。

**不适用：** `ContextMenu`（跟随指针）、`Tooltip`（跟随目标）、文件树 `InlineCreateRow`（内联输入）。

### Tooltip

文件：`src/components/Tooltip.tsx`

**原则：所有悬停提示必须在应用内渲染，禁止使用浏览器原生 `title` 属性。**

| 项 | 约定 |
|----|------|
| 组件 | 统一使用 `Tooltip`，从 `./Tooltip` 导入 |
| 样式 | `bg-bg-elevated` + `border-border-strong` + 阴影，11px 字号 |
| 延迟 | 默认 **400ms**（`SHOW_DELAY`），可通过 `delay` 覆盖 |
| 位置 | 活动栏 / 侧边栏图标 → `right`；标题栏窗口按钮 → `bottom`；面板内按钮 / 工具栏 → `bottom`；状态栏 → `top`；拖拽条按方向适配 |
| 截断文本 | 对 `truncate` 元素用 `Tooltip` 展示完整路径或说明，`wrapperClassName` 保留布局 |
| 无障碍 | 纯图标按钮同时设置 `aria-label`；`Tooltip` 浮层带 `role="tooltip"` |

**禁止：**

- HTML `title` 属性（含 JSX `title={...}`）
- 依赖浏览器默认白底系统 tooltip 的任何交互提示

**允许例外（非 UI 提示）：**

- React 组件 props 名为 `title` 但仅作展示文案（如面板标题 `Header title="运行配置"`）
- SVG `<title>` 元素用于图形语义（若有）

**用法示例：**

```tsx
<Tooltip label="刷新" side="bottom">
  <button type="button" aria-label="刷新" onClick={handleRefresh}>
    <RefreshCw size={13} />
  </button>
</Tooltip>
```

截断路径：

```tsx
<Tooltip label={fullPath} side="bottom" wrapperClassName="truncate min-w-0 flex-1">
  <span className="truncate block">{displayName}</span>
</Tooltip>
```

### 面板拖拽条

文件：`src/components/PanelResizer.tsx`

终端（横向）与侧边栏（纵向）共用同一组件与样式（`.panel-resizer`）。

| 状态 | 表现 |
|------|------|
| 默认 | 分隔线与 grip 隐藏 |
| 悬停 | 1px 分隔线 + 三点 grip 淡入 |
| 拖拽 | 2px `accent` 线 + grip 高亮 |

提示格式：

```
拖动调整终端高度 · 120–640px · 当前 260px
拖动调整侧边栏宽度 · 180–520px · 当前 260px
```

### Prompt（文本输入）

文件：`src/components/PromptDialog.tsx`、`src/store/promptStore.ts`

**原则：需要用户输入名称等文本时，必须使用 `promptDialog`，禁止使用 `window.prompt`。**

| 项 | 约定 |
|----|------|
| API | `promptDialog({ title, message?, defaultValue?, validate? })` → `Promise<string \| null>` |
| 样式 | 与 `ConfirmDialog` 一致的居中浮层（`ModalOverlay`）+ 单行输入框 |
| 校验 | 新建/重命名文件与文件夹使用 `validateEntryName` |
| 快捷键 | `Enter` 确认，`Escape` 取消；打开时自动聚焦并选中默认值 |

**资源管理器新建（与 VS Code 一致）：** 使用 `InlineCreateRow` 在文件树目标目录下内联输入；`Enter` 创建、`Escape`/失焦取消；自动展开父文件夹。新建文件/文件夹**不使用** `promptDialog`。

### Toast

- 从底部滑入，160ms 动画（`.toast-enter`）
- 类型：`info` / `success` / `error`

### 滚动条

- 宽 10px，细圆角，track 透明
- 深色：`#3c3c3c`；浅色：`#c4c4c4`

---

## 文案

- 界面文案默认 **简体中文**
- 活动栏 Tooltip、设置面板、状态栏保持一致
- 占位功能（如调试）使用 toast 明确告知「开发中」

---

## 新增 UI 检查清单

- [ ] 颜色使用 `@theme` token，不写死 hex（图标 SVG 除外）
- [ ] 悬停提示用 `Tooltip`，**禁止** HTML `title`（可用 `rg 'title=' src/components` 自查）
- [ ] 文本输入用 `promptDialog`，**禁止** `window.prompt`
- [ ] 模态对话框使用 `ModalOverlay` 居中，不手写偏移定位
- [ ] 图标来自 lucide-react，尺寸与活动栏协调
- [ ] 可调整面板复用 `PanelResizer` + `panelLayout` / `sidebarLayout` 限制
- [ ] 深色/浅色主题下均验证对比度
- [ ] 修改 `app-icon.svg` 后运行 `pnpm icon:sync`（打 exe 时自动执行）

---

## 参考

- 布局与配色：Cursor / VS Code Dark+
- 应用图标：原版青台（底部长方形）+ 厚切括号
- 技术栈：Tauri 2 · React · Tailwind CSS v4 · CodeMirror 6
