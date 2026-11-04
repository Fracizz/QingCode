# Web 测试页与浏览器验收

Android 项目来源场景使用 `/mobile-android/`，运行 `node scripts/web-tests/mobile-project-sources.agent-browser.mjs`。
验证同名项目的连接名称与 IP 分行显示、WSL / 地址搜索、旧版电脑端兼容、首页与终端来源一致、
WSL 空分类说明，以及 320px 窄屏的长连接名换行；截图与结果位于 `.dev/web-tests/mobile-project-sources/`。

Android 扫码识别使用 `node scripts/web-tests/mobile-scanner.agent-browser.mjs`（先启动 `pnpm test:web`）。
复用 `/mobile-android/` 的真实页面、jsQR 与扫码模块，通过 Canvas MediaStream 提供 1920×1080 模拟相机画面，
验证高清后摄与对焦请求、完整预览、真实配对二维码识别、临时帧异常恢复、权限拒绝、识别与取消后释放相机，
以及采集完成晚于取消的处理。固定二维码由桌面同款 qrcode 0.14.1 / M 级纠错生成，位于
`web-tests/fixtures/mobile-pairing-qr.json`，不包含密码；同时复现旧 720px 采样无法识别、中央高清采样可识别的场景。
截图、结果和浏览器异常保存在 `.dev/web-tests/mobile-scanner/`；模拟帧不能证明真机镜头的清晰度与对焦效果。

Android 移动连接设置场景位于 `/web-tests/mobile-connection.html`，运行 `pnpm test:web` 和
`node scripts/web-tests/mobile-connection.agent-browser.mjs`。复用真实设置组件，通过内存 IPC 检查
设置标题与输入控件对齐、简单密码与 20 位边界、密码自动保存与重新打开后恢复、显示/隐藏、停止后修改，
以及浅色窄窗和大字号布局。截图与结果位于 `.dev/web-tests/mobile-connection/`。
该场景不启动监听端口，不替代 Windows 重启恢复及 Android 真机配对验收。

移动连接使用真实设置页的容器断点：整组占满内容列，连接设置与扫码配对在宽列并排，
窄列和大字号时上下排列。该脚本还检查宽窗内的分屏、二维码说明的可读宽度、地址选择不溢出、
按需展开证书指纹，以及配对设备操作保持可用；配对二维码使用固定内存矩阵，不用于实际扫码。

Linux（含 WSL）默认使用 `agent-browser`，Windows/macOS 默认使用 `ego-browser`。
以执行任务的操作系统为准；WSL 即使能调用 Windows Ego，也不会自动改选 Ego。
用户显式指定引擎时优先遵循，同一次验收保持同一引擎，失败时不自动换浏览器。
本文的 `*.ego.mjs` 脚本适用于 Windows/macOS 默认路径及显式选择 Ego 的场景。

## Linux / WSL：Agent Browser

先启动下文对应端口的 Web 测试服务，再用独立 session 打开相同的 fixture 页面：

```bash
agent-browser --version
agent-browser --session qingcode-ui-review open http://127.0.0.1:38439/
agent-browser --session qingcode-ui-review snapshot -i
mkdir -p .dev/web-tests
agent-browser --session qingcode-ui-review screenshot /home/code/QingCode/.dev/web-tests/agent-browser.png
agent-browser --session qingcode-ui-review close
```

截图路径按实际仓库绝对路径调整；并行验收须使用不同 session 名。
需要参数详情时读取 `agent-browser skills get core --full`。
按各场景列出的交互和结果执行断言、保存截图与报告；上面的命令只验证页面打开和截图，
不代表完成整套回归，也不能直接执行 Ego 专用脚本。需要桌面窗口时显式使用 `--headed`。

运行配置发现场景位于 `/web-tests/run-config-discovery.html`，使用普通配置的 `pnpm dev:web-test`
（38419），运行 `scripts/web-tests/run-config-discovery.ego.mjs` 的 `run()`。
复用真实发现弹窗、发现算法、运行配置 store 与样式，文件接口为固定内存数据。
覆盖取消不写入、已有任务去重、跳过坏文件和不安全名称、保存失败与重试、合并导入、保留原配置、
再次打开防重复、英文浅色 480px 窄窗和 Escape。默认保存截图与 results.json 到 `.dev/web-tests/`。
该场景不执行脚本，也不替代真实 Windows/WSL/SSH 文件和信任流程验收。

