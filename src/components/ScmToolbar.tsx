import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import type { RefObject, CSSProperties, ReactNode } from 'react'
import type { GitStatus } from '@/lib/git/git'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { resolveGitSyncTimestamp } from '@/lib/git/syncTimes'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'

type ScmOperationKind = 'fetch' | 'pull' | 'push' | 'switch'

export type ScmToolbarProps = {
  status: GitStatus | null
  projectPath: string | null
  loading: boolean
  operationKind: ScmOperationKind | null
  disabled: boolean
  branchMenuOpen: boolean
  branchAnchorRef: RefObject<HTMLButtonElement | null>
  pullMenuAnchorRef: RefObject<HTMLButtonElement | null>
  pushMenuAnchorRef: RefObject<HTMLButtonElement | null>
  onOpenBranchMenu: () => void
  onFetch: () => void
  onPull: () => void
  onOpenPullMenu: () => void
  onPush: () => void
  onOpenPushMenu: () => void
}

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="shrink-0 rounded-full bg-accent px-1 text-[9px] font-semibold leading-4 tabular-nums text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}

function TimeTag({ label }: { label: string }) {
  return <span className="shrink-0 text-[10px] text-fg-dim">{label}</span>
}

function segmentGroup(active = false) {
  return `flex h-8 shrink-0 items-stretch overflow-hidden rounded-md border bg-bg-deep/55 ${
    active ? 'border-border-strong/70 bg-bg-active/90' : 'border-border/45'
  }`
}

function SegmentGroup({
  active = false,
  className = '',
  children,
}: {
  active?: boolean
  className?: string
  children: ReactNode
}) {
  return <div className={`${segmentGroup(active)} ${className}`}>{children}</div>
}

