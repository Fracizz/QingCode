import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Command, FileText, LoaderCircle } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
import Kbd from './Kbd'
import { useI18n } from '../lib/i18n'
import {
  buildCommands,
  filterCommands,
  resolveCommandShortcut,
  type RankedCommand,
} from '../lib/commands'
import {
  collectQuickOpenFiles,
  filterQuickOpenFiles,
  mergeQuickOpenEntries,
  parseQuickOpenLocation,
  quickOpenEntriesFromSearchHits,
  type QuickOpenEntry,
} from '../lib/quickOpen'
import { loadExcludeSettingsForProject } from '../lib/excludeSettings'
import { isTauri } from '../lib/tauri'
import { searchFiles } from '../lib/searchFiles'
import { useCommandPaletteStore } from '../store/commandPaletteStore'
import { useEditorStore } from '../store/editorStore'
import { useProjectStore } from '../store/projectStore'
import { useShortcutStore } from '../store/shortcutStore'
import { getFileIcon } from '../utils/fileIcons'

const MAX_VISIBLE = 12
const BACKGROUND_SEARCH_DEBOUNCE_MS = 180
const MAX_RESULTS_PER_PROJECT = 80

type PaletteItem =
  | { kind: 'command'; command: RankedCommand }
  | { kind: 'file'; entry: QuickOpenEntry & { score: number } }

function isCommandMode(query: string) {
  return query.startsWith('>')
}

function commandQuery(query: string) {
  return query.startsWith('>') ? query.slice(1).trimStart() : query
}

/** Renders text with matched query characters highlighted in brand color. */
function highlightMatch(text: string, rawQuery: string): ReactNode {
  const query = rawQuery.trim().toLowerCase()
  if (!query) return text

  const lower = text.toLowerCase()
  const exactIdx = lower.indexOf(query)
  if (exactIdx !== -1) {
    return (
      <>
        {text.slice(0, exactIdx)}
        <span className="font-semibold text-brand underline decoration-brand/40 underline-offset-2">
          {text.slice(exactIdx, exactIdx + query.length)}
        </span>
        {text.slice(exactIdx + query.length)}
      </>
    )
  }

  // Fuzzy match fallback
  const segments: ReactNode[] = []
  let queryIdx = 0
  let lastIdx = 0

  for (let i = 0; i < text.length && queryIdx < query.length; i++) {
    if (text[i].toLowerCase() === query[queryIdx]) {
      if (i > lastIdx) {
        segments.push(text.slice(lastIdx, i))
      }
      segments.push(
        <span key={i} className="font-semibold text-brand">
          {text[i]}
        </span>,
      )
      lastIdx = i + 1
      queryIdx++
    }
  }

  if (lastIdx < text.length) {
    segments.push(text.slice(lastIdx))
  }

  return segments.length > 0 && queryIdx === query.length ? segments : text
}

