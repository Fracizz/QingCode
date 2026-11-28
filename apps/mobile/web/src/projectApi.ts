import { t } from '@qn/codex-client'
import { getGateway } from './client'
import { isAbsolutePath, pathStyle } from './fileLinks'
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

/** 把预览的绝对路径映射到同一目标上最具体的项目，实际路径由目标服务核对。 */
export function projectFileLocation(projects: readonly Project[], targetId: string, filePath: string): { project: Project; path: string } | null {
  if (!isAbsolutePath(filePath)) return null
  let match: { project: Project; path: string } | null = null
  for (const project of projects) {
    if (project.targetId !== targetId || !isAbsolutePath(project.path)) continue
    const windows = pathStyle(project.path) === 'windows'
    // 旧 SSH 项目可能使用 /D:/...，文件链接则通常使用 D:\...。
    const toSlash = (value: string) => value.replace(/^\/(?=[A-Za-z]:[\\/])/, '').replaceAll('\\', '/')
    const root = windows ? toSlash(project.path) : project.path
    const file = windows ? toSlash(filePath) : filePath
    const prefix = root.replace(/\/+$/, '') + '/'
    const head = file.slice(0, prefix.length)
    if (windows ? head.toLowerCase() !== prefix.toLowerCase() : head !== prefix) continue
    const path = file.slice(prefix.length)
    if (path.split('/').some((part) => !part || part === '.' || part === '..' || /[:\\\u0000-\u001f]/.test(part))) continue
    if (!match || path.length < match.path.length) match = { project, path }
  }
  return match
}

export function parentFolder(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

/** 路径面包屑：每段带上到该段为止的相对路径，根目录由调用方用项目名表示。 */
export function folderCrumbs(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))
}

/** 列表里的修改时间：今年内省略年份，跨年才写全，窄屏一行放得下大小与时间。 */
export function formatFileTime(mtimeMs: number, locale: string, now = Date.now()): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return ''
  const date = new Date(mtimeMs)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleString(locale, {
    ...(sameYear ? {} : { year: 'numeric' }), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}
