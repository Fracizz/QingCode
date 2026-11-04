# QingCode Android

## APK 按需发布

本地 `pnpm package:exe` / `pnpm package:installer` 会检查 Android 输入文件和已生成 APK 的摘要。
有更新或 APK 缺失/损坏时构建 `release/QingCode_<版本>-android.apk`，并更新 `QingCode-Android.apk`；
无更新时保留原 APK 的版本和文件。仅桌面版本号变化不触发 APK 构建。
需要 `ANDROID_HOME` / `JAVA_HOME`，也支持本项目现有 `.dev/android-build/sdk` 工具目录；
缺少工具链时提示跳过。签名沿用已有本地密钥；缓存保存在 `.dev/android-build/package-state.json`。

Release 工作流以最近一个实际包含 APK 的公开发布版本（含预发布）为比较基准。
Android 源码、构建/版本脚本、打包图标、依赖锁文件或 APK 内置依赖声明变化时才重新打包；
仅桌面端或应用版本号变化时跳过 APK，继续使用最近发布的 Android APK。
首次发布会尝试构建；仍须配置固定发布签名密钥，缺少密钥时跳过 APK，不阻断桌面端发布。

Android 端是终端优先的远程控制器。手机可保存多台能通过局域网访问的 Windows QingCode，在「连接」中切换、重连、重命名、修改端口、重新配对或移除。每台电脑分别提供本机、WSL 和远端已信任项目，Windows 负责 SSH、Server 连接和凭据管理。

## 配对和使用

1. 在 Windows QingCode 的「设置 → 功能 → Android 移动连接」填写端口和自定义 6–20 位密码，再保存并启用。Windows 自动监听局域网 IPv4 连接（含 Tailscale 等 `100.64.0.0/10` 地址）。密码可使用纯数字、纯字母或符号，无需组合，区分大小写；默认记住，可在电脑端显示或隐藏。启用后设置页显示配对二维码；电脑有多块网卡时可切换二维码使用的地址。
2. 在 Android 的「连接」中点「添加」，选择「扫码添加」扫描电脑上的二维码，或「粘贴配对链接」粘贴电脑端「复制配对链接」得到的 `qingcode://pair?...`。系统相机或其他扫码应用打开该链接时也会直接进入配对。二维码包含地址、端口和证书指纹，手机连接时自动核对指纹，不一致会停止配对；之后只需输入密码。也可以手动填写 IPv4 和端口，此时需逐位核对电脑端显示的 SHA-256 指纹。旧版单台电脑的配对会在升级后自动导入。
3. 从「终端」继续最近使用的项目，或在「项目」中搜索、筛选并打开一个项目。终端顶部可新建和切换会话，右上角菜单可结束会话。若列表缺少项目，在桌面添加并信任后刷新。
4. 底部命令栏支持中文输入和粘贴，点击发送后执行。键盘按钮切换到逐键输入，适合交互式 CLI。快捷键栏可横向滑动，提供 Esc、Tab、一次性 Ctrl / Alt、方向键、Home、End、PgUp 和 PgDn。Ctrl 可组合字母及 `@ [ \ ] ^ _ ?`，Alt 以 ESC 前缀发送，也可与方向键组合。
5. 手机短暂离线、切换主机或重开 App 时，Windows QingCode 继续托管会话。Android 按输出序号接回，重放 Windows 缓存中仍保留的输出；Server 模式远端终端接回时下发的屏幕快照会直接重绘当前屏幕。

## 配对的保存与撤销

- 配对长期有效。Windows 只保存令牌的 SHA-256 摘要，启用状态会被记住：重启电脑端 QingCode 后自动恢复监听，已配对的手机无需重新输入密码。自动启用失败（如端口被占用）时，设置页显示原因。
- 最多同时配对 8 台设备。设置页列出已配对的手机及在线状态，点「移除」即撤销该手机的授权，并结束它创建的终端。
- 「停止连接」关闭监听、结束所有手机终端，并在下次启动时保持关闭；已配对的手机会保留，重新启用后可直接连接。退出 QingCode 同样会结束手机终端，但不改变自动启用设置。
- 从手机移除连接只删除手机上的配对。需要撤销电脑端授权时，在 Windows 设置页移除该设备。
- 默认 TCP 端口为 `48764`，可自定义。密码长期有效，关闭连接或重启电脑端后自动填回，重新启用时留空也可沿用；旧版只保存校验值的密码继续有效，重新设置一次后才可显示。密码与证书私钥一起保存在仅当前用户可读的设置文件中，不会写进二维码或配对链接。更换密码需先停止连接；更换密码不影响已配对的手机。每个来源连续输错 5 次后须等待一分钟，全部来源合计每分钟最多尝试 20 次。

