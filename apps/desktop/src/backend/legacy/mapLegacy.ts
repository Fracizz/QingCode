import type {
  LegacyCounts,
  LegacySkipped,
  SshAuth,
  SshTargetInput,
} from '../../shared/backendApi'
import { basenameOf, projectKey } from '../projectStore'

export type LegacyRow = Record<string, unknown>

export type LegacySnapshot = {
  connections: LegacyRow[]
  projects: LegacyRow[]
  secrets: Record<string, string>
}

export type LegacyTargetDraft = SshTargetInput & { id: string }
export type LegacyProjectDraft = {
  targetId: string
  name: string
  path: string
  lastOpenedAt: number
}
export type LegacyHostKeyDraft = { key: string; fingerprint: string }

export type ExistingLegacyState = {
  targetIds: ReadonlySet<string>
  projectKeys: ReadonlySet<string>
  hostKeys: ReadonlySet<string>
  secretTargetIds: ReadonlySet<string>
}

export type LegacyImportPlan = {
  targets: LegacyTargetDraft[]
  projects: LegacyProjectDraft[]
  hostKeys: LegacyHostKeyDraft[]
  secretIds: { legacyId: string; targetId: string }[]
  skipped: LegacySkipped[]
}

// 旧版 mode 列：'server' = SSH + 远端 server（正是本应用的远程模式），'ssh' = 纯 SSH，都应导入；
// 只有 'direct'/'agent'（不经 SSH 的直连）才跳过。
const isDirectMode = (mode: string): boolean => {
  const value = mode.trim().toLowerCase()
  return value === 'direct' || value === 'agent'
}

const text = (row: LegacyRow, key: string): string => {
  const value = row[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return ''
}

const portOf = (row: LegacyRow): number => {
  const value = row['port']
  const n = typeof value === 'string' ? Number(value)
    : typeof value === 'number' || typeof value === 'bigint' ? Number(value)
    : Number.NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 22
}

export function legacyTargetId(legacyId: string): string {
  return `legacy-${legacyId}`
}

// 旧版把 Server 直连占位也写进 ssh_connections，这类条目不是可 SSH 连接的目标。
export function isDirectConnection(row: LegacyRow): boolean {
  if (isDirectMode(text(row, 'mode'))) return true
  return text(row, 'username') === 'Agent' &&
    /^[0-9a-f]{64}$/i.test(text(row, 'host_key_fingerprint'))
}

export function mapLegacyAuth(row: LegacyRow): SshAuth {
  const kind = text(row, 'auth_kind').toLowerCase()
  if (kind === 'privatekey' || kind === 'private_key' || kind === 'key') {
    const keyPath = text(row, 'private_key_path')
    // 缺 keyPath 的私钥条目退化为 agent，避免写入无法解析的认证配置。
    return keyPath ? { kind: 'key', keyPath } : { kind: 'agent' }
  }
  if (kind === 'password') return { kind: 'password' }
  return { kind: 'agent' }
}

// 旧库时间戳可能是秒也可能是毫秒；统一成毫秒，异常值归零。
export function normalizeLegacyTimestamp(value: unknown): number {
  const n = typeof value === 'number' ? value
    : typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' && value.trim() !== '' ? Number(value)
    : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n < 1e11 ? n * 1000 : n)
}

export type MappedConnection = {
  legacyId: string
  targetId: string | null
  target: LegacyTargetDraft | null
  hostKey: LegacyHostKeyDraft | null
  skipped: LegacySkipped[]
}

export function mapLegacyConnection(row: LegacyRow): MappedConnection {
  const legacyId = text(row, 'id')
  const host = text(row, 'host')
  const name = text(row, 'name') || host || legacyId || '(未知连接)'
  const skipped: LegacySkipped[] = []
  const empty: MappedConnection = { legacyId, targetId: null, target: null, hostKey: null, skipped }
  if (!legacyId) {
    skipped.push({ kind: 'connection', name, reason: '缺少连接 id' })
    return empty
  }
  if (isDirectConnection(row)) {
    skipped.push({ kind: 'connection', name, reason: 'Server 直连条目' })
    return empty
  }
  if (!host) {
    skipped.push({ kind: 'connection', name, reason: '缺少主机地址' })
    return empty
  }
  const username = text(row, 'username')
  if (!username) {
    skipped.push({ kind: 'connection', name, reason: '缺少用户名' })
    return empty
  }
  const port = portOf(row)
  const targetId = legacyTargetId(legacyId)
  const target: LegacyTargetDraft = {
    id: targetId,
    name,
    host,
    port,
    username,
    auth: mapLegacyAuth(row),
  }
  const fingerprint = text(row, 'host_key_fingerprint')
  let hostKey: LegacyHostKeyDraft | null = null
  if (fingerprint.startsWith('SHA256:')) {
    hostKey = { key: `${host}:${port}`, fingerprint }
  } else if (fingerprint) {
    skipped.push({ kind: 'hostKey', name: `${host}:${port}`, reason: '指纹格式不支持' })
  }
  return { legacyId, targetId, target, hostKey, skipped }
}

