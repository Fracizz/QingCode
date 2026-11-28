# T31 Windows 本机 ConPTY

范围：
- `packages/server/src/terminal/**`（Windows 后端、默认 shell 与测试）。
- `packages/server/build.mjs`（从已准备的桌面依赖复制 Windows x64 预编译包到现有 server 资源目录）。

依据：`docs/spikes/terminal.md` §4、`docs/mvp.md` §2 和 §5。预编译实现使用 [@lydell/node-pty](https://github.com/lydell/node-pty) 对应的 Windows x64 平台包。

1. 在 Windows x64 Electron 启动的本机 daemon 按需加载 ConPTY；经 SSH 部署的 server 仍只上传单文件。
2. 接入默认 shell、输入输出、resize、退出与关闭。原生模块缺失时返回 `pty_unavailable`。
3. 单测覆盖后端适配。总管提供预编译依赖后，在 10.87 验证 Electron ABI、中文交互、Ctrl+C、resize、退出状态，以及 NSIS 或 ZIP 安装后的加载。

打包沿用 Electron 的 `extraResources`，将预编译包放在 `resources/server/conpty`，位于 ASAR 外。构建只使用已准备的本机包。尚需总管提供 `@lydell/node-pty` 及同版本 `@lydell/node-pty-win32-x64`。
