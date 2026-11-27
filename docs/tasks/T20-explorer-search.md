# T20 文件树 + 搜索

范围：只新增 `apps/desktop/src/renderer/src/features/explorer/**`（含测试）。**不得修改任何已有文件**（另一会话正在并行重做 UI；接入由总管完成）。打开文件一律调用 `features/workspace/openers.ts` 的 `openFile`，不要依赖 `features/files` / `features/git` 的内部实现（它们在并行开发）。

依据：`docs/roadmap.md` §5 P1；接口 `packages/protocol/src/workspace.ts`（`fs.list` 在 `messages.ts`）；调用 `features/workspace/serverCall.ts`（`fs.list` 不在 `WorkspaceMethods` 里，直接用 `lib/backend.ts` 的 `call('server.req', ...)`，参考 `components/DirectoryPicker.tsx`）。可只读复用：`components/ui.tsx`、`components/primitives.tsx`、`lib/cn.ts`、`lucide-react`、`zustand`、`radix-ui`（右键菜单可用 `radix-ui` 的 ContextMenu）。

实现：

1. `treeModel.ts`（纯函数 + 单测）：树节点状态（展开集合、子项缓存、加载中/错误）、排序（目录在前，名称自然排序，大小写不敏感）、可见行扁平化（供虚拟列表）、`fs.changed` 路径 → 需要刷新的目录集合、新建/重命名名称校验（非空、不含 `/` `\`、不为 `.`/`..`；Windows 风格路径额外禁止 `<>:"|?*`）、路径拼接（POSIX/Windows 按 root 风格）、默认隐藏 `.git`（可切换显示隐藏文件）。
2. `explorerStore.ts`（zustand，按 `targetId + root` 分仓）：懒加载 `fs.list`；展开状态存 `localStorage`（键 `qn-explorer:<targetId>:<root>`）；监听 `fs.changed`（`onServerEvt`）只刷新受影响目录。`fs.watch` 是"每连接一个监听集合、全量替换"，T18 也要监听，所以本卡**不直接调用 `fs.watch`**：导出 `getExplorerWatchPaths(targetId)`（已展开目录），由总管合并后统一登记，在 README 写清楚。
3. 组件：
   - `FileExplorer.tsx`（props：`targetId`、`root`）：定高虚拟滚动树（自行实现，行高 24px），单击文件 → `openFile`，键盘上下/左右/回车；文件图标按扩展名（lucide 通用图标即可）；顶部工具：新建文件、新建文件夹、刷新、折叠全部、显示隐藏文件。
   - 右键菜单：新建文件/文件夹（行内输入框）、重命名（行内）、删除（确认对话框，目录用 `recursive:true` 并提示）、复制路径、复制相对路径。调用 `fs.createFile` / `fs.mkdir` / `fs.rename` / `fs.delete`，错误码转中文。
   - `QuickOpen.tsx`（props：`targetId`、`root`、`open`、`onClose`）：类 Ctrl+P 弹窗，输入防抖 150ms 调 `fs.search {mode:'name'}`，订阅 `fs.searchResult`（按 searchId 过滤，新查询时 `fs.searchCancel` 旧的），模糊排序（纯函数单测：文件名命中优先、连续命中优先、路径短优先），回车打开。
   - `SearchPanel.tsx`（props：`targetId`、`root`）：内容搜索（区分大小写开关、glob 过滤），结果按文件分组、显示行号与高亮命中片段，点击 → `openFile({line, column})`；显示"结果已截断"。
4. `index.ts` 导出 `FileExplorer`、`QuickOpen`、`SearchPanel`、`useExplorer`、`getExplorerWatchPaths`；本目录 `README.md` 写集成方式。

验收：`pnpm exec vitest run apps/desktop/src/renderer/src/features/explorer` 通过；`pnpm --filter @qn/desktop typecheck` 中**本目录无错误**（其他文件错误来自并行 UI 改动，忽略并注明）。
