# Changelog

本文件记录 QingCode 的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- GitHub Release 工作流：推送 `v*` 标签后自动构建 Windows 单文件 exe 并上传
- Gitee Release 同步：配置 `GITEE_TOKEN` 后同一份 exe 自动上传到 Gitee Releases
- 版本同步脚本 `pnpm bump:version` 与发版标签脚本 `pnpm release:tag`
- 中英双语 README

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

[Unreleased]: https://github.com/Fracizz/QingCode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.0
