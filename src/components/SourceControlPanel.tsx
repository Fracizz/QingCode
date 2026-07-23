import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Undo2,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
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
import { peekSourceControlCache, useSourceControlStore } from '../store/sourceControlStore'
import type {
  GitBranchList,
  GitChange,
  GitCommitFileChange,
  GitCommitInfo,
  GitFileContents,
  GitPullResult,
  GitStatus,
} from '../lib/git'
import {
  type GitChangeGroup,
  canCommitStagedChanges,
  collectUnmergedChanges,
  filterCommitFiles,
  formatAbsoluteCommitTime,
  gitChangeIsUnmerged,
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
import { confirmDialog } from '../store/confirmStore'
import { isTauri, safeInvoke } from '../lib/tauri'
import { useUIStore } from '../store/uiStore'
import { COPY_RELATIVE_PATH_SHORTCUT } from '../lib/shortcuts'
import { copyToClipboard, pathsEqual } from '../utils/fileReferences'
import Tooltip from './Tooltip'
import EmptyState from './EmptyState'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import ScmResizableColumn from './ScmResizableColumn'
import { translate, useI18n } from '../lib/i18n'
import { deferToNativeContextMenuInDev, shouldShowAppContextMenu } from '../lib/devBuild'
import {
  clampScmFilesWidth,
  clampScmLeftWidth,
  loadScmLayout,
  saveScmLayout,
  SCM_FILES_MAX,
  SCM_FILES_MIN,
  SCM_FILES_REMAINING_MIN,
  SCM_LEFT_MAX,
  SCM_LEFT_MIN,
  SCM_LEFT_REMAINING_MIN,
} from '../lib/scmLayout'

const ScmInlineDiff = lazy(() => import('./ScmInlineDiff'))

type ScmWorkspaceTab = 'changes' | 'history'

type InlineDiffState = {
  path: string
  name: string
  original: string
  modified: string
}

const ROW_HEIGHT = 28
const COMMIT_ROW_HEIGHT = 36
const COMMIT_FOOTER_HEIGHT = 28
const COMMIT_PAGE_SIZE = 40
const COMMIT_PREFETCH_ROWS = 12
const BRANCH_MENU_WIDTH = 260
const SCM_TOOLBAR_H = 'h-8'
const SCM_TOOLBAR_PAD = 'px-3'
/** Match tab bar `px-3` so section chevrons line up with the「变更」tab button. */
const SCM_SECTION_PAD_X = 'px-3'
/** Tighter than toolbar icon slot so labels sit closer to the left like the tab text. */
const SCM_SECTION_ICON_SLOT = 'inline-flex h-4 w-4 shrink-0 items-center justify-center'
const SCM_SECTION_ICON_SIZE = 13
/** File rows nest under the section label (between tab-align and old pl-6). */
const SCM_ROW_PAD = 'pl-5 pr-9'
const COMMIT_HASH_COL = 'w-[7ch] shrink-0 font-mono text-[11px] tabular-nums text-accent'
const COMMIT_AUTHOR_COL = 'w-[6.5rem] shrink-0 truncate text-[11px] text-fg-muted'
const COMMIT_REFS_COL = 'w-[8rem] shrink-0 truncate text-[10px] text-brand'
const COMMIT_TIME_COL =
  'w-[10.5rem] shrink-0 truncate text-right font-mono text-[10px] tabular-nums text-fg-dim'
const SCM_ICON_SIZE = 13
const SCM_ICON_SLOT = 'inline-flex h-6 w-6 shrink-0 items-center justify-center'
const SCM_ICON_BUTTON =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent text-fg-dim transition-colors hover:border-border hover:bg-bg-hover hover:text-brand disabled:opacity-35'
const STATUS_BADGE =
  'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-bold leading-none'

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
  const label = tone === 'conflict' ? '!' : tone === 'added' ? '+' : glyph.charAt(0) || '?'
  return <span className={className}>{label}</span>
}

type GitOperation = {
  kind: 'stage' | 'unstage' | 'discard' | 'commit' | 'push' | 'pull' | 'switch'
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
  focus: GitChange
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
    event: ReactMouseEvent
  ) => void
  onOpenChange: (group: GitChangeGroup, change: GitChange) => void
  onChangeAction: (group: GitChangeGroup, changes: GitChange[], all?: boolean) => void
  onOpenContextMenu: (event: ReactMouseEvent, group: GitChangeGroup, change: GitChange) => void
}

