import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileIcon,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  LoaderCircle,
  LocateFixed,
  Minus,
  Plus,
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
import type { GitChange, GitPullResult, GitStatus } from '../lib/git'
import {
  type GitChangeGroup,
  canCommitStagedChanges,
  collectUnmergedChanges,
  gitChangePathLooksLikeDirectory,
  gitStatusGlyphForGroup,
  gitStatusMayBeDirectory,
  formatScmDisplayPath,
  normalizeGitChangePath,
  predictBulkGitStatusAfterAction,
  scmRowKey,
  scmStatusBadgeTone,
  splitGitChanges,
} from '../lib/gitStatus'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useUIStore } from '../store/uiStore'
import { COPY_RELATIVE_PATH_SHORTCUT } from '../lib/shortcuts'
import { copyToClipboard } from '../utils/fileReferences'
import Tooltip from './Tooltip'
import EmptyState from './EmptyState'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { translate, useI18n } from '../lib/i18n'
import { shouldShowAppContextMenu } from '../lib/devBuild'

const ROW_HEIGHT = 28
const SCM_TOOLBAR_H = 'h-8'
const SCM_TOOLBAR_PAD = 'px-3'
const SCM_ICON_SIZE = 13
const SCM_ICON_SLOT = 'inline-flex h-6 w-6 shrink-0 items-center justify-center'
const SCM_ICON_BUTTON =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-fg-dim transition-colors hover:border-border hover:bg-bg-hover hover:text-brand disabled:opacity-35'
const STATUS_BADGE = 'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-bold leading-none'

function GitScmStatusBadge({ status, group }: { status: string; group: GitChangeGroup }) {
  const tone = scmStatusBadgeTone(status, group)
  const glyph = gitStatusGlyphForGroup(status, group) ?? status.trim()
  const className =
    tone === 'conflict'
      ? `${STATUS_BADGE} bg-danger text-white`
      : tone === 'added'
      ? `${STATUS_BADGE} bg-ok text-bg`
      : tone === 'deleted'
        ? `${STATUS_BADGE} bg-danger text-white`
        : tone === 'modified'
          ? `${STATUS_BADGE} bg-warn text-bg`
          : `${STATUS_BADGE} bg-accent/80 text-bg`
  const label =
    tone === 'conflict' ? '!' : tone === 'added' ? '+' : glyph.charAt(0) || '?'
  return <span className={className}>{label}</span>
}

type GitOperation = {
  kind: 'stage' | 'unstage' | 'commit' | 'push' | 'pull'
  key: string
}