远端服务包错误恢复场景位于 `/web-tests/ssh-server-recovery.html`，运行
`scripts/web-tests/ssh-server-recovery.ego.mjs` 的 `run()`。复用真实打开项目弹窗、版本/来源信息、
目录选择与在线下载按钮，覆盖选错版本、取消选择、下载失败不保存，以及校验通过后保存并自动重试。
验证深色、英文、480px 窄窗浅色布局，并保存截图和 `results.json`。此页的文件选择、下载、设置与重试均为内存模拟；
不替代 Windows 原生文件选择。Rust 的 `live_stale_package_reselection_restores_service_on_same_connection`
使用明确配置的 `QC_LIVE_*` 主机、已有密钥和指纹，在 UUID 临时目录验证真实 SSH 下的旧包诊断、重选、退避清理、共享 daemon 和目录读取。

终端退出提示条场景为 `/web-tests/terminal-exit.html`，运行 `scripts/web-tests/terminal-exit.ego.mjs` 的 `run()`。覆盖异常退出保持现场、显式打开普通 shell、导出不触发重启、未知退出码、中英文与窄屏浅色布局。该页面只复用提示条组件，进程和 SSH 生命周期由原生集成测试验证；`screenshots: false` 只代表 DOM 验收。

QingCode Android 场景位于 `/mobile-android/`（`pnpm test:web`）。Linux / WSL 运行
`node scripts/web-tests/mobile-layout.agent-browser.mjs`，覆盖首次使用引导、快捷项目、搜索清空、吸顶筛选、长名称、
中文组词保护、命令发送、实时键盘切换、Ctrl+C、字号上下限、历史回看、会话草稿、离线重连、居中弹窗与返回操作。
在 320px 窄屏、390px 常规屏、键盘压缩视口和横屏保存截图，结果位于 `.dev/web-tests/mobile-layout/`。
Windows / macOS 可运行 `scripts/web-tests/mobile-android.ego.mjs` 的 `run()`。
页面直接加载 `mobile/android/web/` 的真实 `index.html`、`app.js`、`protocol.js` 与 xterm，`web-tests/mobile-android-bridge.js`
在内存中替代 `MainActivity` 的 JS 桥和 Windows RPC。覆盖粘贴配对链接后自动核对指纹、证书与二维码不一致时不发送密码、
深链预填、打开项目与命令栏提交、Server 屏幕快照重绘后继续轮询、Alt / Home / PgUp 按键序列、修改端口保留配对并迁移本地记录、
从首页接回原会话。断言读取 xterm 缓冲区而非渲染行，后台窗口不重绘时也能执行；截图在无交互桌面会超时，可传 `screenshots: false`。
该页面不替代真机 WebView、相机扫码、深链、TLS 证书固定与局域网连接验收。

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

## Windows / macOS：Ego 自动验收

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

远程项目后台准备的状态图标场景位于 <http://127.0.0.1:38439/web-tests/ssh-warmup.html>，复用生产项目图标、Tooltip 和状态 store。运行 `scripts/web-tests/ssh-warmup.ego.mjs` 的 `run()` 可验证准备完成后恢复普通云图标且无成功提示，其余四种状态的提示与点击、浅色、英文和窄窗；默认保存截图与 `results.json`。若环境的 `Page.captureScreenshot` 超时，可传 `screenshots: false` 继续 DOM 交互验收，报告会明确记录截图未完成。该场景不建立 SSH；队列的 10 万项目选择、会话预算、前后台复用与取消由 Vitest 覆盖，原生连接、信任、SFTP 与服务仍需 Rust 和真实 SSH 验收。

## 验收边界

SCM 分支菜单场景位于 `/web-tests/scm-branches.html`，使用 `pnpm test:web` 和
`node scripts/web-tests/scm-branches.agent-browser.mjs`。复用真实分支菜单，验证大量分支默认最多十项高度、
向下滚动到远程分支、全量筛选、键盘跨虚拟行选择、少量/空列表、加载状态和窄窗口布局。
截图及结果保存在 `.dev/web-tests/scm-branches/`；分支数据和切换回调均为内存数据，
真实 Git 时间排序由 Rust 测试验证，SSH 分支读取与原生切换仍需真实连接验收。

远程连接概览场景位于 `/web-tests/remote-connections.html`，使用 `pnpm test:web` 和
`node scripts/web-tests/remote-connections.agent-browser.mjs`（Linux 默认 agent-browser）。
复用生产管理页与样式，通过内存适配器提供 SSH、状态检查失败与 Server 端口直连数据；
覆盖概览与编辑切换、隐藏项目搜索、最近项目展开、需要处理筛选、按需日志、800px 窄窗、
英文及浅色主题。截图、JSON 与 HTML 报告保存在 `.dev/web-tests/remote-connections/`。
不建立真实 SSH 连接，不验证终端生命周期、SQLite、系统凭据与原生对话框。

