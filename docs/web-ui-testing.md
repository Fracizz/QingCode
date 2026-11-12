Android 图片与快捷会话场景运行 `node scripts/web-tests/mobile-images.agent-browser.mjs`。
Windows / macOS 的原图上传专项运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-images.ego.mjs').then(m=>m.run())"`（路径按检出目录调整）。覆盖原图选择与保存、上传参数与草稿、超限后切换压缩、重载后沿用和 320px 布局；截图与结果位于 `.dev/web-tests/mobile-images-ego/`，原生选择与上传使用内存桥模拟。
覆盖默认中压缩、保存偏好、取消选择、上传失败保留草稿、迟到上传不串会话、Claude / OpenCode 各启动一次、
紧凑底栏与模拟圆角内边距，截图和结果位于 `.dev/web-tests/mobile-images/`。
此页面使用内存图片选择与 RPC，不替代 Android 相册、照片压缩、Windows / WSL 路径和远端上传的真机验收。

# Web 测试页与浏览器验收

终端工作台项目切换：启动 `pnpm dev:web-test`（38419），Linux 运行 `node scripts/web-tests/terminal-project-switch.agent-browser.mjs`。复用完整 App 与业务 Store，覆盖无终端项目的菜单切换、当前项目禁用、组头加载与重复点击限制、失败保留及重试、布局与侧栏保持，以及英文浅色窄窗。截图与 JSON 结果在 `.dev/web-tests/terminal-project-switch/`；文件、数据库、终端与连接采用隔离测试环境，不替代真实 SSH、PTY 和原生集成验收。

手机会话运行状态：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-session-activity.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖两个会话同时转动、未选中会话完成、手动名称、退出、刷新失败恢复、迟到响应、320px 布局、减少动画和后台/关闭侧栏后暂停刷新。截图与 JSON 位于 `.dev/web-tests/mobile-session-activity/`；使用内存 RPC，不代替 Android 真机和实际 CLI 标题更新验收。

`mobile-send-settings.ego.mjs` 同时覆盖「清除输入」在命令栏与实时输入模式下发送 Ctrl+E、Ctrl+U，以及识别 Windows PowerShell 提示行后改发 Ctrl+Home、Ctrl+End，保留手机草稿并释放修饰键；「清空草稿」仍只编辑本地，清除操作不提交命令或发送中断。

手机快捷键与发送设置：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-send-settings.ego.mjs').then(m=>m.run())"`（路径按检出目录调整）。覆盖 Ctrl+C 文字完整显示和真实中断序列、触摸选项分行显示及保存、发送设置即时生效和重载恢复、慢网络下收到文字回执后再单独发送 Enter、连续提交不插队、发送失败与离开会话取消补发，以及默认斜杠候选。截图和 JSON 位于 `.dev/web-tests/mobile-send-settings/`；使用真实 Web 资产和内存 RPC，Android WebView、输入法与真实 Claude / OpenCode 仍需真机验收。

安卓折叠底行与图片多选：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-multi-images.ego.mjs').then(m=>m.run())"`。覆盖折叠/展开后的完整底行、320px 窄屏、键盘高度及横屏、输入框常驻图片入口、多图原图逐张读取与上传、部分失败保留草稿、取消、切换会话停止批次和单图桥兼容。截图与 JSON 在 `.dev/web-tests/mobile-multi-images/`；内存桥不替代 Android 系统多选、解码与真实网络验收。

手机会话侧栏与命名：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-sidebar.ego.mjs').then(m=>m.run())"`，复用 `pnpm test:web` 的 Android 页面。验证左侧抽屉、程序标题、手动名称优先级、清空恢复自动命名、失败保留原名、草稿隔离、重连接回、320px 窄屏、横屏菜单与旧电脑兼容，并在同一浏览器空间回归最近项目和结束全部会话。截图及 JSON 位于 `.dev/web-tests/mobile-sidebar/`。Rust `mobile` / `mobile_screen` 测试验证真实 OSC 分片解析、标题过滤、名称长度校验、手动名称优先及快照/轮询元数据；浏览器使用内存 RPC，不能代替 Android 真机与本机/WSL/SSH 进程验收。

