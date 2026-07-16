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
import { findProjectForPath } from '../utils/fileReferences'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'

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
type SearchScope = 'current' | 'all'
type TypeFilter = { kind: 'preset'; label: string; exts: string[] } | { kind: 'ext'; ext: string }

const TYPE_PRESETS: { label: string; exts: string[] }[] = [
  { label: 'Web', exts: ['html', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'astro'] },
  { label: '脚本', exts: ['py', 'rs', 'go', 'java', 'kt', 'rb', 'php', 'sh', 'ps1', 'bat', 'cs'] },
  { label: '配置', exts: ['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'env'] },
  { label: '文档', exts: ['md', 'mdx', 'txt', 'rst'] },
]

const COMMON_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'vue', 'svelte', 'astro',
  'json', 'jsonc', 'html', 'css', 'scss', 'less',
  'md', 'mdx', 'yaml', 'yml', 'toml', 'xml', 'sql',
  'rs', 'py', 'go', 'java', 'kt', 'c', 'cpp', 'h', 'cs',
  'php', 'rb', 'swift', 'sh', 'ps1', 'bat', 'env',
]

function typeFilterLabel(filter: TypeFilter | null) {
  if (!filter) return '全部类型'
  if (filter.kind === 'ext') return `.${filter.ext}`
  return filter.label
}

function typeFilterExtensions(filter: TypeFilter | null): string[] | null {
  if (!filter) return null
  return filter.kind === 'ext' ? [filter.ext] : filter.exts
}

function isGlobPattern(query: string) {
  return query.includes('*') || query.includes('?')
}

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
  const { t } = useI18n()
  const projects = useProjectStore(s => s.projects)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const currentProject = useProjectStore(s => s.currentProject)
  const openFile = useEditorStore(s => s.openFile)
  const searchRoot = useUIStore(s => s.searchRoot)
  const setSearchRoot = useUIStore(s => s.setSearchRoot)

  const [searchScope, setSearchScope] = useState<SearchScope>('current')
  const searchRoots = useMemo(() => {
    if (searchRoot) return [{ path: searchRoot, label: null as string | null }]
    if (searchScope === 'all') {
      return projects
        .filter(p => !unavailableProjectIds.includes(p.id))
        .map(p => ({ path: p.path, label: p.name }))
    }
    if (currentProject && !unavailableProjectIds.includes(currentProject.id)) {
      return [{ path: currentProject.path, label: null as string | null }]
    }
    return []
  }, [searchRoot, searchScope, projects, unavailableProjectIds, currentProject])

  const multiProjectSearch = searchRoots.length > 1

  const [mode, setMode] = useState<SearchMode>('content')
  const [query, setQuery] = useState('')
  const [ignoreCase, setIgnoreCase] = useState(true)
  const [fuzzy, setFuzzy] = useState(false)
  const [matchSuffix, setMatchSuffix] = useState(false)
  const [typeFilter, setTypeFilter] = useState<TypeFilter | null>(null)
  const [extPickerOpen, setExtPickerOpen] = useState(false)
  const [filenameResults, setFilenameResults] = useState<SearchHit[]>([])
  const [contentResults, setContentResults] = useState<ContentSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const reqId = useRef(0)
  const listRef = useListRef(null)

  const extList = typeFilterExtensions(typeFilter)
  const useGlob = isGlobPattern(query)

  useEffect(() => {
    setCollapsedFiles(new Set())
  }, [query, mode, typeFilter])

  useEffect(() => {
    if (!extPickerOpen) return
    const onDoc = () => setExtPickerOpen(false)
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [extPickerOpen])

  useEffect(() => {
    if (searchRoots.length === 0) {
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
    } else if (!query.trim() && !typeFilter) {
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
    const perRootLimit = Math.max(50, Math.ceil(500 / searchRoots.length))

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
          let merged: ContentSearchResponse = {
            files: [],
            match_count: 0,
            files_scanned: 0,
            truncated: false,
          }
          for (const root of searchRoots) {
            const resp = await safeInvoke<ContentSearchResponse>('内容搜索', 'search_file_contents', {
              root: root.path,
              query: q,
              ignoreCase,
              extension: null,
              extensions: extList,
              maxMatches: perRootLimit,
              maxFilesScanned: Math.ceil(8000 / searchRoots.length),
              maxMatchesPerFile: 20,
            })
            merged.files.push(...resp.files)
            merged.match_count += resp.match_count
            merged.files_scanned += resp.files_scanned
            merged.truncated = merged.truncated || resp.truncated
            if (merged.match_count >= 500) {
              merged.truncated = true
              break
            }
          }
          if (id === reqId.current) {
            setContentResults(merged)
            setFilenameResults([])
            setError(null)
          }
        } else {
          let hits: SearchHit[] = []
          for (const root of searchRoots) {
            const part = await safeInvoke<SearchHit[]>('文件搜索', 'search_files', {
              root: root.path,
              query: q,
              ignoreCase,
              fuzzy: fuzzy && !useGlob && !matchSuffix && !extList,
              matchSuffix: !useGlob && matchSuffix && !extList,
              extension: null,
              extensions: extList,
              limit: perRootLimit,
            })
            hits.push(...part)
            if (hits.length >= 500) {
              hits = hits.slice(0, 500)
              break
            }
          }
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
  }, [searchRoots, query, ignoreCase, fuzzy, matchSuffix, typeFilter, extList, useGlob, mode])

  const toggleSuffix = () => {
    if (mode === 'content' || useGlob) return
    if (!matchSuffix && typeFilter !== null) return
    setMatchSuffix(v => !v)
  }

  const rows = useMemo<Row[]>(() => {
    if (mode === 'content') {
      if (!contentResults || contentResults.match_count === 0) return []
      const out: Row[] = []
      for (const file of contentResults.files) {
        const collapsed = collapsedFiles.has(file.path)
        const project = multiProjectSearch ? findProjectForPath(projects, file.path) : null
        const dir = dirOf(file.relative)
        out.push({
          kind: 'file',
          path: file.path,
          name: file.name,
          dir: project && dir ? `${project.name} / ${dir}` : project ? project.name : dir,
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
      const project = multiProjectSearch ? findProjectForPath(projects, h.path) : null
      const groupKey = project ? `${project.name} / ${dir}` : dir
      const arr = groups.get(groupKey) ?? []
      arr.push(h)
      groups.set(groupKey, arr)
    }
    const out: Row[] = []
    for (const [dir, items] of groups) {
      out.push({ kind: 'dir', dir })
      for (const h of items) out.push({ kind: 'fn', hit: h })
    }
    return out
  }, [mode, contentResults, filenameResults, collapsedFiles, multiProjectSearch, projects])

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
      : query.trim().length > 0 || typeFilter !== null

  return (
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="px-4 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-widest uppercase text-fg-muted">
        <Search size={13} /> {t('搜索')}
      </div>

      {!searchRoot && (
        <div className="mx-3 mb-2 flex rounded border border-border overflow-hidden text-[11px]">
          <ScopeTab
            active={searchScope === 'current'}
            onClick={() => setSearchScope('current')}
          >
            {t('当前项目')}
          </ScopeTab>
          <ScopeTab
            active={searchScope === 'all'}
            onClick={() => setSearchScope('all')}
          >
            {t('全部项目')}
          </ScopeTab>
        </div>
      )}

      {searchRoot && (
        <div className="mx-3 mb-2 flex items-center gap-1.5 px-2 py-1 rounded border border-accent/40 bg-accent/10 text-[11px] text-fg">
          <Filter size={12} className="text-accent flex-shrink-0" />
          <Tooltip label={searchRoot} side="bottom" wrapperClassName="truncate flex-1 min-w-0">
            <span className="truncate block">
              {t('限定于：')}{searchRoot.replace(/\\/g, '/').split('/').pop() || searchRoot}
            </span>
          </Tooltip>
          <Tooltip label={t('清除目录限定，回到当前项目根')} side="bottom">
            <button
              className="text-fg-dim hover:text-fg flex-shrink-0"
              onClick={() => setSearchRoot(null)}
            >
              <X size={12} />
            </button>
          </Tooltip>
        </div>
      )}

      <div className="px-3 pb-2 flex flex-col gap-2">
        <div className="flex rounded border border-border overflow-hidden text-[11px]">
          <ModeTab active={mode === 'content'} onClick={() => setMode('content')}>
            {t('内容')}
          </ModeTab>
          <ModeTab active={mode === 'filename'} onClick={() => setMode('filename')}>
            {t('文件名')}
          </ModeTab>
        </div>

        <div className="relative">
          {loading ? (
            <LoaderCircle
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 animate-spin text-accent"
              aria-label={t('搜索中')}
            />
          ) : (
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim" />
          )}
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={
              mode === 'content'
                ? typeFilter
                  ? t('在 {type} 文件中搜索内容…', { type: t(typeFilterLabel(typeFilter)) })
                  : t('搜索文件内容…')
                : useGlob
                ? t('通配符匹配，如 *.tsx 或 test*Util.ts')
                : typeFilter
                ? t('在 {type} 中搜索文件名…', { type: t(typeFilterLabel(typeFilter)) })
                : matchSuffix
                ? t('输入后缀/扩展名，如 .ts 或 ts')
                : fuzzy
                ? t('模糊匹配文件名…')
                : t('搜索文件名，支持 * 通配符…')
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
            tooltip={t('忽略大小写')}
            icon={<CaseSensitive size={13} />}
            label="Aa"
          />
          {mode === 'filename' && (
            <>
              <Toggle
                active={fuzzy}
                onClick={() => setFuzzy(v => !v)}
                tooltip={t('模糊匹配（子序列）')}
                icon={<Type size={13} />}
                label={t('模糊')}
                locked={useGlob}
              />
              <Toggle
                active={matchSuffix}
                onClick={toggleSuffix}
                tooltip={t('按后缀/扩展名匹配')}
                icon={<Regex size={13} />}
                label={t('后缀')}
                locked={typeFilter !== null || useGlob}
              />
            </>
          )}
          <Tooltip label={t('按文件类型筛选')} side="bottom">
            <button
              onClick={() => setExtPickerOpen(v => !v)}
              className={`flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border transition-colors
                ${typeFilter
                  ? 'bg-accent text-white border-accent'
                  : 'bg-bg-deep text-fg-muted border-border hover:text-fg hover:border-border-strong'}`}
            >
              <Caret size={11} className={`transition-transform ${extPickerOpen ? 'rotate-180' : ''}`} />
              <span>{t(typeFilterLabel(typeFilter))}</span>
            </button>
          </Tooltip>
          {typeFilter && (
            <Tooltip label={t('清除类型筛选')} side="bottom">
              <button
                className="px-1 py-0.5 text-[11px] rounded text-fg-dim hover:text-fg"
                onClick={() => setTypeFilter(null)}
              >
                <X size={12} />
              </button>
            </Tooltip>
          )}
          {extPickerOpen && (
            <div
              className="absolute z-30 top-[calc(100%+4px)] left-0 bg-bg-elevated border border-border-strong rounded-md shadow-xl p-2 w-[220px] max-h-72 overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setTypeFilter(null)
                  setExtPickerOpen(false)
                }}
                className={`mb-2 w-full px-2 py-1 text-[11px] rounded border transition-colors text-left
                  ${!typeFilter
                    ? 'bg-accent text-white border-accent'
                    : 'bg-bg-deep text-fg-muted border-border hover:text-fg hover:border-border-strong'}`}
              >
                {t('全部类型')}
              </button>
              <div className="mb-2 text-[10px] font-semibold tracking-wide uppercase text-fg-dim px-0.5">
                {t('常见分组')}
              </div>
              <div className="grid grid-cols-2 gap-1 mb-2">
                {TYPE_PRESETS.map(preset => (
                  <button
                    key={preset.label}
                    onClick={() => {
                      setTypeFilter(cur =>
                        cur?.kind === 'preset' && cur.label === preset.label
                          ? null
                          : { kind: 'preset', label: preset.label, exts: preset.exts }
                      )
                      setExtPickerOpen(false)
                    }}
                    className={`px-2 py-1 text-[11px] rounded border transition-colors text-left
                      ${typeFilter?.kind === 'preset' && typeFilter.label === preset.label
                        ? 'bg-accent text-white border-accent'
                        : 'bg-bg-deep text-fg-muted border-border hover:text-fg hover:border-border-strong'}`}
                  >
                    {t(preset.label)}
                  </button>
                ))}
              </div>
              <div className="mb-1 text-[10px] font-semibold tracking-wide uppercase text-fg-dim px-0.5">
                {t('扩展名')}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {COMMON_EXTS.map(ext => (
                  <button
                    key={ext}
                    onClick={() => {
                      setTypeFilter(cur =>
                        cur?.kind === 'ext' && cur.ext === ext ? null : { kind: 'ext', ext }
                      )
                      setExtPickerOpen(false)
                    }}
                    className={`px-1.5 py-0.5 text-[11px] rounded border transition-colors text-center
                      ${typeFilter?.kind === 'ext' && typeFilter.ext === ext
                        ? 'bg-accent text-white border-accent'
                        : 'bg-bg-deep text-fg-muted border-border hover:text-fg hover:border-border-strong'}`}
                  >
                    .{ext}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        className="flex-1 overflow-hidden flex flex-col"
        tabIndex={0}
        onKeyDown={onResultsKeyDown}
      >
        {!searchRoots.length ? (
          <div className="px-4 py-6 text-[13px] text-fg-muted">{t('请先选择或添加项目')}</div>
        ) : error ? (
          <div className="px-4 py-4 text-[13px] text-danger">{error}</div>
        ) : !hasQuery ? (
          <div className="px-4 py-4 text-[13px] text-fg-muted">
            {mode === 'content' ? t('输入关键词搜索文件内容') : t('输入关键词、通配符（*）或选择常见类型开始搜索')}
          </div>
        ) : rows.length === 0 && loading ? (
          <div className="px-4 py-4 text-[13px] text-fg-muted">{t('搜索中…')}</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-4 text-[13px] text-fg-muted">{t('无匹配结果')}</div>
        ) : (
          <>
            <div className="px-4 py-1 flex items-center gap-2 text-[11px] text-fg-dim">
              <span className="truncate">
                {mode === 'content'
                  ? t('{matches} 个匹配 · {files} 个文件{truncated}', {
                      matches: contentResults!.match_count,
                      files: contentResults!.files.length,
                      truncated: contentResults!.truncated ? t(' · 已截断') : '',
                    })
                  : t('{count} 个结果', { count: filenameResults.length })}
              </span>
              {loading && <LoaderCircle size={12} className="animate-spin text-accent flex-shrink-0" aria-label={t('搜索中')} />}
              {mode === 'content' && (
                <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                  <Tooltip label={t('展开全部')} side="bottom">
                    <button className="hover:text-fg" onClick={expandAll}>
                      <ChevronDown size={12} />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('折叠全部')} side="bottom">
                    <button className="hover:text-fg" onClick={collapseAll}>
                      <ChevronRight size={12} />
                    </button>
                  </Tooltip>
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
  const { t } = useI18n()
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
            <Tooltip label={row.dir} side="bottom" wrapperClassName="truncate min-w-0 ml-1">
              <span className="truncate text-fg-dim text-[11px] block">
                {row.dir}
              </span>
            </Tooltip>
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
        {t('…可能还有更多匹配')}
      </div>
    )
  }

  if (row.kind === 'dir') {
    return (
      <div style={style} className={`${baseCls} px-4 text-[11px] text-fg-dim`}>
        <Tooltip label={row.dir} side="bottom" wrapperClassName="truncate min-w-0 w-full">
          <span className="truncate block">{row.dir}</span>
        </Tooltip>
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

function ScopeTab({
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
