import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultLegacyDbPath,
  legacyDbExists,
  parseSecretEntries,
  readLegacySnapshot,
} from './readLegacyDb'

const tempDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(async () => {
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qn-legacy-db-'))
  tempDirs.push(dir)
  return dir
}

describe('defaultLegacyDbPath / legacyDbExists', () => {
  it('默认路径指向旧版 QingCode 数据目录', () => {
    expect(defaultLegacyDbPath().replace(/\\/g, '/')).toMatch(/com\.qingcode\.app\/qingcode\.db$/)
  })

  it('文件不存在时返回 false', async () => {
    const dir = await tempDir()
    expect(await legacyDbExists(join(dir, 'nope.db'))).toBe(false)
  })
})

describe('parseSecretEntries', () => {
  it('只保留非空字符串密文', () => {
    expect(parseSecretEntries({ a: 'YQ==', b: 3, c: null })).toEqual({ a: 'YQ==' })
    expect(parseSecretEntries(null)).toEqual({})
  })
})

describe('readLegacySnapshot', () => {
  it('复制 WAL 副本后只读打开，能看到未 checkpoint 的数据', async () => {
    const dir = await tempDir()
    const dbPath = join(dir, 'qingcode.db')
    const db = new DatabaseSync(dbPath)
    openDbs.push(db)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE ssh_connections (id TEXT, name TEXT, host TEXT)')
    db.exec('CREATE TABLE projects (name TEXT, path TEXT, last_opened_at INTEGER)')
    db.prepare('INSERT INTO ssh_connections VALUES (?, ?, ?)').run('c1', 'Host 93', '192.168.10.93')
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run('Local', 'C:\\work', 1_700_000_000)

    const before = (await readdir(dir)).sort()
    const snapshot = await readLegacySnapshot(dbPath)
    expect(snapshot.connections).toEqual([{ id: 'c1', name: 'Host 93', host: '192.168.10.93' }])
    expect(snapshot.projects).toEqual([{ name: 'Local', path: 'C:\\work', last_opened_at: 1_700_000_000 }])
    // 只读副本不能污染旧版数据目录。
    expect((await readdir(dir)).sort()).toEqual(before)
  })

  it('缺表、缺列时容错；同目录读取 ssh-secrets.json', async () => {
    const dir = await tempDir()
    const dbPath = join(dir, 'qingcode.db')
    const db = new DatabaseSync(dbPath)
    openDbs.push(db)
    db.exec('CREATE TABLE projects (name TEXT, path TEXT)')
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('Old', '/srv/old')
    db.close()
    openDbs.pop()
    await writeFile(join(dir, 'ssh-secrets.json'), JSON.stringify({ c1: 'YQ==', bad: 7 }), 'utf8')

    const snapshot = await readLegacySnapshot(dbPath)
    expect(snapshot.connections).toEqual([])
    expect(snapshot.projects).toEqual([{ name: 'Old', path: '/srv/old' }])
    expect(snapshot.secrets).toEqual({ c1: 'YQ==' })
  })

  it('数据库不存在时抛错', async () => {
    const dir = await tempDir()
    await expect(readLegacySnapshot(join(dir, 'missing.db'))).rejects.toThrow('旧版数据库不存在')
  })
})