安卓平板项目侧栏：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-tablet-projects.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。以 1280×800 验证跨项目切换时分组顺序不变、列表不变暗、终端区不空（旧画面保留到新终端就绪）、关闭最后一个终端后留在空项目、组头在其他项目新建终端并按配置创建、`⋯` 切换与移除（只关手机会话，电脑终端和电脑端项目不动，刷新后不复活，移除当前项目后转到下一个）、折叠与空项目不可折叠、后台终端「有新结果」及组头圆点、长按拖动项目和终端排序并保存，以及原地长按仍露出关闭或打开操作菜单。截图与 JSON 位于 `.dev/web-tests/mobile-tablet-projects/`；使用内存 RPC，WebGL 画面替换和拖动手感须真机验收。

安卓平板适配：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-tablet.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。以 1280×800（同时模拟屏幕尺寸）验证双栏默认收起、侧栏按钮展开为无遮罩常驻侧栏且终端可输入、再次点击收起并记住选择、新建与切换会话不收起、常驻期间元数据继续刷新、返回键离开终端并在工作台取消常驻、600px 分屏退回模态抽屉、915×412 横屏手机不常驻，以及 `qingHardKeyboard` 收起快捷键栏、手动展开不改偏好、拔出后恢复。截图与 JSON 位于 `.dev/web-tests/mobile-tablet/`；使用内存 RPC，实体键盘识别、分屏与折叠屏须真机验收。

手机会话操作菜单：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-session-actions.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。验证点 ⋯ 与触摸长按都打开同一底部菜单、短按仍切换会话、置顶后排在最前并显示标记（新置顶在上）、离开再接回后仍保留、取消置顶恢复电脑端顺序、结束非当前会话时留在侧栏并清除其置顶，以及 320px 窄屏。置顶只保存在手机 localStorage（按连接 + 项目），不改变电脑端顺序；截图与 JSON 位于 `.dev/web-tests/mobile-session-actions/`，使用内存 RPC，不替代 Android 真机长按手感验收。
手机侧栏逐项关闭：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-session-close.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖每行独立关闭、明确目标与取消、关闭其他项保留当前会话和草稿、失败重试、关闭当前项恢复剩余会话草稿、最后一项关闭后留在空项目页，以及窄屏、键盘高度和横屏下的触控区与底部操作；随后在同一空间回归重命名、旧电脑兼容及关闭全部的范围、取消和部分失败。截图和 JSON 位于 `.dev/web-tests/mobile-session-close/`；关闭操作只作用于内存桥，不代替 Android 真机和实际进程验收。

手机会话纵览：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-session-overview.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖首页「全部会话」默认显示且可在设置中关闭再打开、位于最近打开之前、「运行中优先」点一下运行中会话排在组内最前并提示、再点恢复默认顺序、一次请求列出全部项目、先显示 8 个与展开收起、组头完整数量、上次使用标记、搜索与筛选不截断、其他设备运行中会话的确认说明、多选「选已结束」跨项目批量关闭、批量确认统计与取消保留选择、全选切换、首页点选会话接入；抽屉「全部」项目顺序固定与批量关闭不影响当前终端；横屏矮屏抽屉与 320px 首页多选布局；以及旧电脑缺少 `all_sessions` 时隐藏首页区块并禁用抽屉「全部」。截图和 JSON 位于 `.dev/web-tests/mobile-session-overview/`；会话只存在于内存桥，不代替 Android 真机与多台手机的实际验收。

会话抽屉两个范围的一致性：`scripts/web-tests/mobile-session-parity.ego.mjs`（用法同上）。覆盖「本项目」同款组头、同一会话在两个范围状态行相同、「全部」跨项目置顶 / 重命名 / 结束、长按打开操作菜单、电脑终端只能结束、多选隐藏行内操作、320px 布局，以及从「本项目」移除当前项目时统计其手机会话。截图和 JSON 位于 `.dev/web-tests/mobile-session-parity/`。

