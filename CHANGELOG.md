# Changelog

本文件记录 QingCode 的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- VS 风格大文件分级编辑：按体积在完整编辑 / 降级编辑 / 纯文本编辑 / 只读查看间切换，降低打开超大文件时的卡顿
- 工作区信任：未信任项目限制高风险能力，降低打开陌生仓库时的安全风险
- 文档格式化：支持 `Shift+Alt+F` 调用 Prettier / rustfmt / shfmt / ruff·black / gofmt（需本机已安装）格式化当前文件
- `editor.formatOnSave`：保存前按上述格式化器自动格式化（失败时不阻断保存）
- `editor.formatOnPaste`：粘贴后自动格式化（安静模式，大文件/不支持语言跳过）
- `editor.bracketPairColorization.enabled` / `editor.guides.bracketPairs`：括号嵌套分色与光标所在括号对参考线
- `files.exclude` / `search.exclude`：资源管理器与文件/内容搜索按设置 JSON 中的排除规则生效
- `terminal.integrated.scrollback`：限制 xterm 缓冲，并跨重启持久化最近输出
- `terminal.integrated.cursorBlinking`：控制终端光标闪烁
- 命令面板、多项目工作区、符号跳转、轻量 Git 状态/与 HEAD 比较等一批能力

### Changed

- 设置 JSON 中尚未接线的预留键（如小地图、formatOnPaste 等）标注为「暂未生效」，避免误以为已生效

## [0.1.3] - 2026-07-17

### Added

- 无当前项目时也可新建终端：自动选用已有项目或创建临时工作区
- 状态栏显示应用版本（开发构建带 `dev` 标记），便于区分正式版与开发版

### Fixed

- 系统字体列表拆分 Windows TTC 多字体注册表名（如「微软雅黑 & 微软雅黑 UI」）
- 编辑器设置中的等宽字体实际应用到 CodeMirror（覆盖 `.cm-scroller`）
- 终端字体/字号随设置更可靠地更新
- 正式版 WebView2 下 OpenCode 等 TUI 方块字/标题重叠乱码（WebGL 自绘字形 + 稳妥等宽字体栈）
- 正式版编辑器正文不可见/错位：CSP 对 `style-src` 注入 nonce 导致 CodeMirror 运行时样式被拦截

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

[Unreleased]: https://github.com/Fracizz/QingCode/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.3
[0.1.2]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.2
[0.1.1]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.1
[0.1.0]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.0
