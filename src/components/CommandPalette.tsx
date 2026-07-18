import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Command, FileText } from 'lucide-react'
import ModalOverlay from './ModalOverlay'
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
  quickOpenEntriesFromSearchHits,
  type QuickOpenEntry,
  type QuickOpenSearchHit,
} from '../lib/quickOpen'
import { loadExcludeSettingsForProject } from '../lib/excludeSettings'
import { isTauri, safeInvoke } from '../lib/tauri'
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

  useEffect(() => {
    if (!open) return
    setQuery(seedQuery)
    setActiveIndex(0)
    setTick(n => n + 1)
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
    const needle = query.trim()
    setNativeEntries([])
    if (!open || isCommandMode(query) || !needle || !isTauri()) return

    const roots = projects
      .filter(project => !unavailableProjectIds.includes(project.id))
      .sort((a, b) => Number(b.id === currentProject?.id) - Number(a.id === currentProject?.id))
    if (roots.length === 0) return

    let disposed = false
    const timer = window.setTimeout(() => {
      const task = queuedNativeSearch.current.then(async () => {
        if (disposed || requestId !== searchRequestId.current) return
        let found: QuickOpenEntry[] = []
        for (const project of roots) {
          if (disposed || requestId !== searchRequestId.current) return
          try {
            const excludes = await loadExcludeSettingsForProject(project)
            const hits = await safeInvoke<QuickOpenSearchHit[]>('快速打开文件', 'search_files', {
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
            })
            if (disposed || requestId !== searchRequestId.current) return
            found = mergeQuickOpenEntries(found, quickOpenEntriesFromSearchHits(project, hits))
            setNativeEntries(found)
          } catch (error) {
            // A missing/inaccessible project must not prevent results from others.
            console.warn('quick open native search failed:', error)
          }
        }
      })
      queuedNativeSearch.current = task.catch(() => {})
    }, BACKGROUND_SEARCH_DEBOUNCE_MS)

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [open, query, projects, currentProject?.id, unavailableProjectIds])

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
    setActiveIndex(0)
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
      await openFile(item.entry.path)
    } catch (error) {
      console.error('palette action failed:', error)
    }
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
    <ModalOverlay onDismiss={closePalette} zIndex="z-[120]" align="start" className="pt-[12vh]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={commandMode ? t('命令面板') : t('快速打开')}
        className="modal-content-enter relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-elevated shadow-2xl shadow-black/50"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
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
            aria-controls="command-palette-list"
            aria-activedescendant={
              results[activeIndex] ? `command-palette-item-${activeIndex}` : undefined
            }
            className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-dim"
          />
          <kbd className="hidden rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-dim sm:inline">
            Esc
          </kbd>
        </div>
        <div
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          aria-label={commandMode ? t('命令') : t('文件列表')}
          className="max-h-[min(360px,50vh)] overflow-y-auto py-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-fg-dim">
              {commandMode ? t('没有匹配的命令') : t('没有匹配的文件')}
            </p>
          ) : (
            results.map((item, index) => {
              const active = index === activeIndex
              if (item.kind === 'command') {
                const shortcut = resolveCommandShortcut(item.command, shortcuts)
                return (
                  <button
                    key={item.command.id}
                    id={`command-palette-item-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-cmd-index={index}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors ${
                      active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void runItem(item)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {t(item.command.title, item.command.titleValues)}
                    </span>
                    {shortcut && (
                      <span className="flex-shrink-0 font-mono text-[11px] text-fg-dim">{shortcut}</span>
                    )}
                  </button>
                )
              }

              const Icon = getFileIcon(item.entry.label) ?? FileText
              return (
                <button
                  key={item.entry.id}
                  id={`command-palette-item-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-cmd-index={index}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors ${
                    active ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void runItem(item)}
                >
                  <Icon size={15} className="flex-shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate">
                    <span>{item.entry.label}</span>
                    <span className="ml-2 text-[11px] text-fg-dim">
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
