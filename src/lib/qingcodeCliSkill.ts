/**
 * Copyable AI Skill text for QingCode CLI.
 * Not bundled for any specific agent — users paste/install it themselves.
 */

export function buildQingcodeCliSkillMarkdown(exePath: string): string {
  const bin = exePath.trim() || 'QingCode.exe'
  const quoted = bin.includes(' ') ? `"${bin}"` : bin

  return `---
name: qingcode-cli
description: >-
  Drive QingCode via QingCode.exe subcommands for multi-project management and
  run-config CRUD/start/stop. Use when the user asks to add projects, list
  projects, edit .qingcode/run.json run configs, start or stop a run
  configuration, grant workspace trust, or open files in a running QingCode
  instance.
---

# QingCode CLI

Install this file into your AI agent as a Skill / custom instruction (path and
format depend on that product). QingCode only provides the text — it does not
auto-register with any agent.

Prefer these subcommands over hand-editing SQLite or guessing UI steps.

## Binary

\`${quoted}\`

## Output contract

- stdout: JSON \`{ ok, data?, error? }\`
- exit: \`0\` ok · \`1\` error · \`2\` usage · \`3\` app not running

## Offline (no GUI required)

\`\`\`text
${quoted} project list
${quoted} project add <dir> [<dir>...]
${quoted} project remove <id|path|name>

${quoted} run list [--project <id|path|name>]
${quoted} run get <name|id> [--project ...]
${quoted} run upsert --json <file|-> [--project ...]
${quoted} run remove <name|id> [--project ...]
\`\`\`

- Multiple projects: always pass \`--project\` for \`run *\`.
- \`run upsert --json -\` reads stdin. Body is a config object:

\`\`\`json
{
  "name": "前后端",
  "tasks": [
    { "name": "后端", "type": "command", "target": "cargo run", "cwd": "src-tauri" },
    { "name": "前端", "type": "command", "target": "pnpm dev" }
  ]
}
\`\`\`

\`id\` optional (auto-generated). Task \`type\`: \`ps1\` | \`bat\` | \`sh\` | \`command\` | \`script\`.

## Online (QingCode GUI must be running)

\`\`\`text
${quoted} project switch <id|path|name>
${quoted} run start <name|id> [--project ...]
${quoted} run stop <name|id> [--project ...]
${quoted} run status [--project ...]
${quoted} trust grant <path>
${quoted} open <file>[:line[:col]] ...
\`\`\`

- If \`--project\` is omitted online, the GUI **current project** is used.
- If exit \`3\`, tell the user to start QingCode first; do not invent a headless runner.

## Typical agent flow

1. \`project list\` → \`project add\` (batch paths OK)
2. \`trust grant <path>\` (online; avoids trust dialogs before run)
3. \`run upsert --json ...\`
4. Ensure GUI is running → \`run start\` → \`run status\`

## Safety

- \`project remove\` / \`run remove\` only when the user clearly asked to delete
- Do not use this CLI for packaging, release tags, or force-push
- Named workspaces are out of scope — only the user DB project list
`
}
