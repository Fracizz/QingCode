import { safeInvoke } from './tauri'

/** `execute` 的结果，字段与原 `@tauri-apps/plugin-sql` 的 QueryResult 一致。 */
export interface QueryResult {
  rowsAffected: number
  lastInsertId?: number
}

/**
 * 应用 SQLite 数据库句柄（Rust 端见 `src-tauri/src/app_db.rs`）。
 *
 * 取代 `@tauri-apps/plugin-sql`，保持其 `load` / `execute` / `select` / `close` 的调用形状：
 * 参数用 `$1`、`$2`… 占位，按位置传入 `bindValues`。只能打开应用主库与旧产品库。
 */
export default class Database {
  constructor(readonly path: string) {}

  static async load(path: string): Promise<Database> {
    const loaded = await safeInvoke<string>('打开数据库', 'db_load', { db: path })
    return new Database(loaded)
  }

  execute(query: string, bindValues?: unknown[]): Promise<QueryResult> {
    return safeInvoke<QueryResult>('写入数据库', 'db_execute', {
      db: this.path,
      query,
      values: bindValues ?? [],
    })
  }

  select<T>(query: string, bindValues?: unknown[]): Promise<T> {
    return safeInvoke<T>('读取数据库', 'db_select', {
      db: this.path,
      query,
      values: bindValues ?? [],
    })
  }

  close(): Promise<boolean> {
    return safeInvoke<boolean>('关闭数据库', 'db_close', { db: this.path })
  }
}
