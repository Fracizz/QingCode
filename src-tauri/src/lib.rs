mod app_memory;
mod app_paths;
mod cli;
mod code_navigation;
mod commands;
mod content_search;
mod exclude;
mod file_associations;
mod file_encoding;
mod file_watcher;
mod fonts;
mod format;
mod git;
mod git_command;
mod git_status;
mod ipc;
mod language_components;
mod native_input;
mod path_guard;
mod remote_ssh;
mod symbol_search;
mod terminal;
mod update;
mod user_locales;

use file_watcher::FileWatcherManager;
use path_guard::PathAllowlist;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};
use terminal::{TerminalManager, TerminalSpawnResult};

const MAIN_WINDOW_LABEL: &str = "main";

/// File targets waiting for a specific window. Keeping this native-side avoids
/// losing a second-instance request while the new WebView is still loading.
struct LaunchFiles {
    queues: Mutex<HashMap<String, Vec<String>>>,
    open_paths_by_window: Mutex<HashMap<String, Vec<String>>>,
    external_window_label: Mutex<Option<String>>,
    creating_external_window: AtomicBool,
}

impl LaunchFiles {
    fn new(initial: Vec<String>) -> Self {
        let launch_as_external = !initial.is_empty();
        let mut queues = HashMap::new();
        if launch_as_external {
            queues.insert(MAIN_WINDOW_LABEL.to_string(), initial);
        }
        Self {
            queues: Mutex::new(queues),
            open_paths_by_window: Mutex::new(HashMap::new()),
            external_window_label: Mutex::new(
                launch_as_external.then(|| MAIN_WINDOW_LABEL.to_string()),
            ),
            creating_external_window: AtomicBool::new(false),
        }
    }

    fn enqueue(&self, label: &str, targets: Vec<String>) {
        if targets.is_empty() {
            return;
        }
        if let Ok(mut queues) = self.queues.lock() {
            queues.entry(label.to_string()).or_default().extend(targets);
        }
    }

    fn take(&self, label: &str) -> Vec<String> {
        self.queues
            .lock()
            .ok()
            .and_then(|mut queues| queues.remove(label))
            .unwrap_or_default()
    }

    fn sync_open_paths(&self, label: &str, paths: Vec<String>) {
        if let Ok(mut by_window) = self.open_paths_by_window.lock() {
            by_window.insert(
                label.to_string(),
                paths
                    .into_iter()
                    .map(|path| normalized_file_key(&path))
                    .collect(),
            );
        }
    }

    fn window_with_target(&self, app: &tauri::AppHandle, target: &str) -> Option<String> {
        let key = normalized_file_key(open_target_path(target));
        self.open_paths_by_window.lock().ok().and_then(|by_window| {
            by_window.iter().find_map(|(label, paths)| {
                (paths.iter().any(|path| path == &key) && app.get_webview_window(label).is_some())
                    .then(|| label.clone())
            })
        })
    }
}

fn open_target_path(target: &str) -> &str {
    let mut candidate = target;
    for _ in 0..2 {
        let Some((path, suffix)) = candidate.rsplit_once(':') else {
            break;
        };
        if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            break;
        }
        candidate = path;
    }
    candidate
}

fn normalized_file_key(path: &str) -> String {
    let normalized = std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

#[cfg(test)]
mod launch_target_tests {
    use super::open_target_path;

    #[test]
    fn strips_optional_line_and_column_from_open_target() {
        assert_eq!(
            open_target_path(r"D:\docs\README.md:12:3"),
            r"D:\docs\README.md"
        );
        assert_eq!(
            open_target_path(r"D:\docs\README.md:12"),
            r"D:\docs\README.md"
        );
        assert_eq!(open_target_path(r"D:\docs\README.md"), r"D:\docs\README.md");
    }
}

fn focus_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn focus_preferred_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        focus_window(&window);
        return;
    }
    if let Some(window) = app.webview_windows().into_values().next() {
        focus_window(&window);
    }
}

fn build_external_file_window(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<tauri::WebviewWindow, String> {
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App("index.html?fresh=1&external=1".into()),
    )
    .title("QingCode · 独立文件")
    .inner_size(1280.0, 800.0)
    .min_inner_size(720.0, 480.0)
    .decorations(false)
    .center()
    .visible(false)
    .background_color(tauri::window::Color(30, 30, 30, 255));

    #[cfg(target_os = "windows")]
    let builder = builder.enable_clipboard_access();

    builder.build().map_err(|error| error.to_string())
}

