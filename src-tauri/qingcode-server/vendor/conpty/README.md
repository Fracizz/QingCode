# ConPTY（conpty.dll + OpenConsole.exe）

来自 Microsoft 官方 NuGet 包 [`Microsoft.Windows.Console.ConPTY`](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY) **1.25.261109001**（MIT，© Microsoft Corporation，源码见 <https://github.com/microsoft/terminal>）。Windows Terminal / VS Code 同样随应用携带这套新版 ConPTY。

`qingcode-server/src/conpty.rs` 按目标架构把这里的文件嵌入二进制，首次创建终端前释放到 `%LOCALAPPDATA%\QingCode\conpty\<版本>-<架构>\`，校验 SHA-256 后按完整路径预加载 `conpty.dll`，`portable-pty` 随后按名加载时即复用它。设置 `QINGCODE_INBOX_CONPTY=1` 可退回系统自带的 ConPTY。

**为什么需要**：系统自带的 conhost 会吞掉「切换控制台输入模式之前」请求的鼠标上报（`?1000h/?1002h/?1003h/?1006h`）。pi 全屏模式正是先进备用屏幕再切 raw 模式，结果 xterm 收不到鼠标模式，滚轮被转成方向键去翻输入历史。新版 OpenConsole 会把这些请求透传给终端。

| 文件 | 包内路径 | SHA-256 |
|------|----------|---------|
| `x64/conpty.dll` | `runtimes/win-x64/native/conpty.dll` | `e971856f89748dc3b458125e9afdd79b5e9574a7c937676116d3cbbd3b71f492` |
| `x64/OpenConsole.exe` | `build/native/runtimes/x64/OpenConsole.exe` | `b17e48b07ef153b420f0a6e178bacd31fb4c3390e21ae746586213fc0719a775` |
| `arm64/conpty.dll` | `runtimes/win-arm64/native/conpty.dll` | `3608cef830a1c4fbbf3981594ad3f64ebe2df6db98fe43a48a4ca7d2875d8959` |
| `arm64/OpenConsole.exe` | `build/native/runtimes/arm64/OpenConsole.exe` | `c04334f450b5731930b63a28ac4da8a058367242dbcf2fb9b323ea25e5a23252` |

四个文件均带有效的 Microsoft Corporation Authenticode 签名。升级时从新版 nupkg 取同样路径的文件，更新本表、`conpty.rs` 里的 `CONPTY_VERSION`，并在 Windows 上复测 pi 全屏滚轮。
