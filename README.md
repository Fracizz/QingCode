# QingCode

轻量桌面代码编辑器：单窗口多项目、多终端、低内存占用。

基于 Tauri 2 + React + TypeScript + CodeMirror 6 + xterm.js，系统 WebView 空载 60–90MB（约为 Electron 的 1/3）。

## 特性

- **多项目管理**：项目以 chip 形式横向铺在标题栏，点一下即切换；放不下的收进 `···` 溢出下拉。支持添加 / 移除 / 重新定位 / 在文件管理器打开。
- **资源管理器**：侧边栏只显示当前项目的文件树，内联新建文件 / 文件夹，右键菜单覆盖重命名 / 删除 / 复制路径 / 复制为文件引用 / 在此打开终端等。
- **多终端**：底部面板多 tab，每个 tab 一个 PTY 会话，默认 cwd 为当前项目根目录。**切换项目不销毁终端**，切回时还原输出与历史；每项目最多 10 个。
- **编辑器**：CodeMirror 6 多标签，按需懒加载语言包（JS/TS、JSON、Markdown、CSS/HTML、Python），脏标记 + Ctrl+S 保存。
- **搜索 / 运行配置**：侧边栏搜索面板可按目录限定范围；运行配置面板可配置并启动脚本终端。
- **设置**：字体族 / 字号、主题（浅 / 深 / 跟随系统），持久化到 SQLite。
- **主题**：深色优先（参考 Cursor / VS Code Dark+），图标体系参考 OpenCode。

## 开发

```bash
pnpm install
pnpm tauri:dev
```

Windows 下若 `cargo` 不在 PATH，`pnpm tauri:dev` 会自动加入 `%USERPROFILE%\.cargo\bin`。

## 构建

```bash
pnpm tauri build      # 完整安装包
pnpm package:exe       # 仅打包 exe
```

## 目录结构

```
src-tauri/            # Rust 后端：PTY、文件系统、SQLite
src/
  components/         # TitleBar / ProjectPicker / Sidebar / Editor / Terminal ...
  store/              # Zustand：projectStore / editorStore / terminalStore / uiStore ...
  utils/              # projectActions、fileReferences、terminalName ...
  lib/                # tauri 封装、主题、字体、面板布局 ...
DESIGN.md             # 设计规范（色彩、布局、组件约定）
PLAN.md               # 开发计划与技术选型
```

## 设计与约定

界面文案默认简体中文，颜色 / 组件 / 交互约定见 `DESIGN.md`。
