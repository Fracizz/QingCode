mod commands;
mod terminal;

use std::path::PathBuf;
use tauri_plugin_sql::{Migration, MigrationKind};
use terminal::TerminalManager;

fn legacy_database_paths(data_dir: &PathBuf) -> [PathBuf; 2] {
    [
        // Legacy app data directories (read-only migration sources).
        data_dir.join("com.nestcode.app").join("nestcode.db"),
        data_dir
            .join("com.administrator.my-code-desktop")
            .join("my_code_desktop.db"),
    ]
}

/// dev 构建用项目内的 .dev/qingcode.db；release 用应用数据目录下的 qingcode.db。
/// 两者通过 `db_url` 命令暴露给前端，确保前端 Database.load 与后端 migrations 用同一个连接标签。
fn dev_db_file() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest.parent().expect("CARGO_MANIFEST_DIR has no parent");
    project_root.join(".dev").join("qingcode.db")
}

fn resolved_db_file() -> PathBuf {
    if cfg!(debug_assertions) {
        dev_db_file()
    } else {
        dirs::data_dir()
            .expect("no data dir")
            .join("com.qingcode.app")
            .join("qingcode.db")
    }
}

/// 返回 tauri-plugin-sql 的连接标签。dev 用绝对路径（覆盖插件默认的 app_config_dir 解析），
/// release 用相对名（由插件解析到 app_config_dir = %APPDATA%\com.qingcode.app\）。
fn build_db_url() -> String {
    if cfg!(debug_assertions) {
        let db = dev_db_file();
        let _ = std::fs::create_dir_all(db.parent().expect("no parent"));
        format!("sqlite:{}", db.display())
    } else {
        "sqlite:qingcode.db".to_string()
    }
}

fn migrate_legacy_database() {
    let new_db = resolved_db_file();
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
fn create_terminal(
    id: String,
    cwd: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    state.spawn(id, &cwd, app)
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
    build_db_url()
}

#[tauri::command]
fn spawn_script(
    id: String,
    cwd: String,
    shell_kind: String,
    target: String,
    env: std::collections::HashMap<String, String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalManager>,
) -> Result<(), String> {
    state.spawn_script(id, &cwd, &shell_kind, &target, env, app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&build_db_url(), {
                    let mut m = get_migrations();
                    m.extend(get_column_migrations());
                    m
                })
                .build(),
        )
        .manage(TerminalManager::new())
        .setup(|app| {
            migrate_legacy_database();
            for window_config in app.config().app.windows.iter().filter(|w| !w.create) {
                tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                    .enable_clipboard_access()
                    .build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scan_directory,
            commands::validate_directory,
            commands::read_file,
            commands::write_file,
            commands::search_files,
            commands::search_file_contents,
            commands::create_file,
            commands::create_directory,
            commands::rename_path,
            commands::delete_path,
            create_terminal,
            write_terminal,
            kill_terminal,
            resize_terminal,
            spawn_script,
            db_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
