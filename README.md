# QingCode Next

QingCode Next 是用 Electron 和 TypeScript 开发的桌面客户端，通过本地或远程服务连接用户已安装的 Agent。桌面端在 `apps/desktop`，Android 端在 `apps/mobile`，常驻服务在 `packages/server`。

`pnpm dev` 启动桌面开发环境，`pnpm check` 运行类型检查和测试。依赖和 Electron 的离线准备流程见 [scripts/deps-via-1087.sh](scripts/deps-via-1087.sh)。

## Windows x64 打包

在当前 QingCode Next 工作树的仓库根目录运行 `pnpm package`。每次生成一个新的 `X.Y.Z-beta.N` 版本，Beta 序号以 Unix 毫秒时间戳为起点。NSIS 安装包和 `win-unpacked/` 都在仓库根的 `release/<版本>/`。

通过 Windows 构建机同时打包 Windows 安装包和 Android APK 时，运行 `python scripts/qn-package.py`。默认沿用构建机归档中的 beta 版本序列。校验后的安装包、APK 和 `SHA256SUMS-<版本>.txt` 直接放在本机仓库根的 `release/`。明确要打正式版时加 `--stable`。 [项目打包技能](.agents/skills/qn-package/SKILL.md)

两种入口都在成功出包后按产物时间保留本机最近两个版本，并清理更旧版本的产物。

需要正式版时，在本次命令中显式设置 `QINGCODE_PACKAGE_CHANNEL=stable`。下面的命令适用于 PowerShell。

```powershell
cmd /d /c 'set QINGCODE_PACKAGE_CHANNEL=stable&& pnpm package'
```

基础版本默认取自 `apps/desktop/package.json`。单次指定基础版本可设置 `QINGCODE_PACKAGE_BASE_VERSION`，例如以下命令会生成新的 `0.0.2-beta.N` 本地包。

```powershell
cmd /d /c 'set QINGCODE_PACKAGE_BASE_VERSION=0.0.2&& pnpm package --publish never'
```

GitHub 发布配置读取当前工作树的 `origin`，Beta 使用预发行，标签以 `next-v` 开头。
