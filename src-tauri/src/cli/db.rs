//! Offline SQLite access for project list CRUD (same file as the GUI).

use crate::app_paths;
use rusqlite::{params, Connection};
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

    for (col, sql) in [
        (
            "hidden",
            "ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "sort_order",
            "ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        if !column_exists(conn, "projects", col)? {
            let _ = conn.execute(sql, []);
        }
    }
    Ok(())
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
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, default_shell, created_at, last_opened_at,
                    COALESCE(hidden, 0), COALESCE(sort_order, 0)
             FROM projects
             ORDER BY last_opened_at DESC",
        )
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
    path.trim()
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
    let abs_str = abs.to_string_lossy().to_string();
    // Strip Windows \\?\ prefix for consistency with the GUI.
    let abs_str = abs_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&abs_str)
        .to_string();

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
        "INSERT INTO projects (id, name, path, created_at, last_opened_at, hidden, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)",
        params![id, name, abs_str, now, now],
    )
    .map_err(|e| format!("insert project: {e}"))?;

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
    conn.execute(
        "DELETE FROM recent_files WHERE project_id = ?1",
        params![removed.id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", params![removed.id])
        .map_err(|e| e.to_string())?;
    Ok(removed)
}

pub fn run_json_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".qingcode").join("run.json")
}
