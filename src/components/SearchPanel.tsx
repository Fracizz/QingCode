import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Search,
  SearchX,
  AlertCircle,
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
  Copy,
  File as FileIcon,
  LocateFixed,
  ExternalLink,
} from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { List, useListRef } from 'react-window'
import { useProjectStore } from '../store/projectStore'
import { useEditorStore } from '../store/editorStore'
import { useUIStore } from '../store/uiStore'
import { safeInvoke, isTauri, NotInTauriError } from '../lib/tauri'
import { copyToClipboard, findProjectForPath } from '../utils/fileReferences'
import {
  buildContentResultRows,
  buildFilenameResultRows,
  countFilenameKinds,
  filterFilenameHits,
  isGlobPattern,
  isNavigable,
  nextSearchBudget,
  rowHeightOf,
  SEARCH_PREFETCH_ROWS,
  SEARCH_RESULT_BUDGETS,
  trimContentFiles,
  typeFilterExtensions,
  typeFilterLabel,
  type ContentSearchFileResult,
  type EntryKindFilter,
  type SearchResultRow as Row,
  type TypeFilter,
} from '../utils/searchHelpers'
import Tooltip from './Tooltip'
import EmptyState from './EmptyState'
import SegmentedControl from './SegmentedControl'
import ReplacePreviewDialog from './ReplacePreviewDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { getContextMenuStylePosition } from './contextMenuPosition'
import { buildReplacePreview, type ReplacePreview } from '../lib/workspaceReplace'
import { loadExcludeSettingsForProject } from '../lib/excludeSettings'
import {
  copyFileReferenceAction,
  copyPathAction,
  copyRelativePathAction,
} from '../lib/copyFileActions'
import { shouldShowAppContextMenu } from '../lib/devBuild'
import { fileNameFromPath } from '../store/editorStoreHelpers'
import { useI18n } from '../lib/i18n'
import {
  SearchResultRow,
  SearchToggle,
  type SearchContextTarget,
  type SearchRowProps,
} from './SearchPanelParts'

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

type SearchMode = 'all' | 'filename' | 'content'
type SearchScope = 'current' | 'all'

const TOP_EXT_COUNT = 5
/** Content search waits longer so typing stays smooth (IDEA-style pause-then-search). */
const CONTENT_DEBOUNCE_MS = 550
const FILENAME_DEBOUNCE_MS = 280
/** Skip content scan for 1-char queries; filename search still runs. */
const MIN_CONTENT_QUERY_LEN = 2
const MAX_MATCHES_PER_FILE = 20
const INITIAL_SEARCH_BUDGET = SEARCH_RESULT_BUDGETS[0]
const EXT_PICKER_WIDTH = 168
const SCOPE_MENU_WIDTH = 140

