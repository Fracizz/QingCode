# QingCode

[中文](./README.md) · [Settings help (中文)](./帮助文档.md)

A lightweight, native desktop code editor. QingCode is built for developers who juggle multiple local projects — project switching, file management, editing, and terminals live in one focused Windows app.

> Current version **0.1.0** · [Download releases](https://github.com/Fracizz/QingCode/releases) · [Changelog](./CHANGELOG.md)

## Features

### Work across multiple projects

Pin projects in the title bar and switch like tabs. Overflow projects stay reachable; add, remove, relocate, or reveal them in File Explorer anytime.

### Browse and manage local files

The explorer shows only the active project. From the tree you can:

- Create files or folders
- Rename or delete files and folders
- Copy full paths or file references
- Open a terminal in a chosen directory

### Stay focused while coding

Open multiple files at once; unsaved buffers are clearly marked and save with `Ctrl+S`. Languages load on demand, including JavaScript, TypeScript, JSON, Markdown, CSS, HTML, and Python.

### Terminals that stay with the project

Each project can keep multiple terminal tabs, starting in the project root by default. Switching projects does not close existing terminals — return later and continue.

### Find files and content quickly

Search by file name or file contents within a chosen directory scope.

### Save how you run things

Create run configurations for project scripts and launch them in the terminal with one action.

### Make it yours

Dark, light, or system theme; adjustable UI and editor fonts; Simplified Chinese or English UI. Preferences persist locally.

## Typical flow

1. Add a local project folder.
2. Browse, create, or edit files in the explorer.
3. Open a terminal and run commands from the project root.
4. Switch projects from the title bar — terminals and editor state stay available.

## Download

Primary support: **Windows 10/11** (x64).

1. Open [Releases](https://github.com/Fracizz/QingCode/releases).
2. Download the latest `QingCode_<version>.exe` (or `QingCode.exe`).
3. Run it — no installer required.

[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is required (usually preinstalled on recent Windows 10/11).

## Who it is for

Developers who want a light desktop tool for everyday viewing, editing, file ops, and terminals — especially when maintaining several local projects at once.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://www.rust-lang.org/) stable (with Cargo)
- Windows + WebView2

### Commands

```bash
pnpm install          # Install frontend deps
pnpm tauri:dev        # Full desktop app (recommended)
pnpm dev              # Vite UI only (layout work)
pnpm build            # Typecheck + frontend bundle
pnpm check            # Frontend types + Rust fmt/tests
pnpm package:exe      # Build portable Windows exe into release/
```

Outputs:

- `release/QingCode_<version>.exe` — versioned binary
- `release/QingCode.exe` — latest copy

Rust-only changes (skip frontend rebuild):

```bash
pnpm package:exe:fast
```

### Layout

| Path | Purpose |
| --- | --- |
| `src/` | React frontend (components, Zustand, Tauri wrappers) |
| `src-tauri/` | Rust / Tauri backend and capabilities |
| `scripts/` | Windows dev and packaging helpers |
| `帮助文档.md` | Locale packs and settings guide (Chinese) |
| `DESIGN.md` | UI and interaction conventions |

## Releasing

Keep the version in sync in:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

### Local release

```powershell
# 1. Bump version (example: 0.1.1)
pnpm bump:version 0.1.1

# 2. Update CHANGELOG.md, commit, push
git add -A
git commit -m "chore: release v0.1.1"
git push origin master
git push github master   # if you also push to GitHub

# 3. Tag and push (triggers GitHub Actions build + Release)
git tag v0.1.1
git push github v0.1.1
```

Or validate + create the tag in one step (does not push):

```powershell
pnpm release:tag 0.1.1
```

### CI release

Pushing a tag like `v0.1.1` to GitHub runs the [Release](./.github/workflows/release.yml) workflow, which:

1. Builds with `pnpm package:exe` on `windows-latest`
2. Creates a [GitHub Release](https://github.com/Fracizz/QingCode/releases) and uploads the exe
3. If `GITEE_TOKEN` is configured, mirrors the same assets to [Gitee Releases](https://gitee.com/FrancizTest_admin/qing-code/releases)

#### One-time Gitee sync setup

1. Create a Gitee [private token](https://gitee.com/profile/personal_access_tokens) with `projects` scope.
2. In the GitHub repo: Settings → Secrets and variables → Actions → New secret:
   - Name: `GITEE_TOKEN`
   - Value: the token from step 1
3. Later `v*` tags will publish to both GitHub and Gitee.

Local upload (requires `release/` artifacts and `GITEE_TOKEN` in the environment):

```powershell
pnpm gitee:release 0.1.0
```

## Related docs

- [中文 README](./README.md)
- [Changelog](./CHANGELOG.md)
- [Settings help (中文)](./帮助文档.md)
- [Design notes](./DESIGN.md)
- [Repository guidelines](./AGENTS.md)

## Stack

Tauri 2 · React 19 · TypeScript · Vite · CodeMirror 6 · xterm.js · Zustand · Tailwind CSS · Rust
