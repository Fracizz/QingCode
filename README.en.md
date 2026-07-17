# QingCode

[中文](./README.md)

**QingCode** is a lightweight desktop code editor for Windows.  
Multiple projects, file browsing, editing, and terminals live in one window — less app switching, more time writing code.

## Screenshots

### Explorer & editor

![Explorer and code editor](./docs/screenshots/01-explorer-editor.jpg)

### Search

![File content search](./docs/screenshots/02-search.jpg)

### Editor & terminal

![Editor, run configs, and terminal](./docs/screenshots/03-editor-terminal.jpg)

### Settings

![Theme and font settings](./docs/screenshots/04-settings.jpg)

## Why QingCode

Most editors assume a single workspace. QingCode is built for **working across several local projects at once**: switch from the title bar like tabs, keep each project’s file tree and terminals, and never wipe the scene when you leave.

It stays light: a native shell, languages loaded on demand, no bloated marketplace. Built for everyday reading, editing configs, and running scripts — not for launching a full IDE for every small task.

## What you get

### Multi-project switching

Pin folders in the title bar and switch with a click. Overflow stays reachable; add, remove, relocate, or reveal in File Explorer anytime.

### A focused file tree

The explorer shows only the active project. Create, rename, and delete in place; copy paths or file references; open a terminal in any folder.

### Straightforward editing

Multiple file tabs, clear dirty markers, save with `Ctrl+S`. Common languages load on demand — JavaScript, TypeScript, JSON, Markdown, CSS, HTML, Python, and more.

### Terminals that stay with the project

Each project can keep several terminal tabs, starting in the project root by default. Switching projects does not close them — come back and continue.

### Search and run

Search file names or contents in a chosen scope. Save run configurations for common scripts and launch them in the terminal in one step.

### Make it yours

Dark / light / system theme; adjustable UI and editor fonts; Simplified Chinese or English UI. Global and project settings live on disk (JSON5 with comments).

## Typical flow

1. Add a local project folder  
2. Browse, create, or open files in the sidebar  
3. Open a terminal when you need the shell  
4. Switch projects from the title bar — editor and terminal state remain

## Get the app

Primary support: **Windows 10 / 11 (x64)**.

- Portable build: download `QingCode.exe` (or a versioned copy) and run — no installer  
- Requires [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (usually preinstalled on recent Windows)

Build from source locally:

```bash
pnpm install
pnpm package:exe
```

Artifacts land in `release/`.

## Who it is for

- Developers who keep several local repos or work folders open  
- Anyone who wants a light “open, edit, run” desktop tool  
- People who would rather not start a full IDE for a small change  

## Run from source

Needs Node.js 22+, pnpm 10+, Rust stable, Windows + WebView2.

```bash
pnpm install
pnpm tauri:dev    # full desktop app
```

See [AGENTS.md](./AGENTS.md) for repo conventions and [帮助文档.md](./帮助文档.md) for settings (Chinese).

## Stack

Tauri 2 · React 19 · TypeScript · Vite · CodeMirror 6 · xterm.js · Zustand · Tailwind CSS · Rust