断开与 SSH 切换入口使用同一页面，运行
`node scripts/web-tests/remote-connection-recovery.agent-browser.mjs`。
覆盖主动断开后状态栏与概览同步、无事件时轮询发现端口关闭、SSH 地址及模式选择、
切换影响确认与取消，以及英文浅色窄窗；截图和 JSON 结果位于
`.dev/web-tests/remote-connection-recovery/`。端口关闭由内存状态模拟；
实际 TLS 端口失效由 Rust 本地 gateway 测试覆盖，真实 Windows/远端 SSH 切换仍需桌面验收。

Server 状态栏延迟使用同一页面，运行 `node scripts/web-tests/connection-latency.agent-browser.mjs`。
验证延迟纯文字、提示中的测量时间与更新间隔、状态轮询不重复测量、隐藏暂停及恢复补测、
失败占位不改变在线状态、恢复、断开清理及英文浅色窄窗。产物在 `.dev/web-tests/connection-latency/`。
数值和超时由内存适配器提供；真实认证请求和测量门槛另由 Rust 本地 HTTPS gateway 测试覆盖。

底栏清晰度场景位于 `/web-tests/status-bar.html`，使用 `pnpm dev:web-test`（端口 **38419**）。
复用真实 `StatusBar`、连接徽标和业务 Store，以固定内存项目、分支、光标位置和编码验证三种主题、
连接阶段、13/20/32px 字号、窄窗、编码菜单、Git 入口及终端切换信号。可检查光标位置的快捷键提示、
连接详情和键盘焦点。此页不建立真实连接或读写文件，也不伪造桌面身份，因此浏览器不加载原生内存与版本信息；
这两项以及 Windows 原生缩放效果仍需桌面验收。截图和执行报告放在 `.dev/web-tests/status-bar/`。

OpenCode / Claude 终端交互场景位于 `/web-tests/terminal-interaction.html`，使用 `pnpm dev:web-test`（端口 **38419**）及 `scripts/web-tests/terminal-interaction.ego.mjs` 的 `run()`。该页复用生产 `TerminalView`、xterm、终端 store 和菜单；需要普通 Vite 配置，避免 `test:web` 的项目管理终端 stub。IPC、终端输出和剪贴板均为内存模拟，不启动本机或远端进程。覆盖历史回放不复制、OSC 52 中文写入与读请求拦截、TUI 无选区右键、Claude Shift 选区与两种复制快捷键、选区右键后重绘仍复制快照、Shift 右键及普通 Shell 中断/菜单。产物位于 `.dev/web-tests/terminal-interaction-*/`，`run({ screenshots: false })` 可跳过截图；不代替 Windows 原生剪贴板及真实 SSH/OpenCode/Claude 验收。

`vite.web-test.config.ts` 仅供此测试服务器使用：通过别名将项目/界面/终端/编辑器 store、信任操作、
项目操作和工作区保存替换为 `src/test-pages/projectManagerAdapters.ts` 中的内存适配器。
外部操作只记录调用，隐藏/恢复只更新测试数据。测试页显示操作记录，供断言调用参数。
原生模块中的副作用不属于这套测试的覆盖范围。

普通桌面构建仍使用 `vite.config.ts` 和 `index.html`，不会导入测试页或内存适配器。
普通 `pnpm dev` 下访问测试 HTML 也不会启动测试场景，页面提示使用 `pnpm test:web`。

Web 验收证明 React 界面、布局和交互行为；真实文件读写、SQLite 持久化、SSH、PTY、原生窗口和系统对话框
仍需各自的集成测试。内存操作通过不等于真实原生能力通过。

Server 启动与自启恢复复用 `/web-tests/direct-agent.html` 的「打开启动与自启」入口。
使用真实 `DirectServerRecoveryPanel`，断言开关默认开启、关闭后仅应用自启设置、显式 SSH 启动后自动重连、
权限失败不重连、无同主机 SSH 时显示配置入口及手动命令；覆盖英文浅色与窄屏，产物放入 `.dev/web-tests/server-startup/`。
页面的操作均为内存适配器，不注册真实计划任务。真实 Windows 验收另需核对 S4U/当前用户/Limited/开机触发器、
从计划任务启动 HTTPS 服务、关闭自启不终止服务及重启后的服务恢复。

