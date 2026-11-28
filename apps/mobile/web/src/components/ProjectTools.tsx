import { getLocale, t, translateMessage } from '@qn/codex-client'
import { Archive, Ellipsis, FileText, Folder, Pin, PinOff, RotateCw, Terminal, type LucideIcon } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { callDevice } from '../client'
import { getWindowNativePort, NativeRequestError } from '../native'
import { parentFolder, projectConnection, projectRpc, type DeviceDownload, type ProjectFile, type ProjectFiles } from '../projectApi'
import { friendlyError } from '../state'
import { useApp } from '../store'
import type { Project } from '../types'
import { formatBytes } from '../viewer'
import { threadPreferenceKey, toggleProjectPin, useWorkspace, useWorkspacePreferences, workspaceProjectKey } from '../workspace'
import { AgentTag, Button, Dialog, Empty, Loading, Note, SheetAction } from './ui'
import { toast } from '../toast'

const TerminalPanel = lazy(async () => ({ default: (await import('./TerminalPanel')).TerminalPanel }))

/** 由调用方追加到项目工具菜单末尾的操作；点击后先关菜单再执行，避免两层弹层叠在一起。 */
export interface ProjectToolAction {
  icon: LucideIcon
  label: string
  onClick: () => void
}

export function ProjectTools({ project, compact = false, sortable = false, className = 'qn-list-action', actions = [] }: {
  project: Project
  compact?: boolean
  sortable?: boolean
  /** 菜单按钮样式：列表行用默认值，页面顶栏传顶栏图标样式。 */
  className?: string
  actions?: readonly ProjectToolAction[]
}) {
  const [tool, setTool] = useState<'files' | 'terminal' | 'menu' | 'archive' | null>(null)
  const desktopId = useApp((s) => s.activeId)
  const pinned = useWorkspacePreferences()?.pinnedProjects?.includes(workspaceProjectKey(project)) ?? false
  return (
    <>
      {!compact && (
        <Button variant="ghost" className="px-2" onClick={() => setTool('files')} aria-label={t('浏览 {name} 的文件', { name: project.name })} title={t('浏览文件')}>
          <Folder size={19} strokeWidth={1.75} aria-hidden />
        </Button>
      )}
      <Button variant="ghost" className={className} onClick={() => setTool('menu')}
        aria-label={t('{name} 的项目工具', { name: project.name })} aria-haspopup="dialog" title={t('项目工具')}>
        <Ellipsis size={19} strokeWidth={1.75} aria-hidden />
      </Button>
      {tool === 'menu' && (
        <Dialog title={project.name} onClose={() => setTool(null)}>
          <p className="qn-mono -mt-1 mb-2 break-all text-xs text-qn-muted">{project.path}</p>
          <div className="qn-sheet-actions">
            {desktopId && (
              <SheetAction icon={pinned ? PinOff : Pin} onClick={() => { toggleProjectPin(desktopId, project); setTool(null) }}>
                {pinned ? t('取消置顶（仅此手机）') : t('置顶（仅此手机）')}
              </SheetAction>
            )}
            {compact && <SheetAction icon={Folder} onClick={() => setTool('files')}>{t('浏览项目文件')}</SheetAction>}
            <SheetAction icon={Terminal} onClick={() => setTool('terminal')}>{t('打开项目终端')}</SheetAction>
            <SheetAction icon={Archive} onClick={() => setTool('archive')}>{t('已归档会话')}</SheetAction>
            {actions.map(({ icon, label, onClick }) => (
              <SheetAction key={label} icon={icon} onClick={() => { setTool(null); onClick() }}>{label}</SheetAction>
            ))}
          </div>
          {sortable && <p className="qn-hint mt-2">{t('长按项目行可拖动排序（仅此手机）')}</p>}
        </Dialog>
      )}
      {tool === 'files' && <ProjectFileBrowser key={`${desktopId}:${project.id}`} desktopId={desktopId} project={project} onClose={() => setTool(null)} />}
      {tool === 'archive' && desktopId && <ArchivedConversations key={`${desktopId}:${project.id}`} desktopId={desktopId} project={project} onClose={() => setTool(null)} />}
      {tool === 'terminal' && (
        <Dialog title={t('终端 · {name}', { name: project.name })} placement="full" onClose={() => setTool(null)}>
          <Suspense fallback={<p className="py-4 text-center text-sm text-qn-muted" role="status">{t('正在加载终端…')}</p>}>
            <TerminalPanel key={`${desktopId}:${project.id}`} project={project} />
          </Suspense>
        </Dialog>
      )}
    </>
  )
}

