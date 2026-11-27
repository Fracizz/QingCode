import { backendConfig } from './config'
import { setSecretProvider } from './credentials'
import { detectLegacy, importLegacyData } from './legacy/importLegacy'
import {
  createProjectId,
  listProjects,
  readProjects,
  removeProject,
  upsertProject,
  writeProjects,
} from './projectStore'
import { RouterError, type BackendRouter } from './router'
import { loadSecret, removeSecret, saveSecret } from './secretStore'

// T8：项目、凭据、旧版导入（projects.*、legacy.*、target.forgetSecret）。
const asRecord = (x: unknown): Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
    ? x as Record<string, unknown>
    : {}

function requireId(params: unknown): string {
  const id = asRecord(params).id
  if (typeof id !== 'string' || id === '') {
    throw new RouterError('invalid_params', '缺少 id')
  }
  return id
}

export function registerDataMethods(router: BackendRouter): void {
  // T5 的凭据注入点：显式接上 safeStorage，避免运行时动态拼模块路径失败。
  setSecretProvider({
    loadSecret: (targetId) => loadSecret(targetId),
    saveSecret: (targetId, credentials) => saveSecret(targetId, credentials),
  })

  router.register('projects.list', async (params) => {
    const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
    return listProjects(await readProjects(backendConfig.userData), targetId)
  })

  router.register('projects.save', async (params) => {
    const p = asRecord(params)
    const targetId = typeof p.targetId === 'string' ? p.targetId.trim() : ''
    const path = typeof p.path === 'string' ? p.path.trim() : ''
    if (targetId === '') throw new RouterError('invalid_params', '目标不能为空')
    if (path === '') throw new RouterError('invalid_params', '项目路径不能为空')
    const id = typeof p.id === 'string' && p.id !== '' ? p.id : undefined
    const name = typeof p.name === 'string' ? p.name : undefined
    const trusted = typeof p.trusted === 'boolean' ? p.trusted : undefined
    const current = await readProjects(backendConfig.userData)
    const { projects, project } = upsertProject(
      current,
      { id, targetId, name, path, trusted },
      createProjectId()
    )
    await writeProjects(backendConfig.userData, projects)
    return project
  })

  router.register('projects.remove', async (params) => {
    const id = requireId(params)
    const current = await readProjects(backendConfig.userData)
    await writeProjects(backendConfig.userData, removeProject(current, id))
  })

  router.register('legacy.detect', (params) => {
    const path = typeof params?.path === 'string' ? params.path : undefined
    return detectLegacy(path)
  })

  router.register('legacy.import', (params) => {
    const p = asRecord(params)
    const path = typeof p.path === 'string' ? p.path : undefined
    return importLegacyData({ path, includeSecrets: p.includeSecrets === true })
  })

  router.register('target.forgetSecret', async (params) => {
    await removeSecret(requireId(params))
  })
}