export default function ScmToolbar({
  status,
  projectPath,
  loading,
  operationKind,
  disabled,
  branchMenuOpen,
  branchAnchorRef,
  pullMenuAnchorRef,
  pushMenuAnchorRef,
  onOpenBranchMenu,
  onFetch,
  onPull,
  onOpenPullMenu,
  onPush,
  onOpenPushMenu,
}: ScmToolbarProps) {
  const { t } = useI18n()
  const repoReady = Boolean(status?.is_repository)
  const writeDisabled = disabled || !repoReady
  const behind = status?.behind ?? 0
  const ahead = status?.ahead ?? 0
  const neverLabel = t('从未')

  const fetchTime = formatRelativeTime(
    resolveGitSyncTimestamp(projectPath, 'fetch', status?.last_fetch_at),
    t,
    neverLabel,
  )
  const pullTime = formatRelativeTime(
    resolveGitSyncTimestamp(projectPath, 'pull', status?.last_pull_at),
    t,
    neverLabel,
  )
  const pushTime = formatRelativeTime(
    resolveGitSyncTimestamp(projectPath, 'push', status?.last_push_at),
    t,
    neverLabel,
  )

  const segmentBtn = (active = false) =>
    `flex h-full shrink-0 items-center gap-1 px-1.5 text-[11px] text-fg transition-colors hover:bg-bg-hover/80 disabled:opacity-40 ${
      active ? 'bg-bg-hover/60' : ''
    }`

  const menuBtn =
    'flex h-full w-5 shrink-0 items-center justify-center border-l border-border/45 text-fg-dim transition-colors hover:bg-bg-hover/80 disabled:opacity-40'

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Tooltip
        label={status?.branch ?? t('游离 HEAD')}
        side="bottom"
        onlyWhenOverflow
        wrapperClassName="flex min-w-0 max-w-[11rem] shrink"
      >
        <SegmentGroup active={branchMenuOpen} className="w-full min-w-0">
          <button
            ref={branchAnchorRef}
            type="button"
            aria-expanded={branchMenuOpen}
            aria-haspopup="menu"
            aria-label={t('选择分支')}
            disabled={writeDisabled}
            onClick={onOpenBranchMenu}
            className="flex h-full w-full min-w-0 items-center gap-1 px-2 text-left transition-colors hover:bg-bg-hover/80 disabled:opacity-40"
          >
          <GitBranch size={12} className="shrink-0 text-brand" />
          <span className="min-w-0 truncate font-mono text-[11px]">
            {status?.branch ?? t('游离 HEAD')}
          </span>
          {operationKind === 'switch' ? (
            <LoaderCircle size={11} className="shrink-0 animate-spin text-accent" />
          ) : (
            <ChevronDown
              size={11}
              className={`shrink-0 text-fg-dim transition-transform ${branchMenuOpen ? 'rotate-180' : ''}`}
            />
          )}
          </button>
        </SegmentGroup>
      </Tooltip>

      <SegmentGroup>
        <Tooltip label={t('从远程获取最新引用（git fetch）')} side="bottom" wrapperClassName="h-full">
          <button
            type="button"
            aria-label={t('检查更新')}
            disabled={writeDisabled}
            onClick={onFetch}
            className={segmentBtn(operationKind === 'fetch')}
          >
            {operationKind === 'fetch' || loading ? (
              <LoaderCircle size={12} className="animate-spin text-accent" />
            ) : (
              <RefreshCw size={12} className="text-fg-muted" />
            )}
            <span className="whitespace-nowrap">{t('检查更新')}</span>
            <TimeTag label={fetchTime} />
          </button>
        </Tooltip>
      </SegmentGroup>

      <SegmentGroup active={operationKind === 'pull'}>
        <Tooltip label={t('从远程拉取')} side="bottom" wrapperClassName="h-full">
          <button
            type="button"
            aria-label={t('更新')}
            disabled={writeDisabled}
            onClick={onPull}
            className={segmentBtn(operationKind === 'pull')}
          >
            {operationKind === 'pull' ? (
              <LoaderCircle size={12} className="animate-spin text-accent" />
            ) : (
              <ArrowDown size={12} className="text-fg-muted" />
            )}
            <span className="whitespace-nowrap">{t('更新')}</span>
            <TimeTag label={pullTime} />
            <CountBadge count={behind} />
          </button>
        </Tooltip>
        <button
          ref={pullMenuAnchorRef}
          type="button"
          aria-label={t('更多拉取选项')}
          aria-haspopup="menu"
          disabled={writeDisabled}
          onClick={onOpenPullMenu}
          className={menuBtn}
        >
          <ChevronDown size={11} />
        </button>
      </SegmentGroup>

      <SegmentGroup active={operationKind === 'push'}>
        <Tooltip label={t('推送到远程')} side="bottom" wrapperClassName="h-full">
          <button
            type="button"
            aria-label={t('推送')}
            disabled={writeDisabled}
            onClick={onPush}
            className={segmentBtn(operationKind === 'push')}
          >
            {operationKind === 'push' ? (
              <LoaderCircle size={12} className="animate-spin text-accent" />
            ) : (
              <ArrowUp size={12} className="text-fg-muted" />
            )}
            <span className="whitespace-nowrap">{t('推送')}</span>
            <TimeTag label={pushTime} />
            <CountBadge count={ahead} />
          </button>
        </Tooltip>
        <button
          ref={pushMenuAnchorRef}
          type="button"
          aria-label={t('更多推送选项')}
          aria-haspopup="menu"
          disabled={writeDisabled}
          onClick={onOpenPushMenu}
          className={menuBtn}
        >
          <ChevronDown size={11} />
        </button>
      </SegmentGroup>
    </div>
  )
}

export type ScmPullMenuProps = {
  open: boolean
  style: CSSProperties
  menuRef: RefObject<HTMLDivElement | null>
  onPull: () => void
  onPullRebase: () => void
}

export function ScmPullMenu({ open, style, menuRef, onPull, onPullRebase }: ScmPullMenuProps) {
  const { t } = useI18n()
  if (!open) return null
  return (
    <div
      ref={menuRef}
      role="menu"
      className="ui-font-scaled fixed z-[100] min-w-[10rem] rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45"
      style={style}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-bg-hover"
        onClick={onPull}
      >
        <ArrowDown size={12} />
        {t('拉取 (merge)')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-bg-hover"
        onClick={onPullRebase}
      >
        <ArrowDown size={12} />
        {t('拉取 (变基)')}
      </button>
    </div>
  )
}

export type ScmPushMenuProps = {
  open: boolean
  style: CSSProperties
  menuRef: RefObject<HTMLDivElement | null>
  onPush: () => void
}

export function ScmPushMenu({ open, style, menuRef, onPush }: ScmPushMenuProps) {
  const { t } = useI18n()
  if (!open) return null
  return (
    <div
      ref={menuRef}
      role="menu"
      className="ui-font-scaled fixed z-[100] min-w-[10rem] rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45"
      style={style}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-bg-hover"
        onClick={onPush}
      >
        <ArrowUp size={12} />
        {t('推送到远程')}
      </button>
    </div>
  )
}