function ArchivedConversations({ desktopId, project, onClose }: { desktopId: string; project: Project; onClose: () => void }) {
  const list = useApp((s) => s.listArchivedConversations)
  const restore = useApp((s) => s.restoreConversation)
  const requestConnect = useApp((s) => s.requestConnect)
  const ready = useApp((s) => project.targetId === 'local' || s.targetStates[project.targetId]?.state === 'ready')
  const prefs = useWorkspacePreferences()
  const [result, setResult] = useState<Awaited<ReturnType<typeof list>> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!ready) return
    let current = true
    setResult(null)
    void list(project).then((value) => { if (current) setResult(value) },
      (error) => { if (current) setResult({ threads: [], error: friendlyError(error, t('读取归档失败')) }) })
    return () => { current = false }
  }, [list, project, attempt, ready])

  async function restoreThread(thread: NonNullable<typeof result>['threads'][number], key: string) {
    if (restoring) return
    setRestoring(key)
    setError(null)
    try {
      await restore(project.targetId, thread)
      setResult((current) => current && { ...current, threads: current.threads.filter((item) => item.id !== thread.id || item.agent !== thread.agent) })
      if (useApp.getState().activeId === desktopId) void useWorkspace.getState().loadProjects(desktopId)
    } catch (error) {
      setError(friendlyError(error, t('恢复会话失败')))
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Dialog title={t('已归档会话 · {name}', { name: project.name })} onClose={onClose}>
      {!ready ? <Note message={t('请先连接项目主机。')} actionLabel={t('连接主机')} onAction={() => requestConnect(project.targetId)} />
        : !result ? <Loading text={t('正在读取归档…')} /> : <>
          {result.error && <Note tone="error" message={result.error} actionLabel={t('重试')} onAction={() => setAttempt(attempt + 1)} />}
          {error && <Note tone="error" message={error} />}
          {!result.error && !result.threads.length && <Empty>{t('此项目没有已归档会话。')}</Empty>}
          {result.threads.map((thread) => {
            const key = threadPreferenceKey(project.targetId, thread.agent, thread.id)
            const title = prefs?.threads[key]?.title ?? thread.title
            return <div key={key} className="qn-row gap-2 border-b border-qn-border py-2">
              <div className="min-w-0 flex-1"><p className="truncate" title={title}>{title}</p><AgentTag agent={thread.agent} /></div>
              <Button aria-label={t('恢复 {title}', { title })} disabled={restoring !== null} onClick={() => void restoreThread(thread, key)}>
                {restoring === key ? t('恢复中…') : t('恢复')}
              </Button>
            </div>
          })}
        </>}
    </Dialog>
  )
}

/** 目录在前，组内按名称自然排序；电脑端返回的顺序不保证。 */
function sortEntries(entries: readonly ProjectFile[]): ProjectFile[] {
  return [...entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
    || a.name.localeCompare(b.name, getLocale() === 'en' ? 'en-US' : 'zh-CN', { numeric: true, sensitivity: 'base' }))
}

