# QingCode Help Documentation

> This document is for QingCode users, covering interface language, project management, editor, terminal, search, Git, run configurations, and other core features.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Interface Language](#interface-language)
- [Project Management](#project-management)
- [Editor](#editor)
- [Terminal](#terminal)
- [Search](#search)
- [Git Source Control](#git-source-control)
- [Run Configurations](#run-configurations)
- [Settings](#settings)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Check for Updates](#check-for-updates)
- [FAQ](#faq)
- [Language Pack Development](#language-pack-development)

---

## Quick Start

1. **Add a project**: Click the **「+」** button on the right side of the title bar and select a local folder to add to the project list.
2. **Switch projects**: Click a project chip in the title bar to switch; editor and terminal states are automatically preserved.
3. **Open a file**: Single-click a file in the left file tree to select it, then double-click (or press `Enter`) to open it in the editor.
4. **Open a terminal**: Press `` Ctrl+` `` to show the terminal panel; the terminal starts in the project root by default.
5. **Save a file**: Press `Ctrl+S` to save the current file.

---

## Interface Language

1. Click the **「Settings」** icon in the left activity bar.
2. Expand the **「Language」** category.
3. Select **「简体中文」** (Simplified Chinese) or **「English」**.

> Language settings are saved locally and automatically restored on the next startup.

---

## Project Management

### Add a Project

- Click the **「+」** button on the right side of the title bar and select a local folder.
- After adding, the project appears as a chip in the title bar; click to switch.

### Temporary Project

Suitable for quick notes or trying out commands without selecting an existing folder:

- Click **「New Temporary Project」** next to the **「+」** button in the title bar.
- Or, when no project is open, click **「New Terminal」** in the terminal panel to create one automatically.

| Comparison | Regular Project | Temporary Project |
|------------|-----------------|-------------------|
| Source | Select an existing local folder | Create an empty folder in the system temp directory |
| Persistence | Written to the project database, remains after restart | Not written to the database, disappears after restart |
| Project Management | Viewable and sortable in 「Project Management」 | Does not appear in 「Project Management」 |
| Trust Status | Requires manual trust selection on first open | Automatically considered trusted |

> Temporary project files are written to disk normally. After closing the application, the project entry disappears, but the files remain in the system temp directory.

### Remove a Project

- Click the `×` on the project chip to remove it (only removes from the list, does not delete disk files).
- In 「Project Management」, you can manage, sort, or hide projects in bulk.

---

## Editor

### Basic Operations

- **Open a file**: Single-click to select in the file tree, then double-click (or press `Enter`) to open.
- **Multi-select & arrange**: `Ctrl`/`Shift` multi-select; drag-drop or `Ctrl+X`/`C`/`V` to cut, copy, paste; `F2` for inline rename.
- **Switch tabs**: Click the tab bar, or use `Ctrl+Tab`.
- **Close a tab**: Click the `×` on the tab, or middle-click the tab.
- **Save a file**: `Ctrl+S`.
- **Unsaved indicator**: A yellow dot on the tab indicates unsaved changes; a save prompt appears before closing.

### Encoding Support

The editor automatically detects file encoding:

- **Auto-detect** (default): Detects in the order of BOM → UTF-8 → GB18030.
- **Manual switch**: The status bar shows the current encoding; click to reopen with a specified encoding or convert and save with a new encoding.
- Supports `utf8` / `utf8bom` / `utf16le` / `utf16be` / `gbk` / `gb18030` (`auto` can recognize UTF-16 with BOM; without BOM, manual specification is required).

### Large File Handling

- Files exceeding a certain size are automatically downgraded to read-only viewing to avoid lag.
- Very large files only provide a plain text viewing mode.

### Formatting

- **Manual formatting**: `Shift+Alt+F`, calls locally installed Prettier / rustfmt / shfmt / ruff·black / gofmt.
- **Format on save**: Enable `editor.formatOnSave` in settings.
- **Format on paste**: Enable `editor.formatOnPaste` in settings.

### Minimap

- A code overview appears on the right side of the editor (on by default) for structure awareness and quick jumps.
- **Toggle**: Settings → Text Editor → Minimap (`editor.minimap.enabled`), or `Ctrl+Shift+G` / Command Palette “Toggle Minimap”.
- **Interaction**: Click or drag to jump; hover for a Quick View of nearby source; drag the **left edge** to resize (same `PanelResizer` as the sidebar: `ew-resize`, line + grip); right-click to toggle “show minimap on scrollbar hover” and “hide editor scrollbar”.
- **Size tiers**: ≤1MB syntax-colored; 1–5MB density bars; hidden above 5MB. Not shown on diff tabs or the large-file viewer.

---

## Terminal

### Open Terminal

- `` Ctrl+` ``: Show or hide the terminal panel.
- Click the **「+」** at the top of the terminal panel to create a new terminal tab.
- The terminal starts in the project root by default.

### Terminal Profiles

You can configure default startup commands for terminals:

1. Open **「Settings」** → **「Features」** → **「Terminal Profiles」**.
2. Add a profile (name + startup command).
3. When creating a new terminal, right-click the **「+」** button to select a profile.

> Common scenario: one-click entry into an AI CLI (e.g., `opencode`) or a project-specific script environment. Same as a normal terminal: a shell starts first, the startup command is typed automatically, and you can keep typing after it exits.

### Relationship Between Run Configurations and Terminal Profiles

- **Run configurations**: Manage "how to start project services", launching multiple service tasks with one click.
- **Terminal profiles**: Manage "what this shell runs by default", controlling the initial environment of a single terminal.

---

## Search

### Open Search

- `Ctrl+Shift+F`: Open the search panel.
- Searches in the current project by default; you can manually switch to 「All Projects」.

### Search Scope

- **File name search**: Quickly locate files.
- **File content search**: Search for text content within the project.
- Supports filtering by `.gitignore` and other ignore files (can be disabled).

---

## Git Source Control

### View Changes

1. Click the **「Source Control」** icon in the left activity bar (displays the current number of Git changes).
2. View the modification list and branch information.
3. Click a file to see the diff comparison with HEAD.

### Supported Scenarios

- File diffs with Chinese characters, spaces, and renamed paths.
- Files in untracked, modified, staged, and deleted states.

> Committing and pushing are recommended to be done in your familiar Git tool or AI assistant.

---

## Run Configurations

Configure a set of 「run configurations」 for a project to start multiple services with one click:

### Create a Run Configuration

1. Open **「Settings」** → **「Run Configurations」**.
2. Click **「Add Configuration」** and enter a configuration name.
3. Add tasks (command / script / ps1 / bat / sh) under the configuration.

### Launch a Run Configuration

- Click the **「Launch」** button on the configuration card.
- Each task automatically opens a terminal, ideal for starting API, frontend, worker, etc. simultaneously.
- Click **「Stop」** to stop all tasks in the configuration group.

### Configuration Storage Location

Run configurations are saved in `.qingcode/run.json` in the project root, making them easy to manage alongside the project.

---

## Settings

### Settings Levels

| Scope | Location | Description |
|-------|----------|-------------|
| User Settings | Application data directory `default-settings.json` | Applies to all projects |
| Workspace Settings | Project root `.qingcode/project-settings.json` | Only for the current project; overrides global settings with the same name |

### File format (JSON5)

Both `default-settings.json` and `.qingcode/project-settings.json` are **JSON5** (not strict JSON):

- `//` and `/* */` comments, trailing commas, and unquoted keys are allowed.
- The default template includes per-key explanations and states in its header that **comments must not be deleted** (file header and per-key notes).
- When editing by hand, keep JSON5 syntax (QingCode parses these files as JSON5).
- Release path example: `%APPDATA%\com.qingcode.app\default-settings.json`; in development: project `.dev/default-settings.json`.

### Common Settings

- **Editor**: `editor.fontSize`, `editor.tabSize`, `editor.wordWrap`, `editor.lineNumbers`
- **Files**: `files.autoSave`, `files.exclude`, `files.encoding`
- **Search**: `search.exclude`, `search.useIgnoreFiles`
- **Terminal**: `terminal.integrated.scrollback`, `terminal.integrated.cursorBlinking`

### Edit Settings

1. Press `Ctrl+,` to open the settings panel.
2. Toggle between 「User / Workspace」 at the top.
3. Use the search box to filter settings, or click the JSON icon in the top-right corner to edit the raw **JSON5** (comments allowed).

---

## Keyboard Shortcuts

### Common Shortcuts

| Shortcut | Function |
|----------|----------|
| `Ctrl+S` | Save current file |
| `Ctrl+Shift+F` | Open search panel |
| `` Ctrl+` `` | Show/hide terminal panel |
| `Ctrl+,` | Open settings panel |
| `Ctrl+Shift+C` | Copy full file path |
| `Alt+C` | Copy as file reference (with line number range) |
| `Shift+Alt+F` | Format current file |

### Custom Shortcuts

1. Open **「Settings」** → **「Keyboard Shortcuts」**.
2. Click the shortcut input box you want to modify.
3. Press the new key combination directly to save.
4. Click **「Restore Default Shortcuts」** to revert to defaults.

> Editor-reserved shortcuts (e.g., `Ctrl+S`, `Ctrl+Shift+C`) are displayed as read-only and cannot be modified.

---

## Check for Updates

### Automatic Check

- The stable version automatically queries the latest release approximately 3 seconds after startup.
- When a new version is found, it prompts to open the download page (does not auto-install).

### Manual Check

- **Settings** → **「Features」** → **「Check for Updates」** button.
- Or click the version number in the bottom-right corner of the status bar.

### Disable Automatic Check

- **Settings** → **「Features」** → **「Auto-check for updates on startup」** → select **「Off」**.

---

## FAQ

### Project cannot be edited / Terminal cannot be used

Untrusted projects restrict editing, terminal, and script execution capabilities. Click **「Trust」** in the prompt to resolve.

### File encoding shows garbled text

- The status bar displays the currently detected encoding.
- Click the encoding to select 「Reopen with Encoding」 (reads with the new encoding without saving) or 「Save with Encoding」.

### External tool modified a file being edited

- Clean tabs (no modifications) are automatically reloaded.
- Dirty tabs (with unsaved modifications) prompt to compare differences, reload, or keep local modifications.

### How to keep temporary project files long-term

- Copy the temporary project folder to a permanent directory in your file manager.
- Then use **「Add Project」** to add that directory to the project list.

---

## Language Pack Development

Built-in language packs are located in `src/locales/`. To add a new language:

1. Add the corresponding JSON file (refer to `zh-CN.json` / `en.json`).
2. Register the language pack and language code in `src/lib/i18n.ts`.
3. The settings page will automatically read registered language packs.

---

> For more technical details, see [README.en.md](./README.en.md) and [DESIGN.md](./DESIGN.md).
