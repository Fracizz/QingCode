import type { FsReadResult } from '@qn/protocol'
import type { OpenRequest } from '../workspace/openers'
import { basename, dirname } from './fileLinks'

export type TabStatus = 'loading' | 'ready' | 'error'
export type DiffMode = 'worktree' | 'staged' | 'commit' | 'text'
export type TabView = 'source' | 'preview'

/** 文件与差异共用一种标签，避免两套数组同步；未用到的字段留默认值。 */
export type Tab = {
  id: string
  kind: 'file' | 'diff'
  targetId: string
  path: string
  cwd?: string
  title: string
  line?: number
  column?: number
  mode?: DiffMode
  commit?: string
  status: TabStatus
  /** 每次发起 IO 自增，结果回来时比对，丢弃过期响应。 */
  revision: number
  busy?: boolean
  content: string
  encoding: 'utf8' | 'base64' | null
  size: number
  mtimeMs: number
  offset: number
  loadedBytes: number
  truncated: boolean
  binary: boolean
  diff: string
  diffTruncated?: boolean
  sourceDiff?: string
  view: TabView
  error?: string
  errorCode?: string
  notice?: string
}

export function diffModeLabel(mode: DiffMode, commit?: string): string {
  switch (mode) {
    case 'staged':
      return '暂存区对比'
    case 'commit':
      return commit ? `提交 ${commit.slice(0, 7)}` : '提交对比'
    case 'text':
      return '本轮改动'
    default:
      return '与 HEAD 对比'
  }
}

/** 文件按 targetId+path 复用；差异再按 mode+commit 复用。 */
export function tabKeyOf(tab: Pick<Tab, 'kind' | 'targetId' | 'path' | 'mode' | 'commit'>): string {
  return JSON.stringify([
    tab.kind,
    tab.targetId,
    tab.path,
    tab.kind === 'diff' ? (tab.mode ?? 'worktree') : '',
    tab.kind === 'diff' ? (tab.commit ?? '') : '',
  ])
}

export function createTab(req: OpenRequest, id: string): Tab {
  const tab: Tab = {
    id,
    kind: req.kind,
    targetId: req.targetId,
    path: req.path,
    cwd: req.kind === 'diff' ? req.cwd : dirname(req.path),
    title: basename(req.path) || req.path,
    status: 'loading',
    revision: 1,
    content: '',
    encoding: null,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    loadedBytes: 0,
    truncated: false,
    binary: false,
    diff: '',
    view: 'source',
  }
  if (req.kind === 'file') {
    if (req.line !== undefined) tab.line = req.line
    if (req.column !== undefined) tab.column = req.column
    return tab
  }
  const mode: DiffMode = req.mode ?? 'worktree'
  tab.mode = mode
  if (req.commit) tab.commit = req.commit
  if (req.diff) tab.sourceDiff = req.diff
  tab.title = req.title ?? `${tab.title} · ${diffModeLabel(mode, req.commit)}`
  if (mode === 'text') {
    tab.diff = req.diff ?? ''
    tab.status = 'ready'
  }
  return tab
}

export type UpsertResult = {
  tabs: Tab[]
  id: string
  /** 新标签，需要发起读取/取 diff。 */
  created: boolean
  /** 原有标签处于错误态，需要重试。 */
  retry: boolean
}

export function upsertTab(tabs: Tab[], incoming: Tab): UpsertResult {
  const key = tabKeyOf(incoming)
  const index = tabs.findIndex((tab) => tabKeyOf(tab) === key)
  const existing = index >= 0 ? tabs[index] : undefined
  if (!existing) return { tabs: [...tabs, incoming], id: incoming.id, created: true, retry: false }
  const retry = existing.status === 'error'
  const merged: Tab = {
    ...existing,
    cwd: incoming.cwd ?? existing.cwd,
    line: incoming.line ?? existing.line,
    column: incoming.column ?? existing.column,
    sourceDiff: incoming.sourceDiff ?? existing.sourceDiff,
    title: incoming.title || existing.title,
    ...(retry
      ? { status: 'loading' as TabStatus, revision: existing.revision + 1, error: undefined, errorCode: undefined }
      : {}),
  }
  const next = [...tabs]
  next[index] = merged
  return { tabs: next, id: existing.id, created: false, retry }
}

