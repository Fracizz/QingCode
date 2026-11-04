# QingCode Android

Android 端是终端优先的远程控制器。手机可保存多台能通过局域网访问的 Windows QingCode，在「连接」中切换、重连、重命名、重新配对或移除。每台电脑分别提供本机、WSL 和远端已信任项目，Windows 负责 SSH、Server 连接和凭据管理。

## 配对和使用

1. 在 Windows QingCode 的「设置 → 功能 → Android 移动连接」填写手机可达的 Windows 网卡 IPv4、端口和自定义 6 位验证码，再保存并启用。验证码须包含英文字母和数字，可加入符号，区分大小写。
2. 在 Android 的「连接」中添加电脑，填写名称、IP、端口和验证码。首次连接或证书变化时，核对 Windows 显示的 SHA-256 指纹，确认一致后再提交验证码。旧版单台电脑的配对会在升级后自动导入。
3. 从「终端」继续最近使用的项目，或在「项目」中搜索、筛选并打开一个项目。终端顶部可新建和切换会话，右上角菜单可结束会话。若列表缺少项目，在桌面添加并信任后刷新。
4. 底部命令栏支持中文输入和粘贴，点击发送后执行。键盘按钮切换到逐键输入，适合交互式 CLI。快捷键栏提供 Esc、Tab、一次性 Ctrl 和四个方向键。
5. 手机短暂离线、切换主机或重开 App 时，Windows QingCode 继续托管会话。Android 按输出序号接回，重放 Windows 缓存中仍保留的输出。从手机移除连接会删除本地配对。需要撤销授权并结束手机会话时，在 Windows 端点击「停止连接」。

默认 TCP 端口为 `48764`，可自定义。验证码长期有效，关闭连接或重启桌面后重新启用时留空即可沿用。更换验证码需先停止连接。每次启用允许一台设备配对，连续输错 5 次后须等待一分钟。

如果 Windows 防火墙阻止连接，在本机防火墙仅允许所需局域网来源访问所选端口。Windows 须保持在线，WSL 项目须存在对应的发行版，远端项目须能通过桌面已有的 SSH 或 Server 连接打开。工作区信任控制从哪里启动 Shell，Shell 使用其宿主账号的权限。

## 构建 APK

需要 Node 和仓库前端依赖、JDK 17、Android SDK Platform 35 和 Build Tools 35。在仓库根目录运行：

```powershell
pnpm.cmd install --frozen-lockfile
pwsh -NoProfile -File scripts/build-android.ps1 -SdkPlatform 'C:\Android\Sdk\platforms\android-35' -BuildTools 'C:\Android\Sdk\build-tools\35.0.1' -Jdk 'C:\Java\jdk-17'
```

输出为 `release/QingCode-Android.apk`，使用本地开发证书签名。系统需为 Android 8.0 或以上，并使用支持当前 xterm.js 的 Android System WebView。Windows 配套版可用现有 `pnpm package:exe` 流程构建。
