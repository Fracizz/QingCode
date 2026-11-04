import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import rustSource from '../../src-tauri/src/lib.rs?raw'

/** Consume the native migration source, so Web never maintains its own schema. */
export function nativeMigrationSql(source: string): string[] {
  const section = source.slice(
    source.indexOf('fn get_migrations()'),
    source.indexOf('#[tauri::command]', source.indexOf('fn get_column_migrations()'))
  )
  const sql = [...section.matchAll(/sql:\s*"((?:\\.|[^"\\])*)"/g)].map(match =>
    match[1].replace(
      /\\([nrt"\\])/g,
      (_, char: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[char]!
    )
  )
  if (!sql.length) throw new Error('No native database migrations found')
  return sql
}

export class WebTestDatabase {
  private transaction = false

  constructor(
    private readonly db: Database,
    private readonly save: (bytes: Uint8Array) => void
  ) {}

  select(query: string, values: SqlValue[] = []): Record<string, SqlValue>[] {
    const stmt = this.db.prepare(query)
    try {
      stmt.bind(values)
      const rows: Record<string, SqlValue>[] = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      return rows
    } finally {
      stmt.free()
    }
  }

  execute(query: string, values: SqlValue[] = []): [number, number] {
    this.db.run(query, values)
    if (/^\s*BEGIN\b/i.test(query)) this.transaction = true
    if (/^\s*(COMMIT|ROLLBACK)\b/i.test(query)) this.transaction = false
    const count = this.db.getRowsModified()
    const id = Number(this.select('SELECT last_insert_rowid() AS id')[0].id)
    // export() closes SQLite transactions; only snapshot committed data.
    if (!this.transaction) this.save(this.db.export())
    return [count, id]
  }

  close() {
    this.db.close()
  }
}

export async function openWebTestDatabase(
  bytes: Uint8Array | undefined,
  save: (bytes: Uint8Array) => void,
  wasmPath = wasmUrl
) {
  const SQL = await initSqlJs({ locateFile: () => wasmPath })
  const db = new SQL.Database(bytes)
  const current = Number(db.exec('PRAGMA user_version')[0].values[0][0])
  const migrations = nativeMigrationSql(rustSource)
  if (current > migrations.length)
    throw new Error('Web test database schema is newer than this application')
  db.run('BEGIN')
  try {
    migrations.slice(current).forEach(sql => db.run(sql))
    db.run(`PRAGMA user_version = ${migrations.length}`)
    db.run('COMMIT')
  } catch (error) {
    db.run('ROLLBACK')
    db.close()
    throw error
  }
  save(db.export())
  return new WebTestDatabase(db, save)
}
