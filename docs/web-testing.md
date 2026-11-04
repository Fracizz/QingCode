# 完整应用 Web 测试

浏览器按当前执行环境选择：Linux（含 WSL）默认 `agent-browser`，Windows/macOS 默认 `ego-browser`。
WSL 中已安装的 Windows Ego 桥接入口仅在显式选择 Ego 时使用，不改变 Linux 默认值。
同一测试会话保持同一引擎；具体命令和独立场景见 [Web 浏览器验收](web-ui-testing.md)。

```bash
pnpm install
pnpm dev:web-test
```

打开 `http://localhost:38419/?testSession=my-run`。该模式挂载生产 `App`、真实 Zustand Store、CodeMirror 和 xterm；只在 Tauri IPC / 插件接口边界提供测试实现。不加载组件测试页，不替换 Store 方法。

`web-test` 仅在 Vite 开发模式启用。普通 `pnpm dev` 继续是浏览器预览，正式构建不包含测试运行时、SQLite WASM 或测试控制接口。`isTauri()` 保留真实桌面身份；文件、数据库等业务入口通过 `hasBackend()` 判断可用能力。系统窗口、原生拖放、桌面更新等仍使用桌面判断。

## 数据与隔离

- 初始项目列表为空。从欢迎页「打开项目」添加 `/workspace/demo`，经过真实信任对话框、数据库写入、项目切换和文件树加载。
- 模拟目录选择器默认返回 `/workspace/demo`，文件选择器默认返回该目录的 `README.md`，保存对话框默认返回 `/workspace/demo/saved.txt`。可通过控制接口排队指定结果或取消。
- 项目数据库使用 sql.js 的浏览器 SQLite 执行生产仓储 SQL；表结构和升级 SQL 读取 `src-tauri/src/lib.rs` 中的原生迁移。SQLite 数据快照与虚拟文件系统持久化到浏览器本地存储。
- 文件树、文件读写、属性、搜索共用一个虚拟磁盘。支持新建、重命名、移动、复制、删除；不读取主机磁盘。只模拟 UTF-8 文本，不覆盖符号链接、非 UTF-8 编码、图片、大文件分片和 Git 忽略规则。
- 初始保存了一个 `Web Test SSH` 连接，用于通过真实创建项目流程选择远程 `/home/demo`。该连接、指纹、文件和终端均为模拟，不访问任何实际 SSH 主机。
- `testSession` 允许 1–64 位字母、数字、`-`、`_`；省略时使用 `manual`。每个会话隔离应用 localStorage、sessionStorage、设置、信任、草稿、数据库及虚拟文件。刷新恢复同一会话，使用新名字开始独立测试。不要用同一会话并行运行两个浏览器页。
- 未实现的命令明确报错。模拟目录不包含 Git 仓库，Git 状态返回非仓库；不会把固定的成功响应当成 Git 验收。

## 注入底层场景

开发模式中通过 `window.__QINGCODE_TEST__` 操作底层能力。该接口不导入或修改业务 Store。

```js
const test = window.__QINGCODE_TEST__
test.queueDialog('/workspace/other') // 下一次目录/文件对话框结果
test.queueDialog(null)               // 取消下一次对话框
test.readFile('/workspace/demo/README.md')
test.externalWrite('/workspace/demo/README.md', '# Externally changed\n')
test.failNext('write_file', '模拟磁盘写入失败')
test.setLatency('read_file', 500)      // 毫秒；0 恢复即时响应

const [id] = test.terminalIds()       // 先通过界面创建终端
test.output(id, '测试输出\r\n')
test.exit(id, 2)                     // 真实 Store 决定退出/自动重建行为
test.disconnect()                   // Web Test SSH 的连接与终端状态事件
test.reconnect()
test.calls()                        // 最近 500 次命令名，不记录参数或凭据
test.reset()                        // 只清空本会话，随后刷新页面
```

模拟交互 Shell 支持回显、`pwd`、`echo`、`exit` 和 Ctrl+C；其他输入不会执行系统命令。运行配置只创建模拟任务会话，输出和结束由控制接口注入。终端进程、连接状态、延迟和一次性错误不跨页面刷新保留；应用的会话恢复逻辑仍会执行。

文件事件经过生产防抖与保存抑制逻辑。验证外部修改时，应等当前保存结束并超过抑制窗口；不要用修改 Store 的方式触发刷新。修改测试运行时代码后刷新页面，再开始场景，避免 HMR 中的旧事件订阅影响结果。

## 验收边界

优先从界面完成：添加项目 → 信任 → 打开/新建文件 → 编辑保存 → 关闭重开 → 刷新恢复。然后注入外部修改、写入失败、终端输出/退出和 SSH 断线/重连，观察生产逻辑响应。

运行 `pnpm test` 和 `pnpm build` 检查回归。底层契约测试覆盖真实 SQL、事务回滚、数据库恢复、虚拟磁盘一致性、路径与信任拒绝、失败/延迟、远程资源及事件载荷。

本模式验证前端业务流程与模拟接口契约。真实 Rust 文件读写、Git、PTY、SSH 后端联调属于后续阶段；WebView2、系统窗口、系统对话框和原生拖放继续需要桌面验收。
