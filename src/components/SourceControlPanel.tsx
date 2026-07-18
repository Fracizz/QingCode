import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
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
import { gitStatusColorClass, gitStatusGlyph } from '../lib/gitStatus'
import { isTauri, safeInvoke } from '../lib/tauri'
import Tooltip from './Tooltip'
import EmptyState from './EmptyState'
import { translate, useI18n } from '../lib/i18n'

const ROW_HEIGHT = 32
/** Fixed status column so M / U / D share one vertical edge with filenames. */
const STATUS_COL = 'w-4 shrink-0 text-center font-mono text-[12px] font-semibold leading-none'

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

type ChangeRowProps = {
  changes: GitChange[]
  selected: string | null
  onOpenChange: (change: GitChange) => void
}

function ChangeRowComponent(props: {
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
  index: number
  style: CSSProperties
} & ChangeRowProps) {
  const { index, style, changes, selected, onOpenChange } = props
  const change = changes[index]
  if (!change) return null

  const active = selected === change.path
  const glyph = gitStatusGlyph(change.status) ?? change.status
  const glyphColor = gitStatusColorClass(change.status)

  return (
    <div style={style} className="overflow-hidden">
      <button
        type="button"
        onClick={() => onOpenChange(change)}
        className={`flex h-8 w-full items-center gap-2 px-4 text-left text-[12px] hover:bg-bg-hover ${
          active ? 'bg-bg-active' : ''
        }`}
      >
        <span className={`${STATUS_COL} ${glyphColor}`}>{glyph}</span>
        <span className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
          <span className="flex-shrink-0 font-medium leading-none text-fg">{fileBaseName(change.path)}</span>
          {fileDirName(change.path) && (
            <span className="min-w-0 truncate text-[11px] leading-none text-fg-dim">
              {fileDirName(change.path)}
            </span>
          )}
        </span>
      </button>
    </div>
  )
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
      if (!soft) {
        setSelected(null)
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

  const changes = status?.changes ?? []

  const rowProps = useMemo(
    () => ({
      changes,
      selected,
      onOpenChange: openChange,
    }),
    [changes, selected, openChange],
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
              rowHeight={ROW_HEIGHT}
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
