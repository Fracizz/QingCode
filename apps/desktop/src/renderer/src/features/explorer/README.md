# T20 文件树 + 搜索（集成说明）

- `FileExplorer({ targetId, root, className? })`：项目文件树，按 `targetId + root` 分仓；懒加载 `fs.list`，展开状态存 `localStorage` 的 `qn-explorer:<targetId>:<root>`；默认隐藏 `.git` 等点文件，可用工具栏切换。
- `QuickOpen({ targetId, root, open, onClose })`：总管绑定 Ctrl+P，打开时渲染弹窗；`SearchPanel({ targetId, root, className? })`：内容搜索面板。两者经 `features/workspace/openers.ts` 的 `openFile` 打开，不直接依赖文件查看面板。
- `useExplorer` 是 zustand store（`scopes[explorerScopeKey(targetId, root)]`、`actions`），一般无需直接调用；`actions.init` 在 `FileExplorer` 挂载时自动执行。
- **fs.watch 由总管统一登记**：`fs.watch` 是「每连接一个监听集合、全量替换」，本目录不调用它。请对每个已连接目标合并 `getExplorerWatchPaths(targetId)`（本项目所有已展开目录 + 项目根）与 T18 的 `getFileWatchPaths(targetId)`，去重后调用 `serverCall(targetId, 'fs.watch', { paths })`；订阅 `subscribeExplorerWatch(cb)`，展开集合变化时重新合并登记。连接重建后也要重新登记一次。
- `fs.changed` 由 `explorerStore` 自行监听（`onServerEvt`），只重列受影响目录；`fs.search` / `fs.searchCancel` / `fs.searchResult` 由 `useFsSearch` 管理，按 `searchId` 过滤并取消旧查询。
- 接口依据 `packages/protocol/src/workspace.ts`：`fs.createFile` / `fs.mkdir` / `fs.rename` / `fs.delete`（目录删除用 `recursive:true`）；`fs.list` 不在 `WorkspaceMethods` 里，按任务卡约定直接用 `lib/backend.ts` 的 `call('server.req', ...)` 透传。
- 假设：默认「隐藏文件」= 名称以 `.` 开头（含 `.git`）；符号链接按可展开目录对待（不 stat，成环时不再深入）；`fs.changed` 推送绝对路径，Windows 大小写不敏感。
