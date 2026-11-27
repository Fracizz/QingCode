import { getLocale, t } from '@qn/codex-client'
import { Archive, Ellipsis, FileText, Folder, Pin, PinOff, RotateCw, Terminal } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { callDevice } from '../client'
import { getWindowNativePort, NativeRequestError } from '../native'
import { parentFolder, projectRpc, type DownloadChunk, type ProjectFile, type ProjectFiles } from '../projectApi'
import { friendlyError } from '../state'
import { useApp } from '../store'
import type { Project } from '../types'
import { formatBytes } from '../viewer'
import { threadPreferenceKey, toggleProjectPin, useWorkspace, useWorkspacePreferences, workspaceProjectKey } from '../workspace'
import { AgentTag, Button, Dialog, Empty, Loading, Note, SheetAction } from './ui'

const CHUNK_BYTES = 256 * 1024
const TerminalPanel = lazy(async () => ({ default: (await import('./TerminalPanel')).TerminalPanel }))

export function ProjectTools({ project, compact = false, sortable = false }: { project: Project; compact?: boolean; sortable?: boolean }) {
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
      <Button variant="ghost" className="qn-list-action" onClick={() => setTool('menu')}
        aria-label={t('{name} 的项目工具', { name: project.name })} aria-haspopup="dialog" title={t('项目工具')}>
        <Ellipsis size={19} strokeWidth={1.75} aria-hidden />
      </Button>
      {tool === 'menu' && (
        <Dialog title={project.name} onClose={() => setTool(null)}>
          <p className="qn-mono -mt-1 mb-2 break-all text-xs text-qn-muted">{project.path}</p>
          <div className="qn-project-tools-menu">
            {desktopId && (
              <SheetAction icon={pinned ? PinOff : Pin} onClick={() => { toggleProjectPin(desktopId, project); setTool(null) }}>
                {pinned ? t('取消置顶（仅此手机）') : t('置顶（仅此手机）')}
              </SheetAction>
            )}
            {compact && <SheetAction icon={Folder} onClick={() => setTool('files')}>{t('浏览项目文件')}</SheetAction>}
            <SheetAction icon={Terminal} onClick={() => setTool('terminal')}>{t('打开项目终端')}</SheetAction>
            <SheetAction icon={Archive} onClick={() => setTool('archive')}>{t('已归档会话')}</SheetAction>
          </div>
          {sortable && <p className="qn-hint mt-2">{t('长按项目行可拖动排序（仅此手机）')}</p>}
        </Dialog>
      )}
      {tool === 'files' && <ProjectFileBrowser key={`${desktopId}:${project.id}`} desktopId={desktopId} project={project} onClose={() => setTool(null)} />}
      {tool === 'archive' && desktopId && <ArchivedConversations key={`${desktopId}:${project.id}`} desktopId={desktopId} project={project} onClose={() => setTool(null)} />}
      {tool === 'terminal' && (
        <Dialog title={t('终端 · {name}', { name: project.name })} placement="full" closeAt="top" onClose={() => setTool(null)}>
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
  const [progress, setProgress] = useState<{ bytes: number; size: number } | null>(null)
  const [completed, setCompleted] = useState('')
  const operation = useRef<AbortController | null>(null)
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

  useEffect(() => () => operation.current?.abort(), [])

  function browse(next: string) {
    setPath(next)
    setQuery('')
    setSelected(null)
    setCompleted('')
  }

  async function download(file: ProjectFile) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setMessage(null)
    setCompleted('')
    setProgress({ bytes: 0, size: file.size })
    let downloadId: string | null = null
    try {
      let offset = 0
      const fetchPart = (version?: string) => projectRpc<DownloadChunk>(project, 'mobile.files.read',
        { path: file.path, offset, length: CHUNK_BYTES, ...(version ? { version } : {}) }, desktopId)
      let chunk = await fetchPart()
      if (!chunk || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || !chunk.version) throw new Error(t('电脑返回了无效的文件信息'))
      controller.signal.throwIfAborted()
      if (chunk.size !== file.size) throw new Error(t('文件大小已变化，请刷新文件列表后重试'))
      const version = chunk.version
      const size = chunk.size
      const opened = await callDevice<{ id: string } | null>('download.begin', { name: file.name, size }, 300_000)
      if (!opened) return
      downloadId = opened.id
      controller.signal.throwIfAborted()
      while (offset < size) {
        if (chunk.version !== version || chunk.size !== size || !Number.isInteger(chunk.length) ||
          chunk.length < 1 || chunk.length > Math.min(CHUNK_BYTES, size - offset)) throw new Error(t('文件已变化，请重新下载'))
        const written = await callDevice<{ written: number }>('download.append', { id: downloadId, offset, data: chunk.content })
        if (written.written !== offset + chunk.length) throw new Error(t('保存内容长度不一致'))
        offset = written.written
        controller.signal.throwIfAborted()
        setProgress({ bytes: offset, size })
        if (offset < size) {
          chunk = await fetchPart(version)
          controller.signal.throwIfAborted()
        }
      }
      await projectRpc<DownloadChunk>(project, 'mobile.files.read',
        { path: file.path, offset: size, length: 1, version }, desktopId)
      controller.signal.throwIfAborted()
      const saved = await callDevice<{ name: string }>('download.finish', { id: downloadId }, 300_000)
      downloadId = null
      if (!controller.signal.aborted) {
        setCompleted(t('已保存 {name}', { name: saved.name }))
        setSelected(null)
      }
    } catch (error) {
      if (!controller.signal.aborted) setMessage(friendlyError(error, t('下载失败')))
    } finally {
      if (downloadId) await callDevice('download.cancel', { id: downloadId }).catch(() => undefined)
      setProgress(null)
      operation.current = null
    }
  }

  return (
    <Dialog title={t('项目文件 · {name}', { name: project.name })} placement="full" onClose={onClose}>
      <div className="space-y-2">
        <input type="search" className="qn-input" aria-label={t('搜索项目文件')} placeholder={t('搜索文件名或相对路径')}
          value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null) }} disabled={Boolean(progress)} />
        <div className="flex min-w-0 items-center gap-1 text-sm">
          <Button onClick={() => browse(parentFolder(path))} disabled={!path || Boolean(progress)}>{t('上级')}</Button>
          <div className="min-w-0 flex-1 truncate text-qn-muted" title={path}>{path ? `/${path}` : '/'}</div>
          <label className="flex min-h-11 items-center gap-1 px-1 whitespace-nowrap">
            <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} disabled={Boolean(progress)} /> {t('隐藏文件')}
          </label>
          <Button variant="ghost" className="qn-list-action" aria-label={t('刷新文件')} onClick={() => setRefresh(refresh + 1)} disabled={Boolean(progress)}>
            <RotateCw size={17} strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
        {message && <Note message={message} tone="error" onClose={() => setMessage(null)}
          actionLabel={needsTarget ? t('连接目标') : undefined} onAction={needsTarget ? () => requestConnect(project.targetId) : undefined} />}
        {completed && <Note message={completed} onClose={() => setCompleted('')} />}
        {selected && (
          <div className="rounded-xl border border-qn-border bg-qn-card px-3 py-2">
            <p className="break-all text-sm font-medium">{selected.name}</p>
            <p className="my-1 text-xs text-qn-muted">{formatBytes(selected.size)} · {new Date(selected.mtimeMs).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-CN')}</p>
            {progress ? (
              <div className="flex items-center gap-2">
                <progress className="min-w-0 flex-1" value={progress.bytes} max={progress.size || 1} aria-label={t('下载进度')} />
                <span className="text-xs text-qn-muted">{formatBytes(progress.bytes)} / {formatBytes(progress.size)}</span>
                <Button onClick={() => operation.current?.abort()}>{t('取消')}</Button>
              </div>
            ) : (
              <>
                {selected.size >= 100 * 1024 * 1024 && <p className="mb-2 text-xs text-qn-warn">{t('文件超过 100 MiB，请确认网络与存储空间。')}</p>}
                <div className="flex gap-2">
                  <Button variant="primary" disabled={!fileAvailable} onClick={() => void download(selected)}>{t('选择位置并下载')}</Button>
                  <Button variant="ghost" onClick={() => setSelected(null)}>{t('关闭详情')}</Button>
                </div>
                {!fileAvailable && <p className="text-xs text-qn-muted">{t('请在 Android 应用中下载。')}</p>}
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
              <button key={entry.path} className="qn-row border-b border-qn-border px-3 py-2 last:border-0" type="button" disabled={Boolean(progress)}
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
