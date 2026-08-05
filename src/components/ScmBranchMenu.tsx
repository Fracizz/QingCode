import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { Check, LoaderCircle, Search } from 'lucide-react'
import { List, type RowComponentProps } from 'react-window'
import type { GitBranchList } from '@/lib/git/git'
import {
  BRANCH_MENU_VIRTUALIZE_THRESHOLD,
  branchMenuRowHeight,
  buildBranchMenuRows,
  selectableBranchMenuRows,
  type BranchMenuRow,
} from '../lib/git/branchMenu'
import { deferToNativeContextMenuInDev } from '../lib/devBuild'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

function BranchMenuLabel({
  name,
  className = 'block truncate font-mono text-[12px] leading-tight',
}: {
  name: string
  className?: string
}) {
  return (
    <Tooltip label={name} side="right" onlyWhenOverflow wrapperClassName="min-w-0 max-w-full">
      <span className={className}>{name}</span>
    </Tooltip>
  )
}

type BranchRowProps = {
  rows: BranchMenuRow[]
  activeBranch: string | null
  disabled: boolean
  onSwitch: (branch: string) => void
  onHover: (branch: string) => void
}

function BranchMenuRowView({
  index,
  style,
  rows,
  activeBranch,
  disabled,
  onSwitch,
  onHover,
}: RowComponentProps<BranchRowProps>) {
  const row = rows[index]
  if (!row) return null

  if (row.type === 'header') {
    return (
      <div
        style={style}
        className="flex items-center justify-between px-3 py-1 text-[11px] font-semibold tracking-wide text-fg-muted"
      >
        <span>{row.label}</span>
        <span className="font-normal tabular-nums text-fg-dim">{row.count}</span>
      </div>
    )
  }

  if (row.type === 'empty') {
    return (
      <div style={style} className="flex items-center px-3 text-[12px] text-fg-dim">
        {row.label}
      </div>
    )
  }

  if (row.type === 'remote') {
    const active = activeBranch === row.name
    return (
      <div style={style} className="flex">
        <button
          type="button"
          role="menuitem"
          data-branch-name={row.name}
          disabled={disabled}
          onMouseEnter={() => onHover(row.name)}
          onClick={() => onSwitch(row.name)}
          className={`flex w-full items-start gap-2 px-3 py-1.5 text-left ${
            active
              ? 'bg-accent/15 text-fg'
              : 'text-fg hover:bg-bg-hover disabled:opacity-40'
          }`}
        >
          <span className="inline-flex w-3.5 shrink-0" />
          <BranchMenuLabel name={row.name} />
        </button>
      </div>
    )
  }

  const branch = row.branch
  const active = activeBranch === branch.name
  return (
    <div style={style} className="flex">
      <button
        type="button"
        role="menuitem"
        data-branch-name={branch.name}
        disabled={branch.current || disabled}
        onMouseEnter={() => onHover(branch.name)}
        onClick={() => onSwitch(branch.name)}
        className={`flex w-full items-start gap-2 px-3 py-2 text-left ${
          branch.current
            ? 'bg-bg-active text-fg'
            : active
              ? 'bg-accent/15 text-fg'
              : 'text-fg hover:bg-bg-hover disabled:opacity-40'
        }`}
      >
        <span className="mt-0.5 inline-flex w-3.5 shrink-0 justify-center">
          {branch.current ? <Check size={12} className="text-brand" /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <BranchMenuLabel name={branch.name} />
          {branch.upstream && (
            <BranchMenuLabel
              name={branch.upstream}
              className="mt-0.5 block truncate font-mono text-[10px] leading-tight text-fg-dim"
            />
          )}
        </div>
      </button>
    </div>
  )
}

function BranchMenuScrollRows({
  rows,
  activeBranch,
  disabled,
  onSwitch,
  onHover,
}: BranchRowProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-y-contain">
      {rows.map((row, index) => (
        <BranchMenuRowView
          key={row.key}
          index={index}
          style={{}}
          rows={rows}
          activeBranch={activeBranch}
          disabled={disabled}
          onSwitch={onSwitch}
          onHover={onHover}
          ariaAttributes={{
            'aria-posinset': index + 1,
            'aria-setsize': rows.length,
            role: 'listitem',
          }}
        />
      ))}
    </div>
  )
}

