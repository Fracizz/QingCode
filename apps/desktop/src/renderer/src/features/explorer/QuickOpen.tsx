import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { File as FileIcon, Search } from 'lucide-react'
import { ErrorNote, Modal, Spinner } from '../../components/ui'
import { cn } from '../../lib/cn'
import { openFile } from '../workspace/openers'
import { rankNameHits } from './searchModel'
import { baseName, detectPathStyle, relativePath } from './treeModel'
import { useFsSearch } from './useFsSearch'

/** Ctrl+P 式快速打开：防抖按名搜索、结果模糊排序、回车经 openFile 打开。 */
export function QuickOpen({
  targetId,
  root,
  open,
  onClose,
}: {
  targetId: string
  root: string
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  // 关闭时 enabled:false 让 hook 取消在途搜索；hooks 仍无条件调用。
  const search = useFsSearch(targetId, {
    root,
    query,
    mode: 'name',
    debounceMs: 150,
    enabled: open,
    maxResults: 500,
  })
  const style = useMemo(() => detectPathStyle(root), [root])
  const ranked = useMemo(
    () =>
      rankNameHits(query, search.matches, false, 60).map((hit) => ({
        ...hit,
        relative: relativePath(root, hit.path, style),
      })),
    [query, search.matches, root, style],
  )

  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    if (!open) {
      setQuery('')
      setSelected(0)
    }
  }, [open])

  const choose = (path: string): void => {
    openFile({ targetId, path })
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((index) => Math.min(index + 1, Math.max(0, ranked.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const hit = ranked[selected]
      if (hit) choose(hit.path)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  if (!open) return null
  return (
    <Modal
      title="快速打开文件"
      description={root}
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3 text-[12px] text-qn-muted">
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span className="flex items-center gap-2">
            {search.searching && <Spinner label="搜索中…" />}
            {search.truncated && <span className="text-qn-warn">结果已截断</span>}
          </span>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Search size={15} className="shrink-0 text-qn-muted" />
          <input
            autoFocus
            className="qn-input min-w-0 flex-1"
            value={query}
            placeholder="输入文件名，支持模糊匹配"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ErrorNote message={search.error} />
        <div className="qn-scroll max-h-[360px] overflow-y-auto rounded-lg border border-qn-border bg-black/20">
          {ranked.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-qn-muted">
              {query.trim() === ''
                ? '输入文件名开始搜索'
                : search.searching
                  ? '搜索中…'
                  : '未找到匹配文件'}
            </div>
          )}
          {ranked.map((hit, index) => (
            <button
              key={hit.path}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]',
                index === selected ? 'bg-qn-accent/20' : 'hover:bg-white/5',
              )}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(hit.path)}
            >
              <FileIcon size={13} className="shrink-0 text-qn-muted" />
              <span className="shrink-0 truncate font-medium">{baseName(hit.path)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-qn-dim">
                {hit.relative}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
