/**
 * Canonical source for the copyable QingCode CLI Skill.
 * Run `pnpm skill:sync` after changing this template to refresh the repository
 * snapshot at `.agents/skills/qingcode-cli/SKILL.md`.
 */

export const QINGCODE_CLI_REPO_BINARY = String.raw`.\src-tauri\target\debug\qingcode.exe`

function buildEnglishSkill(quoted: string): string {
  return `---
name: qingcode-cli
description: >-
  Drive QingCode via QingCode.exe subcommands for multi-project management and
  local/SSH run-config CRUD and start/stop. Use when the user asks to add
  projects, list projects, edit .qingcode/run.json run configs, start or stop a
  run configuration, grant workspace trust, or open files in a running QingCode
  instance.
---

# QingCode CLI

Install this file into your AI agent as a Skill / custom instruction (path and
format depend on that product). QingCode only provides the text — it does not
auto-register with any agent.

Prefer these subcommands over hand-editing SQLite, directly rewriting
\`.qingcode/run.json\`, or guessing UI steps.

## Binary

\`${quoted}\`

## Output contract

- Command results write JSON \`{ ok, data?, error? }\` to stdout; \`--help\` writes plain text.
- Exit: \`0\` ok · \`1\` error · \`2\` usage · \`3\` app not running.
- Check both the exit code and \`ok\`; surface \`error\` to the user instead of guessing.

## Project and local run-config commands

These commands do not require the GUI for local projects:

\`\`\`text
${quoted} project list
${quoted} project add <dir> [<dir>...]
${quoted} project remove <id|path|name>

${quoted} run list [--project <id|path|name>]
${quoted} run get <name|id> [--project ...]
${quoted} run upsert --json <file|-> [--project ...]
${quoted} run remove <name|id> [--project ...]
\`\`\`

- \`project add\` accepts local directories only. Add SSH projects through QingCode's SSH project
  dialog so the connection, host fingerprint, and remote root are registered together.
- For run-config CRUD, \`--project\` may be omitted only when the database has exactly one project.
- With multiple projects, pass an ID or exact path from \`project list\`; use a name only when unique.
- Local project run-config CRUD reads and writes \`<project>/.qingcode/run.json\` directly without
  starting QingCode.

### SSH run-config CRUD

The same \`run list|get|upsert|remove\` syntax works for projects whose path starts with \`ssh://\`,
but QingCode must be running. The CLI automatically routes these operations through the GUI's
authenticated SSH/SFTP session; it must never treat an \`ssh://\` URI as a local filesystem path.

- Pass \`--project <id|ssh-uri|unique-name>\` when more than one project exists.
- If exit \`3\`, start QingCode and retry. Do not directly rewrite a guessed local copy of the
  remote \`.qingcode/run.json\`.
- If the SSH password is not available in the current app session, ask the user to reconnect by
  opening the SSH project in QingCode; do not request or place a password in \`run.json\`.
- The remote \`.qingcode\` directory is created automatically on the first successful save.

### Run-config JSON

- \`run upsert --json -\` reads stdin. The body may be a config object or \`{ "config": {...} }\`:

\`\`\`json
{
  "name": "前后端",
  "restoreWithProjectSession": false,
  "tasks": [
    { "name": "后端", "type": "command", "target": "cargo run", "cwd": "src-tauri" },
    { "name": "前端", "type": "command", "target": "pnpm dev" }
  ]
}
\`\`\`

Config and task \`id\` values are optional when creating and are auto-generated. Local task \`type\`:
\`ps1\` | \`bat\` | \`sh\` | \`command\` | \`script\`. For SSH Linux projects use only \`command\`, \`sh\`, or
\`script\`; \`ps1\`, \`bat\`, and \`cmd\` scripts are unsupported and will be rejected when started.
The optional \`restoreWithProjectSession\` field defaults to \`false\`; set it to \`true\`
to restore and restart linked task terminals with the project session after an app restart.

SSH task rules:

- \`cwd\` omitted: remote project root. Relative \`cwd\`: relative to that root. An absolute POSIX
  \`cwd\` such as \`/opt/service\` stays on the same SSH connection. Do not use Windows paths.
- \`command\` runs through remote POSIX \`/bin/sh -lc\`; do not write CMD or PowerShell syntax.
- \`sh\` runs the target with \`/bin/sh\`.
- \`script\` selects a remote interpreter by extension: Python (\`.py\`), Node/Bun
  (\`.js\`/\`.mjs\`/\`.cjs\`), project/global \`tsx\` or Bun (\`.ts\`/\`.tsx\`/\`.mts\`/\`.cts\`), and the
  corresponding interpreter for \`.rb\`, \`.php\`, \`.pl\`, \`.bash\`, \`.zsh\`, or \`.sh\`. Other files
  run directly when executable and otherwise fall back to \`/bin/sh\`.
- \`env\` values must be strings and names must be valid POSIX environment identifiers.

### Updating a run config

\`run upsert\` replaces the complete matching config by \`id\`, or by exact \`name\` when no
matching ID is supplied. It is not a partial patch.

1. Read the existing object with \`run get\`.
2. Preserve its \`id\`, tasks, task IDs, \`env\`, and every field the user did not ask to change.
3. Apply the requested changes and upsert the complete config object.
4. Read it again with \`run get\` and verify the result.

## Online execution (QingCode GUI must be running)

\`\`\`text
${quoted} project switch <id|path|name>
${quoted} run start <name|id> [--project ...]
${quoted} run stop <name|id> [--project ...]
${quoted} run status [--project ...]
${quoted} trust grant <path>
${quoted} open <file>[:line[:col]] ...
\`\`\`

- If \`--project\` is omitted for \`run start|stop|status\`, the GUI current project is used.
- If exit \`3\`, tell the user to start QingCode first; do not invent a headless runner. This also
  applies to run-config CRUD for SSH projects.
- \`run start\` executes the commands stored in the selected config.

## Typical agent flow

1. Discover state with \`project list\`; identify SSH projects by their \`ssh://\` path, then use
   \`run list --project <id>\`.
2. Create a config, or use the full-object update flow above for an existing config.
3. Ensure the GUI is running before execution and before any SSH run-config CRUD command.
4. Start the config, then inspect \`run status\` and report the result.
5. If restricted mode blocks execution, explain it and ask for explicit approval before \`trust grant\`.

## Safety

- \`project add\` and \`run upsert\` write persistent state; keep them within the user's request. For
  SSH projects, \`run upsert\` writes the remote project's \`.qingcode/run.json\` over SFTP.
- Use \`project remove\` / \`run remove\` only when the user clearly asked to delete.
- \`project remove\` removes the project and recent-file records from QingCode's database; it does
  not delete the project directory or its files.
- Never grant trust implicitly. Confirm the exact project root and obtain explicit user approval.
- Do not use this CLI for packaging, release tags, or force-push.
- Named workspaces are out of scope — only the user DB project list.
`
}