export default function SearchPanel() {
  const { t } = useI18n()
  const projects = useProjectStore(s => s.projects)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const currentProject = useProjectStore(s => s.currentProject)
  const openFile = useEditorStore(s => s.openFile)
  const setView = useUIStore(s => s.setView)
  const revealFileInTree = useProjectStore(s => s.revealFileInTree)
  const searchRoot = useUIStore(s => s.searchRoot)
  const setSearchRoot = useUIStore(s => s.setSearchRoot)
  const globalSearchSignal = useUIStore(s => s.globalSearchSignal)
  const globalSearchQuery = useUIStore(s => s.globalSearchQuery)

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

  const [mode, setMode] = useState<SearchMode>('all')
  const [entryKind, setEntryKind] = useState<EntryKindFilter>('all')
  const wantsFilename = mode === 'all' || mode === 'filename'
  const wantsContent = (mode === 'all' || mode === 'content') && entryKind !== 'dir'
  const showEntryKindFilter = mode === 'all' || mode === 'filename'
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
  const [filenameBudget, setFilenameBudget] = useState<number>(INITIAL_SEARCH_BUDGET)
  const [contentBudget, setContentBudget] = useState<number>(INITIAL_SEARCH_BUDGET)
  const [filenameTruncated, setFilenameTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [activeIndex, setActiveIndex] = useState(0)
  const [replaceText, setReplaceText] = useState('')
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacePreview, setReplacePreview] = useState<ReplacePreview | null>(null)
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [scopeMenuStyle, setScopeMenuStyle] = useState<CSSProperties>({
    visibility: 'hidden',
    left: 0,
    top: 0,
    width: SCOPE_MENU_WIDTH,
  })
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    target: SearchContextTarget
  } | null>(null)
  const reqId = useRef(0)
  const loadingMoreRef = useRef(false)
  const pushToast = useProjectStore(s => s.pushToast)
  const extScanId = useRef(0)
  /** When true, the next search effect skips debounce (Enter / flush). */
  const searchNowRef = useRef(false)
  /** Do not search intermediate pinyin/phonetic text while an IME composition is active. */
  const composingRef = useRef(false)
  const listRef = useListRef(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const scopeBtnRef = useRef<HTMLButtonElement>(null)
  const scopeMenuRef = useRef<HTMLDivElement>(null)
  const extPickerBtnRef = useRef<HTMLButtonElement>(null)
  const extPickerRef = useRef<HTMLDivElement>(null)
  const [searchFlush, setSearchFlush] = useState(0)
  const showReplace = mode === 'content'
  const extList = useMemo(() => typeFilterExtensions(typeFilter), [typeFilter])
  const useGlob = isGlobPattern(query)
  const topExts = useMemo(() => projectExts.slice(0, TOP_EXT_COUNT), [projectExts])
  const otherExts = useMemo(() => projectExts.slice(TOP_EXT_COUNT), [projectExts])
  const hasStarOption = otherExts.length > 0

  useEffect(() => {
    if (globalSearchSignal === 0) return
    setSearchRoot(null)
    setSearchScope('current')
    if (globalSearchQuery) {
      setQuery(globalSearchQuery)
      searchNowRef.current = true
      setSearchFlush(n => n + 1)
    }
    const frame = window.requestAnimationFrame(() => {
      const input = searchInputRef.current
      if (!input) return
      input.focus()
      if (globalSearchQuery) input.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [globalSearchQuery, globalSearchSignal, setSearchRoot])

  useEffect(() => {
    queueMicrotask(() => setCollapsedFiles(new Set()))
  }, [query, mode, typeFilter, entryKind])

  useEffect(() => {
    if (mode === 'content') return
    queueMicrotask(() => setReplaceOpen(false))
  }, [mode])

  useEffect(() => {
    if (mode === 'content' && entryKind !== 'all') {
      queueMicrotask(() => setEntryKind('all'))
    }
  }, [mode, entryKind])

  useEffect(() => {
    // Fresh query/filters start at the first page budget (not load-more bumps).
    queueMicrotask(() => {
      setFilenameBudget(INITIAL_SEARCH_BUDGET)
      setContentBudget(INITIAL_SEARCH_BUDGET)
      setFilenameTruncated(false)
      setLoadingMore(false)
      loadingMoreRef.current = false
    })
  }, [query, mode, ignoreCase, fuzzy, matchSuffix, typeFilter, entryKind, searchRoots])

  useEffect(() => {
    if (typeFilter?.kind !== 'star') return
    if (otherExts.length === 0) {
      queueMicrotask(() => setTypeFilter(null))
      return
    }
    queueMicrotask(() => setTypeFilter({ kind: 'star', exts: otherExts }))
  }, [otherExts, setTypeFilter, typeFilter?.kind])

  const closeExtPicker = useCallback(() => setExtPickerOpen(false), [])
  const closeScopeMenu = useCallback(() => setScopeMenuOpen(false), [])

  const placeMenu = useCallback(
    (
      btn: HTMLElement,
      menu: HTMLElement,
      width: number,
      setStyle: (style: CSSProperties) => void,
      align: 'left' | 'right' = 'left',
    ) => {
      const rect = btn.getBoundingClientRect()
      const zoom = Number.parseFloat(getComputedStyle(menu).zoom) || 1
      const height = menu.scrollHeight
      const gap = 4
      const preferAbove = rect.bottom + gap + height * zoom > window.innerHeight - 8
      const x = align === 'right' ? rect.right - width * zoom : rect.left
      const placed = getContextMenuStylePosition(
        x,
        preferAbove ? rect.top - gap : rect.bottom + gap,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        preferAbove,
        zoom,
      )
      setStyle({
        left: placed.x,
        top: placed.y,
        width,
        visibility: 'visible',
      })
    },
    [],
  )

  useLayoutEffect(() => {
    if (!extPickerOpen) return
    const btn = extPickerBtnRef.current
    const menu = extPickerRef.current
    if (!btn || !menu) return
    placeMenu(btn, menu, EXT_PICKER_WIDTH, setExtPickerStyle, 'left')
  }, [extPickerOpen, projectExts.length, topExts.length, placeMenu])

  useLayoutEffect(() => {
    if (!scopeMenuOpen) return
    const btn = scopeBtnRef.current
    const menu = scopeMenuRef.current
    if (!btn || !menu) return
    placeMenu(btn, menu, SCOPE_MENU_WIDTH, setScopeMenuStyle, 'right')
  }, [scopeMenuOpen, placeMenu])

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
    if (!scopeMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (scopeMenuRef.current?.contains(target)) return
      if (scopeBtnRef.current?.contains(target)) return
      closeScopeMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeScopeMenu()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', closeScopeMenu)
    window.addEventListener('scroll', closeScopeMenu, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', closeScopeMenu)
      window.removeEventListener('scroll', closeScopeMenu, true)
    }
  }, [scopeMenuOpen, closeScopeMenu])

  useEffect(() => {
    if (searchRoots.length === 0) {
      queueMicrotask(() => {
        setProjectExts([])
        setProjectExtsLoading(false)
      })
      return
    }
    if (!isTauri()) {
      queueMicrotask(() => {
        setProjectExts([])
        setProjectExtsLoading(false)
      })
      return
    }
    const id = ++extScanId.current
    queueMicrotask(() => setProjectExtsLoading(true))
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
    if (!wantsFilename) {
      queueMicrotask(() => setFilenameResults([]))
    }
    if (!wantsContent) {
      queueMicrotask(() => setContentResults(null))
    }
  }, [wantsFilename, wantsContent])

  useEffect(() => {
    const id = ++reqId.current
    if (searchRoots.length === 0) {
      searchNowRef.current = false
      queueMicrotask(() => {
        setFilenameResults([])
        setContentResults(null)
        setError(null)
        setLoading(false)
      })
      return
    }

    if (composingRef.current) {
      queueMicrotask(() => setLoading(false))
      return
    }

    const immediate = searchNowRef.current
    searchNowRef.current = false
    const filenameDelay = immediate ? 0 : FILENAME_DEBOUNCE_MS
    const contentDelay = immediate ? 0 : CONTENT_DEBOUNCE_MS

    const q = query.trim()
    const runFilename = wantsFilename && (q.length > 0 || typeFilter !== null)
    const runContent = wantsContent && q.length >= MIN_CONTENT_QUERY_LEN

    if (!runFilename && !runContent) {
      queueMicrotask(() => {
        if (wantsFilename) {
          setFilenameResults([])
          setFilenameTruncated(false)
        }
        if (wantsContent) setContentResults(null)
        setError(null)
        setLoading(false)
        setLoadingMore(false)
        loadingMoreRef.current = false
      })
      return
    }

    if (!isTauri()) {
      queueMicrotask(() => {
        setError(new NotInTauriError('文件搜索').message)
        setFilenameResults([])
        setFilenameTruncated(false)
        setContentResults(null)
        setLoading(false)
        setLoadingMore(false)
        loadingMoreRef.current = false
      })
      return
    }

    queueMicrotask(() => {
      if (!loadingMoreRef.current) setLoading(true)
    })
    const perRootFilenameLimit = Math.max(50, Math.ceil(filenameBudget / searchRoots.length))
    const perRootContentLimit = Math.max(50, Math.ceil(contentBudget / searchRoots.length))
    let filenameTimer: ReturnType<typeof setTimeout> | undefined
    let contentTimer: ReturnType<typeof setTimeout> | undefined
    let contentStarted = false
    let pending = (runFilename ? 1 : 0) + (runContent ? 1 : 0)
    let sawError: string | null = null

    const finishOne = () => {
      pending -= 1
      if (pending <= 0 && id === reqId.current) {
        setError(sawError)
        setLoading(false)
        setLoadingMore(false)
        loadingMoreRef.current = false
      }
    }

    const resolveProject = (rootPath: string) =>
      findProjectForPath(projects, rootPath) ??
      projects.find(p => p.path === rootPath) ??
      null

    if (runFilename) {
      filenameTimer = setTimeout(async () => {
        try {
          const parts = await Promise.all(
            searchRoots.map(async root => {
              const project = resolveProject(root.path)
              const excludes = await loadExcludeSettingsForProject(project)
              return safeInvoke<SearchHit[]>('文件搜索', 'search_files', {
                root: root.path,
                query: q,
                ignoreCase,
                fuzzy: fuzzy && !useGlob && !matchSuffix && !extList,
                matchSuffix: !useGlob && matchSuffix && !extList,
                extension: null,
                extensions: extList,
                limit: perRootFilenameLimit,
                excludePatterns: excludes.searchExclude,
                useIgnoreFiles: excludes.useIgnoreFiles,
                followSymlinks: excludes.followSymlinks,
              })
            }),
          )
          if (id !== reqId.current) return
          let hits = parts.flat()
          const hitCap = filenameBudget
          const truncated = hits.length >= hitCap || parts.some(part => part.length >= perRootFilenameLimit)
          if (hits.length > hitCap) hits = hits.slice(0, hitCap)
          setFilenameResults(hits)
          setFilenameTruncated(truncated)
          if (!sawError) setError(null)
        } catch (e) {
          if (id === reqId.current) {
            sawError = String(e)
            setFilenameResults([])
          }
        } finally {
          if (id === reqId.current) finishOne()
        }
      }, filenameDelay)
    } else if (wantsFilename) {
      queueMicrotask(() => setFilenameResults([]))
    }

    if (runContent) {
      contentTimer = setTimeout(async () => {
        contentStarted = true
        try {
          const searchId = await safeInvoke<number>('开始内容搜索', 'start_content_search')
          if (id !== reqId.current) return

          const maxFilesScanned = Math.ceil(8000 / searchRoots.length)
          const parts = await Promise.all(
            searchRoots.map(async root => {
              const project = resolveProject(root.path)
              const excludes = await loadExcludeSettingsForProject(project)
              return safeInvoke<ContentSearchResponse>('内容搜索', 'search_file_contents', {
                root: root.path,
                query: q,
                ignoreCase,
                extension: null,
                extensions: extList,
                maxMatches: perRootContentLimit,
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
          const validParts = parts.filter((resp): resp is ContentSearchResponse => Boolean(resp))
          if (validParts.length === 0 || validParts.every(p => p.cancelled)) return

          const merged: ContentSearchResponse = {
            files: [],
            match_count: 0,
            files_scanned: 0,
            truncated: false,
          }
          for (const resp of validParts) {
            if (resp.cancelled) continue
            merged.files.push(...resp.files)
            merged.match_count += resp.match_count
            merged.files_scanned += resp.files_scanned
            merged.truncated = merged.truncated || resp.truncated
          }
          if (merged.match_count > contentBudget) {
            merged.files = trimContentFiles(merged.files, contentBudget)
            merged.match_count = merged.files.reduce((n, f) => n + f.matches.length, 0)
            merged.truncated = true
          }
          setContentResults(merged)
          if (!sawError) setError(null)
        } catch (e) {
          if (id === reqId.current) {
            sawError = String(e)
            setContentResults(null)
          }
        } finally {
          if (id === reqId.current) finishOne()
        }
      }, contentDelay)
    } else if (wantsContent) {
      queueMicrotask(() => setContentResults(null))
    }

    return () => {
      if (filenameTimer) clearTimeout(filenameTimer)
      if (contentTimer) clearTimeout(contentTimer)
      if (contentStarted && isTauri()) {
        void safeInvoke('取消内容搜索', 'cancel_content_search').catch(() => {})
      }
    }
  }, [
    searchRoots,
    query,
    searchFlush,
    ignoreCase,
    fuzzy,
    matchSuffix,
    typeFilter,
    extList,
    useGlob,
    wantsFilename,
    wantsContent,
    filenameBudget,
    contentBudget,
    projects,
  ])

  const flushSearch = useCallback(() => {
    searchNowRef.current = true
    setSearchFlush(n => n + 1)
  }, [])

  const filteredFilenameResults = useMemo(
    () => filterFilenameHits(filenameResults, entryKind),
    [filenameResults, entryKind],
  )

  const contentTruncated = Boolean(contentResults?.truncated)
  const canLoadMoreFilename =
    wantsFilename && filenameTruncated && nextSearchBudget(filenameBudget) !== null
  const canLoadMoreContent =
    wantsContent && contentTruncated && nextSearchBudget(contentBudget) !== null
  const canLoadMore = canLoadMoreFilename || canLoadMoreContent

  const loadMoreResults = useCallback(() => {
    if (loadingMoreRef.current || loading) return
    const nextFn = canLoadMoreFilename ? nextSearchBudget(filenameBudget) : null
    const nextContent = canLoadMoreContent ? nextSearchBudget(contentBudget) : null
    if (nextFn === null && nextContent === null) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    searchNowRef.current = true
    if (nextFn !== null) setFilenameBudget(nextFn)
    if (nextContent !== null) setContentBudget(nextContent)
  }, [
    canLoadMoreContent,
    canLoadMoreFilename,
    contentBudget,
    filenameBudget,
    loading,
  ])

  const toggleSuffix = () => {
    if (!wantsFilename || useGlob) return
    if (!matchSuffix && typeFilter !== null) return
    setMatchSuffix(v => !v)
  }

  const projectNameOf = useCallback(
    (path: string) => {
      if (!multiProjectSearch) return null
      return findProjectForPath(projects, path)?.name ?? null
    },
    [multiProjectSearch, projects],
  )

  const rows = useMemo<Row[]>(() => {
    const filenameRows =
      wantsFilename && filteredFilenameResults.length > 0
        ? buildFilenameResultRows(filteredFilenameResults, projectNameOf)
        : []
    const contentRows =
      wantsContent && contentResults && contentResults.match_count > 0
        ? buildContentResultRows(
            contentResults.files,
            collapsedFiles,
            projectNameOf,
            MAX_MATCHES_PER_FILE,
          )
        : []

    let out: Row[]
    if (mode === 'all') {
      out = []
      if (filenameRows.length > 0) {
        out.push({ kind: 'section', id: 'filename', label: t('文件名匹配') })
        out.push(...filenameRows)
      }
      if (contentRows.length > 0) {
        out.push({ kind: 'section', id: 'content', label: t('内容匹配') })
        out.push(...contentRows)
      }
    } else if (mode === 'content') {
      out = contentRows
    } else {
      out = filenameRows
    }

    if (out.length > 0 && (canLoadMore || loadingMore)) {
      out = [
        ...out,
        { kind: 'footer', loading: loadingMore, hasMore: canLoadMore },
      ]
    }
    return out
  }, [
    mode,
    wantsFilename,
    wantsContent,
    contentResults,
    filteredFilenameResults,
    collapsedFiles,
    projectNameOf,
    canLoadMore,
    loadingMore,
    t,
  ])

  const navigableIndexes = useMemo(() => {
    const arr: number[] = []
    rows.forEach((r, i) => {
      if (isNavigable(r)) arr.push(i)
    })
    return arr
  }, [rows])

  useEffect(() => {
    queueMicrotask(() => setActiveIndex(navigableIndexes[0] ?? 0))
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
    if (wantsContent && contentResults) {
      setCollapsedFiles(new Set(contentResults.files.map(f => f.path)))
    }
  }, [wantsContent, contentResults])

  const onOpenMatch = useCallback(
    (path: string, line: number) => {
      void openFile(path, line)
    },
    [openFile]
  )

  const onOpenFilename = useCallback(
    (path: string, isDir: boolean) => {
      if (isDir) {
        setView('explorer')
        void revealFileInTree(path, { force: true })
        return
      }
      void openFile(path)
    },
    [openFile, revealFileInTree, setView]
  )

  const onOpenContextMenu = useCallback(
    (event: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }, target: SearchContextTarget) => {
      if (!shouldShowAppContextMenu(event)) return
      setContextMenu({ x: event.clientX, y: event.clientY, target })
    },
    [],
  )

  const copyFileName = useCallback(
    async (path: string) => {
      try {
        await copyToClipboard(fileNameFromPath(path))
        pushToast('success', t('文件名已复制'))
      } catch (error) {
        pushToast('error', t('复制文件名失败: {error}', { error: String(error) }))
      }
    },
    [pushToast, t],
  )

  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenu) return []
    const { target } = contextMenu
    const openLabel =
      target.kind === 'fn' && target.isDir ? t('在资源管理器中定位') : t('打开')
    const items: ContextMenuItem[] = [
      {
        label: openLabel,
        icon:
          target.kind === 'fn' && target.isDir ? (
            <LocateFixed size={14} />
          ) : (
            <FileIcon size={14} />
          ),
        action: () => {
          if (target.kind === 'match') void openFile(target.path, target.line)
          else if (target.kind === 'fn') onOpenFilename(target.path, target.isDir)
          else void openFile(target.path)
        },
      },
      {
        label: t('在资源管理器中定位'),
        icon: <LocateFixed size={14} />,
        separatorBefore: true,
        action: () => {
          setView('explorer')
          void revealFileInTree(target.path, { force: true })
        },
      },
      {
        label: t('在文件管理器中显示'),
        icon: <ExternalLink size={14} />,
        action: () => {
          void revealItemInDir(target.path).catch(error => {
            pushToast('error', t('在文件管理器中显示失败: {error}', { error: String(error) }))
          })
        },
      },
      {
        label: t('复制路径'),
        icon: <Copy size={14} />,
        shortcut: 'Ctrl+Shift+C',
        separatorBefore: true,
        action: () => void copyPathAction(target.path),
      },
      {
        label: t('复制相对路径'),
        icon: <Copy size={14} />,
        action: () => void copyRelativePathAction(target.path),
      },
      {
        label: t('复制文件名'),
        icon: <Copy size={14} />,
        action: () => void copyFileName(target.path),
      },
    ]
    if (target.kind === 'match') {
      items.push({
        label: t('复制为文件引用'),
        icon: <Copy size={14} />,
        action: () =>
          void copyFileReferenceAction(target.path, {
            startLine: target.line,
            endLine: target.line,
          }),
      })
    }
    return items
  }, [
    contextMenu,
    copyFileName,
    onOpenFilename,
    openFile,
    pushToast,
    revealFileInTree,
    setView,
    t,
  ])

  const onRowsRendered = useCallback(
    (
      _visible: { startIndex: number; stopIndex: number },
      all: { startIndex: number; stopIndex: number },
    ) => {
      if (!canLoadMore || rows.length === 0) return
      if (all.stopIndex >= rows.length - 1 - SEARCH_PREFETCH_ROWS) {
        loadMoreResults()
      }
    },
    [canLoadMore, loadMoreResults, rows.length],
  )

  useEffect(() => {
    if (!canLoadMore || loadingMore || loading || rows.length === 0) return
    const element = listRef.current?.element
    if (element && element.scrollHeight <= element.clientHeight + 8) {
      loadMoreResults()
    }
  }, [canLoadMore, loadMoreResults, loading, loadingMore, rows.length, listRef])

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
      onOpenContextMenu,
    }),
    [rows, activeIndex, toggleFileCollapse, onOpenMatch, onOpenFilename, onOpenContextMenu]
  )

  const queryTrimmed = query.trim()
  const contentQueryShort =
    wantsContent && !wantsFilename && queryTrimmed.length > 0 && queryTrimmed.length < MIN_CONTENT_QUERY_LEN
  const hasQuery =
    wantsContent && !wantsFilename
      ? queryTrimmed.length >= MIN_CONTENT_QUERY_LEN
      : queryTrimmed.length > 0 || typeFilter !== null

  const emptyHint = contentQueryShort
    ? t('继续输入以搜索内容（至少 {n} 个字符）', { n: MIN_CONTENT_QUERY_LEN })
    : mode === 'all'
      ? t('输入关键词搜索文件名或内容')
      : mode === 'content'
        ? t('输入关键词搜索文件内容')
        : t('输入关键词、通配符（*）或选择文件类型开始搜索')

  const inputPlaceholder = (() => {
    if (mode === 'all') {
      return typeFilter
        ? t('在 {type} 中搜索文件或内容…', { type: t(typeFilterLabel(typeFilter)) })
        : t('搜索文件或内容…')
    }
    if (mode === 'content') {
      return typeFilter
        ? t('在 {type} 文件中搜索内容…', { type: t(typeFilterLabel(typeFilter)) })
        : t('搜索文件内容…')
    }
    if (useGlob) return t('通配符匹配，如 *.tsx 或 test*Util.ts')
    if (typeFilter) return t('在 {type} 中搜索文件名…', { type: t(typeFilterLabel(typeFilter)) })
    if (matchSuffix) return t('输入后缀/扩展名，如 .ts 或 ts')
    if (fuzzy) return t('模糊匹配文件名…')
    return t('搜索文件名，支持 * 通配符…')
  })()

  const resultSummary = (() => {
    const { dirs, files } = countFilenameKinds(filteredFilenameResults)
    const truncated =
      filenameTruncated || contentTruncated ? t(' · 已截断') : ''
    if (mode === 'all') {
      if (entryKind === 'dir') {
        return t('{dirs} 个目录{truncated}', { dirs, truncated })
      }
      return t('{dirs} 个目录 · {files} 个文件 · {matches} 个内容匹配{truncated}', {
        dirs,
        files,
        matches: contentResults?.match_count ?? 0,
        truncated,
      })
    }
    if (mode === 'content') {
      if (!contentResults) return ''
      return t('{matches} 个匹配 · {files} 个文件{truncated}', {
        matches: contentResults.match_count,
        files: contentResults.files.length,
        truncated: contentTruncated ? t(' · 已截断') : '',
      })
    }
    if (entryKind === 'dir') {
      return t('{dirs} 个目录{truncated}', { dirs, truncated })
    }
    if (entryKind === 'file') {
      return t('{files} 个文件{truncated}', { files, truncated })
    }
    return t('{dirs} 个目录 · {files} 个文件{truncated}', { dirs, files, truncated })
  })()

  const scopeLabel = searchScope === 'all' ? t('全部项目') : t('当前项目')

  return (
    <>
    <div className="h-full flex flex-col bg-bg-sidebar text-fg">
      <div className="px-3 h-9 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-muted">
        <Search size={13} className="text-brand flex-shrink-0" />
        <span className="min-w-0 truncate">{t('搜索')}</span>
        {!searchRoot && (
          <Tooltip label={t('搜索范围')} side="bottom" wrapperClassName="ml-auto inline-flex shrink-0">
            <button
              ref={scopeBtnRef}
              type="button"
              aria-label={t('搜索范围')}
              aria-expanded={scopeMenuOpen}
              aria-haspopup="listbox"
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded font-medium tracking-normal text-fg-muted hover:text-fg hover:bg-bg-hover transition-colors whitespace-nowrap"
              onClick={event => {
                event.stopPropagation()
                if (scopeMenuOpen) {
                  closeScopeMenu()
                  return
                }
                setScopeMenuStyle(prev => ({ ...prev, visibility: 'hidden' }))
                setScopeMenuOpen(true)
              }}
            >
              <span>{scopeLabel}</span>
              <Caret
                size={11}
                className={`flex-shrink-0 transition-transform ${scopeMenuOpen ? 'rotate-180' : ''}`}
              />
            </button>
          </Tooltip>
        )}
      </div>

      {scopeMenuOpen &&
        createPortal(
          <div
            ref={scopeMenuRef}
            role="listbox"
            aria-label={t('搜索范围')}
            className="menu-enter ui-font-scaled fixed z-[100] rounded-md border border-border-strong bg-bg-elevated p-1 shadow-2xl shadow-black/50"
            style={scopeMenuStyle}
            onPointerDown={event => event.stopPropagation()}
          >
            {(
              [
                { value: 'current' as const, label: t('当前项目') },
                { value: 'all' as const, label: t('全部项目') },
              ] as const
            ).map(option => {
              const selected = searchScope === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`w-full px-2 py-1 text-left text-[12px] rounded transition-colors
                    ${selected
                      ? 'bg-bg-active text-fg'
                      : 'text-fg-muted hover:bg-bg-hover hover:text-fg'}`}
                  onClick={() => {
                    setSearchScope(option.value)
                    closeScopeMenu()
                  }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>,
          document.body,
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
            { value: 'all', label: t('全部') },
            { value: 'content', label: t('内容') },
            { value: 'filename', label: t('文件名') },
          ]}
          value={mode}
          onChange={setMode}
        />
        {showEntryKindFilter && (
          <SegmentedControl
            ariaLabel={t('按目录或文件筛选')}
            options={[
              { value: 'all', label: t('全部') },
              { value: 'dir', label: t('目录') },
              { value: 'file', label: t('文件') },
            ]}
            value={entryKind}
            onChange={setEntryKind}
          />
        )}

        <div className="flex items-start gap-0.5">
          {showReplace && (
            <Tooltip label={replaceOpen ? t('隐藏替换') : t('显示替换')} side="bottom">
              <button
                type="button"
                aria-label={replaceOpen ? t('隐藏替换') : t('显示替换')}
                aria-expanded={replaceOpen}
                className="flex-shrink-0 mt-1 p-1 rounded text-fg-dim hover:text-fg hover:bg-bg-hover transition-colors"
                onClick={() => setReplaceOpen(v => !v)}
              >
                {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            </Tooltip>
          )}
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
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
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={e => {
                  composingRef.current = false
                  setQuery(e.currentTarget.value)
                  setSearchFlush(n => n + 1)
                }}
                onKeyDown={e => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  flushSearch()
                }}
                placeholder={inputPlaceholder}
                aria-keyshortcuts="Enter"
                className="setting-input w-full pl-7 pr-7 py-1.5 text-[13px]"
              />
              {query && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-dim hover:text-fg"
                  onClick={() => setQuery('')}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {showReplace && replaceOpen && (
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
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <SearchToggle
            active={ignoreCase}
            onClick={() => setIgnoreCase(v => !v)}
            tooltip={t('忽略大小写')}
            icon={<CaseSensitive size={13} />}
            label="Aa"
          />
          {wantsFilename && (
            <>
              <SearchToggle
                active={fuzzy}
                onClick={() => setFuzzy(v => !v)}
                tooltip={t('模糊匹配（子序列）')}
                icon={<Type size={13} />}
                label={t('模糊')}
                locked={useGlob}
              />
              <SearchToggle
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
                    <Tooltip
                      label={`${t('其余扩展名')}（${otherExts.length}）`}
                      side="bottom"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={typeFilter?.kind === 'star'}
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
                    </Tooltip>
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
          <EmptyState icon={<Search size={28} strokeWidth={1.2} />} title={emptyHint} />
        ) : rows.length === 0 && loading ? (
          <EmptyState icon={<LoaderCircle size={24} className="animate-spin text-accent" />} title={t('搜索中…')} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<SearchX size={28} strokeWidth={1.2} />} title={t('无匹配结果')} />
        ) : (
          <>
            <div className="px-4 py-1 flex items-center gap-2 text-[11px] text-fg-dim">
              <span className="truncate">{resultSummary}</span>
              {loading && <LoaderCircle size={12} className="animate-spin text-accent flex-shrink-0" aria-label={t('搜索中')} />}
              {wantsContent && contentResults && contentResults.match_count > 0 && (
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
                rowComponent={SearchResultRow}
                rowProps={rowProps}
                onRowsRendered={onRowsRendered}
                overscanCount={8}
                className="h-full overscroll-y-contain"
                style={{ height: '100%', overscrollBehavior: 'contain' }}
              />
            </div>
          </>
        )}
      </div>
    </div>
    {contextMenu && (
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
    )}
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
