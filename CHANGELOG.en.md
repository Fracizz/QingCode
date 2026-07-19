# Changelog

User-visible changes for QingCode. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [Semantic Versioning](https://semver.org/).

Chinese version: [CHANGELOG.md](./CHANGELOG.md).

## [Unreleased]

## [0.1.4] - 2026-07-19

### Added

- Editor minimap (CodeGlance-inspired): Lezer syntax colors, caret line, hover Quick View, right-click quick config, `Ctrl+Shift+G` toggle; setting `editor.minimap.enabled` (on by default; ≤1MB full / 1–5MB density / >5MB hidden)
- Find in terminal (`Ctrl+F`) and clear buffer (`Ctrl+Shift+K` / context menu / command palette)
- Global default terminal shell (Settings → Terminal): Windows defaults to `pwsh` (cmd / WSL / Windows PowerShell available); macOS/Linux defaults to `zsh` (Bash / pwsh available); built-in Ordinary Terminal follows this setting; custom profiles may override
- Terminal busy detection: ignore console-host noise children; honor shell-integration OSC 133/633 “command running”; only one-shot run tasks stay always-busy
- VS-style large-file editing tiers: full / degraded / plain-text / read-only by file size to reduce freezes on huge files
- Workspace trust: untrusted projects restrict high-risk capabilities when opening unfamiliar repos
- Document formatting: `Shift+Alt+F` runs Prettier / rustfmt / shfmt / ruff·black / gofmt when installed locally
- `editor.formatOnSave`: format with the same formatters before save (failures do not block save)
- `editor.formatOnPaste`: quiet format-after-paste (skips large files / unsupported languages)
- `editor.bracketPairColorization.enabled` / `editor.guides.bracketPairs`: nested bracket colors and active pair guides
- `files.exclude` / `search.exclude`: explorer and search honor exclude rules from settings JSON
- `explorer.excludeGitIgnore` / `search.useIgnoreFiles`: filter via `.gitignore` and similar ignore files (toggleable)
- `search.followSymlinks`: whether search follows symlinks (default `false`)
- `files.encoding`: default `auto` detection (UTF-8/UTF-16 BOM / UTF-8 / GB18030 fallback); open/save supports `utf8` / `utf8bom` / `utf16le` / `utf16be` / `gbk` / `gb18030`; status bar can reopen or convert on save
- `terminal.integrated.scrollback`: cap xterm buffer and persist recent output across restarts
- `terminal.integrated.cursorBlinking`: control terminal cursor blink
- Command palette, multi-project workspace, symbol jump, lightweight Git status / compare with HEAD, and related capabilities
- Quick Open and temporary projects for faster folder / short-lived workspace access
- Update check: release builds can auto-query Gitee/GitHub Releases on launch; disable auto-check or check manually in Settings; prompts only open the download page
- Multi-arch GitHub Release builds: Windows x64 / Windows ARM64 (`windows-11-arm`) / macOS Apple Silicon arm64 (`macos-14`, dmg + app zip)
- Windows NSIS installer script (`pnpm package:installer`)
- Bilingual README screenshots (explorer, search, source control, run configs, settings, project manager)
- Everforest theme and VS Code–style auto save
- Full Chinese and English help docs, switched with UI language

### Fixed

- Keyboard access for project chips and editor/terminal tabs; Escape closes the project-add dialog; settings activity-bar active state
- Terminal kill/write failures surface as toasts instead of being swallowed
- Windows `pnpm tauri:dev`: host Vite outside Tauri so a dying `beforeDevCommand` no longer tears down the whole session
- Source Control resolves Git path records correctly for Chinese names, spaces, and renames
- Startup white screen caused by Diff theme
- Expanded folder children cleared when a root refresh finishes after directory expansion
- Follow-up stability/UX fixes for release editor/terminal (format hints, interaction details, etc.)

### Changed

- Local packaging unified as `pnpm package`: one pass builds Windows x64 portable + NSIS installer (ARM64/macOS remain CI)
- Hover tips use in-app `Tooltip` only (no DOM `title`); terminal launch command tip moved to tab hover instead of a permanent banner
- Terminal profiles launch via a single `interactive` spawn path (keep shell after command); auto-respawn prompt when OpenCode tears down ConPTY; PTY created after xterm fit with real size
- Reserved settings keys that will not be implemented (e.g. linked editing) are marked “not planned”; minimap and other common keys are wired up
- Help docs follow UI language: Chinese UI shows `帮助文档.md`, non-Chinese shows `HELP.md`
- Terminal collapse/close; tooltips appear after ~2s hover; window button labels are localized
- Faster Source Control panel open with large change sets

## [0.1.3] - 2026-07-17

### Added

- Create a terminal without a current project: pick an existing project or create a temporary workspace
- Status bar shows app version (`dev` marker on development builds)

### Fixed

- Split Windows TTC multi-face registry font names (e.g. “Microsoft YaHei & Microsoft YaHei UI”)
- Editor monospace font setting actually applied to CodeMirror (`.cm-scroller`)
- Terminal font/size updates more reliably with settings
- OpenCode and similar TUI block glyphs / overlapping titles under release WebView2 (WebGL glyph rendering + safer monospace stack)
- Invisible/misaligned editor body in release builds: CSP `style-src` nonce blocked CodeMirror runtime styles

## [0.1.2] - 2026-07-17

### Added

- Choose installed system fonts in Settings
- Keybinding settings show editor-reserved actions (`Alt+C` copy file reference, `Ctrl+Shift+C` copy path)

### Fixed

- Splash / early window show flicker; shorter splash wait
- Settings font dropdown squeezing the title into a vertical single character
- Vite forbidding `?raw` SVG imports from `public/`
- Duplicate editor font-size controls under Common and Text Editor

### Changed

- App icon artwork centered; desktop package icons updated

## [0.1.1] - 2026-07-17

### Fixed

- Portable exe creating an ~14×14 nearly invisible window on launch
- Package script not enabling `custom-protocol`, so the exe tried to reach local Vite (`ERR_CONNECTION_REFUSED`)
- Idle terminals reported as still running on quit
- False “unsaved editor changes may be lost” on quit confirm

### Changed

- Global settings file renamed to `default-settings.json`; workspace uses `.qingcode/project-settings.json` (JSON5, comments + project list)
- README focuses on product description; release process docs removed from README

## [0.1.0] - 2026-07-17

### Added

- Multi-project management: title-bar switch, add/remove/reveal projects
- File explorer: create, rename, delete, copy path and reference
- CodeMirror editor: multi-tabs, dirty markers, common languages on demand
- Multi-terminal: sessions per project, default cwd at project root
- File name and content search
- Project run configurations
- Themes (dark / light / system), font and size settings
- UI language: Simplified Chinese, English
- Windows single-file exe packaging (`pnpm package:exe`)
- GitHub / Gitee Release workflow and version scripts

[Unreleased]: https://github.com/Fracizz/QingCode/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.4
[0.1.3]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.3
[0.1.2]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.2
[0.1.1]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.1
[0.1.0]: https://github.com/Fracizz/QingCode/releases/tag/v0.1.0
