use super::*;
use serde_json::json;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn memory_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    configure_connection(&conn).unwrap();
    conn
}

fn migrated_db() -> Connection {
    let mut conn = memory_db();
    run_migrations(&mut conn, &all_migrations()).unwrap();
    conn
}

/// 1–6 取自真实安装（tauri-plugin-sql/sqlx 写入）的 `_sqlx_migrations.checksum`；
/// 7 为同算法计算值。任何一项变化都说明迁移 SQL 文本被改动，老用户库会对不上。
#[test]
fn migration_checksums_match_sqlx_records() {
    let expected = [
        (1, "0ba0f21eaac37bc138b7602e5deba4d4dffe644d3671e7ea602a63f830d19e4bdfcabbcf3ad2c8bc366c24311fcef697"),
        (2, "27d6ce480a58c807015c0f527bbc6c3b28ac637229f7c62961c74402f89fad694606af60a4cfa2118a9c254e59eea385"),
        (3, "628cfcf935cd9808cc3630031920f44f37b8912a2622bb4193a9f863aa7089c8b24ad268d6fae19e0f09580df3621382"),
        (4, "609bf2eadc4c661b74eb7de9ac54e05777a87ecb658992d74db18bfdb8f28748a3d2e13c1c01a0aacd348eebafb984b4"),
        (5, "04a5ba166a5f98db44f979415a9ba8d784f1295bccb4b9f9e19457862f013add56d3e7df8be41e979ac11c5e2af6e9c5"),
        (6, "87a42d32ec1eadaf3ae764eee5cb329c9a2513b4764d7a0751ac75c9bd01cb501b1f4a69cc773af662f17649fa9bfc1e"),
        (7, "914a3925e741971dbf618a4afacc939b4570b89aa90c25be9cd072c68fe859020e2639381ae07811c9b4305b3007ef2f"),
    ];
    let migrations = all_migrations();
    assert_eq!(migrations.len(), expected.len());
    for (migration, (version, checksum)) in migrations.iter().zip(expected) {
        assert_eq!(migration.version, version);
        assert_eq!(
            hex(&migration_checksum(migration.sql)),
            checksum,
            "migration {version}"
        );
    }
}

#[test]
fn run_migrations_creates_schema_and_is_idempotent() {
    let mut conn = migrated_db();
    run_migrations(&mut conn, &all_migrations()).unwrap();
    let versions: Vec<i64> = conn
        .prepare("SELECT version FROM _sqlx_migrations WHERE success = TRUE ORDER BY version")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7]);
    let execution_time: i64 = conn
        .query_row(
            "SELECT execution_time FROM _sqlx_migrations WHERE version = 7",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(execution_time >= 0);
    // 所有迁移加出来的列都在。
    conn.execute_batch(
        "INSERT INTO projects (id, name, path, created_at, last_opened_at, hidden, sort_order, kind, connection_id, root_path)
         VALUES ('p', 'n', '/p', 1, 1, 0, 0, 'local', NULL, NULL);
         INSERT INTO ssh_connections (id, name, host, username, auth_kind, host_key_fingerprint, created_at, updated_at, mode)
         VALUES ('c', 'n', 'h', 'u', 'password', 'fp', 1, 1, 'ssh');
         INSERT INTO favorite_items (project_id, relative_path, item_type, created_at) VALUES ('p', 'a', 'file', 1);",
    )
    .unwrap();
}

#[test]
fn run_migrations_continues_an_sqlx_database() {
    let mut conn = memory_db();
    let migrations = all_migrations();
    // 模拟旧版插件已应用 1–6 的数据库。
    run_migrations(&mut conn, &migrations[..6]).unwrap();
    run_migrations(&mut conn, &migrations).unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM _sqlx_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 7);
    conn.execute_batch("UPDATE ssh_connections SET mode = 'ssh'")
        .unwrap();
}

#[test]
fn run_migrations_rejects_partially_applied_version() {
    let mut conn = migrated_db();
    conn.execute_batch("UPDATE _sqlx_migrations SET success = FALSE WHERE version = 3")
        .unwrap();
    let error = run_migrations(&mut conn, &all_migrations()).unwrap_err();
    assert!(error.contains('3'), "{error}");
}

#[test]
fn run_migrations_tolerates_checksum_drift_and_unknown_versions() {
    let mut conn = migrated_db();
    conn.execute_batch(
        "UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 2;
         INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
         VALUES (99, 'future', TRUE, x'00', 0);",
    )
    .unwrap();
    run_migrations(&mut conn, &all_migrations()).unwrap();
}

