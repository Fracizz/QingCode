---
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

`D:\code\qingcode\src-tauri\target\debug\qingcode.exe`

## Output contract

- stdout: JSON `{ ok, data?, error? }`
- exit: `0` ok · `1` error · `2` usage · `3` app not running

## Offline (no GUI required)

```text
D:\code\qingcode\src-tauri\target\debug\qingcode.exe project list
D:\code\qingcode\src-tauri\target\debug\qingcode.exe project add <dir> [<dir>...]
D:\code\qingcode\src-tauri\target\debug\qingcode.exe project remove <id|path|name>

D:\code\qingcode\src-tauri\target\debug\qingcode.exe run list [--project <id|path|name>]
D:\code\qingcode\src-tauri\target\debug\qingcode.exe run get <name|id> [--project ...]
D:\code\qingcode\src-tauri\target\debug\qingcode.exe run upsert --json <file|-> [--project ...]
D:\code\qingcode\src-tauri\target\debug\qingcode.exe run remove <name|id> [--project ...]
```

- Multiple projects: always pass `--project` for `run *`.
- `run upsert --json -` reads stdin. Body is a config object:

```json
{
  "name": "前后端",
  "tasks": [
    { "name": "后端", "type": "command", "target": "cargo run", "cwd": "src-tauri" },
    { "name": "前端", "type": "command", "target": "pnpm dev" }
  ]
}
```

`id` optional (auto-generated). Task `type`: `ps1` | `bat` | `sh` | `command` | `script`.

## Online (QingCode GUI must be running)

```text
D:\code\qingcode\src-tauri\target\debug\qingcode.exe project switch <id|path|name>
D:\code\qingcode\src-tauri\target\debug\qingcode.exe run start <name|id> [--project ...]
D:\code\qingcode\src-tauri\target\debug\qingcode.exe run stop <name|id> [--project ...]
D:\code\qingcode\src-tauri\target\debug\qingcode.exe run status [--project ...]
D:\code\qingcode\src-tauri\target\debug\qingcode.exe trust grant <path>
D:\code\qingcode\src-tauri\target\debug\qingcode.exe open <file>[:line[:col]] ...
```

- If `--project` is omitted online, the GUI **current project** is used.
- If exit `3`, tell the user to start QingCode first; do not invent a headless runner.

## Typical agent flow

1. `project list` → `project add` (batch paths OK)
2. `trust grant <path>` (online; avoids trust dialogs before run)
3. `run upsert --json ...`
4. Ensure GUI is running → `run start` → `run status`

## Safety

- `project remove` / `run remove` only when the user clearly asked to delete
- Do not use this CLI for packaging, release tags, or force-push
- Named workspaces are out of scope — only the user DB project list
