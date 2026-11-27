import { RouterError } from '../router'

type RecordValue = Record<string, unknown>
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export async function mobileProject(
  invoke: (method: string, params: unknown) => Promise<unknown>,
  raw: unknown,
): Promise<{ id: string; targetId: string; root: string; params: RecordValue }> {
  if (!isRecord(raw) || typeof raw.projectId !== 'string' || !raw.projectId ||
    typeof raw.targetId !== 'string' || !raw.targetId) {
    throw new RouterError('invalid_params', '缺少项目或目标')
  }
  const targets = await invoke('projects.list', { targetId: raw.targetId })
  const project = Array.isArray(targets) && targets.find((candidate) =>
    isRecord(candidate) && candidate.id === raw.projectId && candidate.targetId === raw.targetId)
  if (!project || typeof project.path !== 'string' || !project.path) {
    throw new RouterError('not_found', '电脑上找不到该项目，请刷新项目列表')
  }
  return { id: raw.projectId, targetId: raw.targetId, root: project.path, params: raw }
}

export async function mobileProjectFiles(
  invoke: (method: string, params: unknown) => Promise<unknown>,
  method: string,
  raw: unknown,
): Promise<unknown> {
  const { root, targetId, params } = await mobileProject(invoke, raw)
  const read = method === 'mobile.files.read'
  const list = method === 'mobile.files.list'
  const serverMethod = read ? 'fs.project.read' : list ? 'fs.project.list' : 'fs.project.search'
  const path = params.path ?? ''
  const query = read || list ? undefined : params.query ?? ''
  return invoke('server.req', {
    targetId,
    method: serverMethod,
    params: {
      root,
      path,
      ...(read ? { offset: params.offset, length: params.length, version: params.version } : { hidden: params.hidden === true }),
      ...(query !== undefined ? { query, limit: params.limit } : {}),
    },
  })
}
