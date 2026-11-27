# T7 打包与安装验收

范围：`apps/desktop/electron-builder.yml`、`apps/desktop/build/**`（图标等）、`scripts/package-*.{sh,ps1,mjs}`、`README.md`。

1. `pnpm package` 产出 `apps/desktop/release/QingCode Next Setup <ver>.exe`（NSIS x64，当前用户安装）与 `win-unpacked/`。electron-builder 需要的额外二进制（nsis、winCodeSign 等）本机下载不稳定：若构建时报下载失败，在报告里列出确切 URL 与缓存目标路径（`%LOCALAPPDATA%\electron-builder\Cache\...`），由总管经 10.87 中转放入缓存后重试；不要自己反复重试下载。
2. 确认安装包内含 `resources/server/qn-server.cjs`、`qn-server.json`，ssh2 可加载（可选原生模块缺失不影响）。
3. `win-unpacked\QingCode Next.exe --smoke` 退出码 0。
4. 写 `README.md`：项目简介、目录结构、开发命令（`pnpm dev` / `pnpm check` / `pnpm package`）、依赖安装经 10.87 的说明（`scripts/deps-via-1087.sh`）、MVP 范围。

## 交付（总管）

全部完成后：安装包 `QingCode Next Setup <ver>.exe` 与便携目录压缩包（`win-unpacked` → zip）经 `agent-cli-x put windows-91295 <file> dl:` 放到 10.87 的 `D:\Download`，并附 SHA256。
