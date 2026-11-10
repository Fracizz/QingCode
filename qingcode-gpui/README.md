# qingcode-gpui — GPUI 原生编辑器 MVP

QingCode 向 [GPUI Kit](https://gpui-kit.com/) 迁移的可行性试验。目标是用最小代价验证：
gpui-component 的 `Editor` / `Diff` 能否承担 QingCode 编辑区，以及在 Windows 上的输入、渲染与性能表现。

> 独立 Cargo workspace，**不参与** `src-tauri` 构建与 `pnpm check`，不影响现有桌面应用。

## 范围

| 已实现 | 说明 |
|---|---|
| 工作区文件树 | 按需加载目录，隐藏 `.git` / `node_modules` / `target` 等噪声目录 |
| 多标签页 | 去重打开、关闭后激活右侧/左侧、未保存标记 `●`，有未保存修改时拒绝关闭 |
| 代码编辑 | gpui-component `Editor`（rope + tree-sitter 高亮 + 折叠 + 搜索），按扩展名选语言 |
| 保存 | `Ctrl+S` 原子写入；保留原文件 CRLF/LF，去 BOM；>5 MB、二进制、非 UTF-8 拒绝打开 |
| Diff | `Ctrl+Shift+D`：当前缓冲区（含未保存修改）对比 `git HEAD`，gpui-component `Diff` 渲染；`Ctrl+Shift+M` 切换统一/并排 |
| 状态栏 | 相对路径、行列号、语言、换行符 |

**明确不做（本阶段）**：minimap、括号着色、LSP、终端、SSH、设置、多窗口、未保存确认对话框。

## 运行

```powershell
cd qingcode-gpui
cargo run -- D:\path\to\workspace   # 缺省为当前目录；需要交互式桌面会话
cargo test                          # 19 个纯逻辑单测 + 5 个无头窗口 UI 测试
cargo clippy --all-targets -- -D warnings
```

> 在 SSH / 服务会话（session 0）里直接运行会报 `cannot open windows while headless`，
> 这是 GPUI 需要真实桌面的限制；此时用 `cargo test` 的无头 UI 测试验证交互。

`tests/ui.rs` 用 `#[gpui_kit::test]` 渲染真实主窗口并驱动键鼠事件，覆盖：文件树过滤与懒加载展开、
打开去重、输入后脏标记、`Ctrl+S` 保持 CRLF、未保存拒绝 `Ctrl+W`、Diff（未改动提示 / 未保存缓冲区对比 HEAD /
统一↔并排切换 / Diff 下快捷键可用 / 切回编辑器可继续输入）。

Release 单文件 exe 约 33 MB（`cargo build --release`，无 WebView 依赖）。

快捷键：`Ctrl+O` 打开文件夹 · `Ctrl+S` 保存 · `Ctrl+W` 关闭标签 · `Ctrl+Shift+D` 切换 Diff ·
`Ctrl+Shift+M` 统一/并排 · `Ctrl+Q` 退出。

## 依赖与网络

- `gpui-kit = "=0.9.1"`（crates.io 精确锁定，内部固定 `gpui-pre =0.3.12`），未 fork GPUI。
- 首次拉取约 800 个 crate；在 252.107 上单连接下载很慢时，可并行下载缺失 crate 并按
  `Cargo.lock` 的 checksum 校验后放入 `~/.cargo/registry/cache`，再 `cargo build --offline`。

## 结构

| 文件 | 职责 |
|---|---|
| `src/main.rs` | 应用入口、主题、全局快捷键、窗口 |
| `src/app.rs` | 主视图：文件树、标签栏、Editor / Diff 切换、状态栏、动作处理 |
| `src/file_tree.rs` | 懒加载文件树模型（纯逻辑） |
| `src/tabs.rs` | 标签页列表模型（纯逻辑） |
| `src/text_file.rs` | 读写、编码 / 二进制检查、换行符往返、原子保存 |
| `src/git.rs` | 仓库定位、读取 HEAD 版本、生成统一补丁 |
| `src/language.rs` | 扩展名 → 高亮语言名 |

## 已知限制

- Diff 在 UI 线程同步调用 `git show`，超大仓库首次切换会有短暂卡顿（MVP 可接受，后续移到后台任务）。
- 未保存关闭仅提示拒绝，没有「保存 / 放弃」确认对话框；无外部修改检测与自动重载。
- 文件树不读取 `.gitignore`，只隐藏固定噪声目录。

## 待验证（go / no-go）

1. Windows 微软拼音 / 搜狗输入法在 `Editor` 中的候选框位置与组合输入
2. 中文 / emoji 字体回退与 DirectWrite 渲染清晰度
3. 20 万行文件打开、滚动、编辑流畅度；冷启动内存与时间
4. 增量编译时间是否可接受