手机最近打开与批量结束会话：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-recent-sessions.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。验证最近 10 项的时间排序、整页滚动与固定导航、重开置顶、旧电脑兼容与按电脑隔离，以及结束全部会话的数量/范围确认、取消、部分失败保留和重试。截图与 JSON 位于 `.dev/web-tests/mobile-recent-sessions/`；使用内存 RPC，不结束真实终端，不替代 Android 真机和本机/WSL/SSH 进程验收。

手机新建会话与电脑端终端配置：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-terminal-profiles.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。验证项目空状态按钮与右上角「+」打开同一「新建会话」弹层、首个终端使用「普通终端」配置、弹窗按电脑端配置列出并标出未信任项、未信任配置留在弹窗不创建、按配置 id 创建且不向终端输入命令、电脑端修改后再次打开即刷新、已删除配置由电脑端拒绝、旧电脑只保留普通终端，以及 320px 窄屏。截图与 JSON 位于 `.dev/web-tests/mobile-terminal-profiles/`；使用内存 RPC，命令解析与信任由 `src/lib/mobileBridge.test.ts`、Rust `mobile` / `terminal` 测试覆盖，不替代本机/WSL/SSH 真实进程验收。

安卓后台提醒、渲染与手势说明：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-background-alerts.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖首次手势说明只显示一次、320px 布局和返回键、emoji 按 Unicode 11 占两格、WebGL 开关与丢失上下文后的回退和恢复、后台提醒的一次性询问、权限拒绝、旧版电脑不询问，以及点通知切到目标会话。桥默认关闭 WebGL 并标记手势说明已看过，`?gpu=1`、`?guide=1` 用于显式测试，`?guide=keep` 保留已看过记录。截图与 JSON 位于 `.dev/web-tests/mobile-background-alerts/`。Chrome 设备模拟下 WebGL 画布按显示器真实 DPR 计算，文字会缩小错位，这是模拟的假象，WebGL 画质须在未模拟的页面或真机确认；前台服务、系统通知和息屏行为同样只能真机验收。

安卓界面动效：先启动 `pnpm test:web`，运行 `node scripts/web-tests/headless-task-space.mjs <仓库绝对路径>/scripts/web-tests/mobile-motion.ego.mjs`（窗口被节流时动画时间不走，所以用无头 Chrome）。覆盖弹层退出时 `close` 语义不变且不挡点击、退出途中重新打开、抽屉与返回键、页面和浮层入场、按压缩放、发送回执、延迟探测闪烁（失败不闪）、虚拟鼠标从尖端长出、会话行原地收起、图标对齐首行，以及减少动画时全部关闭。脚本固定了 `prefers-reduced-motion`，因为测试机系统可能开着减少动画，此时其他脚本走不到动画路径。截图与 JSON 位于 `.dev/web-tests/mobile-motion/`；流畅度须真机确认。

安卓终端打磨：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-terminal-polish.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖状态行「草稿 / 直发」与首次说明、已接收回执约 4 秒后消失且重进终端不回放、输入框横向拖动移动草稿光标与直发 ← / →、快捷键栏排序 / 长按拖动排序（按住前滑动不触发、不误触开关）/ 隐藏到「更多」/ 重载保留 / 恢复默认、双指缩放字号且不发终端输入、实时终端链接点按（localhost 换成电脑地址、复制与打开、全屏程序鼠标上报下按坐标识别），以及 390px / 320px / 键盘高度 / 横屏布局。触摸经 CDP `Input.dispatchTouchEvent` 发出；截图与 JSON 位于 `.dev/web-tests/mobile-terminal-polish/`，截图超时只记录不影响断言。不替代 Android 真机的拖动、缩放手感与系统浏览器验收。

