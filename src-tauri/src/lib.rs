mod commands;
mod terminal;

use std::path::PathBuf;
use tauri_plugin_sql::{Migration, MigrationKind};
use terminal::TerminalManager;

fn legacy_database_paths(data_dir: &PathBuf) -> [PathBuf; 2] {
    [
        data_dir.join("com.nestcode.app").join("nestcode.db"),
        data_dir
            .join("com.administrator.my-code-desktop")
            .join("my_code_desktop.db"),
    ]
}

fn migrate_legacy_database() {
    let Some(data_dir) = dirs::data_dir() else {
        return;
    };

    let new_dir = data_dir.join("com.qingcode.app");
    let new_db = new_dir.join("qingcode.db");
    if new_db.exists() {
        return;
    }

    for legacy_db in legacy_database_paths(&data_dir) {
        if !legacy_db.exists() {
            continue;
        }
        if std::fs::create_dir_all(&new_dir).is_err() {
            return;
        }
        let _ = std::fs::copy(&legacy_db, &new_db);
        return;
    }
}

fn get_migrations() -> Vec<Migration> {
    vec![
        Migration {
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
        },
    ]
}

#[tauri::command]
fn create_terminal(id: String, cwd: String, app: tauri::AppHandle, state: tauri::State<'_, TerminalManager>) -> Result<(), String> {
    state.spawn(id, &cwd, app)
}

#[tauri::command]
fn write_terminal(id: String, data: String, state: tauri::State<'_, TerminalManager>) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
fn kill_terminal(id: String, state: tauri::State<'_, TerminalManager>) -> Result<(), String> {
    state.kill(&id);
    Ok(())
}

#[tauri::command]
fn resize_terminal(id: String, cols: u16, rows: u16, state: tauri::State<'_, TerminalManager>) -> Result<(), String> {
    state.resize(&id, cols, rows)
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
                .add_migrations("sqlite:qingcode.db", get_migrations())
                .build(),
        )
        .manage(TerminalManager::new())
        .setup(|_| {
            migrate_legacy_database();
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
