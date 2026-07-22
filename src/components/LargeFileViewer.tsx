import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Copy, ExternalLink, Eye, LocateFixed, Search } from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { safeInvoke } from '../lib/tauri'
import { formatFileSize } from '../lib/fileSizePolicy'
import { copyToClipboard } from '../utils/fileReferences'
import { useProjectStore } from '../store/projectStore'
import { useUIStore } from '../store/uiStore'
import { useI18n } from '../lib/i18n'
import type { EditorTab } from '../types'

const CHUNK_BYTES = 128 * 1024
/** Max chunks to scan when Find Next continues past the current window. */
const MAX_SEARCH_CHUNKS = 32

/** 行偏移索引：记录文件中每行的起始字节偏移，用于快速定位 */
type LineIndex = {
  offsets: number[] // 每行的字节偏移
  totalLines: number
  fileSize: number
}

type FileSlice = {
  offset: number
  len: number
  text: string
  eof: boolean
  file_size: number
}

type LineOffsetResult = {
  line: number
  offset: number
  found: boolean
  total_lines: number
  file_size: number
}

interface Props {
  tab: EditorTab
}

function findAllMatches(text: string, query: string): number[] {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const positions: number[] = []
  let from = 0
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) break
    positions.push(idx)
    from = idx + Math.max(1, needle.length)
  }
  return positions
}

