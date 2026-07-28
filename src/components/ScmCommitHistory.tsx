import { useCallback, useEffect, useMemo, type CSSProperties } from 'react'
import { LoaderCircle } from 'lucide-react'
import { List, useListRef } from 'react-window'
import type { GitCommitInfo } from '../lib/git/git'
import { formatAbsoluteCommitTime } from '../lib/git/gitStatus'
import { useI18n } from '../lib/i18n'
import Tooltip from './Tooltip'

export const SCM_COMMIT_PAGE_SIZE = 40

const ROW_HEIGHT = 36
const FOOTER_HEIGHT = 28
const PREFETCH_ROWS = 12
const HASH_COL = 'w-[8ch] shrink-0 pr-2 font-mono text-[11px] tabular-nums text-accent'
const AUTHOR_COL = 'w-[6.5rem] shrink-0 truncate text-[11px] text-fg-muted'
const REFS_COL = 'w-[8rem] shrink-0 truncate text-[10px] text-brand'
const TIME_COL =
  'w-[10.5rem] shrink-0 truncate text-right font-mono text-[10px] tabular-nums text-fg-dim'

type RowProps = {
  commits: GitCommitInfo[]
  selectedHash: string | null
  loadingMore: boolean
  hasMore: boolean
  exhaustedLabel: string
  loadingLabel: string
  noSubjectLabel: string
  onSelect: (hash: string) => void
}

function CommitRow(
  props: {
    ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
    index: number
    style: CSSProperties
  } & RowProps
) {
  const {
    index,
    style,
    commits,
    selectedHash,
    loadingMore,
    hasMore,
    exhaustedLabel,
    loadingLabel,
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
            {loadingLabel}
          </>
        ) : hasMore ? (
          <span className="opacity-0">·</span>
        ) : (
          exhaustedLabel
        )}
      </div>
    )
  }

  const commit = commits[index]
  if (!commit) return null
  return (
    <div style={style} className="flex">
      <button
        type="button"
        onClick={() => onSelect(commit.hash)}
        className={`flex h-full w-full items-center gap-2 pl-5 pr-3 text-left hover:bg-bg-hover ${
          selectedHash === commit.hash ? 'bg-bg-active' : ''
        }`}
      >
        <span className={HASH_COL}>{commit.short_hash}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
          {commit.subject || noSubjectLabel}
        </span>
        <span className={AUTHOR_COL}>
          <Tooltip
            label={commit.author}
            side="bottom"
            onlyWhenOverflow
            wrapperClassName="block min-w-0 truncate"
          >
            <span>{commit.author}</span>
          </Tooltip>
        </span>
        <span className={REFS_COL}>
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
        <span className={TIME_COL}>{formatAbsoluteCommitTime(commit.date)}</span>
      </button>
    </div>
  )
}

export default function ScmCommitHistory({
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
    commits.length > 0 && (hasMore || loadingMore || commits.length >= SCM_COMMIT_PAGE_SIZE)
  const rowCount = commits.length + (showFooter ? 1 : 0)
  const rowProps = useMemo(
    () => ({
      commits,
      selectedHash,
      loadingMore,
      hasMore,
      exhaustedLabel: commits.length >= SCM_COMMIT_PAGE_SIZE ? t('已加载全部提交') : '',
      loadingLabel: t('正在加载更多提交…'),
      noSubjectLabel: t('（无提交说明）'),
      onSelect,
    }),
    [commits, hasMore, loadingMore, onSelect, selectedHash, t]
  )
  const rowHeight = useCallback(
    (index: number) => (index >= commits.length ? FOOTER_HEIGHT : ROW_HEIGHT),
    [commits.length]
  )
  const onRowsRendered = useCallback(
    (
      _visible: { startIndex: number; stopIndex: number },
      all: { startIndex: number; stopIndex: number }
    ) => {
      if (hasMore && commits.length > 0 && all.stopIndex >= commits.length - PREFETCH_ROWS) {
        onNearEnd()
      }
    },
    [commits.length, hasMore, onNearEnd]
  )

  useEffect(() => {
    if (!hasMore || loadingMore || commits.length === 0) return
    const element = listRef.current?.element
    if (element && element.scrollHeight <= element.clientHeight + 8) onNearEnd()
  }, [commits.length, hasMore, loadingMore, listRef, onNearEnd])

  if (commits.length === 0) {
    return <p className="px-3 py-2 text-[11px] text-fg-dim">{t('暂无提交记录')}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex flex-shrink-0 items-center gap-2 border-b border-border/50 bg-bg-sidebar/80 pl-5 pr-3 text-[10px] font-medium tracking-wide text-fg-dim"
        style={{ height: FOOTER_HEIGHT }}
      >
        <span className={HASH_COL}>{t('哈希')}</span>
        <span className="min-w-0 flex-1 truncate">{t('说明')}</span>
        <span className={AUTHOR_COL}>{t('作者')}</span>
        <span className={REFS_COL}>{t('引用')}</span>
        <span className={TIME_COL}>{t('时间')}</span>
      </div>
      <div className="min-h-0 flex-1">
        <List
          listRef={listRef}
          rowCount={rowCount}
          rowHeight={rowHeight}
          rowComponent={CommitRow}
          rowProps={rowProps}
          onRowsRendered={onRowsRendered}
          overscanCount={16}
          className="h-full overscroll-y-contain"
          style={{
            height: '100%',
            overscrollBehavior: 'contain',
            contain: 'strict',
            scrollbarGutter: 'stable',
          }}
        />
      </div>
    </div>
  )
}
