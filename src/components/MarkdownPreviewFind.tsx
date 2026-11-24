import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-react'
import Tooltip from './Tooltip'
import { useI18n } from '../lib/i18n'
import {
  PREVIEW_FIND_MAX_MATCHES,
  collectTextSegments,
  findTextMatches,
  rangeForMatch,
} from '../lib/markdownPreviewFind'

const ICON_BTN =
  'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-40 disabled:pointer-events-none'

const TOGGLE_BTN =
  'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded border border-transparent'

/** CSS Custom Highlight 名称，样式见 markdown.css。 */
const HIGHLIGHT_ALL = 'qing-md-find'
const HIGHLIGHT_CURRENT = 'qing-md-find-current'

type HighlightRegistry = {
  set: (name: string, value: unknown) => void
  delete: (name: string) => void
}

function highlightRegistry(): HighlightRegistry | null {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights
  const HighlightCtor = (globalThis as { Highlight?: unknown }).Highlight
  return registry && typeof HighlightCtor === 'function' ? registry : null
}

function setHighlight(name: string, ranges: Range[], priority = 0) {
  const registry = highlightRegistry()
  if (!registry) return
  if (ranges.length === 0) {
    registry.delete(name)
    return
  }
  const Ctor = (globalThis as unknown as {
    Highlight: new (...ranges: Range[]) => { priority: number }
  }).Highlight
  const highlight = new Ctor(...ranges)
  // 当前匹配优先级更高，覆盖全部匹配的底色。
  highlight.priority = priority
  registry.set(name, highlight)
}

function clearHighlights() {
  const registry = highlightRegistry()
  registry?.delete(HIGHLIGHT_ALL)
  registry?.delete(HIGHLIGHT_CURRENT)
}

/** 只在匹配不在可视区域时滚动预览容器，让匹配居中。 */
function revealRange(container: HTMLElement, range: Range) {
  if (typeof range.getBoundingClientRect !== 'function') return
  const rect = range.getBoundingClientRect()
  const box = container.getBoundingClientRect()
  // 顶部留出查找浮层的高度，避免匹配被浮层盖住。
  const topInset = 44
  if (rect.top >= box.top + topInset && rect.bottom <= box.bottom) return
  container.scrollTop += rect.top - box.top - container.clientHeight / 2
}

type Props = {
  previewRef: RefObject<HTMLDivElement | null>
  /** 预览内容变化时重新计算匹配。 */
  content: string
  /** 打开时的初始查询（来自预览中选中的文字）。 */
  seed: string
  /** 每次请求打开（含已打开时再次 Ctrl+F）递增，用于重新聚焦输入框。 */
  focusToken: number
  onClose: () => void
}

/** Markdown 预览内查找浮层，外观与编辑器查找面板一致。 */
export default function MarkdownPreviewFind({ previewRef, content, seed, focusToken, onClose }: Props) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState(seed)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regexp, setRegexp] = useState(false)
  const [current, setCurrent] = useState(0)
  const [result, setResult] = useState<{ ranges: Range[]; invalid: boolean }>({
    ranges: [],
    invalid: false,
  })

  // 再次 Ctrl+F：渲染期带入新选区（React 推荐的「随 props 调整 state」写法）。
  const [seedToken, setSeedToken] = useState(focusToken)
  if (seedToken !== focusToken) {
    setSeedToken(focusToken)
    if (seed) {
      setSearch(seed)
      setCurrent(0)
    }
  }

  useLayoutEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  // 预览 DOM 在本组件提交前已更新，effect 中读取文本节点即可。
  useEffect(() => {
    const root = previewRef.current
    if (!root) return
    const segments = collectTextSegments(root)
    const matches = findTextMatches(segments.text, search, { caseSensitive, wholeWord, regexp })
    const ranges = (matches ?? [])
      .map(match => rangeForMatch(segments, match))
      .filter((range): range is Range => range !== null)
    setHighlight(HIGHLIGHT_ALL, ranges)
    queueMicrotask(() => {
      setResult({ ranges, invalid: matches === null })
      setCurrent(index => (index < ranges.length ? index : 0))
    })
  }, [caseSensitive, content, previewRef, regexp, search, wholeWord])

  const total = result.ranges.length
  const active = total > 0 ? result.ranges[Math.min(current, total - 1)] : null

  useEffect(() => {
    setHighlight(HIGHLIGHT_CURRENT, active ? [active] : [], 1)
    const root = previewRef.current
    if (active && root) revealRange(root, active)
  }, [active, previewRef])

  useEffect(() => clearHighlights, [])

  const step = (delta: number) => {
    if (total === 0) return
    setCurrent(index => (index + delta + total) % total)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'F3' || (event.key === 'Enter' && event.target === inputRef.current)) {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    }
  }

  const matchLabel = !search
    ? ''
    : total === 0
      ? t('无结果')
      : total >= PREVIEW_FIND_MAX_MATCHES
        ? `${current + 1} / 9999+`
        : `${current + 1} / ${total}`

  return (
    <div className="ui-font-scaled cm-qing-find-replace qing-md-find" onKeyDown={onKeyDown}>
      <div className="cm-qing-find-replace-widget">
        <div className="cm-qing-find-rows">
          <div className="cm-qing-find-row">
            <div className="cm-qing-find-input-wrap">
              <input
                ref={inputRef}
                type="text"
                name="search"
                value={search}
                placeholder={t('查找')}
                aria-label={t('查找')}
                className="cm-qing-find-input"
                onChange={event => {
                  setSearch(event.target.value)
                  setCurrent(0)
                }}
              />
              <div className="cm-qing-find-input-toggles">
                <ToggleChip
                  active={caseSensitive}
                  tooltip={t('区分大小写')}
                  onClick={() => setCaseSensitive(v => !v)}
                >
                  <CaseSensitive size={14} />
                </ToggleChip>
                <ToggleChip
                  active={wholeWord}
                  tooltip={t('全字匹配')}
                  onClick={() => setWholeWord(v => !v)}
                >
                  <WholeWord size={14} />
                </ToggleChip>
                <ToggleChip active={regexp} tooltip={t('正则表达式')} onClick={() => setRegexp(v => !v)}>
                  <Regex size={14} />
                </ToggleChip>
              </div>
            </div>

            <span
              className={`cm-qing-find-count ${search && total === 0 ? 'is-empty' : ''}`}
              aria-live="polite"
            >
              {matchLabel}
            </span>

            <div className="cm-qing-find-actions">
              <IconButton
                label={t('上一个')}
                shortcut="Shift+Enter"
                disabled={total === 0}
                onClick={() => step(-1)}
              >
                <ChevronUp size={14} />
              </IconButton>
              <IconButton label={t('下一个')} shortcut="Enter" disabled={total === 0} onClick={() => step(1)}>
                <ChevronDown size={14} />
              </IconButton>
            </div>
          </div>
        </div>

        <div className="cm-qing-find-close">
          <IconButton label={t('关闭')} shortcut="Esc" onClick={onClose}>
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
      <button type="button" aria-label={label} className={ICON_BTN} disabled={disabled} onClick={onClick}>
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
