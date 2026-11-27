import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { ArrowUp, ChevronLeft, ChevronRight, Folder } from 'lucide-react'
import { t, translateMessage } from '@qn/codex-client'
import { call } from '../lib/backend'
import {
  canGoBack,
  canGoForward,
  currentPath,
  goBack,
  goForward,
  goUp,
  initHistory,
  joinPath,
  navigateTo,
  normalizePath,
  parseFsList,
  type FsEntry,
  type PathHistory,
} from '../lib/directory'
import { friendlyError } from '../lib/errors'
import { EmptyState, ErrorNote, IconButton, Modal, Spinner } from './ui'

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
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDir = useCallback(
    async (path: string) => {
      setLoading(true)
      setError(null)
      try {
        const result = await call('server.req', {
          targetId,
          method: 'fs.list',
          params: { path, dirsOnly: true },
        })
        const parsed = parseFsList(result)
        const actual = parsed.path || path
        setEntries(parsed.entries.filter((entry) => entry.kind !== 'file'))
        setHistory((value) => navigateTo(value, actual))
        setInput(actual)
        setSelected(null)
      } catch (err) {
        setEntries([])
        setError(t('{error}；可直接输入完整路径', { error: translateMessage(friendlyError(err, t('读取目录失败'))) }))
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
        else setError(t('未取得主目录，请直接输入完整路径'))
      } catch (err) {
        if (!cancelled) {
          setError(t('{error}；可直接输入完整路径', { error: translateMessage(friendlyError(err, t('获取主目录失败'))) }))
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
      setError(t('请输入目录路径'))
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

  const enter = (name: string) => goTo(joinPath(currentPath(history) || input, name))

  const onPathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      goTo(input)
    }
  }

  const directories = entries.filter((entry) => entry.kind === 'dir' || entry.kind === 'symlink')

  return (
    <Modal
      title={t('选择项目目录')}
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-mono text-ui-sm text-qn-muted">
            {currentPath(history) || input || t('（未选择）')}
          </span>
          <div className="flex shrink-0 gap-2">
            <button className="qn-button-subtle" type="button" onClick={onClose}>
              {t('取消')}
            </button>
            <button
              className="qn-button"
              type="button"
              disabled={!input.trim() && !currentPath(history)}
              onClick={() => onConfirm(input.trim() || currentPath(history))}
            >
              {t('选择当前目录')}
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
            placeholder={t('目录绝对路径，例如 /home/user/repo')}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onPathKeyDown}
          />
          <button className="qn-button-subtle shrink-0" type="button" onClick={() => goTo(input)}>
            {t('转到')}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={t('后退')} disabled={!canGoBack(history)} onClick={() => move(goBack(history))}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label={t('前进')} disabled={!canGoForward(history)} onClick={() => move(goForward(history))}>
            <ChevronRight size={15} />
          </IconButton>
          <IconButton label={t('上级目录')} disabled={!currentPath(history)} onClick={() => move(goUp(history))}>
            <ArrowUp size={15} />
          </IconButton>
          {loading && <Spinner label={t('读取目录…')} />}
        </div>
        <ErrorNote message={error} onClose={() => setError(null)} />
        <div className="qn-scroll h-64 space-y-0.5 overflow-y-auto rounded-lg border border-qn-border bg-qn-inset p-1">
          {directories.length === 0 && !loading && (
            <EmptyState>{t('没有子目录，可返回上级或输入完整路径。')}</EmptyState>
          )}
          {directories.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm ${
                selected === entry.name ? 'bg-qn-accent/20' : 'hover:bg-qn-fg/5'
              }`}
              onClick={() => setSelected(entry.name)}
              onDoubleClick={() => enter(entry.name)}
            >
              <Folder size={13} className="shrink-0 text-amber-300" />
              <span className="truncate">{entry.name}</span>
              {entry.kind === 'symlink' && <span className="text-ui-xs text-qn-muted">{t('链接')}</span>}
            </button>
          ))}
        </div>
        <p className="text-ui-sm text-qn-muted">{t('单击选中、双击进入目录；也可直接在上方输入路径。')}</p>
      </div>
    </Modal>
  )
}
