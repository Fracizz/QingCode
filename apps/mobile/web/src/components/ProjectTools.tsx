import { getLocale, t } from '@qn/codex-client'
import { Archive, ArrowUp, Check, ChevronRight, Download, Ellipsis, Eye, EyeOff, FileText, Folder, Pin, PinOff, RotateCw, Terminal, X, type LucideIcon } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { callDevice } from '../client'
import { watchDownload } from '../downloads'
import { getWindowNativePort, NativeRequestError } from '../native'
import { folderCrumbs, formatFileTime, parentFolder, projectConnection, projectRpc, type DeviceDownload, type ProjectFile, type ProjectFiles } from '../projectApi'
import { friendlyError } from '../state'
import { useApp } from '../store'
import type { Project } from '../types'
import { formatBytes } from '../viewer'
import { threadPreferenceKey, toggleProjectPin, useWorkspace, useWorkspacePreferences, workspaceProjectKey } from '../workspace'
import { AgentTag, Button, Dialog, Empty, Loading, LoadingIcon, Note, SheetAction } from './ui'
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

const LARGE_FILE_BYTES = 100 * 1024 * 1024

type FileState = 'running' | 'starting' | 'done' | 'idle'

function DownloadProgress({ job }: { job: DeviceDownload }) {
  return (
    <span className="mt-1.5 flex items-center gap-2">
      <progress className="min-w-0 flex-1" value={job.written} max={job.size || 1} aria-label={t('下载进度')} />
      <span className="text-xs whitespace-nowrap text-qn-muted tabular-nums">{formatBytes(job.written)} / {formatBytes(job.size)}</span>
    </span>
  )
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
  const [confirming, setConfirming] = useState<ProjectFile | null>(null)
  const [job, setJob] = useState<DeviceDownload | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const targetState = useApp((s) => s.targetStates[project.targetId]?.state)
  const requestConnect = useApp((s) => s.requestConnect)
  const fileAvailable = Boolean(getWindowNativePort())
  const locale = getLocale() === 'en' ? 'en-US' : 'zh-CN'

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
  const busy = running || starting !== null

  // 打开页面时接上仍在后台进行的下载；进行中每 500ms 刷新一次进度。
  useEffect(() => {
    if (!fileAvailable) return
    let current = true
    const poll = () => callDevice<DeviceDownload | null>('download.status', job ? { id: job.id } : {}).then((next) => {
      if (!current || !next) return
      if (!job && next.state !== 'running') return
      // 页面重开时接上仍在进行的下载，完成提示统一交给应用层监听。
      if (next.state === 'running') watchDownload(next.id)
      setJob(next)
    }, () => undefined)
    if (!job) void poll()
    if (!running) return () => { current = false }
    const timer = setInterval(() => void poll(), 500)
    return () => { current = false; clearInterval(timer) }
  }, [fileAvailable, job?.id, running])

  function browse(next: string) {
    setPath(next)
    setQuery('')
    setSelected(null)
  }

  async function download(file: ProjectFile) {
    if (busy) return
    const connection = projectConnection(desktopId)
    if (!connection) {
      toast(t('请先连接电脑'), { tone: 'error' })
      return
    }
    setStarting(file.path)
    try {
      // 原生前台服务直接经网关拉取分块，应用切到后台或关闭此页面后继续下载。
      const started = await callDevice<DeviceDownload | null>('download.start', {
        host: connection.host, port: connection.port, fp: connection.fp, token: connection.token,
        projectId: project.id, targetId: project.targetId, path: file.path, name: file.name, size: file.size,
      }, 300_000)
      if (started) {
        setJob(started)
        // 不阻塞：可以继续浏览、关掉此页或切到后台，完成后由 watchDownload 提示。
        watchDownload(started.id)
        toast(t('已开始后台下载，完成后会提醒你'))
      }
    } catch (error) {
      toast(friendlyError(error, t('下载失败')), { tone: 'error' })
    } finally {
      setStarting(null)
    }
  }

  /** 行尾下载键：先弹确认框，确定后转入后台下载。 */
  function quickDownload(file: ProjectFile) {
    setConfirming(file)
  }

  function confirmDownload() {
    const file = confirming
    setConfirming(null)
    if (file) void download(file)
  }

  function cancelDownload() {
    if (job) void callDevice('download.cancel', { id: job.id }).catch(() => undefined)
  }

  function fileState(file: ProjectFile): FileState {
    if (job?.path === file.path && job.state === 'running') return 'running'
    if (starting === file.path) return 'starting'
    if (job?.path === file.path && job.state === 'done') return 'done'
    return 'idle'
  }

  const searching = query.trim() !== ''
  const entries = listing ? (searching ? listing.entries : sortEntries(listing.entries)) : []
  const crumbs = folderCrumbs(path)
  // 正在下载的文件不在当前列表里（换了目录或在搜索）时，在顶部保留一条进度，随时可取消。
  const jobVisible = running && entries.some((entry) => entry.path === job.path)

  return (
    <Dialog title={t('项目文件 · {name}', { name: project.name })} placement="full" onClose={onClose}>
      <div className="space-y-2">
        <input type="search" className="qn-input" aria-label={t('搜索项目文件')} placeholder={t('搜索文件名或相对路径')}
          value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null) }} />
        <div className="flex min-w-0 items-center gap-1">
          <Button variant="ghost" className="qn-list-action shrink-0" aria-label={t('上级目录')} title={t('上级目录')}
            onClick={() => browse(parentFolder(path))} disabled={!path || searching}>
            <ArrowUp size={18} strokeWidth={1.75} aria-hidden />
          </Button>
          {/* 面包屑可横向滚动，深层目录也能一步跳回任意上级。 */}
          <nav className="flex min-w-0 flex-1 items-center overflow-x-auto text-sm whitespace-nowrap" aria-label={t('当前目录')}>
            <button type="button" className={`min-h-11 shrink-0 px-1 ${crumbs.length ? 'text-qn-muted' : 'font-medium'}`}
              onClick={() => browse('')} aria-current={crumbs.length ? undefined : 'page'}>{project.name}</button>
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1
              return (
                <span key={crumb.path} className="flex shrink-0 items-center">
                  <ChevronRight size={14} className="text-qn-dim" aria-hidden />
                  <button type="button" className={`min-h-11 px-1 ${last ? 'font-medium' : 'text-qn-muted'}`}
                    onClick={() => browse(crumb.path)} aria-current={last ? 'page' : undefined}>{crumb.name}</button>
                </span>
              )
            })}
          </nav>
          <Button variant="ghost" className={`qn-list-action shrink-0 ${hidden ? 'text-qn-accent' : ''}`} aria-pressed={hidden}
            aria-label={t('显示隐藏文件')} title={t('显示隐藏文件')} onClick={() => setHidden(!hidden)}>
            {hidden ? <Eye size={18} strokeWidth={1.75} aria-hidden /> : <EyeOff size={18} strokeWidth={1.75} aria-hidden />}
          </Button>
          <Button variant="ghost" className="qn-list-action shrink-0" aria-label={t('刷新文件')} onClick={() => setRefresh(refresh + 1)}>
            <RotateCw size={17} strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
        {!fileAvailable && <p className="qn-hint">{t('请在 Android 应用中下载。')}</p>}
        {running && !jobVisible && (
          <div className="rounded-xl border border-qn-border bg-qn-card px-3 py-2">
            <div className="flex items-center gap-2">
              <Download size={16} className="shrink-0 text-qn-accent" aria-hidden />
              <p className="min-w-0 flex-1 truncate text-sm" title={job.name}>{t('正在下载 {name}', { name: job.name })}</p>
              <Button variant="ghost" className="qn-list-action -my-1 shrink-0" aria-label={t('取消下载 {name}', { name: job.name })} onClick={cancelDownload}>
                <X size={18} aria-hidden />
              </Button>
            </div>
            <DownloadProgress job={job} />
          </div>
        )}
        {message && <Note message={message} tone="error" onClose={() => setMessage(null)}
          actionLabel={needsTarget ? t('连接目标') : undefined} onAction={needsTarget ? () => requestConnect(project.targetId) : undefined} />}
        {listing === null && !message && <p className="py-4 text-center text-sm text-qn-muted" role="status">{t('正在读取文件…')}</p>}
        {listing?.entries.length === 0 && <p className="py-4 text-center text-sm text-qn-muted">{searching ? t('没有匹配的文件') : t('目录为空')}</p>}
        {listing?.truncated && <p className="text-xs text-qn-warn">{t('结果较多，请缩小查询范围。')}</p>}
        {entries.length > 0 && (
          <ul className="overflow-hidden rounded-xl border border-qn-border bg-qn-card">
            {entries.map((entry) => {
              const label = searching ? entry.path : entry.name
              if (entry.kind === 'dir') {
                return (
                  <li key={entry.path} className="border-b border-qn-border last:border-0">
                    <button className="qn-row px-3 py-2" type="button" onClick={() => browse(entry.path)}>
                      <Folder size={18} strokeWidth={1.75} className="shrink-0 text-qn-accent" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                      <ChevronRight size={16} className="shrink-0 text-qn-dim" aria-hidden />
                    </button>
                  </li>
                )
              }
              const state = fileState(entry)
              return (
                <li key={entry.path} className="flex items-center border-b border-qn-border last:border-0">
                  <button className="qn-row min-w-0 flex-1 items-start py-2.5 pr-1 pl-3" type="button" onClick={() => setSelected(entry)}>
                    <FileText size={18} strokeWidth={1.75} className="mt-px shrink-0 text-qn-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      {/* 同前缀的文件（如只差版本号的安装包）截断成一行无法区分，名称最多折两行。 */}
                      <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{label}</span>
                      {state === 'running' && job ? <DownloadProgress job={job} /> : (
                        <span className="mt-0.5 block text-xs text-qn-muted">
                          {formatBytes(entry.size)}{entry.mtimeMs > 0 && ` · ${formatFileTime(entry.mtimeMs, locale)}`}
                          {state === 'done' && <span className="text-qn-ok"> · {t('已保存')}</span>}
                        </span>
                      )}
                    </span>
                  </button>
                  {fileAvailable && (state === 'running' ? (
                    <Button variant="ghost" className="qn-list-action mr-1 shrink-0" aria-label={t('取消下载 {name}', { name: entry.name })} onClick={cancelDownload}>
                      <X size={18} aria-hidden />
                    </Button>
                  ) : (
                    <Button variant="ghost" className="qn-list-action mr-1 shrink-0 text-qn-accent" aria-label={t('下载 {name}', { name: entry.name })}
                      // 另一个文件下载中也能点开确认框，框里说明需等它完成。
                      disabled={starting !== null} onClick={() => quickDownload(entry)}>
                      {state === 'starting' ? <LoadingIcon size={18} />
                        : state === 'done' ? <Check size={18} aria-hidden /> : <Download size={18} strokeWidth={1.75} aria-hidden />}
                    </Button>
                  ))}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {selected && (
        <FileDetails file={selected} locale={locale} job={job} state={fileState(selected)} fileAvailable={fileAvailable} busy={busy}
          onDownload={() => { setSelected(null); void download(selected) }} onCancel={cancelDownload} onClose={() => setSelected(null)} />
      )}
      {confirming && (
        <DownloadConfirm file={confirming} otherJob={running && job.path !== confirming.path ? job.name : null}
          onConfirm={confirmDownload} onClose={() => setConfirming(null)} />
      )}
    </Dialog>
  )
}

/** 下载确认：说明保存位置与后台进行，确定后立即关闭，不等下载结束。 */
function DownloadConfirm({ file, otherJob, onConfirm, onClose }: {
  file: ProjectFile
  otherJob: string | null
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog title={t('下载文件')} onClose={onClose}>
      <p className="text-sm font-medium break-all">{file.name}</p>
      <p className="mt-1 text-xs text-qn-muted">{formatBytes(file.size)}</p>
      <p className="qn-hint mt-3">{t('在后台下载，可以继续操作或切到其他应用，完成后会提醒你。')}</p>
      {file.size >= LARGE_FILE_BYTES && <p className="mt-2 text-xs text-qn-warn">{t('文件超过 100 MiB，请确认网络与存储空间。')}</p>}
      {otherJob && <p className="mt-2 text-xs text-qn-warn">{t('正在下载 {name}，完成后可继续下载其他文件。', { name: otherJob })}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button onClick={onClose}>{t('取消')}</Button>
        <Button variant="primary" disabled={Boolean(otherJob)} onClick={onConfirm}>{t('确定')}</Button>
      </div>
    </Dialog>
  )
}

/** 点文件行弹出的详情：完整名称与路径、大文件提醒，以及下载或取消。 */
function FileDetails({ file, locale, job, state, fileAvailable, busy, onDownload, onCancel, onClose }: {
  file: ProjectFile
  locale: string
  job: DeviceDownload | null
  state: FileState
  fileAvailable: boolean
  busy: boolean
  onDownload: () => void
  onCancel: () => void
  onClose: () => void
}) {
  const otherJob = job?.state === 'running' && job.path !== file.path ? job.name : null
  return (
    <Dialog title={t('文件详情')} onClose={onClose}>
      <p className="text-sm font-medium break-all">{file.name}</p>
      <p className="qn-mono mt-1 text-xs break-all text-qn-muted">{file.path}</p>
      <p className="mt-2 text-xs text-qn-muted">
        {formatBytes(file.size)}{file.mtimeMs > 0 && ` · ${new Date(file.mtimeMs).toLocaleString(locale)}`}
      </p>
      <div className="mt-3">
        {state === 'running' && job ? (
          <>
            <DownloadProgress job={job} />
            <p className="qn-hint mt-2">{t('关闭此页面或切到后台后下载会继续，进度见通知栏。')}</p>
            <Button className="mt-3 w-full" onClick={onCancel}>{t('取消下载')}</Button>
          </>
        ) : (
          <>
            {file.size >= LARGE_FILE_BYTES && <p className="mb-2 text-xs text-qn-warn">{t('文件超过 100 MiB，请确认网络与存储空间。')}</p>}
            {otherJob && <p className="qn-hint mb-2">{t('正在下载 {name}，完成后可继续下载其他文件。', { name: otherJob })}</p>}
            {state === 'done' && <p className="mb-2 text-xs text-qn-ok">{t('已保存到手机。')}</p>}
            {fileAvailable ? (
              <Button variant="primary" className="w-full" disabled={busy} onClick={onDownload}>
                {state === 'starting' ? <LoadingIcon size={18} /> : <Download size={18} strokeWidth={1.75} aria-hidden />}
                {state === 'done' ? t('重新下载') : t('下载')}
              </Button>
            ) : <p className="qn-hint">{t('请在 Android 应用中下载。')}</p>}
          </>
        )}
      </div>
    </Dialog>
  )
}
