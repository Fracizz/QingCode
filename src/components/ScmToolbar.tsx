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
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'

type ScmOperationKind = 'fetch' | 'pull' | 'push' | 'switch'

export type ScmToolbarProps = {
  status: GitStatus | null
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

function upstreamCaption(status: GitStatus | null): string {
  const upstream = status?.upstream?.trim()
  if (!upstream) return '--'
  const slash = upstream.indexOf('/')
  return slash >= 0 ? upstream.slice(0, slash) : upstream
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
      className={`flex min-w-0 flex-col rounded-md border border-border bg-bg-deep/70 px-1.5 pb-1 pt-0.5 ${className}`}
    >
      <span className="truncate px-0.5 text-[9px] leading-none text-fg-dim">{caption}</span>
      {children}
    </div>
  )
}

function CountBadge({ count }: { count: number }) {
  return (
    <span
      className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ${
        count > 0 ? 'bg-accent text-white' : 'bg-bg-active text-fg-dim'
      }`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function ScmToolbar({
  status,
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
  const remoteCaption = upstreamCaption(status)
  const behind = status?.behind ?? 0
  const ahead = status?.ahead ?? 0

  return (
    <div className="flex min-h-[52px] flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <ScmChip caption={t('分支')} className="min-w-[7rem] max-w-[11rem] flex-1">
        <button
          ref={branchAnchorRef}
          type="button"
          aria-expanded={branchMenuOpen}
          aria-haspopup="menu"
          aria-label={t('选择分支')}
          disabled={writeDisabled}
          onClick={onOpenBranchMenu}
          className={`flex h-7 w-full min-w-0 items-center gap-1 rounded px-1 text-left transition-colors hover:bg-bg-hover disabled:opacity-40 ${
            branchMenuOpen ? 'bg-bg-active' : ''
          }`}
        >
          <GitBranch size={12} className="shrink-0 text-brand" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
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

      <ScmChip caption={remoteCaption}>
        <Tooltip label={t('从远程获取最新引用（git fetch）')} side="bottom">
          <button
            type="button"
            aria-label={t('检查更新')}
            disabled={writeDisabled}
            onClick={onFetch}
            className="flex h-7 items-center gap-1.5 rounded px-1.5 text-[11px] text-fg transition-colors hover:bg-bg-hover disabled:opacity-40"
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

      <ScmChip caption={remoteCaption} className="min-w-[8.5rem]">
        <div className="flex h-7 items-stretch">
          <Tooltip label={t('从远程拉取')} side="bottom">
            <button
              type="button"
              aria-label={t('更新')}
              disabled={writeDisabled}
              onClick={onPull}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-l px-1.5 text-[11px] text-fg transition-colors hover:bg-bg-hover disabled:opacity-40"
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
            className="flex w-5 shrink-0 items-center justify-center rounded-r text-fg-dim transition-colors hover:bg-bg-hover disabled:opacity-40"
          >
            <ChevronDown size={11} />
          </button>
          <span className="mx-0.5 w-px self-stretch bg-border" aria-hidden />
          <span className="flex items-center px-1">
            <CountBadge count={behind} />
          </span>
        </div>
      </ScmChip>

      <ScmChip caption={remoteCaption} className="min-w-[8.5rem]">
        <div className="flex h-7 items-stretch">
          <Tooltip label={t('推送到远程')} side="bottom">
            <button
              type="button"
              aria-label={t('推送')}
              disabled={writeDisabled}
              onClick={onPush}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-l px-1.5 text-[11px] text-fg transition-colors hover:bg-bg-hover disabled:opacity-40"
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
            className="flex w-5 shrink-0 items-center justify-center rounded-r text-fg-dim transition-colors hover:bg-bg-hover disabled:opacity-40"
          >
            <ChevronDown size={11} />
          </button>
          <span className="mx-0.5 w-px self-stretch bg-border" aria-hidden />
          <span className="flex items-center px-1">
            <CountBadge count={ahead} />
          </span>
        </div>
      </ScmChip>
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
