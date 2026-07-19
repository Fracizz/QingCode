# 编辑器小地图（Minimap）

> 状态：**已实现**（CodeGlance 风格 v1）。
> 实现入口：`EditorMinimap.tsx`、`minimapPolicy.ts`、`minimapPaint.ts`、`minimapSettings.ts`。

对照 [CodeGlance Pro](https://github.com/Nasller/CodeGlancePro) 的交互与观感，在 CodeMirror 6 上自研实现（无法嵌入 JetBrains 插件）。

---

## A. 需求

### A.1 产品目标

右侧代码缩略图，用于：

- 感知文件整体结构与长度
- 点击 / 拖拽跳转滚动位置
- 显示当前视口与光标行
- 悬停 Quick View 快速预览附近源码

### A.2 功能表

| 项 | 要求 | 优先级 |
|---|---|---|
| 位置 | 编辑区右侧竖条，与编辑区同高 | Must |
| 默认 | 开启 | Must |
| 开关 | 设置 → 文本编辑器；`editor.minimap.enabled`；`Ctrl+Shift+G` | Must |
| 点击 / 拖拽跳转 | 按比例滚动 | Must |
| 视口框 | 随滚动同步 | Must |
| Caret 线 | 当前行高亮 | Must |
| 选中匹配 | 双击/选中单词后，小地图同步标出主选区与其他出现处（其他更暗） | Should |
| 语法色 | ≤1MB 默认 **字符预览**（8px 等宽字；颜色同步编辑器 CM 高亮 + 主题变量并柔化）；1–5MB 自动降级色块 | Must |
| Quick View | 预览区悬停约 0.5s 首次显示附近约 12 行 | Must |
| 右键菜单 | 划过滚动条显示、隐藏编辑器滚动条 | Must |
| 体积分级 | ≤1MB full；1–5MB density；>5MB 隐藏 | Must |
| Markdown | 仅源码区；纯预览可无 | Must |
| 不适用 | diff、打开失败、加载中、`LargeFileViewer` | Must |
| 宽度 | 左缘 `PanelResizer` 拖拽 80–360px（与侧边栏同款 grip / `ew-resize`）；默认 120；`localStorage` | Should |
| Error / VCS stripe | 不做（编辑器尚无诊断 / VCS gutter） | Won't |

### A.3 性能验收

1. 滚动时缩略图不整图重绘；仅视口指示更新
2. 连续输入相对关闭小地图时无明显额外延迟
3. 仅活动 `EditorView` 绘制
4. >5MB 不挂载

---

## B. 架构

```
Editor.tsx
├── 单一共享 EditorView（viewRef）
├── updateListener → emitMinimapUpdate
└── .editor-pane
    ├── .editor-pane__host  → CodeMirror
    └── .editor-minimap     → absolute overlay
        ├── canvas / viewport
        ├── PanelResizer（左缘拖宽，复用 sidebar 样式）
        ├── Quick View（portal）
        └── 右键菜单（portal）
```

| 文件 | 职责 |
|---|---|
| `src/components/EditorMinimap.tsx` | UI、跳转、拖宽（`PanelResizer`）、右键、Quick View |
| `src/lib/minimapPaint.ts` | Lezer 着色、density、caret |
| `src/lib/minimapPolicy.ts` | 档位 / 宽度 / 视口 / 采样 |
| `src/lib/minimapSettings.ts` | `editor.minimap.enabled` |
| `src/lib/minimapBridge.ts` | CM `ViewUpdate` 桥接 |
| `src/styles/minimap.css` | overlay / Quick View / 隐藏滚动条 |

**硬性禁令**：禁止每次渲染 `doc.toString()` / 全量 `split`；禁止滚动时重绘 canvas；禁止信 Zustand `tab.content`。