Windows 管理员真机可运行 `powershell -File scripts/test-server-startup.ps1 -ServerBinary <qingcode-server.exe>`，
用独立程序、随机本地端口、临时状态目录和任务验证注册、取消及计划任务拉起，结束后清理；不重启主机。
Linux 浏览器场景使用 `node scripts/web-tests/server-startup.agent-browser.mjs`。

直连 Server 更新来源场景位于 `/web-tests/server-version-update.html`，Linux 运行
`node scripts/web-tests/direct-update-source.agent-browser.mjs`。复用真实更新弹窗，验证自动获取、
本机离线目录、取消重选、旧包/缺平台文件阻止更新、下载与上传的阶段反馈、失败后重新准备，
以及英文浅色 480px 窄窗。截图、JSON 结果和浏览器错误保存到 `.dev/web-tests/direct-update-source/`。
打开更新弹窗后自动检查一次本机服务包，不触发联网下载；版本、平台及完整性校验通过的本机包直接更新，
确认服务就绪后关闭弹窗并显示完成通知。缺包或失败时保留手动准备/重试入口，下载得到的包等待更新确认。
重新打开时再次检查，展开说明不重复检查或更新；离线目录手动校验成功后同样自动更新。
启动自动更新场景使用同一页面的 `?startup`，Linux 执行
`node scripts/web-tests/startup-server-updates.agent-browser.mjs`。
应用项目列表加载后按连接去重，在后台检查所有已有可信项目的 Server 端口直连连接（包括隐藏项目），
只对版本不匹配且本机离线包合规的服务自动更新，不弹出更新/认证对话框，不自动下载。
复用生产启动 hook、连接准备、自动更新、进度卡片和完成通知；IPC、SQLite 与设置均为内存模拟。
覆盖无需点击即更新、成功提示、旧包/缺包、已是当前版本、未受信任和更新失败，产物在 `.dev/web-tests/startup-server-updates/`。
原生启动准备另由 `cargo test --lib startup_preparation` 覆盖：使用真实本地 HTTPS gateway，
验证健康但版本过旧的服务（包括已缓存端点）仍返回版本不匹配，受限项目不触发服务准备，
当前版本与认证失败分别处理。Web 夹具模拟版本响应，不能替代这组原生分支检查。
目录选择、下载与远端更新均为内存模拟，不替代原生目录选择和真实断网主机的 SSH 更新验收。

安装与更新进度卡片场景位于 `/web-tests/server-operation.html`，Linux 运行
`node scripts/web-tests/server-operation.agent-browser.mjs`。复用真实打开项目组件、后台操作 store 与进度卡片，
覆盖首次安装非模态、真实阶段推进、取消打开、后台更新、计时、成功自动关闭、失败保留授权入口及英文浅色窄窗。
后台更新、打开项目、通知与文件传输复用同一个右下角纵向堆栈；覆盖并行卡片无重叠、取消打开后更新继续、
420px 英文浅色窄窗，以及短窗口中多任务滚动后仍可操作末项。
结果与截图位于 `.dev/web-tests/server-operation/`。该场景不连接 SSH，不替代 Linux/macOS 原生生命周期验收。


退出应用场景位于 `/web-tests/app-close.html`，执行 `node scripts/web-tests/app-close.agent-browser.mjs`。
复用真实退出决策与 `ChoiceDialog`，只替换窗口、文件保存和终端接口；覆盖保留、结束、未确认后的重试/仍然退出、取消文件确认、Escape、仅本地终端以及英文浅色 480px 布局。
截图与结果保存在 `.dev/web-tests/app-close/`。页面不建立远程连接，不能替代原生退出和真实远程终端验收。


界面交互优化回归使用 `node scripts/web-tests/ui-interactions.agent-browser.mjs`。
同时启动 `pnpm dev:web-test`（38419）和 `pnpm test:web`（38439）；Linux 使用独立 headed agent-browser 会话，需要可用的显示环境。
脚本在新的内存会话中添加项目，验证保存失败保留文件、保存后关闭、运行配置与远程连接的离开保护、
设置键搜索与空结果、当前项目分类、分屏无横向溢出、菜单键盘及焦点返回，以及三种主题和英文窄窗的项目行操作。
结果、浏览器异常、PNG 截图与 HTML 报告在 `.dev/web-tests/ui-interactions/`；不建立真实远程连接或执行项目命令。
