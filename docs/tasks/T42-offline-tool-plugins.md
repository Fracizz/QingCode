# T42 离线工具插件

桌面设置提供插件管理，首个插件为 ripgrep。范围包括桌面设置、后端导入与部署、目标机 `qn-server` 和独立打包脚本。手机继续使用项目文件接口。

- 从本地选择 `.qnplugin`，校验格式、平台和 SHA-256 后缓存。导入只读取数据。安装前显示版本和信任提示。
- 本机与 SSH 目标按实际平台安装、替换和移除托管版本。SSH 加速连接经现有 SSH 管理通道写入。纯直连可查状态，由主机管理员管理安装。
- `fs.search` 优先使用目标机 `PATH` 中可运行的 `rg`，其次用托管版本，再走 Node 兜底。安装自检通过才切换，现有搜索无需重启 daemon。
- 使用已验来源的可执行文件和对应许可证独立生成包及校验文件。产物可作为 QingCode 发版的独立附件，插件自身沿用上游 `rg` 版本号。

验收覆盖离线导入、损坏包、平台不匹配、PATH 优先、安装失败保留旧版、移除后回落、直连权限和打包往返。Windows、Linux 和 macOS 包分别由对应目标运行自检。

## 制作发布附件

先核对官方发布包的来源和校验，再准备解包后的 `rg` 或 `rg.exe` 及许可证。以下命令只读本地文件，每个平台执行一次。

```bash
node --experimental-strip-types scripts/package-rg-plugin.mjs \
  --version 16.0.0 --platform linux-x64 --binary /path/to/rg \
  --license /path/to/LICENSE-MIT --license /path/to/UNLICENSE \
  --release 0.0.3-beta.7
```

平台值为 `win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64`、`darwin-x64` 和 `darwin-arm64`。Linux 可优先准备 musl 构建。把 `release/plugins/<QingCode 版本>/` 下的 `.qnplugin` 和 `.sha256` 一起附到对应的 `next-v<版本>` Release。插件包名记录上游版本和平台，同一包可以供支持格式版本 1 的 QingCode 版本复用。发布校验文件验证整个下载包，导入校验验证包内的二进制。安装会以目标 daemon 的权限运行二进制自检，应使用可信来源的包。

桌面入口为**设置 → 插件**。导入后可在不同目标复用本机缓存。每个平台保留最近导入的一个包，导入其他版本可替换缓存。选择目标再安装或移除，清除本机缓存不会改变已安装的目标。纯直连目标可由管理员在主机 `PATH` 上安装 `rg`，也可用具有 SSH 管理权限的桌面连接安装托管版。
