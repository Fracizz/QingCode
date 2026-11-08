//! Offline SQLite access for project list CRUD (same file as the GUI).

use crate::app_paths;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub path: String,
    pub default_shell: Option<String>,
    pub created_at: i64,
    pub last_opened_at: i64,
    pub hidden: i64,
    pub sort_order: i64,
}

pub fn open_db() -> Result<Connection, String> {
    let path = app_paths::db_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create db dir: {e}"))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("open db {}: {e}", path.display()))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
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
    )
    .map_err(|e| format!("ensure schema: {e}"))?;
    // 后续列只由 GUI 迁移添加：CLI 抢先 ALTER 会让迁移因重复列失败，数据库无法打开。
    Ok(())
}

/// 新库尚未跑过 GUI 迁移时列不存在，按默认值 0 读取。
fn integer_column_or_zero(conn: &Connection, column: &str) -> Result<String, String> {
    Ok(if column_exists(conn, "projects", column)? {
        format!("COALESCE({column}, 0)")
    } else {
        "0".to_string()
    })
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for name in rows {
        if name.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn list_projects(conn: &Connection) -> Result<Vec<ProjectRow>, String> {
    let hidden = integer_column_or_zero(conn, "hidden")?;
    let sort_order = integer_column_or_zero(conn, "sort_order")?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id, name, path, default_shell, created_at, last_opened_at,
                    {hidden}, {sort_order}
             FROM projects
             ORDER BY last_opened_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectRow {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                default_shell: row.get(3)?,
                created_at: row.get(4)?,
                last_opened_at: row.get(5)?,
                hidden: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn normalize_path(path: &str) -> String {
    crate::terminal::strip_windows_verbatim_prefix(path.trim())
        .trim_end_matches(['/', '\\'])
        .replace('\\', "/")
        .to_lowercase()
}

pub fn resolve_project<'a>(
    projects: &'a [ProjectRow],
    query: &str,
) -> Result<&'a ProjectRow, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("empty project query".into());
    }
    if let Some(p) = projects.iter().find(|p| p.id == q) {
        return Ok(p);
    }
    let nq = normalize_path(q);
    let by_path: Vec<_> = projects
        .iter()
        .filter(|p| normalize_path(&p.path) == nq)
        .collect();
    if by_path.len() == 1 {
        return Ok(by_path[0]);
    }
    if by_path.len() > 1 {
        return Err(format!("ambiguous project path: {q}"));
    }
    let by_name: Vec<_> = projects.iter().filter(|p| p.name == q).collect();
    if by_name.len() == 1 {
        return Ok(by_name[0]);
    }
    if by_name.len() > 1 {
        return Err(format!(
            "ambiguous project name '{q}' ({} matches); use id or path",
            by_name.len()
        ));
    }
    Err(format!("project not found: {q}"))
}

pub fn resolve_project_for_run(
    projects: &[ProjectRow],
    query: Option<&str>,
) -> Result<ProjectRow, String> {
    match query {
        Some(q) => resolve_project(projects, q).cloned(),
        None => {
            if projects.len() == 1 {
                Ok(projects[0].clone())
            } else if projects.is_empty() {
                Err("no projects in database; add one first".into())
            } else {
                Err(format!(
                    "multiple projects ({}); pass --project <id|path|name>",
                    projects.len()
                ))
            }
        }
    }
}

pub fn insert_project(conn: &Connection, path: &Path) -> Result<ProjectRow, String> {
    if !path.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    let abs = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // canonicalize turns UNC paths into \\?\UNC\...; preserve the leading
    // share separator so WSL detection and filesystem access still work.
    let abs_str =
        crate::terminal::strip_windows_verbatim_prefix(&abs.to_string_lossy()).into_owned();

    let existing = list_projects(conn)?;
    let n = normalize_path(&abs_str);
    if let Some(p) = existing.iter().find(|p| normalize_path(&p.path) == n) {
        return Ok(p.clone());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| abs_str.clone());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO projects (id, name, path, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, abs_str, now, now],
    )
    .map_err(|e| format!("insert project: {e}"))?;
    update_cli_removed_paths(conn, |paths| paths.retain(|item| normalize_path(item) != n))?;

    Ok(ProjectRow {
        id,
        name,
        path: abs_str,
        default_shell: None,
        created_at: now,
        last_opened_at: now,
        hidden: 0,
        sort_order: 0,
    })
}

