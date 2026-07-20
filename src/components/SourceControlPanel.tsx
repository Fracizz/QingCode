import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileIcon,
  Folder,
  GitBranch,
  GitCompare,
  LoaderCircle,
  LocateFixed,
  RefreshCw,
} from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { List, useListRef } from 'react-window'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useGitStatusStore } from '../store/gitStatusStore'
import {
  peekSourceControlCache,
  useSourceControlStore,
} from '../store/sourceControlStore'
import type { GitChange, GitStatus } from '../lib/git'
import {
  gitChangePathLooksLikeDirectory,
  gitStatusColorClass,
  gitStatusGlyph,
  gitStatusMayBeDirectory,
  normalizeGitChangePath,
} from '../lib/gitStatus'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useUIStore } from '../store/uiStore'
import { COPY_RELATIVE_PATH_SHORTCUT } from '../lib/shortcuts'
import { copyToClipboard } from '../utils/fileReferences'
import Tooltip from './Tooltip'
import EmptyState from './EmptyState'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { translate, useI18n } from '../lib/i18n'

const ROW_HEIGHT = 34
/** Fixed status column so M / U / D share one vertical edge with filenames. */
const STATUS_COL = 'w-4 shrink-0 text-center font-mono text-[12px] font-semibold leading-none'

