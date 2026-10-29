# Web 测试页 + ego 验收

终端退出提示条场景为 `/web-tests/terminal-exit.html`，运行 `scripts/web-tests/terminal-exit.ego.mjs` 的 `run()`。覆盖异常退出保持现场、显式打开普通 shell、导出不触发重启、未知退出码、中英文与窄屏浅色布局。该页面只复用提示条组件，进程和 SSH 生命周期由原生集成测试验证；`screenshots: false` 只代表 DOM 验收。

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

界面清晰度场景位于 <http://127.0.0.1:38439/web-tests/ui-clarity.html>，运行
`scripts/web-tests/ui-clarity.ego.mjs` 的 `run()`。复用生产来源徽标、设置项、SSH 状态与详情、
导入弹窗，覆盖阶段状态、键盘展开密钥详情、显式选择导入、三种主题、中英文和 800px 窗口下的 20px 字号。
数据及导入保存均在内存中；IPC 仅在此测试入口中模拟，未列出的命令直接失败。
该场景验收完成后保留自己的 TaskSpace，可传 `spaceId` 给项目管理脚本继续回归并由其收尾关闭。

两个脚本均支持 `captureScreenshots: false`，供截图接口不可用时继续 DOM 交互验收。
报告会记录 `screenshotStatus: "not-captured"`；无截图不能视为视觉验收完成，也不能代替真实 Windows
100% / 125% / 150% 缩放检查。`results.json` 和 `report.html` 默认仍保存在 `.dev/web-tests/`。

Windows SSH 修复确认框的独立场景位于 <http://127.0.0.1:38439/web-tests/ssh-repair.html>，复用真实 `ConfirmDialog` 和产品复选框文案。可验证默认勾选、取消勾选后确认、取消整个弹窗以及再次打开时重置默认值。场景只回显选择结果，不建立 SSH 连接；真实配置备份、有效配置等义验证、并发修改拒绝和回滚可在 Windows 管理员 SSH 环境运行 `scripts/test-windows-sshd-repair.ps1 -ImplementationPath <windows_sshd_repair.ps1>`。该脚本使用临时配置副本与真实 sshd 校验器，服务启停由仅接受测试名称的桩替代，不重启真实服务。

远程项目后台准备的状态图标场景位于 <http://127.0.0.1:38439/web-tests/ssh-warmup.html>，复用生产项目图标、Tooltip 和状态 store。运行 `scripts/web-tests/ssh-warmup.ego.mjs` 的 `run()` 可验证五种状态的提示与点击、浅色、英文和窄窗；默认保存截图与 `results.json`。若环境的 `Page.captureScreenshot` 超时，可传 `screenshots: false` 继续 DOM 交互验收，报告会明确记录截图未完成。该场景不建立 SSH；队列的 10 万项目选择、会话预算、前后台复用与取消由 Vitest 覆盖，原生连接、信任、SFTP 与服务仍需 Rust 和真实 SSH 验收。

## 验收边界

`vite.web-test.config.ts` 仅供此测试服务器使用：通过别名将项目/界面/终端/编辑器 store、信任操作、
项目操作和工作区保存替换为 `src/test-pages/projectManagerAdapters.ts` 中的内存适配器。
外部操作只记录调用，隐藏/恢复只更新测试数据。测试页显示操作记录，供断言调用参数。
原生模块中的副作用不属于这套测试的覆盖范围。

普通桌面构建仍使用 `vite.config.ts` 和 `index.html`，不会导入测试页或内存适配器。
普通 `pnpm dev` 下访问测试 HTML 也不会启动测试场景，页面提示使用 `pnpm test:web`。

Web 验收证明 React 界面、布局和交互行为；真实文件读写、SQLite 持久化、SSH、PTY、原生窗口和系统对话框
仍需各自的集成测试。内存操作通过不等于真实原生能力通过。
