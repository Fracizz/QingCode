//! 应用 SQLite 数据库（项目列表、最近文件、收藏、SSH 连接等）的前端访问层。
//!
//! 取代原先的 `tauri-plugin-sql`（sqlx）：两者访问同一个 `qingcode.db`，但插件会额外
//! 链接 sqlx 全家桶，而 CLI（`cli/db.rs`）本就使用 rusqlite。这里用 rusqlite 实现与插件
//! 等价的 load / execute / select / close 四个命令，前端 `src/lib/database.ts` 保持
//! 原插件的调用形状。
//!
//! 兼容性要点（改动前务必核对）：
//! - 迁移记录沿用 sqlx 的 `_sqlx_migrations` 表与 SHA-384 校验和，老用户数据库无缝衔接，
//!   回退到旧版本时 sqlx 校验也能通过；因此迁移 SQL 文本一个字节都不能改。
//! - 参数按 sqlx 的规则绑定：`$N` / `?N` 取第 N 个值，数字一律按 f64 绑定，
//!   布尔/数组/对象按 JSON 文本绑定。
//! - 新建数据库时与 sqlx 一样切到 WAL；连接开启 `foreign_keys`，忙等 5 秒。

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use sha2::{Digest, Sha384};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::app_paths;

/// 旧产品 id 的数据库，只读打开，供前端逐行导入（见 `projectRepository.ts`）。
const LEGACY_DB_URL: &str = "sqlite:../com.administrator.my-code-desktop/my_code_desktop.db";

/// 一条只升不降的迁移，字段与原 `tauri_plugin_sql::Migration` 一致。
pub(crate) struct Migration {
    pub version: i64,
    pub description: &'static str,
    pub sql: &'static str,
}

#[derive(Default)]
pub struct AppDbState {
    connections: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

fn all_migrations() -> Vec<Migration> {
    let mut migrations = get_migrations();
    migrations.extend(get_column_migrations());
    migrations
}

fn migration_checksum(sql: &str) -> Vec<u8> {
    Sha384::digest(sql.as_bytes()).to_vec()
}

/// 按 sqlx 0.8 `Migrator::run` 的语义执行迁移：建表、拒绝半途失败的版本、逐个应用。
/// 与 sqlx 不同的是：已应用版本校验和不一致、或数据库里有本版本不认识的更新迁移时只记日志，
/// 不阻止打开数据库（sqlx 会直接报错，导致项目列表无法加载）。
fn run_migrations(conn: &mut Connection, migrations: &[Migration]) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
);",
    )
    .map_err(|e| format!("创建迁移表失败：{e}"))?;

    let dirty: Option<i64> = match conn.query_row(
        "SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1",
        [],
        |row| row.get(0),
    ) {
        Ok(version) => Some(version),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(format!("读取迁移状态失败：{e}")),
    };
    if let Some(version) = dirty {
        return Err(format!(
            "数据库迁移 {version} 未完成（上次执行中断），请备份后修复数据库"
        ));
    }

    let applied: HashMap<i64, Vec<u8>> = {
        let mut stmt = conn
            .prepare("SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
            .map_err(|e| format!("读取迁移记录失败：{e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|e| format!("读取迁移记录失败：{e}"))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| format!("读取迁移记录失败：{e}"))?
    };

    for migration in migrations {
        let checksum = migration_checksum(migration.sql);
        if let Some(existing) = applied.get(&migration.version) {
            if existing != &checksum {
                eprintln!(
                    "[app_db] migration {} checksum differs from the applied one; keeping the database as is",
                    migration.version
                );
            }
            continue;
        }
        let started = Instant::now();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始迁移 {} 失败：{e}", migration.version))?;
        tx.execute_batch(migration.sql)
            .map_err(|e| format!("执行迁移 {} 失败：{e}", migration.version))?;
        tx.execute(
            "INSERT INTO _sqlx_migrations ( version, description, success, checksum, execution_time ) VALUES ( ?1, ?2, TRUE, ?3, -1 )",
            rusqlite::params![migration.version, migration.description, checksum],
        )
        .map_err(|e| format!("记录迁移 {} 失败：{e}", migration.version))?;
        tx.commit()
            .map_err(|e| format!("提交迁移 {} 失败：{e}", migration.version))?;
        let elapsed = i64::try_from(started.elapsed().as_nanos()).unwrap_or(i64::MAX);
        conn.execute(
            "UPDATE _sqlx_migrations SET execution_time = ?1 WHERE version = ?2",
            rusqlite::params![elapsed, migration.version],
        )
        .map_err(|e| format!("记录迁移 {} 耗时失败：{e}", migration.version))?;
    }
    Ok(())
}

/// `sqlite:<path>`：绝对路径原样使用，相对路径与插件一样相对 app config 目录。
fn resolve_db_path(config_dir: &Path, url: &str) -> Result<PathBuf, String> {
    let raw = url
        .strip_prefix("sqlite:")
        .ok_or_else(|| format!("无效的数据库地址：{url}"))?;
    let path = PathBuf::from(raw);
    Ok(if path.is_absolute() {
        path
    } else {
        config_dir.join(path)
    })
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置数据库忙等失败：{e}"))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("设置数据库外键失败：{e}"))
}

/// 打开主数据库并执行迁移；文件不存在时新建并切到 WAL（与 sqlx 建库行为一致）。
fn open_main_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据库目录失败：{e}"))?;
    }
    let created = !path.exists();
    let mut conn =
        Connection::open(path).map_err(|e| format!("打开数据库 {} 失败：{e}", path.display()))?;
    if created {
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))
            .map_err(|e| format!("设置 WAL 失败：{e}"))?;
    }
    configure_connection(&conn)?;
    run_migrations(&mut conn, &all_migrations())?;
    Ok(conn)
}

