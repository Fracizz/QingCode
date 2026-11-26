# T6 渲染进程：连接流程 + Codex 对话 UI

范围：只改 `apps/desktop/src/renderer/**`。可读（不改）：`apps/desktop/src/shared/backendApi.ts`、`packages/codex-client/src/**`、`vendor/codex-protocol/ts/**`。依赖已装：react 19、zustand、tailwindcss 4、lucide-react、react-markdown、remark-gfm。

依据：`docs/mvp.md` §5、§6。T3 已有骨架（`lib/backend.ts`、`store/targets.ts`、三栏布局、连接表单）。

## 要做

1. **连接流程**：点击目标 → `target.connect`（密码认证时先弹密码输入框；私钥带口令时同理）；订阅 `target.state` 显示状态点与进度文字（部署步骤）；错误可重试。`hostKey.prompt` 弹窗：`new` 显示指纹 + "信任并连接 / 取消"；`changed` 红色警告，显示新旧指纹，默认按钮为"取消"。断开按钮。
2. **Codex 传输适配** `lib/codexTransport.ts`：把 backend 的 `codex.send` / `evt codex.recv`（按 targetId 过滤）包装成 `@qn/codex-client` 的 `CodexTransport`；每个 ready 的目标首次进入对话时调用 `server.req codex.open`，记住 `lastSeq`。
3. **状态** `store/codex.ts`（zustand）：每个目标一个 `CodexRpc` + `ConversationState`（用 codex-client 的 reducer）；当前目标、当前 cwd、会话列表、当前 threadId。
4. **中栏**：当前目标的项目列表（`projects.list {targetId}`；"添加项目"弹窗：路径输入框 + 用 `server.req fs.list {dirsOnly:true}` 逐级浏览，起点 `fs.home`，确定后 `projects.save`；右键/菜单删除 `projects.remove`）；选中项目时 `projects.save` 刷新 lastOpenedAt；项目下的会话列表（`thread/list` 按 cwd，显示标题/预览、更新时间；刷新按钮）；"新建会话"。
4b. **导入旧版 QingCode**：左栏底部入口 + 首次启动横幅（`legacy.detect` 发现数据且尚无 SSH 目标时显示，可关闭，关闭状态存 localStorage）。导入对话框：来源路径（"另选文件"用 `qn.openFile`，过滤 `.db`）、预览数量、"同时导入已保存的密码"复选框（默认不勾选，旁边说明"用本机系统加密重新保存"）、导入结果摘要（含跳过原因列表），完成后刷新目标与项目。连接表单/密码弹窗加"记住密码"复选框（`target.connect {remember}`），目标菜单加"忘记已保存的密码"（`target.forgetSecret`）。
5. **对话主区**：
   - 打开已有会话：`thread/resume`（或 `thread/read`）后 `loadThread`。
   - 消息列表：用户消息；Agent 消息（react-markdown + remark-gfm，代码块等宽、可横向滚动，流式时末尾光标）；推理摘要（默认折叠）；命令执行（命令、cwd、状态、退出码，输出默认折叠，最多显示末尾 200 行）；文件改动（路径列表 + diff 文本，+/− 行着色）；其他类型显示类型名与摘要。
   - 审批卡片：标题、详情（命令或改动文件），按钮"允许 / 本会话允许 / 拒绝"，调用 `approvalResponse` 后 `rpc.respond`；已解决的卡片消失。
   - 底部输入框：Enter 发送、Shift+Enter 换行、IME 组合输入时 Enter 不发送；运行中显示"中断"按钮（`turn/interrupt`）；turn 失败显示错误。
   - 自动滚动到底（用户上滑时暂停，出现"回到底部"按钮）。
6. 本机目标（id `local`）走同一套流程；若本机未安装 codex，`codex.open` 的错误要清楚提示"本机未找到 codex，请先安装并 `codex login`"。
7. 视觉：深色、紧凑、等宽字体用于命令/代码；组件拆分到 `components/`，不要一个巨型文件。

## 验收

- `pnpm --filter @qn/desktop typecheck`、`pnpm exec vitest run apps/desktop/src/renderer`（为传输适配、目录历史等纯逻辑写单测）通过；`pnpm --filter @qn/desktop build` 成功；`electron . --smoke` 仍退出 0。
- 报告里列出你无法在无界面环境验证的交互，由总管手工验收。
