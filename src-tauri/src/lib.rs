mod app_memory;
mod app_paths;
mod cli;
mod commands;
mod content_search;
mod exclude;
mod file_associations;
mod file_encoding;
mod file_watcher;
mod fonts;
mod format;
mod git;
mod git_status;
mod ipc;
mod path_guard;
mod symbol_search;
mod terminal;
mod update;
mod user_locales;

use file_watcher::FileWatcherManager;
use path_guard::PathAllowlist;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri_plugin_sql::{Migration, MigrationKind};
use terminal::{TerminalManager, TerminalSpawnResult};

/// File paths passed on the command line (Explorer "Open with").
struct LaunchFiles(Mutex<Vec<String>>);

fn legacy_database_paths(data_dir: &Path) -> [PathBuf; 2] {
    [
        // Legacy app data directories (read-only migration sources).
        data_dir.join("com.nestcode.app").join("nestcode.db"),
        data_dir
            .join("com.administrator.my-code-desktop")
            .join("my_code_desktop.db"),
    ]
}

/// One-time whole-DB copy from legacy product data directories
/// (`com.nestcode.app` / `com.administrator.my-code-desktop`) into the current
/// `qingcode.db`. Version-guarded by the new DB file's existence: once
/// `qingcode.db` exists this is a no-op, so we do not re-stat the legacy paths on
/// every launch. The logic is retained (not deleted) so users upgrading from a
/// legacy build for the first time still recover their project list.
fn migrate_legacy_database() {
    let new_db = app_paths::db_file();
    if new_db.exists() {
        return;
    }

    let Some(data_dir) = dirs::data_dir() else {
        return;
    };

    for legacy_db in legacy_database_paths(&data_dir) {
        if !legacy_db.exists() {
            continue;
        }
        if std::fs::create_dir_all(new_db.parent().unwrap_or(&new_db)).is_err() {
            return;
        }
        let _ = std::fs::copy(&legacy_db, &new_db);
        return;
    }
}

fn get_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create projects and settings tables",
        sql: "CREATE TABLE IF NOT EXISTS projects (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              path TEXT NOT NULL UNIQUE,
              default_shell TEXT,
              created_at INTEGER NOT NULL,
              last_opened_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS recent_files (
              project_id TEXT,
              path TEXT NOT NULL,
              opened_at INTEGER NOT NULL,
              PRIMARY KEY(project_id, path)
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );",
        kind: MigrationKind::Up,
    }]
}

fn get_column_migrations() -> Vec<Migration> {
    // Lightweight schema-up migrations applied once by version. SQLite lacks
    // `ADD COLUMN IF NOT EXISTS`, so each migration is guarded by its distinct
    // version number; tauri-plugin-sql records applied versions and skips
    // re-running them.
    vec![
        Migration {
            version: 2,
            description: "add hidden column to projects",
            sql: "ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add sort_order column to projects",
            sql: "ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
    ]
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn create_terminal(
    id: String,
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalManager>,
    allowlist: tauri::State<'_, PathAllowlist>,
) -> Result<TerminalSpawnResult, String> {
    allowlist.ensure_executable(&cwd)?;
    state.spawn(
        id,
        &cwd,
        shell.as_deref(),
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        app,
    )
}

#[tauri::command]
fn write_terminal(
    id: String,
    data: String,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
fn kill_terminal(id: String, state: tauri::State<'_, TerminalManager>) -> Result<(), String> {
    state.kill(&id);
    Ok(())
}

#[tauri::command]
fn resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command]
fn db_url() -> String {
    app_paths::build_db_url()
}

/// Absolute path to the global `default-settings.json`.
/// Dev builds write beside the project `.dev` database; release uses app data dir.
#[tauri::command]
fn default_settings_path() -> String {
    app_paths::default_settings_file()
        .to_string_lossy()
        .into_owned()
}

/// Frontend completes an IPC CLI request started by the local IPC server.
#[tauri::command]
fn resolve_cli_request(
    id: String,
    ok: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
) {
    ipc::resolve_request(&id, ok, data, error);
}

#[tauri::command]
fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

/// Absolute path of the running QingCode executable (for Settings → copy CLI skill).
#[tauri::command]
fn app_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("locate exe: {e}"))
}

/// Consume CLI file paths once (Explorer → Open with / `QingCode.exe path`).
#[tauri::command]
fn take_launch_files(state: tauri::State<'_, LaunchFiles>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut paths| std::mem::take(&mut *paths))
        .unwrap_or_default()
}

#[tauri::command]
fn terminal_has_child_processes(
    id: String,
    state: tauri::State<'_, TerminalManager>,
) -> Result<bool, String> {
    state.has_child_processes(&id)
}

