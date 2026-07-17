# Repository Guidelines

## Project Structure & Module Organization

QingCode is a Tauri 2 desktop code editor with a React 19/Vite frontend and a Rust backend. Keep UI code in `src/`: reusable views live in `src/components/`, Zustand state in `src/store/`, Tauri wrappers in `src/lib/`, and focused helpers in `src/utils/`. Static files belong in `public/`. Native commands and terminal handling are in `src-tauri/src/`; Tauri permissions are defined in `src-tauri/capabilities/default.json`. Use `scripts/` for Windows packaging helpers and consult `DESIGN.md` before changing interaction patterns.

## Build, Test, and Development Commands

- `pnpm install` installs the frontend toolchain.
- `pnpm tauri:dev` starts the complete Windows desktop application; use this for features involving files, terminals, or native dialogs.
- `pnpm dev` runs only Vite's browser UI for layout-focused work.
- `pnpm build` runs TypeScript checking and creates the frontend production bundle.
- `cargo test` (from `src-tauri/`) runs Rust unit tests; `cargo fmt --all -- --check` verifies Rust formatting.
- `pnpm tauri build --no-bundle` validates the production desktop build without producing an installer. Run `pnpm package:exe` when preparing the Windows executable package.
- For a GitHub/Gitee Release: `pnpm bump:version x.y.z`, update `CHANGELOG.md`, commit, then `pnpm release:tag x.y.z` and `git push github vX.Y.Z` (see README). Set GitHub secret `GITEE_TOKEN` to mirror assets to Gitee Releases.

## Coding Style & Naming Conventions

Match the surrounding code: TypeScript uses two-space indentation, functional React components, PascalCase component filenames (for example, `PromptDialog.tsx`), and camelCase helpers. Name stores by responsibility, such as `editorStore.ts`. Rust follows `rustfmt` and snake_case naming. Route frontend calls through `safeInvoke` in `src/lib/tauri.ts`; new commands must be registered in `src-tauri/src/lib.rs`. Reuse shared overlays, tooltips, and dialogs rather than adding browser-native prompts or duplicate UI patterns.

## Testing Guidelines

There is no configured frontend test runner. For TypeScript/UI changes, run `pnpm build` and manually verify the affected path in `pnpm tauri:dev`. Add Rust tests near the helper or command they cover, use descriptive names such as `parse_path_rejects_empty_input`, and run `cargo test` before review. Exercise file-changing commands against disposable files or a temporary workspace.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style messages, commonly `feat: <concise Chinese summary>`; use the appropriate type (`feat`, `fix`, `docs`, or `refactor`) and keep each commit focused. Pull requests should explain user-visible behavior, list validation commands, link the relevant issue when available, and include screenshots or a short recording for UI changes. Do not commit local `.dev` state, generated `dist/` or `release/` output, or application data. Treat capability and CSP changes as security-sensitive and explain why they are required.
