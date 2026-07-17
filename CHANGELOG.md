# Changelog

本文件记录 QingCode 的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/Fracizz/QingCode/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.1
[0.1.0]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.0