无交互桌面的 Windows 主机（例如经 SSH 登录、`Get-Process` 看不到任何窗口标题）上 Ego 截图会因窗口不渲染而超时。此时可用 `node scripts/web-tests/headless-task-space.mjs <脚本绝对路径>` 以无头 Chrome 运行同一 `*.ego.mjs` 脚本：适配层实现脚本用到的 `taskSpace` / `page` 子集（`click` 支持 CSS 与 `loc=role:button[name=…]`，等元素位置稳定后再点），失败时也会关闭浏览器。有桌面的环境仍按上文默认使用 Ego。

Android 延迟显示运行 `node scripts/web-tests/mobile-latency.agent-browser.mjs`。覆盖首页与终端复用读数、终端周期刷新、长轮询不污染测量、连接详情、320px / 横屏布局、Android 前后台回调、探测失败仍可输入、旧版电脑不重复检测、重新配对恢复和切换电脑丢弃迟到值；截图与 JSON 位于 `.dev/web-tests/mobile-latency/`。调度、单并发和过期由 `mobileAndroidLatency.test.ts` 补充验证；浏览器使用内存桥，真实手机网络及原生计时仍需真机验收。

Codex / OpenCode 全屏只读历史：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-tui-history.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖备用屏、鼠标上报和内联 TUI 的上下连续手势、进入历史后不立即退出、Claude 风格普通终端保持自然滚动、无缓存提示、读取失败重试及显式程序模式；只读模式断言没有终端输入。截图与 JSON 位于 `.dev/web-tests/mobile-tui-history/`。Rust `mobile_screen` 测试补充验证真实重绘的纯文本采样、频率、缓存上限、分片转义与 OSC 排除；浏览器模拟程序输出，不能代替 Android WebView 和实际 Codex / OpenCode 验收。

