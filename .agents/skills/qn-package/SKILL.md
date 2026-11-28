---
name: qn-package
description: 为当前 QingCode Next 项目构建 beta（BT）或正式版。用于打包、出包、打 BT、打正式版以及 Windows 安装包或 Android APK 请求。默认构建两个平台并把校验过的产物取回本机。
---

# QingCode Next 打包

在当前仓库根目录运行 `python scripts/qn-package.py`。默认构建同版本的 Windows x64 NSIS 安装包和 Android APK，Windows 只出安装包。使用现有的 `windows-91295` 构建机及其已准备的工具链，沿用归档版本递增 beta 序号。取回并验证 SHA-256 后，将产物和 `SHA256SUMS-<版本>.txt` 直接放入仓库根的 `release/`。按产物时间保留最近两个版本。

- 打包请求只指定「all」或「BT」，或省略目标和渠道时，使用默认命令。只有用户明确要求「正式版」或 `stable` 时才加 `--stable`。
- 单独打 Windows 或 Android 时分别追加 `desktop` 或 `android`。用户指定基础版本时加 `--base-version X.Y.Z`。用户明确要求产物留在构建机时才加 `--remote-only`。
- 打包源为当前 Git 提交。用户要求把未提交代码也打入时，先确认其提交授权。打包本身使用 `--publish never`。提交、推送源代码或发布产物分别按用户授权处理。
- 监控任务直到所选目标完成。传输中断时从日志中的 `dl:qn-package-…` 取回同一份产物，按构建机的 `SHA256SUMS` 校验后将产物和按版本命名的校验清单放入 `release/`。运行 `node apps/desktop/build/release-retention.mjs` 清理旧版本。交付时给出版本、源提交和产物的可点击文件链接。缺依赖时报告具体名称。

后续修改此技能时，以本目录为源，通过 `cs-skills-deploy` 的 `--project <仓库根目录>` 同步到 Codex、Cursor 和 Claude 项目目录。
