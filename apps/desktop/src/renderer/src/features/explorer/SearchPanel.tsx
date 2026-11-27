import { useMemo, useState } from 'react'
import { FeedbackRow } from '../../components/FeedbackRow'
import { SearchField } from '../../components/SearchField'
import { Checkbox, EmptyState, ErrorNote, Spinner } from '../../components/ui'
import { cn } from '../../lib/cn'
import { openFile } from '../workspace/openers'
import { groupContentMatches, highlightParts } from './searchModel'
import { detectPathStyle, relativePath } from './treeModel'
import { useFsSearch } from './useFsSearch'

const MAX_RESULTS = 500

/** 内容搜索：大小写开关 + glob 过滤，结果按文件分组并高亮命中片段。 */
export function SearchPanel({
  targetId,
  root,
  className,
}: {
  targetId: string
  root: string
  className?: string
}) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [glob, setGlob] = useState('')
  const search = useFsSearch(targetId, {
    root,
    query,
    mode: 'content',
    caseSensitive,
    glob,
    debounceMs: 200,
    maxResults: MAX_RESULTS,
  })
  const style = useMemo(() => detectPathStyle(root), [root])
  const groups = useMemo(() => groupContentMatches(search.matches), [search.matches])
  const truncated = search.truncated || (search.done && search.matches.length >= MAX_RESULTS)

  return (
    <div className={cn('flex min-h-0 flex-col bg-qn-sidebar text-qn-text', className)}>
      <div className="shrink-0 space-y-2 border-b border-qn-border px-3 py-2">
        <div className="flex items-center gap-2">
          <SearchField
            boxed
            className="flex-1"
            label="搜索文件内容"
            value={query}
            placeholder="搜索文件内容"
            onChange={(event) => setQuery(event.target.value)}
          />
          {search.searching && <Spinner label="搜索中…" />}
        </div>
        <div className="flex items-center gap-3">
          <Checkbox checked={caseSensitive} onChange={setCaseSensitive}>
            区分大小写
          </Checkbox>
          <input
            className="qn-input min-w-0 flex-1 font-mono text-ui-sm"
            value={glob}
            placeholder="glob 过滤，如 *.ts 或 src/**"
            onChange={(event) => setGlob(event.target.value)}
          />
        </div>
      </div>
      <ErrorNote message={search.error} />
      <FeedbackRow
        message={truncated ? '结果已截断，请缩小查询范围或使用 glob 过滤' : null}
        className="border-b border-qn-warn/30 bg-qn-warn/10 px-3 py-1.5 text-ui-sm leading-5 text-qn-warn"
      />
      <div className="qn-scroll min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 && (
          <EmptyState>
            {query.trim() === ''
              ? '输入关键字搜索项目内容'
              : search.searching
                ? '搜索中…'
                : search.done
                  ? '没有匹配结果'
                  : '准备搜索…'}
          </EmptyState>
        )}
        {groups.map((group) => (
          <div key={group.path} className="border-b border-qn-border/60 py-1">
            <div
              className="flex items-center gap-2 px-3 py-1 text-ui-sm font-medium text-qn-text"
              title={group.path}
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {relativePath(root, group.path, style) || group.path}
              </span>
              <span className="shrink-0 text-ui-xs text-qn-dim">{group.hits.length}</span>
            </div>
            {group.hits.map((hit, index) => (
              <button
                key={`${hit.path}:${hit.line ?? 0}:${hit.column ?? 0}:${index}`}
                type="button"
                className="flex w-full items-start gap-2 px-3 py-0.5 text-left text-ui-sm hover:bg-qn-fg/5"
                onClick={() =>
                  openFile({
                    targetId,
                    path: hit.path,
                    line: hit.line,
                    column: hit.column,
                  })
                }
              >
                <span className="w-12 shrink-0 truncate font-mono text-ui-xs text-qn-dim">
                  {hit.line ?? '-'}
                  {hit.column ? `:${hit.column}` : ''}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-ui-xs leading-5">
                  {highlightParts(hit.text ?? '', query, caseSensitive).map((part, partIndex) => (
                    <span
                      key={partIndex}
                      className={part.hit ? 'rounded-sm bg-qn-warn/30 text-qn-warn' : undefined}
                    >
                      {part.text}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
