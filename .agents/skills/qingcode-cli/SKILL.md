---
name: qingcode-cli
description: >-
  Drive QingCode via QingCode.exe subcommands for multi-project management and
  local/SSH run-config CRUD and start/stop. Use when the user asks to add
  projects, list projects, edit .qingcode/run.json run configs, start or stop a
  run configuration, grant workspace trust, open files in a running QingCode
  instance, or Windows cannot reach a frontend after starting an SSH/WSL run.
---

# QingCode CLI

Install this file into your AI agent as a Skill / custom instruction (path and
format depend on that product). QingCode only provides the text — it does not
auto-register with any agent.

Prefer these subcommands over hand-editing SQLite, directly rewriting
`.qingcode/run.json`, or guessing UI steps.

## Binary

`.\src-tauri\target\debug\qingcode.exe`

## Output contract

- Command results write JSON `{ ok, data?, error? }` to stdout; `--help` writes plain text.
- Exit: `0` ok · `1` error · `2` usage · `3` app not running.
- Check both the exit code and `ok`; surface `error` to the user instead of guessing.

## Project and local run-config commands

These commands do not require the GUI for local projects:

```text
.\src-tauri\target\debug\qingcode.exe project list
.\src-tauri\target\debug\qingcode.exe project add <dir> [<dir>...]
.\src-tauri\target\debug\qingcode.exe project remove <id|path|name>

.\src-tauri\target\debug\qingcode.exe run list [--project <id|path|name>]
.\src-tauri\target\debug\qingcode.exe run get <name|id> [--project ...]
.\src-tauri\target\debug\qingcode.exe run upsert --json <file|-> [--project ...]
.\src-tauri\target\debug\qingcode.exe run remove <name|id> [--project ...]
```

- `project add` accepts local directories only. Add SSH projects through QingCode's SSH project
  dialog so the connection, host fingerprint, and remote root are registered together.
- For run-config CRUD, `--project` may be omitted only when the database has exactly one project.
- With multiple projects, pass an ID or exact path from `project list`; use a name only when unique.
- Local project run-config CRUD reads and writes `<project>/.qingcode/run.json` directly without
  starting QingCode.

### SSH run-config CRUD

The same `run list|get|upsert|remove` syntax works for projects whose path starts with `ssh://`,
but QingCode must be running. The CLI automatically routes these operations through the GUI's
authenticated SSH/SFTP session; it must never treat an `ssh://` URI as a local filesystem path.

- Pass `--project <id|ssh-uri|unique-name>` when more than one project exists.
- If exit `3`, start QingCode and retry. Do not directly rewrite a guessed local copy of the
  remote `.qingcode/run.json`.
- If the SSH password is not available in the current app session, ask the user to reconnect by
  opening the SSH project in QingCode; do not request or place a password in `run.json`.
- The remote `.qingcode` directory is created automatically on the first successful save.

### Run-config JSON

- `run upsert --json -` reads stdin. The body may be a config object or `{ "config": {...} }`:

```json
{
  "name": "前后端",
  "restoreWithProjectSession": false,
  "tasks": [
    { "name": "后端", "type": "command", "target": "cargo run", "cwd": "src-tauri" },
    { "name": "前端", "type": "command", "target": "pnpm dev" }
  ]
}
```

Config and task `id` values are optional when creating and are auto-generated. Local task `type`:
`ps1` | `bat` | `sh` | `command` | `script`. For SSH Linux projects use only `command`, `sh`, or
`script`; `ps1`, `bat`, and `cmd` scripts are unsupported and will be rejected when started.
The optional `restoreWithProjectSession` field defaults to `false`; set it to `true`
to restore and restart linked task terminals with the project session after an app restart.

SSH task rules:

- `cwd` omitted: remote project root. Relative `cwd`: relative to that root. An absolute POSIX
  `cwd` such as `/opt/service` stays on the same SSH connection. Do not use Windows paths.
- `command` runs through remote POSIX `/bin/sh -lc`; do not write CMD or PowerShell syntax.
- `sh` runs the target with `/bin/sh`.
- `script` selects a remote interpreter by extension: Python (`.py`), Node/Bun
  (`.js`/`.mjs`/`.cjs`), project/global `tsx` or Bun (`.ts`/`.tsx`/`.mts`/`.cts`), and the
  corresponding interpreter for `.rb`, `.php`, `.pl`, `.bash`, `.zsh`, or `.sh`. Other files
  run directly when executable and otherwise fall back to `/bin/sh`.
- `env` values must be strings and names must be valid POSIX environment identifiers.

### Windows access to SSH/WSL services

When QingCode runs on Windows and the project is WSL/SSH, the local browser can only
reach services through WSL localhost forwarding.

- Bind dev servers to `127.0.0.1`. Binding `0.0.0.0` / `vite --host` / `host: true`
  makes `http://127.0.0.1:<port>` fail from Windows.
- Use `vite --host 127.0.0.1` (or equivalent); do not bind all interfaces for LAN access.
- After start, verify from **Windows** at `http://127.0.0.1:<actual-port>`. The WSL eth0
  IP often does not work on the same machine.
- Confirm the listener belongs to the current project; do not use another project's port.

### Updating a run config

`run upsert` replaces the complete matching config by `id`, or by exact `name` when no
matching ID is supplied. It is not a partial patch.

1. Read the existing object with `run get`.
2. Preserve its `id`, tasks, task IDs, `env`, and every field the user did not ask to change.
3. Apply the requested changes and upsert the complete config object.
4. Read it again with `run get` and verify the result.

## Online execution (QingCode GUI must be running)

```text
.\src-tauri\target\debug\qingcode.exe project switch <id|path|name>
.\src-tauri\target\debug\qingcode.exe run start <name|id> [--project ...]
.\src-tauri\target\debug\qingcode.exe run stop <name|id> [--project ...]
.\src-tauri\target\debug\qingcode.exe run status [--project ...]
.\src-tauri\target\debug\qingcode.exe trust grant <path>
.\src-tauri\target\debug\qingcode.exe open <file>[:line[:col]] ...
```

- If `--project` is omitted for `run start|stop|status`, the GUI current project is used.
- If exit `3`, tell the user to start QingCode first; do not invent a headless runner. This also
  applies to run-config CRUD for SSH projects.
- `run start` executes the commands stored in the selected config.

## Typical agent flow

1. Discover state with `project list`; identify SSH projects by their `ssh://` path, then use
   `run list --project <id>`.
2. Create a config, or use the full-object update flow above for an existing config.
3. Ensure the GUI is running before execution and before any SSH run-config CRUD command.
4. Start the config, then inspect `run status`. For SSH/WSL projects, also verify
   `http://127.0.0.1:<port>` from Windows (the server must bind `127.0.0.1`).
5. If restricted mode blocks execution, explain it and ask for explicit approval before `trust grant`.

## Safety

- `project add` and `run upsert` write persistent state; keep them within the user's request. For
  SSH projects, `run upsert` writes the remote project's `.qingcode/run.json` over SFTP.
- Use `project remove` / `run remove` only when the user clearly asked to delete.
- `project remove` removes the project and recent-file records from QingCode's database; it does
  not delete the project directory or its files.
- Never grant trust implicitly. Confirm the exact project root and obtain explicit user approval.
- Do not use this CLI for packaging, release tags, or force-push.
- Named workspaces are out of scope — only the user DB project list.
