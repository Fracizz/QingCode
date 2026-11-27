import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { ArrowUp, ChevronLeft, ChevronRight, Folder, FolderPlus, Pencil } from 'lucide-react'
import { describeWorkspaceError, detectPathStyle, joinPath, validateEntryName } from '../features/explorer/treeModel'
import { serverCall } from '../features/workspace/serverCall'
import { call } from '../lib/backend'
import {
  canGoBack,
  canGoForward,
  currentPath,
  goBack,
  goForward,
  goUp,
  initHistory,
  navigateTo,
  normalizePath,
  parseFsList,
  type FsEntry,
  type PathHistory,
} from '../lib/directory'
import { friendlyError } from '../lib/errors'
import { EmptyState, ErrorNote, IconButton, Modal, Spinner } from './ui'

type DirectoryDraft = { name: string; original?: string }

// 文件写入接口要求已加载的路径含盘符、UNC 根或 POSIX 根。
const absolutePath = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/

export function DirectoryPicker({
  targetId,
  onClose,
  onConfirm,
}: {
  targetId: string
  onClose: () => void
  onConfirm: (path: string) => void
}) {
  const [history, setHistory] = useState<PathHistory>({ entries: [], index: -1 })
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [listedPath, setListedPath] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<DirectoryDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDir = useCallback(
    async (path: string, selectName?: string) => {
      setLoading(true)
      setListedPath('')
      setError(null)
      setSelected(null)
      try {
        const result = await call('server.req', {
          targetId,
          method: 'fs.list',
          params: { path, dirsOnly: true },
        })
        const parsed = parseFsList(result)
        const actual = parsed.path || path
        setEntries(parsed.entries)
        setListedPath(actual)
        setHistory((value) => navigateTo(value, actual))
        setInput(actual)
        if (selectName && parsed.entries.some((entry) => entry.name === selectName)) {
          setSelected(selectName)
        }
      } catch (err) {
        setEntries([])
        setError(`${friendlyError(err, '读取目录失败')}；可直接输入完整路径`)
      } finally {
        setLoading(false)
      }
    },
    [targetId],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const home = await call('server.req', { targetId, method: 'fs.home', params: {} })
        const path =
          typeof (home as { path?: unknown } | null)?.path === 'string'
            ? (home as { path: string }).path
            : ''
        if (cancelled) return
        setHistory(initHistory(path))
        setInput(path)
        if (path) await loadDir(path)
        else {
          setLoading(false)
          setError('未取得主目录，请直接输入完整路径')
        }
      } catch (err) {
        if (!cancelled) {
          setLoading(false)
          setError(`${friendlyError(err, '获取主目录失败')}；可直接输入完整路径`)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [targetId, loadDir])

  const goTo = (raw: string) => {
    const path = normalizePath(raw)
    if (!path) {
      setError('请输入目录路径')
      return
    }
    setHistory((value) => navigateTo(value, path))
    setInput(path)
    void loadDir(path)
  }

  const move = (next: PathHistory) => {
    const path = currentPath(next)
    setHistory(next)
    setInput(path)
    if (path) void loadDir(path)
  }

  const enter = (name: string) => goTo(joinPath(listedPath, name))

  const startEdit = (original?: string) => {
    setError(null)
    setDraft({ name: original ?? '', original })
  }

  const saveDirectory = async () => {
    if (!draft || saving || !absolutePath.test(listedPath)) return
    const name = draft.name.trim()
    const { original } = draft
    if (original === draft.name || original === name) {
      setDraft(null)
      setError(null)
      return
    }

    // 名称只允许一个路径段；操作使用已加载的目录，避免误用地址栏尚未提交的路径。
    const problem = validateEntryName(name, detectPathStyle(listedPath))
    if (problem) {
      setError(problem)
      return
    }
    if (entries.some((entry) => entry.name === name)) {
      setError('同名文件或目录已存在')
      return
    }

    const to = joinPath(listedPath, name)
    setSaving(true)
    setError(null)
    try {
      if (original !== undefined) {
        await serverCall(targetId, 'fs.rename', { from: joinPath(listedPath, original), to })
        setDraft(null)
        await loadDir(listedPath, name)
      } else {
        await serverCall(targetId, 'fs.mkdir', { path: to, recursive: false })
        setDraft(null)
        await loadDir(to)
      }
    } catch (err) {
      setError(describeWorkspaceError(err, original === undefined ? '新建目录失败' : '重命名失败'))
    } finally {
      setSaving(false)
    }
  }

  const onPathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      goTo(input)
    }
  }

  const directories = entries.filter((entry) => entry.kind === 'dir' || entry.kind === 'symlink')
  const navigationDisabled = loading || saving || draft !== null
  const canEdit = !navigationDisabled && absolutePath.test(listedPath)
  const renaming = draft?.original !== undefined

  return (
    <Modal
      title="选择项目目录"
      width="max-w-2xl"
      onClose={saving ? undefined : onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-mono text-ui-sm text-qn-muted">
            {currentPath(history) || input || '（未选择）'}
          </span>
          <div className="flex shrink-0 gap-2">
            <button className="qn-button-subtle" type="button" disabled={saving} onClick={onClose}>
              取消
            </button>
            <button
              className="qn-button"
              type="button"
              disabled={draft !== null || saving || (!input.trim() && !currentPath(history))}
              onClick={() => onConfirm(input.trim() || currentPath(history))}
            >
              选择当前目录
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            className="qn-input min-w-0 flex-1 font-mono"
            value={input}
            disabled={navigationDisabled}
            placeholder="目录绝对路径，例如 /home/user/repo"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onPathKeyDown}
          />
          <button
            className="qn-button-subtle shrink-0"
            type="button"
            disabled={navigationDisabled}
            onClick={() => goTo(input)}
          >
            转到
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <IconButton
            label="后退"
            disabled={navigationDisabled || !canGoBack(history)}
            onClick={() => move(goBack(history))}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton
            label="前进"
            disabled={navigationDisabled || !canGoForward(history)}
            onClick={() => move(goForward(history))}
          >
            <ChevronRight size={15} />
          </IconButton>
          <IconButton
            label="上级目录"
            disabled={navigationDisabled || !currentPath(history)}
            onClick={() => move(goUp(history))}
          >
            <ArrowUp size={15} />
          </IconButton>
          {loading && <Spinner label="读取目录…" />}
          <div className="ml-auto flex flex-wrap gap-2">
            <button
              className="qn-button-subtle inline-flex items-center gap-1.5"
              type="button"
              disabled={!canEdit}
              onClick={() => startEdit()}
            >
              <FolderPlus size={15} aria-hidden />
              新建目录
            </button>
            <button
              className="qn-button-subtle inline-flex items-center gap-1.5"
              type="button"
              disabled={!canEdit || selected === null}
              onClick={() => {
                if (selected !== null) startEdit(selected)
              }}
            >
              <Pencil size={15} aria-hidden />
              重命名
            </button>
          </div>
        </div>
        {draft && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void saveDirectory()
            }}
          >
            <input
              autoFocus
              aria-label={renaming ? '新目录名称' : '目录名称'}
              className="qn-input min-w-0 flex-1"
              value={draft.name}
              placeholder="输入目录名称"
              disabled={saving}
              onFocus={(event) => event.target.select()}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value })
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
            />
            <button className="qn-button-subtle shrink-0" type="submit" disabled={saving}>
              {saving ? '保存中…' : renaming ? '保存' : '创建'}
            </button>
            <button
              className="qn-button-subtle shrink-0"
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(null)
                setError(null)
              }}
            >
              {renaming ? '取消重命名' : '取消新建'}
            </button>
          </form>
        )}
        <ErrorNote message={error} onClose={() => setError(null)} />
        <div className="qn-scroll h-64 space-y-0.5 overflow-y-auto rounded-lg border border-qn-border bg-qn-inset p-1">
          {directories.length === 0 && !loading && (
            <EmptyState>没有子目录，可返回上级或输入完整路径。</EmptyState>
          )}
          {directories.map((entry) => (
            <button
              key={entry.name}
              type="button"
              aria-pressed={selected === entry.name}
              disabled={navigationDisabled}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm ${
                selected === entry.name ? 'bg-qn-accent/20' : 'hover:bg-qn-fg/5'
              }`}
              onClick={() => setSelected(entry.name)}
              onDoubleClick={() => enter(entry.name)}
            >
              <Folder size={13} className="shrink-0 text-amber-300" />
              <span className="truncate">{entry.name}</span>
              {entry.kind === 'symlink' && <span className="text-ui-xs text-qn-muted">链接</span>}
            </button>
          ))}
        </div>
        <p className="text-ui-sm text-qn-muted">单击选中、双击进入目录；也可直接在上方输入路径。</p>
      </div>
    </Modal>
  )
}
