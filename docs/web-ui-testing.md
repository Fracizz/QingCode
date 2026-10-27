# Web 测试页 + ego 验收

项目管理提供独立的浏览器验收入口，复用 `src/components/ProjectManager.tsx` 及生产样式。
不启动 `App.tsx`，不加载真实项目数据库、恢复会话或建立 SSH 连接。

## 启动

```powershell
pnpm test:web
```

访问 <http://127.0.0.1:38439/>。独立 Vite 配置只监听本机，端口被占用时直接失败。
依赖缓存放在 `.dev/vite-web-test-cache`，不会与桌面开发服务的依赖缓存冲突。

测试数据包含 16 个持久项目（显示 5、隐藏 11）和 1 个不应出现在管理列表的临时项目：

- 本机、Ubuntu 与 Debian 原生 WSL 项目；同时包含旧 UNC 路径和 WSL URI。
- 两个 SSH 连接：`WinDev` 与连接名称为 `WSL` 的主机。
- 同名的 `django`、`nem-panel`、`QingCode`，以及长项目名和跨页记录。

页面可重置数据、切换主题与语言；关闭项目管理后可操作测试页工具栏。

## ego 自动验收

先阅读当前安装版本的指南：

```powershell
ego-browser skill
```

保持 Web 测试服务运行，在另一个 PowerShell 中执行以下命令；路径按实际检出位置调整：

```powershell
ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/project-manager.ego.mjs').then(m=>m.run())"
```

脚本使用一个 ego TaskSpace，在浏览器中操作真实表单控件并断言 DOM 结果。成功后关闭自己的 TaskSpace；
失败时保留浏览器现场。使用 `run({ spaceId: <已有 id> })` 可以在同一 TaskSpace 中重跑。

覆盖项目：

1. 固定数据、临时项目排除和稳定的同名来源标签。
2. 本机、原生 WSL、具体发行版、SSH 和具体连接的筛选。
3. 名称、路径、连接名、主机、账号和大小写搜索。
4. 关键词、来源、显示状态的组合及空结果。
5. 分页复位、每页数量、全量排序。
6. 跨页选择、筛选后的选择清理、保存工作区的参数。
7. 清除搜索后的键盘焦点、Escape 关闭与重开、重置数据。
8. 行内隐藏和恢复的内存状态变化。
9. 1440px 和 800px 布局、浅色主题、英文界面及未捕获的浏览器异常。

默认产物位于 `.dev/web-tests/project-manager-<运行时间>/`：`results.json`、`report.html`，
以及桌面、窄窗、浅色和英文界面的 PNG 截图。可用 `run({ artifactDir: 'D:/absolute/path' })` 指定位置。
截图用于人工视觉检查；脚本没有建立像素差异基线。

## 验收边界

`vite.web-test.config.ts` 仅供此测试服务器使用：通过别名将项目/界面/终端/编辑器 store、信任操作、
项目操作和工作区保存替换为 `src/test-pages/projectManagerAdapters.ts` 中的内存适配器。
外部操作只记录调用，隐藏/恢复只更新测试数据。测试页显示操作记录，供断言调用参数。
原生模块中的副作用不属于这套测试的覆盖范围。

普通桌面构建仍使用 `vite.config.ts` 和 `index.html`，不会导入测试页或内存适配器。
普通 `pnpm dev` 下访问测试 HTML 也不会启动测试场景，页面提示使用 `pnpm test:web`。

Web 验收证明 React 界面、布局和交互行为；真实文件读写、SQLite 持久化、SSH、PTY、原生窗口和系统对话框
仍需各自的集成测试。内存操作通过不等于真实原生能力通过。