function buildChineseSkill(quoted: string): string {
  return `---
name: qingcode-cli
description: >-
  使用 QingCode.exe 子命令管理多个项目，以及本地/SSH 运行配置的增删改查、启动和停止。
  当用户要求添加或列出项目、编辑 .qingcode/run.json、启动或停止运行配置、授予工作区
  信任，或在运行中的 QingCode 中打开文件时使用。
---

# QingCode CLI

将此文件作为 Skill / 自定义指令安装到 AI Agent；具体路径和格式取决于对应产品。
QingCode 只提供文本，不会自动注册或适配任何 Agent。

优先使用这些子命令，不要手动修改 SQLite、直接重写 \`.qingcode/run.json\`，也不要猜测界面步骤。

## 可执行文件

\`${quoted}\`

## 输出约定

- 命令结果向 stdout 输出 JSON \`{ ok, data?, error? }\`；\`--help\` 输出纯文本。
- 退出码：\`0\` 成功 · \`1\` 错误 · \`2\` 用法错误 · \`3\` 应用未运行。
- 同时检查退出码和 \`ok\`；应向用户展示 \`error\`，不要自行猜测原因。

## 项目与本地运行配置命令

本地项目执行以下命令不需要启动 GUI：

\`\`\`text
${quoted} project list
${quoted} project add <dir> [<dir>...]
${quoted} project remove <id|path|name>

${quoted} run list [--project <id|path|name>]
${quoted} run get <name|id> [--project ...]
${quoted} run upsert --json <file|-> [--project ...]
${quoted} run remove <name|id> [--project ...]
\`\`\`

- \`project add\` 只接受本地目录。SSH 项目应通过 QingCode 的 SSH 项目对话框添加，使连接、
  主机指纹和远端根目录能够一起登记。
- 运行配置增删改查仅在数据库只有一个项目时可以省略 \`--project\`。
- 存在多个项目时，传入 \`project list\` 返回的 ID 或精确路径；名称只有在唯一时才能使用。
- 本地项目直接读写 \`<project>/.qingcode/run.json\`，不需要启动 QingCode。

### SSH 运行配置增删改查

路径以 \`ssh://\` 开头的项目同样使用 \`run list|get|upsert|remove\`，但必须先启动 QingCode。
CLI 会自动通过 GUI 中已认证的 SSH/SFTP 会话执行操作；绝不能把 \`ssh://\` URI 当成本地路径。

- 有多个项目时传入 \`--project <id|ssh-uri|唯一名称>\`。
- 如果退出码为 \`3\`，启动 QingCode 后重试。不要改写猜测出来的远端 \`.qingcode/run.json\`
  本地副本。
- 如果当前应用会话中没有 SSH 密码，请让用户在 QingCode 中重新打开并连接 SSH 项目；
  不要索要密码，也不要把密码写入 \`run.json\`。
- 首次成功保存时会自动创建远端 \`.qingcode\` 目录。

### 运行配置 JSON

\`run upsert --json -\` 从 stdin 读取。内容可以是配置对象，也可以是 \`{ "config": {...} }\`：

\`\`\`json
{
  "name": "前后端",
  "restoreWithProjectSession": false,
  "tasks": [
    { "name": "后端", "type": "command", "target": "cargo run", "cwd": "src-tauri" },
    { "name": "前端", "type": "command", "target": "pnpm dev" }
  ]
}
\`\`\`

创建时配置和任务的 \`id\` 可以省略，系统会自动生成。本地任务 \`type\` 支持：
\`ps1\` | \`bat\` | \`sh\` | \`command\` | \`script\`。SSH Linux 项目只能使用
\`command\`、\`sh\` 或 \`script\`；启动时会拒绝 \`ps1\`、\`bat\` 和 \`cmd\` 脚本。
可选字段 \`restoreWithProjectSession\` 默认为 \`false\`；设为 \`true\` 后，应用重启并恢复
项目会话时会重新启动关联的任务终端。

SSH 任务规则：

- 未填写 \`cwd\`：使用远端项目根目录。相对 \`cwd\`：相对于项目根目录。绝对 POSIX 路径
  （例如 \`/opt/service\`）仍使用同一个 SSH 连接。不要填写 Windows 路径。
- \`command\` 通过远端 POSIX \`/bin/sh -lc\` 运行；不要使用 CMD 或 PowerShell 语法。
- \`sh\` 使用 \`/bin/sh\` 运行目标。
- \`script\` 根据扩展名选择远端解释器：Python（\`.py\`）、Node/Bun
  （\`.js\`/\`.mjs\`/\`.cjs\`）、项目内或全局 \`tsx\`/Bun
  （\`.ts\`/\`.tsx\`/\`.mts\`/\`.cts\`），以及 \`.rb\`、\`.php\`、\`.pl\`、\`.bash\`、
  \`.zsh\`、\`.sh\` 对应的解释器。其他文件在可执行时直接运行，否则回退到 \`/bin/sh\`。
- \`env\` 的值必须是字符串，名称必须是有效的 POSIX 环境变量标识符。

### 更新运行配置

\`run upsert\` 会按 \`id\` 替换完整配置；未提供匹配 ID 时按精确 \`name\` 替换。
它不是局部更新。

1. 使用 \`run get\` 读取现有对象。
2. 保留其 \`id\`、任务、任务 ID、\`env\` 以及用户未要求修改的所有字段。
3. 应用用户要求的变更，并提交完整配置对象。
4. 再次使用 \`run get\` 验证结果。

## 在线执行（必须启动 QingCode GUI）

\`\`\`text
${quoted} project switch <id|path|name>
${quoted} run start <name|id> [--project ...]
${quoted} run stop <name|id> [--project ...]
${quoted} run status [--project ...]
${quoted} trust grant <path>
${quoted} open <file>[:line[:col]] ...
\`\`\`

- \`run start|stop|status\` 未提供 \`--project\` 时使用 GUI 当前项目。
- 如果退出码为 \`3\`，告诉用户先启动 QingCode；不要虚构无界面的运行器。SSH 项目的运行配置
  增删改查也遵循此规则。
- \`run start\` 执行所选配置中保存的命令。

## Agent 典型流程

1. 使用 \`project list\` 获取状态；通过 \`ssh://\` 路径识别 SSH 项目，然后执行
   \`run list --project <id>\`。
2. 创建配置；更新现有配置时遵循上面的完整对象更新流程。
3. 执行任务以及操作 SSH 运行配置前，确保 GUI 正在运行。
4. 启动配置后检查 \`run status\` 并报告结果。
5. 如果受限模式阻止执行，说明原因，并在执行 \`trust grant\` 前取得用户明确授权。

## 安全

- \`project add\` 和 \`run upsert\` 会写入持久状态，必须限制在用户请求范围内。对于 SSH
  项目，\`run upsert\` 会通过 SFTP 写入远端项目的 \`.qingcode/run.json\`。
- 只有用户明确要求删除时才能使用 \`project remove\` / \`run remove\`。
- \`project remove\` 只会删除 QingCode 数据库中的项目和最近文件记录，不会删除项目目录或文件。
- 绝不能隐式授予信任。确认准确的项目根目录，并取得用户明确授权。
- 不要使用此 CLI 执行打包、发布标签或强推。
- 命名工作区不在范围内——只操作用户数据库中的项目列表。
`
}

export function isChineseSkillLanguage(language: string): boolean {
  return /^zh(?:-|$)/i.test(language.trim())
}

export function buildQingcodeCliSkillMarkdown(exePath: string, language = 'en'): string {
  const bin = exePath.trim() || 'QingCode.exe'
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  return isChineseSkillLanguage(language) ? buildChineseSkill(quoted) : buildEnglishSkill(quoted)
}