function ChangeRowComponent(
  props: {
    ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
    index: number
    style: CSSProperties
  } & ChangeRowProps
) {
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
        className={`flex h-full min-w-0 flex-1 items-center gap-2 ${SCM_ROW_PAD} text-left text-[12px] leading-5 hover:bg-bg-hover ${
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
      <Tooltip
        label={actionLabel}
        side="bottom"
        wrapperClassName="absolute right-2 top-1/2 -translate-y-1/2"
      >
        <button
          type="button"
          disabled={disabled}
          aria-label={`${actionLabel}: ${change.path}`}
          onClick={runRowAction}
          className={`rounded border border-transparent p-0.5 text-fg-dim hover:border-border hover:bg-bg-active hover:text-fg disabled:opacity-40 ${
            actionBusy
              ? 'opacity-100'
              : 'opacity-0 group-hover/scm-row:opacity-100 focus:opacity-100'
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
    ]
  )

  return (
    <section
      className={
        collapsed
          ? 'flex-none border-b border-border'
          : 'flex min-h-0 flex-1 flex-col border-b border-border'
      }
    >
      <div
        className={`flex ${SCM_TOOLBAR_H} flex-shrink-0 items-center border-b border-border/60 bg-bg-sidebar text-[12px] text-fg-muted`}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => onToggle(group)}
          className={`flex h-full min-w-0 flex-1 items-center gap-1.5 ${SCM_SECTION_PAD_X} text-left hover:bg-bg-hover hover:text-fg`}
        >
          <span className={SCM_SECTION_ICON_SLOT}>
            {collapsed ? (
              <ChevronRight size={SCM_SECTION_ICON_SIZE} />
            ) : (
              <ChevronDown size={SCM_SECTION_ICON_SIZE} />
            )}
          </span>
          <span className="truncate font-medium tabular-nums text-fg">{label}</span>
        </button>
        <div className={`flex shrink-0 items-center ${SCM_SECTION_PAD_X} pl-0`}>
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

function CommitFileListRowComponent(
  props: {
    ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
    index: number
    style: CSSProperties
  } & {
    files: GitCommitFileChange[]
    selectedPath: string | null
    onSelect: (path: string) => void
  }
) {
  const { index, style, files, selectedPath, onSelect } = props
  const file = files[index]
  if (!file) return null
  const active = selectedPath === file.path
  return (
    <div style={style} className="flex">
      <button
        type="button"
        onClick={() => onSelect(file.path)}
        className={`flex h-full w-full items-center gap-2 px-3 text-left text-[12px] hover:bg-bg-hover ${
          active ? 'bg-bg-active' : ''
        }`}
      >
        <GitScmStatusBadge status={file.status} group="unstaged" />
        <Tooltip
          label={file.path}
          side="bottom"
          onlyWhenOverflow
          wrapperClassName="min-w-0 flex-1 truncate font-mono text-[11px] text-tree-fg"
        >
          <span>{formatScmDisplayPath(file.path)}</span>
        </Tooltip>
      </button>
    </div>
  )
}

function CommitFileList({
  files,
  selectedPath,
  onSelect,
}: {
  files: GitCommitFileChange[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  const listRef = useListRef(null)
  const rowProps = useMemo(
    () => ({ files, selectedPath, onSelect }),
    [files, onSelect, selectedPath]
  )

  return (
    <List
      listRef={listRef}
      rowCount={files.length}
      rowHeight={ROW_HEIGHT}
      rowComponent={CommitFileListRowComponent}
      rowProps={rowProps}
      overscanCount={20}
      className="h-full overscroll-y-contain"
      style={
        {
          height: '100%',
          overscrollBehavior: 'contain',
          contain: 'strict',
          scrollbarGutter: 'stable',
        } as CSSProperties
      }
    />
  )
}

function seedSourceControlStatus(projectPath: string): GitStatus | null {
  return (
    peekSourceControlCache(projectPath) ?? useGitStatusStore.getState().peekPanelStatus(projectPath)
  )
}

type CommitHistoryRowProps = {
  commits: GitCommitInfo[]
  selectedHash: string | null
  loadingMore: boolean
  hasMore: boolean
  emptyExhaustedLabel: string
  loadingMoreLabel: string
  noSubjectLabel: string
  onSelect: (hash: string) => void
}

function CommitHistoryRowComponent(
  props: {
    ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
    index: number
    style: CSSProperties
  } & CommitHistoryRowProps
) {
  const {
    index,
    style,
    commits,
    selectedHash,
    loadingMore,
    hasMore,
    emptyExhaustedLabel,
    loadingMoreLabel,
    noSubjectLabel,
    onSelect,
  } = props

  if (index >= commits.length) {
    return (
      <div
        style={style}
        className="flex items-center gap-2 pl-5 pr-3 text-[11px] text-fg-dim"
        aria-hidden={!loadingMore && hasMore}
      >
        {loadingMore ? (
          <>
            <LoaderCircle size={12} className="animate-spin text-accent" />
            {loadingMoreLabel}
          </>
        ) : hasMore ? (
          <span className="opacity-0">·</span>
        ) : (
          emptyExhaustedLabel
        )}
      </div>
    )
  }

  const commit = commits[index]
  if (!commit) return null
  const active = selectedHash === commit.hash
  return (
    <div style={style} className="flex">
      <button
        type="button"
        onClick={() => onSelect(commit.hash)}
        className={`flex h-full w-full items-center gap-2 pl-5 pr-3 text-left hover:bg-bg-hover ${
          active ? 'bg-bg-active' : ''
        }`}
      >
        <span className={COMMIT_HASH_COL}>{commit.short_hash}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
          {commit.subject || noSubjectLabel}
        </span>
        <span className={COMMIT_AUTHOR_COL}>
          <Tooltip
            label={commit.author}
            side="bottom"
            onlyWhenOverflow
            wrapperClassName="block min-w-0 truncate"
          >
            <span>{commit.author}</span>
          </Tooltip>
        </span>
        <span className={COMMIT_REFS_COL}>
          {commit.refs ? (
            <Tooltip
              label={commit.refs}
              side="bottom"
              onlyWhenOverflow
              wrapperClassName="block min-w-0 truncate"
            >
              <span>{commit.refs}</span>
            </Tooltip>
          ) : null}
        </span>
        <span className={COMMIT_TIME_COL}>{formatAbsoluteCommitTime(commit.date)}</span>
      </button>
    </div>
  )
}

function CommitHistoryList({
  commits,
  selectedHash,
  loadingMore,
  hasMore,
  onSelect,
  onNearEnd,
}: {
  commits: GitCommitInfo[]
  selectedHash: string | null
  loadingMore: boolean
  hasMore: boolean
  onSelect: (hash: string) => void
  onNearEnd: () => void
}) {
  const { t } = useI18n()
  const listRef = useListRef(null)
  const showFooter =
    commits.length > 0 && (hasMore || loadingMore || commits.length >= COMMIT_PAGE_SIZE)
  const rowCount = commits.length + (showFooter ? 1 : 0)

  const rowProps = useMemo(
    () => ({
      commits,
      selectedHash,
      loadingMore,
      hasMore,
      emptyExhaustedLabel: commits.length >= COMMIT_PAGE_SIZE ? t('已加载全部提交') : '',
      loadingMoreLabel: t('正在加载更多提交…'),
      noSubjectLabel: t('（无提交说明）'),
      onSelect,
    }),
    [commits, hasMore, loadingMore, onSelect, selectedHash, t]
  )

  const rowHeight = useCallback(
    (index: number) => (index >= commits.length ? COMMIT_FOOTER_HEIGHT : COMMIT_ROW_HEIGHT),
    [commits.length]
  )

  const onRowsRendered = useCallback(
    (
      _visible: { startIndex: number; stopIndex: number },
      all: { startIndex: number; stopIndex: number }
    ) => {
      if (!hasMore || commits.length === 0) return
      if (all.stopIndex >= commits.length - COMMIT_PREFETCH_ROWS) {
        onNearEnd()
      }
    },
    [commits.length, hasMore, onNearEnd]
  )

  // Short first page: keep prefetching until the list can scroll or data ends.
  useEffect(() => {
    if (!hasMore || loadingMore || commits.length === 0) return
    const el = listRef.current?.element
    if (!el) return
    if (el.scrollHeight <= el.clientHeight + 8) onNearEnd()
  }, [commits.length, hasMore, loadingMore, listRef, onNearEnd])

  if (commits.length === 0) {
    return (
      <p className={`${SCM_SECTION_PAD_X} py-2 text-[11px] text-fg-dim`}>{t('暂无提交记录')}</p>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex flex-shrink-0 items-center gap-2 border-b border-border/50 bg-bg-sidebar/80 pl-5 pr-3 text-[10px] font-medium tracking-wide text-fg-dim"
        style={{ height: COMMIT_FOOTER_HEIGHT }}
      >
        <span className={COMMIT_HASH_COL}>{t('哈希')}</span>
        <span className="min-w-0 flex-1 truncate">{t('说明')}</span>
        <span className={COMMIT_AUTHOR_COL}>{t('作者')}</span>
        <span className={COMMIT_REFS_COL}>{t('引用')}</span>
        <span className={COMMIT_TIME_COL}>{t('时间')}</span>
      </div>
      <div className="min-h-0 flex-1">
        <List
          listRef={listRef}
          rowCount={rowCount}
          rowHeight={rowHeight}
          rowComponent={CommitHistoryRowComponent}
          rowProps={rowProps}
          onRowsRendered={onRowsRendered}
          overscanCount={16}
          className="h-full overscroll-y-contain"
          style={{
            height: '100%',
            overscrollBehavior: 'contain',
            contain: 'strict',
            scrollbarGutter: 'stable',
          } as CSSProperties}
        />
      </div>
    </div>
  )
}

export default function SourceControlPanel() {
  const { t } = useI18n()
  const currentProject = useProjectStore(s => s.currentProject)
  const projectPath = currentProject?.path ?? null

  const [status, setStatus] = useState<GitStatus | null>(() =>
    projectPath ? seedSourceControlStatus(projectPath) : null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const selectionAnchorRef = useRef<{ group: GitChangeGroup; index: number } | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [commitError, setCommitError] = useState<string | null>(null)
  const [pushRetryAvailable, setPushRetryAvailable] = useState(false)
  const [pushAfterCommit, setPushAfterCommit] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<GitChangeGroup, boolean>>({
    unstaged: false,
    staged: false,
  })
  const [scmTab, setScmTab] = useState<ScmWorkspaceTab>('changes')
  const [scmLeftWidth, setScmLeftWidth] = useState(() => loadScmLayout().leftWidth)
  const [scmFilesWidth, setScmFilesWidth] = useState(() => loadScmLayout().filesWidth)
  const [commitsCollapsed, setCommitsCollapsed] = useState(false)
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [commitsHasMore, setCommitsHasMore] = useState(false)
  const [commitsLoadingMore, setCommitsLoadingMore] = useState(false)
  const commitsRef = useRef<GitCommitInfo[]>([])
  const commitsHasMoreRef = useRef(false)
  const commitsLoadingMoreRef = useRef(false)
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null)
  const selectedCommitHashRef = useRef<string | null>(null)
  const [commitFiles, setCommitFiles] = useState<GitCommitFileChange[]>([])
  const [commitFilesLoading, setCommitFilesLoading] = useState(false)
  const [commitFilesError, setCommitFilesError] = useState<string | null>(null)
  const [commitFileFilter, setCommitFileFilter] = useState('')
  const [commitFileFilterRegex, setCommitFileFilterRegex] = useState(false)
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null)
  const selectedCommitFileRef = useRef<string | null>(null)
  const [commitFileDiff, setCommitFileDiff] = useState<InlineDiffState | null>(null)
  const [commitFileDiffLoading, setCommitFileDiffLoading] = useState(false)
  const [inlineDiff, setInlineDiff] = useState<InlineDiffState | null>(null)
  const [inlineDiffLoading, setInlineDiffLoading] = useState(false)
  const [inlineDiffError, setInlineDiffError] = useState<string | null>(null)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [branchMenuStyle, setBranchMenuStyle] = useState<CSSProperties>({
    left: 0,
    top: 0,
    width: BRANCH_MENU_WIDTH,
    visibility: 'hidden',
  })
  const branchAnchorRef = useRef<HTMLButtonElement>(null)
  const branchMenuRef = useRef<HTMLDivElement>(null)
  const refreshSequenceRef = useRef(0)
  const loadingRefreshSequenceRef = useRef<number | null>(null)
  const commitFilesSequenceRef = useRef(0)
  const commitFileDiffSequenceRef = useRef(0)
  const [operation, setOperation] = useState<GitOperation | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    group: GitChangeGroup
    change: GitChange
  } | null>(null)
  const setView = useUIStore(s => s.setView)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)

  const onScmLeftWidthChange = useCallback(
    (width: number) => {
      const next = clampScmLeftWidth(width)
      setScmLeftWidth(next)
      saveScmLayout({ leftWidth: next, filesWidth: scmFilesWidth })
    },
    [scmFilesWidth]
  )

  const onScmFilesWidthChange = useCallback(
    (width: number) => {
      const next = clampScmFilesWidth(width)
      setScmFilesWidth(next)
      saveScmLayout({ leftWidth: scmLeftWidth, filesWidth: next })
    },
    [scmLeftWidth]
  )

  const loadCommits = useCallback(async (path: string, refreshSequence?: number) => {
    const isCurrentRequest = () =>
      useProjectStore.getState().currentProject?.path === path &&
      (refreshSequence === undefined || refreshSequenceRef.current === refreshSequence)
    if (!isTauri()) {
      setCommits([])
      commitsRef.current = []
      setCommitsHasMore(false)
      commitsHasMoreRef.current = false
      return
    }
    try {
      const next = await safeInvoke<GitCommitInfo[]>('读取提交记录', 'git_log', {
        path,
        limit: COMMIT_PAGE_SIZE,
        skip: 0,
      })
      if (isCurrentRequest()) {
        commitsRef.current = next
        setCommits(next)
        const more = next.length >= COMMIT_PAGE_SIZE
        commitsHasMoreRef.current = more
        setCommitsHasMore(more)
        selectedCommitHashRef.current = null
        setSelectedCommitHash(null)
      }
    } catch {
      if (isCurrentRequest()) {
        commitsRef.current = []
        setCommits([])
        commitsHasMoreRef.current = false
        setCommitsHasMore(false)
      }
    }
  }, [])

  const loadMoreCommits = useCallback(async () => {
    const project = useProjectStore.getState().currentProject
    if (!project || !isTauri() || !commitsHasMoreRef.current || commitsLoadingMoreRef.current) {
      return
    }
    const path = project.path
    const skip = commitsRef.current.length
    commitsLoadingMoreRef.current = true
    setCommitsLoadingMore(true)
    try {
      const page = await safeInvoke<GitCommitInfo[]>('读取提交记录', 'git_log', {
        path,
        limit: COMMIT_PAGE_SIZE,
        skip,
      })
      if (useProjectStore.getState().currentProject?.path !== path) return
      const seen = new Set(commitsRef.current.map(c => c.hash))
      const appended = page.filter(c => !seen.has(c.hash))
      const merged =
        appended.length === 0 ? commitsRef.current : [...commitsRef.current, ...appended]
      commitsRef.current = merged
      setCommits(merged)
      const more = page.length >= COMMIT_PAGE_SIZE
      commitsHasMoreRef.current = more
      setCommitsHasMore(more)
    } catch {
      if (useProjectStore.getState().currentProject?.path === path) {
        commitsHasMoreRef.current = false
        setCommitsHasMore(false)
      }
    } finally {
      commitsLoadingMoreRef.current = false
      if (useProjectStore.getState().currentProject?.path === path) {
        setCommitsLoadingMore(false)
      }
    }
  }, [])

  const onCommitListNearEnd = useCallback(() => {
    void loadMoreCommits()
  }, [loadMoreCommits])

  const refresh = useCallback(
    async (opts?: { soft?: boolean }) => {
      const sequence = ++refreshSequenceRef.current
      const soft = opts?.soft ?? false
      const project = useProjectStore.getState().currentProject
      if (!project) {
        loadingRefreshSequenceRef.current = null
        setLoading(false)
        setStatus(null)
        setError(null)
        setOperationError(null)
        setCommits([])
        commitsRef.current = []
        setCommitsHasMore(false)
        commitsHasMoreRef.current = false
        useSourceControlStore.getState().clearCache()
        return
      }
      if (!isTauri()) {
        loadingRefreshSequenceRef.current = null
        setLoading(false)
        setError(translate('Git 功能需要 Tauri 桌面环境'))
        setStatus(null)
        setCommits([])
        commitsRef.current = []
        setCommitsHasMore(false)
        commitsHasMoreRef.current = false
        return
      }

      const path = project.path
      const isCurrentRequest = () =>
        refreshSequenceRef.current === sequence &&
        useProjectStore.getState().currentProject?.path === path
      if (!soft) {
        loadingRefreshSequenceRef.current = sequence
        setLoading(true)
        setOperationError(null)
      } else if (loadingRefreshSequenceRef.current !== null) {
        loadingRefreshSequenceRef.current = null
        setLoading(false)
      }

      try {
        // Soft path reuses the shared workdir refresh (coalesced with badge/tree).
        // Hard refresh uses full git_status so branch + rename paths stay accurate.
        if (soft) {
          await useGitStatusStore.getState().refresh(path)
          let next = seedSourceControlStatus(path)
          if (next?.is_repository && !next.branch) {
            try {
              const head = await safeInvoke<{ name: string } | null>(
                '读取 Git 分支',
                'get_git_head',
                {
                  path,
                }
              )
              if (head?.name) {
                next = { ...next, branch: head.name }
                useSourceControlStore.getState().setCache(path, next)
              }
            } catch {
              /* keep null branch; hard refresh can recover */
            }
          }
          if (next && isCurrentRequest()) {
            setStatus(next)
            setError(null)
          }
          return
        }

        const next = await safeInvoke<GitStatus>('读取 Git 状态', 'git_status', {
          path,
        })
        if (!isCurrentRequest()) return
        setStatus(next)
        setError(null)
        useGitStatusStore.getState().applyFromGitStatus(path, next)
        setSelectedKeys(new Set())
        setInlineDiff(null)
        setInlineDiffLoading(false)
        setInlineDiffError(null)
        if (next.is_repository) {
          await loadCommits(path, sequence)
        } else {
          setCommits([])
          commitsRef.current = []
          setCommitsHasMore(false)
          commitsHasMoreRef.current = false
        }
      } catch (reason) {
        if (!isCurrentRequest()) return
        if (!soft || !seedSourceControlStatus(path)) {
          setStatus(null)
        }
        setError(String(reason))
      } finally {
        if (loadingRefreshSequenceRef.current === sequence) {
          loadingRefreshSequenceRef.current = null
          setLoading(false)
        }
      }
    },
    [loadCommits]
  )

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setCommitMessage('')
      setCommitError(null)
      setOperationError(null)
      setPushRetryAvailable(false)
      setOperation(null)
      setContextMenu(null)
      setBranchMenuOpen(false)
      setBranchList(null)
      selectedCommitHashRef.current = null
      selectedCommitFileRef.current = null
      commitFilesSequenceRef.current += 1
      commitFileDiffSequenceRef.current += 1
      setSelectedCommitHash(null)
      setCommitFiles([])
      setCommitFilesError(null)
      setCommitFileDiff(null)
      setInlineDiff(null)
      setInlineDiffLoading(false)
      setInlineDiffError(null)
      if (!projectPath) {
        setStatus(null)
        setError(null)
        setCommits([])
        commitsRef.current = []
        setCommitsHasMore(false)
        commitsHasMoreRef.current = false
        setSelectedKeys(new Set())
        return
      }
      const seeded = seedSourceControlStatus(projectPath)
      if (seeded) {
        setStatus(seeded)
        setError(null)
        void refresh({ soft: true })
        if (seeded.is_repository) void loadCommits(projectPath)
        else {
          setCommits([])
          commitsRef.current = []
          setCommitsHasMore(false)
          commitsHasMoreRef.current = false
        }
      } else {
        setStatus(null)
        void refresh({ soft: false })
      }
    }, 0)
    return () => window.clearTimeout(resetTimer)
  }, [projectPath, refresh, loadCommits])

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
  const unmergedChanges = useMemo(() => collectUnmergedChanges(status?.changes ?? []), [status])
  const filteredCommitFiles = useMemo(
    () =>
      filterCommitFiles(commitFiles, commitFileFilter, commitFileFilterRegex ? 'regex' : 'text'),
    [commitFileFilter, commitFileFilterRegex, commitFiles],
  )

  // Drop stale selection / inline diff when status refresh removes those paths
  // (discard, stage, watcher) — otherwise the right pane keeps a frozen snapshot.
  const inlineDiffPath = inlineDiff?.path ?? null
  useEffect(() => {
    if (!projectPath) return
    const liveKeys = new Set<string>([
      ...groups.staged.map(change => scmRowKey('staged', change.path)),
      ...groups.unstaged.map(change => scmRowKey('unstaged', change.path)),
    ])
    const liveAbs = [
      ...groups.staged.map(change => absoluteFilePath(projectPath, change.path)),
      ...groups.unstaged.map(change => absoluteFilePath(projectPath, change.path)),
    ]

    setSelectedKeys(prev => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set<string>()
      for (const key of prev) {
        if (liveKeys.has(key)) next.add(key)
        else changed = true
      }
      return changed ? next : prev
    })

    if (
      inlineDiffPath &&
      !liveAbs.some(abs => pathsEqual(abs, inlineDiffPath))
    ) {
      setInlineDiff(null)
      setInlineDiffLoading(false)
      setInlineDiffError(null)
    }
  }, [groups.staged, groups.unstaged, inlineDiffPath, projectPath])

  const toggleGroup = useCallback((group: GitChangeGroup) => {
    setCollapsedGroups(current => ({ ...current, [group]: !current[group] }))
  }, [])

  const positionBranchMenu = useCallback(() => {
    const rect = branchAnchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - BRANCH_MENU_WIDTH - 8))
    setBranchMenuStyle({
      left,
      top: rect.bottom + 4,
      width: BRANCH_MENU_WIDTH,
      visibility: 'visible',
    })
  }, [])

  const openBranchMenu = useCallback(async () => {
    const project = useProjectStore.getState().currentProject
    if (!project || !isTauri() || operation || loading) return
    setBranchMenuOpen(true)
    try {
      const next = await safeInvoke<GitBranchList>('读取分支列表', 'git_branch_list', {
        path: project.path,
      })
      if (useProjectStore.getState().currentProject?.path === project.path) {
        setBranchList(next)
      }
    } catch (reason) {
      if (useProjectStore.getState().currentProject?.path === project.path) {
        setBranchMenuOpen(false)
        const message = String(reason)
        setOperationError(message)
        useProjectStore
          .getState()
          .pushToast('error', t('读取分支列表失败：{error}', { error: message }))
      }
    }
  }, [loading, operation, t])

  const switchToBranch = useCallback(
    async (branch: string) => {
      const project = useProjectStore.getState().currentProject
      if (!project || operation || loading) return
      setBranchMenuOpen(false)
      setOperation({ kind: 'switch', key: `switch:${branch}` })
      setOperationError(null)
      try {
        await safeInvoke('切换 Git 分支', 'git_switch', {
          path: project.path,
          branch,
        })
        if (useProjectStore.getState().currentProject?.path === project.path) {
          await refresh({ soft: false })
          useProjectStore.getState().pushToast('success', t('已切换到 {branch}', { branch }))
        }
      } catch (reason) {
        if (useProjectStore.getState().currentProject?.path === project.path) {
          const message = String(reason)
          setOperationError(message)
          useProjectStore
            .getState()
            .pushToast('error', t('切换分支失败：{error}', { error: message }))
        }
      } finally {
        setOperation(null)
      }
    },
    [loading, operation, refresh, t]
  )

  const copyCommitHash = useCallback(
    async (shortHash: string) => {
      try {
        await copyToClipboard(shortHash)
        useProjectStore.getState().pushToast('success', t('已复制提交哈希'))
      } catch (error) {
        useProjectStore
          .getState()
          .pushToast('error', t('复制路径失败: {error}', { error: String(error) }))
      }
    },
    [t]
  )

  const loadCommitFiles = useCallback(async (rev: string) => {
    const sequence = ++commitFilesSequenceRef.current
    const project = useProjectStore.getState().currentProject
    if (!project || !isTauri()) {
      setCommitFiles([])
      return
    }
    setCommitFilesLoading(true)
    setCommitFilesError(null)
    setCommitFileFilter('')
    selectedCommitFileRef.current = null
    setSelectedCommitFile(null)
    setCommitFileDiff(null)
    commitFileDiffSequenceRef.current += 1
    const isCurrentRequest = () =>
      commitFilesSequenceRef.current === sequence &&
      selectedCommitHashRef.current === rev &&
      useProjectStore.getState().currentProject?.path === project.path
    try {
      const files = await safeInvoke<GitCommitFileChange[]>('读取提交文件', 'git_commit_files', {
        path: project.path,
        rev,
      })
      if (isCurrentRequest()) {
        setCommitFiles(files)
      }
    } catch (reason) {
      if (isCurrentRequest()) {
        setCommitFiles([])
        setCommitFilesError(String(reason))
      }
    } finally {
      if (isCurrentRequest()) {
        setCommitFilesLoading(false)
      }
    }
  }, [])

  const loadCommitFileDiff = useCallback(
    async (rev: string, filePath: string) => {
      const sequence = ++commitFileDiffSequenceRef.current
      const project = useProjectStore.getState().currentProject
      if (!project || !isTauri()) return
      selectedCommitFileRef.current = filePath
      setSelectedCommitFile(filePath)
      setCommitFileDiffLoading(true)
      const isCurrentRequest = () =>
        commitFileDiffSequenceRef.current === sequence &&
        selectedCommitHashRef.current === rev &&
        selectedCommitFileRef.current === filePath &&
        useProjectStore.getState().currentProject?.path === project.path
      try {
        const pair = await safeInvoke<GitFileContents>(
          '读取提交文件内容',
          'git_commit_file_contents',
          { path: project.path, rev, file: filePath }
        )
        if (!isCurrentRequest()) return
        const name = filePath.split(/[/\\]/).pop() ?? filePath
        setCommitFileDiff({
          path: `${project.path}/${filePath}`,
          name,
          original: pair.original,
          modified: pair.modified,
        })
      } catch (reason) {
        if (isCurrentRequest()) {
          setCommitFileDiff(null)
          useProjectStore
            .getState()
            .pushToast('error', t('打开差异对比失败：{error}', { error: String(reason) }))
        }
      } finally {
        if (isCurrentRequest()) {
          setCommitFileDiffLoading(false)
        }
      }
    },
    [t]
  )

  useEffect(() => {
    if (scmTab !== 'history') return
    const rev = selectedCommitHash ?? commits[0]?.hash ?? null
    if (!rev) {
      selectedCommitHashRef.current = null
      queueMicrotask(() => {
        setCommitFiles([])
        setCommitFilesError(null)
      })
      return
    }
    selectedCommitHashRef.current = rev
    queueMicrotask(() => void loadCommitFiles(rev))
  }, [scmTab, selectedCommitHash, commits, loadCommitFiles])

  useLayoutEffect(() => {
    if (!branchMenuOpen) return
    positionBranchMenu()
  }, [branchMenuOpen, branchList, positionBranchMenu])

  useEffect(() => {
    if (!branchMenuOpen) return
    const close = () => setBranchMenuOpen(false)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (branchMenuRef.current?.contains(target)) return
      if (branchAnchorRef.current?.contains(target)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onReposition = () => positionBranchMenu()
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onReposition)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('blur', close)
    }
  }, [branchMenuOpen, positionBranchMenu])

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
        await safeInvoke(
          isStage ? '暂存 Git 更改' : '取消暂存 Git 更改',
          isStage ? 'git_stage' : 'git_unstage',
          {
            path: project.path,
            files: all ? [] : files,
            all: all || null,
          }
        )
        if (useProjectStore.getState().currentProject?.path === project.path) {
          void refresh({ soft: true })
          useProjectStore
            .getState()
            .pushToast(
              'success',
              isStage
                ? t('已暂存 {count} 个文件', { count: all ? changes.length : files.length })
                : t('已取消暂存 {count} 个文件', { count: all ? changes.length : files.length })
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
          useProjectStore
            .getState()
            .pushToast(
              'error',
              isStage
                ? t('暂存更改失败：{error}', { error: message })
                : t('取消暂存失败：{error}', { error: message })
            )
        }
      } finally {
        setOperation(null)
      }
    },
    [loading, operation, refresh, status, t]
  )

  const discardChanges = useCallback(
    async (group: GitChangeGroup, targets: GitChange[]) => {
      const project = useProjectStore.getState().currentProject
      if (!project || operation || loading || targets.length === 0) return
      if (targets.some(change => gitChangeIsUnmerged(change.status))) {
        useProjectStore.getState().pushToast('error', t('无法丢弃存在合并冲突的文件'))
        return
      }

      const bulk = targets.length > 1
      const firstName = formatScmDisplayPath(targets[0].path)
      const confirmed = await confirmDialog({
        title: t('丢弃更改'),
        message: bulk
          ? t('确定丢弃 {count} 个文件的更改？', { count: targets.length })
          : t('确定丢弃「{name}」的更改？', { name: firstName }),
        detail: t('此操作无法撤销。未跟踪的文件将被删除。'),
        kind: 'danger',
        confirmLabel: t('丢弃'),
        cancelLabel: t('取消'),
      })
      if (confirmed !== true) return

      const files = targets.map(change => change.path)
      const key = files.length > 1 ? `multi:${group}` : scmRowKey(group, files[0])
      setOperation({ kind: 'discard', key })
      setOperationError(null)

      try {
        await safeInvoke('丢弃 Git 更改', 'git_discard', {
          path: project.path,
          files,
          staged: group === 'staged',
        })
        if (useProjectStore.getState().currentProject?.path === project.path) {
          const editor = useEditorStore.getState()
          for (const change of targets) {
            const abs = absoluteFilePath(project.path, change.path)
            if (change.status === '??') {
              editor.closeTabsForPath(abs)
            } else {
              editor.closeDiffTabsForPath(abs)
            }
          }
          void refresh({ soft: true })
          useProjectStore
            .getState()
            .pushToast('success', t('已丢弃 {count} 个文件的更改', { count: files.length }))
        }
      } catch (reason) {
        if (useProjectStore.getState().currentProject?.path === project.path) {
          void refresh({ soft: true })
          const message = String(reason)
          setOperationError(message)
          useProjectStore
            .getState()
            .pushToast('error', t('丢弃更改失败：{error}', { error: message }))
        }
      } finally {
        setOperation(null)
      }
    },
    [loading, operation, refresh, t]
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
    setPushRetryAvailable(false)
    try {
      await safeInvoke<string>('提交 Git 更改', 'git_commit', {
        path: project.path,
        message,
      })
      if (useProjectStore.getState().currentProject?.path === project.path) {
        await refresh({ soft: false })
        if (pushAfterCommit) {
          setOperation({ kind: 'push', key: 'push' })
          try {
            await safeInvoke<string>('推送 Git 提交', 'git_push', { path: project.path })
          } catch (reason) {
            if (useProjectStore.getState().currentProject?.path !== project.path) return
            const pushError = String(reason)
            const failureMessage = t(
              '提交成功，但推送失败：{error}。提交信息已保留；请检查远程认证、网络或分支后重试。',
              { error: pushError }
            )
            setOperationError(failureMessage)
            setPushRetryAvailable(true)
            useProjectStore.getState().pushToast('error', failureMessage)
            return
          }
          if (useProjectStore.getState().currentProject?.path !== project.path) return
          await refresh({ soft: false })
          setCommitMessage('')
          useProjectStore.getState().pushToast('success', t('提交并推送成功'))
        } else {
          setCommitMessage('')
          useProjectStore.getState().pushToast('success', t('提交成功'))
        }
      }
    } catch (reason) {
      if (useProjectStore.getState().currentProject?.path === project.path) {
        await refresh({ soft: false })
        const failureMessage = t(
          '提交失败：{error}。提交信息已保留；请检查 Git 身份、冲突或暂存内容后重试。',
          { error: String(reason) }
        )
        setOperationError(failureMessage)
        useProjectStore.getState().pushToast('error', failureMessage)
      }
    } finally {
      setOperation(null)
    }
  }, [commitMessage, groups.staged.length, loading, operation, pushAfterCommit, refresh, t])

  const retryPush = useCallback(async () => {
    const project = useProjectStore.getState().currentProject
    if (!project || operation || loading) return
    setOperation({ kind: 'push', key: 'push' })
    setOperationError(null)
    try {
      await safeInvoke<string>('推送 Git 提交', 'git_push', { path: project.path })
      if (useProjectStore.getState().currentProject?.path === project.path) {
        await refresh({ soft: false })
        setCommitMessage('')
        setPushRetryAvailable(false)
        useProjectStore.getState().pushToast('success', t('推送成功'))
      }
    } catch (reason) {
      if (useProjectStore.getState().currentProject?.path === project.path) {
        const failureMessage = t(
          '推送失败：{error}。提交信息已保留；请检查远程认证、网络或分支后重试。',
          { error: String(reason) }
        )
        setOperationError(failureMessage)
        setPushRetryAvailable(true)
        useProjectStore.getState().pushToast('error', failureMessage)
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
    [revealFileInTree, setView]
  )

  const loadInlineDiff = useCallback(
    async (change: GitChange) => {
      if (!currentProject) return
      const rel = normalizeGitChangePath(change.path)
      const abs = absoluteFilePath(currentProject.path, rel)
      if (await changeIsDirectory(currentProject.path, change)) {
        setInlineDiff(null)
        setInlineDiffError(null)
        revealInSidebar(abs)
        return
      }
      setInlineDiffLoading(true)
      setInlineDiffError(null)
      try {
        const pair = await safeInvoke<GitFileContents>('读取 Git 文件内容', 'git_file_contents', {
          path: currentProject.path,
          file: abs,
        })
        if (useProjectStore.getState().currentProject?.path !== currentProject.path) return
        const name = rel.split(/[/\\]/).pop() ?? rel
        setInlineDiff({
          path: abs,
          name,
          original: pair.original,
          modified: pair.modified,
        })
      } catch (reason) {
        if (useProjectStore.getState().currentProject?.path === currentProject.path) {
          setInlineDiff(null)
          setInlineDiffError(String(reason))
        }
      } finally {
        if (useProjectStore.getState().currentProject?.path === currentProject.path) {
          setInlineDiffLoading(false)
        }
      }
    },
    [currentProject, revealInSidebar]
  )

  const openChangeInEditor = useCallback(
    async (_group: GitChangeGroup, change: GitChange) => {
      if (!currentProject) return
      const rel = normalizeGitChangePath(change.path)
      const abs = absoluteFilePath(currentProject.path, rel)
      if (await changeIsDirectory(currentProject.path, change)) {
        revealInSidebar(abs)
        return
      }
      setView('explorer')
      void useEditorStore.getState().openDiff(currentProject.path, rel, abs)
    },
    [currentProject, revealInSidebar, setView]
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
      setScmTab('changes')
      void loadInlineDiff(change)
    },
    [groups.staged, groups.unstaged, loadInlineDiff]
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
    []
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
        label: bulkAction
          ? t('丢弃 {count} 个文件的更改', { count: actionTargets.length })
          : t('丢弃更改'),
        icon: <Undo2 size={14} />,
        danger: true,
        disabled:
          Boolean(operation) ||
          loading ||
          actionTargets.some(item => gitChangeIsUnmerged(item.status)),
        action: () => void discardChanges(group, actionTargets),
      },
      {
        label: t('打开更改'),
        icon: <GitCompare size={14} />,
        separatorBefore: true,
        action: () => void openChangeInEditor(group, change),
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
            setView('explorer')
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
    body = (
      <EmptyState icon={<Folder size={28} strokeWidth={1.2} />} title={t('请先选择或添加项目')} />
    )
  } else if (error && !status) {
    body = (
      <EmptyState
        icon={<AlertCircle size={28} strokeWidth={1.2} className="text-danger" />}
        title={error}
      />
    )
  } else if (status && !status.is_repository) {
    body = (
      <EmptyState
        icon={<GitBranch size={28} strokeWidth={1.2} />}
        title={t('当前项目不是 Git 仓库')}
      />
    )
  } else if (status) {
    const branch = status.branch ?? t('游离 HEAD')
    const writeDisabled = Boolean(operation) || loading
    const changesPane = (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ScmResizableColumn
          width={scmLeftWidth}
          minWidth={SCM_LEFT_MIN}
          maxWidth={SCM_LEFT_MAX}
          remainingMin={SCM_LEFT_REMAINING_MIN}
          onWidthChange={onScmLeftWidthChange}
          tooltip={t('拖动调整列表宽度 · {min}–{max}px · 当前 {current}px', {
            min: SCM_LEFT_MIN,
            max: SCM_LEFT_MAX,
            current: scmLeftWidth,
          })}
          className="bg-bg-sidebar"
        >
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
            onOpenChange={openChangeInEditor}
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
            onOpenChange={openChangeInEditor}
            onChangeAction={runChangeAction}
            onOpenContextMenu={showChangeContextMenu}
            onToggle={toggleGroup}
          />
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
              rows={3}
              disabled={writeDisabled}
              onChange={event => {
                setCommitMessage(event.target.value)
                if (commitError) setCommitError(null)
              }}
              placeholder={
                groups.staged.length === 0 ? t('请先暂存要提交的更改') : t('提交信息（必填）')
              }
              aria-label={t('提交信息')}
              aria-invalid={commitError ? true : undefined}
              className="text-ui-sm block max-h-28 min-h-14 w-full resize-y rounded border border-border-strong bg-bg-deep/60 px-2.5 py-2 leading-5 text-fg outline-none placeholder:text-fg-dim focus:border-accent disabled:opacity-60"
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
        </ScmResizableColumn>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
          {inlineDiffLoading ? (
            <EmptyState
              icon={<LoaderCircle size={22} className="animate-spin text-accent" />}
              title={t('正在读取差异…')}
            />
          ) : inlineDiffError ? (
            <EmptyState
              icon={<AlertCircle size={28} strokeWidth={1.2} className="text-danger" />}
              title={inlineDiffError}
            />
          ) : inlineDiff ? (
            <div className="editor-font-independent flex min-h-0 flex-1 flex-col">
              <Suspense
                fallback={
                  <EmptyState
                    icon={<LoaderCircle size={22} className="animate-spin text-accent" />}
                    title={t('正在读取差异…')}
                  />
                }
              >
                <ScmInlineDiff
                  path={inlineDiff.path}
                  name={inlineDiff.name}
                  original={inlineDiff.original}
                  modified={inlineDiff.modified}
                />
              </Suspense>
            </div>
          ) : (
            <EmptyState
              icon={<GitCompare size={28} strokeWidth={1.2} />}
              title={t('选择一个更改查看差异')}
            />
          )}
        </div>
      </div>
    )

    const selectedCommit = commits.find(c => c.hash === selectedCommitHash) ?? commits[0] ?? null
    const showingCommitDiff = Boolean(commitFileDiff || commitFileDiffLoading)

    const closeCommitDiff = () => {
      selectedCommitFileRef.current = null
      setSelectedCommitFile(null)
      setCommitFileDiff(null)
      setCommitFileDiffLoading(false)
      commitFileDiffSequenceRef.current += 1
    }

    const historyDetailPane = selectedCommit ? (
      <ScmResizableColumn
        width={scmFilesWidth}
        minWidth={SCM_FILES_MIN}
        maxWidth={SCM_FILES_MAX}
        remainingMin={SCM_FILES_REMAINING_MIN}
        edge="start"
        onWidthChange={onScmFilesWidthChange}
        tooltip={t('拖动调整详情宽度 · {min}–{max}px · 当前 {current}px', {
          min: SCM_FILES_MIN,
          max: SCM_FILES_MAX,
          current: scmFilesWidth,
        })}
        className="bg-bg-sidebar"
      >
        <div className="flex-shrink-0 space-y-2 border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-semibold leading-snug text-fg">
            {selectedCommit.subject || t('（无提交说明）')}
          </h2>
          <div className="flex flex-col gap-1 text-[12px] text-fg-muted">
            <span>
              <span className="text-fg-dim">{t('作者')}</span>
              {' · '}
              {selectedCommit.author}
            </span>
            <span>
              <span className="text-fg-dim">{t('时间')}</span>
              {' · '}
              {formatAbsoluteCommitTime(selectedCommit.date)}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-fg-dim">{t('提交')}</span>
              <span className="font-mono text-[12px] text-accent">{selectedCommit.short_hash}</span>
              <button
                type="button"
                onClick={() => void copyCommitHash(selectedCommit.short_hash)}
                className="rounded border border-border px-2 py-0.5 text-[11px] text-fg hover:bg-bg-hover"
              >
                {t('复制哈希')}
              </button>
            </span>
          </div>
        </div>
        <div className="flex h-8 flex-shrink-0 items-center border-b border-border/60 px-3 text-[12px] font-medium text-fg">
          {commitFileFilter.trim()
            ? t('更改的文件（{shown} / {total}）', {
                shown: filteredCommitFiles.files.length,
                total: commitFiles.length,
              })
            : t('更改的文件（{count}）', { count: commitFiles.length })}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
          <input
            type="search"
            value={commitFileFilter}
            onChange={event => setCommitFileFilter(event.target.value)}
            placeholder={
              commitFileFilterRegex ? t('支持正则表达式') : t('筛选文件路径')
            }
            aria-label={t('筛选文件路径')}
            className="text-ui-sm min-w-0 flex-1 rounded border border-border bg-bg-deep/60 px-2 py-1 text-fg outline-none placeholder:text-fg-dim focus:border-accent"
          />
          <Tooltip
            label={commitFileFilterRegex ? t('关闭正则') : t('使用正则')}
            side="bottom"
          >
            <button
              type="button"
              aria-pressed={commitFileFilterRegex}
              aria-label={commitFileFilterRegex ? t('关闭正则') : t('使用正则')}
              onClick={() => setCommitFileFilterRegex(v => !v)}
              className={`shrink-0 rounded border px-1.5 py-1 font-mono text-[11px] leading-none transition-colors ${
                commitFileFilterRegex
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-border text-fg-dim hover:bg-bg-hover hover:text-fg'
              }`}
            >
              .*
            </button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {commitFilesLoading ? (
            <p className="flex items-center gap-2 px-3 py-2 text-[11px] text-fg-dim">
              <LoaderCircle size={12} className="animate-spin text-accent" />
              {t('正在读取提交文件…')}
            </p>
          ) : commitFilesError ? (
            <p className="px-3 py-2 text-[11px] text-danger">{commitFilesError}</p>
          ) : commitFiles.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-fg-dim">{t('此提交没有文件变更')}</p>
          ) : filteredCommitFiles.error === 'invalid-regex' ? (
            <p className="px-3 py-2 text-[11px] text-danger">{t('正则表达式无效')}</p>
          ) : filteredCommitFiles.files.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-fg-dim">{t('没有匹配的文件')}</p>
          ) : (
            <CommitFileList
              files={filteredCommitFiles.files}
              selectedPath={selectedCommitFile}
              onSelect={path => void loadCommitFileDiff(selectedCommit.hash, path)}
            />
          )}
        </div>
      </ScmResizableColumn>
    ) : null

    const historyPane = (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ~3/5: commit list by default; clicking a file covers this with the diff. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg">
          {showingCommitDiff ? (
            <>
              <div
                className={`flex ${SCM_TOOLBAR_H} flex-shrink-0 items-center gap-2 border-b border-border/60 bg-bg-sidebar px-2 text-[12px] text-fg-muted`}
              >
                <button
                  type="button"
                  onClick={closeCommitDiff}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-fg hover:bg-bg-hover"
                >
                  <ChevronLeft size={14} />
                  {t('返回提交列表')}
                </button>
                {commitFileDiff && (
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-dim">
                    {commitFileDiff.name}
                  </span>
                )}
              </div>
              {commitFileDiffLoading ? (
                <EmptyState
                  icon={<LoaderCircle size={22} className="animate-spin text-accent" />}
                  title={t('正在读取差异…')}
                />
              ) : commitFileDiff ? (
                <div className="editor-font-independent flex min-h-0 flex-1 flex-col">
                  <Suspense
                    fallback={
                      <EmptyState
                        icon={<LoaderCircle size={22} className="animate-spin text-accent" />}
                        title={t('正在读取差异…')}
                      />
                    }
                  >
                    <ScmInlineDiff
                      path={commitFileDiff.path}
                      name={commitFileDiff.name}
                      original={commitFileDiff.original}
                      modified={commitFileDiff.modified}
                    />
                  </Suspense>
                </div>
              ) : null}
            </>
          ) : (
            <div
              className={
                commitsCollapsed ? 'flex-none border-b border-border' : 'flex min-h-0 flex-1 flex-col'
              }
            >
              <div
                className={`flex ${SCM_TOOLBAR_H} flex-shrink-0 items-center border-b border-border/60 bg-bg-sidebar text-[12px] text-fg-muted`}
                style={{ scrollbarGutter: 'stable' }}
              >
                <button
                  type="button"
                  aria-expanded={!commitsCollapsed}
                  onClick={() => setCommitsCollapsed(v => !v)}
                  className={`flex h-full min-w-0 flex-1 items-center gap-1.5 ${SCM_SECTION_PAD_X} text-left hover:bg-bg-hover hover:text-fg`}
                >
                  <span className={SCM_SECTION_ICON_SLOT}>
                    {commitsCollapsed ? (
                      <ChevronRight size={SCM_SECTION_ICON_SIZE} />
                    ) : (
                      <ChevronDown size={SCM_SECTION_ICON_SIZE} />
                    )}
                  </span>
                  <span className="truncate font-medium tabular-nums text-fg">
                    {t('提交记录（{count}）', { count: commits.length })}
                  </span>
                </button>
              </div>
              {!commitsCollapsed && (
                <div className="min-h-0 flex-1 overflow-hidden bg-bg-deep/15">
                  {commits.length === 0 ? (
                    <EmptyState
                      icon={<GitCommitHorizontal size={28} strokeWidth={1.2} />}
                      title={t('暂无提交记录')}
                    />
                  ) : (
                    <CommitHistoryList
                      commits={commits}
                      selectedHash={selectedCommit?.hash ?? null}
                      loadingMore={commitsLoadingMore}
                      hasMore={commitsHasMore}
                      onSelect={hash => {
                        selectedCommitHashRef.current = hash
                        setSelectedCommitHash(hash)
                      }}
                      onNearEnd={onCommitListNearEnd}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {historyDetailPane ?? (
          <div className="flex min-h-0 w-[min(40%,520px)] flex-shrink-0 flex-col border-l border-border bg-bg-sidebar">
            <EmptyState
              icon={<GitCommitHorizontal size={28} strokeWidth={1.2} />}
              title={t('暂无提交记录')}
            />
          </div>
        )}
      </div>
    )

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
          <div
            role="alert"
            className="text-ui-sm flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 break-words border-y border-border bg-danger/5 px-3 py-2 text-danger"
          >
            <span>{operationError ?? error}</span>
            {pushRetryAvailable && (
              <button
                type="button"
                onClick={() => void retryPush()}
                disabled={Boolean(operation) || loading}
                className="rounded border border-danger/50 px-2 py-1 text-[11px] font-medium hover:bg-danger/10 disabled:opacity-50"
              >
                {t('重试推送')}
              </button>
            )}
          </div>
        )}
        <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border px-3">
          <button
            type="button"
            onClick={() => setScmTab('changes')}
            className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
              scmTab === 'changes'
                ? 'bg-bg-active text-fg'
                : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
            }`}
          >
            {t('变更')}
          </button>
          <button
            type="button"
            onClick={() => setScmTab('history')}
            className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
              scmTab === 'history'
                ? 'bg-bg-active text-fg'
                : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
            }`}
          >
            {t('历史')}
          </button>
        </div>
        {scmTab === 'changes' ? changesPane : historyPane}
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
    <div className="ui-font-scaled flex h-full flex-col overflow-hidden bg-bg-sidebar text-fg">
      <div
        className={`flex ${SCM_TOOLBAR_H} flex-shrink-0 items-center gap-2 border-b border-border ${SCM_TOOLBAR_PAD}`}
      >
        <span className="flex min-w-0 items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
          <span className={SCM_ICON_SLOT}>
            <GitBranch size={SCM_ICON_SIZE} className="text-brand" />
          </span>
          <span className="truncate">{t('源代码管理')}</span>
          {status?.is_repository && (
            <button
              ref={branchAnchorRef}
              type="button"
              aria-expanded={branchMenuOpen}
              aria-haspopup="menu"
              aria-label={t('选择分支')}
              disabled={loading || Boolean(operation)}
              onClick={() => {
                if (branchMenuOpen) setBranchMenuOpen(false)
                else void openBranchMenu()
              }}
              className={`flex max-w-[10rem] items-center gap-0.5 truncate rounded bg-bg-deep/80 px-1.5 py-px font-mono text-[10px] font-normal normal-case tracking-normal text-fg transition-colors hover:bg-bg-hover disabled:opacity-50 ${
                branchMenuOpen ? 'bg-bg-active' : ''
              }`}
            >
              <span className="truncate">{status.branch ?? t('游离 HEAD')}</span>
              {operation?.kind === 'switch' ? (
                <LoaderCircle size={10} className="shrink-0 animate-spin text-accent" />
              ) : (
                <ChevronDown
                  size={10}
                  className={`shrink-0 transition-transform ${branchMenuOpen ? 'rotate-180' : ''}`}
                />
              )}
            </button>
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
          <Tooltip label={t('推送到远程')} side="bottom">
            <button
              type="button"
              onClick={() => void retryPush()}
              disabled={loading || Boolean(operation) || !currentProject || !status?.is_repository}
              aria-label={t('推送到远程')}
              className={`${SCM_ICON_BUTTON} hover:text-fg`}
            >
              {operation?.kind === 'push' ? (
                <LoaderCircle size={SCM_ICON_SIZE} className="animate-spin text-accent" />
              ) : (
                <ArrowUp size={SCM_ICON_SIZE} strokeWidth={2.25} />
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
      {branchMenuOpen &&
        createPortal(
          <div
            ref={branchMenuRef}
            role="menu"
            className="ui-font-scaled fixed z-[100] flex max-h-[70vh] flex-col rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45"
            style={branchMenuStyle}
            onPointerDown={event => event.stopPropagation()}
            onContextMenu={event => {
              if (!deferToNativeContextMenuInDev()) event.preventDefault()
            }}
          >
            <div className="px-3 py-1 text-[11px] font-semibold tracking-wide text-fg-muted">
              {t('本地分支')}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {!branchList ? (
                <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-fg-dim">
                  <LoaderCircle size={12} className="animate-spin" />
                  {t('正在读取分支…')}
                </div>
              ) : branchList.local.length === 0 ? (
                <div className="px-3 py-2 text-[12px] text-fg-dim">{t('暂无本地分支')}</div>
              ) : (
                branchList.local.map(branch => (
                  <button
                    key={branch.name}
                    type="button"
                    role="menuitem"
                    disabled={branch.current || Boolean(operation)}
                    onClick={() => void switchToBranch(branch.name)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                      branch.current
                        ? 'bg-bg-active text-fg'
                        : 'text-fg hover:bg-bg-hover disabled:opacity-40'
                    }`}
                  >
                    <span className="inline-flex w-3.5 shrink-0 justify-center">
                      {branch.current ? <Check size={12} className="text-brand" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">{branch.name}</span>
                    {branch.upstream && (
                      <span className="max-w-[40%] truncate text-[10px] text-fg-dim">
                        {branch.upstream}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
            {branchList && branchList.remote.length > 0 && (
              <>
                <div className="mt-1 border-t border-border px-3 py-1 text-[11px] font-semibold tracking-wide text-fg-muted">
                  {t('远程分支')}
                </div>
                <div className="max-h-40 overflow-auto">
                  {branchList.remote.map(name => (
                    <div
                      key={name}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-fg-dim"
                    >
                      <span className="inline-flex w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
