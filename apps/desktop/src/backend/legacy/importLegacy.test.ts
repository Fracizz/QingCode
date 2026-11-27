import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readProjects } from '../projectStore'
import { loadSecret, readSecretStore, type SecretCipher } from '../secretStore'
import { readTargets } from '../targetStore'
import { detectLegacy, importLegacyData, type LegacyDeps } from './importLegacy'
import { readKnownHostsFile } from './knownHosts'

const tempDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(async () => {
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qn-legacy-import-'))
  tempDirs.push(dir)
  return dir
}

// 测试里用可逆的 base64 代替 safeStorage；不触碰 Electron parentPort。
const cipher: SecretCipher = {
  encrypt: async (text) => Buffer.from(text).toString('base64'),
  decrypt: async (encoded) => Buffer.from(encoded, 'base64').toString('utf8'),
}

const decrypt = async (
  entries: Record<string, string>
): Promise<Record<string, string | null>> => {
  const result: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(entries)) {
    result[key] = value === 'Yw==' ? JSON.stringify({ password: 'p@ss' }) : null
  }
  return result
}

async function createLegacyDb(): Promise<{ dbPath: string }> {
  const dir = await tempDir()
  const dbPath = join(dir, 'qingcode.db')
  const db = new DatabaseSync(dbPath)
  openDbs.push(db)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE ssh_connections (
    id TEXT PRIMARY KEY, name TEXT, host TEXT, port INTEGER, username TEXT,
    auth_kind TEXT, private_key_path TEXT, host_key_fingerprint TEXT,
    mode TEXT, created_at INTEGER, updated_at INTEGER
  )`)
  db.exec(`CREATE TABLE projects (
    id TEXT, name TEXT, path TEXT NOT NULL UNIQUE, created_at INTEGER,
    last_opened_at INTEGER, hidden INTEGER, kind TEXT, connection_id TEXT, root_path TEXT
  )`)
  const insertConn = db.prepare(`INSERT INTO ssh_connections
    (id, name, host, port, username, auth_kind, private_key_path, host_key_fingerprint, mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`)
  insertConn.run('c1', 'Host 93', '192.168.10.93', 2222, 'root', 'password', null, 'SHA256:abc', 'server')
  insertConn.run('c2', 'Key host', '10.0.0.2', null, 'admin', 'privateKey', 'C:\\keys\\id', 'SHA256:def', 'ssh')
  insertConn.run('d1', 'Direct', '10.0.0.3', 22, 'Agent', 'password', null, 'a'.repeat(64), 'server')
  insertConn.run('bad', 'Broken', '', 22, 'root', 'password', null, '', 'ssh')
  const insertProject = db.prepare(`INSERT INTO projects
    (id, name, path, created_at, last_opened_at, hidden, kind, connection_id, root_path)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`)
  insertProject.run('p1', 'Local A', 'C:\\work\\a', 1_700_000_000, 1, 'local', null, null)
  insertProject.run('p2', 'Local B', '/home/u/b', 1_800_000_000_000, 0, 'local', null, null)
  insertProject.run('p3', 'Remote', 'C:\\placeholder', 1_600_000_000, 0, 'ssh', 'c1', '/srv/app')
  insertProject.run('p4', 'Orphan', 'C:\\placeholder2', 1, 0, 'ssh', 'missing', '/srv/x')
  await writeFile(join(dir, 'ssh-secrets.json'), JSON.stringify({ c1: 'Yw==', d1: 'ZA==' }), 'utf8')
  return { dbPath }
}

async function fileText(userData: string, name: string): Promise<string> {
  return readFile(join(userData, name), 'utf8')
}

describe('legacy detect → import → 再次 import', () => {
  it('完整流程：首次写入、二次全部 skipped、文件不变', async () => {
    const { dbPath } = await createLegacyDb()
    const userData = await tempDir()
    const deps: Partial<LegacyDeps> = { userData, cipher, decrypt }

    const detected = await detectLegacy(dbPath)
    expect(detected.found).toBe(true)
    expect(detected.path).toBe(dbPath)
    expect(detected.counts).toEqual({
      connections: 4, localProjects: 2, sshProjects: 2, secrets: 2,
    })

    const first = await importLegacyData({ path: dbPath, includeSecrets: true }, deps)
    expect(first.imported).toEqual({ targets: 2, projects: 3, hostKeys: 2, secrets: 1 })
    expect(first.skipped).toEqual(expect.arrayContaining([
      { kind: 'connection', name: 'Direct', reason: 'Server 直连条目' },
      { kind: 'connection', name: 'Broken', reason: '缺少主机地址' },
      { kind: 'project', name: 'Orphan', reason: '关联连接不存在或未导入' },
      { kind: 'secret', name: 'd1', reason: '关联连接不存在或未导入' },
    ]))

    expect((await readTargets(userData)).map((t) => t.id)).toEqual(['local', 'legacy-c1', 'legacy-c2'])
    const keyTarget = (await readTargets(userData)).find((t) => t.id === 'legacy-c2')
    expect(keyTarget?.kind === 'ssh' ? keyTarget.auth : null).toEqual({ kind: 'key', keyPath: 'C:\\keys\\id' })

    const projects = await readProjects(userData)
    expect(projects).toHaveLength(3)
    expect(projects.map((p) => p.name)).toEqual(['Local B', 'Local A', 'Remote'])
    expect(projects.find((p) => p.name === 'Remote')?.targetId).toBe('legacy-c1')
    expect(projects.find((p) => p.name === 'Local A')?.lastOpenedAt).toBe(1_700_000_000_000)

    expect(await readKnownHostsFile(userData)).toEqual({
      '192.168.10.93:2222': 'SHA256:abc',
      '10.0.0.2:22': 'SHA256:def',
    })
    expect(Object.keys(await readSecretStore(userData))).toEqual(['legacy-c1'])
    expect(await loadSecret('legacy-c1', { userData, cipher })).toEqual({ password: 'p@ss' })

    const before = await Promise.all(
      ['targets.json', 'projects.json', 'known_hosts.json', 'secrets.json'].map((n) => fileText(userData, n))
    )
    const second = await importLegacyData({ path: dbPath, includeSecrets: true }, deps)
    expect(second.imported).toEqual({ targets: 0, projects: 0, hostKeys: 0, secrets: 0 })
    expect(second.skipped.length).toBeGreaterThanOrEqual(8)
    expect(second.skipped.some((s) => s.reason === '已导入')).toBe(true)
    expect(second.skipped.some((s) => s.reason === '已存在')).toBe(true)
    const after = await Promise.all(
      ['targets.json', 'projects.json', 'known_hosts.json', 'secrets.json'].map((n) => fileText(userData, n))
    )
    expect(after).toEqual(before)
  })

  it('不勾选导入密码时不写 secrets.json', async () => {
    const { dbPath } = await createLegacyDb()
    const userData = await tempDir()
    const result = await importLegacyData({ path: dbPath, includeSecrets: false }, { userData, cipher, decrypt })
    expect(result.imported.secrets).toBe(0)
    expect(result.skipped.some((s) => s.kind === 'secret')).toBe(false)
    expect(await readSecretStore(userData)).toEqual({})
  })

  it('旧库不存在时 detect 返回 found:false，import 抛错', async () => {
    const missing = join(await tempDir(), 'nope.db')
    expect(await detectLegacy(missing)).toMatchObject({ found: false, path: missing })
    await expect(importLegacyData({ path: missing }, { userData: await tempDir(), cipher, decrypt }))
      .rejects.toThrow('旧版数据库不存在')
  })
})
