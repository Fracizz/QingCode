# 本地并行打包 CLI

在仓库根目录用 `pnpm package:local` 本地打包。默认只生成带版本号的 Windows x64 NSIS 安装版，例如 `release/QingCode_0.1.15-beta.3-setup.exe`，也不会生成 `QingCode-setup.exe` 别名。默认不构建便携版、Server 离线包或 Android APK。需要完整产物时显式使用 `--only all`。脚本不提交、不推送、不创建标签、不上传或发布 Release。

```powershell
pnpm package:local --plan                         # 预览安装版依赖和命令，不执行
pnpm package:local                                # 仅带版本号的安装版，前台执行，默认最多 3 个并行阶段
pnpm package:local --jobs 2                       # 限制并发阶段数（1–8）
pnpm package:local --only all                     # 安装包、便携版、Server 和按需更新的 APK
pnpm package:local --only desktop                 # 安装包、便携版和配套 Server
pnpm package:local --only exe                     # 仅便携版及其准备阶段
pnpm package:local --only installer               # 显式指定默认的安装版流程
pnpm package:local --only server                  # 仅 Server 和离线 zip
pnpm package:local --only apk                     # 仅检查/构建 APK
pnpm package:local --skip-frontend --skip-icons --skip-server
```

安装版流程只准备前端、图标并构建 NSIS 安装器，不检查 Server，也不复制便携版。`--skip-server` 仅影响会包含 Server 的 `all`、`desktop` 或 `exe` 流程，并将改为校验现有 Server 的版本、摘要并刷新离线包；不会盲用旧版本。跳过前端或图标时须已有对应产物。原有 `pnpm package`、`package:exe` 和 `package:installer` 保留兼容；它们直接执行单个桌面打包流程，可加 `-SkipAndroid` 禁止顺带检查 APK。

## 后台、状态与取消

```powershell
pnpm package:local start --jobs 3                 # 返回 run-id，隐藏窗口后台执行
pnpm package:local status <run-id>                # 输出 JSON 状态和各阶段日志路径
pnpm package:local cancel <run-id>                # 取消整个任务
pnpm package:local cancel <run-id> --task apk     # 仅取消 APK；桌面流程继续
```

前台也可按 **Ctrl+C**。取消会终止对应阶段的整个子进程树，包括 Cargo/rustc、Java 等子进程；取消准备阶段时，其依赖阶段也会取消。任一阶段失败则停止其他阶段，保留日志并返回非零退出码。整个任务被取消返回 130。

每次任务的 `status.json`、`runner.log`（后台模式）和各阶段 `.log` 都在 `.dev/package-runs/<run-id>/`。状态有 `queued`、`running`、`succeeded`、`failed` 和 `cancelled`。同一工作区一次只允许一个统一打包任务，避免多个任务同时覆盖 `dist/`、Cargo 输出和 `release/`；不要同时运行旧的单包脚本。若操作系统强杀 runner 导致遗留 `active.lock`，先确认其中 PID 和相关构建进程已退出，再移除该锁并重新运行。

## 并行边界和 APK 缓存

默认安装版中前端与图标准备可并行，随后完成嵌入检查和 NSIS 构建。完整流程中 Server 可参与并行准备，APK 等待图标准备后独立执行。便携版等待三项准备完成，安装包随后运行，避免两个 Cargo 构建争抢同一输出目录。Server 只构建一次，前端只构建一次；既有 Cargo 缓存继续复用。

APK 比较 Android 源码、构建脚本、图标、实际内置 JS/CSS/许可证和签名身份的 SHA-256；仅桌面代码或应用版本号变化时复用上次 APK，保留其原版本。有输入变化或上次 APK 缺失/损坏才重新构建。缓存写在 `.dev/android-build/package-state.json`，不提交入库。

Android 工具链和本地签名沿用 [Android 构建说明](../mobile/README.md)。默认发现 `ANDROID_HOME` / `JAVA_HOME`，也兼容本项目已有的 `.dev/android-build/sdk`；缺少工具链会在 APK 日志提示跳过，不阻断桌面产物。状态 `succeeded` 表示阶段脚本成功执行；APK 是否重新构建或因无更新/缺工具而跳过，以 `apk.log` 为准。本地包使用既有开发签名，不能作为固定发布签名包上传。

统一 CLI 默认只在 `release/` 生成：

- `QingCode_<版本>-setup.exe`：带版本号的安装包，当前版本为 `QingCode_0.1.15-beta.3-setup.exe`。

显式完整打包或其他兼容命令还可能生成：

- `QingCode_<版本>.exe`：便携版。
- `QingCode-setup.exe`：无版本号的安装包别名。
- `QingCode-servers.zip` 与 `servers/`：Server 离线包。
- `QingCode_<APK版本>-android.apk` 与 `QingCode-Android.apk`：最近一次本地 APK。

取消后已完成的产物会保留；未完成阶段的旧文件不能视为本次成功产物，以任务状态和日志为准。
