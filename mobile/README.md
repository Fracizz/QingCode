# QingCode Android

Android 端通过局域网连接 Windows QingCode，按本机、WSL、远端分类显示桌面上已信任的项目。打开项目时复用手机创建的会话，或在项目目录启动真实 Shell。Windows 承担 SSH、Server 连接和凭据管理。

## 配对和使用

1. 启动带移动连接功能的 Windows QingCode，在「设置 → 功能 → Android 移动连接」选定手机可达的 Windows 网卡 IPv4，启用并生成验证码。
2. 将完整的 `QC1:` 验证码通过私下渠道复制到 Android。验证码包含连接地址、TLS 证书指纹和随机密钥，有效期 5 分钟且只能使用一次。桌面每次启用只配对一台设备。
3. 在 Android 选择项目所在环境，点开项目。右上角可新建、切换和结束终端。若列表缺少项目，在桌面添加并信任后刷新。
4. 手机短暂离线、切换项目或重开 App 时，Windows QingCode 继续托管手机会话。Android 按输出序号接回，并重放 Windows 缓存中仍保留的输出。Windows 端点击「停止连接」会撤销配对并请求结束手机创建的会话。

端口为 TCP `48764`。如果 Windows 防火墙阻止连接，在本机防火墙仅允许所需局域网来源访问该端口。Windows 须保持在线，WSL 项目须存在对应的发行版，远端项目须能通过桌面已有的 SSH 或 Server 连接打开。工作区信任控制从哪里启动 Shell，Shell 使用其宿主账号的权限。

## 构建 APK

需要 Node 和仓库前端依赖、JDK 17、Android SDK Platform 35 和 Build Tools 35。在仓库根目录运行：

```powershell
pnpm.cmd install --frozen-lockfile
pwsh -NoProfile -File scripts/build-android.ps1 -SdkPlatform 'C:\Android\Sdk\platforms\android-35' -BuildTools 'C:\Android\Sdk\build-tools\35.0.1' -Jdk 'C:\Java\jdk-17'
```

输出为 `release/QingCode-Android.apk`，使用本地开发证书签名。系统需为 Android 8.0 或以上，并使用支持当前 xterm.js 的 Android System WebView。Windows 配套版可用现有 `pnpm package:exe` 流程构建。
