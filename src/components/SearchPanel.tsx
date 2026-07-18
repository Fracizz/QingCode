import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Search,
  SearchX,
  AlertCircle,
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
  Replace,
} from 'lucide-react'
import { List, useListRef } from 'react-window'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import { findProjectForPath } from '../utils/fileReferences'
import {
  dirOf,
  isGlobPattern,
  isNavigable,
  rowHeightOf,
  trimContentFiles,
  typeFilterExtensions,
  typeFilterLabel,
  type ContentSearchFileResult,
  type SearchResultRow as Row,
  type TypeFilter,
} from '../utils/searchHelpers'
import Tooltip from './Tooltip'
import EmptyState from './EmptyState'
import SegmentedControl from './SegmentedControl'
import ReplacePreviewDialog from './ReplacePreviewDialog'
import { getContextMenuStylePosition } from './contextMenuPosition'
import { buildReplacePreview, type ReplacePreview } from '../lib/workspaceReplace'
import { loadExcludeSettingsForProject } from '../lib/excludeSettings'
import { useI18n } from '../lib/i18n'

interface SearchHit {
  name: string
  path: string
  relative: string
  is_dir: boolean
}

interface ContentSearchResponse {
  files: ContentSearchFileResult[]
  match_count: number
  files_scanned: number
  truncated: boolean
  cancelled?: boolean
}

type SearchMode = 'filename' | 'content'
type SearchScope = 'current' | 'all'

const TOP_EXT_COUNT = 5
const CONTENT_DEBOUNCE_MS = 400
const FILENAME_DEBOUNCE_MS = 200
const MAX_MATCHES_PER_FILE = 20
const EXT_PICKER_WIDTH = 168

