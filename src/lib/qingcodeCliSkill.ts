/**
 * Canonical source for the copyable QingCode CLI Skill.
 * Run `pnpm skill:sync` after changing this template to refresh the repository
 * snapshot at `.agents/skills/qingcode-cli/SKILL.md`.
 */

export const QINGCODE_CLI_REPO_BINARY = String.raw`.\src-tauri\target\debug\qingcode.exe`

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

Prefer these subcommands over hand-editing SQLite, directly rewriting
\`.qingcode/run.json\`, or guessing UI steps.

## Binary

\`${quoted}\`

## Output contract

- Command results write JSON \`{ ok, data?, error? }\` to stdout; \`--help\` writes plain text.
- Exit: \`0\` ok · \`1\` error · \`2\` usage · \`3\` app not running.
- Check both the exit code and \`ok\`; surface \`error\` to the user instead of guessing.

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

- For offline \`run *\`, \`--project\` may be omitted only when the database has exactly one project.
- With multiple projects, pass an ID or exact path from \`project list\`; use a name only when unique.
- \`run upsert --json -\` reads stdin. The body may be a config object or \`{ "config": {...} }\`:

\`\`\`json
{
  "name": "前后端",
  "tasks": [
    { "name": "后端", "type": "command", "target": "cargo run", "cwd": "src-tauri" },
    { "name": "前端", "type": "command", "target": "pnpm dev" }
  ]
}
\`\`\`

Config and task \`id\` values are optional when creating and are auto-generated. Task \`type\`:
\`ps1\` | \`bat\` | \`sh\` | \`command\` | \`script\`.

### Updating a run config

\`run upsert\` replaces the complete matching config by \`id\`, or by exact \`name\` when no
matching ID is supplied. It is not a partial patch.

1. Read the existing object with \`run get\`.
2. Preserve its \`id\`, tasks, task IDs, \`env\`, and every field the user did not ask to change.
3. Apply the requested changes and upsert the complete config object.
4. Read it again with \`run get\` and verify the result.

## Online (QingCode GUI must be running)

\`\`\`text
${quoted} project switch <id|path|name>
${quoted} run start <name|id> [--project ...]
${quoted} run stop <name|id> [--project ...]
${quoted} run status [--project ...]
${quoted} trust grant <path>
${quoted} open <file>[:line[:col]] ...
\`\`\`

- If \`--project\` is omitted for online \`run *\`, the GUI current project is used.
- If exit \`3\`, tell the user to start QingCode first; do not invent a headless runner.
- \`run start\` executes the commands stored in the selected config.

## Typical agent flow

1. Discover state with \`project list\` and \`run list\`; add a project only when needed.
2. Create a config, or use the full-object update flow above for an existing config.
3. Ensure the GUI is running before any online command.
4. Start the config, then inspect \`run status\` and report the result.
5. If restricted mode blocks execution, explain it and ask for explicit approval before \`trust grant\`.

## Safety

- \`project add\` and \`run upsert\` write persistent state; keep them within the user's request.
- Use \`project remove\` / \`run remove\` only when the user clearly asked to delete.
- \`project remove\` removes the project and recent-file records from QingCode's database; it does
  not delete the project directory or its files.
- Never grant trust implicitly. Confirm the exact project root and obtain explicit user approval.
- Do not use this CLI for packaging, release tags, or force-push.
- Named workspaces are out of scope — only the user DB project list.
`
}
