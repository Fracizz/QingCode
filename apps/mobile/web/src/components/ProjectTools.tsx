import { Ellipsis, FileText, Folder, RotateCw, Terminal } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { callDevice } from '../client'
import { getWindowNativePort, NativeRequestError } from '../native'
import { parentFolder, projectRpc, type DownloadChunk, type ProjectFile, type ProjectFiles } from '../projectApi'
import { friendlyError } from '../state'
import { useApp } from '../store'
import type { Project } from '../types'
import { formatBytes } from '../viewer'
import { Button, Dialog, Note, SheetAction } from './ui'

const CHUNK_BYTES = 256 * 1024
const TerminalPanel = lazy(async () => ({ default: (await import('./TerminalPanel')).TerminalPanel }))

export function ProjectTools({ project, compact = false }: { project: Project; compact?: boolean }) {
  const [tool, setTool] = useState<'files' | 'terminal' | 'menu' | null>(null)
  const desktopId = useApp((s) => s.activeId)
  return (
    <>
      {!compact && (
        <Button variant="ghost" className="px-2" onClick={() => setTool('files')} aria-label={`浏览 ${project.name} 的文件`} title="浏览文件">
          <Folder size={19} strokeWidth={1.75} aria-hidden />
        </Button>
      )}
      <Button variant="ghost" className="qn-list-action" onClick={() => setTool('menu')}
        aria-label={`${project.name} 的项目工具`} aria-haspopup="dialog" title="项目工具">
        <Ellipsis size={19} strokeWidth={1.75} aria-hidden />
      </Button>
      {tool === 'menu' && (
        <Dialog title={project.name} onClose={() => setTool(null)}>
          <p className="qn-mono -mt-1 mb-2 text-xs text-qn-muted">{project.path}</p>
          <div className="qn-project-tools-menu">
            {compact && <SheetAction icon={Folder} onClick={() => setTool('files')}>浏览项目文件</SheetAction>}
            <SheetAction icon={Terminal} onClick={() => setTool('terminal')}>打开项目终端</SheetAction>
          </div>
        </Dialog>
      )}
      {tool === 'files' && <ProjectFileBrowser key={`${desktopId}:${project.id}`} desktopId={desktopId} project={project} onClose={() => setTool(null)} />}
      {tool === 'terminal' && (
        <Dialog title={`终端 · ${project.name}`} placement="full" onClose={() => setTool(null)}>
          <Suspense fallback={<p className="py-4 text-center text-sm text-qn-muted" role="status">正在加载终端…</p>}>
            <TerminalPanel key={`${desktopId}:${project.id}`} project={project} />
          </Suspense>
        </Dialog>
      )}
    </>
  )
}

