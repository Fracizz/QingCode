import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ListChecks,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from 'lucide-react'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from '@codemirror/search'
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import { shouldSkipSearchMatchCount } from '../lib/editorSession'

const ICON_BTN =
  'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-fg-muted hover:bg-bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:opacity-40 disabled:pointer-events-none'

const TOGGLE_BTN =
  'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] border border-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50'

type PanelProps = {
  view: EditorView
  panel: QingFindReplacePanel
}

function countMatches(view: EditorView, query: SearchQuery): { current: number; total: number } {
  if (!query.valid || !query.search) return { current: 0, total: 0 }
  // Degraded/plain docs: skip full-document match scans (VS-style large-file guard).
  if (shouldSkipSearchMatchCount(view.state.doc.length)) return { current: 0, total: 0 }
  const cursor = query.getCursor(view.state)
  const ranges: { from: number; to: number }[] = []
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    ranges.push(step.value)
    if (ranges.length > 9999) break
  }
  const total = ranges.length
  if (total === 0) return { current: 0, total: 0 }
  const head = view.state.selection.main.head
  let current = 1
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i].from <= head && head <= ranges[i].to) {
      current = i + 1
      break
    }
    if (ranges[i].from >= head) {
      current = i + 1
      break
    }
    current = i + 1
  }
  return { current, total }
}

