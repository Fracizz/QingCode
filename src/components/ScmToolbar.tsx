import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  GitBranch,
  Link,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from 'react'
import type { GitRemote, GitStatus } from '@/lib/git/git'
import { flattenRemoteRows, primaryRemoteRow, type ScmRemoteRow } from '@/lib/git/scmRemotes'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { resolveGitSyncTimestamp } from '@/lib/git/syncTimes'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'

type ScmOperationKind = 'fetch' | 'pull' | 'push' | 'switch'

export type ScmToolbarProps = {
  status: GitStatus | null
  projectPath: string | null
  remotes: GitRemote[] | null
  remotesLoading?: boolean
  loading: boolean
  operationKind: ScmOperationKind | null
  disabled: boolean
  branchMenuOpen: boolean
  remotesMenuOpen: boolean
  branchAnchorRef: RefObject<HTMLButtonElement | null>
  remotesMenuAnchorRef: RefObject<HTMLButtonElement | null>
  pullMenuAnchorRef: RefObject<HTMLButtonElement | null>
  pushMenuAnchorRef: RefObject<HTMLButtonElement | null>
  onOpenBranchMenu: () => void
  onFetch: () => void
  onPull: () => void
  onOpenPullMenu: () => void
  onPush: () => void
  onOpenPushMenu: () => void
  onCopyRemoteUrl: (url: string) => void
  onOpenRemotesMenu: () => void
}

function CountBadge({ count }: { count: number }) {
  return (
    <span
      className={`flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none tabular-nums ${
        count > 0 ? 'bg-accent text-white' : 'border border-border bg-bg-elevated text-fg-dim'
      }`}
    >
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
  ...rest
}: {
  active?: boolean
  className?: string
  children: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`${segmentGroup(active)} ${className}`} {...rest}>
      {children}
    </div>
  )
}

export default function ScmToolbar({
  status,
  projectPath,
  remotes,
  remotesLoading = false,
  loading,
  operationKind,
  disabled,
  branchMenuOpen,
  remotesMenuOpen,
  branchAnchorRef,
  remotesMenuAnchorRef,
  pullMenuAnchorRef,
  pushMenuAnchorRef,
  onOpenBranchMenu,
  onFetch,
  onPull,
  onOpenPullMenu,
  onPush,
  onOpenPushMenu,
  onCopyRemoteUrl,
  onOpenRemotesMenu,
}: ScmToolbarProps) {
  const { t } = useI18n()
  const repoReady = Boolean(status?.is_repository)
  const writeDisabled = disabled || !repoReady
  const behind = status?.behind ?? 0
  const ahead = status?.ahead ?? 0
  const neverLabel = t('从未')
  const primary = primaryRemoteRow(remotes, status?.upstream)
  const remoteRows = remotes ? flattenRemoteRows(remotes, primary?.name ?? null) : []
  const hasMultipleRemotes = remoteRows.length > 1

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

      <SegmentGroup active={operationKind === 'pull'} data-scm-action-segment="pull">
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

      <SegmentGroup active={operationKind === 'push'} data-scm-action-segment="push">
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

      {repoReady && (
        <Tooltip
          label={primary?.url ?? t('GIT 地址')}
          side="bottom"
          onlyWhenOverflow={!primary}
          wrapperClassName="flex min-w-0 max-w-[16rem] shrink"
        >
          <SegmentGroup
            active={remotesMenuOpen}
            className="w-full min-w-0"
            data-scm-action-segment="remotes"
          >
            <button
              type="button"
              aria-label={t('复制 GIT 地址')}
              disabled={!primary || writeDisabled}
              onClick={() => {
                if (primary) onCopyRemoteUrl(primary.url)
              }}
              className="flex h-full min-w-0 flex-1 items-center gap-1 px-1.5 text-left text-[11px] text-fg transition-colors hover:bg-bg-hover/80 disabled:opacity-40"
            >
              {remotesLoading && remotes === null ? (
                <LoaderCircle size={12} className="shrink-0 animate-spin text-accent" />
              ) : (
                <Link size={12} className="shrink-0 text-fg-muted" />
              )}
              <span className="min-w-0 truncate font-mono text-[11px]">
                {primary?.url ?? t('暂无远程地址')}
              </span>
              {primary && <Copy size={11} className="shrink-0 text-fg-dim" />}
            </button>
            {hasMultipleRemotes && (
              <button
                ref={remotesMenuAnchorRef}
                type="button"
                aria-label={t('更多远程地址')}
                aria-haspopup="menu"
                aria-expanded={remotesMenuOpen}
                disabled={writeDisabled}
                onClick={onOpenRemotesMenu}
                className={menuBtn}
              >
                <ChevronDown
                  size={11}
                  className={`transition-transform ${remotesMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>
            )}
          </SegmentGroup>
        </Tooltip>
      )}
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

export type ScmRemotesMenuProps = {
  open: boolean
  style: CSSProperties
  menuRef: RefObject<HTMLDivElement | null>
  rows: ScmRemoteRow[]
  onCopy: (url: string) => void
}

export function ScmRemotesMenu({ open, style, menuRef, rows, onCopy }: ScmRemotesMenuProps) {
  const { t } = useI18n()
  if (!open) return null
  return (
    <div
      ref={menuRef}
      role="menu"
      className="ui-font-scaled fixed z-[100] max-w-[28rem] min-w-[14rem] rounded-md border border-border-strong bg-bg-elevated py-1 shadow-2xl shadow-black/45"
      style={style}
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="px-3 py-1 text-[11px] font-semibold tracking-wide text-fg-muted">
        {t('GIT 地址')}
      </div>
      {rows.map(row => (
        <button
          key={row.key}
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-bg-hover"
          onClick={() => onCopy(row.url)}
        >
          <Copy size={12} className="shrink-0 text-fg-dim" />
          <span className="shrink-0 font-medium">{row.name}</span>
          {row.isCurrent && (
            <span className="shrink-0 rounded px-1 py-px text-[10px] text-accent bg-accent/10">
              {t('当前')}
            </span>
          )}
          {row.kind === 'fetch' && (
            <span className="shrink-0 text-[10px] text-fg-dim">{t('拉取')}</span>
          )}
          {row.kind === 'push' && (
            <span className="shrink-0 text-[10px] text-fg-dim">{t('推送')}</span>
          )}
          <span className="min-w-0 truncate font-mono text-[11px] text-fg-muted">{row.url}</span>
        </button>
      ))}
    </div>
  )
}