全屏程序滚动与软键盘行数：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-program-scroll.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`；Ego 窗口不渲染时 rAF 被节流，改用 `node scripts/web-tests/headless-task-space.mjs <脚本绝对路径>`）。覆盖程序开启鼠标上报后右侧回弹变速滑块的显示与隐藏、手指慢滑每两行一格的整格滚轮（绕开 xterm 对小像素滚动的 0.3 倍折扣）、按住滑块按速度持续发送且松手即停、上下箭头翻约三分之一屏，以及软键盘弹出时保持 PTY 行数、画面上移露出光标行（避免 Claude Code / Codex 重绘把旧状态栏挤进历史造成重复）。截图与 JSON 位于 `.dev/web-tests/mobile-program-scroll/`；使用内存 RPC，不替代 Android 真机手感与实际 Codex / OpenCode 验收。

Android 终端长按选字运行 `node scripts/web-tests/mobile-selection.agent-browser.mjs`，复用真实 xterm、触摸手势与页面。覆盖中文宽字符长按、双端手柄跨行拖动、全选、手机剪贴板桥、失败重试、鼠标上报 TUI 不发输入、返回取消、旋转清理及会话切换；截图与结果在 `.dev/web-tests/mobile-selection/`。剪贴板写入由内存桥模拟，Android 原生剪贴板和真实触屏手感仍需真机验收。

Android 项目来源场景使用 `/mobile-android/`，运行 `node scripts/web-tests/mobile-project-sources.agent-browser.mjs`。
验证同名项目的连接名称与 IP 分行显示、WSL / 地址搜索、旧版电脑端兼容、首页与终端来源一致、
取消环境分类后的统一列表、WSL 路径查询，以及 320px 窄屏的长连接名换行；截图与结果位于 `.dev/web-tests/mobile-project-sources/`。

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
`node scripts/web-tests/mobile-layout.agent-browser.mjs`，覆盖首次使用引导、快捷项目、搜索清空、吸顶搜索、长名称、
中文组词保护、命令发送、实时键盘切换、Ctrl+C、两排快捷键与符号键、Alt 双击锁定与释放、单会话隐藏标签栏、
竖屏会话底部弹层、连接头像、字号上下限、历史回看、会话草稿、离线重连、居中弹窗与返回操作。
下拉刷新、弹层下滑关闭和长按连发的触摸手势由 `src/lib/mobileAndroidGestures.test.ts` 覆盖。
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

手机编辑、阅读与恢复专项：运行 `node scripts/web-tests/mobile-workspace.agent-browser.mjs`，覆盖横屏操作菜单、展开编辑与中文组词、草稿持久化、接收回执、未知结果原文恢复、新草稿不被旧回执清空、真实终端固定列宽、只读搜索、diff 文本安全渲染、阅读期间接收新输出、网页链接点击、手机重载后原会话丢失的草稿恢复，以及 320px / 横屏键盘压缩布局。截图、JSON 和中文 HTML 报告位于 `.dev/web-tests/mobile-workspace/`。原生请求通过内存 fixture 模拟，真机系统浏览器、输入法、存储失败及后台杀进程仍需集成验收；`mobileAndroidWorkspace.test.ts` 另行验证持久化失败、跨电脑隔离及迟到回执。

手机快速接回与历史分页：运行 `node scripts/web-tests/mobile-history.agent-browser.mjs`。以 1000 个旧输出块验证最新快照接回及后续序号，不预取历史；覆盖 120 行分页、前插锚点、阅读期间接收新输出、缓存边界、无图标的滚轮与触摸入口、滑回底部返回实时、只读操作不发按键、失败重试、重连接回、TUI 滚轮、全屏返回顺序和切换会话时的迟到响应。报告位于 `.dev/web-tests/mobile-history/`。Rust 的 `mobile_screen::tests` 与 `mobile::tests` 验证解析器、快照、分页游标和旧客户端兼容；触摸单测 `mobileAndroidTerminalTouch.test.ts` 验证逐帧合并、减速惯性、新触摸中止、TUI 禁止惯性和销毁取消。浏览器采用内存 RPC，Windows / SSH / WSL 与真机链路仍需集成验收。

手机横屏与全屏专项：运行 `node scripts/web-tests/mobile-landscape.agent-browser.mjs`，覆盖横屏默认收起、展开后并排布局、旋转与重载后的偏好、收起时保留草稿和实时键盘、释放隐藏修饰键、横屏自动沉浸与竖屏恢复、离开终端恢复系统栏、Android 返回顺序、失败恢复、迟到回复及横屏键盘高度。通过原生方向回调模拟窄屏横屏和竖屏键盘缩小，确认方向判断不依赖键盘后的视口比例。截图和报告位于 `.dev/web-tests/mobile-landscape/`。原生桥由内存 fixture 模拟；Android 横屏保留状态栏并隐藏导航栏、挖孔及软键盘避让仍需真机验收。

手机斜杠命令与技能输入专项：运行 `node scripts/web-tests/mobile-completion.agent-browser.mjs`，覆盖斜杠草稿先预览再确认、草稿与实时输入的 Tab 补全、方向键与确认保留键盘焦点、中文组词保护及多行草稿保留，并检查窄屏、软键盘高度和横屏。截图、JSON 和 HTML 报告位于 `.dev/web-tests/mobile-completion/`；此验收只覆盖真实 Web 资产、xterm 和内存 RPC，仍需真机验证输入法及实际 Claude / OpenCode 候选。

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

终端工作台布局：先启动 `pnpm dev:web-test`（端口 **38419**），Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/terminal-workbench.ego.mjs').then(m=>m.run())"`（路径按检出目录调整）。使用完整 App 与内存后端，覆盖菜单进入、列表显示与标题栏细调、新建/点击/方向键切换、双击重命名、关闭二次确认、全项目分组（拖拽组头排序、切换项目不重排、分组新建、跨项目切换、后台运行与待查看标记、折叠、切到无文件项目收起编辑器）、切到文件树时标签栏接管、打开文件后编辑器在终端右侧、分隔条向右拖宽并在编辑器开合后保留、关闭最后一个文件自动收起、收起终端后点列表展开、重载恢复、800px 窄窗和切回其他预设。截图与 JSON 位于 `.dev/web-tests/terminal-workbench/`；终端与文件均为模拟，不代替 Tauri 下真实 PTY、SSH 与原生窗口验收。

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

