import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import {
  Search,
  File as FileIcon,
  Folder,
  CaseSensitive,
  Type,
  Regex,
  X,
  ChevronDown,
  ChevronRight,
  Filter,
  LoaderCircle,
  ChevronDown as Caret,
} from 'lucide-react'
import { List, useListRef } from 'react-window'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'

interface SearchHit {
  name: string
  path: string
  relative: string
  is_dir: boolean
}

interface ContentSearchMatch {
  line: number
  text: string
  match_start: number
  match_end: number
}

interface ContentSearchFileResult {
  name: string
  path: string
  relative: string
  matches: ContentSearchMatch[]
}

interface ContentSearchResponse {
  files: ContentSearchFileResult[]
  match_count: number
  files_scanned: number
  truncated: boolean
}

type SearchMode = 'filename' | 'content'

const COMMON_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'vue', 'svelte', 'astro',
  'json', 'jsonc', 'html', 'css', 'scss', 'less',
  'md', 'mdx', 'yaml', 'yml', 'toml', 'xml', 'sql',
  'rs', 'py', 'go', 'java', 'kt', 'c', 'cpp', 'h', 'cs',
  'php', 'rb', 'swift', 'sh', 'ps1', 'bat', 'env',
]

const CONTENT_DEBOUNCE_MS = 400
const FILENAME_DEBOUNCE_MS = 200
const MAX_MATCHES_PER_FILE = 20

type Row =
  | { kind: 'file'; path: string; name: string; dir: string; matchCount: number; collapsed: boolean }
  | { kind: 'match'; path: string; line: number; text: string; matchStart: number; matchEnd: number }
  | { kind: 'more'; path: string }
  | { kind: 'dir'; dir: string }
  | { kind: 'fn'; hit: SearchHit }

function rowHeightOf(row: Row): number {
  switch (row.kind) {
    case 'file': return 24
    case 'match': return 22
    case 'more': return 18
    case 'dir': return 20
    case 'fn': return 22
  }
}

function dirOf(relative: string): string {
  const sep = relative.includes('\\') ? '\\' : '/'
  const parts = relative.split(sep).filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join(sep)
}

function isNavigable(row: Row): boolean {
  return row.kind === 'file' || row.kind === 'match' || row.kind === 'fn'
}