export function closeTab(
  tabs: Tab[],
  activeId: string | null,
  id: string,
): { tabs: Tab[]; activeId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return { tabs, activeId }
  const next = tabs.filter((tab) => tab.id !== id)
  const active = activeId === id ? (next[Math.min(index, next.length - 1)]?.id ?? null) : activeId
  return { tabs: next, activeId: active }
}

/** 合并首读/续读结果；utf8 续读时拼接文本。 */
export function mergeRead(tab: Tab, result: FsReadResult, append: boolean): Tab {
  return {
    ...tab,
    status: 'ready',
    busy: false,
    content: append ? tab.content + result.content : result.content,
    encoding: result.encoding,
    size: result.size,
    mtimeMs: result.mtimeMs,
    offset: result.offset,
    loadedBytes: result.offset + result.length,
    truncated: result.truncated,
    binary: result.binary,
    error: undefined,
    errorCode: undefined,
  }
}

const ERROR_TEXT: Record<string, string> = {
  not_found: '文件不存在',
  permission: '没有权限读取该文件',
  too_large: '文件过大，无法完整读取',
  conflict: '文件已被外部修改，请刷新',
  params: '路径参数无效',
  exists: '目标已存在',
  not_empty: '目录非空',
  not_repo: '当前目录不是 Git 仓库',
  git_missing: '目标机器上未安装 git',
  git_failed: 'git 命令执行失败',
  auth_required: '远端需要认证，请在远端配置 ssh-agent 或凭据助手',
  not_connected: '目标尚未连接，请先连接',
  unknown_method: 'server 不支持该操作，请升级到新版本',
  method: 'server 不支持该操作，请升级到新版本',
  not_implemented: '后端功能尚未接入，当前版本暂不可用',
  invalid_params: '请求参数无效',
  internal: '操作失败',
}

export function errorCodeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

/** 错误码优先给固定中文文案；未知错误才附带后端原始信息（截断，避免刷屏）。 */
export function errorMessage(err: unknown, fallback = '操作失败'): string {
  const code = errorCodeOf(err)
  const mapped = ERROR_TEXT[code]
  if (mapped) {
    if (code === 'git_failed') {
      const detail = err instanceof Error ? err.message : ''
      return detail ? `${mapped}：${detail.slice(0, 200)}` : mapped
    }
    return mapped
  }
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return detail ? `${fallback}：${detail.slice(0, 200)}` : fallback
}

export function failedTab(tab: Tab, err: unknown, fallback: string): Tab {
  return {
    ...tab,
    status: 'error',
    busy: false,
    error: errorMessage(err, fallback),
    errorCode: errorCodeOf(err) || undefined,
  }
}

/** fs.changed 事件 payload → 路径列表；脏数据直接忽略。 */
export function changedPaths(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return []
  const paths = (payload as { paths?: unknown }).paths
  if (!Array.isArray(paths)) return []
  return paths.filter((item): item is string => typeof item === 'string' && item !== '')
}

/** 供总管合并登记 fs.watch：已打开的文件标签路径去重。 */
export function watchPaths(tabs: Tab[], targetId: string): string[] {
  const paths = new Set<string>()
  for (const tab of tabs) {
    if (tab.kind === 'file' && tab.targetId === targetId) paths.add(tab.path)
  }
  return [...paths]
}

/** 所有目标的文件标签集合指纹：只有增删标签才需要重新登记 fs.watch。 */
export function watchKey(tabs: Tab[]): string {
  const keys = new Set<string>()
  for (const tab of tabs) {
    if (tab.kind === 'file') keys.add(`${tab.targetId}\u0000${tab.path}`)
  }
  return [...keys].sort().join('\n')
}

/** Windows 路径大小写/分隔符不敏感，POSIX 严格区分；仅用于 fs.changed 匹配。 */
export function pathWatchKey(path: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
  return windows ? path.replace(/\//g, '\\').toLowerCase() : path
}

/** 续读后改口显示已加载量，避免大文件提示与实际内容不符。 */
export function loadedLabel(loadedBytes: number): string {
  const limit = 2 * 1024 * 1024
  if (!Number.isFinite(loadedBytes) || loadedBytes <= limit) return '仅显示前 2 MiB'
  return `已加载 ${(loadedBytes / (1024 * 1024)).toFixed(1)} MiB`
}
