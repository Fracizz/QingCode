# Windows 目标：server 行为补齐与本机验收（T24）

> 本次验收在**本机 Windows 11 x64** 上执行（Node v24.18.0、git 2.45.2.windows.1、
> `rg` 存在于 `%USERPROFILE%\.pi\agent\bin`、`claude.exe` 存在于
> `%USERPROFILE%\.local\bin`、本机未安装 codex）。测试全部使用 `os.tmpdir()` 下的临时目录/仓库，
> 结束后清理。范围与红线见 `docs/tasks/T24-windows-server.md`、`docs/agent-adapters.md`。

## 0. 自动验收结果

| 命令 | 结果 |
|---|---|
| `pnpm exec tsc -p packages/server/tsconfig.json` | 通过，0 错误 |
| `pnpm exec tsc -p packages/protocol/tsconfig.json` | 通过，0 错误（附加检查） |
| `pnpm exec vitest run packages/server/src/workspace` | 16 个文件 / 175 个用例：174 通过、1 跳过（仅 POSIX 权限位用例） |
| `pnpm exec vitest run packages/server/src` | 49 个文件 / 378 个用例：376 通过、2 跳过（附加检查） |
| `node packages/server/build.mjs` | 成功，`apps/desktop/resources/server/qn-server.cjs` 2 984 800 字节，sha256 `81604f0ca86a` |

复现步骤：在仓库根（`D:\code\qingcode-next`）依次执行上表命令；本机验收用例集中在
`packages/server/src/workspace/**` 内标有 `it.skipIf(process.platform !== 'win32')` 的用例。

## 1. 路径

验收步骤：