/// Status-bar memory: main + WebView2 + associated terminal process trees.
/// Pass `force: true` to bypass the short TTL cache (hover tip / terminal churn).
#[tauri::command]
fn get_app_memory(
    force: Option<bool>,
    state: tauri::State<'_, TerminalManager>,
) -> app_memory::AppMemoryInfo {
    app_memory::sample_app_memory(&state.shell_pids(), force.unwrap_or(false))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn spawn_script(
    id: String,
    cwd: String,
    shell_kind: String,
    target: String,
    env: std::collections::HashMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalManager>,
    allowlist: tauri::State<'_, PathAllowlist>,
) -> Result<TerminalSpawnResult, String> {
    allowlist.ensure_executable(&cwd)?;
    // Script file targets must stay inside the sandbox. Inline `command` /
    // `interactive` strings are unrestricted once the cwd is trusted (UI confirms).
    let kind = shell_kind.as_str();
    if kind != "command" && kind != "interactive" {
        let target_path = {
            let p = Path::new(&target);
            if p.is_absolute() {
                target.clone()
            } else {
                Path::new(&cwd).join(p).to_string_lossy().into_owned()
            }
        };
        allowlist.ensure_allowed(&target_path)?;
    }
    state.spawn_script(
        id,
        &cwd,
        &shell_kind,
        &target,
        env,
        shell.as_deref(),
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        app,
    )
}

#[cfg(target_os = "windows")]
fn repair_windows_main_window_size(window: &tauri::WebviewWindow) {
    const WIDTH: f64 = 1280.0;
    const HEIGHT: f64 = 800.0;
    const MIN_SANE: u32 = 200;

    let target = tauri::Size::Logical(tauri::LogicalSize::new(WIDTH, HEIGHT));
    let min = tauri::Size::Logical(tauri::LogicalSize::new(720.0, 480.0));

    // Prefer sizing without a decorations toggle: toggling chrome while the first
    // navigation is in flight can leave WebView2 stuck on an empty surface.
    let _ = window.set_size(target);
    let _ = window.set_min_size(Some(min));
    let _ = window.center();

    let needs_chrome_toggle = window
        .inner_size()
        .map(|size| size.width < MIN_SANE || size.height < MIN_SANE)
        .unwrap_or(true);
    if !needs_chrome_toggle {
        return;
    }

    let _ = window.set_decorations(true);
    let _ = window.set_size(target);
    let _ = window.set_min_size(Some(min));
    let _ = window.set_decorations(false);
    let _ = window.set_size(target);
    let _ = window.center();
    // Decorations changes can abort the initial document load — reload once.
    let _ = window.reload();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(code) = cli::try_run_as_cli() {
        std::process::exit(code);
    }

    let launch_files = file_associations::collect_cli_file_paths(std::env::args());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&app_paths::build_db_url(), {
                    let mut m = get_migrations();
                    m.extend(get_column_migrations());
                    m
                })
                .build(),
        )
        .manage(TerminalManager::new())
        .manage(FileWatcherManager::new())
        .manage(PathAllowlist::new())
        .manage(symbol_search::SymbolSearchState::new())
        .manage(LaunchFiles(Mutex::new(launch_files)))
        .setup(|app| {
            migrate_legacy_database();
            ipc::start_server(app.handle().clone());
            for window_config in app.config().app.windows.iter().filter(|w| !w.create) {
                // Keep visible:false from config so the HTML splash owns the first show().
                // Pin an explicit inner size on Windows so borderless+hidden does not boot
                // at ~14x14; only fall back to a decorations toggle if size is still wrong.
                #[cfg(target_os = "windows")]
                let window = tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                    .devtools(cfg!(debug_assertions))
                    .enable_clipboard_access()
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(720.0, 480.0)
                    .build()?;
                #[cfg(not(target_os = "windows"))]
                let window = tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                    .devtools(cfg!(debug_assertions))
                    .enable_clipboard_access()
                    .build()?;

                #[cfg(target_os = "windows")]
                {
                    repair_windows_main_window_size(&window);
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = window
                        .set_size(tauri::Size::Logical(tauri::LogicalSize::new(1280.0, 800.0)));
                    let _ = window.center();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_directory,
            commands::validate_directory,
            commands::file_stat,
            commands::read_file,
            commands::detect_file_encoding,
            commands::read_file_slice,
            commands::find_line_offset,
            commands::replace_file_range,
            commands::write_file,
            commands::search_files,
            commands::search_file_contents,
            commands::start_content_search,
            commands::cancel_content_search,
            symbol_search::search_symbol_definitions,
            symbol_search::search_symbol_references,
            symbol_search::search_workspace_symbols,
            commands::list_file_extensions,
            commands::create_file,
            commands::create_directory,
            commands::rename_path,
            commands::move_path,
            commands::copy_path_into,
            commands::delete_path,
            commands::clipboard_write_files,
            commands::clipboard_write_text,
            commands::directory_delete_stats,
            commands::directory_entry_counts,
            commands::check_symlink_write,
            format::format_document,
            path_guard::sync_project_roots,
            path_guard::sync_trusted_roots,
            path_guard::authorize_paths,
            git_status::get_git_head,
            git_status::get_git_workdir_status,
            git_status::git_show_head_file,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_branch_list,
            git::git_switch,
            git::git_log,
            git::git_commit_files,
            git::git_commit_file_contents,
            git::git_diff,
            git::git_file_contents,
            fonts::list_system_fonts,
            create_terminal,
            write_terminal,
            kill_terminal,
            resize_terminal,
            terminal_has_child_processes,
            get_app_memory,
            spawn_script,
            db_url,
            default_settings_path,
            app_exe_path,
            user_locales::user_locales_dir,
            user_locales::list_user_locales,
            is_dev_build,
            update::check_app_update,
            update::download_app_update,
            take_launch_files,
            resolve_cli_request,
            file_associations::get_open_with_status,
            file_associations::register_file_open_with,
            file_associations::unregister_file_open_with,
            file_watcher::sync_file_watches,
            file_watcher::suppress_fs_watch,
            file_watcher::is_fs_watch_suppressed,
            file_watcher::file_mtime,
            file_watcher::file_ctime,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
