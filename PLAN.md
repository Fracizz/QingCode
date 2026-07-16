# QingCode 开发计划

一个比 VSCode 更轻的桌面代码编辑器：单窗口管理多项目、保存项目记录、多终端、文件编辑，内存占用低。

## 一、技术选型（内存优先）

| 模块 | 选型 | 说明 |
| --- | --- | --- |
| 壳 | Tauri 2 (Rust) | 系统 WebView，无内嵌 Chromium，内存约为 Electron 的 1/3 |
| 前端 | React 18 + TypeScript + Vite | 渲染层，轻量 |
| 编辑器 | CodeMirror 6 | 比 Monaco 内存低，API 现代，按需加载语言包 |
| 终端渲染 | xterm.js + @xterm/addon-fit/addon-web-links | 前端终端 UI |
| 终端后端 | portable-pty (Rust) + Tauri IPC | Rust 侧创建 PTY，事件流双向打通 |
| 文件系统 | Tauri fs 插件 + 自研文件树 | 读目录/读写文件走 Rust 权限 |
| 持久化 | SQLite (tauri-plugin-sql) | 存项目记录、最近文件、设置 |
| 状态管理 | Zustand | 轻量，避免 Redux 开销 |
| 样式 | TailwindCSS + CSS 变量主题 | |

> 不选 Electron：每个窗口一个 Chromium，空载 200MB+；Tauri 系统 WebView 空载 60-90MB。
> 不选 Zed 路线：Rust + 自研 GPUI + 自研编辑器，周期数月、维护门槛极高。

## 二、目录结构

```
qingcode/
  src-tauri/              # Rust 后端
    src/
      main.rs
      terminal/           # PTY 管理、进程生命周期
      fs/                 # 文件读写、目录扫描
      db/                 # SQLite 初始化、迁移
    tauri.conf.json
  src/                    # React 前端
    main.tsx
    App.tsx
    components/
      Sidebar/            # 项目列表、文件树
      Editor/             # CodeMirror 容器、多标签
      Terminal/           # xterm.js 容器、多终端 tab
      StatusBar/
      Tabs/
    store/                # Zustand stores
      projectStore.ts    # 项目列表、当前项目
      editorStore.ts      # 打开文件、标签、脏标记
      terminalStore.ts    # 终端实例
    services/             # 调用 Tauri 命令的封装
    hooks/
  PLAN.md
```

## 三、核心功能模块

### 1. 多项目管理
- 主侧栏顶部：项目下拉/列表，点击切换当前项目
- 添加项目：选择本地目录，写入 SQLite projects 表
- 项目记录：name、path、lastOpenedAt、终端配置、recentFiles
- 切换项目时关闭旧文件标签，保留各自终端会话
- 最近项目入口

### 2. 文件树与文件操作
- 递归扫描目录（Rust 侧，带忽略 .git/node_modules）
- 点击文件 → 打开到编辑器新标签（已打开则激活）
- 支持新建/重命名/删除/拖拽移动
- 编辑器脏标记 + Ctrl+S 保存（调 Tauri fs 写盘）

### 3. 编辑器（CodeMirror 6）
- 多标签页，每个标签一个 EditorState
- 基础语言支持：JS/TS、JSON、Markdown、CSS/HTML、Python（按需懒加载）
- 行号、搜索替换、自动缩进、括号匹配、基础补全
- ESM 按需加载，避免一次性加载所有语言包占内存

### 4. 多终端（核心亮点）
- 底部面板，可多 tab，每个 tab 一个 PTY 会话
- 终端默认 cwd = 当前项目根目录
- 可选 shell（Windows: powershell/pwsh/cmd；Unix: bash/zsh）
- xterm.js ↔ Tauri 事件双向流：Rust 读 PTY → emit → 前端写屏；前端键盘 → invoke → Rust write PTY
- 终端随项目保留：切项目不销毁对应终端，切回还原输出
- 支持拆分（左右）、关闭、重命名

### 5. 设置
- 字体族/大小、主题（浅/深/跟随系统）、默认 shell、终端滚动行数
- 存 SQLite settings 表

## 四、数据库表（SQLite）

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT, path TEXT UNIQUE,
  default_shell TEXT,
  created_at INTEGER, last_opened_at INTEGER
);
CREATE TABLE recent_files (
  project_id TEXT, path TEXT, opened_at INTEGER,
  PRIMARY KEY(project_id, path)
);
CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT );
```

## 五、分阶段任务

### 阶段 0 · 脚手架（1-2 天）
- tauri create，接入 React+TS+Vite+Tailwind
- 配置 tauri.conf.json 权限（fs、shell、dialog）
- 引入 zustand、codemirror、xterm、tauri-plugin-sql

### 阶段 1 · 多项目骨架（2 天）
- projects 表、增删查、项目侧栏、切换项目状态机
- 应用启动恢复上次项目

### 阶段 2 · 文件树与编辑（3 天）
- Rust 递归目录扫描命令
- 文件树 UI（展开/折叠/激活）
- CodeMirror 多标签、读盘/写盘、Ctrl+S
- recent_files 记录

### 阶段 3 · 多终端（3-4 天）
- portable-pty 在 Rust 侧管理 PTY 池
- open/write/resize/kill 命令 + data 事件
- xterm.js 容器、多 tab、随项目保留会话
- 拆分、重命名、shell 选择

### 阶段 4 · 打磨（2-3 天）
- 主题、设置面板、状态栏（当前文件/分支/行列）
- 快捷键体系、关闭确认未保存提示
- 打包 Windows 安装包，验内存占用

预计 MVP：2-3 周。

## 六、内存优化要点
- 仅 WebView 单实例，切项目不新开窗口
- CodeMirror 语言包懒加载
- 终端滚动缓冲限制（addon-fit + 默认 5000 行）
- 大文件 >5MB 警告/只读流式查看
- 文件树虚拟滚动（react-window）避免渲染万项