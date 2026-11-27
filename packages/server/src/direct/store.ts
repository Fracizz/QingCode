import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// 直连的持久化状态：<stateDir>/direct/{config.json,grants.json}。
// 每个客户端一份可撤销的授权（参考 Orca 的 Shared Server Access），文件里只存 token 的 SHA-256。

export interface DirectConfig {
  /** host:port 或 port */
  listen: string
  allowPublic: boolean
}

export interface DirectGrant {
  id: string
  name: string
  tokenSha256: string
  createdAt: number
}

export interface DirectFiles {
  dir: string
  configFile: string
  grantsFile: string
}

export function directFiles(stateDir: string): DirectFiles {
  const dir = path.join(stateDir, 'direct')
  return { dir, configFile: path.join(dir, 'config.json'), grantsFile: path.join(dir, 'grants.json') }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function parseConfig(raw: unknown): DirectConfig | null {
  if (!isRecord(raw) || typeof raw.listen !== 'string' || raw.listen === '') return null
  return { listen: raw.listen, allowPublic: raw.allowPublic === true }
}

export function readConfig(files: DirectFiles): DirectConfig | null {
  return parseConfig(readJson(files.configFile))
}

export function writeConfig(files: DirectFiles, config: DirectConfig): void {
  writeJsonAtomic(files.configFile, config)
}

export function removeConfig(files: DirectFiles): void {
  fs.rmSync(files.configFile, { force: true })
}

export function parseGrants(raw: unknown): DirectGrant[] {
  const list = isRecord(raw) && Array.isArray(raw.grants) ? raw.grants : []
  return list.flatMap((item): DirectGrant[] => {
    if (!isRecord(item)) return []
    const { id, name, tokenSha256, createdAt } = item
    if (typeof id !== 'string' || typeof tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(tokenSha256)) return []
    return [{
      id,
      name: typeof name === 'string' ? name : '',
      tokenSha256,
      createdAt: typeof createdAt === 'number' ? createdAt : 0,
    }]
  })
}

export function readGrants(files: DirectFiles): DirectGrant[] {
  return parseGrants(readJson(files.grantsFile))
}

function writeGrants(files: DirectFiles, grants: DirectGrant[]): void {
  writeJsonAtomic(files.grantsFile, { grants })
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 新建授权；明文 token 只在返回值里出现一次。 */
export function addGrant(files: DirectFiles, name: string, now = Date.now()): { grant: DirectGrant; token: string } {
  const token = randomBytes(32).toString('hex')
  const grant: DirectGrant = {
    id: randomBytes(6).toString('hex'),
    name: name.trim().slice(0, 80),
    tokenSha256: hashToken(token),
    createdAt: now,
  }
  writeGrants(files, [...readGrants(files), grant])
  return { grant, token }
}

export function removeGrant(files: DirectFiles, id: string): boolean {
  const grants = readGrants(files)
  const next = grants.filter((g) => g.id !== id)
  if (next.length === grants.length) return false
  writeGrants(files, next)
  return true
}

/** 常数时间比较哈希，找不到返回 null。 */
export function matchGrant(grants: readonly DirectGrant[], token: unknown): DirectGrant | null {
  if (typeof token !== 'string' || token.length === 0) return null
  const digest = Buffer.from(hashToken(token), 'hex')
  let found: DirectGrant | null = null
  for (const grant of grants) {
    if (timingSafeEqual(digest, Buffer.from(grant.tokenSha256, 'hex'))) found = grant
  }
  return found
}