/// Queue files for the dedicated project-less window. The same window is
/// reused until the user turns it into a project window.
pub(crate) fn route_external_file_targets(
    app: &tauri::AppHandle,
    targets: Vec<String>,
) -> Result<(), String> {
    if targets.is_empty() {
        focus_preferred_window(app);
        return Ok(());
    }

    let state = app.state::<LaunchFiles>();
    let mut remaining = Vec::new();
    let mut already_open: HashMap<String, Vec<String>> = HashMap::new();
    for target in targets {
        if let Some(label) = state.window_with_target(app, &target) {
            already_open.entry(label).or_default().push(target);
        } else {
            remaining.push(target);
        }
    }
    for (label, targets) in already_open {
        state.enqueue(&label, targets);
        let _ = app.emit_to(&label, "open-files", ());
        if let Some(window) = app.get_webview_window(&label) {
            focus_window(&window);
        }
    }
    if remaining.is_empty() {
        return Ok(());
    }

    let targets = remaining;
    let existing_label = state
        .external_window_label
        .lock()
        .map_err(|error| error.to_string())?
        .clone();

    if let Some(label) = existing_label {
        if let Some(window) = app.get_webview_window(&label) {
            state.enqueue(&label, targets);
            let _ = app.emit_to(&label, "open-files", ());
            focus_window(&window);
            return Ok(());
        }
        if state.creating_external_window.load(Ordering::Acquire) {
            state.enqueue(&label, targets);
            return Ok(());
        }
    }

    // `qing-*` matches capabilities/secondary.json for editor/file/dialog access.
    let label = format!("qing-external-files-{}", uuid::Uuid::new_v4().simple());
    state.enqueue(&label, targets);
    if let Ok(mut current) = state.external_window_label.lock() {
        *current = Some(label.clone());
    }

    if state.creating_external_window.swap(true, Ordering::AcqRel) {
        return Ok(());
    }

    let result = build_external_file_window(app, &label);
    state
        .creating_external_window
        .store(false, Ordering::Release);
    if let Err(error) = result {
        let _ = state.take(&label);
        if let Ok(mut current) = state.external_window_label.lock() {
            if current.as_deref() == Some(label.as_str()) {
                *current = None;
            }
        }
        return Err(error);
    }
    Ok(())
}

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
        Migration {
            version: 4,
            description: "create favorite items table",
            sql: "CREATE TABLE IF NOT EXISTS favorite_items (
                    project_id TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    item_type TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(project_id, relative_path)
                  );
                  CREATE INDEX IF NOT EXISTS idx_favorite_items_project_order
                    ON favorite_items(project_id, sort_order);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add remote project metadata",
            sql: "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'local';
                  ALTER TABLE projects ADD COLUMN connection_id TEXT;
                  ALTER TABLE projects ADD COLUMN root_path TEXT;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create ssh connections table",
            sql: "CREATE TABLE IF NOT EXISTS ssh_connections (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL DEFAULT 22,
                    username TEXT NOT NULL,
                    auth_kind TEXT NOT NULL,
                    private_key_path TEXT,
                    host_key_fingerprint TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                  );",
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

/// Consume launch targets queued specifically for the calling window.
#[tauri::command]
fn take_launch_files(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LaunchFiles>,
) -> Vec<String> {
    state.take(window.label())
}

/// Once the dedicated window opens a project, future Explorer requests should
/// create a new project-less file window instead of entering that project.
#[tauri::command]
fn release_external_file_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LaunchFiles>,
) {
    if let Ok(mut current) = state.external_window_label.lock() {
        if current.as_deref() == Some(window.label()) {
            *current = None;
        }
    }
}