OpenCode / Claude 终端交互场景位于 `/web-tests/terminal-interaction.html`，使用 `pnpm dev:web-test`（端口 **38419**）及 `scripts/web-tests/terminal-interaction.ego.mjs` 的 `run()`。该页复用生产 `TerminalView`、xterm、终端 store 和菜单；需要普通 Vite 配置，避免 `test:web` 的项目管理终端 stub。IPC、终端输出和剪贴板均为内存模拟，不启动本机或远端进程。覆盖历史回放不复制、OSC 52 中文写入与读请求拦截、TUI 无选区右键、Claude Shift 选区与两种复制快捷键、选区右键后重绘仍复制快照、Shift 右键及普通 Shell 中断/菜单，以及文件路径 Ctrl+点击（含带鼠标上报的 TUI、文件不存在）、OSC 8 文件与编辑器链接、文字与地址不符的网页链接确认、Shift+Enter 在 TUI 与普通 Shell 的区别。产物位于 `.dev/web-tests/terminal-interaction-*/`，`run({ screenshots: false })` 可跳过截图；不代替 Windows 原生剪贴板及真实 SSH/OpenCode/Claude 验收。

终端 Ctrl + 滚轮缩放复用同一页面与 `pnpm dev:web-test`（端口 **38419**），运行 `scripts/web-tests/terminal-font-zoom.ego.mjs` 的 `run()`。覆盖每格一步、字号持久化、页面不缩放、不转发给鼠标跟踪中的 TUI、缩放保持历史阅读位置和字号上限。产物位于 `.dev/web-tests/terminal-font-zoom-*/`；不替代 WebView2 中的真实滚轮手感与 Claude／OpenCode 验收。

终端「编辑长文本」浮动面板复用同一页面与 `pnpm dev:web-test`（端口 **38419**），运行 `scripts/web-tests/terminal-composer.ego.mjs` 的 `run()`。覆盖无遮罩／无模糊的非模态打开、默认高度约 70% 视口、焦点在终端时 Escape 发给终端不关闭面板、拖动标题栏移动并持久化、面板内 Escape 关闭后重开保留位置与草稿、双击标题栏复位居中。产物位于 `.dev/web-tests/terminal-composer-*/`；不替代 Tauri 原生拖放附件与真实 Claude／OpenCode 验收。

终端「清除终端输入」：Linux 启动 `pnpm dev:web-test`（端口 **38419**）后运行 `node scripts/web-tests/terminal-clear-input.agent-browser.mjs`。复用真实终端组件和 Store，检查 POSIX／Windows Shell 与 AI 输入模式的按键序列、实际 Shell 优先、保留输出和长文本草稿、恢复终端焦点，以及菜单打开后退出／重连／等待 PTY／其他设备接管时拒绝写入。截图和 JSON 在 `.dev/web-tests/terminal-clear-input/`，含英文浅色窄窗；内存传输验证不能替代真实 PTY、SSH 和前台程序的按键行为验收。

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
多个远程任务共用一张可展开的进度卡，通知与传输各自独立展示。覆盖按连接选择、单项取消、失败定位和全部转入后台，
并在 420px 英文浅色窄窗中验证九项任务的列表滚动与末项操作。
结果与截图位于 `.dev/web-tests/server-operation/`。该场景不连接 SSH，不替代 Linux/macOS 原生生命周期验收。


退出应用场景位于 `/web-tests/app-close.html`，执行 `node scripts/web-tests/app-close.agent-browser.mjs`。
复用真实退出决策与 `ChoiceDialog`，只替换窗口、文件保存和终端接口；覆盖保留、结束、未确认后的重试/仍然退出、取消文件确认、Escape、仅本地终端以及英文浅色 480px 布局。
截图与结果保存在 `.dev/web-tests/app-close/`。页面不建立远程连接，不能替代原生退出和真实远程终端验收。


