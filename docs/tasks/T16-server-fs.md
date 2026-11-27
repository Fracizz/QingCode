# T16 server 文件协议

范围：只改/新增 `packages/server/src/workspace/fs/**`（含测试）。**不要改** `daemon.ts`、`workspace/registry.ts`、`workspace/index.ts`、`packages/protocol/**`（契约已由总管写好）。

依据：`docs/roadmap.md` §3、§4.1；接口类型以 `packages/protocol/src/workspace.ts` 为准（`WorkspaceMethods` 中 `fs.*`）；处理函数签名、`WorkspaceError`、`WorkspaceContext` 见 `packages/server/src/workspace/registry.ts`；登记位置 `workspace/fs/index.ts` 的 `fsHandlers`（daemon 已在 default 分支按方法名分发，并在连接断开时调用 `ctx.onClose` 登记的清理）。

实现：

1. `fs.stat` / `fs.read` / `fs.write` / `fs.mkdir` / `fs.createFile` / `fs.rename` / `fs.delete`：
   - 参数逐个校验，不合法抛 `WorkspaceError('params', ...)`；路径必须是绝对路径（POSIX 或 Windows 盘符路径都要支持，server 也在本机 Windows 跑）。
   - Node 错误映射：ENOENT→`not_found`，EEXIST→`exists`，ENOTEMPTY→`not_empty`，EACCES/EPERM→`permission`，其他→`internal`。
   - `fs.read`：默认/上限 2 MiB；`encoding:'base64'` 上限 10 MiB；未指定编码时取前 8 KiB 判断二进制（含 NUL 或非法 UTF-8 比例高），二进制返回 `binary:true, content:''`；按字节偏移读取，utf8 截断时不要切断多字节字符（回退到完整字符边界，并据实返回 length）。
   - `fs.write`：`expectedMtimeMs` 与当前 mtime 差 > 1ms 抛 `conflict`；`create:false` 且不存在抛 `not_found`；写同目录临时文件后 rename（保留原文件权限位）；返回新 mtime。
   - `fs.delete`：目录非空且未传 `recursive` 抛 `not_empty`；拒绝删除根目录和用户主目录本身（`params`）。
2. `fs.search` / `fs.searchCancel`：立即返回 `searchId`，结果经 `ctx.emit('fs.searchResult', FsSearchResultEvt)` 分批推送（每批 ≤ 200 条或 ≥ 100ms），最后一次 `done:true`。
   - 优先 `rg`（`command -v rg` / Windows `where rg` 探测并缓存）：content 用 `rg --json`，name 用 `rg --files` 后在 Node 里做子串/glob 过滤。
   - 无 rg 时 Node 遍历：跳过 `.git`、`node_modules`、`.hg`、`.svn`、大于 2 MiB 或二进制文件；name 模式大小写不敏感子串匹配（`caseSensitive` 时敏感）。
   - 达到 `maxResults`（默认 500，上限 5000）即停止并 `truncated:true`；连接断开或 cancel 时杀掉子进程/停止遍历。
3. `fs.watch`：全量替换本连接的监听集合（最多 500 个路径，超出截断并 log）；用 `fs.watch`（目录非递归即可，Linux 不支持 recursive 时退化为只监听该目录）；变化 200ms 去抖后 `ctx.emit('fs.changed', {paths})`，paths 为发生变化的绝对路径（拿不到文件名时给被监听路径）；`ctx.onClose` 时全部关闭。
4. 纯逻辑（错误映射、二进制判断、UTF-8 边界、glob 匹配、rg json 解析、批处理节流）拆成独立函数并写 vitest；IO 部分用临时目录做集成测试（`os.tmpdir()` 下创建，测试后清理）。

验收：`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec vitest run packages/server` 通过；`node packages/server/build.mjs` 打包成功（不得引入新依赖）。
