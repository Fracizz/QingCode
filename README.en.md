# QingCode

[中文](./README.md)

**QingCode** is a **project-management companion for the AI coding era** on Windows: multi-project switching, service startup, terminal sessions, and light editing in one window.  
It is not another VS Code or Zed — it focuses on keeping several local projects and their processes under control.

## Screenshots

### Explorer & editor

![Explorer and code editor](./docs/screenshots/en-01-explorer-editor.jpg)

### Search

![File content search](./docs/screenshots/en-02-search.jpg)

### Source Control

![Branch, changes, and diffs](./docs/screenshots/en-03-source-control.jpg)

### Run configurations

![Run configs and .qingcode/run.json](./docs/screenshots/en-04-run-config.jpg)

### Settings

![Theme and font settings](./docs/screenshots/en-05-settings.jpg)

### Manage projects

![Add, hide, and manage local projects](./docs/screenshots/en-06-manage-projects.jpg)

## Why QingCode

Coding increasingly happens alongside AI tools (Cursor, Claude, OpenCode, and others). What often slows you down is not “missing a heavier IDE”, but:

- Several local repos open at once, with context lost every time you switch windows  
- Each project needs a stack of services (API, web, workers, proxies…) that are easy to forget and hard to keep tidy in terminals  
- AI assistants, scripts, and local processes stay fragmented while project ops stay manual  

QingCode puts weight on **project ops and the running scene**: pin many projects, keep terminals with each project, and start services with run configurations. Editing, search, and Git review are enough to stay oriented; deep language intelligence stays with the AI tools you already use.

## What you get

### Multi-project switching

Pin folders in the title bar and switch with a click. Each project keeps its own file tree and terminals; leaving a project does not wipe unsaved buffers or terminal sessions. Overflow stays reachable, and you can save named multi-project workspaces.

### Run configurations: start project services

This is a core QingCode workflow. Define run configurations per project (stored in `.qingcode/run.json`):

- One configuration can hold multiple tasks (command / script / ps1 / bat / sh)  
- On launch, **each task opens its own terminal** — ideal for API + web + worker side by side  
- Per-task working directory and environment variables; stop a whole configuration at once  
- Unknown projects start restricted; trust is required before editing, running scripts, or using the terminal  

Typical loop: open a project → start a run configuration → services land in separate terminals → edit code or hand a terminal to an AI CLI.

### Terminal profiles: default shells and AI / tool entry points

Alongside run configurations, manage **terminal profiles** (name + startup command):

- Default PowerShell, or jump straight into a custom environment  
- Save common AI / dev CLIs (for example `opencode`) as profiles and pick them from the terminal “+” menu  
- Terminals default to the project root; switching projects does not close existing ones  

Run configurations answer “how do this project’s services start?”; terminal profiles answer “what should this shell open with?” — together they keep the local multi-project scene in one place.

### Focused file tree and light editing

The explorer shows only the active project. Create, rename, and delete in place; copy paths or file references; open a terminal in any folder.

Multi-tab editing with on-demand highlighting for common languages; auto-detect UTF-8 / BOM / GB18030-compatible text; external changes can be reloaded or compared instead of overwritten silently. Large files degrade or open read-only. Editor and terminal sessions restore after restart.

### Lightweight Git review

Source Control shows the branch, changed files, and diffs; compare any file side by side with HEAD. Chinese names, spaces, and renames use original paths. Commit and push can stay in your usual Git or AI tools — QingCode helps you see what changed first.

### Search and preferences

Search file names or contents in a chosen scope. Dark / light / forest / system theme; adjustable UI and editor fonts; Simplified Chinese or English UI. Global `default-settings.json` and project `.qingcode/project-settings.json` are **JSON5**; the template states that comments must not be deleted (see [HELP.md · Settings](./HELP.md#settings)).

## How it relates to VS Code / Zed

| | QingCode | VS Code | Zed |
|--|--|--|--|
| Role | Multi-project ops companion | Extensible platform editor | Native high-performance editor |
| Multi-project switching | Title-bar pins; sessions kept | Workspace-centric | Typical single-project focus |
| Service / task startup | **Multi-task run configs → many terminals** | Strong tasks / launch | Available, different shape |
| LSP / debug / marketplace | Intentionally not a full IDE | Full stack | Strong LSP, smaller ecosystem |
| AI | Not built-in; plays well with CLIs | Extensions or built-in | Built-in leaning |

QingCode **deliberately skips** full IntelliSense, a debugger, and an extension marketplace. Keep VS Code / Zed / Cursor for deep editing; use QingCode to manage which projects are open, which services are up, and which terminals are live.

## Typical flow

1. Add several local project folders and pin them in the title bar  
2. Create run configurations for common stacks (for example `dev` = API + web)  
3. Start services in one click; each task gets its own terminal  
4. Use terminal profiles to jump into an AI CLI or project script environment  
5. Switch projects from the title bar — editor and terminal state remain  

## Who it is for

- People who keep several local repos and frequently start/stop services  
- Developers already using AI coding tools who want a steadier local project / process companion  
- Anyone who would rather not launch a full IDE just to switch projects and bring services up  

## Get the app

Download from [GitHub Releases](https://github.com/Fracizz/QingCode/releases) or [Gitee Releases](https://gitee.com/FrancizTest_admin/qing-code/releases) (built by CI on `v*` tags):

| Platform | Arch | Recommended file |
|----------|------|------------------|
| Windows | x64 | `QingCode_*-windows-x64.exe` or `QingCode_*.exe` |
| Windows | ARM64 | `QingCode_*-windows-arm64.exe` |
| macOS | Apple Silicon (arm64) | `QingCode_*-macos-arm64.dmg` or `.zip` |

- Windows: portable exe or NSIS installer (`*-setup.exe`); needs [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/). The installer tries an automatic download first; on failure, Yes opens the bootstrapper download and No opens the product page  
- macOS: unsigned builds may need right-click → Open the first time  

Local packaging (Windows x64 host):

```bash
pnpm install
pnpm package                  # NSIS installer (x64 only)
# pnpm package:exe            # portable single-file exe
# pnpm package:fast           # skip frontend/icons; Rust only
```

Artifacts land in `release/`: `QingCode.exe` (portable), `QingCode-setup.exe` (installer). ARM64 / macOS multi-arch builds use `.github/workflows/release.yml`.

## Run from source

Needs Node.js 22+, pnpm 10+, Rust stable; WebView2 on Windows, Xcode CLT on macOS.

```bash
pnpm install
pnpm tauri:dev    # full desktop app
```

See [AGENTS.md](./AGENTS.md) for repo conventions and [HELP.md](./HELP.md) for usage documentation.

## Stack

Tauri 2 · React 19 · TypeScript · Vite · CodeMirror 6 · xterm.js · Zustand · Tailwind CSS · Rust

## License

[MIT](./LICENSE)