/// 旧库只读打开；文件不存在时报错而不是新建空库。
fn open_legacy_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开旧数据库 {} 失败：{e}", path.display()))?;
    configure_connection(&conn)?;
    Ok(conn)
}

/// sqlx 的绑定规则：数字统一按 f64，字符串按 TEXT，其余（布尔、数组、对象）按 JSON 文本。
fn json_to_sql(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::String(text) => Value::Text(text.clone()),
        JsonValue::Number(number) => Value::Real(number.as_f64().unwrap_or_default()),
        other => Value::Text(other.to_string()),
    }
}

fn sql_to_json(value: ValueRef<'_>) -> JsonValue {
    match value {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(number) => JsonValue::from(number),
        ValueRef::Real(number) => JsonValue::from(number),
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .map(|text| JsonValue::String(text.to_string()))
            .unwrap_or(JsonValue::Null),
        ValueRef::Blob(bytes) => {
            JsonValue::Array(bytes.iter().map(|b| JsonValue::from(*b)).collect())
        }
    }
}

/// 与 sqlx 一致：`$N` / `?N` 命名参数取第 N 个值，其余按出现位置取值；缺失的值绑定 NULL。
fn bind_values(stmt: &mut rusqlite::Statement<'_>, values: &[JsonValue]) -> Result<(), String> {
    for index in 1..=stmt.parameter_count() {
        let position = stmt
            .parameter_name(index)
            .and_then(|name| name.strip_prefix('$').or_else(|| name.strip_prefix('?')))
            .and_then(|digits| digits.parse::<usize>().ok())
            .unwrap_or(index);
        let value = position
            .checked_sub(1)
            .and_then(|i| values.get(i))
            .map(json_to_sql)
            .unwrap_or(Value::Null);
        stmt.raw_bind_parameter(index, value)
            .map_err(|e| format!("绑定参数 {position} 失败：{e}"))?;
    }
    Ok(())
}

fn execute_on(
    conn: &Connection,
    query: &str,
    values: &[JsonValue],
) -> Result<ExecuteResult, String> {
    if values.is_empty() {
        // 无参数时允许多条语句（BEGIN / COMMIT / 批量 DDL），与 sqlx 一致。
        conn.execute_batch(query).map_err(|e| e.to_string())?;
    } else {
        let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
        bind_values(&mut stmt, values)?;
        stmt.raw_execute().map_err(|e| e.to_string())?;
    }
    Ok(ExecuteResult {
        rows_affected: conn.changes(),
        last_insert_id: conn.last_insert_rowid(),
    })
}

