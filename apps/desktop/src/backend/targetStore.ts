import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LOCAL_TARGET,
  type DirectTarget,
  type DirectTargetInput,
  type SshAuth,
  type SshDirect,
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
  const direct = parseSshDirect(x.direct)
  // 只保留已知字段，避免把旧版本残留的密码写回磁盘。
  return {
    id: x.id,
    kind: 'ssh',
    name: x.name,
    host: x.host,
    port: x.port,
    username: x.username,
    auth,
    ...(direct ? { direct } : {}),
  }
}

const FINGERPRINT = /^[0-9a-f]{64}$/

function parseSshDirect(x: unknown): SshDirect | null {
  if (!isRecord(x)) return null
  if (typeof x.host !== 'string' || x.host === '') return null
  if (typeof x.port !== 'number' || !Number.isInteger(x.port) || x.port < 1 || x.port > 65535) return null
  if (typeof x.fingerprint !== 'string' || !FINGERPRINT.test(x.fingerprint)) return null
  if (typeof x.grantId !== 'string' || x.grantId === '') return null
  return { host: x.host, port: x.port, fingerprint: x.fingerprint, grantId: x.grantId }
}

/** 设置或清除 SSH 目标的直连配置；目标不存在或不是 SSH 时返回 null。 */
export function setSshDirect(
  targets: readonly Target[],
  id: string,
  direct: SshDirect | undefined
): { targets: Target[]; target: SshTarget } | null {
  const current = targets.find((t) => t.id === id)
  if (!current || current.kind !== 'ssh') return null
  const { direct: _old, ...rest } = current
  const next: SshTarget = direct ? { ...rest, direct } : rest
  const list = targets.map((t) => (t.id === id ? next : t))
  return { targets: normalizeTargets(list.filter((t) => t.kind !== 'local')), target: next }
}

function parseDirectTarget(x: unknown): DirectTarget | null {
  if (!isRecord(x) || x.kind !== 'direct') return null
  if (typeof x.id !== 'string' || x.id.length === 0 || x.id === 'local') return null
  if (typeof x.name !== 'string' || typeof x.host !== 'string') return null
  if (typeof x.port !== 'number' || !Number.isInteger(x.port)) return null
  if (typeof x.fingerprint !== 'string' || !FINGERPRINT.test(x.fingerprint)) return null
  // token 只在 secrets 里，白名单重建避免写回磁盘。
  return { id: x.id, kind: 'direct', name: x.name, host: x.host, port: x.port, fingerprint: x.fingerprint }
}

function parseRemoteTarget(x: unknown): SshTarget | DirectTarget | null {
  return parseSshTarget(x) ?? parseDirectTarget(x)
}

// 本机目标永远存在且排在首位；无效或损坏的条目直接忽略。
export function normalizeTargets(raw: unknown): Target[] {
  const items = Array.isArray(raw) ? raw : []
  const result: Target[] = [LOCAL_TARGET]
  const seen = new Set<string>([LOCAL_TARGET.id])
  for (const item of items) {
    const target = parseRemoteTarget(item)
    if (!target || seen.has(target.id)) continue
    seen.add(target.id)
    result.push(target)
  }
  return result
}

export function serializeTargets(targets: readonly Target[]): string {
  // 经 parseSshTarget 白名单重建，避免把上游附带的密码等字段写回磁盘。
  const stored = targets
    .filter((t) => t.kind !== 'local')
    .map((t) => parseRemoteTarget(t))
    .filter((t): t is SshTarget | DirectTarget => t !== null)
  return JSON.stringify(stored, null, 2) + '\n'
}

export function upsertTarget(
  targets: readonly Target[],
  input: SshTargetInput,
  newId: string
): { targets: Target[]; target: SshTarget } {
  const id = input.id && input.id !== 'local' ? input.id : newId
  // 表单不携带直连配置；编辑连接信息时保留已开启的直连。
  const previous = targets.find((t) => t.id === id)
  const direct = previous?.kind === 'ssh' ? previous.direct : undefined
  const next: SshTarget = {
    id,
    kind: 'ssh',
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    auth: input.auth,
    ...(direct ? { direct } : {}),
  }
  const list = [...targets]
  const existing = list.findIndex((t) => t.id === id)
  if (existing >= 0) list[existing] = next
  else list.push(next)
  return { targets: normalizeTargets(list.filter((t) => t.kind !== 'local')), target: next }
}

export function upsertDirectTarget(
  targets: readonly Target[],
  input: DirectTargetInput,
  newId: string
): { targets: Target[]; target: DirectTarget } {
  const id = input.id && input.id !== 'local' ? input.id : newId
  const next: DirectTarget = {
    id,
    kind: 'direct',
    name: input.name,
    host: input.host,
    port: input.port,
    fingerprint: input.fingerprint,
  }
  const list = [...targets]
  const existing = list.findIndex((t) => t.id === id)
  if (existing >= 0) list[existing] = next
  else list.push(next)
  return { targets: normalizeTargets(list.filter((t) => t.kind !== 'local')), target: next }
}

export function removeTarget(targets: readonly Target[], id: string): Target[] {
  return normalizeTargets(targets.filter((t) => t.kind !== 'local' && t.id !== id))
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
