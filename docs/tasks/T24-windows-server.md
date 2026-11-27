# T24 Windows 目标：server 行为补齐与本机验收

范围：`packages/server/src/workspace/**`（fs、git 及测试）、`packages/server/src/claude/resolve.ts`、`packages/server/src/codexHost.ts` 中可执行文件解析的函数（只改解析相关代码，先重新读取）、新增 `docs/windows-acceptance.md`。
**不碰**：`sshTarget.ts`、`remoteCommands.ts`、`packages/server/src/{direct/**,serve.ts,args.ts,main.ts,validation.ts}`、`daemon.ts`（远程传输由另一会话负责）；`packages/server/src/pi/**`（T22 在做）。

背景：QingCode Next 的目标可能是 Windows（本机、经直连的 Windows 主机）。T16/T17 的 fs/git 主要在 POSIX 语义下写成，需要在 Windows 上补齐并实测。本机就是 Windows 11，可直接跑集成测试。

实现：

1. **路径**：盘符（`C:\`、`c:/`）、UNC（`\\server\share`）、`\\?\` 长路径前缀、大小写不敏感比较（Windows 下 `fs.watch` 合并、搜索结果去重、git root 相对路径计算）、反斜杠与正斜杠混用。`fs.delete` 的"拒绝删除根/主目录"在 Windows 下也要生效（`C:\`、`%USERPROFILE%`）。
2. **编码与换行**：`fs.read` 识别 UTF-8 BOM（去掉 BOM 并在结果里加 `bom:true`；写回时由客户端决定，`fs.write` 新增可选 `bom?: boolean`）；CRLF 原样保留，不做转换（补测试）。UTF-16 LE/BE（带 BOM）文件识别为文本并正确解码为 utf8 返回（结果标 `encoding:'utf16le'` 来源，写回时按原编码），不支持的编码按二进制处理。协议字段改动只追加到 `packages/protocol/src/workspace.ts`（先重新读取）。
3. **fs.watch**：Windows 与 macOS 上用 `recursive:true` 监听项目根以减少句柄；Linux 保持逐目录。去抖合并路径时大小写归一。
4. **fs.search**：Windows 无 rg 时的 Node 遍历要跳过 `$RECYCLE.BIN`、`System Volume Information`；`.gitignore` 简单规则（目录名/通配）尽量遵守；文件名搜索大小写不敏感。
5. **git**：解析 `git.exe`（PATH → `C:\Program Files\Git\cmd\git.exe` → `%LOCALAPPDATA%\Programs\Git\cmd`），所有命令加 `-c core.quotepath=false`，保证中文文件名不被转义；`core.autocrlf=true` 的仓库里 diff 不应整文件显示为改动（补测试：本机临时仓库设 autocrlf 后改一行）；长路径 `-c core.longpaths=true`。
6. **Agent 可执行文件解析**（Windows）：codex（npm 全局 `codex.cmd`、WindowsApps `codex.exe`）、claude（`claude.exe`、`%USERPROFILE%\.local\bin\claude.exe`）在 PATH 外的常见安装目录；`.cmd`/`.bat` 启动必须安全转义参数（参照现有实现），不经 `shell:true` 拼接用户输入。补纯函数单测。
7. **本机验收**：在本机（Windows）用真实 git、真实目录跑集成测试（临时目录，结束清理），并写 `docs/windows-acceptance.md`：逐项列出 Windows 目标的验收步骤与本次结果（路径、编码、监听、搜索、git、Agent 解析、直连连接——直连一节只写待验收项，由总管在 10.87 实测）。

验收：`pnpm exec tsc -p packages/server/tsconfig.json`、`pnpm exec vitest run packages/server/src/workspace` 通过；`node packages/server/build.mjs` 成功。