启用后可直接切换端口。新端口成功启用后旧端口停止监听；已配对的手机和正在运行的手机终端都会保留。在手机的「连接详情」中把端口改为新端口即可，无需重新配对，也可以重新扫码。若新端口被占用，原连接继续使用旧端口。Windows 防火墙中手动创建的规则由用户管理。

如果 Windows 防火墙阻止连接，在本机防火墙仅允许所需局域网来源访问所选端口。Windows 须保持在线，WSL 项目须存在对应的发行版，远端项目须能通过桌面已有的 SSH 或 Server 连接打开。打开远端项目时若电脑上弹出确认（如主机指纹），请在电脑上处理，手机最多等待 90 秒。工作区信任控制从哪里启动 Shell，Shell 使用其宿主账号的权限。

手机与电脑之间使用 HTTPS 长连接复用（空闲 10 秒内复用，电脑端 15 秒关闭空闲连接）；读取类请求遇到失效的复用连接会自动重试一次，输入、建终端等写操作不会自动重发。手机创建的终端输出只进入移动端缓冲，不广播给桌面窗口。

## 构建 APK

需要 Node 和仓库前端依赖、JDK 17、Android SDK Platform 35 和 Build Tools 35.x。在仓库根目录运行：

```powershell
pnpm.cmd install --frozen-lockfile
pwsh -NoProfile -File scripts/build-android.ps1 -SdkPlatform 'C:\Android\Sdk\platforms\android-35' -BuildTools 'C:\Android\Sdk\build-tools\35.0.1' -Jdk 'C:\Java\jdk-17'
```

设置 `ANDROID_HOME` 和 `JAVA_HOME` 后可省略这三个参数。输出为 `release/QingCode-Android.apk`。

- 版本号取自 `package.json`：`versionName` 与桌面一致，`versionCode` 由 `scripts/android-version.mjs` 推导（`major·10⁷ + minor·10⁵ + patch·10³ + 预发布序号`，正式版排在同号预发布之后），保证升级单调递增。
- 本地构建默认使用 Android 标准调试密钥库 `~/.android/debug.keystore`（不存在时自动生成，与 Android Studio 共用）。同一台电脑上的多次构建可以直接覆盖安装；换一台电脑构建的调试包签名不同，需要卸载后安装。
- 发布构建使用 `-Release` 和固定发布密钥库：`-Keystore`（或 `QINGCODE_ANDROID_KEYSTORE`）、`QINGCODE_ANDROID_KEYSTORE_PASSWORD`、`QINGCODE_ANDROID_KEY_ALIAS`，可选 `QINGCODE_ANDROID_KEY_PASSWORD`。口令通过环境变量传给 `apksigner`。
- Release CI 在配置了仓库 Secrets `ANDROID_KEYSTORE_BASE64`（发布密钥库的 base64）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`（可选 `ANDROID_KEY_PASSWORD`）时构建 `QingCode_<版本>-android.apk` 并随 Release 发布、同步到 Gitee；未配置时跳过 APK 并给出警告，其余平台照常发布。密钥库一旦用于发布不可更换，否则已安装的手机无法覆盖升级。

系统需为 Android 8.0 或以上，并使用支持当前 xterm.js 的 Android System WebView。扫码需要相机权限，仅在点「扫码添加」时申请。Windows 配套版可用现有 `pnpm package:exe` 流程构建。

## 测试

- `src/lib/mobileAndroidProtocol.test.ts`：配对链接、输出块、输入拆分、修饰键与按键序列（`mobile/android/web/protocol.js`）。
- `src-tauri/src/mobile.rs`：配对持久化、多设备与撤销、按来源限流、轮询分页与快照、局域网来源。
- Web 验收：`/mobile-android/` 页面加载真实 Android 网页资产，见 [Web 测试页与浏览器验收](../docs/web-ui-testing.md)。该页面不替代真机上的 WebView、相机、深链和网络验收。