function absoluteFilePath(projectPath: string, relativePath: string) {
  const root = projectPath.replace(/[\\/]+$/, '')
  const rel = normalizeGitChangePath(relativePath).replace(/\//g, '\\')
  return `${root}\\${rel}`
}

function selectedChangesInGroup(
  group: GitChangeGroup,
  changes: GitChange[],
  selectedKeys: Set<string>,
  focus: GitChange,
): GitChange[] {
  const list = changes.filter(item => selectedKeys.has(scmRowKey(group, item.path)))
  if (list.length > 1 && list.some(item => item.path === focus.path)) return list
  return [focus]
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

function canOpenFileInEditor(status: string): boolean {
  return !status.includes('D')
}

type ChangeRowProps = {
  changes: GitChange[]
  group: GitChangeGroup
  selectedKeys: Set<string>
  operation: GitOperation | null
  disabled: boolean
  stageLabel: string
  unstageLabel: string
  onSelectChange: (
    group: GitChangeGroup,
    change: GitChange,
    index: number,
    event: ReactMouseEvent,
  ) => void
  onOpenChange: (group: GitChangeGroup, change: GitChange) => void
  onChangeAction: (group: GitChangeGroup, changes: GitChange[], all?: boolean) => void
  onOpenContextMenu: (
    event: ReactMouseEvent,
    group: GitChangeGroup,
    change: GitChange,
  ) => void
}

function ChangeRowComponent(props: {
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
  index: number
  style: CSSProperties
} & ChangeRowProps) {
  const {
    index,
    style,
    changes,
    group,
    selectedKeys,
    operation,
    disabled,
    stageLabel,
    unstageLabel,
    onSelectChange,
    onOpenChange,
    onChangeAction,
    onOpenContextMenu,
  } = props
  const change = changes[index]
  if (!change) return null
  const rowKey = scmRowKey(group, change.path)
  const active = selectedKeys.has(rowKey)
  const actionLabel = group === 'staged' ? unstageLabel : stageLabel
  const actionBusy = operation?.key === rowKey || operation?.key === `multi:${group}`
  const selectedInGroup = changes.filter(item => selectedKeys.has(scmRowKey(group, item.path)))

  const runRowAction = () => {
    if (selectedInGroup.length > 1 && active) {
      onChangeAction(group, selectedInGroup)
      return
    }
    onChangeAction(group, [change])
  }

  return (
    <div style={style} className="group/scm-row relative flex">
      <button
        type="button"
        onClick={event => onSelectChange(group, change, index, event)}
        onDoubleClick={() => onOpenChange(group, change)}
        onContextMenu={event => onOpenContextMenu(event, group, change)}
        className={`flex h-full min-w-0 flex-1 items-center gap-2 pl-6 pr-9 text-left text-[12px] leading-5 hover:bg-bg-hover ${
          active ? 'bg-bg-active' : ''
        }`}
      >
        <GitScmStatusBadge status={change.status} group={group} />
        <Tooltip
          label={normalizeGitChangePath(change.path).replace(/\\/g, '/')}
          side="bottom"
          onlyWhenOverflow
          wrapperClassName="min-w-0 flex-1 truncate font-mono text-[11px] text-tree-fg"
        >
          <span>{formatScmDisplayPath(change.path)}</span>
        </Tooltip>
      </button>
      <Tooltip label={actionLabel} side="bottom" wrapperClassName="absolute right-2 top-1/2 -translate-y-1/2">
        <button
          type="button"
          disabled={disabled}
          aria-label={`${actionLabel}: ${change.path}`}
          onClick={runRowAction}
          className={`rounded border border-transparent p-0.5 text-fg-dim hover:border-border hover:bg-bg-active hover:text-fg disabled:opacity-40 ${
            actionBusy ? 'opacity-100' : 'opacity-0 group-hover/scm-row:opacity-100 focus:opacity-100'
          }`}
        >
          {actionBusy ? (
            <LoaderCircle size={12} className="animate-spin text-accent" />
          ) : group === 'staged' ? (
            <Minus size={12} />
          ) : (
            <Plus size={12} />
          )}
        </button>
      </Tooltip>
    </div>
  )
}

type ChangeGroupSectionProps = Omit<ChangeRowProps, 'changes' | 'group'> & {
  changes: GitChange[]
  group: GitChangeGroup
  label: string
  collapsed: boolean
  allStageLabel: string
  allUnstageLabel: string
  onToggle: (group: GitChangeGroup) => void
}

function ChangeGroupSection({
  changes,
  group,
  label,
  collapsed,
  allStageLabel,
  allUnstageLabel,
  selectedKeys,
  operation,
  disabled,
  stageLabel,
  unstageLabel,
  onSelectChange,
  onOpenChange,
  onChangeAction,
  onOpenContextMenu,
  onToggle,
}: ChangeGroupSectionProps) {
  const listRef = useListRef(null)
  const bulkLabel = group === 'staged' ? allUnstageLabel : allStageLabel
  const bulkBusy = operation?.key === `all:${group}`
  const rowProps = useMemo(
    () => ({
      changes,
      group,
      selectedKeys,
      operation,
      disabled,
      stageLabel,
      unstageLabel,
      onSelectChange,
      onOpenChange,
      onChangeAction,
      onOpenContextMenu,
    }),
    [
      changes,
      disabled,
      group,
      onChangeAction,
      onOpenChange,
      onOpenContextMenu,
      onSelectChange,
      operation,
      selectedKeys,
      stageLabel,
      unstageLabel,
    ],
  )

  return (
    <section className={collapsed ? 'flex-none border-b border-border' : 'flex min-h-0 flex-1 flex-col border-b border-border'}>
      <div
        className={`flex ${SCM_TOOLBAR_H} flex-shrink-0 items-center border-b border-border/60 bg-bg-sidebar text-[12px] text-fg-muted`}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => onToggle(group)}
          className={`flex h-full min-w-0 flex-1 items-center gap-1.5 ${SCM_TOOLBAR_PAD} text-left hover:bg-bg-hover hover:text-fg`}
        >
          <span className={SCM_ICON_SLOT}>
            {collapsed ? <ChevronRight size={SCM_ICON_SIZE} /> : <ChevronDown size={SCM_ICON_SIZE} />}
          </span>
          <span className="truncate font-medium tabular-nums text-fg">{label}</span>
        </button>
        <div className={`flex shrink-0 items-center ${SCM_TOOLBAR_PAD} pl-0`}>
          <Tooltip label={bulkLabel} side="bottom">
            <button
              type="button"
              disabled={disabled || changes.length === 0}
              aria-label={bulkLabel}
              onClick={() => onChangeAction(group, changes, true)}
              className={SCM_ICON_BUTTON}
            >
              {bulkBusy ? (
                <LoaderCircle size={SCM_ICON_SIZE} className="animate-spin text-accent" />
              ) : group === 'staged' ? (
                <ArrowUp size={SCM_ICON_SIZE} strokeWidth={2.25} />
              ) : (
                <ArrowDown size={SCM_ICON_SIZE} strokeWidth={2.25} />
              )}
            </button>
          </Tooltip>
        </div>
      </div>
      {!collapsed && changes.length > 0 && (
        <div className="min-h-0 flex-1 overflow-hidden bg-bg-deep/15">
          <List
            listRef={listRef}
            rowCount={changes.length}
            rowHeight={ROW_HEIGHT}
            rowComponent={ChangeRowComponent}
            rowProps={rowProps}
            overscanCount={8}
            className="h-full"
            style={{ height: '100%' }}
          />
        </div>
      )}
    </section>
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
  const [operationError, setOperationError] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const selectionAnchorRef = useRef<{ group: GitChangeGroup; index: number } | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitError, setCommitError] = useState<string | null>(null)
  const [pushAfterCommit, setPushAfterCommit] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<GitChangeGroup, boolean>>({
    unstaged: false,
    staged: false,
  })
  const [operation, setOperation] = useState<GitOperation | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    group: GitChangeGroup
    change: GitChange
  } | null>(null)
  const setView = useUIStore(s => s.setView)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)

  const refresh = useCallback(async (opts?: { soft?: boolean }) => {
    const soft = opts?.soft ?? false
    const project = useProjectStore.getState().currentProject
    if (!project) {
      setStatus(null)
      setError(null)
      setOperationError(null)
      useSourceControlStore.getState().clearCache()
      return
    }
    if (!isTauri()) {
      setError(translate('Git 功能需要 Tauri 桌面环境'))
      setStatus(null)
      return
    }

    const path = project.path
    if (!soft) {
      setLoading(true)
      setOperationError(null)
    }

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
      setSelectedKeys(new Set())
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
    const resetTimer = window.setTimeout(() => {
      setCommitMessage('')
      setCommitError(null)
      setOperationError(null)
      setOperation(null)
      setContextMenu(null)
      if (!projectPath) {
        setStatus(null)
        setError(null)
        setSelectedKeys(new Set())
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
    }, 0)
    return () => window.clearTimeout(resetTimer)
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

  const groups = useMemo(() => splitGitChanges(status?.changes ?? []), [status])
  const unmergedChanges = useMemo(
    () => collectUnmergedChanges(status?.changes ?? []),
    [status],
  )

  const toggleGroup = useCallback((group: GitChangeGroup) => {
    setCollapsedGroups(current => ({ ...current, [group]: !current[group] }))
  }, [])

  const runChangeAction = useCallback(
    async (group: GitChangeGroup, requestedChanges: GitChange[], all = false) => {
      const project = useProjectStore.getState().currentProject
      if (!project || operation || loading) return
      const currentGroups = splitGitChanges(status?.changes ?? [])
      const changes = requestedChanges.length > 0 ? requestedChanges : currentGroups[group]
      const files = [...new Set(changes.map(change => normalizeGitChangePath(change.path)))]
      if (!all && files.length === 0) return

      const isStage = group === 'unstaged'
      const key = all
        ? `all:${group}`
        : files.length > 1
          ? `multi:${group}`
          : scmRowKey(group, files[0])
      setOperation({ kind: isStage ? 'stage' : 'unstage', key })
      setOperationError(null)

      const snapshot = all && status ? status : null
      if (snapshot) {
        const optimistic = predictBulkGitStatusAfterAction(snapshot, group)
        setStatus(optimistic)
        useGitStatusStore.getState().applyFromGitStatus(project.path, optimistic)
      }

      try {
        await safeInvoke(isStage ? '暂存 Git 更改' : '取消暂存 Git 更改', isStage ? 'git_stage' : 'git_unstage', {
          path: project.path,
          files: all ? [] : files,
          all: all || null,
        })
        if (useProjectStore.getState().currentProject?.path === project.path) {
          void refresh({ soft: true })
          useProjectStore.getState().pushToast(
            'success',
            isStage
              ? t('已暂存 {count} 个文件', { count: all ? changes.length : files.length })
              : t('已取消暂存 {count} 个文件', { count: all ? changes.length : files.length }),
          )
        }
      } catch (reason) {
        if (useProjectStore.getState().currentProject?.path === project.path) {
          if (snapshot) {
            setStatus(snapshot)
            useGitStatusStore.getState().applyFromGitStatus(project.path, snapshot)
          }
          void refresh({ soft: true })
          const message = String(reason)
          setOperationError(message)
          useProjectStore.getState().pushToast(
            'error',
            isStage
              ? t('暂存更改失败：{error}', { error: message })
              : t('取消暂存失败：{error}', { error: message }),
          )
        }
      } finally {
        setOperation(null)
      }
    },
    [loading, operation, refresh, status, t],
  )

  const pullCurrent = useCallback(async () => {
    const project = useProjectStore.getState().currentProject
    if (!project || operation || loading) return
    setOperation({ kind: 'pull', key: 'pull' })
    setOperationError(null)
    try {
      const result = await safeInvoke<GitPullResult>('拉取 Git 更改', 'git_pull', {
        path: project.path,
      })
      if (useProjectStore.getState().currentProject?.path === project.path) {
        await refresh({ soft: false })
        if (result.has_conflicts) {
          const message = t('拉取完成，但存在 {count} 个未解决的合并冲突', {
            count: result.conflict_paths.length,
          })
          useProjectStore.getState().pushToast('error', message)
        } else {
          useProjectStore.getState().pushToast('success', t('拉取成功'))
        }
      }
    } catch (reason) {
      if (useProjectStore.getState().currentProject?.path === project.path) {
        await refresh({ soft: false })
        const message = String(reason)
        setOperationError(message)
        useProjectStore.getState().pushToast('error', t('拉取失败：{error}', { error: message }))
      }
    } finally {
      setOperation(null)
    }
  }, [loading, operation, refresh, t])

  const commitStaged = useCallback(async () => {
    const project = useProjectStore.getState().currentProject
    if (!project || operation || loading) return
    const message = commitMessage.trim()
    if (!message) {
      setCommitError(t('提交信息不能为空'))
      return
    }
    if (groups.staged.length === 0) return

    setOperation({ kind: 'commit', key: 'commit' })
    setCommitError(null)
    setOperationError(null)
    try {
      await safeInvoke<string>('提交 Git 更改', 'git_commit', {
        path: project.path,
        message,
      })
      if (useProjectStore.getState().currentProject?.path === project.path) {
        setCommitMessage('')
        await refresh({ soft: false })
        if (pushAfterCommit) {
          setOperation({ kind: 'push', key: 'push' })
          try {
            await safeInvoke<string>('推送 Git 提交', 'git_push', { path: project.path })
          } catch (reason) {
            if (useProjectStore.getState().currentProject?.path !== project.path) return
            const pushError = String(reason)
            const message = t('提交成功，但推送失败：{error}', { error: pushError })
            setOperationError(message)
            useProjectStore.getState().pushToast('error', message)
            return
          }
          if (useProjectStore.getState().currentProject?.path !== project.path) return
          await refresh({ soft: false })
          useProjectStore.getState().pushToast('success', t('提交并推送成功'))
        } else {
          useProjectStore.getState().pushToast('success', t('提交成功'))
        }
      }
    } catch (reason) {
      if (useProjectStore.getState().currentProject?.path === project.path) {
        await refresh({ soft: false })
        const message = String(reason)
        setOperationError(message)
        useProjectStore
          .getState()
          .pushToast('error', t('提交失败：{error}', { error: message }))
      }
    } finally {
      setOperation(null)
    }
  }, [commitMessage, groups.staged.length, loading, operation, pushAfterCommit, refresh, t])

  const pushCurrent = useCallback(async () => {
    const project = useProjectStore.getState().currentProject
    if (!project || operation || loading) return
    setOperation({ kind: 'push', key: 'push' })
    setOperationError(null)
    try {
      await safeInvoke<string>('推送 Git 提交', 'git_push', { path: project.path })
      if (useProjectStore.getState().currentProject?.path === project.path) {
        await refresh({ soft: false })
        useProjectStore.getState().pushToast('success', t('推送成功'))
      }
    } catch (reason) {
      if (useProjectStore.getState().currentProject?.path === project.path) {
        const message = String(reason)
        setOperationError(message)
        useProjectStore
          .getState()
          .pushToast('error', t('推送失败：{error}', { error: message }))
      }
    } finally {
      setOperation(null)
    }
  }, [loading, operation, refresh, t])

  const revealInSidebar = useCallback(
    (absolutePath: string) => {
      setView('explorer')
      void revealFileInTree(absolutePath)
    },
    [revealFileInTree, setView],
  )

  const openChange = useCallback(
    async (_group: GitChangeGroup, change: GitChange) => {
      if (!currentProject) return
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

  const selectChange = useCallback(
    (group: GitChangeGroup, change: GitChange, index: number, event: ReactMouseEvent) => {
      const key = scmRowKey(group, change.path)
      const ctrl = Boolean(event.ctrlKey || event.metaKey)
      const shift = Boolean(event.shiftKey)
      const list = group === 'staged' ? groups.staged : groups.unstaged

      if (shift) {
        const anchorIndex =
          selectionAnchorRef.current?.group === group ? selectionAnchorRef.current.index : index
        const lo = Math.min(anchorIndex, index)
        const hi = Math.max(anchorIndex, index)
        const next = new Set<string>()
        for (let i = lo; i <= hi; i++) {
          const item = list[i]
          if (item) next.add(scmRowKey(group, item.path))
        }
        setSelectedKeys(next)
        return
      }

      if (ctrl) {
        setSelectedKeys(prev => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
        selectionAnchorRef.current = { group, index }
        return
      }

      setSelectedKeys(new Set([key]))
      selectionAnchorRef.current = { group, index }
      void openChange(group, change)
    },
    [groups.staged, groups.unstaged, openChange],
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

  const showChangeContextMenu = useCallback(
    (event: ReactMouseEvent, group: GitChangeGroup, change: GitChange) => {
      if (!shouldShowAppContextMenu(event)) return
      setContextMenu({ x: event.clientX, y: event.clientY, group, change })
    },
    [],
  )

  const contextMenuItems = (group: GitChangeGroup, change: GitChange): ContextMenuItem[] => {
    if (!currentProject) return []
    const projectPath = currentProject.path
    const abs = absoluteFilePath(projectPath, change.path)
    const looksLikeDir = gitChangePathLooksLikeDirectory(change.path)
    const isStaged = group === 'staged'
    const groupChanges = group === 'staged' ? groups.staged : groups.unstaged
    const actionTargets = selectedChangesInGroup(group, groupChanges, selectedKeys, change)
    const bulkAction = actionTargets.length > 1
    return [
      {
        label: bulkAction
          ? isStaged
            ? t('取消暂存 {count} 个文件', { count: actionTargets.length })
            : t('暂存 {count} 个文件', { count: actionTargets.length })
          : isStaged
            ? t('取消暂存更改')
            : t('暂存更改'),
        icon: isStaged ? <Minus size={14} /> : <Plus size={14} />,
        disabled: Boolean(operation) || loading,
        action: () => void runChangeAction(group, actionTargets),
      },
      {
        label: t('打开更改'),
        icon: <GitCompare size={14} />,
        separatorBefore: true,
        action: () => void openChange(group, change),
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

  let body: ReactNode
  if (!currentProject) {
    body = <EmptyState icon={<Folder size={28} strokeWidth={1.2} />} title={t('请先选择或添加项目')} />
  } else if (error && !status) {
    body = <EmptyState icon={<AlertCircle size={28} strokeWidth={1.2} className="text-danger" />} title={error} />
  } else if (status && !status.is_repository) {
    body = <EmptyState icon={<GitBranch size={28} strokeWidth={1.2} />} title={t('当前项目不是 Git 仓库')} />
  } else if (status) {
    const branch = status.branch ?? t('游离 HEAD')
    const writeDisabled = Boolean(operation) || loading
    body = (
      <>
        {unmergedChanges.length > 0 && (
          <div className="text-ui-sm flex-shrink-0 break-words border-y border-warn/30 bg-warn/10 px-3 py-2 text-warn">
            <p className="font-medium">
              {t('存在 {count} 个未解决的合并冲突', { count: unmergedChanges.length })}
            </p>
            <p className="mt-1 text-[11px] leading-5 text-fg-muted">
              {t('请在编辑器中解决冲突标记（<<<<<<<），解决后暂存并提交。')}
            </p>
          </div>
        )}
        {(error || operationError) && (
          <div className="text-ui-sm flex-shrink-0 break-words border-y border-border bg-danger/5 px-3 py-2 text-danger">
            {operationError ?? error}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChangeGroupSection
            group="unstaged"
            label={t('变更（{count}）', { count: groups.unstaged.length })}
            changes={groups.unstaged}
            collapsed={collapsedGroups.unstaged}
            selectedKeys={selectedKeys}
            operation={operation}
            disabled={writeDisabled}
            stageLabel={t('暂存更改')}
            unstageLabel={t('取消暂存更改')}
            allStageLabel={t('所有文件添加至「待提交」')}
            allUnstageLabel={t('所有文件移出「待提交」')}
            onSelectChange={selectChange}
            onOpenChange={openChange}
            onChangeAction={runChangeAction}
            onOpenContextMenu={showChangeContextMenu}
            onToggle={toggleGroup}
          />
          <ChangeGroupSection
            group="staged"
            label={t('待提交（{count}）', { count: groups.staged.length })}
            changes={groups.staged}
            collapsed={collapsedGroups.staged}
            selectedKeys={selectedKeys}
            operation={operation}
            disabled={writeDisabled}
            stageLabel={t('暂存更改')}
            unstageLabel={t('取消暂存更改')}
            allStageLabel={t('所有文件添加至「待提交」')}
            allUnstageLabel={t('所有文件移出「待提交」')}
            onSelectChange={selectChange}
            onOpenChange={openChange}
            onChangeAction={runChangeAction}
            onOpenContextMenu={showChangeContextMenu}
            onToggle={toggleGroup}
          />
        </div>
        <div className="flex-shrink-0 border-t border-border bg-bg-sidebar px-3 py-2.5">
          <label className="mb-2 flex items-center gap-2 text-[12px] text-fg-muted">
            <input
              type="checkbox"
              checked={pushAfterCommit}
              disabled={writeDisabled}
              onChange={event => setPushAfterCommit(event.target.checked)}
              className="h-3.5 w-3.5"
              style={{ accentColor: 'var(--color-accent)' }}
            />
            <span>{t('推送到远程')}</span>
          </label>
          <textarea
            value={commitMessage}
            rows={4}
            disabled={writeDisabled}
            onChange={event => {
              setCommitMessage(event.target.value)
              if (commitError) setCommitError(null)
            }}
            placeholder={
              groups.staged.length === 0
                ? t('请先暂存要提交的更改')
                : t('提交信息（必填）')
            }
            aria-label={t('提交信息')}
            aria-invalid={commitError ? true : undefined}
            className="text-ui-sm block max-h-28 min-h-16 w-full resize-y rounded border border-border-strong bg-bg-deep/60 px-2.5 py-2 leading-5 text-fg outline-none placeholder:text-fg-dim focus:border-accent disabled:opacity-60"
          />
          <button
            type="button"
            disabled={!canCommitStagedChanges(commitMessage, groups.staged.length, writeDisabled)}
            onClick={() => void commitStaged()}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {operation?.kind === 'commit' || operation?.kind === 'push' ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <GitCommitHorizontal size={13} />
            )}
            {operation?.kind === 'commit'
              ? t('正在提交…')
              : operation?.kind === 'push'
                ? t('正在推送…')
                : pushAfterCommit
                  ? t('提交并推送到 {branch}', { branch })
                  : t('提交到 {branch}', { branch })}
          </button>
          {commitError && <p className="text-ui-sm mt-1.5 text-danger">{commitError}</p>}
        </div>
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
      <div
        className={`flex ${SCM_TOOLBAR_H} flex-shrink-0 items-center justify-between gap-2 border-b border-border ${SCM_TOOLBAR_PAD}`}
      >
        <span className="flex min-w-0 items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
          <span className={SCM_ICON_SLOT}>
            <GitBranch size={SCM_ICON_SIZE} className="text-brand" />
          </span>
          <span className="truncate">{t('源代码管理')}</span>
          {status?.is_repository && (
            <span className="max-w-[8rem] truncate rounded bg-bg-deep/80 px-1.5 py-px font-mono text-[10px] font-normal normal-case tracking-normal text-fg">
              {status.branch ?? t('游离 HEAD')}
            </span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip label={t('从远程拉取')} side="bottom">
            <button
              type="button"
              onClick={() => void pullCurrent()}
              disabled={loading || Boolean(operation) || !currentProject || !status?.is_repository}
              aria-label={t('从远程拉取')}
              className={`${SCM_ICON_BUTTON} hover:text-fg`}
            >
              {operation?.kind === 'pull' ? (
                <LoaderCircle size={SCM_ICON_SIZE} className="animate-spin text-accent" />
              ) : (
                <ArrowDown size={SCM_ICON_SIZE} strokeWidth={2.25} />
              )}
            </button>
          </Tooltip>
          <Tooltip label={t('刷新')} side="bottom">
            <button
              type="button"
              onClick={() => void refresh({ soft: false })}
              disabled={loading || Boolean(operation) || !currentProject}
              aria-label={t('刷新')}
              className={`${SCM_ICON_BUTTON} hover:text-fg`}
            >
              <RefreshCw
                size={SCM_ICON_SIZE}
                className={loading ? 'animate-spin text-accent' : undefined}
              />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu.group, contextMenu.change)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
