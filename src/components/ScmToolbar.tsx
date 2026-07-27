import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react'
import type { RefObject, ReactNode, CSSProperties } from 'react'
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

function ScmChip({
  caption,
  children,
  className = '',
}: {
  caption: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`flex shrink-0 flex-col gap-1 rounded-md border border-border bg-bg-deep/70 px-2 pb-1.5 pt-1.5 ${className}`}
    >
      <span className="truncate text-[10px] leading-[1.25] text-fg-dim">{caption}</span>
      {children}
    </div>
  )
}

function CountBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}

function actionBtn(active = false) {
  return `flex items-center gap-1 rounded text-[11px] text-fg transition-colors hover:bg-bg-hover disabled:opacity-40 ${
    active ? 'bg-bg-active' : ''
  }`
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

  const fetchCaption = formatRelativeTime(
    resolveGitSyncTimestamp(projectPath, 'fetch', status?.last_fetch_at),
    t,
  )
  const pullCaption = formatRelativeTime(
    resolveGitSyncTimestamp(projectPath, 'pull', status?.last_pull_at),
    t,
  )
  const pushCaption = formatRelativeTime(
    resolveGitSyncTimestamp(projectPath, 'push', status?.last_push_at),
    t,
  )

  return (
    <div className="shrink-0 overflow-x-auto overflow-y-visible border-b border-border px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-w-max items-center gap-1.5">
        <ScmChip caption={t('分支')} className="max-w-[9rem]">
          <button
            ref={branchAnchorRef}
            type="button"
            aria-expanded={branchMenuOpen}
            aria-haspopup="menu"
            aria-label={t('选择分支')}
            disabled={writeDisabled}
            onClick={onOpenBranchMenu}
            className={`${actionBtn(branchMenuOpen)} h-7 max-w-full px-1`}
          >
            <GitBranch size={12} className="shrink-0 text-brand" />
            <span className="min-w-0 truncate font-mono">
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
        </ScmChip>

        <ScmChip caption={fetchCaption}>
          <Tooltip label={t('从远程获取最新引用（git fetch）')} side="bottom">
            <button
              type="button"
              aria-label={t('检查更新')}
              disabled={writeDisabled}
              onClick={onFetch}
              className={`${actionBtn()} h-7 px-1.5`}
            >
              {operationKind === 'fetch' || loading ? (
                <LoaderCircle size={12} className="animate-spin text-accent" />
              ) : (
                <RefreshCw size={12} className="text-fg-muted" />
              )}
              <span className="whitespace-nowrap">{t('检查更新')}</span>
            </button>
          </Tooltip>
        </ScmChip>

        <ScmChip caption={pullCaption}>
          <div className="flex h-7 items-center gap-0.5">
            <Tooltip label={t('从远程拉取')} side="bottom">
              <button
                type="button"
                aria-label={t('更新')}
                disabled={writeDisabled}
                onClick={onPull}
                className={`${actionBtn()} h-7 rounded-l px-1.5`}
              >
                {operationKind === 'pull' ? (
                  <LoaderCircle size={12} className="animate-spin text-accent" />
                ) : (
                  <ArrowDown size={12} className="text-fg-muted" />
                )}
                <span className="whitespace-nowrap">{t('更新')}</span>
              </button>
            </Tooltip>
            <button
              ref={pullMenuAnchorRef}
              type="button"
              aria-label={t('更多拉取选项')}
              aria-haspopup="menu"
              disabled={writeDisabled}
              onClick={onOpenPullMenu}
              className="flex h-7 w-5 shrink-0 items-center justify-center rounded-r text-fg-dim transition-colors hover:bg-bg-hover disabled:opacity-40"
            >
              <ChevronDown size={11} />
            </button>
            {behind > 0 && (
              <>
                <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
                <CountBadge count={behind} />
              </>
            )}
          </div>
        </ScmChip>

        <ScmChip caption={pushCaption}>
          <div className="flex h-7 items-center gap-0.5">
            <Tooltip label={t('推送到远程')} side="bottom">
              <button
                type="button"
                aria-label={t('推送')}
                disabled={writeDisabled}
                onClick={onPush}
                className={`${actionBtn()} h-7 rounded-l px-1.5`}
              >
                {operationKind === 'push' ? (
                  <LoaderCircle size={12} className="animate-spin text-accent" />
                ) : (
                  <ArrowUp size={12} className="text-fg-muted" />
                )}
                <span className="whitespace-nowrap">{t('推送')}</span>
              </button>
            </Tooltip>
            <button
              ref={pushMenuAnchorRef}
              type="button"
              aria-label={t('更多推送选项')}
              aria-haspopup="menu"
              disabled={writeDisabled}
              onClick={onOpenPushMenu}
              className="flex h-7 w-5 shrink-0 items-center justify-center rounded-r text-fg-dim transition-colors hover:bg-bg-hover disabled:opacity-40"
            >
              <ChevronDown size={11} />
            </button>
            {ahead > 0 && (
              <>
                <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
                <CountBadge count={ahead} />
              </>
            )}
          </div>
        </ScmChip>
      </div>
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
