import { t } from '@qn/codex-client'
import { getGateway } from './client'
import { useApp } from './store'
import type { Project, RpcMethod } from './types'

export type ProjectFile = { path: string; name: string; kind: 'dir' | 'file'; size: number; mtimeMs: number }
export type ProjectFiles = { entries: ProjectFile[]; truncated: boolean }
export type DownloadChunk = { content: string; length: number; size: number; version: string }

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
