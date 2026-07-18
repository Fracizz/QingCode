import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import { List, useListRef } from 'react-window'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import {
  peekSourceControlCache,
  useSourceControlStore,
} from '../store/sourceControlStore'
import type { GitChange, GitStatus } from '../lib/git'
import { isTauri, safeInvoke } from '../lib/tauri'
import Tooltip from './Tooltip'
import EmptyState from './EmptyState'
import { translate, useI18n } from '../lib/i18n'

const ROW_HEIGHT = 32
/** Matches max-h-64 (16rem) for the inline diff panel. */
const DIFF_PANEL_HEIGHT = 256
const MAX_INLINE_DIFF_LINES = 400

function absoluteFilePath(projectPath: string, relativePath: string) {
  const root = projectPath.replace(/[\\/]+$/, '')
  const rel = relativePath.replace(/\//g, '\\')
  return `${root}\\${rel}`
}

function fileBaseName(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator >= 0 ? path.slice(separator + 1) : path
}

function fileDirName(path: string) {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 ? path.slice(0, separator + 1) : ''
}

function statusClass(status: string) {
  if (status.includes('D')) return 'text-danger'
  if (status === '??' || status.includes('A') || status.includes('R') || status.includes('C')) {
    return 'text-ok'
  }
  return 'text-warn'
}

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-fg-muted'
  if (line.startsWith('+')) return 'text-ok'
  if (line.startsWith('-')) return 'text-danger'
  if (line.startsWith('@@')) return 'text-accent'
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
    return 'text-fg-dim'
  }
  return 'text-fg-muted'
}

/** Full-width row background so +/- hunks read as blocks, not just colored text. */
function diffLineRowClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return ''
  if (line.startsWith('+')) return 'bg-ok/10'
  if (line.startsWith('-')) return 'bg-danger/10'
  if (line.startsWith('@@')) return 'bg-accent/10'
  return ''
}

function DiffView({ text }: { text: string }) {
  const { t } = useI18n()
  const allLines = text.split('\n')
  const truncated = allLines.length > MAX_INLINE_DIFF_LINES
  const lines = truncated ? allLines.slice(0, MAX_INLINE_DIFF_LINES) : allLines
  return (
    <pre className="whitespace-pre-wrap break-words py-3 font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <span key={index} className={`block px-3 ${diffLineClass(line)} ${diffLineRowClass(line)}`}>
          {line || ' '}
        </span>
      ))}
      {truncated && (
        <span className="block px-3 pt-2 text-[11px] leading-5 text-fg-muted">
          {t('差异过长，已截断显示。点击文件可在编辑器中查看完整差异。')}
        </span>
      )}
    </pre>
  )
}

type ChangeRowProps = {
  changes: GitChange[]
  selected: string | null
  expanded: string | null
  diff: string | null
  diffLoading: boolean
  onToggleDiff: (change: GitChange) => void
  onOpenChange: (change: GitChange) => void
}

function ChangeRowComponent(props: {
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
  index: number
  style: CSSProperties
} & ChangeRowProps) {
  const { t } = useI18n()
  const {
    index,
    style,
    changes,
    selected,
    expanded,
    diff,
    diffLoading,
    onToggleDiff,
    onOpenChange,
  } = props
  const change = changes[index]
  if (!change) return null

  const open = expanded === change.path
  const active = selected === change.path

  return (
    <div style={style} className="overflow-hidden">
      <div
        className={`flex h-8 w-full items-center gap-0.5 px-2 text-[12px] hover:bg-bg-hover ${
          active ? 'bg-bg-active' : ''
        }`}
      >
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            onToggleDiff(change)
          }}
          aria-label={open ? t('折叠差异') : t('展开差异')}
          aria-expanded={open}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-fg-dim hover:bg-bg-hover hover:text-fg"
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          onClick={() => onOpenChange(change)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className={`w-5 flex-shrink-0 font-mono font-semibold ${statusClass(change.status)}`}>
            {change.status}
          </span>
          <span className="min-w-0 flex items-baseline gap-1.5 overflow-hidden">
            <span className="flex-shrink-0 font-medium text-fg">{fileBaseName(change.path)}</span>
            {fileDirName(change.path) && (
              <span className="min-w-0 truncate text-[11px] text-fg-dim">{fileDirName(change.path)}</span>
            )}
          </span>
        </button>
      </div>
      {open && (
        <div
          className="overflow-auto border-y border-border bg-bg-deep"
          style={{ height: DIFF_PANEL_HEIGHT }}
        >
          {diffLoading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-fg-muted">
              <LoaderCircle size={14} className="animate-spin text-accent" />
              {t('正在读取差异…')}
            </div>
          ) : diff ? (
            <DiffView text={diff} />
          ) : null}
        </div>
      )}
    </div>
  )
}