#[test]
fn bind_values_follow_dollar_number_positions() {
    let conn = migrated_db();
    execute_on(
        &conn,
        "INSERT INTO settings (key, value) VALUES ($1, $2)",
        &[json!("k"), json!("v1")],
    )
    .unwrap();
    // `$2` 先出现时仍取第 2 个值（SQLite 自身会按出现顺序编号，sqlx 不会）。
    let result = execute_on(
        &conn,
        "UPDATE settings SET value = $2 WHERE key = $1",
        &[json!("k"), json!("v2")],
    )
    .unwrap();
    assert_eq!(result.rows_affected, 1);
    let rows = select_on(
        &conn,
        "SELECT value FROM settings WHERE key = $1",
        &[json!("k")],
    )
    .unwrap();
    assert_eq!(
        rows,
        vec![json!({ "value": "v2" }).as_object().unwrap().clone()]
    );
}

#[test]
fn bind_values_match_sqlx_type_rules() {
    let conn = memory_db();
    conn.execute_batch("CREATE TABLE t (i INTEGER, x TEXT, anything)")
        .unwrap();
    let result = execute_on(
        &conn,
        "INSERT INTO t (i, x, anything) VALUES (?, ?, ?)",
        &[json!(1_700_000_000_123_i64), json!(true), json!(null)],
    )
    .unwrap();
    assert_eq!(result.last_insert_id, 1);
    let rows = select_on(
        &conn,
        "SELECT i, x, anything, typeof(i) AS kind FROM t",
        &[],
    )
    .unwrap();
    let row = &rows[0];
    // 数字按 f64 绑定后进入 INTEGER 列仍存为整数。
    assert_eq!(row["i"], json!(1_700_000_000_123_i64));
    assert_eq!(row["kind"], json!("integer"));
    // 布尔按 JSON 文本绑定。
    assert_eq!(row["x"], json!("true"));
    assert_eq!(row["anything"], json!(null));
    // 少传的参数绑定为 NULL，而不是报错。
    execute_on(&conn, "INSERT INTO t (i, x) VALUES ($1, $2)", &[json!(5)]).unwrap();
    let rows = select_on(&conn, "SELECT x FROM t WHERE i = $1", &[json!(5)]).unwrap();
    assert_eq!(rows[0]["x"], json!(null));
}

#[test]
fn select_decodes_storage_classes() {
    let conn = memory_db();
    let rows = select_on(
        &conn,
        "SELECT 1 AS i, 1.5 AS r, 'a' AS s, x'0102' AS b, NULL AS n, COUNT(*) AS c FROM (SELECT 1)",
        &[],
    )
    .unwrap();
    assert_eq!(
        serde_json::Value::Object(rows[0].clone()),
        json!({ "i": 1, "r": 1.5, "s": "a", "b": [1, 2], "n": null, "c": 1 })
    );
}

#[test]
fn execute_without_values_supports_transactions_and_batches() {
    let conn = migrated_db();
    execute_on(&conn, "BEGIN IMMEDIATE", &[]).unwrap();
    execute_on(
        &conn,
        "INSERT INTO settings (key, value) VALUES ($1, $2)",
        &[json!("a"), json!("1")],
    )
    .unwrap();
    execute_on(&conn, "ROLLBACK", &[]).unwrap();
    assert!(select_on(&conn, "SELECT * FROM settings", &[])
        .unwrap()
        .is_empty());

    execute_on(
        &conn,
        "INSERT INTO settings (key, value) VALUES ('a', '1'); INSERT INTO settings (key, value) VALUES ('b', '2');",
        &[],
    )
    .unwrap();
    let count = select_on(&conn, "SELECT COUNT(*) AS c FROM settings", &[]).unwrap();
    assert_eq!(count[0]["c"], json!(2));
}

#[test]
fn execute_reports_sql_errors() {
    let conn = migrated_db();
    assert!(execute_on(&conn, "INSERT INTO missing VALUES ($1)", &[json!(1)]).is_err());
    assert!(select_on(&conn, "SELECT * FROM missing", &[]).is_err());
}

#[test]
fn resolve_db_path_maps_relative_urls_under_config_dir() {
    let config = Path::new("C:/cfg/com.qingcode.app");
    assert_eq!(
        resolve_db_path(config, "sqlite:qingcode.db").unwrap(),
        config.join("qingcode.db")
    );
    assert_eq!(
        resolve_db_path(config, LEGACY_DB_URL).unwrap(),
        config.join("../com.administrator.my-code-desktop/my_code_desktop.db")
    );
    let absolute = std::env::temp_dir().join("x.db");
    assert_eq!(
        resolve_db_path(config, &format!("sqlite:{}", absolute.display())).unwrap(),
        absolute
    );
    assert!(resolve_db_path(config, "postgres://x").is_err());
}

#[test]
fn open_main_db_creates_wal_database_and_legacy_open_never_creates_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("qingcode.db");
    let conn = open_main_db(&path).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
    drop(conn);
    // 再次打开已有库：迁移不重复执行。
    let conn = open_main_db(&path).unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM _sqlx_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 7);

    let missing = dir.path().join("legacy.db");
    assert!(open_legacy_db(&missing).is_err());
    assert!(!missing.exists());
}