function BranchMenuVirtualRows({
  rows,
  activeBranch,
  disabled,
  onSwitch,
  onHover,
}: BranchRowProps) {
  const rowHeight = useCallback(
    (index: number) => branchMenuRowHeight(rows[index]),
    [rows]
  )
  const rowProps = useMemo(
    () => ({
      rows,
      activeBranch,
      disabled,
      onSwitch,
      onHover,
    }),
    [activeBranch, disabled, onHover, onSwitch, rows]
  )

  return (
    <div className="min-h-0 flex-1">
      <List
        rowCount={rows.length}
        rowHeight={rowHeight}
        rowComponent={BranchMenuRowView}
        rowProps={rowProps}
        overscanCount={12}
        className="h-full overscroll-y-contain"
        style={{
          height: '100%',
          overscrollBehavior: 'contain',
          contain: 'strict',
          scrollbarGutter: 'stable',
        }}
      />
    </div>
  )
}

export default function ScmBranchMenu({
  menuRef,
  style,
  branchList,
  loading,
  disabled,
  onSwitch,
}: {
  menuRef: RefObject<HTMLDivElement | null>
  style: CSSProperties
  branchList: GitBranchList | null
  loading: boolean
  disabled: boolean
  onSwitch: (branch: string) => void
}) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [activeBranch, setActiveBranch] = useState<string | null>(null)

  const labels = useMemo(
    () => ({
      local: t('本地分支'),
      remote: t('远程分支'),
      noLocal: t('暂无本地分支'),
      noMatch: t('没有匹配的分支'),
      loading: t('正在读取分支…'),
    }),
    [t]
  )

  const rows = useMemo(
    () => buildBranchMenuRows(branchList, filter, labels),
    [branchList, filter, labels]
  )
  const selectable = useMemo(() => selectableBranchMenuRows(rows), [rows])
  const virtualize = rows.length >= BRANCH_MENU_VIRTUALIZE_THRESHOLD

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    queueMicrotask(() => {
      setActiveBranch(selectable[0] ?? null)
    })
  }, [filter, selectable])

  const moveActive = useCallback(
    (delta: number) => {
      if (selectable.length === 0) {
        setActiveBranch(null)
        return
      }
      const currentIndex = activeBranch ? selectable.indexOf(activeBranch) : -1
      const nextIndex =
        currentIndex < 0
          ? 0
          : (currentIndex + delta + selectable.length) % selectable.length
      setActiveBranch(selectable[nextIndex] ?? null)
    },
    [activeBranch, selectable]
  )

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveActive(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveActive(-1)
    } else if (event.key === 'Enter' && activeBranch && !disabled) {
      event.preventDefault()
      onSwitch(activeBranch)
    }
  }

  useLayoutEffect(() => {
    if (!activeBranch || !menuRef.current) return
    menuRef.current
      .querySelector<HTMLElement>(`[data-branch-name="${CSS.escape(activeBranch)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeBranch, menuRef, rows])

  return (
    <div
      ref={menuRef}
      role="menu"
      className="ui-font-scaled fixed z-[100] flex max-h-[70vh] flex-col rounded-md border border-border-strong bg-bg-elevated shadow-2xl shadow-black/45"
      style={style}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => {
        if (!deferToNativeContextMenuInDev()) event.preventDefault()
      }}
    >
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-2 rounded border border-border bg-bg/60 px-2 py-1">
          <Search size={13} className="shrink-0 text-fg-dim" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={filter}
            onChange={event => setFilter(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('筛选分支…')}
            aria-label={t('筛选分支')}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-dim"
          />
          {loading && (
            <LoaderCircle size={12} className="shrink-0 animate-spin text-fg-dim" aria-hidden />
          )}
        </div>
      </div>

      {virtualize ? (
        <BranchMenuVirtualRows
          rows={rows}
          activeBranch={activeBranch}
          disabled={disabled}
          onSwitch={onSwitch}
          onHover={setActiveBranch}
        />
      ) : (
        <BranchMenuScrollRows
          rows={rows}
          activeBranch={activeBranch}
          disabled={disabled}
          onSwitch={onSwitch}
          onHover={setActiveBranch}
        />
      )}
    </div>
  )
}