function ProjectFileBrowser({ project, desktopId, onClose }: {
  project: Project; desktopId: string | null; onClose: () => void
}) {
  const [path, setPath] = useState('')
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [listing, setListing] = useState<ProjectFiles | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [needsTarget, setNeedsTarget] = useState(false)
  const [selected, setSelected] = useState<ProjectFile | null>(null)
  const [job, setJob] = useState<DeviceDownload | null>(null)
  const [starting, setStarting] = useState(false)
  const reported = useRef<string | null>(null)
  const targetState = useApp((s) => s.targetStates[project.targetId]?.state)
  const requestConnect = useApp((s) => s.requestConnect)
  const fileAvailable = Boolean(getWindowNativePort())

  useEffect(() => {
    let current = true
    setListing(null)
    setMessage(null)
    setNeedsTarget(false)
    const search = query.trim()
    const timer = setTimeout(() => {
      void projectRpc<ProjectFiles>(project, search ? 'mobile.files.search' : 'mobile.files.list',
        { path, hidden, ...(search ? { query: search } : {}) }, desktopId).then((result) => {
        if (!current) return
        if (!result || !Array.isArray(result.entries)) {
          setMessage(t('电脑或目标服务版本不支持项目文件，请更新后重试'))
          return
        }
        setListing(result)
      }, (error: unknown) => {
        if (current) {
          const disconnected = error instanceof NativeRequestError && error.code === 'not_connected'
          setNeedsTarget(disconnected)
          setMessage(disconnected ? t('需要先连接此项目的目标。') : friendlyError(error, t('读取项目文件失败')))
        }
      })
    }, search ? 220 : 0)
    return () => { current = false; clearTimeout(timer) }
  }, [project, desktopId, path, query, hidden, refresh, targetState])

  const running = job?.state === 'running'

  // 打开页面时接上仍在后台进行的下载；进行中每 500ms 刷新一次进度。
  useEffect(() => {
    if (!fileAvailable) return
    let current = true
    const poll = () => callDevice<DeviceDownload | null>('download.status', job ? { id: job.id } : {}).then((next) => {
      if (!current || !next) return
      if (!job && next.state !== 'running') {
        // 页面打开前已结束的下载不再提示。
        reported.current = next.id
        return
      }
      setJob(next)
    }, () => undefined)
    if (!job) void poll()
    if (!running) return () => { current = false }
    const timer = setInterval(() => void poll(), 500)
    return () => { current = false; clearInterval(timer) }
  }, [fileAvailable, job?.id, running])

  useEffect(() => {
    if (!job || job.state === 'running' || reported.current === job.id) return
    reported.current = job.id
    if (job.state === 'done') {
      const name = job.savedName ?? job.name
      toast(job.auto ? t('已保存到 下载/QingCode/{name}', { name }) : t('已保存 {name}', { name }), { tone: 'ok' })
    } else if (job.state === 'failed') {
      toast(job.error ? translateMessage(job.error) : t('下载失败'), { tone: 'error' })
    }
  }, [job])

  function browse(next: string) {
    setPath(next)
    setQuery('')
    setSelected(null)
  }

  async function download(file: ProjectFile) {
    if (job?.state === 'running' || starting) return
    const connection = projectConnection(desktopId)
    if (!connection) {
      toast(t('请先连接电脑'), { tone: 'error' })
      return
    }
    setStarting(true)
    try {
      // 原生前台服务直接经网关拉取分块，应用切到后台或关闭此页面后继续下载。
      const started = await callDevice<DeviceDownload | null>('download.start', {
        host: connection.host, port: connection.port, fp: connection.fp, token: connection.token,
        projectId: project.id, targetId: project.targetId, path: file.path, name: file.name, size: file.size,
      }, 300_000)
      if (started) {
        setJob(started)
        if (started.auto) toast(t('已开始下载，可切到后台，进度见通知栏'), { tone: 'ok' })
      }
    } catch (error) {
      toast(friendlyError(error, t('下载失败')), { tone: 'error' })
    } finally {
      setStarting(false)
    }
  }

  function cancelDownload() {
    if (job) void callDevice('download.cancel', { id: job.id }).catch(() => undefined)
  }

  return (
    <Dialog title={t('项目文件 · {name}', { name: project.name })} placement="full" onClose={onClose}>
      <div className="space-y-2">
        <input type="search" className="qn-input" aria-label={t('搜索项目文件')} placeholder={t('搜索文件名或相对路径')}
          value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null) }} disabled={starting} />
        <div className="flex min-w-0 items-center gap-1 text-sm">
          <Button onClick={() => browse(parentFolder(path))} disabled={!path}>{t('上级')}</Button>
          <div className="min-w-0 flex-1 truncate text-qn-muted" title={path}>{path ? `/${path}` : '/'}</div>
          <label className="flex min-h-11 items-center gap-1 px-1 whitespace-nowrap">
            <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} disabled={starting} /> {t('隐藏文件')}
          </label>
          <Button variant="ghost" className="qn-list-action" aria-label={t('刷新文件')} onClick={() => setRefresh(refresh + 1)} disabled={starting}>
            <RotateCw size={17} strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
        {message && <Note message={message} tone="error" onClose={() => setMessage(null)}
          actionLabel={needsTarget ? t('连接目标') : undefined} onAction={needsTarget ? () => requestConnect(project.targetId) : undefined} />}
        {selected && (
          <div className="rounded-xl border border-qn-border bg-qn-card px-3 py-2">
            <p className="break-all text-sm font-medium">{selected.name}</p>
            <p className="my-1 text-xs text-qn-muted">{formatBytes(selected.size)} · {new Date(selected.mtimeMs).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN')}</p>
            {running && job.path === selected.path ? (
              <div className="flex items-center gap-2">
                <progress className="min-w-0 flex-1" value={job.written} max={job.size || 1} aria-label={t('下载进度')} />
                <span className="text-xs text-qn-muted">{formatBytes(job.written)} / {formatBytes(job.size)}</span>
                <Button onClick={cancelDownload}>{t('取消')}</Button>
              </div>
            ) : (
              <>
                {selected.size >= 100 * 1024 * 1024 && <p className="mb-2 text-xs text-qn-warn">{t('文件超过 100 MiB，请确认网络与存储空间。')}</p>}
                <div className="flex gap-2">
                  <Button variant="primary" disabled={!fileAvailable || running || starting} onClick={() => void download(selected)}>{t('下载')}</Button>
                  <Button variant="ghost" onClick={() => setSelected(null)}>{t('关闭详情')}</Button>
                </div>
                {!fileAvailable && <p className="text-xs text-qn-muted">{t('请在 Android 应用中下载。')}</p>}
                {running && <p className="mt-1 text-xs text-qn-muted">{t('正在下载 {name}，完成后可继续下载其他文件。', { name: job.name })}</p>}
              </>
            )}
          </div>
        )}
        {listing === null && !message && <p className="py-4 text-center text-sm text-qn-muted" role="status">{t('正在读取文件…')}</p>}
        {listing?.entries.length === 0 && <p className="py-4 text-center text-sm text-qn-muted">{query ? t('没有匹配的文件') : t('目录为空')}</p>}
        {listing?.truncated && <p className="text-xs text-qn-warn">{t('结果较多，请缩小查询范围。')}</p>}
        {listing && listing.entries.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-qn-border bg-qn-card">
            {(query.trim() ? listing.entries : sortEntries(listing.entries)).map((entry) => (
              <button key={entry.path} className="qn-row border-b border-qn-border px-3 py-2 last:border-0" type="button" disabled={starting}
                onClick={() => entry.kind === 'dir' ? browse(entry.path) : setSelected(entry)}>
                <span aria-hidden className={entry.kind === 'dir' ? 'text-qn-accent' : 'text-qn-muted'}>
                  {entry.kind === 'dir' ? (
                    <Folder size={18} strokeWidth={1.75} />
                  ) : (
                    <FileText size={18} strokeWidth={1.75} />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{query ? entry.path : entry.name}</span>
                {entry.kind === 'file' && <span className="text-xs whitespace-nowrap text-qn-muted">{formatBytes(entry.size)}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}
