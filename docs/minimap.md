# 编辑器小地图（Minimap）

> 状态：**已实现**（v1）。验收仍按 §A.5 Must 清单手动确认。  
> 实现入口：`EditorMinimap.tsx`、`minimapPolicy.ts`、`minimapSettings.ts`。

本文分两块：

| 块 | 回答什么 | 变更原则 |
|---|---|---|
| **A. 需求** | 用户要什么、验收什么 | 产品拍板；实现不得擅自砍 Must |
| **B. 最佳方案** | 在 QingCode 架构下怎么做最稳 | 可替换实现细节，但须仍满足 A |

---

# A. 需求（What）

## A.1 产品目标

右侧 **VS Code 风格代码缩略图**，用于：

- 感知文件整体结构与长度
- 点击（及可选拖拽）跳转滚动位置
- 显示当前视口在全文中的位置（视口框）

**不追求**：像素级对齐 VS Code、完整语法高亮缩略、Markdown 并排预览区小地图。

## A.2 功能需求

| 项 | 要求 | 优先级 |
|---|---|---|
| 位置 | 编辑区右侧竖条，与编辑区同高 | Must |
| 默认 | **开启** | Must |
| 开关 | 设置 → 文本编辑器；`editor.minimap.enabled`（全局/工作区合并） | Must |
| 点击跳转 | 点击 → 编辑器滚到对应比例位置 | Must |
| 视口框 | 随滚动同步显示当前可见范围 | Must |
| 体积分级 | ≤1MB 完整缩略；1–5MB 密度条；>5MB **不显示** | Must |
| 体积判定 | 优先 `tab.fileSize`，未知再 `doc.length`；>5MB 与 degraded 档（5MB）对齐 | Must |
| Markdown | 仅源码编辑区显示；纯预览可隐藏 | Must |
| 不适用 | diff、打开失败、加载中、`LargeFileViewer` 不显示 | Must |
| 宽度 | 可拖拽（建议 64–180px，默认 96px）；本地记忆即可，**不必进 settings JSON** | Should |
| 轻量着色 | ≤1MB 有关键字/字符串/注释等简化色（非完整 token） | Should |
| 遗留迁移 | 旧模板「不计划」+ `false` 可迁为 `true` | Should |
| 拖拽连续跳转 | 按住小地图拖动连续滚动 | Could |
| 主题色 | 跟随 forest / light | Could |

**设置**：默认模板改为 `true`；宽度不暴露过多 JSON 键。

**实现后文档**（Should，建议同 PR）：设置中/英文案、帮助、`CHANGELOG`、模板注释去掉「不计划」、设置页「已生效键」列入该键。

## A.3 性能与体验验收（结果，不规定实现 API）

下列为**可验收结果**；违反则宁可不上线：

1. 滚动时缩略图不闪、不整图重绘；仅视口指示更新
2. 连续输入相对关闭小地图时无明显额外延迟
3. 后台/非活动标签不持续做绘制工作
4. 大文件（>5MB）不显示，避免 WebView 卡顿

## A.4 明确不做（v1 Won't）

- >5MB 仍显示  
- diff / 只读大文件查看器上的小地图  
- 完整 token 级缩略、`editor.minimap.maxColumn` 等 VS Code 全量配置  
- 与 Markdown 预览同步滚动、diff 两侧各一枚小地图  

## A.5 合并前验收（Must 全过）

**功能**

- [ ] 冷启动后小文件（&lt;100KB）右侧竖条**稳定可见**（非一闪）
- [ ] 默认开；设置关→立即消失；再开→恢复
- [ ] 点击可跳转；视口框随滚动动
- [ ] ≤1MB 有缩略；1–5MB 密度条；&gt;5MB 无
- [ ] MD 源码有 / 纯预览可无；diff / 失败 / 加载中 / `LargeFileViewer` 无

**体验**

- [ ] 滚动时缩略不闪
- [ ] 连续输入无明显卡顿
- [ ] 关闭小地图对比，体感可接受

**手动回归**：`pnpm tauri:dev` 完全退出再开 → 小文件可见 → 滚动/输入 → 开关 → 打开 &gt;5MB 确认隐藏。

---

# B. 最佳解决方案（How）