1. 用盘符（`C:\`、`c:/`）、UNC（`\\server\share`）、`\\?\` 长路径前缀、混用斜杠调用
   `fs.stat` / `fs.read` / `fs.write`；大小写不同的同一路径应命中同一文件。
2. 用 `fs.delete` 删除 `C:\`、`%USERPROFILE%`、UNC 共享根，必须返回 `params` 且不删除任何内容。
3. 用带大小写差异 / 混用斜杠 / `\\?\` 前缀的 `cwd` 调用 `git.status`，
   用大小写不同的文件名调用 `git.diff`，应定位同一仓库与同一文件。

本次结果：**通过**。

- `packages/server/src/workspace/paths.test.ts`：长路径前缀还原、大小写/斜杠归一、去重、父子目录判断、win32/posix 实现选择。
- `packages/server/src/workspace/fs/logic.test.ts`：绝对路径识别（含 `\\?\`、UNC）、保护目录（盘符根、UNC 根、主目录大小写差异）。
- `packages/server/src/workspace/fs/ops.test.ts`：本机真实目录的大小写 + 混用斜杠读取、`\\?\` 前缀下 >260 字符路径的建目录/写/读。
- `packages/server/src/workspace/git/pure.test.ts` + `git/integration.test.ts`：真实 git 仓库下混用斜杠与大小写 cwd、`\\?\` 前缀 cwd、大小写不同的文件名 pathspec（由 `canonicalizeRepoRelative` 按磁盘真实名称归一）。
- 限制：本机没有可用 UNC 共享，UNC 只做了纯逻辑与路径计算验证，未跑真实 UNC IO。

## 2. 编码与换行

验收步骤：

1. 写 UTF-8 BOM + CRLF 文件，`fs.read` 应去掉 BOM 并带 `bom:true`，CRLF 原样保留；
   `encoding:'base64'` 时返回原始字节（含 BOM）。
2. `fs.write { bom:true }` 写回 UTF-8 BOM；`bom:false` 不加前缀。
3. 写 UTF-16 LE / BE（带 BOM、含中文、emoji 代理对、CRLF）文件，`fs.read` 应返回 utf8 文本，
   并标 `bom:true` 与源编码；把读到的元数据原样传回 `fs.write` 后字节完全一致。
4. UTF-32 BOM 与无 BOM 的 UTF-16 按二进制处理（`binary:true`）。

本次结果：**通过**（`fs/encoding.test.ts`、`fs/ops.test.ts`、`fs/logic.test.ts`）。

协议字段只追加到 `packages/protocol/src/workspace.ts`：`FsReadResult` 增加可选 `bom`、
`sourceEncoding`，`FsWriteParams` 增加可选 `bom`、`sourceEncoding`。
`encoding` 字段仍表示返回内容的编码（`utf8` / `base64`），源编码另用 `sourceEncoding` 标注。

## 3. fs.watch

验收步骤：

1. `fs.watch {paths:[项目根]}`，在**子目录**内新建文件，200ms 去抖后应收到 `evt fs.changed`
   且路径为绝对路径（Windows/macOS 用 `recursive:true`，Linux 仍逐目录）。
2. 传入大小写不同的同一目录两次，事件里不应出现大小写重复的同一路径。
3. 再次调用（含空数组）全量替换、连接断开时清理 watcher。

本次结果：**通过**（`fs/watch.test.ts`：递归监听子目录、大小写归一去重、全量替换、断连清理、上限、非法参数）。

## 4. fs.search

验收步骤：

1. 项目根下建 `$RECYCLE.BIN`、`System Volume Information` 并放入命中文件，
   Node 兜底遍历（无 rg 路径）应跳过它们；文件名搜索大小写不敏感。
2. 写 `.gitignore`（`dist/`、`*.log`、`!keep` 取反、`src/generated/**`、嵌套 `.gitignore`），
   搜索结果应尽量遵守；同一路径大小写不同不重复推送。

本次结果：**通过**（`fs/ignore.test.ts`、`fs/search.test.ts`、`fs/searchLogic.test.ts`）。
说明：`.gitignore` 简化规则作用于 Node 兜底遍历；rg 路径仍用 `--no-ignore` +
固定排除 glob（含两个 Windows 系统目录），与原行为一致。

## 5. Git

验收步骤：

1. 本机真实 git（临时仓库）跑 `git.status` / `git.diff`；确认命令带
   `-c core.quotepath=false`、`-c core.longpaths=true`（不覆盖 `core.autocrlf`）。
2. 中文文件名不应被转义成 `\344\270...`；`core.autocrlf=true` 的仓库里改一行后
   diff 只显示该行，不整文件显示为改动。
3. PATH 之外（Program Files\Git\cmd、`%LOCALAPPDATA%\Programs\Git\cmd`）的 `git.exe` 能被解析到。

本次结果：**通过**。

- `git/run.test.ts`：候选顺序、存在性注入、全局 `-c` 参数不含 autocrlf、真实 `git --version` 带全局参数可执行。
- `git/integration.test.ts`：本机真实仓库 + `core.autocrlf=true`，CRLF 文件改一行后 diff 只含 `-two/+TWO`；
  中文文件名 diff 未转义；混用斜杠/大小写/`\\?\` 前缀 cwd；文件名大小写归一。

## 6. Agent 可执行文件解析

验收步骤：

1. Windows 下解析 codex：PATH → `%APPDATA%\npm`（`codex.cmd`）→
   `%LOCALAPPDATA%\Microsoft\WindowsApps`（`codex.exe`）→ 官方安装器目录；claude：
   PATH → `%USERPROFILE%\.local\bin\claude.exe` → npm 全局 / WindowsApps，不列 `.cmd`。
2. `.cmd` / `.bat` 启动不得用 `shell:true` 拼接参数；用含空格、`&` 的真实批处理文件
   验证参数安全、stdio 可收发，并验证参数里的 cmd 元字符不会执行注入命令。
3. 显式路径优先；JSON 数组测试钩子（假 codex）不受影响。

本次结果：**通过**（`workspace/agentExec.test.ts`：候选纯函数 + 本机真实 `.cmd` 启动 + stdin/stdout + 注入防护；
`claude/resolve.test.ts` 原有解析用例仍通过）。

合规：`docs/agent-adapters.md` §7 / R1 / R5 / R7 —— 只做路径解析与 `--version`，
不下载/安装/升级 Agent、不碰凭据、不改 `clientInfo`、不自动应答审批、不注入环境变量。

## 7. 直连连接（待验收，由总管在 10.87 实测）

T24 范围不含 `direct/**`、`sshTarget.ts`、`remoteCommands.ts`、`daemon.ts`，以下仅列待验收项：

- [ ] 10.87（Windows，Claude Code 2.1.331 已登录）作为「本机」目标时，
      `qn-server.cjs ensure` 能否用 Electron 自带 Node detached 拉起常驻 daemon，命名管道可连。
- [ ] 证书指纹固定：复制连接信息 → 手机/另一台电脑导入 → TLS 直连；
      指纹不符（重新生成证书或地址指向另一台电脑）应拒绝并给出提示。
- [ ] Windows 目标 `direct enable` / `direct grant` / `direct revoke` / `direct status`
      在 `%LOCALAPPDATA%\qingcode-next\server` 下的读写与 daemon 重读配置。
- [ ] 直连 5 秒超时失败（含指纹不符）回退 SSH，状态说明带原因；
      `codex.attach {sinceSeq}` 重连回放正常。
- [ ] Windows 远端（SSH）部署：探测退化为 cmd/PowerShell 分支、`node -e` base64url 脚本写文件、
      SFTP `/C:/...` 路径、WMI 拉起 daemon 与断线不丢会话。
- [ ] 直连会话禁止调用 `server.shutdown` / `direct.reload` / `direct.status`（`forbidden`）。
- [ ] 本机未安装 codex，需在 10.87 或 93 上验证 codex `app-server` 真实启动（`codex.open` → 初始化 → 流式消息）。

## 8. 本次实现假设

1. `FsReadResult` 新增 `sourceEncoding` 而不是改写 `encoding`：`encoding` 仍是返回内容的编码
   （UTF-16 源已解码为 utf8 内容），源编码单独标注；客户端把 `bom` / `sourceEncoding` 原样传回
   `fs.write` 即可按原编码写回。
2. UTF-16 的 `fs.read {offset}` 按双字节码元对齐（奇数偏移回退到 BOM 之后的偶数边界），
   `length` 是消费的原始字节数（含 BOM）。
3. 只识别带 BOM 的 UTF-16 LE/BE；UTF-32 BOM 与无 BOM 的 UTF-16 按二进制处理。
4. Windows `.cmd` 路径中若含 `%`、`!`、`"`、CR/LF/NUL 会被拒绝（cmd 会展开或注入），
   改用 `.exe` 或不含这些字符的路径；不经 `shell:true`。
5. 简化的 `.gitignore` 只支持注释、`!`、`目录/`、`*` / `**` / `[]` 通配与目录锚定，
   不支持转义空格与 `git check-ignore` 的完整语义。
6. `fs.watch` 在 Linux 仍逐目录；macOS 不支持 `recursive` 时自动退回逐目录。
7. `git` 路径大小写归一通过 `readdir` 取磁盘真实名称；文件已从工作区删除时保留客户端写法，
   此时 `git show <ref>:<path>` 仍可能区分大小写。
