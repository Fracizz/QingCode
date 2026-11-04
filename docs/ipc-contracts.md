# 渐进文件 IPC 类型契约

`src-tauri/qingcode-contracts` 是无 Tauri 依赖的共享 Rust 数据 crate。本地和 SSH
文件命令直接使用其中的 DTO，`ts-rs` 从实际 Rust 定义生成
`src/lib/generated/fileIpc.ts`，不手工维护第二份响应字段。

```sh
pnpm ipc:generate
pnpm ipc:check
```

生成器仅编译轻量 contracts crate，不启动 GUI，也不需要编译 WebKit/GTK。
`pnpm check:frontend` 先检查生成文件是否过期。新增或改动 DTO 后重新生成并提交结果。
常规桌面构建不启用 `export` feature，`ts-rs` 不进入运行时代码。
因此 `pnpm check:frontend` 也需要已安装 Rust/Cargo（首次运行需取得 contracts 的依赖）。
仅查看 UI 的机器仍可直接运行 `pnpm typecheck`、`pnpm exec vitest run` 或 `pnpm build`；
这些命令使用仓库中提交的生成文件，不启动生成器。

`src/lib/fileIpc.ts` 提供目录扫描、文件属性、片段读取和行偏移的类型化入口，
继续调用 `safeInvoke`，保留 SSH 路由、运行环境错误和性能记录。
SSH 片段返回 `content/nextOffset/fileSize`，本地返回 `text/len/file_size`；
入口将 SSH 结果转成统一的本地形状，长度按字节偏移计算。
前端文件树的 `loaded` 状态保留在 UI 层，不属于原生 wire 数据。

本阶段自动生成响应 DTO，参数门面仍按现有命令签名维护，未宣称所有 Tauri 命令均已
自动验证。以后按模块逐步接入参数生成或 tauri-specta；不要绕过现有路由直接调用生成的
`invoke`。JSON 数值对应 `number`，文件大小和偏移需处于 JavaScript 安全整数范围。
这套检查验证类型同步，不替代真实本地/WSL/SSH 文件访问验收。