pub fn remove_project(conn: &Connection, query: &str) -> Result<ProjectRow, String> {
    let projects = list_projects(conn)?;
    let target = resolve_project(&projects, query)?;
    let removed = target.clone();
    update_cli_removed_paths(conn, |paths| {
        if !paths.contains(&removed.path) {
            paths.push(removed.path.clone());
        }
    })?;
    conn.execute(
        "DELETE FROM recent_files WHERE project_id = ?1",
        params![removed.id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![removed.id])
        .map_err(|e| e.to_string())?;
    Ok(removed)
}

/// CLI 移除的项目路径。`default-settings.json` 是带注释的 JSON5，由 GUI 回写；
/// GUI 下次加载时据此跳过导入、回写设置后删除记录，否则移除的项目会在启动同步时恢复。
const CLI_REMOVED_PATHS_KEY: &str = "cli_removed_project_paths";

fn update_cli_removed_paths(
    conn: &Connection,
    update: impl FnOnce(&mut Vec<String>),
) -> Result<(), String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![CLI_REMOVED_PATHS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut paths: Vec<String> = stored
        .as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_default();
    update(&mut paths);
    if paths.is_empty() {
        conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![CLI_REMOVED_PATHS_KEY],
        )
    } else {
        let value = serde_json::to_string(&paths).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![CLI_REMOVED_PATHS_KEY, value],
        )
    }
    .map_err(|e| format!("update removed project paths: {e}"))?;
    Ok(())
}

pub fn run_json_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".qingcode").join("run.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disposable_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("qingcode-cli-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn removed_paths(conn: &Connection) -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![CLI_REMOVED_PATHS_KEY],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    #[test]
    fn gui_column_migrations_still_apply_after_cli_initializes_database() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let dir = disposable_dir("fresh-db");
        let added = insert_project(&conn, &dir).unwrap();
        assert_eq!(list_projects(&conn).unwrap()[0].hidden, 0);

        conn.execute_batch(
            "ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
        )
        .unwrap();
        let listed = list_projects(&conn).unwrap();
        assert_eq!(listed[0].id, added.id);
        assert_eq!(listed[0].sort_order, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn removed_project_stays_recorded_until_it_is_added_again() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let dir = disposable_dir("removed");
        let added = insert_project(&conn, &dir).unwrap();
        assert_eq!(removed_paths(&conn), None);

        remove_project(&conn, &added.id).unwrap();
        let recorded: Vec<String> = serde_json::from_str(&removed_paths(&conn).unwrap()).unwrap();
        assert_eq!(recorded, vec![added.path.clone()]);

        insert_project(&conn, &dir).unwrap();
        assert_eq!(removed_paths(&conn), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn canonical_wsl_project_path_preserves_unc_root() {
        let canonical = r"\\?\UNC\wsl.localhost\Ubuntu\home\code\QingCode";
        let saved = crate::terminal::strip_windows_verbatim_prefix(canonical);
        assert_eq!(saved, r"\\wsl.localhost\Ubuntu\home\code\QingCode");
        let wsl = crate::run_environment::parse_wsl_path(&saved).unwrap();
        assert_eq!(wsl.distro, "Ubuntu");
        assert_eq!(wsl.path, "/home/code/QingCode");
        assert_eq!(normalize_path(canonical), normalize_path(&saved));
    }

    #[test]
    fn canonical_local_project_path_matches_existing_registration() {
        assert_eq!(
            normalize_path(r"\\?\D:\Code\QingCode"),
            normalize_path("D:/Code/QingCode/")
        );
        assert_eq!(normalize_path(r"\\server\share\app"), "//server/share/app");
        assert_eq!(normalize_path("/home/code/app"), "/home/code/app");
    }
}