function rowHeightOf(index: number, props: ChangeRowProps) {
  const change = props.changes[index]
  if (change && props.expanded === change.path) {
    return ROW_HEIGHT + DIFF_PANEL_HEIGHT
  }
  return ROW_HEIGHT
}

export default function SourceControlPanel() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const projectPath = currentProject?.path ?? null

  const [status, setStatus] = useState<GitStatus | null>(() =>
    projectPath ? peekSourceControlCache(projectPath) : null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** Inline unified diff under a row; only toggled by the chevron, never by row click. */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const diffRequestId = useRef(0)
  const expandedRef = useRef<string | null>(null)
  expandedRef.current = expanded
  const listRef = useListRef(null)

  const refresh = useCallback(async (opts?: { soft?: boolean }) => {
    const soft = opts?.soft ?? false
    const project = useProjectStore.getState().currentProject
    if (!project) {
      setStatus(null)
      setError(null)
      useSourceControlStore.getState().clearCache()
      return
    }
    if (!isTauri()) {
      setError(translate('Git 功能需要 Tauri 桌面环境'))
      setStatus(null)
      return
    }

    const path = project.path
    if (!soft) setLoading(true)

    try {
      const next = await safeInvoke<GitStatus>('读取 Git 状态', 'git_status', {
        path,
      })
      setStatus(next)
      setError(null)
      useSourceControlStore.getState().setCache(path, next)
      const currentExpanded = expandedRef.current
      if (!soft) {
        setSelected(null)
        setExpanded(null)
        setDiff(null)
      } else if (currentExpanded) {
        const stillThere = next.changes.some(c => c.path === currentExpanded)
        if (!stillThere) {
          setExpanded(null)
          setDiff(null)
          setSelected(prev => (prev === currentExpanded ? null : prev))
        }
      }
      useGitStatusStore.getState().scheduleRefresh(path, 0)
    } catch (reason) {
      if (!soft || !peekSourceControlCache(path)) {
        setStatus(null)
      }
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!projectPath) {
      setStatus(null)
      setError(null)
      setSelected(null)
      setExpanded(null)
      setDiff(null)
      return
    }
    const cached = peekSourceControlCache(projectPath)
    if (cached) {
      setStatus(cached)
      setError(null)
      void refresh({ soft: true })
    } else {
      setStatus(null)
      void refresh({ soft: false })
    }
  }, [projectPath, refresh])

  // Refresh only while this panel is mounted, and only after a debounced file
  // watcher event for the active project. This keeps the fast cached open path
  // while making terminal/external edits visible without a polling loop.
  useEffect(() => {
    if (!projectPath || !isTauri()) return
    let timer: number | null = null
    const onWorktreeChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectPath?: string }>).detail
      if (detail?.projectPath !== projectPath) return
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh({ soft: true }), 700)
    }
    window.addEventListener('qingcode:git-worktree-changed', onWorktreeChange)
    return () => {
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('qingcode:git-worktree-changed', onWorktreeChange)
    }
  }, [projectPath, refresh])

  const openChange = useCallback(
    (change: GitChange) => {
      if (!currentProject) return
      setSelected(change.path)
      const abs = absoluteFilePath(currentProject.path, change.path)
      void useEditorStore.getState().openDiff(currentProject.path, change.path, abs)
    },
    [currentProject],
  )

  const toggleInlineDiff = useCallback(
    async (change: GitChange) => {
      if (!currentProject) return
      if (expandedRef.current === change.path) {
        diffRequestId.current += 1
        setExpanded(null)
        setDiff(null)
        setDiffLoading(false)
        return
      }
      const abs = absoluteFilePath(currentProject.path, change.path)
      const requestId = ++diffRequestId.current
      setSelected(change.path)
      setExpanded(change.path)
      setDiffLoading(true)
      setDiff(null)
      try {
        const text = await safeInvoke<string>('读取 Git 差异', 'git_diff', {
          path: currentProject.path,
          file: abs,
        })
        if (requestId !== diffRequestId.current) return
        setDiff(text || translate('该文件当前没有可显示的差异。'))
      } catch (reason) {
        if (requestId !== diffRequestId.current) return
        setDiff(translate('读取差异失败：{error}', { error: String(reason) }))
      } finally {
        if (requestId === diffRequestId.current) setDiffLoading(false)
      }
    },
    [currentProject],
  )

  const changes = status?.changes ?? []

  const rowProps = useMemo(
    () => ({
      changes,
      selected,
      expanded,
      diff,
      diffLoading,
      onToggleDiff: (change: GitChange) => void toggleInlineDiff(change),
      onOpenChange: openChange,
    }),
    [changes, selected, expanded, diff, diffLoading, toggleInlineDiff, openChange],
  )

  let body: ReactNode
  if (!currentProject) {
    body = <EmptyState icon={<Folder size={28} strokeWidth={1.2} />} title={t('请先选择或添加项目')} />
  } else if (error && !status) {
    body = <EmptyState icon={<AlertCircle size={28} strokeWidth={1.2} className="text-danger" />} title={error} />
  } else if (status && !status.is_repository) {
    body = <EmptyState icon={<GitBranch size={28} strokeWidth={1.2} />} title={t('当前项目不是 Git 仓库')} />
  } else if (status) {
    body = (
      <>
        <div className="border-y border-border px-4 py-2 text-[12px] text-fg-muted">
          <div className="flex items-center gap-1.5 text-fg">
            <GitBranch size={13} className="text-accent" />
            <span>{status.branch ?? t('游离 HEAD')}</span>
          </div>
          <p className="mt-1">{t('{count} 个更改', { count: status.changes.length })}</p>
          {error && <p className="mt-1 text-danger">{error}</p>}
        </div>
        {status.changes.length === 0 ? (
          <EmptyState icon={<CheckCircle2 size={28} strokeWidth={1.2} className="text-ok" />} title={t('工作区没有未提交的更改')} />
        ) : (
          <div className="flex-1 min-h-0">
            <List
              listRef={listRef}
              rowCount={status.changes.length}
              rowHeight={rowHeightOf}
              rowComponent={ChangeRowComponent}
              rowProps={rowProps}
              overscanCount={8}
              className="h-full"
              style={{ height: '100%' }}
            />
          </div>
        )}
      </>
    )
  } else {
    body = (
      <EmptyState
        icon={<LoaderCircle size={22} className="animate-spin text-accent" />}
        title={t('正在读取 Git 状态…')}
      />
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="px-4 h-9 flex items-center justify-between text-[11px] font-semibold tracking-wide text-fg-muted flex-shrink-0">
        <span className="flex items-center gap-2 min-w-0">
          <GitBranch size={13} className="flex-shrink-0" />
          <span className="truncate">{t('源代码管理')}</span>
        </span>
        <Tooltip label={t('刷新')} side="bottom">
          <button
            type="button"
            onClick={() => void refresh({ soft: false })}
            disabled={loading || !currentProject}
            aria-label={t('刷新')}
            className="rounded p-1 text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin text-accent' : undefined} />
          </button>
        </Tooltip>
      </div>
      {body}
    </div>
  )
}
