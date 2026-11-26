import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LOCAL_TARGET,
  type SshAuth,
  type SshTarget,
  type SshTargetInput,
  type Target,
} from '../shared/backendApi'

const TARGETS_FILE = 'targets.json'

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

function parseAuth(x: unknown): SshAuth | null {
  if (!isRecord(x)) return null
  if (x.kind === 'password' || x.kind === 'agent') return { kind: x.kind }
  if (x.kind === 'key' && typeof x.keyPath === 'string' && x.keyPath.length > 0) {
    return { kind: 'key', keyPath: x.keyPath }
  }
  return null
}

function parseSshTarget(x: unknown): SshTarget | null {
  if (!isRecord(x) || x.kind !== 'ssh') return null
  if (typeof x.id !== 'string' || x.id.length === 0 || x.id === 'local') return null
  if (typeof x.name !== 'string' || typeof x.host !== 'string') return null
  if (typeof x.port !== 'number' || !Number.isFinite(x.port)) return null
  if (typeof x.username !== 'string') return null
  const auth = parseAuth(x.auth)
  if (!auth) return null
  // 只保留已知字段，避免把旧版本残留的密码写回磁盘。
  return {
    id: x.id,
    kind: 'ssh',
    name: x.name,
    host: x.host,
    port: x.port,
    username: x.username,
    auth,
  }
}

// 本机目标永远存在且排在首位；无效或损坏的条目直接忽略。
export function normalizeTargets(raw: unknown): Target[] {
  const items = Array.isArray(raw) ? raw : []
  const result: Target[] = [LOCAL_TARGET]
  const seen = new Set<string>([LOCAL_TARGET.id])
  for (const item of items) {
    const target = parseSshTarget(item)
    if (!target || seen.has(target.id)) continue
    seen.add(target.id)
    result.push(target)
  }
  return result
}

export function serializeTargets(targets: readonly Target[]): string {
  // 经 parseSshTarget 白名单重建，避免把上游附带的密码等字段写回磁盘。
  const stored = targets
    .filter((t): t is SshTarget => t.kind === 'ssh')
    .map((t) => parseSshTarget(t))
    .filter((t): t is SshTarget => t !== null)
  return JSON.stringify(stored, null, 2) + '\n'
}

export function upsertTarget(
  targets: readonly Target[],
  input: SshTargetInput,
  newId: string
): { targets: Target[]; target: SshTarget } {
  const id = input.id && input.id !== 'local' ? input.id : newId
  const next: SshTarget = {
    id,
    kind: 'ssh',
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    auth: input.auth,
  }
  const list = [...targets]
  const existing = list.findIndex((t) => t.id === id)
  if (existing >= 0) list[existing] = next
  else list.push(next)
  return { targets: normalizeTargets(list.filter((t) => t.kind === 'ssh')), target: next }
}

export function removeTarget(targets: readonly Target[], id: string): Target[] {
  return normalizeTargets(targets.filter((t) => t.kind === 'ssh' && t.id !== id))
}

export function createTargetId(): string {
  return `ssh-${randomUUID()}`
}

export async function readTargets(userData: string): Promise<Target[]> {
  try {
    const text = await readFile(join(userData, TARGETS_FILE), 'utf8')
    return normalizeTargets(JSON.parse(text) as unknown)
  } catch {
    // 文件不存在或已损坏时退回只有本机，避免启动时整个 backend 不可用。
    return normalizeTargets([])
  }
}

export async function writeTargets(userData: string, targets: readonly Target[]): Promise<void> {
  const file = join(userData, TARGETS_FILE)
  const tmp = `${file}.tmp`
  await mkdir(userData, { recursive: true })
  await writeFile(tmp, serializeTargets(targets), 'utf8')
  await rename(tmp, file)
}
