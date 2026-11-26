import type {
  LegacyDetectResult,
  LegacyImportResult,
  LegacySkipped,
} from '../../shared/backendApi'
import { backendConfig } from '../config'
import {
  createProjectId,
  projectKey,
  readProjects,
  upsertProject,
  writeProjects,
} from '../projectStore'
import {
  defaultSecretCipher,
  parseStoredSecret,
  readSecretStore,
  saveSecret,
  type SecretCipher,
} from '../secretStore'
import { readTargets, upsertTarget, writeTargets } from '../targetStore'
import { decryptLegacySecrets } from './dpapi'
import { readKnownHostsFile, writeKnownHostsFile } from './knownHosts'
import {
  countLegacy,
  planLegacyImport,
  type ExistingLegacyState,
  type LegacySnapshot,
} from './mapLegacy'
import { defaultLegacyDbPath, legacyDbExists, readLegacySnapshot } from './readLegacyDb'

export type LegacyDeps = {
  userData: string
  cipher: SecretCipher
  readDb: (path: string) => Promise<LegacySnapshot>
  dbExists: (path: string) => Promise<boolean>
  decrypt: (entries: Record<string, string>) => Promise<Record<string, string | null>>
}

export type LegacyImportParams = {
  path?: string
  includeSecrets?: boolean
}

const emptyCounts = (): LegacyDetectResult['counts'] => ({
  connections: 0,
  localProjects: 0,
  sshProjects: 0,
  secrets: 0,
})

function defaultDeps(): LegacyDeps {
  return {
    userData: backendConfig.userData,
    cipher: defaultSecretCipher(),
    readDb: readLegacySnapshot,
    dbExists: legacyDbExists,
    decrypt: decryptLegacySecrets,
  }
}

function resolvePath(path?: string): string {
  return typeof path === 'string' && path.trim() !== '' ? path.trim() : defaultLegacyDbPath()
}

export async function detectLegacy(
  path?: string,
  deps: Partial<Pick<LegacyDeps, 'readDb' | 'dbExists'>> = {}
): Promise<LegacyDetectResult> {
  const dbPath = resolvePath(path)
  const readDb = deps.readDb ?? readLegacySnapshot
  const dbExists = deps.dbExists ?? legacyDbExists
  const notFound: LegacyDetectResult = { found: false, path: dbPath, counts: emptyCounts() }
  if (!(await dbExists(dbPath))) return notFound
  try {
    const snapshot = await readDb(dbPath)
    return { found: true, path: dbPath, counts: countLegacy(snapshot) }
  } catch {
    // 只读预览不应因为旧库损坏而让 UI 报错。
    return notFound
  }
}

export async function importLegacyData(
  params: LegacyImportParams = {},
  deps: Partial<LegacyDeps> = {}
): Promise<LegacyImportResult> {
  const d: LegacyDeps = { ...defaultDeps(), ...deps }
  const dbPath = resolvePath(params.path)
  if (!(await d.dbExists(dbPath))) throw new Error('旧版数据库不存在：' + dbPath)
  const snapshot = await d.readDb(dbPath)

  const targets = await readTargets(d.userData)
  const projects = await readProjects(d.userData)
  const hosts = await readKnownHostsFile(d.userData)
  const storedSecrets = await readSecretStore(d.userData)
  const current: ExistingLegacyState = {
    targetIds: new Set(targets.map((t) => t.id)),
    projectKeys: new Set(projects.map((p) => projectKey(p.targetId, p.path))),
    hostKeys: new Set(Object.keys(hosts)),
    secretTargetIds: new Set(Object.keys(storedSecrets)),
  }
  const plan = planLegacyImport(snapshot, current, params.includeSecrets === true)
  const skipped: LegacySkipped[] = [...plan.skipped]

  let nextTargets = targets
  for (const target of plan.targets) {
    nextTargets = upsertTarget(nextTargets, target, target.id).targets
  }
  if (plan.targets.length > 0) await writeTargets(d.userData, nextTargets)

  let nextProjects = projects
  for (const project of plan.projects) {
    nextProjects = upsertProject(nextProjects, project, createProjectId()).projects
  }
  if (plan.projects.length > 0) await writeProjects(d.userData, nextProjects)

  if (plan.hostKeys.length > 0) {
    const nextHosts = { ...hosts }
    for (const item of plan.hostKeys) nextHosts[item.key] = item.fingerprint
    await writeKnownHostsFile(d.userData, nextHosts)
  }

  let importedSecrets = 0
  if (plan.secretIds.length > 0) {
    const entries: Record<string, string> = {}
    for (const item of plan.secretIds) {
      const encoded = snapshot.secrets[item.legacyId]
      if (encoded) entries[item.legacyId] = encoded
    }
    const plaintexts = await d.decrypt(entries)
    for (const item of plan.secretIds) {
      const secret = parseStoredSecret(plaintexts[item.legacyId] ?? null)
      if (!secret) {
        skipped.push({ kind: 'secret', name: item.legacyId, reason: '解密失败或明文格式不支持' })
        continue
      }
      try {
        await saveSecret(item.targetId, secret, { userData: d.userData, cipher: d.cipher })
        importedSecrets++
      } catch {
        // safeStorage 不可用时不应让已导入的连接/项目整体失败。
        skipped.push({ kind: 'secret', name: item.legacyId, reason: '保存凭据失败' })
      }
    }
  }

  return {
    imported: {
      targets: plan.targets.length,
      projects: plan.projects.length,
      hostKeys: plan.hostKeys.length,
      secrets: importedSecrets,
    },
    skipped,
  }
}
