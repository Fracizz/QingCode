import { memo, type CSSProperties, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
} from 'lucide-react'
import type { SearchResultRow as Row } from '../utils/searchHelpers'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

export interface SearchRowProps {
  rows: Row[]
  activeIndex: number
  onToggleFile: (path: string) => void
  onOpenMatch: (path: string, line: number) => void
  onOpenFilename: (path: string, isDir: boolean) => void
}

export function SearchResultRow(props: {
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
  index: number
  style: CSSProperties
} & SearchRowProps) {
  const { t } = useI18n()
  const { index, style, rows, activeIndex, onToggleFile, onOpenMatch, onOpenFilename } = props
  const row = rows[index]
  if (!row) return null
  const active = index === activeIndex
  const baseCls = 'absolute left-0 right-0 flex items-center'
  const activeCls = active ? 'bg-bg-active' : ''

  if (row.kind === 'section') {
    return (
      <div
        style={style}
        className={`${baseCls} px-3 text-[11px] font-semibold tracking-wide text-fg-muted border-b border-border/60`}
      >
        <span className="truncate">{row.label}</span>
      </div>
    )
  }

  if (row.kind === 'file') {
    return (
      <div style={style} className={`${baseCls} ${activeCls} px-3 text-[12px]`}>
        <button
          className="w-full flex items-center gap-1 h-full text-left hover:bg-bg-hover"
          onClick={() => onToggleFile(row.path)}
        >
          {row.collapsed ? (
            <ChevronRight size={13} className="text-fg-dim flex-shrink-0" />
          ) : (
            <ChevronDown size={13} className="text-fg-dim flex-shrink-0" />
          )}
          <FileIcon size={13} className="text-fg-muted flex-shrink-0" />
          <span className="truncate font-medium">{row.name}</span>
          {row.dir && (
            <Tooltip label={row.dir} side="bottom" wrapperClassName="truncate min-w-0 ml-1">
              <span className="text-ui-sm block truncate text-fg-dim">{row.dir}</span>
            </Tooltip>
          )}
          <span className="text-ui-sm ml-auto flex-shrink-0 text-fg-dim">
            {row.matchCount}
          </span>
        </button>
      </div>
    )
  }

  if (row.kind === 'match') {
    return (
      <button
        style={style}
        onClick={() => onOpenMatch(row.path, row.line)}
        className={`${baseCls} ${activeCls} pl-9 pr-3 gap-2 text-[12px] text-left hover:bg-bg-hover`}
      >
        <span className="w-8 flex-shrink-0 text-right text-fg-dim tabular-nums">
          {row.line}
        </span>
        <span className="truncate text-fg-muted">
          <MatchHighlight text={row.text} start={row.matchStart} end={row.matchEnd} />
        </span>
      </button>
    )
  }

  if (row.kind === 'more') {
    return (
      <div style={style} className={`${baseCls} text-ui-sm pl-9 pr-3 text-fg-dim`}>
        {t('…可能还有更多匹配')}
      </div>
    )
  }

  if (row.kind === 'dir') {
    return (
      <div style={style} className={`${baseCls} text-ui-sm px-4 text-fg-dim`}>
        <Tooltip label={row.dir} side="bottom" wrapperClassName="truncate min-w-0 w-full">
          <span className="truncate block">{row.dir}</span>
        </Tooltip>
      </div>
    )
  }

  return (
    <button
      style={style}
      onClick={() => onOpenFilename(row.hit.path, row.hit.is_dir)}
      className={`${baseCls} ${activeCls} pl-6 pr-3 gap-1.5 text-[13px] text-left hover:bg-bg-hover`}
    >
      {row.hit.is_dir ? (
        <Folder size={14} className="text-accent flex-shrink-0" />
      ) : (
        <FileIcon size={14} className="text-fg-muted flex-shrink-0" />
      )}
      <span className="truncate">{row.hit.name}</span>
      <span className="text-ui-sm ml-auto max-w-[40%] truncate text-fg-dim">
        {row.hit.relative}
      </span>
    </button>
  )
}

const MatchHighlight = memo(function MatchHighlight({
  text,
  start,
  end,
}: {
  text: string
  start: number
  end: number
}) {
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-accent/30 text-fg rounded-sm px-0.5">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  )
})

export function SearchToggle({
  active,
  onClick,
  tooltip,
  icon,
  label,
  locked,
}: {
  active: boolean
  onClick: () => void
  tooltip: string
  icon: ReactNode
  label: string
  locked?: boolean
}) {
  const { t } = useI18n()
  const tooltipLabel = locked ? `${tooltip}${t('（已由后缀筛选锁定）')}` : tooltip
  return (
    <Tooltip label={tooltipLabel} side="bottom">
      <button
        onClick={onClick}
        className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border transition-colors
          ${active
            ? 'bg-bg-active text-fg border-border-strong'
            : 'bg-bg-deep text-fg-muted border-border hover:text-fg'}
          ${locked ? 'opacity-60 cursor-default' : ''}`}
      >
        {icon}
        <span>{label}</span>
      </button>
    </Tooltip>
  )
}