界面交互优化回归使用 `node scripts/web-tests/ui-interactions.agent-browser.mjs`。
同时启动 `pnpm dev:web-test`（38419）和 `pnpm test:web`（38439）；Linux 使用独立 headed agent-browser 会话，需要可用的显示环境。
脚本在新的内存会话中添加项目，验证保存失败保留文件、保存后关闭、运行配置与远程连接的离开保护、
设置键搜索与空结果、当前项目分类、分屏无横向溢出、菜单键盘及焦点返回，以及三种主题和英文窄窗的项目行操作。
结果、浏览器异常、PNG 截图与 HTML 报告在 `.dev/web-tests/ui-interactions/`；不建立真实远程连接或执行项目命令。

设置分类验收运行 `node scripts/web-tests/settings-categories.agent-browser.mjs`，使用
`pnpm dev:web-test`（38419）和独立 Linux agent-browser 会话。复用真实设置页与内存后端，
覆盖单分类显示、跨分类搜索、配置键和自定义快捷键搜索、用户/当前项目范围切换、
空结果与焦点恢复、终端配置快捷跳转、窄窗大字号及英文浅色界面，
以及「管理设置」中的用户 JSON 和项目默认模板入口。仅在测试会话内模拟 Windows 来源与移动状态；
不验证真实文件、Windows 原生缩放、SSH 或手机连接。
截图、JSON 与 HTML 报告位于 `.dev/web-tests/settings-categories/`。

AI 编程按键专项：运行 `node scripts/web-tests/mobile-ai-keys.agent-browser.mjs`，验证两排六列、单行输入候选、明确的手机草稿与实时输入目标、中文与 emoji 退格、选区删除、换行、删词、删至行首、只清空本地、键盘收起后远端删除、保留另一份草稿、Tab / Shift+Tab 的原始序列、长按松手停止和跨会话取消。覆盖 320px / 390px、软键盘高度和横屏，截图与业务结果位于 `.dev/web-tests/mobile-ai-keys/`。内存桥只证明输入序列与页面行为，真实 Claude / OpenCode 的候选、定制快捷键及手机 IME 仍需真机与 PTY 验收。

安卓中英文界面：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-i18n.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`；窗口不渲染时改用 `node scripts/web-tests/headless-task-space.mjs <脚本绝对路径>`）。以 `?lang=en` 打开 `/mobile-android/`，检查首页、连接页语言选择、配对弹窗与电脑端错误翻译、项目列表、终端、设置/按键/菜单/快捷键栏弹层和会话侧栏不残留中文界面文案，并验证切回中文后重新加载。测试桥未保存语言偏好时固定中文，现有中文断言不受系统语言影响。截图与 JSON 位于 `.dev/web-tests/mobile-i18n/`；词典覆盖由 `mobileAndroidI18n.test.ts` 检查，不替代 Android 真机系统语言验收。

安卓下拉选项：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-select.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖 6 个下拉不再露出系统控件、窄屏贴底与横屏居中的选择面板、当前项标记、选中后保存、返回键与遮罩取消、程序赋值和语言切换时的显示同步。

安卓界面精简：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-ui-polish.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`；截图超时用 `node scripts/web-tests/headless-task-space.mjs <脚本绝对路径>`）。覆盖项目按主机分组与搜索展开、方向键和退格 SVG 居中、390px 七个常用键可见、状态浮层不改变终端行列、收起按键后展开按钮的位置、经 CDP 触摸的左滑关闭与点行面收起、弹层焦点落在标题不弹键盘、开关整行可点并写回设置，以及项目行左滑复制显示路径、下拉刷新浮标不推动列表并显示结果。截图与 JSON 位于 `.dev/web-tests/mobile-ui-polish/`；使用内存桥，不替代 Android 真机的滑动手感与软键盘验收。