fn select_on(
    conn: &Connection,
    query: &str,
    values: &[JsonValue],
) -> Result<Vec<Map<String, JsonValue>>, String> {
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    bind_values(&mut stmt, values)?;
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let mut rows = stmt.raw_query();
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut record = Map::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let value = row.get_ref(index).map_err(|e| e.to_string())?;
            record.insert(column.clone(), sql_to_json(value));
        }
        out.push(record);
    }
    Ok(out)
}

fn with_connection<T>(
    state: &AppDbState,
    db: &str,
    action: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let connection = state
        .connections
        .lock()
        .map_err(|_| "数据库状态锁已损坏".to_string())?
        .get(db)
        .cloned()
        .ok_or_else(|| format!("数据库未加载：{db}"))?;
    let guard = connection
        .lock()
        .map_err(|_| "数据库连接锁已损坏".to_string())?;
    action(&guard)
}

/// 只允许打开应用主库和旧产品库，前端不能借此读写任意 SQLite 文件。
#[tauri::command(async)]
pub fn db_load(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppDbState>,
    db: String,
) -> Result<String, String> {
    let main_url = app_paths::build_db_url();
    if db != main_url && db != LEGACY_DB_URL {
        return Err(format!("不允许打开该数据库：{db}"));
    }
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| "数据库状态锁已损坏".to_string())?;
    if connections.contains_key(&db) {
        return Ok(db);
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("找不到应用配置目录：{e}"))?;
    let path = resolve_db_path(&config_dir, &db)?;
    let conn = if db == main_url {
        open_main_db(&path)?
    } else {
        open_legacy_db(&path)?
    };
    connections.insert(db.clone(), Arc::new(Mutex::new(conn)));
    Ok(db)
}

#[tauri::command(async)]
pub fn db_execute(
    state: tauri::State<'_, AppDbState>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<ExecuteResult, String> {
    with_connection(&state, &db, |conn| execute_on(conn, &query, &values))
}

#[tauri::command(async)]
pub fn db_select(
    state: tauri::State<'_, AppDbState>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<Map<String, JsonValue>>, String> {
    with_connection(&state, &db, |conn| select_on(conn, &query, &values))
}

/// 关闭连接；不传 `db` 时关闭全部。返回是否关闭了任何连接。
#[tauri::command(async)]
pub fn db_close(state: tauri::State<'_, AppDbState>, db: Option<String>) -> Result<bool, String> {
    let mut connections = state
        .connections
        .lock()
        .map_err(|_| "数据库状态锁已损坏".to_string())?;
    Ok(match db {
        Some(db) => connections.remove(&db).is_some(),
        None => {
            let any = !connections.is_empty();
            connections.clear();
            any
        }
    })
}

// 以下迁移 SQL 自 tauri-plugin-sql 时代原样搬来：校验和按文本计算，改一个空格都会让
// 已安装用户的 `_sqlx_migrations` 记录对不上。新增变更只能追加新版本。

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
    }]
}

fn get_column_migrations() -> Vec<Migration> {
    // Lightweight schema-up migrations applied once by version. SQLite lacks
    // `ADD COLUMN IF NOT EXISTS`, so each migration is guarded by its distinct
    // version number; `run_migrations` records applied versions and skips
    // re-running them.
    vec![
        Migration {
            version: 2,
            description: "add hidden column to projects",
            sql: "ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;",
        },
        Migration {
            version: 3,
            description: "add sort_order column to projects",
            sql: "ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
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
        },
        Migration {
            version: 5,
            description: "add remote project metadata",
            sql: "ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'local';
                  ALTER TABLE projects ADD COLUMN connection_id TEXT;
                  ALTER TABLE projects ADD COLUMN root_path TEXT;",
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
        },
        Migration {
            version: 7,
            description: "add ssh connection mode",
            sql: "ALTER TABLE ssh_connections ADD COLUMN mode TEXT;",
        },
    ]
}

#[cfg(test)]
mod tests;
