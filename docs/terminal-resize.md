# 终端面板拖动与防闪烁

> 状态：**已实现，关键渲染链路**。
> 适用范围：底部终端高度拖动、侧栏旁终端宽度拖动，以及会改变终端容器尺寸的共享面板拖动。

## 1. 目标

- 连续拖动终端面板时不出现白帧、黑帧、文字瞬间消失或整屏闪烁。
- 拖动期间字符保持原始宽高比例，不因快照适配容器而变高、变宽或模糊。
- 松手后只提交一次最终字符网格，避免 xterm、ConPTY 和全屏 TUI 重复整屏刷新。
- 普通 Shell 与 OpenCode、vim 等 alternate buffer 程序均保持稳定。

## 2. 问题根因

xterm 的 WebGL canvas 在 `term.resize()` 时会同步改变 backing store 尺寸，旧像素随即被清空；新字符画面则由渲染调度器异步绘制。如果 WebView2 在两者之间完成合成，就会把空 canvas 显示出来。

仅依赖下面两种做法都不能保证无闪烁：

1. 只固定 `.xterm` 的 DOM 宽高：这不会保存 canvas 像素。
2. 固定等待一个 `requestAnimationFrame`：rAF 回调顺序不等于 xterm 已完成实际渲染。

## 3. 当前交接流程

```text
pointerdown
  ├─ 复制活动 xterm 的真实 canvas（每次拖动仅一次）
  ├─ 快照保持原始 CSS 像素尺寸
  └─ 禁止 ResizeObserver 在拖动中 term.resize()

pointermove
  ├─ 每帧只更新 dock 的最终像素宽度/高度
  ├─ 扩大区域铺终端背景，缩小区域裁剪快照
  └─ 不重算字符网格，不复制新快照，不通知 PTY

pointerup / settle
  ├─ 先订阅 xterm.onRender
  ├─ term.resize() 单次提交最终 cols/rows
  ├─ settle.waitUntil(renderReady)
  ├─ onRender 后仍保留快照一个合成帧
  ├─ 移除快照，显示已完成的新 WebGL 画面
  └─ PTY resize 按 100/500ms 合并策略延后发送
```

## 4. 不可破坏的不变量

以下规则与代码中的“终端防闪烁关键”注释共同构成回归保护。修改其中任意一项时，必须同步审查整条链路。

### 4.1 快照必须是真实像素

- `WebglAddon` 必须使用 `new WebglAddon(true)` 保留 drawing buffer，否则浏览器合成后允许丢弃像素，canvas 快照可能随机为空。
- 快照必须复制活动 xterm 的 canvas，不能仅克隆 DOM；克隆 `<canvas>` 不会复制其绘制内容。
- 每次拖动只截取一次，禁止在 `pointermove` 中重复复制 canvas。

### 4.2 快照不得随容器非等比拉伸

- 快照的 CSS 宽高必须固定为截图瞬间的 `getBoundingClientRect()` 尺寸。
- 禁止设置 `width: 100%` 或 `height: 100%`，否则拖动高度时字体会纵向拉长，拖动宽度时字体会横向拉宽。
- 面板扩大时只补终端背景；面板缩小时通过 `overflow: hidden` 裁剪旧画面。

### 4.3 拖动期间不得调整字符网格

- `ResizeObserver` 检测到 `isPanelResizing()` 时必须直接返回。
- `pointermove` 每帧只修改 dock 像素尺寸，不调用 `FitAddon.fit()` 或 `term.resize()`。
- 最终 cols/rows 只能由 settle 阶段提交一次。

### 4.4 解冻必须等待真实渲染完成

- 必须在调用 `term.resize()` **之前**订阅 `term.onRender`。
- settle listener 必须通过 `PanelResizeSettleDetail.waitUntil()` 注册渲染 Promise。
- `onRender` 完成后仍需再等待一个 rAF，让 WebView2 至少合成一次新画面，再移除快照。
- 不得退回“固定一个/两个 rAF 后解冻”的实现。
- 250ms 终端渲染屏障与 400ms 面板兜底只用于隐藏、销毁或异常终端，不能作为正常完成信号。