export default function SearchPanel() {
  const { t } = useI18n()
  const projects = useProjectStore(s => s.projects)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const currentProject = useProjectStore(s => s.currentProject)
  const openFile = useEditorStore(s => s.openFile)
  const searchRoot = useUIStore(s => s.searchRoot)
  const setSearchRoot = useUIStore(s => s.setSearchRoot)
  const globalSearchSignal = useUIStore(s => s.globalSearchSignal)

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
  const [extPickerStyle, setExtPickerStyle] = useState<CSSProperties>({
    visibility: 'hidden',
    left: 0,
    top: 0,
    width: EXT_PICKER_WIDTH,
  })
  const [projectExts, setProjectExts] = useState<string[]>([])
  const [projectExtsLoading, setProjectExtsLoading] = useState(false)
  const [filenameResults, setFilenameResults] = useState<SearchHit[]>([])
  const [contentResults, setContentResults] = useState<ContentSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const [replaceText, setReplaceText] = useState('')
  const [replacePreview, setReplacePreview] = useState<ReplacePreview | null>(null)
  const reqId = useRef(0)
  const pushToast = useProjectStore(s => s.pushToast)
  const extScanId = useRef(0)
  const listRef = useListRef(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const extPickerBtnRef = useRef<HTMLButtonElement>(null)
  const extPickerRef = useRef<HTMLDivElement>(null)
  const extList = typeFilterExtensions(typeFilter)
  const useGlob = isGlobPattern(query)
  const topExts = useMemo(() => projectExts.slice(0, TOP_EXT_COUNT), [projectExts])
  const otherExts = useMemo(() => projectExts.slice(TOP_EXT_COUNT), [projectExts])
  const hasStarOption = otherExts.length > 0

  useEffect(() => {
    if (globalSearchSignal === 0) return
    setSearchRoot(null)
    setSearchScope('current')
    window.requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [globalSearchSignal, setSearchRoot])

  useEffect(() => {
    setCollapsedFiles(new Set())
  }, [query, mode, typeFilter])

  useEffect(() => {
    if (typeFilter?.kind !== 'star') return
    if (otherExts.length === 0) {
      setTypeFilter(null)
      return
    }
    setTypeFilter({ kind: 'star', exts: otherExts })
  }, [otherExts])

  const closeExtPicker = useCallback(() => setExtPickerOpen(false), [])

  useLayoutEffect(() => {
    if (!extPickerOpen) return
    const btn = extPickerBtnRef.current
    const menu = extPickerRef.current
    if (!btn || !menu) return

    const rect = btn.getBoundingClientRect()
    const zoom = Number.parseFloat(getComputedStyle(menu).zoom) || 1
    const height = menu.scrollHeight
    const gap = 4
    const preferAbove = rect.bottom + gap + height * zoom > window.innerHeight - 8
    const placed = getContextMenuStylePosition(
      rect.left,
      preferAbove ? rect.top - gap : rect.bottom + gap,
      { width: EXT_PICKER_WIDTH, height },
      { width: window.innerWidth, height: window.innerHeight },
      preferAbove,
      zoom,
    )
    setExtPickerStyle({
      left: placed.x,
      top: placed.y,
      width: EXT_PICKER_WIDTH,
      visibility: 'visible',
    })
  }, [extPickerOpen, projectExts.length, topExts.length])

  useEffect(() => {
    if (!extPickerOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (extPickerRef.current?.contains(target)) return
      if (extPickerBtnRef.current?.contains(target)) return
      closeExtPicker()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeExtPicker()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', closeExtPicker)
    window.addEventListener('scroll', closeExtPicker, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', closeExtPicker)
      window.removeEventListener('scroll', closeExtPicker, true)
    }
  }, [extPickerOpen, closeExtPicker])

  useEffect(() => {
    if (searchRoots.length === 0) {
      setProjectExts([])
      setProjectExtsLoading(false)
      return
    }
    if (!isTauri()) {
      setProjectExts([])
      setProjectExtsLoading(false)
      return
    }
    const id = ++extScanId.current
    setProjectExtsLoading(true)
    const roots = searchRoots.map(root => root.path)
    void safeInvoke<string[]>('扫描项目扩展名', 'list_file_extensions', {
      roots,
      maxFiles: 8000,
    })
      .then(exts => {
        if (id !== extScanId.current) return
        setProjectExts(exts)
      })
      .catch(() => {
        if (id !== extScanId.current) return
        setProjectExts([])
      })
      .finally(() => {
        if (id === extScanId.current) setProjectExtsLoading(false)
      })
  }, [searchRoots])

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
          const searchId = await safeInvoke<number>('开始内容搜索', 'start_content_search')
          if (id !== reqId.current) return

          const maxFilesScanned = Math.ceil(8000 / searchRoots.length)
          const parts = await Promise.all(
            searchRoots.map(async root => {
              const project =
                findProjectForPath(projects, root.path) ??
                projects.find(p => p.path === root.path) ??
                null
              const excludes = await loadExcludeSettingsForProject(project)
              return safeInvoke<ContentSearchResponse>('内容搜索', 'search_file_contents', {
                root: root.path,
                query: q,
                ignoreCase,
                extension: null,
                extensions: extList,
                maxMatches: perRootLimit,
                maxFilesScanned,
                maxMatchesPerFile: MAX_MATCHES_PER_FILE,
                searchId,
                excludePatterns: excludes.searchExclude,
                useIgnoreFiles: excludes.useIgnoreFiles,
                followSymlinks: excludes.followSymlinks,
              })
            }),
          )
          if (id !== reqId.current) return
          if (parts.every(p => p.cancelled)) return

          const merged: ContentSearchResponse = {
            files: [],
            match_count: 0,
            files_scanned: 0,
            truncated: false,
          }
          for (const resp of parts) {
            if (resp.cancelled) continue
            merged.files.push(...resp.files)
            merged.match_count += resp.match_count
            merged.files_scanned += resp.files_scanned
            merged.truncated = merged.truncated || resp.truncated
          }
          if (merged.match_count > 500) {
            merged.files = trimContentFiles(merged.files, 500)
            merged.match_count = merged.files.reduce((n, f) => n + f.matches.length, 0)
            merged.truncated = true
          }
          if (id === reqId.current) {
            setContentResults(merged)
            setFilenameResults([])
            setError(null)
          }
        } else {
          const parts = await Promise.all(
            searchRoots.map(async root => {
              const project =
                findProjectForPath(projects, root.path) ??
                projects.find(p => p.path === root.path) ??
                null
              const excludes = await loadExcludeSettingsForProject(project)
              return safeInvoke<SearchHit[]>('文件搜索', 'search_files', {
                root: root.path,
                query: q,
                ignoreCase,
                fuzzy: fuzzy && !useGlob && !matchSuffix && !extList,
                matchSuffix: !useGlob && matchSuffix && !extList,
                extension: null,
                extensions: extList,
                limit: perRootLimit,
                excludePatterns: excludes.searchExclude,
                useIgnoreFiles: excludes.useIgnoreFiles,
                followSymlinks: excludes.followSymlinks,
              })
            }),
          )
          if (id !== reqId.current) return
          let hits = parts.flat()
          if (hits.length > 500) hits = hits.slice(0, 500)
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

    return () => {
      clearTimeout(handle)
      if (mode === 'content' && isTauri()) {
        void safeInvoke('取消内容搜索', 'cancel_content_search').catch(() => {})
      }
    }
  }, [searchRoots, query, ignoreCase, fuzzy, matchSuffix, typeFilter, extList, useGlob, mode, projects])

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
    <>
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="px-4 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
        <Search size={13} /> {t('搜索')}
      </div>

      {!searchRoot && (
        <SegmentedControl
          className="mx-3 mb-2"
          ariaLabel={t('搜索范围')}
          options={[
            { value: 'current', label: t('当前项目') },
            { value: 'all', label: t('全部项目') },
          ]}
          value={searchScope}
          onChange={setSearchScope}
        />
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
        <SegmentedControl
          ariaLabel={t('搜索模式')}
          options={[
            { value: 'content', label: t('内容') },
            { value: 'filename', label: t('文件名') },
          ]}
          value={mode}
          onChange={setMode}
        />

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
            ref={searchInputRef}
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
            className="setting-input w-full pl-7 pr-7 py-1.5 text-[13px]"
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

        {mode === 'content' && (
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Replace
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim"
              />
              <input
                value={replaceText}
                onChange={e => setReplaceText(e.target.value)}
                placeholder={t('替换为…')}
                className="setting-input w-full pl-7 pr-2 py-1.5 text-[13px]"
              />
            </div>
            <Tooltip label={t('预览并确认后写入全部匹配')} side="bottom">
              <button
                type="button"
                disabled={
                  !contentResults ||
                  contentResults.files.length === 0 ||
                  !query.trim() ||
                  loading
                }
                className="flex-shrink-0 px-2 py-1.5 text-[11px] rounded border border-border-strong text-fg-muted hover:text-fg hover:bg-bg-hover disabled:opacity-40 disabled:pointer-events-none transition-colors"
                onClick={() => {
                  if (!contentResults || !query.trim()) return
                  setReplacePreview(
                    buildReplacePreview(
                      query,
                      replaceText,
                      ignoreCase,
                      contentResults.files,
                      contentResults.match_count,
                      contentResults.truncated,
                    ),
                  )
                }}
              >
                {t('全部替换')}
              </button>
            </Tooltip>
          </div>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
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
              ref={extPickerBtnRef}
              type="button"
              aria-expanded={extPickerOpen}
              onClick={event => {
                event.stopPropagation()
                if (extPickerOpen) {
                  closeExtPicker()
                  return
                }
                setExtPickerStyle(prev => ({ ...prev, visibility: 'hidden' }))
                setExtPickerOpen(true)
              }}
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
                type="button"
                className="px-1 py-0.5 text-[11px] rounded text-fg-dim hover:text-fg"
                onClick={() => setTypeFilter(null)}
              >
                <X size={12} />
              </button>
            </Tooltip>
          )}
          {extPickerOpen &&
            createPortal(
              <div
                ref={extPickerRef}
                role="listbox"
                className="menu-enter ui-font-scaled fixed z-[100] rounded-md border border-border-strong bg-bg-elevated p-1.5 shadow-2xl shadow-black/50"
                style={extPickerStyle}
                onPointerDown={event => event.stopPropagation()}
              >
                <div className="mb-1 flex items-center justify-between gap-2 px-1">
                  <span className="text-[10px] text-fg-dim">{t('当前项目')}</span>
                  {projectExtsLoading && (
                    <LoaderCircle size={10} className="animate-spin text-accent" />
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    role="option"
                    aria-selected={!typeFilter}
                    onClick={() => {
                      setTypeFilter(null)
                      closeExtPicker()
                    }}
                    className={`rounded border px-2 py-0.5 text-[11px] transition-colors
                      ${!typeFilter
                        ? 'border-accent bg-accent text-white'
                        : 'border-border bg-bg-deep text-fg-muted hover:border-border-strong hover:bg-bg-active hover:text-fg'}`}
                  >
                    {t('全部')}
                  </button>
                  {topExts.map(ext => {
                    const selected = typeFilter?.kind === 'ext' && typeFilter.ext === ext
                    return (
                      <button
                        key={ext}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          setTypeFilter(cur =>
                            cur?.kind === 'ext' && cur.ext === ext ? null : { kind: 'ext', ext }
                          )
                          closeExtPicker()
                        }}
                        className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors
                          ${selected
                            ? 'border-accent bg-accent text-white'
                            : 'border-border bg-bg-deep text-fg-muted hover:border-border-strong hover:bg-bg-active hover:text-fg'}`}
                      >
                        .{ext}
                      </button>
                    )
                  })}
                  {hasStarOption && (
                    <button
                      type="button"
                      role="option"
                      aria-selected={typeFilter?.kind === 'star'}
                      title={`${t('其余扩展名')}（${otherExts.length}）`}
                      onClick={() => {
                        setTypeFilter(cur =>
                          cur?.kind === 'star' ? null : { kind: 'star', exts: otherExts }
                        )
                        closeExtPicker()
                      }}
                      className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors
                        ${typeFilter?.kind === 'star'
                          ? 'border-accent bg-accent text-white'
                          : 'border-border bg-bg-deep text-fg-muted hover:border-border-strong hover:bg-bg-active hover:text-fg'}`}
                    >
                      *
                    </button>
                  )}
                  {!projectExtsLoading && topExts.length === 0 && (
                    <span className="px-1 py-0.5 text-[11px] text-fg-dim">{t('暂无扩展名')}</span>
                  )}
                </div>
              </div>,
              document.body,
            )}
        </div>
      </div>

      <div
        className="flex-1 overflow-hidden flex flex-col"
        tabIndex={0}
        onKeyDown={onResultsKeyDown}
      >
        {!searchRoots.length ? (
          <EmptyState icon={<Folder size={28} strokeWidth={1.2} />} title={t('请先选择或添加项目')} />
        ) : error ? (
          <EmptyState icon={<AlertCircle size={28} strokeWidth={1.2} className="text-danger" />} title={error} />
        ) : !hasQuery ? (
          <EmptyState
            icon={<Search size={28} strokeWidth={1.2} />}
            title={mode === 'content' ? t('输入关键词搜索文件内容') : t('输入关键词、通配符（*）或选择文件类型开始搜索')}
          />
        ) : rows.length === 0 && loading ? (
          <EmptyState icon={<LoaderCircle size={24} className="animate-spin text-accent" />} title={t('搜索中…')} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<SearchX size={28} strokeWidth={1.2} />} title={t('无匹配结果')} />
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
    {replacePreview && (
      <ReplacePreviewDialog
        preview={replacePreview}
        onClose={() => setReplacePreview(null)}
        onApplied={result => {
          pushToast(
            'success',
            t('已替换 {replacements} 处（{files} 个文件）', {
              replacements: result.replacements,
              files: result.filesChanged,
            }),
          )
        }}
      />
    )}
    </>
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