/** 目录在前，组内按名称自然排序；电脑端返回的顺序不保证。 */
function sortEntries(entries: readonly ProjectFile[]): ProjectFile[] {
  return [...entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)
    || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }))
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
          setMessage('电脑或目标服务版本不支持项目文件，请更新后重试')
          return
        }
        setListing(result)
      }, (error: unknown) => {
        if (current) {
          const disconnected = error instanceof NativeRequestError && error.code === 'not_connected'
          setNeedsTarget(disconnected)
          setMessage(disconnected ? '需要先连接此项目的目标。' : friendlyError(error, '读取项目文件失败'))
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
      if (!chunk || !Number.isSafeInteger(chunk.size) || chunk.size < 0 || !chunk.version) throw new Error('电脑返回了无效的文件信息')
      controller.signal.throwIfAborted()
      if (chunk.size !== file.size) throw new Error('文件大小已变化，请刷新文件列表后重试')
      const version = chunk.version
      const size = chunk.size
      const opened = await callDevice<{ id: string } | null>('download.begin', { name: file.name, size }, 300_000)
      if (!opened) return
      downloadId = opened.id
      controller.signal.throwIfAborted()
      while (offset < size) {
        if (chunk.version !== version || chunk.size !== size || !Number.isInteger(chunk.length) ||
          chunk.length < 1 || chunk.length > Math.min(CHUNK_BYTES, size - offset)) throw new Error('文件已变化，请重新下载')
        const written = await callDevice<{ written: number }>('download.append', { id: downloadId, offset, data: chunk.content })
        if (written.written !== offset + chunk.length) throw new Error('保存内容长度不一致')
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
        setCompleted(`已保存 ${saved.name}`)
        setSelected(null)
      }
    } catch (error) {
      if (!controller.signal.aborted) setMessage(friendlyError(error, '下载失败'))
    } finally {
      if (downloadId) await callDevice('download.cancel', { id: downloadId }).catch(() => undefined)
      setProgress(null)
      operation.current = null
    }
  }

  return (
    <Dialog title={`项目文件 · ${project.name}`} placement="full" onClose={onClose}>
      <div className="space-y-2">
        <input type="search" className="qn-input" aria-label="搜索项目文件" placeholder="搜索文件名或相对路径"
          value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null) }} disabled={Boolean(progress)} />
        <div className="flex min-w-0 items-center gap-1 text-sm">
          <Button onClick={() => browse(parentFolder(path))} disabled={!path || Boolean(progress)}>上级</Button>
          <div className="min-w-0 flex-1 truncate text-qn-muted" title={path}>{path ? `/${path}` : '/'}</div>
          <label className="flex min-h-11 items-center gap-1 px-1 whitespace-nowrap">
            <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} disabled={Boolean(progress)} /> 隐藏文件
          </label>
          <Button variant="ghost" className="qn-list-action" aria-label="刷新文件" onClick={() => setRefresh(refresh + 1)} disabled={Boolean(progress)}>
            <RotateCw size={17} strokeWidth={1.75} aria-hidden />
          </Button>
        </div>
        {message && <Note message={message} tone="error" onClose={() => setMessage(null)}
          actionLabel={needsTarget ? '连接目标' : undefined} onAction={needsTarget ? () => requestConnect(project.targetId) : undefined} />}
        {completed && <Note message={completed} onClose={() => setCompleted('')} />}
        {selected && (
          <div className="rounded-xl border border-qn-border bg-qn-card px-3 py-2">
            <p className="break-all text-sm font-medium">{selected.name}</p>
            <p className="my-1 text-xs text-qn-muted">{formatBytes(selected.size)} · {new Date(selected.mtimeMs).toLocaleString('zh-CN')}</p>
            {progress ? (
              <div className="flex items-center gap-2">
                <progress className="min-w-0 flex-1" value={progress.bytes} max={progress.size || 1} aria-label="下载进度" />
                <span className="text-xs text-qn-muted">{formatBytes(progress.bytes)} / {formatBytes(progress.size)}</span>
                <Button onClick={() => operation.current?.abort()}>取消</Button>
              </div>
            ) : (
              <>
                {selected.size >= 100 * 1024 * 1024 && <p className="mb-2 text-xs text-qn-warn">文件超过 100 MiB，请确认网络与存储空间。</p>}
                <div className="flex gap-2">
                  <Button variant="primary" disabled={!fileAvailable} onClick={() => void download(selected)}>选择位置并下载</Button>
                  <Button variant="ghost" onClick={() => setSelected(null)}>关闭详情</Button>
                </div>
                {!fileAvailable && <p className="text-xs text-qn-muted">请在 Android 应用中下载。</p>}
              </>
            )}
          </div>
        )}
        {listing === null && !message && <p className="py-4 text-center text-sm text-qn-muted" role="status">正在读取文件…</p>}
        {listing?.entries.length === 0 && <p className="py-4 text-center text-sm text-qn-muted">{query ? '没有匹配的文件' : '目录为空'}</p>}
        {listing?.truncated && <p className="text-xs text-qn-warn">结果较多，请缩小查询范围。</p>}
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