### 4.5 PTY resize 必须与画面切换错开

- xterm 的本地最终网格先完成并显示，再通知原生 PTY。
- alternate buffer 使用 100ms，normal buffer 使用 500ms 合并窗口。
- `PANEL_RESIZE_END_EVENT` 中不得立即调用 `flushPendingPtyResize()`；这会让 OpenCode、vim 等 TUI 与 WebGL 揭帧同时整屏刷新。

## 5. 关键文件

| 文件 | 职责 |
|---|---|
| `src/hooks/useTerminalPanel.ts` | Pointer Capture、每帧合并 dock 像素尺寸、触发 begin/settle |
| `src/lib/panelResize.ts` | canvas 快照、settle `waitUntil`、合成帧与超时兜底 |
| `src/components/Terminal.tsx` | 阻止拖动中 fit、最终网格提交、`onRender` 屏障、PTY 调度 |
| `src/lib/terminalRenderBarrier.ts` | xterm 实际渲染完成信号与 250ms 安全超时 |
| `src/lib/terminalResizePolicy.ts` | 网格校验和 normal/alternate PTY 延迟策略 |
| `src/styles/xterm.css` | 快照覆盖层、原尺寸显示、背景补齐和裁剪 |
| `src/lib/panelResize.test.ts` | 快照必须跨越 render readiness 和额外合成帧 |
| `src/lib/terminalRenderBarrier.test.ts` | rendered、unchanged、timeout 三条屏障路径 |

## 6. 性能约束

- 一次拖动只进行一次 canvas 复制、一次最终 `term.resize()` 和一次最终 PTY resize。
- `pointermove` 继续使用 rAF 合并，只处理最新目标尺寸。
- 快照由 CSS 定位与裁剪，不在拖动帧中重绘。
- 不要为解决闪烁恢复实时字符网格 reflow；忙碌终端与全屏 TUI 会显著放大其开销。

## 7. 修改后的验证清单

自动检查：

```bash
pnpm exec vitest run src/lib/panelResize.test.ts src/lib/terminalRenderBarrier.test.ts src/lib/terminalResizePolicy.test.ts
pnpm check:frontend
pnpm build
```

必须使用 `pnpm tauri:dev` 做 WebView2 目测；浏览器测试和单元测试无法判断真实合成像素。

| 场景 | 操作 | 预期 |
|---|---|---|
| 普通 PowerShell | 快速上下连续拖动底部终端 | 无白/黑帧；字体比例不变 |
| 面板扩大 | 向上拖动 | 原画面保持清晰，新增区域为终端背景 |
| 面板缩小 | 向下拖动 | 原画面平滑裁剪，无压缩或拉伸 |
| OpenCode / vim | alternate buffer 中快速拖动并松手 | 无整屏闪烁；松手后一次稳定重排 |
| 侧栏旁终端 | 快速左右拖动 | 字符不横向拉宽；无空 canvas |
| 忙碌输出 | 持续输出日志时拖动 | 拖动画面稳定；结束后显示最新内容 |
| Windows 缩放 | 100%、125%、150% DPI 分别验证 | 快照清晰且切换位置无跳变 |

## 8. 回归现象与优先排查

| 现象 | 优先检查 |
|---|---|
| 松手瞬间白/黑一下 | `waitUntil` 是否注册；是否提前移除快照；是否绕过 `onRender` |
| 拖动时字体变高或变宽 | 快照是否被设置为 `width/height: 100%` 或使用了非等比 transform |
| 仅 OpenCode/vim 闪烁 | 是否在 end 阶段立即 flush PTY resize；alternate 延迟是否仍为 100ms |
| 拖动全程卡顿 | `pointermove` 是否新增 fit、canvas 复制、React 高频 setState 或 PTY 调用 |
| 偶发一直显示旧画面 | render barrier/面板超时是否被删除；session 取消逻辑是否失效 |
