# Changelog

本文件记录 QingCode 的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.4] - 2026-07-17

### Added

- 状态栏显示应用版本（开发构建带 `dev` 标记），便于区分正式版与开发版

## [0.1.3] - 2026-07-17

### Added

- 无当前项目时也可新建终端：自动选用已有项目或创建临时工作区

### Fixed

- 系统字体列表拆分 Windows TTC 多字体注册表名（如「微软雅黑 & 微软雅黑 UI」）
- 编辑器设置中的等宽字体实际应用到 CodeMirror（覆盖 `.cm-scroller`）
- 终端字体/字号随设置更可靠地更新

## [0.1.2] - 2026-07-17

### Added

- 设置中可选择本机已安装的系统字体
- 快捷键设置展示编辑器保留项（含 `Alt+C` 复制文件引用、`Ctrl+Shift+C` 复制路径）

### Fixed

- 启动闪屏与窗口过早显示导致的闪烁；缩短 splash 等待
- 设置页字体下拉把标题挤成竖排一字的问题
- Vite 禁止从 `public/` 用 `?raw` 导入 SVG
- 去掉「常用设置」与「文本编辑器」重复的编辑器字号项

### Changed

- 应用图标图形整体居中，并同步桌面打包图标

## [0.1.1] - 2026-07-17

### Fixed

- 便携版 exe 启动时窗口被建成约 14×14、几乎不可见的问题
- 打包脚本未启用 `custom-protocol`，导致 exe 误连本地 Vite（`ERR_CONNECTION_REFUSED`）
- 退出应用时把空闲终端误报为「仍在运行」
- 退出确认中虚假的「未保存的编辑器更改可能丢失」提示

### Changed

- 全局设置文件改为 `default-settings.json`，工作区改为 `.qingcode/project-settings.json`（JSON5，支持注释与项目列表配置）
- README 改为突出产品描述，去掉发版流程说明

## [0.1.0] - 2026-07-17

### Added

- 多项目管理：标题栏切换、添加/移除/定位项目
- 文件资源管理器：新建、重命名、删除、复制路径与引用
- CodeMirror 编辑器：多标签、未保存标记、常见语言按需加载
- 多终端：按项目保留会话，默认在项目根目录启动
- 文件名与内容搜索
- 项目运行配置
- 主题（深色 / 浅色 / 跟随系统）、字体与字号设置
- 界面语言：简体中文、English
- Windows 单文件 exe 打包（`pnpm package:exe`）
- GitHub / Gitee Release 工作流与版本脚本

[Unreleased]: https://github.com/Fracizz/QingCode/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.4
[0.1.3]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.3
[0.1.2]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.2
[0.1.1]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.1
[0.1.0]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.0
