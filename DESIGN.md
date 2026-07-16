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
| 标题栏 | 32px | 应用名 + 窗口控制 |
| 活动栏 | 48px | 视图切换 + 快捷动作 |
| 侧边栏 | 180–520px，默认 260px | 可拖拽，见 `src/lib/sidebarLayout.ts` |
| 标签栏 | 35px | 文件 Tab |
| 终端 | 120px – 80% 窗口高 | 可拖拽，见 `src/lib/panelLayout.ts` |
| 状态栏 | 24px | 项目/文件/终端信息 |

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
| `public/app-icon.svg` | favicon、Tauri 图标源 |
| `src/components/AppIcon.tsx` | 标题栏内联图标（须与 SVG 同步） |
| `src-tauri/icons/*` | 各平台打包图标 |

### 约定（参考 OpenCode）

- 画布 **512×512**，**方形**（无圆角）
- **填充几何**，非描边
- 背景 `#131010`（暖黑底）
- 主图形 `#F1ECEC`（OpenCode 同款 off-white，比纯白更有质感）
- 层次块 `#4A6864`（青灰 accent，96×96 居中偏下）
- 语义：上 `>` 代码尖括号，下巢形弧带；层次块与主图形叠压制造景深

重新生成平台图标：

```bash
pnpm exec tauri icon public/app-icon.svg -o src-tauri/icons
```

---

## 交互组件

### Tooltip

文件：`src/components/Tooltip.tsx`

- 深色浮层：`bg-bg-elevated` + `border-border-strong` + 阴影
- 400ms 延迟显示
- 活动栏提示在 **右侧**，窗口按钮在 **下方**，拖拽条按方向适配
- **禁止**使用原生 `title` 属性

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
- [ ] 悬停提示用 `Tooltip`，不用 `title`
- [ ] 图标来自 lucide-react，尺寸与活动栏协调
- [ ] 可调整面板复用 `PanelResizer` + `panelLayout` / `sidebarLayout` 限制
- [ ] 深色/浅色主题下均验证对比度
- [ ] 修改 `app-icon.svg` 后同步 `AppIcon.tsx` 并重新生成 Tauri 图标

---

## 参考

- 布局与配色：Cursor / VS Code Dark+
- 应用图标：OpenCode 填充分层、高对比、512 方形约定
- 技术栈：Tauri 2 · React · Tailwind CSS v4 · CodeMirror 6
