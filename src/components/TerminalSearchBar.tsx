import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { translate } from '../lib/i18n'
import Tooltip from './Tooltip'

export interface TerminalSearchBarProps {
  query: string
  onQueryChange: (value: string) => void
  onFindNext: () => void
  onFindPrevious: () => void
  onClose: () => void
  /** 0-based active match index; -1 when unknown / over highlight limit. */
  matchIndex: number
  matchTotal: number
}

function matchLabel(query: string, matchIndex: number, matchTotal: number): string {
  if (!query.trim()) return ''
  if (matchTotal === 0) return translate('无结果')
  if (matchIndex < 0) return `${matchTotal}+`
  return `${matchIndex + 1} / ${matchTotal}`
}

/** Compact find widget — floats over the terminal like the editor Find panel. */
export default function TerminalSearchBar({
  query,
  onQueryChange,
  onFindNext,
  onFindPrevious,
  onClose,
  matchIndex,
  matchTotal,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const label = matchLabel(query, matchIndex, matchTotal)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    onFindNext()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      onFindPrevious()
    }
  }

  return (
    <form
      className="terminal-search-bar ui-font-scaled"
      onSubmit={onSubmit}
      onMouseDown={event => event.stopPropagation()}
    >
      <div className="terminal-search-bar__widget">
        <div className="terminal-search-bar__input-wrap">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={translate('查找')}
            className="terminal-search-bar__input"
            aria-label={translate('在终端中查找')}
          />
        </div>
        <span
          className={`terminal-search-bar__count${
            query.trim() && matchTotal === 0 ? ' is-empty' : ''
          }`}
          aria-live="polite"
        >
          {label}
        </span>
        <div className="terminal-search-bar__actions">
          <Tooltip label={translate('上一个')} side="bottom">
            <button
              type="button"
              className="terminal-search-bar__btn"
              aria-label={translate('上一个')}
              onClick={onFindPrevious}
              disabled={!query.trim() || matchTotal === 0}
            >
              <ChevronUp size={14} />
            </button>
          </Tooltip>
          <Tooltip label={translate('下一个')} side="bottom">
            <button
              type="button"
              className="terminal-search-bar__btn"
              aria-label={translate('下一个')}
              onClick={onFindNext}
              disabled={!query.trim() || matchTotal === 0}
            >
              <ChevronDown size={14} />
            </button>
          </Tooltip>
        </div>
        <Tooltip label={translate('关闭')} side="bottom">
          <button
            type="button"
            className="terminal-search-bar__close"
            aria-label={translate('关闭')}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
    </form>
  )
}