#[tauri::command]
fn sync_open_file_paths(
    paths: Vec<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LaunchFiles>,
) {
    state.sync_open_paths(window.label(), paths);
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
    terminal_ids: Option<Vec<String>>,
    state: tauri::State<'_, TerminalManager>,
) -> app_memory::AppMemoryInfo {
    let project_pids = state.shell_pids_for_ids(terminal_ids.as_deref().unwrap_or(&[]));
    app_memory::sample_app_memory(&state.shell_pids(), &project_pids, force.unwrap_or(false))
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
    let launch_as_external = !launch_files.is_empty();
    // Explorer/NSIS shortcuts can provide an arbitrary $OUTDIR. Keep relative
    // launch-file resolution above, then stabilize native runtime loading.
    app_paths::stabilize_runtime_working_directory();

    tauri::Builder::default()
        // Must be registered first: it owns process arbitration before any
        // other desktop plugin can initialize a competing app instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = file_associations::collect_cli_file_paths_from(args, Some(Path::new(&cwd)));
            let app = app.clone();
            // On Windows the callback runs inside WM_COPYDATA. Creating a WebView
            // synchronously from that handler can deadlock WebView2, so route on
            // a worker thread (the documented Tauri multi-window pattern).
            std::thread::spawn(move || {
                if let Err(error) = route_external_file_targets(&app, paths) {
                    eprintln!("route second-instance files failed: {error}");
                    focus_preferred_window(&app);
                }
            });
        }))
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
        .manage(remote_ssh::SshManager::new())
        .manage(code_navigation::SemanticNavigationState::new())
        .manage(symbol_search::SymbolSearchState::new())
        .manage(LaunchFiles::new(launch_files))
        .setup(move |app| {
            migrate_legacy_database();
            ipc::start_server(app.handle().clone());
            for window_config in app.config().app.windows.iter().filter(|w| !w.create) {
                let mut window_config = window_config.clone();
                if launch_as_external && window_config.label == MAIN_WINDOW_LABEL {
                    window_config.url =
                        tauri::WebviewUrl::App("index.html?fresh=1&external=1".into());
                    window_config.title = "QingCode · 独立文件".to_string();
                }
                // Keep visible:false from config so the HTML splash owns the first show().
                // Pin an explicit inner size on Windows so borderless+hidden does not boot
                // at ~14x14; only fall back to a decorations toggle if size is still wrong.
                #[cfg(target_os = "windows")]
                let window =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                        .devtools(cfg!(debug_assertions))
                        .enable_clipboard_access()
                        .inner_size(1280.0, 800.0)
                        .min_inner_size(720.0, 480.0)
                        .build()?;
                #[cfg(not(target_os = "windows"))]
                let window =
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
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
            code_navigation::prepare_semantic_index,
            code_navigation::update_semantic_overlay,
            code_navigation::clear_semantic_overlay,
            code_navigation::resolve_symbol_at,
            code_navigation::find_symbol_usages_at,
            code_navigation::find_symbol_usages_by_id,
            code_navigation::search_indexed_workspace_symbols,
            code_navigation::semantic_index_status,
            language_components::language_component_statuses,
            native_input::primary_modifier_pressed,
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
            git::git_fetch,
            git::git_pull,
            git::git_branch_list,
            git::git_remotes,
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
            update::claim_startup_update_check,
            update::check_app_update,
            update::download_app_update,
            take_launch_files,
            release_external_file_window,
            sync_open_file_paths,
            resolve_cli_request,
            file_associations::get_open_with_status,
            file_associations::register_file_open_with,
            file_associations::unregister_file_open_with,
            file_watcher::sync_file_watches,
            file_watcher::suppress_fs_watch,
            file_watcher::is_fs_watch_suppressed,
            file_watcher::file_mtime,
            file_watcher::file_ctime,
            remote_ssh::ssh_probe_host,
            remote_ssh::ssh_connect,
            remote_ssh::ssh_disconnect,
            remote_ssh::ssh_connection_status,
            remote_ssh::ssh_validate_directory,
            remote_ssh::ssh_scan_directory,
            remote_ssh::ssh_file_stat,
            remote_ssh::ssh_file_mtime,
            remote_ssh::ssh_read_file,
            remote_ssh::ssh_detect_file_encoding,
            remote_ssh::ssh_read_file_slice,
            remote_ssh::ssh_write_file,
            remote_ssh::ssh_check_symlink_write,
            remote_ssh::ssh_create_file,
            remote_ssh::ssh_create_directory,
            remote_ssh::ssh_rename_path,
            remote_ssh::ssh_delete_path,
            remote_ssh::ssh_upload_paths,
            remote_ssh::ssh_download_paths,
            remote_ssh::ssh_search_files,
            remote_ssh::ssh_list_file_extensions,
            remote_ssh::ssh_search_file_contents,
            remote_ssh::ssh_git_status,
            remote_ssh::ssh_git_log,
            remote_ssh::ssh_git_branch_list,
            remote_ssh::ssh_git_remotes,
            remote_ssh::ssh_git_switch,
            remote_ssh::ssh_git_commit_files,
            remote_ssh::ssh_git_commit_file_contents,
            remote_ssh::ssh_git_file_contents,
            remote_ssh::ssh_git_show_head_file,
            remote_ssh::ssh_git_discard,
            remote_ssh::ssh_git_stage,
            remote_ssh::ssh_git_unstage,
            remote_ssh::ssh_git_commit,
            remote_ssh::ssh_git_push,
            remote_ssh::ssh_git_fetch,
            remote_ssh::ssh_git_pull,
            remote_ssh::ssh_format_document,
            remote_ssh::ssh_create_terminal,
            remote_ssh::ssh_spawn_script,
            remote_ssh::ssh_write_terminal,
            remote_ssh::ssh_resize_terminal,
            remote_ssh::ssh_kill_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
