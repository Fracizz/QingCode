# QingCode

[English](./README.en.md) · [配置帮助](./帮助文档.md)

轻量、原生的桌面代码编辑器。面向需要同时处理多个本地项目的开发者，把项目切换、文件管理、代码编辑和终端工作流集中在一个简洁的 Windows 桌面应用中。

> 当前版本 **0.1.0** · [下载发布包](https://github.com/Fracizz/QingCode/releases) · [更新日志](./CHANGELOG.md)

## 能做什么

### 同时管理多个项目

把常用项目加入标题栏，像切换标签一样在项目间快速切换。项目过多时会自动收纳，仍可随时添加、移除、重新定位，或在文件管理器中打开。

### 浏览和管理本地文件

资源管理器只显示当前项目，减少干扰。你可以直接在文件树中：

- 新建文件或文件夹
- 重命名、删除文件和文件夹
- 复制完整路径或文件引用
- 在指定目录打开终端

### 专注写代码

支持同时打开多个文件，未保存内容会有明确标记，按 `Ctrl+S` 即可保存。编辑器按需支持 JavaScript、TypeScript、JSON、Markdown、CSS、HTML 与 Python 等常见文件类型。

### 在项目中直接使用终端

每个项目都可以保留多个终端标签页，默认从项目根目录启动。切换到其他项目时，已有终端不会被关闭；返回项目后可继续原来的工作。

### 快速找到文件和内容

可以按目录范围搜索文件名或文件内容，适合在项目中定位代码、配置或文本。

### 保存常用运行方式

为项目脚本创建运行配置，一键在终端中启动，减少重复输入命令。

### 按自己的习惯使用

支持深色、浅色和跟随系统主题；界面与代码字体、字号均可调整；界面语言可选简体中文或 English。设置会保存在本机。

## 使用流程

1. 添加一个本地项目目录。
2. 在资源管理器中浏览、创建或编辑文件。
3. 打开终端，在项目根目录执行常用命令。
4. 需要处理其他项目时，直接从标题栏切换，终端和编辑状态会继续保留。

## 下载与安装

优先支持 **Windows 10/11**（x64）。

1. 打开 [Releases](https://github.com/Fracizz/QingCode/releases)。
2. 下载最新的 `QingCode_<version>.exe`（或 `QingCode.exe`）。
3. 双击运行即可，无需安装。

系统需已安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（较新的 Windows 10/11 通常已预装）。

## 适合谁

QingCode 适合希望用轻量桌面工具完成日常代码查看、编辑、文件操作和终端工作的开发者，尤其适合同时维护多个本地项目的场景。

## 开发

### 环境要求

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://www.rust-lang.org/) stable（含 Cargo）
- Windows + WebView2

### 常用命令

```bash
pnpm install          # 安装前端依赖
pnpm tauri:dev        # 启动完整桌面应用（推荐）
pnpm dev              # 仅 Vite 前端，适合布局调试
pnpm build            # TypeScript 检查 + 前端产物
pnpm check            # 前端类型检查 + Rust 格式/测试
pnpm package:exe      # 打 Windows 单文件 exe 到 release/
```

产物路径：

- `release/QingCode_<version>.exe` — 带版本号
- `release/QingCode.exe` — 最新副本

仅改了 Rust、前端未变时可加速打包：

```bash
pnpm package:exe:fast
```

### 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/` | React 前端（组件、Zustand、Tauri 封装） |
| `src-tauri/` | Rust / Tauri 后端与权限配置 |
| `scripts/` | Windows 开发与打包脚本 |
| `帮助文档.md` | 语言包与设置说明 |
| `DESIGN.md` | 界面与交互设计约定 |

## 发版

版本号需同步出现在三处：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

### 本地发版

```powershell
# 1. 同步版本号（示例：升到 0.1.1）
pnpm bump:version 0.1.1

# 2. 更新 CHANGELOG.md，提交变更
git add -A
git commit -m "chore: release v0.1.1"
git push origin master
git push github master   # 若同时维护 GitHub 远程

# 3. 打标签并推送（触发 GitHub Actions 构建与 Release）
git tag v0.1.1
git push github v0.1.1
```

也可一键走完校验、打标签（不会自动 `git push`）：

```powershell
pnpm release:tag 0.1.1
```

### CI 发版

推送形如 `v0.1.1` 的 tag 到 GitHub 后，[Release](./.github/workflows/release.yml) 工作流会：

1. 在 `windows-latest` 上执行 `pnpm package:exe`
2. 创建对应 GitHub Release
3. 上传 `QingCode_<version>.exe` 与 `QingCode.exe`

草稿/预发布可通过 workflow 输入或后续在 GitHub Release 页面调整。

## 相关文档

- [English README](./README.en.md)
- [更新日志](./CHANGELOG.md)
- [配置帮助](./帮助文档.md)
- [设计规范](./DESIGN.md)
- [贡献与仓库约定](./AGENTS.md)

## 技术栈

Tauri 2 · React 19 · TypeScript · Vite · CodeMirror 6 · xterm.js · Zustand · Tailwind CSS · Rust