export default function CommandPalette() {
  const { t } = useI18n()
  const open = useCommandPaletteStore(s => s.open)
  const seedQuery = useCommandPaletteStore(s => s.seedQuery)
  const closePalette = useCommandPaletteStore(s => s.closePalette)
  const shortcuts = useShortcutStore(s => s.shortcuts)
  const projects = useProjectStore(s => s.projects)
  const currentProject = useProjectStore(s => s.currentProject)
  const unavailableProjectIds = useProjectStore(s => s.unavailableProjectIds)
  const projectTrees = useProjectStore(s => s.projectTrees)
  const openFile = useEditorStore(s => s.openFile)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRequestId = useRef(0)
  const queuedNativeSearch = useRef<Promise<void>>(Promise.resolve())
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [tick, setTick] = useState(0)
  const [nativeEntries, setNativeEntries] = useState<QuickOpenEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [failedProjects, setFailedProjects] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searchRetry, setSearchRetry] = useState(0)

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      setQuery(seedQuery)
      setActiveIndex(0)
      setTick(n => n + 1)
    })
    const id = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [open, seedQuery])

  const commandMode = isCommandMode(query)

  const fileEntries = useMemo(
    () => collectQuickOpenFiles(projects, projectTrees),
    [projects, projectTrees],
  )
  const allFileEntries = useMemo(
    () => mergeQuickOpenEntries(fileEntries, nativeEntries),
    [fileEntries, nativeEntries],
  )

  // The palette opens and accepts input before touching disk. Once typing pauses,
  // run at most one native search at a time; stale responses are never rendered.
  useEffect(() => {
    const requestId = ++searchRequestId.current
    const { fileQuery: needle, projectName } = parseQuickOpenLocation(query)
    queueMicrotask(() => {
      if (requestId !== searchRequestId.current) return
      setNativeEntries([])
      setSearching(false)
      setFailedProjects([])
      setTruncated(false)
    })
    if (!open || isCommandMode(query) || !needle || !isTauri()) return

    const roots = projects
      .filter(project => !unavailableProjectIds.includes(project.id))
      .filter(
        project => !projectName || project.name.toLowerCase() === projectName.toLowerCase(),
      )
      .sort((a, b) => Number(b.id === currentProject?.id) - Number(a.id === currentProject?.id))
    if (roots.length === 0) return

    let disposed = false
    const searchAbort = new AbortController()
    queueMicrotask(() => {
      if (!disposed) setSearching(true)
    })
    const timer = window.setTimeout(() => {
      const task = queuedNativeSearch.current.then(async () => {
        if (disposed || requestId !== searchRequestId.current) return
        let found: QuickOpenEntry[] = []
        for (const project of roots) {
          if (disposed || requestId !== searchRequestId.current) return
          try {
            const excludes = await loadExcludeSettingsForProject(project)
            const response = await searchFiles('快速打开文件', {
              root: project.path,
              query: needle,
              ignoreCase: true,
              fuzzy: true,
              matchSuffix: false,
              extension: null,
              extensions: null,
              limit: MAX_RESULTS_PER_PROJECT,
              excludePatterns: excludes.searchExclude,
              useIgnoreFiles: excludes.useIgnoreFiles,
              followSymlinks: excludes.followSymlinks,
            }, searchAbort.signal)
            if (disposed || requestId !== searchRequestId.current) return
            if (response.cancelled) {
              setFailedProjects(names => [...names, project.name])
              continue
            }
            if (response.truncated) setTruncated(true)
            found = mergeQuickOpenEntries(found, quickOpenEntriesFromSearchHits(project, response.hits))
            setNativeEntries(found)
          } catch (error) {
            // A missing/inaccessible project must not prevent results from others.
            console.warn('quick open native search failed:', error)
            if (!disposed && requestId === searchRequestId.current) {
              setFailedProjects(names => [...names, project.name])
            }
          }
        }
        if (!disposed && requestId === searchRequestId.current) setSearching(false)
      })
      queuedNativeSearch.current = task.catch(() => {})
    }, BACKGROUND_SEARCH_DEBOUNCE_MS)

    return () => {
      disposed = true
      searchAbort.abort()
      window.clearTimeout(timer)
    }
  }, [open, query, projects, currentProject?.id, unavailableProjectIds, searchRetry])

  const results = useMemo((): PaletteItem[] => {
    void tick
    if (commandMode) {
      return filterCommands(buildCommands(), commandQuery(query), t)
        .slice(0, MAX_VISIBLE)
        .map(command => ({ kind: 'command', command }))
    }
    return filterQuickOpenFiles(allFileEntries, query, MAX_VISIBLE).map(entry => ({
      kind: 'file',
      entry,
    }))
  }, [commandMode, query, t, tick, allFileEntries])

  useEffect(() => {
    queueMicrotask(() => setActiveIndex(0))
  }, [query, tick])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePalette()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, closePalette])

  if (!open) return null

  const runItem = async (item: PaletteItem) => {
    closePalette()
    try {
      if (item.kind === 'command') {
        await item.command.run()
        return
      }
      const { line, column } = parseQuickOpenLocation(query)
      await openFile(item.entry.path, line, column)
    } catch (error) {
      console.error('palette action failed:', error)
    }
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(i => (results.length === 0 ? 0 : (i + 1) % results.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(i => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const selected = results[activeIndex]
      if (selected) void runItem(selected)
    }
  }

  const placeholder = commandMode
    ? t('输入命令名称进行筛选…')
    : t('输入文件名进行筛选…（> 前缀搜索命令）')

  return (
    <ModalOverlay onDismiss={closePalette} zIndex="z-[120]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        aria-describedby="command-palette-description"
        className="ui-font-scaled modal-content-enter relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-elevated/95 backdrop-blur-md [box-shadow:var(--shadow-elevation-3)]"
      >
        <h2 id="command-palette-title" className="sr-only">
          {commandMode ? t('命令面板') : t('快速打开')}
        </h2>
        <p id="command-palette-description" className="sr-only">
          {commandMode ? t('搜索并执行命令。') : t('搜索并打开项目中的文件。')}
        </p>
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          {commandMode ? (
            <Command size={16} className="flex-shrink-0 text-fg-muted" aria-hidden />
          ) : (
            <FileText size={16} className="flex-shrink-0 text-fg-muted" aria-hidden />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-label={commandMode ? t('命令') : t('快速打开')}
            aria-controls="command-palette-list"
            aria-activedescendant={
              results[activeIndex] ? `command-palette-item-${activeIndex}` : undefined
            }
            className="modal-search-input"
          />
          <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-ui-2xs text-fg-dim sm:inline">
            Esc
          </kbd>
        </div>
        {!commandMode && (searching || failedProjects.length > 0 || truncated) && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-ui-sm text-fg-muted" role="status">
            {searching && <LoaderCircle size={13} className="animate-spin shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1 break-words">
              {searching ? t('正在查找文件…') : failedProjects.length > 0 ? t('部分项目未能完成搜索') : t('结果已达搜索上限，请细化关键词')}
              {failedProjects.length > 0 && ` · ${failedProjects.join('、')}`}
            </span>
            {!searching && failedProjects.length > 0 && <button type="button" className="shrink-0 text-accent hover:underline" onClick={() => setSearchRetry(n => n + 1)}>{t('重试')}</button>}
          </div>
        )}
        <div
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-busy={!commandMode && searching}
          aria-label={commandMode ? t('命令') : t('文件列表')}
          className="max-h-[min(360px,50vh)] overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-ui text-fg-dim">
              {commandMode ? t('没有匹配的命令') : searching ? t('正在查找文件…') : failedProjects.length > 0 ? t('搜索未完成，请重试') : t('没有匹配的文件')}
            </p>
          ) : (
            results.map((item, index) => {
              const active = index === activeIndex
              if (item.kind === 'command') {
                const shortcut = resolveCommandShortcut(item.command, shortcuts)
                const titleText = t(item.command.title, item.command.titleValues)
                return (
                  <button
                    key={item.command.id}
                    id={`command-palette-item-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-cmd-index={index}
                    className={`flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left text-ui transition-colors duration-100 ${
                      active
                        ? 'border-brand bg-accent/15 text-fg'
                        : 'border-transparent text-fg-muted hover:bg-bg-hover hover:text-fg'
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void runItem(item)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {highlightMatch(titleText, commandQuery(query))}
                    </span>
                    {shortcut && (
                      <span className="flex-shrink-0">
                        <Kbd>{shortcut}</Kbd>
                      </span>
                    )}
                  </button>
                )
              }

              const Icon = getFileIcon(item.entry.label) ?? FileText
              const { fileQuery } = parseQuickOpenLocation(query)
              return (
                <button
                  key={item.entry.id}
                  id={`command-palette-item-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-cmd-index={index}
                  className={`flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left text-ui transition-colors duration-100 ${
                    active
                      ? 'border-brand bg-accent/15 text-fg'
                      : 'border-transparent text-fg-muted hover:bg-bg-hover hover:text-fg'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void runItem(item)}
                >
                  <Icon size={15} className="flex-shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate">
                    <span>{highlightMatch(item.entry.label, fileQuery)}</span>
                    <span className="text-ui-sm ml-2 text-fg-dim">
                      {item.entry.relativePath}
                      {projects.length > 1 ? ` · ${item.entry.projectName}` : ''}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