export type MappedProject = {
  project: LegacyProjectDraft | null
  skipped: LegacySkipped[]
}

export function mapLegacyProject(
  row: LegacyRow,
  knownTargetIds: ReadonlySet<string>
): MappedProject {
  const name = text(row, 'name')
  const kind = text(row, 'kind') || 'local'
  const lastOpenedAt = normalizeLegacyTimestamp(row['last_opened_at'])
  const skipped: LegacySkipped[] = []
  const displayName = name || text(row, 'path') || '(未知项目)'

  if (kind === 'local') {
    const path = text(row, 'path')
    if (!path) {
      skipped.push({ kind: 'project', name: displayName, reason: '缺少项目路径' })
      return { project: null, skipped }
    }
    return {
      project: {
        targetId: 'local',
        name: name || basenameOf(path),
        path,
        lastOpenedAt,
      },
      skipped,
    }
  }

  const legacyId = text(row, 'connection_id')
  if (!legacyId) {
    skipped.push({ kind: 'project', name: displayName, reason: '缺少关联连接 id' })
    return { project: null, skipped }
  }
  const targetId = legacyTargetId(legacyId)
  if (!knownTargetIds.has(targetId)) {
    skipped.push({ kind: 'project', name: displayName, reason: '关联连接不存在或未导入' })
    return { project: null, skipped }
  }
  const path = text(row, 'root_path') || text(row, 'path')
  if (!path) {
    skipped.push({ kind: 'project', name: displayName, reason: '缺少远端项目路径' })
    return { project: null, skipped }
  }
  return {
    project: { targetId, name: name || basenameOf(path), path, lastOpenedAt },
    skipped,
  }
}

export function countLegacy(snapshot: LegacySnapshot): LegacyCounts {
  let localProjects = 0
  let sshProjects = 0
  for (const row of snapshot.projects) {
    if ((text(row, 'kind') || 'local') === 'local') localProjects++
    else sshProjects++
  }
  return {
    connections: snapshot.connections.length,
    localProjects,
    sshProjects,
    secrets: Object.keys(snapshot.secrets).length,
  }
}

// 纯逻辑：把旧库快照与当前已导入状态对比，产出"这次真正要写什么"。
export function planLegacyImport(
  snapshot: LegacySnapshot,
  current: ExistingLegacyState,
  includeSecrets: boolean
): LegacyImportPlan {
  const plan: LegacyImportPlan = {
    targets: [],
    projects: [],
    hostKeys: [],
    secretIds: [],
    skipped: [],
  }
  const targetIdByLegacyId = new Map<string, string>()
  const plannedTargetIds = new Set<string>()
  const plannedHostKeys = new Set<string>()

  for (const row of snapshot.connections) {
    const mapped = mapLegacyConnection(row)
    plan.skipped.push(...mapped.skipped)
    if (!mapped.targetId) continue
    targetIdByLegacyId.set(mapped.legacyId, mapped.targetId)
    if (mapped.target) {
      if (current.targetIds.has(mapped.targetId) || plannedTargetIds.has(mapped.targetId)) {
        plan.skipped.push({ kind: 'connection', name: mapped.target.name, reason: '已导入' })
      } else {
        plan.targets.push(mapped.target)
        plannedTargetIds.add(mapped.targetId)
      }
    }
    if (mapped.hostKey) {
      if (current.hostKeys.has(mapped.hostKey.key) || plannedHostKeys.has(mapped.hostKey.key)) {
        plan.skipped.push({ kind: 'hostKey', name: mapped.hostKey.key, reason: '已存在' })
      } else {
        plan.hostKeys.push(mapped.hostKey)
        plannedHostKeys.add(mapped.hostKey.key)
      }
    }
  }

  const knownTargetIds = new Set(targetIdByLegacyId.values())
  const plannedProjectKeys = new Set<string>()
  for (const row of snapshot.projects) {
    const mapped = mapLegacyProject(row, knownTargetIds)
    plan.skipped.push(...mapped.skipped)
    if (!mapped.project) continue
    const key = projectKey(mapped.project.targetId, mapped.project.path)
    if (current.projectKeys.has(key) || plannedProjectKeys.has(key)) {
      plan.skipped.push({ kind: 'project', name: mapped.project.name, reason: '已存在' })
      continue
    }
    plan.projects.push(mapped.project)
    plannedProjectKeys.add(key)
  }

  if (includeSecrets) {
    const plannedSecretTargetIds = new Set<string>()
    for (const legacyId of Object.keys(snapshot.secrets)) {
      const targetId = targetIdByLegacyId.get(legacyId)
      if (!targetId) {
        plan.skipped.push({ kind: 'secret', name: legacyId, reason: '关联连接不存在或未导入' })
        continue
      }
      if (current.secretTargetIds.has(targetId) || plannedSecretTargetIds.has(targetId)) {
        plan.skipped.push({ kind: 'secret', name: legacyId, reason: '已存在' })
        continue
      }
      plan.secretIds.push({ legacyId, targetId })
      plannedSecretTargetIds.add(targetId)
    }
  }
  return plan
}