function renderHighlighted(
  text: string,
  query: string,
  activeIndex: number,
): ReactNode {
  if (!query) return text
  const matches = findAllMatches(text, query)
  if (matches.length === 0) return text
  const nodes: ReactNode[] = []
  let cursor = 0
  matches.forEach((start, i) => {
    if (start > cursor) nodes.push(text.slice(cursor, start))
    const end = start + query.length
    const isActive = i === activeIndex
    nodes.push(
      <mark
        key={`${start}-${i}`}
        data-search-match-index={i}
        className={
          isActive
            ? 'rounded-sm bg-accent/40 text-fg ring-1 ring-accent'
            : 'rounded-sm bg-warn/25 text-fg'
        }
      >
        {text.slice(start, end)}
      </mark>,
    )
    cursor = end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export default function LargeFileViewer({ tab }: Props) {
  const { t } = useI18n()
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const setView = useUIStore(s => s.setView)
  const [text, setText] = useState('')
  const [offset, setOffset] = useState(0)
  const [sliceLen, setSliceLen] = useState(0)
  const [fileSize, setFileSize] = useState(tab.fileSize ?? 0)
  const [eof, setEof] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lineInput, setLineInput] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [statusLine, setStatusLine] = useState<number | null>(null)
  const requestId = useRef(0)
  const preRef = useRef<HTMLPreElement>(null)
  // 行偏移索引缓存，避免重复计算
  const lineIndexRef = useRef<LineIndex | null>(null)

  const loadSlice = useCallback(
    async (nextOffset: number): Promise<FileSlice | null> => {
      const id = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const slice = await safeInvoke<FileSlice>('读取文件片段', 'read_file_slice', {
          path: tab.path,
          offset: nextOffset,
          maxBytes: CHUNK_BYTES,
        })
        if (id !== requestId.current) return null
        setText(slice.text)
        setOffset(slice.offset)
        setSliceLen(slice.len)
        setFileSize(slice.file_size)
        setEof(slice.eof)
        return slice
      } catch (e) {
        if (id !== requestId.current) return null
        setError(e instanceof Error ? e.message : String(e))
        setText('')
        setSliceLen(0)
        return null
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    [tab.path],
  )

  useEffect(() => {
    queueMicrotask(() => void loadSlice(0))
    queueMicrotask(() => {
      setStatusLine(null)
      setSearchQuery('')
      setSearchInput('')
      setActiveMatch(0)
      setLineInput('')
    })
  }, [loadSlice, tab.path])

  const matches = useMemo(
    () => findAllMatches(text, searchQuery),
    [text, searchQuery],
  )

  useEffect(() => {
    if (matches.length === 0) {
      queueMicrotask(() => setActiveMatch(0))
      return
    }
    if (activeMatch >= matches.length) queueMicrotask(() => setActiveMatch(0))
  }, [matches, activeMatch])

  useEffect(() => {
    const el = preRef.current?.querySelector<HTMLElement>(
      `[data-search-match-index="${activeMatch}"]`,
    )
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeMatch, text, searchQuery])

  const windowEnd = Math.min(offset + sliceLen, fileSize)

  const goPrev = () => {
    if (offset <= 0 || loading) return
    setStatusLine(null)
    void loadSlice(Math.max(0, offset - CHUNK_BYTES))
  }

  const goNext = () => {
    if (eof || loading) return
    setStatusLine(null)
    void loadSlice(offset + CHUNK_BYTES)
  }

  const jumpPercent = (pct: number) => {
    if (fileSize <= 0 || loading) return
    const target = Math.min(
      Math.max(0, Math.floor((fileSize * pct) / 100)),
      Math.max(0, fileSize - 1),
    )
    setStatusLine(null)
    void loadSlice(target)
  }

  const jumpToLine = async () => {
    const line = Math.floor(Number(lineInput))
    if (!Number.isFinite(line) || line < 1 || loading) return
    setLoading(true)
    setError(null)
    try {
      const result = await safeInvoke<LineOffsetResult>('定位行偏移', 'find_line_offset', {
        path: tab.path,
        line,
      })
      const targetLine = result.found ? result.line : result.total_lines
      if (!result.found) {
        useProjectStore.getState().pushToast(
          'info',
          t('文件共 {total} 行，已跳到最后一行', { total: result.total_lines }),
        )
      }
      setStatusLine(targetLine > 0 ? targetLine : null)
      await loadSlice(result.offset)
      // Scroll pre to top of the chunk (line starts at window start).
      preRef.current?.scrollTo({ top: 0 })
    } catch (e) {
      useProjectStore
        .getState()
        .pushToast('error', t('跳转到行失败: {error}', { error: String(e) }))
      setLoading(false)
    }
  }

  const applySearch = (query: string) => {
    setSearchQuery(query)
    setActiveMatch(0)
  }

  /** 构建行偏移索引：扫描整个文件建立每行的字节偏移 */
  const buildLineIndex = useCallback(async (): Promise<LineIndex | null> => {
    if (lineIndexRef.current && lineIndexRef.current.fileSize === fileSize) {
      return lineIndexRef.current
    }
    try {
      const offsets: number[] = [0]
      let cursorOffset = 0
      let currentEof = false
      while (!currentEof && offsets.length < 10_000_000) {
        const slice = await safeInvoke<FileSlice>('读取文件片段', 'read_file_slice', {
          path: tab.path,
          offset: cursorOffset,
          maxBytes: CHUNK_BYTES,
        })
        if (!slice) break
        // 统计当前块中的换行符，建立行偏移
        for (let i = 0; i < slice.text.length; i++) {
          if (slice.text.charCodeAt(i) === 10) { // '\n'
            offsets.push(slice.offset + i + 1)
          }
        }
        currentEof = slice.eof
        cursorOffset = slice.offset + slice.len
        if (cursorOffset >= fileSize) break
      }
      const index: LineIndex = { offsets, totalLines: offsets.length, fileSize }
      lineIndexRef.current = index
      return index
    } catch {
      return null
    }
  }, [tab.path, fileSize])

  const findInDirection = async (direction: 1 | -1) => {
    const query = searchInput.trim()
    if (!query || loading) return

    // Ensure query is applied to current chunk first.
    if (query !== searchQuery) {
      applySearch(query)
      const local = findAllMatches(text, query)
      if (local.length > 0) {
        setActiveMatch(direction === 1 ? 0 : local.length - 1)
        return
      }
    } else if (matches.length > 0) {
      const next = activeMatch + direction
      if (next >= 0 && next < matches.length) {
        setActiveMatch(next)
        return
      }
    }

    // 优先使用行偏移索引进行搜索（如果文件不太大）
    if (fileSize > 0 && fileSize <= 50 * 1024 * 1024) {
      const index = await buildLineIndex()
      if (index && index.offsets.length > 0) {
        // 基于行索引进行搜索：逐行检查
        const startLine = Math.floor(offset / CHUNK_BYTES) * (CHUNK_BYTES / 80) // 估算
        const linesToCheck = direction === 1
          ? index.offsets.slice(startLine)
          : index.offsets.slice(0, startLine).reverse()
        for (let i = 0; i < Math.min(linesToCheck.length, MAX_SEARCH_CHUNKS * 100); i++) {
          const lineOffset = linesToCheck[i]
          const slice = await safeInvoke<FileSlice>('读取文件片段', 'read_file_slice', {
            path: tab.path,
            offset: lineOffset,
            maxBytes: CHUNK_BYTES,
          })
          if (!slice) break
          const found = findAllMatches(slice.text, query)
          if (found.length > 0) {
            applySearch(query)
            setActiveMatch(direction === 1 ? 0 : found.length - 1)
            setStatusLine(null)
            await loadSlice(slice.offset)
            return
          }
        }
        useProjectStore.getState().pushToast('info', t('未找到匹配项'))
        return
      }
    }

    // Fallback: 逐块扫描（原有逻辑）
    let cursorOffset = offset
    let cursorEof = eof
    for (let i = 0; i < MAX_SEARCH_CHUNKS; i++) {
      if (direction === 1) {
        if (cursorEof) break
        cursorOffset = cursorOffset + CHUNK_BYTES
      } else {
        if (cursorOffset <= 0) break
        cursorOffset = Math.max(0, cursorOffset - CHUNK_BYTES)
      }
      const slice = await loadSlice(cursorOffset)
      if (!slice) return
      cursorEof = slice.eof
      cursorOffset = slice.offset
      const found = findAllMatches(slice.text, query)
      if (found.length > 0) {
        applySearch(query)
        setActiveMatch(direction === 1 ? 0 : found.length - 1)
        setStatusLine(null)
        return
      }
    }
    useProjectStore.getState().pushToast('info', t('未找到匹配项'))
  }

  const copyPath = async () => {
    try {
      await copyToClipboard(tab.path)
      useProjectStore.getState().pushToast('success', t('路径已复制'))
    } catch (error) {
      useProjectStore
        .getState()
        .pushToast('error', t('复制路径失败: {error}', { error: String(error) }))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-[11px] text-fg-muted">
        <Eye size={12} className="text-accent flex-shrink-0" aria-hidden />
        <span className="truncate">
          {t('只读预览')} · {formatFileSize(fileSize || tab.fileSize || 0)} ·{' '}
          {t('超过 100MB 的文件仅只读分块预览，不可编辑')}
          {statusLine != null ? ` · ${t('第 {line} 行', { line: statusLine })}` : ''}
        </span>
        <span className="ml-auto flex-shrink-0 font-mono text-fg-dim">
          {fileSize > 0
            ? `${formatFileSize(offset)} – ${formatFileSize(Math.max(windowEnd, offset))} / ${formatFileSize(fileSize)}`
            : '…'}
        </span>
      </div>

      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          disabled={loading || offset <= 0}
          onClick={goPrev}
        >
          {t('上一块')}
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          disabled={loading || eof}
          onClick={goNext}
        >
          {t('下一块')}
        </button>
        <div className="mx-1 h-3 w-px bg-border" />
        {[0, 25, 50, 75, 100].map(pct => (
          <button
            key={pct}
            type="button"
            className="rounded px-1.5 py-0.5 font-mono text-[11px] text-fg-dim hover:bg-bg-hover hover:text-fg disabled:opacity-40"
            disabled={loading || fileSize <= 0}
            onClick={() => jumpPercent(pct === 100 ? 99 : pct)}
          >
            {pct}%
          </button>
        ))}
        <div className="mx-1 h-3 w-px bg-border" />
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          <span className="flex-shrink-0">{t('行号')}</span>
          <input
            type="number"
            min={1}
            className="w-20 rounded border border-border bg-bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
            value={lineInput}
            disabled={loading}
            onChange={e => setLineInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void jumpToLine()
              }
            }}
            placeholder="1"
          />
        </label>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          disabled={loading || !lineInput.trim()}
          onClick={() => void jumpToLine()}
        >
          {t('跳转')}
        </button>
        <div className="mx-1 h-3 w-px bg-border" />
        <label className="flex min-w-0 items-center gap-1 text-[11px] text-fg-muted">
          <Search size={12} className="flex-shrink-0 text-fg-dim" aria-hidden />
          <input
            type="search"
            className="w-36 min-w-0 rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-[11px] text-fg outline-none focus:border-accent"
            value={searchInput}
            disabled={loading}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void findInDirection(e.shiftKey ? -1 : 1)
              }
            }}
            placeholder={t('在当前块中搜索')}
          />
        </label>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          disabled={loading || !searchInput.trim()}
          onClick={() => void findInDirection(1)}
        >
          {t('查找下一个')}
        </button>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          disabled={loading || !searchInput.trim()}
          onClick={() => void findInDirection(-1)}
        >
          {t('查找上一个')}
        </button>
        {searchQuery && matches.length > 0 && (
          <span className="text-ui-sm font-mono text-fg-dim">
            {activeMatch + 1}/{matches.length}
          </span>
        )}
        <div className="text-ui-sm ml-auto flex items-center gap-3">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() => {
              setView('explorer')
              void revealFileInTree(tab.path, { force: true })
            }}
          >
            <LocateFixed size={12} />
            {t('在资源管理器中定位')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() =>
              void revealItemInDir(tab.path).catch(error => {
                useProjectStore
                  .getState()
                  .pushToast(
                    'error',
                    t('在文件管理器中显示失败: {error}', { error: String(error) }),
                  )
              })
            }
          >
            <ExternalLink size={12} />
            {t('在文件管理器中显示')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() => void copyPath()}
          >
            <Copy size={12} />
            {t('复制路径')}
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="text-ui-sm pointer-events-none absolute right-3 top-2 text-fg-dim">
            {t('加载中…')}
          </div>
        )}
        {error ? (
          <div className="p-6 text-sm text-warn">{error}</div>
        ) : (
          <pre
            ref={preRef}
            className="m-0 whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-5 text-fg"
          >
            {text
              ? renderHighlighted(text, searchQuery, activeMatch)
              : loading
                ? ''
                : t('（空）')}
          </pre>
        )}
      </div>
    </div>
  )
}
