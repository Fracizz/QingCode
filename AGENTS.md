# Repository Guidelines

## Project Structure & Module Organization

QingCode is a Tauri 2 desktop code editor with a React 19/Vite frontend and a Rust backend. Keep UI code in `src/`: reusable views live in `src/components/`, Zustand state in `src/store/`, Tauri wrappers in `src/lib/`, and focused helpers in `src/utils/`. Static files belong in `public/`. Native commands and terminal handling are in `src-tauri/src/`; Tauri permissions are defined in `src-tauri/capabilities/default.json`. Use `scripts/` for Windows packaging helpers and consult `DESIGN.md` before changing interaction patterns.

Global `default-settings.json` and workspace `.qingcode/project-settings.json` are **JSON5** (comments, trailing commas). Default templates in `src/lib/projectSettings.ts` must keep **per-key comments** and state in the file header that comments must not be deleted (`不得删除注释`).

## Build, Test, and Development Commands

- `pnpm install` installs the frontend toolchain.
- `pnpm tauri:dev` starts the complete Windows desktop application; use this for features involving files, terminals, or native dialogs.
- `pnpm dev` runs only Vite's browser UI for layout-focused work.
- `pnpm build` runs TypeScript checking and creates the frontend production bundle.
- `pnpm test` / `pnpm test:watch` run Vitest unit tests under `src/**/*.{test,spec}.{ts,tsx}`.
- `pnpm check` runs frontend typecheck + Vitest, then Rust `fmt` / `clippy -D warnings` / `test`.
- `cargo test` (from `src-tauri/`) runs Rust unit tests; `cargo fmt --all -- --check` verifies Rust formatting; `cargo clippy --all-targets -- -D warnings` enforces lint cleanliness.
- `pnpm tauri build --no-bundle` validates the production desktop build without producing an installer. Local Windows packaging: `pnpm package` builds **x64 portable + NSIS installer** in one pass (`release/QingCode.exe`, `release/QingCode-setup.exe`); `pnpm package:fast` skips frontend/icons. Separate `package:exe` / `package:installer` remain for single artifacts; ARM64 (`package:*:arm64`) and `package:macos` are for CI / other hosts. `pnpm smoke:start` smokes `release/QingCode.exe`.
- Release CI (`.github/workflows/release.yml`) builds **Windows x64**, **Windows ARM64** (`windows-11-arm`), and **macOS arm64** (`macos-14`), then uploads assets to GitHub Release. After a successful **tag** Release, `Sync Gitee Release` mirrors the 6 canonical assets to Gitee when `GITEE_TOKEN` is set (also runnable manually).
- `pnpm register:open-with` / `pnpm unregister:open-with` register or remove Explorer “Open with” entries for the portable `release/QingCode.exe` (HKCU, no admin). Settings → 功能 also exposes the same action for the running exe.

## Coding Style & Naming Conventions

Match the surrounding code: TypeScript uses two-space indentation, functional React components, PascalCase component filenames (for example, `PromptDialog.tsx`), and camelCase helpers. Name stores by responsibility, such as `editorStore.ts`. Rust follows `rustfmt` and snake_case naming. Route frontend calls through `safeInvoke` in `src/lib/tauri.ts`; new commands must be registered in `src-tauri/src/lib.rs`. Reuse shared overlays, tooltips, and dialogs rather than adding browser-native prompts or duplicate UI patterns. Never put HTML `title` on DOM nodes for hover tips — use `Tooltip` (see `DESIGN.md`; ESLint `react/forbid-dom-props`).

## Testing Guidelines

Prefer pure helpers / reducers with Vitest coverage under `src/**/*.test.ts` (stores, settings parse, path utils, dirty-tab copy). For TypeScript/UI changes, run `pnpm check` (or at least `pnpm test` + `pnpm build`) and manually verify the affected path in `pnpm tauri:dev`. Add Rust tests near the helper or command they cover, use descriptive names such as `parse_path_rejects_empty_input`, and run `cargo test` / `clippy` before review. Exercise file-changing commands against disposable files or a temporary workspace. Release CI runs `pnpm check`, then packages Windows x64 / Windows ARM64 / macOS arm64 artifacts.

## Dual Remotes (Gitee + GitHub)

QingCode is mirrored on both hosts. Configure a clone with:

```bash
pnpm remotes:setup
```

| Remote | Fetch | Push |
|--------|-------|------|
| `origin` | Gitee (`FrancizTest_admin/qing-code`) | Gitee **and** GitHub |
| `github` | GitHub (`Fracizz/QingCode`) | GitHub |

Use `git push origin <branch>` to publish to both. Fetch either side with `git fetch origin` / `git fetch github`. Do not force-push unless explicitly requested.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style messages, commonly `feat: <concise Chinese summary>`; use the appropriate type (`feat`, `fix`, `docs`, or `refactor`) and keep each commit focused. Pull requests should explain user-visible behavior, list validation commands, link the relevant issue when available, and include screenshots or a short recording for UI changes. Do not commit local `.dev` state, generated `dist/` or `release/` output, or application data. Treat capability and CSP changes as security-sensitive and explain why they are required.