在 QingCode **单共享 `EditorView` + `tab.content` 常被清空** 的前提下，下列为推荐默认方案；换实现须仍满足 A。

## B.1 方案选型

| 选项 | 结论 |
|---|---|
| CodeMirror 内置 minimap | **无**；不可用 |
| 第三方 CM6 minimap 插件 | 不优先（体积/与单 view 绑定难对齐） |
| **自绘 canvas + 视口 DOM overlay** | **采用**：可控、易做滚动分离与体积分级 |

## B.2 架构约束 → 对策

```
Editor.tsx
├── 单一共享 EditorView（viewRef）
├── bindTabToView：换 EditorState；Zustand tab.content 常清空
├── 正文唯一真相：CM doc（getLiveEditorContent）
└── 大文件：full / degraded / plain / view
```

| 约束 | 对策 |
|---|---|
| 勿信 `tab.content` | **只读** `viewRef.current.state.doc` |
| flex 兄弟易高度 0 | 小地图做 **同一 pane 的 absolute overlay**（right/top/bottom:0） |
| Suspense lazy，首帧 ref 空 | `containerRef` 就绪后再挂；bind 结束显式 `repaint()`，必要时短 retry |
| 设置异步加载会覆盖 | 监听 `loadEffectiveEditorPreferences` / 变更通知，勿只读首帧默认值 |

## B.3 DOM 结构

```
.editor-pane (position: relative)
├── .editor-pane__host  ← CodeMirror
└── .editor-minimap     ← absolute; right:0; top:0; bottom:0
    ├── canvas          ← 缩略（仅 docChanged / resize / bind 后重绘）
    └── viewport        ← 视口框（仅改 top/height）
```

## B.4 数据流与性能实现要点

```
docChanged (CM updateListener) → requestRepaint()  // rAF 合并 + ≥48ms 节流
scroll                         → 只改 viewport style
bindTabToView 结束             → repaint()
ResizeObserver                 → repaint()
```

**硬性实现禁令**（对应 A.3，上次翻车点）：

1. 禁止每次 React 渲染 `doc.toString()` / `split('\n')`
2. 禁止 interval 轮询文档
3. 绘制按 **canvas 高度采样行**（O(画布行数)）；简化档 DPR=1
4. 仅当前绑定的 `EditorView` 绘制

**体积策略实现**：`minimapPolicy.ts` 纯函数 + Vitest；1–5MB 只读行长画密度条；>5MB 组件直接不挂载。

## B.5 文件划分

| 文件 | 职责 |
|---|---|
| `EditorMinimap.tsx` | UI、绘制、点击/拖拽、宽度 |
| `minimapPolicy.ts` | 档位常量与判定 + 单测 |
| `minimap.css`（或并入现有样式） | overlay |
| `Editor.tsx` | 挂载条件 + settings/宽度（约 +30 行） |
| （可选）`migrateLegacyMinimapSetting` | 旧 `false`+不计划 → `true` |

## B.6 上次失败 → 方案侧规避

| 现象 | 根因 | 本方案规避 |
|---|---|---|
| 完全看不到 | sessionKey 空 / `containerRef` null 就 return | overlay + bind 后 repaint；不依赖脆弱 sessionKey |
| 一闪而过 | 先画 `tab.content` 再绑到空 CM；或 flex 塌高 | 禁止用 `tab.content` 作源；absolute 同高 |
| 设置开了仍无 | 模板/磁盘仍 `false`；异步 preferences 覆盖 | 默认改 `true` + 监听生效值；可选迁移 |
| 性能差 | 轮询、全量 toString、滚动重绘 canvas | 禁令 + 滚动/绘制分离 |

## B.7 实现落点

| 项 | 路径 |
|---|---|
| UI / 绘制 | `src/components/EditorMinimap.tsx` |
| 样式 | `src/styles/minimap.css` |
| 档位策略 | `src/lib/minimapPolicy.ts` |
| 设置 / 迁移 | `src/lib/minimapSettings.ts` |
| CM 桥接 | `src/lib/minimapBridge.ts` → `Editor.tsx` `updateListener` |
| 隐藏阈值 | `MINIMAP_HIDE_BYTES === EDIT_DEGRADED_BYTES`（5MB） |