export default function SearchPanel() {
  const currentProject = useProjectStore(s => s.currentProject)
  const openFile = useEditorStore(s => s.openFile)
  const searchRoot = useUIStore(s => s.searchRoot)
  const setSearchRoot = useUIStore(s => s.setSearchRoot)

  const effectiveRoot = searchRoot ?? currentProject?.path ?? null

  const [mode, setMode] = useState<SearchMode>('content')
  const [query, setQuery] = useState('')
  const [ignoreCase, setIgnoreCase] = useState(true)
  const [fuzzy, setFuzzy] = useState(false)
  const [matchSuffix, setMatchSuffix] = useState(false)
  const [activeExt, setActiveExt] = useState<string | null>(null)
  const [extPickerOpen, setExtPickerOpen] = useState(false)
  const [filenameResults, setFilenameResults] = useState<SearchHit[]>([])
  const [contentResults, setContentResults] = useState<ContentSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const reqId = useRef(0)
  const listRef = useListRef(null)

  useEffect(() => {
    if (activeExt !== null) setMatchSuffix(true)
  }, [activeExt])

  useEffect(() => {
    setCollapsedFiles(new Set())
  }, [query, mode, activeExt])

  useEffect(() => {
    if (!extPickerOpen) return
    const onDoc = () => setExtPickerOpen(false)
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [extPickerOpen])

  useEffect(() => {
    if (!effectiveRoot) {
      setFilenameResults([])
      setContentResults(null)
      return
    }
    if (mode === 'content') {
      if (!query.trim()) {
        setContentResults(null)
        setError(null)
        return
      }
    } else if (!query.trim() && activeExt === null) {
      setFilenameResults([])
      setContentResults(null)
      setError(null)
      return
    }
    if (!isTauri()) {
      setError(new NotInTauriError('文件搜索').message)
      setFilenameResults([])
      setContentResults(null)
      return
    }

    const id = ++reqId.current
    setLoading(true)
    const debounce = mode === 'content' ? CONTENT_DEBOUNCE_MS : FILENAME_DEBOUNCE_MS

    const handle = setTimeout(async () => {
      try {
        const q = query.trim()
        if (mode === 'content') {
          if (!q) {
            if (id === reqId.current) {
              setContentResults(null)
              setError(null)
              setLoading(false)
            }
            return
          }
          const resp = await safeInvoke<ContentSearchResponse>('内容搜索', 'search_file_contents', {
            root: effectiveRoot,
            query: q,
            ignoreCase,
            extension: activeExt,
            maxMatches: 500,
            maxFilesScanned: 8000,
            maxMatchesPerFile: 20,
          })
          if (id === reqId.current) {
            setContentResults(resp)
            setFilenameResults([])
            setError(null)
          }
        } else {
          const effectiveQuery = q || (activeExt ?? '')
          const useSuffix = matchSuffix || activeExt !== null
          const hits = await safeInvoke<SearchHit[]>('文件搜索', 'search_files', {
            root: effectiveRoot,
            query: effectiveQuery,
            ignoreCase,
            fuzzy: fuzzy && !useSuffix,
            matchSuffix: useSuffix,
            limit: 500,
          })
          if (id === reqId.current) {
            setFilenameResults(hits)
            setContentResults(null)
            setError(null)
          }
        }
      } catch (e) {
        if (id === reqId.current) {
          setError(String(e))
          setFilenameResults([])
          setContentResults(null)
        }
      } finally {
        if (id === reqId.current) setLoading(false)
      }
    }, debounce)

    return () => clearTimeout(handle)
  }, [effectiveRoot, query, ignoreCase, fuzzy, matchSuffix, activeExt, mode])

  const toggleSuffix = () => {
    if (mode === 'content') return
    if (!matchSuffix && activeExt !== null) return
    setMatchSuffix(v => !v)
  }

  const rows = useMemo<Row[]>(() => {
    if (mode === 'content') {
      if (!contentResults || contentResults.match_count === 0) return []
      const out: Row[] = []
      for (const file of contentResults.files) {
        const collapsed = collapsedFiles.has(file.path)
        out.push({
          kind: 'file',
          path: file.path,
          name: file.name,
          dir: dirOf(file.relative),
          matchCount: file.matches.length,
          collapsed,
        })
        if (!collapsed) {
          for (const m of file.matches) {
            out.push({
              kind: 'match',
              path: file.path,
              line: m.line,
              text: m.text,
              matchStart: m.match_start,
              matchEnd: m.match_end,
            })
          }
          if (file.matches.length >= MAX_MATCHES_PER_FILE) {
            out.push({ kind: 'more', path: file.path })
          }
        }
      }
      return out
    }
    // filename mode
    const groups = new Map<string, SearchHit[]>()
    for (const h of filenameResults) {
      const sep = h.relative.includes('\\') ? '\\' : '/'
      const parts = h.relative.split(sep)
      const dir = parts.length > 1 ? parts.slice(0, -1).join(sep) : '(root)'
      const arr = groups.get(dir) ?? []
      arr.push(h)
      groups.set(dir, arr)
    }
    const out: Row[] = []
    for (const [dir, items] of groups) {
      out.push({ kind: 'dir', dir })
      for (const h of items) out.push({ kind: 'fn', hit: h })
    }
    return out
  }, [mode, contentResults, filenameResults, collapsedFiles])

  const navigableIndexes = useMemo(() => {
    const arr: number[] = []
    rows.forEach((r, i) => {
      if (isNavigable(r)) arr.push(i)
    })
    return arr
  }, [rows])

  useEffect(() => {
    setActiveIndex(navigableIndexes[0] ?? 0)
  }, [navigableIndexes])

  const toggleFileCollapse = useCallback((path: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expandAll = useCallback(() => setCollapsedFiles(new Set()), [])
  const collapseAll = useCallback(() => {
    if (mode === 'content' && contentResults) {
      setCollapsedFiles(new Set(contentResults.files.map(f => f.path)))
    }
  }, [mode, contentResults])

  const onOpenMatch = useCallback(
    (path: string, line: number) => {
      void openFile(path, line)
    },
    [openFile]
  )

  const onOpenFilename = useCallback(
    (path: string, isDir: boolean) => {
      if (!isDir) void openFile(path)
    },
    [openFile]
  )

  const onResultsKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (navigableIndexes.length === 0) return
      const curPos = navigableIndexes.indexOf(activeIndex)
      const moveBy = (delta: number) => {
        e.preventDefault()
        const base = curPos === -1 ? 0 : curPos
        const next = Math.min(navigableIndexes.length - 1, Math.max(0, base + delta))
        const idx = navigableIndexes[next]
        setActiveIndex(idx)
        listRef.current?.scrollToRow({ index: idx, align: 'center', behavior: 'auto' })
      }
      if (e.key === 'ArrowDown') return moveBy(1)
      if (e.key === 'ArrowUp') return moveBy(-1)
      if (e.key === 'Enter') {
        e.preventDefault()
        const row = rows[activeIndex]
        if (!row) return
        if (row.kind === 'match') onOpenMatch(row.path, row.line)
        else if (row.kind === 'fn') onOpenFilename(row.hit.path, row.hit.is_dir)
        else if (row.kind === 'file') toggleFileCollapse(row.path)
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const row = rows[activeIndex]
        if (row?.kind === 'file') {
          e.preventDefault()
          const collapsed = collapsedFiles.has(row.path)
          if (e.key === 'ArrowRight' && collapsed) toggleFileCollapse(row.path)
          else if (e.key === 'ArrowLeft' && !collapsed) toggleFileCollapse(row.path)
        }
      }
    },
    [navigableIndexes, activeIndex, rows, onOpenMatch, onOpenFilename, toggleFileCollapse, collapsedFiles, listRef]
  )

  const rowProps = useMemo<SearchRowProps>(
    () => ({
      rows,
      activeIndex,
      onToggleFile: toggleFileCollapse,
      onOpenMatch,
      onOpenFilename,
    }),
    [rows, activeIndex, toggleFileCollapse, onOpenMatch, onOpenFilename]
  )

  const hasQuery =
    mode === 'content'
      ? query.trim().length > 0
      : query.trim().length > 0 || activeExt !== null

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="px-4 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-widest uppercase text-fg-muted">
        <Search size={13} /> Search
      </div>

      {searchRoot && (
        <div className="mx-3 mb-2 flex items-center gap-1.5 px-2 py-1 rounded border border-accent/40 bg-accent/10 text-[11px] text-fg">
          <Filter size={12} className="text-accent flex-shrink-0" />
          <span className="truncate flex-1" title={searchRoot}>
            限定于：{searchRoot.replace(/\\/g, '/').split('/').pop() || searchRoot}
          </span>
          <button
            title="清除目录限定，回到当前项目根"
            className="text-fg-dim hover:text-fg flex-shrink-0"
            onClick={() => setSearchRoot(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="px-3 pb-2 flex flex-col gap-2">
        <div className="flex rounded border border-border overflow-hidden text-[11px]">
          <ModeTab active={mode === 'content'} onClick={() => setMode('content')}>
            内容
          </ModeTab>
          <ModeTab active={mode === 'filename'} onClick={() => setMode('filename')}>
            文件名
          </ModeTab>
        </div>

        <div className="relative">
          {loading ? (
            <LoaderCircle
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 animate-spin text-accent"
              aria-label="搜索中"
            />
          ) : (
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim" />
          )}
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={
              mode === 'content'
                ? activeExt
                  ? `在 .${activeExt} 文件中搜索内容…`
                  : '搜索文件内容…'
                : activeExt
                ? `按后缀 .${activeExt} 搜索…`
                : matchSuffix
                ? '输入后缀/扩展名，如 .ts'
                : fuzzy
                ? '模糊匹配文件名…'
                : '搜索文件名…'
            }
            className="w-full pl-7 pr-7 py-1.5 text-[13px] rounded bg-bg-deep border border-border focus:border-accent outline-none"
          />
          {query && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg"
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap relative">
          <Toggle
            active={ignoreCase}
            onClick={() => setIgnoreCase(v => !v)}
            title="忽略大小写"
            icon={<CaseSensitive size={13} />}
            label="Aa"
          />
          {mode === 'filename' && (
            <>
              <Toggle
                active={fuzzy}
                onClick={() => setFuzzy(v => !v)}
                title="模糊匹配（子序列）"
                icon={<Type size={13} />}
                label="模糊"
              />
              <Toggle
                active={matchSuffix}
                onClick={toggleSuffix}
                title="按后缀/扩展名匹配"
                icon={<Regex size={13} />}
                label="后缀"
                locked={activeExt !== null}
              />
            </>
          )}
          <button
            onClick={() => setExtPickerOpen(v => !v)}
            title="按文件类型筛选"
            className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border transition-colors
              ${activeExt
                ? 'bg-accent text-white border-accent'
                : 'bg-bg-deep text-fg-muted border-border hover:text-fg hover:border-border-strong'}`}
          >
            <Caret size={11} className={`transition-transform ${extPickerOpen ? 'rotate-180' : ''}`} />
            <span>{activeExt ? `.${activeExt}` : '全部类型'}</span>
          </button>
          {activeExt && (
            <button
              className="px-1 py-0.5 text-[11px] rounded text-fg-dim hover:text-fg"
              onClick={() => setActiveExt(null)}
              title="清除类型筛选"
            >
              <X size={12} />
            </button>
          )}
          {extPickerOpen && (
            <div
              className="absolute z-30 top-[calc(100%+4px)] left-0 bg-bg-elevated border border-border-strong rounded-md shadow-xl p-2 grid grid-cols-3 gap-1 w-[180px] max-h-56 overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              {COMMON_EXTS.map(ext => (
                <button
                  key={ext}
                  onClick={() => {
                    setActiveExt(cur => (cur === ext ? null : ext))
                    setExtPickerOpen(false)
                  }}
                  className={`px-1.5 py-0.5 text-[11px] rounded border transition-colors text-center
                    ${activeExt === ext
                      ? 'bg-accent text-white border-accent'
                      : 'bg-bg-deep text-fg-muted border-border hover:text-fg hover:border-border-strong'}`}
                >
                  .{ext}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div
        className="flex-1 overflow-hidden flex flex-col"
        tabIndex={0}
        onKeyDown={onResultsKeyDown}
      >
        {!effectiveRoot ? (
          <div className="px-4 py-6 text-[13px] text-fg-muted">请先选择或添加项目</div>
        ) : error ? (
          <div className="px-4 py-4 text-[13px] text-danger">{error}</div>
        ) : !hasQuery ? (
          <div className="px-4 py-4 text-[13px] text-fg-muted">
            {mode === 'content' ? '输入关键词搜索文件内容' : '输入关键词或选择常见后缀开始搜索'}
          </div>
        ) : rows.length === 0 && loading ? (
          <div className="px-4 py-4 text-[13px] text-fg-muted">搜索中…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-4 text-[13px] text-fg-muted">无匹配结果</div>
        ) : (
          <>
            <div className="px-4 py-1 flex items-center gap-2 text-[11px] text-fg-dim">
              <span className="truncate">
                {mode === 'content'
                  ? `${contentResults!.match_count} 个匹配 · ${contentResults!.files.length} 个文件${contentResults!.truncated ? ' · 已截断' : ''}`
                  : `${filenameResults.length} 个结果`}
              </span>
              {loading && <LoaderCircle size={12} className="animate-spin text-accent flex-shrink-0" aria-label="搜索中" />}
              {mode === 'content' && (
                <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                  <button className="hover:text-fg" onClick={expandAll} title="展开全部">
                    <ChevronDown size={12} />
                  </button>
                  <button className="hover:text-fg" onClick={collapseAll} title="折叠全部">
                    <ChevronRight size={12} />
                  </button>
                </span>
              )}
            </div>
            <div className="flex-1">
              <List
                listRef={listRef}
                rowCount={rows.length}
                rowHeight={(index: number) => rowHeightOf(rows[index])}
                rowComponent={SearchRowComponent}
                rowProps={rowProps}
                overscanCount={8}
                className="h-full"
                style={{ height: '100%' }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface SearchRowProps {
  rows: Row[]
  activeIndex: number
  onToggleFile: (path: string) => void
  onOpenMatch: (path: string, line: number) => void
  onOpenFilename: (path: string, isDir: boolean) => void
}

const SearchRowComponent = (props: {
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
  index: number
  style: CSSProperties
} & SearchRowProps) => {
  const { index, style, rows, activeIndex, onToggleFile, onOpenMatch, onOpenFilename } = props
  const row = rows[index]
  if (!row) return null
  const active = index === activeIndex
  const baseCls = 'absolute left-0 right-0 flex items-center'
  const activeCls = active ? 'bg-bg-active' : ''

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
            <span className="truncate text-fg-dim text-[11px] ml-1" title={row.dir}>
              {row.dir}
            </span>
          )}
          <span className="ml-auto text-[11px] text-fg-dim flex-shrink-0">
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
      <div style={style} className={`${baseCls} pl-9 pr-3 text-[11px] text-fg-dim`}>
        …可能还有更多匹配
      </div>
    )
  }

  if (row.kind === 'dir') {
    return (
      <div style={style} className={`${baseCls} px-4 text-[11px] text-fg-dim`} title={row.dir}>
        <span className="truncate">{row.dir}</span>
      </div>
    )
  }

  // filename result
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
      <span className="ml-auto text-[11px] text-fg-dim truncate max-w-[40%]">
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
  const before = text.slice(0, start)
  const match = text.slice(start, end)
  const after = text.slice(end)
  return (
    <>
      {before}
      <mark className="bg-accent/30 text-fg rounded-sm px-0.5">{match}</mark>
      {after}
    </>
  )
})

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-1 transition-colors
        ${active
          ? 'bg-bg-active text-fg font-medium'
          : 'bg-bg-deep text-fg-muted hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

function Toggle({
  active,
  onClick,
  title,
  icon,
  label,
  locked,
}: {
  active: boolean
  onClick: () => void
  title: string
  icon: ReactNode
  label: string
  locked?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={locked ? `${title}（已由后缀筛选锁定）` : title}
      className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border transition-colors
        ${active
          ? 'bg-bg-active text-fg border-border-strong'
          : 'bg-bg-deep text-fg-muted border-border hover:text-fg'}
        ${locked ? 'opacity-60 cursor-default' : ''}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
