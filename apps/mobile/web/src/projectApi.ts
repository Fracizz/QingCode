import { t } from '@qn/codex-client'
import { getGateway } from './client'
import { useApp } from './store'
import type { Connection, Project, RpcMethod } from './types'

export type ProjectFile = { path: string; name: string; kind: 'dir' | 'file'; size: number; mtimeMs: number }
export type ProjectFiles = { entries: ProjectFile[]; truncated: boolean }
/** 原生后台下载的状态快照；auto 表示自动保存到「下载/QingCode」。 */
export type DeviceDownload = {
  id: string; name: string; path: string; size: number; written: number
  state: 'running' | 'done' | 'failed' | 'cancelled'; auto: boolean; error?: string; savedName?: string
}

/** 当前选中的电脑连接；电脑已切换时返回 null。 */
export function projectConnection(desktopId?: string | null): Connection | null {
  const { activeId, connections } = useApp.getState()
  if (desktopId !== undefined && activeId !== desktopId) return null
  return connections.find((item) => item.id === activeId) ?? null
}

export function projectRpc<T>(project: Project, method: RpcMethod, params: Record<string, unknown> = {}, desktopId?: string | null): Promise<T> {
  const { activeId, connections } = useApp.getState()
  if (desktopId !== undefined && activeId !== desktopId) return Promise.reject(new Error(t('电脑连接已切换')))
  const connection = connections.find((item) => item.id === activeId)
  if (!connection) return Promise.reject(new Error(t('请先连接电脑')))
  return getGateway().rpc<T>(connection, method, { ...params, projectId: project.id, targetId: project.targetId })
}

export async function suggestFiles(project: Project, query: string): Promise<ProjectFile[]> {
  return (await projectRpc<ProjectFiles>(project, 'mobile.files.search', { query, limit: 8 })).entries
}

export function parentFolder(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}
