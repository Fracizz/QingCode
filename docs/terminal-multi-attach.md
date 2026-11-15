# 终端多端共享（多端同时查看、同时输入）

电脑、平板、手机可以同时查看并同时输入同一个终端。手机经电脑中转（移动连接 Hub），本地终端与远程终端规则相同。设计参考 [herdr](https://github.com/herdrdev/herdr) / herdr-core 的会话共享模型，只借鉴终端托管与分发这一层，不照搬服务端托管布局与渲染，也不照搬它「没有应用层认证」的安全模型。

## 规则

| 项目 | 规则 | 实现 |
|---|---|---|
| 输入 | 所有接入端默认可写；一条输入整体写入，按终端串行 | `Sharing::input`，`MobileState::lock_control` |
| 只读旁观 | 设备可选 `observe`，旁观者不能输入、不抢尺寸 | `attach{observe}` |
| 独占 | 任一端可独占，独占期间其他端只读；电脑可解除；旧版手机「接管」抢下独占 | `set_exclusive`，`claim(take)` |
| 尺寸 | 跟随最后一次**键盘输入**的一方；焦点、滚动、自动应答不算 | `Sharing::claim_size` |
| 断开其他端 | 电脑让所有设备退出该终端，收回设备的独占与尺寸；设备轮询得到 `kicked`（同时带 `takenOver` 兼容旧版）后回到工作台并提示，重新 `attach` 即恢复；保留配对 | `kick_devices`，`Sharing::kicked` |
| 锁定尺寸 | 锁定后打字不切换；「按本端尺寸」显式改成本端 | `set_size_lock`，`take_size` |
| 尺寸交还 | 尺寸方离开（设备 10 秒无轮询）且未锁定时交给电脑，其次最近活跃的可写设备 | `Sharing::hand_over_size`，每秒巡检 |
| 自动应答 | 光标位置、设备属性、颜色、焦点等应答只转发尺寸方那份；尺寸方不在线时放行其他端 | `mobile/reply.rs` |
| 在线状态 | 谁在看（角色）、谁正在输入（3 秒）、尺寸方、锁定、独占、最近输入 | `presence`，`terminal-control` 事件带递增 `rev` |
| 输入来源 | 每个终端保留最近 64 条来源记录（谁、何时、字节数、是否自动应答），不含内容 | `mobile_terminal_input_log` |
| CLI / AI 写入 | `terminal send` 先等人停止输入 3 秒；电脑上有未提交草稿时最多再等 60 秒 | `src/lib/terminal/terminalInputGate.ts` |

各端各自的展示状态（滚动位置、历史翻页、「待查看」标记、字号）保留在本端；Hub 只保存共享事实。

### 自动应答的已知歧义

`ESC [ 1 ; <2..16> R` 既是光标位置应答，也是 xterm 编码的带修饰键 F3。这里按应答处理，代价是非尺寸方按 Shift/Ctrl+F3 会被丢弃。整段输入只要夹带一个按键，就按人工输入处理。

## 数据流

- **电脑终端 → 手机**：开启「允许手机接入电脑上开的终端」后，`TerminalManager` 的输出线程、持久终端（SSH Server / 本机托管）的 `emit_data` / `emit_screen`、SSH 兼容模式的 `emit_direct_terminal_data` 都把同一份 base64 交给 `Hub::tap_output`。镜像从终端启动（`tap_open`）或整屏快照（`tap_screen`）起记录，画面完整；开启前已有输出的终端，首次接入时由电脑前端补一次当前画面。数据流不再经过电脑前端，窗口重载不影响手机。
- **电脑前端**：被设备独占时 xterm 只读；其他端是尺寸方时网格跟随对方，并按字号把对方整屏铺满窗口（手机窄网格放大、平板宽网格放进窄窗格时缩小，6–40px，见 `terminalFollowFit.ts`）；窗口变化只把电脑自己的行列（按设置字号计算）报给后端记下，电脑打字成为尺寸方时用，随后恢复设置字号。`TerminalControlNotice` 是叠在终端右上角的小角标（👁 + 谁在看 / 谁在输入 / 跟随谁的尺寸 / 已独占），不占终端高度，设备加入或离开时终端不重排；悬停显示完整说明，点开菜单提供「按电脑尺寸 / 锁定尺寸 / 独占 / 解除独占 / 断开其他端」。安卓端同理，短标签挂在标题副行，点开底部面板操作。
- **Android**：可写但跟随其他端尺寸时，按对方网格缩放显示、键盘照常可用，并把本机按窗口算出的行列报给电脑；标题栏副行末尾的共享标签显示简短状态（谁在看 / 谁在输入 / 跟随谁的尺寸 / 已独占），不占终端高度；点开弹层查看完整说明并操作「改用本机尺寸 / 独占 / 改为只读旁观」，「…」菜单也有入口。

## daemon（qingcode-server）改动

- 屏幕快照以 CAN（0x18）开头，接收端丢弃停在半截的转义序列。
- 快照本来就还原备用屏、括号粘贴、鼠标与键盘模式（已有测试覆盖）。
- 接回时待补发输出超过 1 MiB 直接给屏幕快照，不再逐段补发积压（herdr 的「落后过多直接重绘」）。
- `pty.input` / `pty.resize` / `pty.kill` 校验终端所有者：同一台 daemon 的 token 可能被多个客户端共享，不能只靠连接鉴权。

## 评估后暂不实施

| 项目 | 结论 | 原因 |
|---|---|---|
| daemon 多订阅者（多台电脑同时接同一远程 PTY） | 暂不做 | 已确定手机经电脑中转；电脑始终是远程 PTY 的唯一连接者。需要时在 daemon 增加按连接的订阅表、按客户端的输入序号与跨安装授权，并以 `pty.multiAttach` 能力协商 |
| 手机推送通道（WebSocket） | 暂不做 | 长轮询在有输出时立即唤醒（另合并 24ms），延迟已接近推送；手机 TLS 证书固定在原生层，WebSocket 需原生 Java 实现，本机无 Android 工具链无法编译验证 |
| 屏幕解析换 libghostty-vt | 不换 | vt100 已满足快照还原；替换涉及 Zig 工具链与跨平台构建，收益有限 |
| PTY 持有进程与 daemon 分离（升级不中断） | 暂不做 | 需要新增常驻持有进程与 PTY 句柄移交（Windows ConPTY 句柄跨进程继承），改动面大；现有做法是升级前提示有活跃终端 |
| 每个慢连接单独降级 | 已部分满足 | 每个终端单独占一条 daemon 连接，溢出只影响它自己；重连时积压过大直接给快照 |

## 验证

- Rust：`cargo test --lib mobile::`（共享规则、自动应答识别、镜像分发、尺寸交还）、`cargo test -p qingcode-server`。
- 前端：`TerminalControlNotice.component.test.tsx`、`mobileBridge.test.ts`、`terminalInputGate.test.ts`、`mobileAndroidShare.test.ts`。
- 真机：Windows 测试机 252.45 上的远程终端，电脑与模拟手机同时输入（见下方记录）。

### 真机记录（2026-11-14，252.45 Windows，直连网关传输）

`QC_STAB_PHASES=share,func,ctrlc,flood,tui,multi cargo test --lib real_host_stability -- --ignored --nocapture`，server 用本分支编译并按 sha256 重新部署。

| 阶段 | 结果 |
|---|---|
| share | 通过：同一 token 的其他客户端 `pty.resize/kill/input` 均返回 `forbidden`，终端仍可用；手机 60x25 → 电脑 120x40 → 手机 60x25 打字后真实 PTY 尺寸逐次切换；非尺寸方光标位置应答被丢弃；断开期间约 1.3 MB 输出，接回给 991 字节快照（CAN 开头），补发 0 字节 |
| func / ctrlc / flood / multi | 通过（flood 序号缺口 0；multi 27/27 任务成功） |
| reattach | 不适用：45 走直连网关，该阶段要求 SSH 传输 |
| tui | 未通过：写入 `qc-tui.ps1` 时报「读取文件需要已注册项目根」，属文件写入路径，与本分支改动无关 |