function EditorFindReplaceView({ view, panel }: PanelProps) {
  const { t } = useI18n()
  const findRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState(() => getSearchQuery(view.state).search)
  const [replace, setReplace] = useState(() => getSearchQuery(view.state).replace)
  const [caseSensitive, setCaseSensitive] = useState(() => getSearchQuery(view.state).caseSensitive)
  const [regexp, setRegexp] = useState(() => getSearchQuery(view.state).regexp)
  const [wholeWord, setWholeWord] = useState(() => getSearchQuery(view.state).wholeWord)
  const [replaceOpen, setReplaceOpen] = useState(() => {
    const q = getSearchQuery(view.state)
    return Boolean(q.replace) || panel.preferReplace
  })
  const [docTick, setDocTick] = useState(0)
  const queryRef = useRef(getSearchQuery(view.state))
  const readOnly = view.state.readOnly

  useEffect(() => {
    panel.setQueryListener(query => {
      queryRef.current = query
      setSearch(query.search)
      setReplace(query.replace)
      setCaseSensitive(query.caseSensitive)
      setRegexp(query.regexp)
      setWholeWord(query.wholeWord)
      setDocTick(n => n + 1)
    })
    panel.setDocListener(() => setDocTick(n => n + 1))
    return () => {
      panel.setQueryListener(null)
      panel.setDocListener(null)
    }
  }, [panel])

  useLayoutEffect(() => {
    const input = findRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  const matchInfo = useMemo(() => {
    void docTick
    return countMatches(view, queryRef.current)
  }, [view, search, caseSensitive, regexp, wholeWord, docTick])

  const commit = (next: {
    search?: string
    replace?: string
    caseSensitive?: boolean
    regexp?: boolean
    wholeWord?: boolean
  }) => {
    const query = new SearchQuery({
      search: next.search ?? search,
      replace: next.replace ?? replace,
      caseSensitive: next.caseSensitive ?? caseSensitive,
      regexp: next.regexp ?? regexp,
      wholeWord: next.wholeWord ?? wholeWord,
    })
    if (query.eq(queryRef.current)) return
    queryRef.current = query
    panel.noteQuery(query)
    view.dispatch({ effects: setSearchQuery.of(query) })
    setDocTick(n => n + 1)
  }

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (runScopeHandlers(view, event.nativeEvent, 'search-panel')) {
      event.preventDefault()
      return
    }
    if (event.key === 'Tab' && !readOnly) {
      // Allow tab between find/replace when replace is open
      return
    }
    if (event.key !== 'Enter') return
    if (event.target === findRef.current) {
      event.preventDefault()
      ;(event.shiftKey ? findPrevious : findNext)(view)
      setDocTick(n => n + 1)
    } else if (event.target === replaceRef.current) {
      event.preventDefault()
      replaceNext(view)
      setDocTick(n => n + 1)
    }
  }

  const matchLabel = !search
    ? ''
    : matchInfo.total === 0
      ? t('无结果')
      : matchInfo.total > 9999
        ? `${matchInfo.current} / 9999+`
        : `${matchInfo.current} / ${matchInfo.total}`

  return (
    <div
      className="ui-font-scaled cm-qing-find-replace"
      onKeyDown={onPanelKeyDown}
    >
      <div className={`cm-qing-find-replace-widget ${replaceOpen && !readOnly ? 'is-replace' : ''}`}>
        {!readOnly && (
          <button
            type="button"
            className={`${ICON_BTN} cm-qing-find-toggle-replace`}
            aria-label={replaceOpen ? t('隐藏替换') : t('显示替换')}
            aria-expanded={replaceOpen}
            onClick={() => setReplaceOpen(v => !v)}
          >
            {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}

        <div className="cm-qing-find-rows">
          <div className="cm-qing-find-row">
            <div className="cm-qing-find-input-wrap">
              <input
                ref={findRef}
                type="text"
                name="search"
                value={search}
                placeholder={t('查找')}
                aria-label={t('查找')}
                className="cm-qing-find-input"
                {...{ 'main-field': 'true' }}
                onChange={event => {
                  const value = event.target.value
                  setSearch(value)
                  commit({ search: value })
                }}
              />
              <div className="cm-qing-find-input-toggles">
                <ToggleChip
                  active={caseSensitive}
                  tooltip={t('区分大小写')}
                  onClick={() => {
                    const next = !caseSensitive
                    setCaseSensitive(next)
                    commit({ caseSensitive: next })
                  }}
                >
                  <CaseSensitive size={14} />
                </ToggleChip>
                <ToggleChip
                  active={wholeWord}
                  tooltip={t('全字匹配')}
                  onClick={() => {
                    const next = !wholeWord
                    setWholeWord(next)
                    commit({ wholeWord: next })
                  }}
                >
                  <WholeWord size={14} />
                </ToggleChip>
                <ToggleChip
                  active={regexp}
                  tooltip={t('正则表达式')}
                  onClick={() => {
                    const next = !regexp
                    setRegexp(next)
                    commit({ regexp: next })
                  }}
                >
                  <Regex size={14} />
                </ToggleChip>
              </div>
            </div>

            <span
              className={`cm-qing-find-count ${search && matchInfo.total === 0 ? 'is-empty' : ''}`}
              aria-live="polite"
            >
              {matchLabel}
            </span>

            <div className="cm-qing-find-actions">
              <IconButton
                label={t('上一个')}
                shortcut="Shift+F3"
                disabled={!search || matchInfo.total === 0}
                onClick={() => {
                  findPrevious(view)
                  setDocTick(n => n + 1)
                }}
              >
                <ChevronUp size={14} />
              </IconButton>
              <IconButton
                label={t('下一个')}
                shortcut="F3"
                disabled={!search || matchInfo.total === 0}
                onClick={() => {
                  findNext(view)
                  setDocTick(n => n + 1)
                }}
              >
                <ChevronDown size={14} />
              </IconButton>
              <IconButton
                label={t('选择全部匹配')}
                disabled={!search || matchInfo.total === 0}
                onClick={() => selectMatches(view)}
              >
                <ListChecks size={14} />
              </IconButton>
            </div>
          </div>

          {replaceOpen && !readOnly && (
            <div className="cm-qing-find-row">
              <div className="cm-qing-find-input-wrap is-replace">
                <input
                  ref={replaceRef}
                  type="text"
                  name="replace"
                  value={replace}
                  placeholder={t('替换')}
                  aria-label={t('替换')}
                  className="cm-qing-find-input"
                  onChange={event => {
                    const value = event.target.value
                    setReplace(value)
                    commit({ replace: value })
                  }}
                />
              </div>
              <div className="cm-qing-find-actions">
                <IconButton
                  label={t('替换')}
                  disabled={!search || matchInfo.total === 0}
                  onClick={() => {
                    replaceNext(view)
                    setDocTick(n => n + 1)
                  }}
                >
                  <Replace size={14} />
                </IconButton>
                <IconButton
                  label={t('全部替换')}
                  disabled={!search || matchInfo.total === 0}
                  onClick={() => {
                    replaceAll(view)
                    setDocTick(n => n + 1)
                  }}
                >
                  <ReplaceAll size={14} />
                </IconButton>
              </div>
            </div>
          )}
        </div>

        <div className="cm-qing-find-close">
          <IconButton label={t('关闭')} shortcut="Esc" onClick={() => closeSearchPanel(view)}>
            <X size={14} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

function IconButton({
  label,
  shortcut,
  onClick,
  children,
  disabled,
}: {
  label: string
  shortcut?: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
}) {
  const tip = shortcut ? `${label} (${shortcut})` : label
  return (
    <Tooltip label={tip} side="bottom">
      <button
        type="button"
        aria-label={label}
        className={ICON_BTN}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function ToggleChip({
  active,
  tooltip,
  onClick,
  children,
}: {
  active: boolean
  tooltip: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip label={tooltip} side="bottom">
      <button
        type="button"
        aria-label={tooltip}
        aria-pressed={active}
        onClick={onClick}
        className={`${TOGGLE_BTN} ${
          active
            ? 'bg-bg-active text-fg border-border-strong'
            : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

class QingFindReplacePanel implements Panel {
  dom: HTMLElement
  top = true
  preferReplace = false
  private root: Root
  private query: SearchQuery
  private queryListener: ((query: SearchQuery) => void) | null = null
  private docListener: (() => void) | null = null

  constructor(view: EditorView) {
    this.query = getSearchQuery(view.state)
    // If replace field already has content, open replace row (e.g. reopen after Ctrl+H flow).
    this.preferReplace = Boolean(this.query.replace)
    this.dom = document.createElement('div')
    this.dom.className = 'cm-qing-find-replace-host'
    this.root = createRoot(this.dom)
    flushSync(() => {
      this.root.render(<EditorFindReplaceView view={view} panel={this} />)
    })
  }

  noteQuery(query: SearchQuery) {
    this.query = query
  }

  setQueryListener(listener: ((query: SearchQuery) => void) | null) {
    this.queryListener = listener
  }

  setDocListener(listener: (() => void) | null) {
    this.docListener = listener
  }

  mount() {
    const input = this.dom.querySelector<HTMLInputElement>('[main-field]')
    input?.focus()
    input?.select()
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value
          this.queryListener?.(effect.value)
        }
      }
    }
    if (update.docChanged || update.selectionSet) {
      this.docListener?.()
    }
  }

  destroy() {
    this.queryListener = null
    this.docListener = null
    this.root.unmount()
  }

  get pos() {
    return 80
  }
}

/** CodeMirror search `createPanel` that mounts QingCode's Find/Replace UI. */
export function createEditorFindReplacePanel(view: EditorView): Panel {
  return new QingFindReplacePanel(view)
}