安卓设置页：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-settings.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`）。覆盖顶栏入口、通用设置归位、就地切换语言、返回键层级、偏好重载后保留、从终端设置进入不打断会话，以及 320px 窄屏和横屏布局；截图与 JSON 位于 `.dev/web-tests/mobile-settings/`，使用内存桥，不替代 Android 真机验收。

安卓在线更新：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-update.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`；无桌面时用 `node scripts/web-tests/headless-task-space.mjs <脚本绝对路径>`）。覆盖启动后台检查一次、beta 手机收到最新带 APK 的 beta（跳过无 APK 的更新版本）、下载进度、首次安装跳转系统授权与系统确认、取消下载、首页提示卡片与跳过此版本、正式版忽略 beta、检查失败提示与关闭自动检查，以及英文界面。测试桥支持 `?appVersion=<版本>&appCode=<versionCode>` 模拟已安装版本。截图与 JSON 位于 `.dev/web-tests/mobile-update/`；使用内存桥，真实下载、签名校验和系统安装器需真机验收，地址白名单由 `pnpm test:android-native`（需 JDK）中的 `UpdatePolicyTest` 覆盖。

安卓终端鼠标模式：Windows/macOS 运行 `ego-browser nodejs -e "await import('file:///D:/Code/QingCode/scripts/web-tests/mobile-mouse-mode.ego.mjs').then(m=>m.run())"`（先启动 `pnpm test:web`；无桌面时用 `node scripts/web-tests/headless-task-space.mjs <脚本绝对路径>`）。覆盖内置符号字体加载、加粗滑块、短按不误入、长按进入虚拟鼠标模式、点终端只定位指针、左右键选词/菜单/剪贴板、返回键先关选区再退出、全屏程序左右键 SGR 点击和长按左键拖动，以及离开终端清理。菜单动画结束后使用 CDP 指针事件，在模拟视口内按实际命中坐标操作；仍运行同一 Ego 空间、真实 xterm 与内存桥。测试服务忽略 `coverage/`，避免并行生成覆盖率报告触发页面重载。截图与 JSON 位于 `.dev/web-tests/mobile-mouse-mode/`；不能替代 Android 真机触摸手感验收。

终端管理分页与批量关闭：同一服务的 `/web-tests/terminal-manager.html` 复用真实 `TerminalManager`、确认框与生产样式，65 个终端仅在内存中模拟，不结束真实进程。Windows/macOS 运行 `scripts/web-tests/terminal-manager.ego.mjs` 的 `run()`，覆盖 30 条分页、跨页全选、取消无副作用、部分失败保留选择及重试、筛选关闭不影响隐藏条目，以及英文浅色窄窗大字号布局；截图和 JSON 位于 `.dev/web-tests/terminal-manager/`。组件单测另行覆盖手机/远端部分失败、已接回远端终端防误杀和异步刷新乱序；这些模拟不能替代真实本机/WSL/SSH 进程验收。

终端粘贴清理设置：启动 `pnpm test:web` 后运行
`node scripts/web-tests/terminal-paste-cleanup.agent-browser.mjs`。
页面 `/web-tests/terminal-paste-cleanup.html` 复用真实终端设置分区、设置读写 hook 和确认弹窗，
覆盖默认关闭、7/15/30 天选项、保存后重新打开、工作区继承与关闭、取消清理、
本机/WSL/SSH 命令路由及英文窄屏浅色布局。截图与结果位于
`.dev/web-tests/terminal-paste-cleanup/`。文件操作使用内存 IPC，不能代替原生或真实 SSH 验收。

Windows Shell 预热设置：启动 `pnpm test:web` 后运行 `node scripts/web-tests/shell-prewarm.agent-browser.mjs`，页面为 `/web-tests/shell-prewarm.html`。复用真实终端设置组件，覆盖默认自动、1–8 选项、关闭、JSON5 保存与重新打开、工作区只读、Linux 隐藏和英文浅色窄窗；截图和 JSON 在 `.dev/web-tests/shell-prewarm/`。该页面模拟 Windows UI 平台和设置文件，不执行 Shell，原生池和 Windows ConPTY 仍需 Rust/桌面验收。