function absoluteFilePath(projectPath: string, relativePath: string) {
  const root = projectPath.replace(/[\\/]+$/, '')
  const rel = normalizeGitChangePath(relativePath).replace(/\//g, '\\')
  return `${root}\\${rel}`
}

function fileBaseName(path: string) {
  const cleaned = normalizeGitChangePath(path)
  const separator = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return separator >= 0 ? cleaned.slice(separator + 1) : cleaned
}

function fileDirName(path: string) {
  const cleaned = normalizeGitChangePath(path)
  const separator = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return separator > 0 ? cleaned.slice(0, separator + 1) : ''
}

async function changeIsDirectory(projectPath: string, change: GitChange): Promise<boolean> {
  if (gitChangePathLooksLikeDirectory(change.path)) return true
  if (!gitStatusMayBeDirectory(change.status)) return false
  try {
    const abs = absoluteFilePath(projectPath, change.path)
    const stat = await safeInvoke<{ size: number; is_dir: boolean }>('读取文件信息', 'file_stat', {
      path: abs,
    })
    return Boolean(stat.is_dir)
  } catch {
    return false
  }
}

/** Worktree column of `git status --short` (second character). */
function gitWorktreeCode(status: string): string {
  if (status === '??' || status === '!!') return status
  if (status.length >= 2) return status[1] ?? status[0]
  return status
}

function canOpenFileInEditor(status: string): boolean {
  return gitWorktreeCode(status) !== 'D'
}

type ChangeRowProps = {
  changes: GitChange[]
  selected: string | null
  onOpenChange: (change: GitChange) => void
  onOpenContextMenu: (event: ReactMouseEvent, change: GitChange) => void
}

function ChangeRowComponent(props: {
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
  index: number
  style: CSSProperties
} & ChangeRowProps) {
  const { index, style, changes, selected, onOpenChange, onOpenContextMenu } = props
  const change = changes[index]
  if (!change) return null

  const active = selected === change.path
  const glyph = gitStatusGlyph(change.status) ?? change.status
  const glyphColor = gitStatusColorClass(change.status)
  const dirName = fileDirName(change.path)

  return (
    <div style={style}>
      <button
        type="button"
        onClick={() => onOpenChange(change)}
        onContextMenu={event => onOpenContextMenu(event, change)}
        className={`flex h-full w-full items-center gap-2 px-4 text-left text-[12px] leading-5 hover:bg-bg-hover ${
          active ? 'bg-bg-active' : ''
        }`}
      >
        <span className={`${STATUS_COL} ${glyphColor}`}>{glyph}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <span className="flex-shrink-0 font-medium text-tree-fg">{fileBaseName(change.path)}</span>
          {dirName && (
            <Tooltip
              label={dirName}
              side="bottom"
              onlyWhenOverflow
              wrapperClassName="min-w-0 truncate"
            >
              <span className="block truncate text-[11px] text-fg-dim">{dirName}</span>
            </Tooltip>
          )}
        </span>
      </button>
    </div>
  )
}

function seedSourceControlStatus(projectPath: string): GitStatus | null {
  return peekSourceControlCache(projectPath) ?? useGitStatusStore.getState().peekPanelStatus(projectPath)
}

export default function SourceControlPanel() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const projectPath = currentProject?.path ?? null

  const [status, setStatus] = useState<GitStatus | null>(() =>
    projectPath ? seedSourceControlStatus(projectPath) : null,
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; change: GitChange } | null>(
    null,
  )
  const listRef = useListRef(null)
  const setView = useUIStore(s => s.setView)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)

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
      // Soft path reuses the shared workdir refresh (coalesced with badge/tree).
      // Hard refresh uses full git_status so branch + rename paths stay accurate.
      if (soft) {
        await useGitStatusStore.getState().refresh(path)
        let next = seedSourceControlStatus(path)
        if (next?.is_repository && !next.branch) {
          try {
            const head = await safeInvoke<{ name: string } | null>('读取 Git 分支', 'get_git_head', {
              path,
            })
            if (head?.name) {
              next = { ...next, branch: head.name }
              useSourceControlStore.getState().setCache(path, next)
            }
          } catch {
            /* keep null branch; hard refresh can recover */
          }
        }
        if (next) {
          setStatus(next)
          setError(null)
        }
        return
      }

      const next = await safeInvoke<GitStatus>('读取 Git 状态', 'git_status', {
        path,
      })
      setStatus(next)
      setError(null)
      useGitStatusStore.getState().applyFromGitStatus(path, next)
      setSelected(null)
    } catch (reason) {
      if (!soft || !seedSourceControlStatus(path)) {
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
    const seeded = seedSourceControlStatus(projectPath)
    if (seeded) {
      setStatus(seeded)
      setError(null)
      void refresh({ soft: true })
    } else {
      setStatus(null)
      void refresh({ soft: false })
    }
  }, [projectPath, refresh])

  // Follow shared workdir updates (file watcher / focus) without a second git_status.
  useEffect(() => {
    if (!projectPath || !isTauri()) return
    return useGitStatusStore.subscribe((state, prev) => {
      if (state.projectPath !== projectPath) return
      if (state.entries === prev.entries && state.dirtyCount === prev.dirtyCount) return
      const next = seedSourceControlStatus(projectPath)
      if (next) setStatus(next)
    })
  }, [projectPath])

  const revealInSidebar = useCallback(
    (absolutePath: string) => {
      setView('explorer')
      void revealFileInTree(absolutePath)
    },
    [revealFileInTree, setView],
  )

  const openChange = useCallback(
    async (change: GitChange) => {
      if (!currentProject) return
      setSelected(change.path)
      const rel = normalizeGitChangePath(change.path)
      const abs = absoluteFilePath(currentProject.path, rel)
      if (await changeIsDirectory(currentProject.path, change)) {
        revealInSidebar(abs)
        return
      }
      void useEditorStore.getState().openDiff(currentProject.path, rel, abs)
    },
    [currentProject, revealInSidebar],
  )

  const copyAbsolutePath = async (path: string) => {
    try {
      await copyToClipboard(path)
      useProjectStore.getState().pushToast('success', t('路径已复制'))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('复制路径失败: {error}', { error: String(error) }))
    }
  }

  const copyRelativePath = async (relativePath: string) => {
    try {
      await copyToClipboard(normalizeGitChangePath(relativePath).replace(/\\/g, '/'))
      useProjectStore.getState().pushToast('success', t('相对路径已复制'))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('复制路径失败: {error}', { error: String(error) }))
    }
  }

  const revealInFileManager = async (absolutePath: string) => {
    try {
      await revealItemInDir(absolutePath)
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('在文件管理器中打开失败: {error}', { error: String(error) }))
    }
  }

  const showChangeContextMenu = useCallback((event: ReactMouseEvent, change: GitChange) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ x: event.clientX, y: event.clientY, change })
  }, [])

  const contextMenuItems = (change: GitChange): ContextMenuItem[] => {
    if (!currentProject) return []
    const projectPath = currentProject.path
    const abs = absoluteFilePath(projectPath, change.path)
    const looksLikeDir = gitChangePathLooksLikeDirectory(change.path)
    return [
      {
        label: t('打开更改'),
        icon: <GitCompare size={14} />,
        action: () => void openChange(change),
      },
      {
        label: t('打开文件'),
        icon: <FileIcon size={14} />,
        disabled: !canOpenFileInEditor(change.status) || looksLikeDir,
        action: () => {
          void (async () => {
            if (await changeIsDirectory(projectPath, change)) {
              revealInSidebar(abs)
              return
            }
            await useEditorStore.getState().openFile(abs)
          })()
        },
      },
      {
        label: t('在资源管理器中定位'),
        icon: <LocateFixed size={14} />,
        separatorBefore: true,
        action: () => revealInSidebar(abs),
      },
      {
        label: t('在文件管理器中显示'),
        icon: <ExternalLink size={14} />,
        action: () => void revealInFileManager(abs),
      },
      {
        label: t('复制路径'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        separatorBefore: true,
        action: () => void copyAbsolutePath(abs),
      },
      {
        label: t('复制相对路径'),
        icon: <Copy size={14} />,
        shortcut: COPY_RELATIVE_PATH_SHORTCUT,
        action: () => void copyRelativePath(change.path),
      },
    ]
  }

  const changes = status?.changes ?? []

  const rowProps = useMemo(
    () => ({
      changes,
      selected,
      onOpenChange: openChange,
      onOpenContextMenu: showChangeContextMenu,
    }),
    [changes, selected, openChange, showChangeContextMenu],
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
        <div className="flex-shrink-0 border-y border-border px-4 py-2 text-[12px] leading-5 text-fg-muted">
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
          <div className="min-h-0 flex-1 overflow-hidden">
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
    <div className="flex h-full flex-col overflow-hidden bg-bg-sidebar text-fg">
      <div className="flex h-9 flex-shrink-0 items-center justify-between px-4 text-[11px] font-semibold tracking-wide text-fg-muted">
        <span className="flex min-w-0 items-center gap-2">
          <GitBranch size={13} className="flex-shrink-0 text-brand" />
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu.change)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
