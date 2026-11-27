import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { LegacyRow, LegacySnapshot } from './mapLegacy'

const LEGACY_DB_NAME = 'qingcode.db'
const LEGACY_APP_DIR = 'com.qingcode.app'
const LEGACY_SECRETS_FILE = 'ssh-secrets.json'

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export function defaultLegacyDbPath(): string {
  const appData = process.env['APPDATA']
  const base = appData && appData !== '' ? appData : join(homedir(), '.config')
  return join(base, LEGACY_APP_DIR, LEGACY_DB_NAME)
}

export async function legacyDbExists(dbPath: string): Promise<boolean> {
  try {
    return (await stat(dbPath)).isFile()
  } catch {
    return false
  }
}

export function parseSecretEntries(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key !== '' && typeof value === 'string' && value !== '') result[key] = value
  }
  return result
}

async function readSecretsFile(dbPath: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(join(dirname(dbPath), LEGACY_SECRETS_FILE), 'utf8')
    return parseSecretEntries(JSON.parse(text) as unknown)
  } catch {
    // 未保存过密码、文件损坏都不影响连接与项目的导入。
    return {}
  }
}

function queryAll(db: DatabaseSync, table: string): LegacyRow[] {
  try {
    return db.prepare(`SELECT * FROM "${table}"`).all() as LegacyRow[]
  } catch {
    // 旧版本可能没有某张表；缺表等同于没有这类数据。
    return []
  }
}

// 旧版可能仍在运行并持有 WAL：先复制 db/-wal/-shm 到临时目录，再只读打开副本。
export async function readLegacySnapshot(dbPath: string): Promise<LegacySnapshot> {
  if (!(await legacyDbExists(dbPath))) throw new Error('旧版数据库不存在')
  const sqlite = await import('node:sqlite').catch(() => null)
  if (!sqlite) throw new Error('当前 Node 不支持 node:sqlite，无法读取旧版数据')

  const temp = await mkdtemp(join(tmpdir(), 'qn-legacy-'))
  const copy = join(temp, 'legacy.db')
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        await copyFile(`${dbPath}${suffix}`, `${copy}${suffix}`)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (suffix === '' || code !== 'ENOENT') throw err
      }
    }
    const db = new sqlite.DatabaseSync(copy, { readOnly: true })
    let connections: LegacyRow[] = []
    let projects: LegacyRow[] = []
    try {
      connections = queryAll(db, 'ssh_connections')
      projects = queryAll(db, 'projects')
    } finally {
      db.close()
    }
    const secrets = await readSecretsFile(dbPath)
    return { connections, projects, secrets }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
